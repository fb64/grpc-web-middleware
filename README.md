# grpc-web-middleware
Nodejs middleware use to translate requests from [grpc-web](https://github.com/grpc/grpc-web)
clients to a GRPC server.


## Examples

### Express

```javascript
const express = require('express')
const expressApp = express()
const expressCors = require('cors')
const grpcWebMiddleware = require('grpc-web-middleware')

expressApp.use(expressCors())
expressApp.use(grpcWebMiddleware('http://localhost:6565'))
```



### Koa

```javascript
const Koa = require('koa')
const koaApp = new Koa()
const koaCors = require('@koa/cors')
const grpcWebMiddleware = require('grpc-web-middleware')

koaApp.use(koaCors())
koaApp.use(async (ctx,next) => grpcWebMiddleware('http://localhost:6565')(ctx.req,ctx.res,next))
```
