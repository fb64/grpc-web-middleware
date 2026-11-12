/**
 * Streaming base64 codecs for the grpc-web-text format.
 *
 * Chunks arrive at arbitrary boundaries, so both codecs keep the incomplete
 * tail of a chunk until the next one completes it.
 */

/** Decodes base64 text that may be split anywhere and may contain several padded segments. */
export class Base64Decoder {
  #pending = ''

  /** Decodes every complete 4-character group seen so far. */
  push(text: string): Uint8Array[] {
    this.#pending += text.replace(/\s/g, '')
    const usable = this.#pending.length - (this.#pending.length % 4)
    const complete = this.#pending.slice(0, usable)
    this.#pending = this.#pending.slice(usable)

    // A client may concatenate independently encoded segments ("QQ==QkI="):
    // decode each padded group separately so the padding does not stop decoding.
    const out: Uint8Array[] = []
    let start = 0
    for (let i = 3; i < complete.length; i += 4) {
      if (complete[i] === '=') {
        out.push(Buffer.from(complete.slice(start, i + 1), 'base64'))
        start = i + 1
      }
    }
    if (start < complete.length) out.push(Buffer.from(complete.slice(start), 'base64'))
    return out.filter((bytes) => bytes.length > 0)
  }

  /** Throws if the input ended in the middle of a 4-character group. */
  end(): void {
    if (this.#pending.length > 0) throw new Error('Truncated base64 input')
  }
}

/** Encodes bytes to base64 without emitting padding until {@link end}. */
export class Base64Encoder {
  #pending: Buffer = Buffer.alloc(0)

  /** Encodes every complete 3-byte group seen so far, as ASCII bytes. */
  push(bytes: Uint8Array): Uint8Array {
    const all = Buffer.concat([this.#pending, bytes])
    const usable = all.length - (all.length % 3)
    this.#pending = all.subarray(usable)
    return Buffer.from(all.subarray(0, usable).toString('base64'), 'latin1')
  }

  /** Encodes the remaining bytes, with padding. */
  end(): Uint8Array {
    const rest = this.#pending
    this.#pending = Buffer.alloc(0)
    return Buffer.from(rest.toString('base64'), 'latin1')
  }
}
