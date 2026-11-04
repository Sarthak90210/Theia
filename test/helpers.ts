import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Synthesised fixtures. Real files off a phone would be better and are coming,
 * but tests must not need a device attached, and these exercise exactly the
 * structural properties the validators care about.
 */

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + payload.length, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, payload])
}

function ftyp(brand: string): Buffer {
  const payload = Buffer.alloc(8)
  payload.write(brand, 0, 'latin1')
  payload.writeUInt32BE(512, 4)
  return box('ftyp', payload)
}

/**
 * A QuickTime video shaped the way the iPhone writes them: samples first, then
 * the moov index at the very end. Truncation therefore destroys the index,
 * which is why a cut video will not play at all rather than playing partially.
 */
export function makeVideo(opts: { moov?: boolean; mdatBytes?: number } = {}): Buffer {
  const { moov = true, mdatBytes = 4096 } = opts
  const parts = [ftyp('qt  '), box('mdat', randomBytes(mdatBytes))]
  if (moov) parts.push(box('moov', box('mvhd', randomBytes(96))))
  return Buffer.concat(parts)
}

export function makeHeic(opts: { meta?: boolean; mdatBytes?: number } = {}): Buffer {
  const { meta = true, mdatBytes = 2048 } = opts
  const parts = [ftyp('heic')]
  if (meta) parts.push(box('meta', box('hdlr', randomBytes(32))))
  parts.push(box('mdat', randomBytes(mdatBytes)))
  return Buffer.concat(parts)
}

export function makeJpeg(opts: { eoi?: boolean; scanBytes?: number } = {}): Buffer {
  const { eoi = true, scanBytes = 1024 } = opts

  const app0Payload = Buffer.alloc(14)
  app0Payload.write('JFIF\0', 0, 'latin1')
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0]),
    lengthPrefixed(app0Payload),
  ])

  const sos = Buffer.concat([Buffer.from([0xff, 0xda]), lengthPrefixed(Buffer.alloc(10))])

  // Entropy-coded data must not contain 0xff, or the walker would read it as a
  // marker. Real encoders byte-stuff; here we just avoid it.
  const scan = Buffer.alloc(scanBytes, 0x5a)

  const parts = [Buffer.from([0xff, 0xd8]), app0, sos, scan]
  if (eoi) parts.push(Buffer.from([0xff, 0xd9]))
  return Buffer.concat(parts)
}

function lengthPrefixed(payload: Buffer): Buffer {
  const out = Buffer.alloc(2 + payload.length)
  out.writeUInt16BE(2 + payload.length, 0)
  payload.copy(out, 2)
  return out
}

export function makePng(opts: { iend?: boolean } = {}): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunk = (type: string, payload: Buffer) => {
    const out = Buffer.alloc(12 + payload.length)
    out.writeUInt32BE(payload.length, 0)
    out.write(type, 4, 'latin1')
    payload.copy(out, 8)
    out.writeUInt32BE(0, 8 + payload.length)
    return out
  }
  const parts = [sig, chunk('IHDR', Buffer.alloc(13)), chunk('IDAT', randomBytes(64))]
  if (opts.iend !== false) parts.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

/* --------------------------------------------------------------- scratch */

export interface Scratch {
  dir: string
  deviceRoot: string
  libraryRoot: string
  dbPath: string
  cleanup: () => void
}

export function scratch(): Scratch {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photos-win-test-'))
  const deviceRoot = path.join(dir, 'device')
  const libraryRoot = path.join(dir, 'library')
  fs.mkdirSync(path.join(deviceRoot, 'DCIM', '100APPLE'), { recursive: true })
  fs.mkdirSync(libraryRoot, { recursive: true })
  return {
    dir,
    deviceRoot,
    libraryRoot,
    dbPath: path.join(dir, 'library.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

/** Writes a file into the fake device's camera roll and returns its device path. */
export function putOnDevice(s: Scratch, name: string, bytes: Buffer, mtimeMs?: number): string {
  const local = path.join(s.deviceRoot, 'DCIM', '100APPLE', name)
  fs.writeFileSync(local, bytes)
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs)
    fs.utimesSync(local, t, t)
  }
  return `/DCIM/100APPLE/${name}`
}

/** Every file in the library, excluding staging and quarantine. */
export function libraryFiles(libraryRoot: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(path.relative(libraryRoot, full).split(path.sep).join('/'))
    }
  }
  walk(libraryRoot)
  return out.sort()
}
