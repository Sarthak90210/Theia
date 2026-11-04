import type { Duplex } from 'node:stream'

/**
 * Reads an exact number of bytes from a duplex stream.
 *
 * This is the piece the real implementation needs too: it takes any Duplex,
 * which is what makes the transcript-replay seam possible. Swap the socket for
 * a stream backed by a recorded fixture and every layer above is unchanged.
 */
export class ByteReader {
  private chunks: Buffer[] = []
  private buffered = 0
  private want = 0
  private resolve: ((b: Buffer) => void) | null = null
  private reject: ((e: Error) => void) | null = null
  private ended = false
  private failure: Error | null = null

  private readonly onData = (c: Buffer) => {
    this.chunks.push(c)
    this.buffered += c.length
    this.pump()
  }
  private readonly onEnd = () => {
    this.ended = true
    this.pump()
    if (this.resolve) this.fail(new Error('stream ended mid-frame'))
  }
  private readonly onError = (e: Error) => {
    this.failure = e
    this.fail(e)
  }

  constructor(private stream: Duplex) {
    stream.on('data', this.onData)
    stream.on('end', this.onEnd)
    stream.on('error', this.onError)
  }

  /** Stop consuming, leaving the socket clean for a TLS upgrade to take over. */
  detach(): { stream: Duplex; leftover: Buffer } {
    this.stream.off('data', this.onData)
    this.stream.off('end', this.onEnd)
    this.stream.off('error', this.onError)
    const leftover = Buffer.concat(this.chunks, this.buffered)
    this.chunks = []
    this.buffered = 0
    return { stream: this.stream, leftover }
  }

  private fail(e: Error) {
    const rej = this.reject
    this.resolve = null
    this.reject = null
    this.want = 0
    rej?.(e)
  }

  private pump() {
    if (!this.resolve || this.buffered < this.want) return
    const all = Buffer.concat(this.chunks, this.buffered)
    const out = all.subarray(0, this.want)
    const rest = all.subarray(this.want)
    this.chunks = rest.length ? [rest] : []
    this.buffered = rest.length
    const res = this.resolve
    this.resolve = null
    this.reject = null
    this.want = 0
    res(out)
  }

  read(n: number): Promise<Buffer> {
    if (n === 0) return Promise.resolve(Buffer.alloc(0))
    if (this.failure) return Promise.reject(this.failure)
    if (this.resolve) return Promise.reject(new Error('concurrent read on one stream'))
    return new Promise<Buffer>((res, rej) => {
      this.resolve = res
      this.reject = rej
      this.want = n
      this.pump()
      if (this.want !== 0 && this.ended) this.fail(new Error(`stream ended before ${n} bytes`))
    })
  }
}

export function writeAll(stream: Duplex, buf: Buffer): Promise<void> {
  return new Promise((res, rej) => {
    stream.write(buf, (err) => (err ? rej(err) : res()))
  })
}
