# grpc-web-middleware

simple nodejs middleware acting as a [grpc-web](https://github.com/grpc/grpc-web) gateway

[![npm version](https://badge.fury.io/js/grpc-web-middleware.svg)](https://badge.fury.io/js/grpc-web-middleware)

## Installation

Intall grpc-web-middleware with [npm registry](https://www.npmjs.com/)

```sh
$ npm install grpc-web-middleware
```

## Configuration

```javascript
const grpcWebMiddleware = require('grpc-web-middleware')
```

### grpcWebMiddleware(grpcServerUrl,[prefix])

- `grpcServerUrl` - The grpc server base url
- `prefix` - add a path prefix to handle grpc web request 

**Returns async function (req, res, next)**

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
