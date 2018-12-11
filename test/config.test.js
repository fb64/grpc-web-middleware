const rewire = require('rewire')
const isApplicable = rewire('../index.js').__get__('isApplicable')

describe('test configuration applicability', () => {
  it('without prefix and request match', () => {
    var mockRequest = {
      headers: { 'content-type': 'application/grpc-web-text' },
      method: 'POST',
      url: '/test/path'
    }
    expect(isApplicable(mockRequest)).toBe(true)
  })

  it('without prefix and request content-type does not match', () => {
    var mockRequest = {
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/test/path'
    }
    expect(isApplicable(mockRequest)).toBe(false)
  })

  it('without prefix and request method does not match', () => {
    var mockRequest = {
      headers: { 'content-type': 'application/grpc-web-text' },
      method: 'GET',
      url: '/test/path'
    }
    expect(isApplicable(mockRequest)).toBe(false)
  })

  it('with prefix and request match', () => {
    var mockRequest = {
      headers: { 'content-type': 'application/grpc-web-text' },
      method: 'POST',
      url: '/prefix/path'
    }
    expect(isApplicable(mockRequest, '/prefix')).toBe(true)
  })

  it('with prefix and request does not match', () => {
    var mockRequest = {
      headers: { 'content-type': 'application/grpc-web-text' },
      method: 'POST',
      url: '/test/path'
    }
    expect(isApplicable(mockRequest, '/prefix')).toBe(false)
  })
})
