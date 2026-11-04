import type { Duplex } from 'node:stream'
import { ByteReader, writeAll } from './bytes.ts'
import type { Recorder } from './usbmux.ts'

/**
 * AFC packet header, 40 bytes, all little-endian:
 *   magic (8) | entire_length (8) | this_length (8) | packet_num (8) | op (8)
 * Matches AFCPacket in libimobiledevice's afc.h.
 */
const AFC_MAGIC = Buffer.from('CFA6LPAA', 'ascii')
const HEADER_BYTES = 40

export const OP = {
  STATUS: 0x01n,
  DATA: 0x02n,
  READ_DIR: 0x03n,
  GET_FILE_INFO: 0x0an,
  GET_DEVINFO: 0x0bn,
  FILE_OPEN: 0x0dn,
  FILE_OPEN_RES: 0x0en,
  FILE_READ: 0x0fn,
  FILE_SEEK: 0x11n,
  FILE_TELL: 0x12n,
  FILE_TELL_RES: 0x13n,
  FILE_CLOSE: 0x14n,
} as const

export const FOPEN_RDONLY = 0x01n

export const SEEK_SET = 0n
export const SEEK_CUR = 1n
export const SEEK_END = 2n

const AFC_ERRORS: Record<string, string> = {
  '0': 'success',
  '1': 'unknown error',
  '2': 'op header invalid',
  '3': 'no resources',
  '4': 'read error',
  '5': 'write error',
  '6': 'unknown packet type',
  '7': 'invalid argument',
  '8': 'object not found',
  '9': 'object is directory',
  '10': 'permission denied',
  '11': 'service not connected',
  '12': 'operation timeout',
  '13': 'too much data',
  '14': 'end of data',
  '15': 'operation not supported',
  '16': 'object exists',
  '17': 'object busy',
  '18': 'no space left',
  '19': 'operation would block',
  '20': 'io error',
  '21': 'operation interrupted',
  '22': 'operation in progress',
  '23': 'internal error',
}

export class AfcError extends Error {
  constructor(public code: bigint, op: string) {
    super(`AFC ${op} failed: ${AFC_ERRORS[code.toString()] ?? `code ${code}`}`)
  }
}

function splitNulls(buf: Buffer): string[] {
  const out: string[] = []
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      if (i > start) out.push(buf.subarray(start, i).toString('utf8'))
      start = i + 1
    }
  }
  if (start < buf.length) out.push(buf.subarray(start).toString('utf8'))
  return out
}

function pairsToRecord(items: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < items.length; i += 2) out[items[i]!] = items[i + 1]!
  return out
}

export interface FileInfo {
  size: number
  isDirectory: boolean
  mtimeMs: number
  birthtimeMs: number
  raw: Record<string, string>
}

export class AfcClient {
  private reader: ByteReader
  private packetNum = 0n

  constructor(private stream: Duplex, private record?: Recorder) {
    this.reader = new ByteReader(stream)
  }

  /** Same rule as lockdownd: one operation in flight per AFC channel. */
  private queue: Promise<unknown> = Promise.resolve()

  private async transact(op: bigint, payload: Buffer, opName: string) {
    const run = this.queue.then(
      () => this.exchange(op, payload, opName),
      () => this.exchange(op, payload, opName),
    )
    this.queue = run.catch(() => undefined)
    return run
  }

  private async exchange(op: bigint, payload: Buffer, opName: string) {
    const header = Buffer.alloc(HEADER_BYTES)
    AFC_MAGIC.copy(header, 0)
    const total = BigInt(HEADER_BYTES + payload.length)
    header.writeBigUInt64LE(total, 8)
    header.writeBigUInt64LE(total, 16)
    header.writeBigUInt64LE(this.packetNum, 24)
    header.writeBigUInt64LE(op, 32)
    this.packetNum += 1n
    this.record?.('tx', 'afc', { op: opName, bytes: payload.length })
    await writeAll(this.stream, Buffer.concat([header, payload]))

    const respHeader = await this.reader.read(HEADER_BYTES)
    if (!respHeader.subarray(0, 8).equals(AFC_MAGIC)) {
      throw new Error('AFC response lost framing, magic mismatch')
    }
    const entire = respHeader.readBigUInt64LE(8)
    const respOp = respHeader.readBigUInt64LE(32)
    const body = await this.reader.read(Number(entire) - HEADER_BYTES)
    this.record?.('rx', 'afc', { op: respOp.toString(16), bytes: body.length })

    if (respOp === OP.STATUS) {
      const code = body.length >= 8 ? body.readBigUInt64LE(0) : 1n
      if (code !== 0n) throw new AfcError(code, opName)
    }
    return { op: respOp, body }
  }

  private static cpath(path: string): Buffer {
    return Buffer.concat([Buffer.from(path, 'utf8'), Buffer.from([0])])
  }

  async deviceInfo(): Promise<Record<string, string>> {
    const { body } = await this.transact(OP.GET_DEVINFO, Buffer.alloc(0), 'GET_DEVINFO')
    return pairsToRecord(splitNulls(body))
  }

  async readDir(path: string): Promise<string[]> {
    const { body } = await this.transact(OP.READ_DIR, AfcClient.cpath(path), 'READ_DIR')
    return splitNulls(body).filter((n) => n !== '.' && n !== '..')
  }

  async stat(path: string): Promise<FileInfo> {
    const { body } = await this.transact(OP.GET_FILE_INFO, AfcClient.cpath(path), 'GET_FILE_INFO')
    const raw = pairsToRecord(splitNulls(body))
    return {
      size: Number(raw.st_size ?? 0),
      isDirectory: raw.st_ifmt === 'S_IFDIR',
      // AFC reports nanoseconds since epoch.
      mtimeMs: Number(BigInt(raw.st_mtime ?? '0') / 1_000_000n),
      birthtimeMs: Number(BigInt(raw.st_birthtime ?? '0') / 1_000_000n),
      raw,
    }
  }

  async open(path: string, mode = FOPEN_RDONLY): Promise<bigint> {
    const payload = Buffer.concat([Buffer.alloc(8), AfcClient.cpath(path)])
    payload.writeBigUInt64LE(mode, 0)
    const { op, body } = await this.transact(OP.FILE_OPEN, payload, 'FILE_OPEN')
    if (op !== OP.FILE_OPEN_RES) throw new Error(`FILE_OPEN returned op 0x${op.toString(16)}`)
    return body.readBigUInt64LE(0)
  }

  async read(handle: bigint, length: number): Promise<Buffer> {
    const payload = Buffer.alloc(16)
    payload.writeBigUInt64LE(handle, 0)
    payload.writeBigUInt64LE(BigInt(length), 8)
    const { body } = await this.transact(OP.FILE_READ, payload, 'FILE_READ')
    return body
  }

  /** The operation the entire resume design rests on. */
  async seek(handle: bigint, offset: bigint, whence = SEEK_SET): Promise<void> {
    const payload = Buffer.alloc(24)
    payload.writeBigUInt64LE(handle, 0)
    payload.writeBigUInt64LE(whence, 8)
    payload.writeBigInt64LE(offset, 16)
    await this.transact(OP.FILE_SEEK, payload, 'FILE_SEEK')
  }

  async tell(handle: bigint): Promise<bigint> {
    const payload = Buffer.alloc(8)
    payload.writeBigUInt64LE(handle, 0)
    const { body } = await this.transact(OP.FILE_TELL, payload, 'FILE_TELL')
    return body.readBigUInt64LE(0)
  }

  async close(handle: bigint): Promise<void> {
    const payload = Buffer.alloc(8)
    payload.writeBigUInt64LE(handle, 0)
    await this.transact(OP.FILE_CLOSE, payload, 'FILE_CLOSE')
  }

  destroy() {
    ;(this.stream as any).destroy?.()
  }
}
