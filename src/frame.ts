/** Flag of a grpc-web frame carrying trailers instead of a message. */
const TRAILER_FLAG = 0x80

/**
 * Encodes trailers as a grpc-web trailer frame: the flag byte, a 4-byte big-endian
 * length, then the trailers as HTTP/1 header lines (`name: value\r\n`).
 */
export function trailerFrame(trailers: Iterable<[string, string]>): Uint8Array {
  let text = ''
  for (const [name, value] of trailers) text += `${name.toLowerCase()}: ${value}\r\n`
  const payload = Buffer.from(text, 'utf8')
  const frame = Buffer.alloc(5 + payload.length)
  frame.writeUInt8(TRAILER_FLAG, 0)
  frame.writeUInt32BE(payload.length, 1)
  payload.copy(frame, 5)
  return frame
}
