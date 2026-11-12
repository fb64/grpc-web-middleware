// A real gRPC server (grpc-js) implementing echo.v1.EchoService, used as the proxy upstream.
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

const definition = protoLoader.loadSync('test/fixtures/echo/v1/echo.proto', { defaults: true })
const proto = grpc.loadPackageDefinition(definition) as any

export interface Upstream {
  port: number
  /** Resolves when the server sees a Count stream cancelled by the client. */
  countCancelled: Promise<void>
  stop(): Promise<void>
  /** Kills every connection immediately, like a crashed server. */
  kill(): void
}

export async function startUpstream(): Promise<Upstream> {
  let onCountCancelled = (): void => {}
  const countCancelled = new Promise<void>((resolve) => {
    onCountCancelled = resolve
  })

  const server = new grpc.Server()
  server.addService(proto.echo.v1.EchoService.service, {
    echo(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      const { message, failWithCode, delayMs } = call.request
      setTimeout(() => {
        if (failWithCode) {
          callback({ code: failWithCode, details: message })
          return
        }
        const header = new grpc.Metadata()
        header.set('x-echo-header', String(call.metadata.get('x-test')[0] ?? ''))
        call.sendMetadata(header)
        const trailer = new grpc.Metadata()
        trailer.set('x-echo-trailer', 'done')
        callback(null, { message }, trailer)
      }, delayMs)
    },

    count(call: grpc.ServerWritableStream<any, any>) {
      const { count, intervalMs } = call.request
      let number = 0
      const timer = setInterval(() => {
        if (number === count) {
          clearInterval(timer)
          call.end()
          return
        }
        call.write({ number: number++ })
      }, intervalMs)
      call.on('cancelled', () => {
        clearInterval(timer)
        onCountCancelled()
      })
    },
  })

  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  )

  return {
    port,
    countCancelled,
    stop: () => new Promise<void>((resolve) => server.tryShutdown(() => resolve())),
    kill: () => server.forceShutdown(),
  }
}
