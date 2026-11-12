import http2 from 'node:http2'
import { Base64Decoder, Base64Encoder } from './base64.ts'
import { trailerFrame } from './frame.ts'

export interface GrpcWebHandlerOptions {
  /** URL of the upstream gRPC server: `http://` for plaintext (h2c), `https://` for TLS. */
  target: string | URL
  /** Path prefix of the grpc-web requests, stripped before forwarding (e.g. `/grpc`). */
  prefix?: string
  /** Options for the upstream HTTP/2 connection (e.g. TLS certificates). */
  connectOptions?: http2.SecureClientSessionOptions
}

export interface GrpcWebHandler {
  /**
   * Proxies a grpc-web request to the upstream gRPC server.
   * Resolves to `undefined` when the request is not a grpc-web request under the prefix,
   * so the caller can fall through to its next handler.
   */
  (request: Request): Promise<Response | undefined>
  /** Closes the upstream HTTP/2 connection. A later request opens a new one. */
  close(): void
}

const GRPC_WEB = 'application/grpc-web'
const GRPC_WEB_TEXT = 'application/grpc-web-text'

/** gRPC status codes used by the proxy itself. */
const Code = {
  CANCELLED: 1,
  UNKNOWN: 2,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const

/** Request headers that are specific to the browser hop and must not reach the gRPC server. */
const DROPPED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'connection',
  'content-length',
  'content-type',
  'host',
  'http2-settings',
  'keep-alive',
  'origin',
  'proxy-connection',
  'referer',
  'te',
  'transfer-encoding',
  'upgrade',
  'x-grpc-web',
  'x-user-agent',
])

/** Response headers rewritten by the proxy. */
const DROPPED_RESPONSE_HEADERS = new Set(['content-length', 'content-type'])

export function normalizePrefix(prefix: string | undefined): string {
  if (!prefix || prefix === '/') return ''
  return '/' + prefix.replace(/^\/+|\/+$/g, '')
}

/** True for a POST with a grpc-web content type whose path is under `prefix` (already normalized). */
export function isGrpcWebRequest(
  method: string | undefined,
  contentType: string | null | undefined,
  path: string,
  prefix: string,
): boolean {
  return (
    method?.toUpperCase() === 'POST' &&
    !!contentType?.toLowerCase().startsWith(GRPC_WEB) &&
    path.startsWith(prefix + '/')
  )
}

export function createGrpcWebHandler(options: GrpcWebHandlerOptions): GrpcWebHandler {
  const target = new URL(options.target)
  const prefix = normalizePrefix(options.prefix)
  let session: http2.ClientHttp2Session | undefined

  function upstreamSession(): http2.ClientHttp2Session {
    if (!session || session.closed || session.destroyed) {
      const created = http2.connect(target, options.connectOptions)
      // Connection errors also fail the pending streams, which report them to their callers.
      created.on('error', () => {})
      const forget = (): void => {
        if (session === created) session = undefined
      }
      created.on('close', forget)
      created.on('goaway', forget)
      session = created
    }
    return session
  }

  const handler = async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url)
    const contentType = request.headers.get('content-type')
    if (!contentType || !isGrpcWebRequest(request.method, contentType, url.pathname, prefix)) {
      return undefined
    }

    const text = contentType.toLowerCase().startsWith(GRPC_WEB_TEXT)
    const subtype = contentType.slice((text ? GRPC_WEB_TEXT : GRPC_WEB).length) // "", "+proto", "+json"...
    const responseContentType = (text ? GRPC_WEB_TEXT : GRPC_WEB) + subtype

    const upstreamHeaders: http2.OutgoingHttpHeaders = {
      [http2.constants.HTTP2_HEADER_METHOD]: 'POST',
      [http2.constants.HTTP2_HEADER_PATH]: url.pathname.slice(prefix.length),
      [http2.constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc' + subtype,
      [http2.constants.HTTP2_HEADER_TE]: 'trailers',
    }
    for (const [name, value] of request.headers) {
      if (!DROPPED_REQUEST_HEADERS.has(name)) upstreamHeaders[name] = value
    }

    let stream: http2.ClientHttp2Stream
    try {
      stream = upstreamSession().request(upstreamHeaders)
    } catch (error) {
      return trailersOnly(responseContentType, Code.UNAVAILABLE, errorMessage(error))
    }
    let streamError: Error | undefined
    stream.on('error', (error) => {
      streamError = error
    })

    const cancelUpstream = (): void => {
      if (!stream.closed) stream.close(http2.constants.NGHTTP2_CANCEL)
    }
    request.signal.addEventListener('abort', cancelUpstream, { once: true })
    stream.once('close', () => request.signal.removeEventListener('abort', cancelUpstream))

    void forwardRequestBody(request.body, stream, text)

    const headers = await new Promise<http2.IncomingHttpHeaders | undefined>((resolve) => {
      stream.once('response', resolve)
      stream.once('close', () => resolve(undefined))
    })
    if (!headers) {
      return trailersOnly(
        responseContentType,
        streamError ? Code.UNAVAILABLE : statusFromResetCode(stream.rstCode),
        streamError ? errorMessage(streamError) : 'Upstream stream closed before sending headers',
      )
    }

    const responseHeaders = new Headers({ 'content-type': responseContentType })
    for (const [name, value] of Object.entries(headers)) {
      if (name.startsWith(':') || DROPPED_RESPONSE_HEADERS.has(name) || value === undefined) continue
      for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item)
    }

    const httpStatus = Number(headers[http2.constants.HTTP2_HEADER_STATUS])
    if (httpStatus !== 200 && !responseHeaders.has('grpc-status')) {
      cancelUpstream()
      return trailersOnly(responseContentType, statusFromHttp(httpStatus), `Upstream HTTP status ${httpStatus}`)
    }

    // A "trailers-only" response carries grpc-status in its headers and has no trailer frame.
    let statusSent = responseHeaders.has('grpc-status')
    const encoder = text ? new Base64Encoder() : undefined
    let cancelled = false

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enqueue = (bytes: Uint8Array): void => {
          if (cancelled) return
          const out = encoder ? encoder.push(bytes) : bytes
          if (out.length > 0) controller.enqueue(out)
          if ((controller.desiredSize ?? 1) <= 0) stream.pause()
        }

        stream.on('data', (chunk: Buffer) => enqueue(chunk))
        stream.on('trailers', (trailers: http2.IncomingHttpHeaders) => {
          enqueue(trailerFrame(headerEntries(trailers)))
          statusSent = true
        })
        stream.once('close', () => {
          if (cancelled) return
          if (!statusSent) {
            const code = streamError ? Code.UNAVAILABLE : statusFromResetCode(stream.rstCode)
            const message = streamError ? errorMessage(streamError) : 'Upstream stream ended without a gRPC status'
            enqueue(trailerFrame([['grpc-status', String(code)], ['grpc-message', encodeURIComponent(message)]]))
          }
          if (encoder) {
            const rest = encoder.end()
            if (rest.length > 0) controller.enqueue(rest)
          }
          controller.close()
        })
      },
      pull() {
        stream.resume()
      },
      cancel() {
        cancelled = true
        cancelUpstream()
      },
    })

    return new Response(body, { status: 200, headers: responseHeaders })
  }

  return Object.assign(handler, {
    close(): void {
      session?.close()
      session = undefined
    },
  })
}

/** Copies the request body to the upstream stream, decoding it first in grpc-web-text mode. */
async function forwardRequestBody(
  body: ReadableStream<Uint8Array> | null,
  stream: http2.ClientHttp2Stream,
  text: boolean,
): Promise<void> {
  try {
    if (body) {
      const decoder = text ? new Base64Decoder() : undefined
      for await (const chunk of body) {
        const parts = decoder ? decoder.push(Buffer.from(chunk).toString('latin1')) : [chunk]
        for (const part of parts) {
          if (stream.closed) return
          if (!stream.write(part)) {
            await new Promise((resolve) => {
              stream.once('drain', resolve)
              stream.once('close', resolve)
            })
          }
        }
      }
      decoder?.end()
    }
    if (!stream.closed) stream.end()
  } catch {
    // The client went away or sent invalid base64: abandon the call.
    if (!stream.closed) stream.close(http2.constants.NGHTTP2_CANCEL)
  }
}

function trailersOnly(contentType: string, code: number, message: string): Response {
  return new Response(null, {
    status: 200,
    headers: {
      'content-type': contentType,
      'grpc-status': String(code),
      'grpc-message': encodeURIComponent(message),
    },
  })
}

function* headerEntries(headers: http2.IncomingHttpHeaders): Iterable<[string, string]> {
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(':') || value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) yield [name, item]
  }
}

/** Maps the HTTP/2 RST_STREAM code of a stream that ended without a gRPC status. */
function statusFromResetCode(rstCode: number | undefined): number {
  switch (rstCode) {
    case http2.constants.NGHTTP2_CANCEL:
      return Code.CANCELLED
    case http2.constants.NGHTTP2_REFUSED_STREAM:
      return Code.UNAVAILABLE
    case http2.constants.NGHTTP2_ENHANCE_YOUR_CALM:
      return Code.RESOURCE_EXHAUSTED
    case http2.constants.NGHTTP2_INADEQUATE_SECURITY:
      return Code.PERMISSION_DENIED
    default:
      return Code.INTERNAL
  }
}

/** Maps a non-200 HTTP status without grpc-status, as specified by gRPC's HTTP status mapping. */
function statusFromHttp(httpStatus: number): number {
  switch (httpStatus) {
    case 400:
      return Code.INTERNAL
    case 401:
      return Code.UNAUTHENTICATED
    case 403:
      return Code.PERMISSION_DENIED
    case 404:
      return Code.UNIMPLEMENTED
    case 429:
    case 502:
    case 503:
    case 504:
      return Code.UNAVAILABLE
    default:
      return Code.UNKNOWN
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
