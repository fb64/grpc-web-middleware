const http2 = require('http2')

function grpcWebMiddleware (grpcUrl) {
  var grpcClient = http2.connect(grpcUrl, {})

  grpcClient.on('error', (err) => {
    console.log('grpcClient error: ' + JSON.stringify(err))
  })

  return async function (req, res, next) {
    if (grpcClient.destroyed) {
      grpcClient = http2.connect(grpcUrl)
      grpcClient.on('error', (err) => {
        console.log('grpcClient error: ' + JSON.stringify(err))
      })
    }
    if (req.headers['content-type'] !== 'application/grpc-web-text'.toUpperCase() && req.method !== 'POST') {
      await next()
    } else {
      await callGrpcServer(req, res, grpcClient)
    }
  }
}

function callGrpcServer (req, res, hc) {
  return new Promise(function (resolve, reject) {
    var hasResponse = false
    res.setHeader('content-type', 'application/grpc-web-text')

    // init http2 post request
    var h2req = hc.request({
      [http2.constants.HTTP2_HEADER_TE]: 'trailers',
      [http2.constants.HTTP2_HEADER_METHOD]: http2.constants.HTTP2_METHOD_POST,
      [http2.constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc',
      [http2.constants.HTTP2_HEADER_PATH]: req.url
    })

    h2req.on('response', (headers) => {
      res.statusCode = headers[http2.constants.HTTP2_HEADER_STATUS]
      hasResponse = true
    })

    h2req.on('data', (chunk) => {
      res.write(Buffer.from(chunk).toString('base64'))
    })

    h2req.on('end', () => {
      if (hasResponse) {
        res.end()
        resolve()
      }
    })

    h2req.on('error', (err) => {
      reject(err)
    })

    // decode and write request data to http2 request
    req.on('data', function (chunk) {
      h2req.write(Buffer.from(chunk.toString(), 'base64'))
    })

    req.on('end', function () {
      h2req.end()
    })
  }).catch((error) => {
    res.statusCode = 500
    res.end(JSON.stringify(error))
  })
}

module.exports = grpcWebMiddleware
