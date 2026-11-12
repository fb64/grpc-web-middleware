import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import {
  createGrpcWebHandler,
  type GrpcWebHandlerOptions,
  isGrpcWebRequest,
  normalizePrefix,
} from './handler.ts'

export interface GrpcWebMiddleware {
  /**
   * Proxies grpc-web requests under the prefix, and calls `next` for every other request.
   * Works with `node:http`, Express, Connect and other `(req, res, next)` frameworks.
   */
  (req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => unknown): Promise<void>
  /** Closes the upstream HTTP/2 connection. */
  close(): void
}

/**
 * Creates a `(req, res, next)` middleware that proxies grpc-web requests to a gRPC server.
 *
 * @example grpcWebMiddleware({ target: 'http://localhost:6565', prefix: '/grpc' })
 * @example grpcWebMiddleware('http://localhost:6565', '/grpc')
 */
export function grpcWebMiddleware(options: GrpcWebHandlerOptions): GrpcWebMiddleware
export function grpcWebMiddleware(target: string | URL, prefix?: string): GrpcWebMiddleware
export function grpcWebMiddleware(
  optionsOrTarget: GrpcWebHandlerOptions | string | URL,
  prefix?: string,
): GrpcWebMiddleware {
  const options =
    typeof optionsOrTarget === 'string' || optionsOrTarget instanceof URL
      ? { target: optionsOrTarget, prefix }
      : optionsOrTarget
  const handle = createGrpcWebHandler(options)
  const normalizedPrefix = normalizePrefix(options.prefix)

  const middleware = async (
    req: IncomingMessage,
    res: ServerResponse,
    next?: (error?: unknown) => unknown,
  ): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    if (!isGrpcWebRequest(req.method, req.headers['content-type'], path, normalizedPrefix)) {
      await next?.()
      return
    }

    // 'close' also fires after a normal end, when aborting is a no-op.
    const abort = new AbortController()
    res.once('close', () => abort.abort())

    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.startsWith(':') || value === undefined) continue
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
    }
    const request = new Request(new URL(req.url ?? '/', 'http://localhost'), {
      method: 'POST',
      headers,
      body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
      signal: abort.signal,
      duplex: 'half',
    } as RequestInit)

    const response = await handle(request)
    if (!response) {
      await next?.()
      return
    }
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (!response.body) {
      res.end()
      return
    }
    try {
      await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), res)
    } catch {
      // The browser went away: the upstream call is cancelled through the abort signal.
    }
  }

  return Object.assign(middleware, { close: handle.close })
}
