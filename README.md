# grpc-web-middleware

A small [grpc-web](https://github.com/grpc/grpc-web) to gRPC proxy for Node.js, with no runtime dependencies.
It lets browsers call a regular gRPC server (HTTP/2) through your existing Node.js web server, without Envoy.

[![npm version](https://img.shields.io/npm/v/grpc-web-middleware)](https://www.npmjs.com/package/grpc-web-middleware)

- Works with any grpc-web client: [Connect-ES](https://connectrpc.com/docs/web/getting-started) (`createGrpcWebTransport`) or Google's [grpc-web](https://github.com/grpc/grpc-web)
- Binary (`application/grpc-web`, `+proto`) and text (`application/grpc-web-text`) modes
- Unary and server-streaming calls; cancelling the browser request cancels the upstream call
- Forwards metadata, deadlines (`grpc-timeout`), response headers and trailers
- Upstream failures are reported as gRPC statuses (`UNAVAILABLE`...), not HTTP 500s
- Two APIs: a fetch-style handler (`Request` → `Response`) and a `(req, res, next)` middleware

Client streaming and bidirectional streaming are not part of the grpc-web protocol.

## Installation

```sh
npm install grpc-web-middleware
```

Requires Node.js 22.12 or later. The package is ESM only.

## Usage

### Hono (fetch-style handler)

`createGrpcWebHandler` returns `(request: Request) => Promise<Response | undefined>`.
It resolves to `undefined` for requests it does not handle, so you can fall through to your next handler.

```js
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createGrpcWebHandler } from 'grpc-web-middleware'

const grpcWeb = createGrpcWebHandler({ target: 'http://localhost:6565', prefix: '/grpc' })

const app = new Hono()
app.use('/grpc/*', async (c, next) => (await grpcWeb(c.req.raw)) ?? next())
serve({ fetch: app.fetch, port: 3000 })
```

### node:http, Express, Connect

```js
import express from 'express'
import { grpcWebMiddleware } from 'grpc-web-middleware'

const app = express()
app.use(grpcWebMiddleware({ target: 'http://localhost:6565', prefix: '/grpc' }))
app.listen(3000)
```

With plain `node:http`: `createServer((req, res) => grpcWeb(req, res, () => { /* other routes */ }))`.

### Koa

Koa must not send its own response once the middleware has written one:

```js
import Koa from 'koa'
import { grpcWebMiddleware } from 'grpc-web-middleware'

const grpcWeb = grpcWebMiddleware({ target: 'http://localhost:6565', prefix: '/grpc' })

const app = new Koa()
app.use(async (ctx, next) => {
  let handled = true
  await grpcWeb(ctx.req, ctx.res, async () => {
    handled = false
    await next()
  })
  if (handled) ctx.respond = false
})
app.listen(3000)
```

### Browser client (Connect-ES)

```js
import { createClient } from '@connectrpc/connect'
import { createGrpcWebTransport } from '@connectrpc/connect-web'
import { NewsService } from './gen/news_service_pb.js'

const client = createClient(NewsService, createGrpcWebTransport({ baseUrl: '/grpc' }))
```

## Options

| Option           | Description |
|------------------|-------------|
| `target`         | Upstream gRPC server URL: `http://host:port` for plaintext (h2c), `https://host:port` for TLS |
| `prefix`         | Path prefix of grpc-web requests, removed before forwarding (`/grpc/pkg.Service/Method` → `/pkg.Service/Method`). Default: none |
| `connectOptions` | Options for [`http2.connect`](https://nodejs.org/api/http2.html#http2connectauthority-options-listener), e.g. `ca` for a private TLS certificate |

`grpcWebMiddleware(target, prefix)` is also accepted. Both APIs return an object with a `close()` method
that closes the upstream HTTP/2 connection (useful for graceful shutdown and tests).

The proxy only handles `POST` requests with an `application/grpc-web*` content type under the prefix.

## Cross-origin requests

Same-origin requests need no configuration. If the page and the proxy are on different origins, enable CORS
on your server and expose the gRPC response headers to the browser, for example with Hono:

```js
import { cors } from 'hono/cors'

app.use('/grpc/*', cors({
  origin: 'https://app.example.com',
  allowHeaders: ['content-type', 'x-grpc-web', 'x-user-agent', 'grpc-timeout'],
  exposeHeaders: ['grpc-status', 'grpc-message', 'grpc-status-details-bin'],
}))
```

## Migrating from 0.x

- Use the named export instead of the default export: `import { grpcWebMiddleware } from 'grpc-web-middleware'`
  (CommonJS code can still use `const { grpcWebMiddleware } = require('grpc-web-middleware')` thanks to `require(esm)`).
- `grpcWebMiddleware(url, prefix)` keeps its signature; an options object is also accepted.
- The prefix now matches a whole path segment: with prefix `/grpc`, `/grpcfoo/...` no longer matches.
- Binary mode, trailers, metadata, deadlines and cancellation now work. 0.x only handled `grpc-web-text`,
  dropped trailers (so the gRPC status never reached the client) and did not forward request headers.

## Development

```sh
mise install       # Node.js and buf, see mise.toml
npm ci
npm test           # integration tests: Connect-ES client -> proxy -> grpc-js server
npm run typecheck
npm run build      # compiles src/ to dist/
```

`test/gen` is generated from `test/fixtures` with `mise run generate`.

## License

[MIT](LICENSE)
