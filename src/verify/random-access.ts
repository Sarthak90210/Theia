import fs from 'node:fs'

/**
 * Structure checks read headers scattered through a file, never the whole
 * thing. The largest file in the reference library is 4.90 GB, so anything
 * that takes a Buffer is unusable on exactly the files that matter most.
 */
export interface RandomAccess {
  readonly size: number
  /** Reads up to `length` bytes at `offset`. Returns fewer at end of file. */
  read(offset: number, length: number): Buffer
}

export class BufferAccess implements RandomAccess {
  constructor(private readonly buf: Buffer) {}
  get size(): number {
    return this.buf.length
  }
  read(offset: number, length: number): Buffer {
    if (offset >= this.buf.length) return Buffer.alloc(0)
    return this.buf.subarray(offset, Math.min(this.buf.length, offset + length))
  }
}

export class FileAccess implements RandomAccess {
  readonly size: number
  private constructor(private readonly fd: number, size: number) {
    this.size = size
  }

  static open(filePath: string): FileAccess {
    const fd = fs.openSync(filePath, 'r')
    const { size } = fs.fstatSync(fd)
    return new FileAccess(fd, size)
  }

  read(offset: number, length: number): Buffer {
    if (offset >= this.size) return Buffer.alloc(0)
    const want = Math.min(length, this.size - offset)
    const buf = Buffer.alloc(want)
    let filled = 0
    while (filled < want) {
      const n = fs.readSync(this.fd, buf, filled, want - filled, offset + filled)
      if (n === 0) break
      filled += n
    }
    return filled === want ? buf : buf.subarray(0, filled)
  }

  close(): void {
    fs.closeSync(this.fd)
  }
}
