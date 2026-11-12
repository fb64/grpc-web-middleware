import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { Code, ConnectError, createClient, type Client } from '@connectrpc/connect'
import { createGrpcWebTransport } from '@connectrpc/connect-web'
import { createGrpcWebHandler, grpcWebMiddleware } from '../src/index.ts'
import { EchoRequestSchema, EchoResponseSchema, EchoService } from './gen/echo/v1/echo_pb.ts'
import { startUpstream, type Upstream } from './upstream.ts'

/** A proxy under test: a base URL and fetch function to reach it, and a way to shut it down. */
interface Proxy {
  baseUrl: string
  fetch: typeof fetch
  close(): Promise<void>
}

/** The fetch-style handler, called directly (no HTTP server in between). */
function fetchHandlerProxy(target: string): Proxy {
  const handler = createGrpcWebHandler({ target, prefix: '/grpc' })
  return {
    baseUrl: 'http://proxy.test/grpc',
    fetch: async (input, init) => {
      const response = await handler(new Request(input, init))
      return response ?? new Response('not grpc-web', { status: 404 })
    },
    close: async () => handler.close(),
  }
}

/** The (req, res, next) middleware, behind a real node:http server. */
async function nodeMiddlewareProxy(target: string): Promise<Proxy> {
  const middleware = grpcWebMiddleware(target, '/grpc')
  const server: Server = createServer((req, res) =>
    middleware(req, res, () => {
      res.statusCode = 404
      res.end('not grpc-web')
    }),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/grpc`,
    fetch: globalThis.fetch,
    close: async () => {
      middleware.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const proxies = {
  'fetch handler': fetchHandlerProxy,
  'node middleware': nodeMiddlewareProxy,
}

for (const [name, createProxy] of Object.entries(proxies)) {
  describe(`${name} with a Connect-ES grpc-web client`, () => {
    let upstream: Upstream
    let proxy: Proxy
    let client: Client<typeof EchoService>

    before(async () => {
      upstream = await startUpstream()
      proxy = await createProxy(`http://127.0.0.1:${upstream.port}`)
      client = createClient(EchoService, createGrpcWebTransport({ baseUrl: proxy.baseUrl, fetch: proxy.fetch }))
    })

    after(async () => {
      await proxy.close()
      await upstream.stop()
    })

    test('unary call with header and trailer metadata', async () => {
      let header: Headers | undefined
      let trailer: Headers | undefined
      const response = await client.echo(
        { message: 'hello' },
        { headers: { 'x-test': 'from-client' }, onHeader: (h) => (header = h), onTrailer: (t) => (trailer = t) },
      )

      assert.equal(response.message, 'hello')
      assert.equal(header?.get('x-echo-header'), 'from-client')
      assert.equal(trailer?.get('x-echo-trailer'), 'done')
    })

    test('error status and non-ASCII message', async () => {
      const error = await client.echo({ message: 'échec 💥', failWithCode: Code.NotFound }).catch((e) => e)

      assert.ok(error instanceof ConnectError)
      assert.equal(error.code, Code.NotFound)
      assert.equal(error.rawMessage, 'échec 💥')
    })

    test('deadline is forwarded to the server', async () => {
      const error = await client.echo({ message: 'slow', delayMs: 2_000 }, { timeoutMs: 100 }).catch((e) => e)

      assert.ok(error instanceof ConnectError)
      assert.equal(error.code, Code.DeadlineExceeded)
    })

    test('server streaming', async () => {
      const numbers: number[] = []
      for await (const response of client.count({ count: 5, intervalMs: 5 })) numbers.push(response.number)

      assert.deepEqual(numbers, [0, 1, 2, 3, 4])
    })

    test('cancelling a stream cancels the upstream call', async () => {
      const abort = new AbortController()
      for await (const _ of client.count({ count: 1_000, intervalMs: 10 }, { signal: abort.signal })) {
        abort.abort()
        break
      }

      await withTimeout(upstream.countCancelled, 2_000, 'upstream call was not cancelled')
    })
  })

  describe(`${name} edge cases`, () => {
    test('unreachable upstream maps to UNAVAILABLE', async () => {
      const proxy = await createProxy('http://127.0.0.1:1')
      try {
        const client = createClient(
          EchoService,
          createGrpcWebTransport({ baseUrl: proxy.baseUrl, fetch: proxy.fetch }),
        )
        const error = await client.echo({ message: 'anyone?' }).catch((e) => e)

        assert.ok(error instanceof ConnectError)
        assert.equal(error.code, Code.Unavailable)
      } finally {
        await proxy.close()
      }
    })

    test('upstream process dying during a stream maps to UNAVAILABLE', async (t) => {
      const upstream = spawn(process.execPath, ['test/upstream-process.ts'], { stdio: ['ignore', 'pipe', 'inherit'] })
      // Never leave the upstream running if the test fails before killing it, or the test run hangs.
      t.after(() => upstream.kill('SIGKILL'))
      const [portLine] = await once(upstream.stdout, 'data')
      const proxy = await createProxy(`http://127.0.0.1:${String(portLine).trim()}`)
      try {
        const client = createClient(
          EchoService,
          createGrpcWebTransport({ baseUrl: proxy.baseUrl, fetch: proxy.fetch }),
        )
        const received: number[] = []
        const error = await (async () => {
          for await (const response of client.count({ count: 1_000, intervalMs: 20 })) {
            received.push(response.number)
            if (received.length === 1) upstream.kill('SIGKILL')
          }
        })().catch((e) => e)

        assert.deepEqual(received, [0])
        assert.ok(error instanceof ConnectError, `expected an error, got ${error}`)
        assert.equal(error.code, Code.Unavailable, error.rawMessage)
      } finally {
        await proxy.close()
      }
    })

    test('grpc-web-text request split at arbitrary boundaries', async () => {
      const upstream = await startUpstream()
      const proxy = await createProxy(`http://127.0.0.1:${upstream.port}`)
      try {
        const message = toBinary(EchoRequestSchema, create(EchoRequestSchema, { message: 'text mode' }))
        const base64 = Buffer.from(dataFrame(message)).toString('base64')
        const chunks = [base64.slice(0, 3), base64.slice(3, 9), base64.slice(9)]

        const response = await proxy.fetch(`${proxy.baseUrl}/echo.v1.EchoService/Echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/grpc-web-text', 'x-grpc-web': '1' },
          body: new ReadableStream({
            pull(controller) {
              const chunk = chunks.shift()
              if (chunk === undefined) controller.close()
              else controller.enqueue(new TextEncoder().encode(chunk))
            },
          }),
          duplex: 'half',
        } as RequestInit)

        assert.equal(response.headers.get('content-type'), 'application/grpc-web-text')
        const frames = parseFrames(Buffer.from(await response.text(), 'base64'))
        assert.equal(frames.length, 2)
        assert.equal(fromBinary(EchoResponseSchema, frames[0]!.payload).message, 'text mode')
        assert.equal(frames[1]!.trailer, true)
        assert.match(Buffer.from(frames[1]!.payload).toString(), /grpc-status: 0\r\n/)
      } finally {
        await proxy.close()
        await upstream.stop()
      }
    })

    test('other requests fall through', async () => {
      const proxy = await createProxy('http://127.0.0.1:1')
      try {
        const root = proxy.baseUrl.replace(/\/grpc$/, '')
        const requests: [string, RequestInit][] = [
          [`${root}/index.html`, { method: 'GET' }],
          [`${root}/other/echo.v1.EchoService/Echo`, { method: 'POST', headers: { 'content-type': 'application/grpc-web' } }],
          [`${proxy.baseUrl}/echo.v1.EchoService/Echo`, { method: 'POST', headers: { 'content-type': 'application/json' } }],
        ]
        for (const [url, init] of requests) {
          const response = await proxy.fetch(url, init)
          assert.equal(response.status, 404, `${init.method} ${url}`)
          assert.equal(await response.text(), 'not grpc-web')
        }
      } finally {
        await proxy.close()
      }
    })
  })
}

function dataFrame(payload: Uint8Array): Uint8Array {
  const frame = Buffer.alloc(5 + payload.length)
  frame.writeUInt32BE(payload.length, 1)
  frame.set(payload, 5)
  return frame
}

function parseFrames(bytes: Buffer): { trailer: boolean; payload: Uint8Array }[] {
  const frames = []
  for (let offset = 0; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset + 1)
    frames.push({ trailer: (bytes[offset]! & 0x80) !== 0, payload: bytes.subarray(offset + 5, offset + 5 + length) })
    offset += 5 + length
  }
  return frames
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref()),
  ])
}
