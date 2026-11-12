import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Base64Decoder, Base64Encoder } from '../src/base64.ts'

const bytes = Buffer.from(Array.from({ length: 50 }, (_, i) => (i * 37) % 256))

function decodeAll(chunks: string[]): Buffer {
  const decoder = new Base64Decoder()
  const out = chunks.flatMap((chunk) => decoder.push(chunk))
  decoder.end()
  return Buffer.concat(out)
}

test('decoder handles every split position', () => {
  const text = bytes.toString('base64')
  for (let i = 0; i <= text.length; i++) {
    assert.deepEqual(decodeAll([text.slice(0, i), text.slice(i)]), bytes, `split at ${i}`)
  }
})

test('decoder handles concatenated padded segments', () => {
  const segments = [bytes.subarray(0, 1), bytes.subarray(1, 3), bytes.subarray(3)]
  const text = segments.map((segment) => Buffer.from(segment).toString('base64')).join('')

  assert.match(text, /=.+/) // padding in the middle
  assert.deepEqual(decodeAll([text]), bytes)
})

test('decoder rejects a truncated input', () => {
  const decoder = new Base64Decoder()
  decoder.push('QUJD' + 'QQ')
  assert.throws(() => decoder.end(), /Truncated/)
})

test('encoder output is valid base64 whatever the chunking', () => {
  for (let size = 1; size <= 7; size++) {
    const encoder = new Base64Encoder()
    let text = ''
    for (let i = 0; i < bytes.length; i += size) {
      text += Buffer.from(encoder.push(bytes.subarray(i, i + size))).toString('latin1')
    }
    text += Buffer.from(encoder.end()).toString('latin1')

    assert.equal(text, bytes.toString('base64'), `chunk size ${size}`)
  }
})
