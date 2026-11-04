import fs from 'node:fs'

// libheif returns untagged RGB. Keep the source ICC profile with encoded
// derivatives so the viewer can colour-manage those pixels.
// Ignore the linear/PQ/HLG profiles used by auxiliary HDR images.
export { IMAGE_CACHE_VERSION } from './version.ts'

export function heicProfile(file: string): Buffer | null {
  let head: Buffer
  try {
    const fd = fs.openSync(file, 'r')
    try {
      head = Buffer.alloc(512 * 1024)
      head = head.subarray(0, fs.readSync(fd, head, 0, head.length, 0))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  return profileFromHead(head)
}

export function profileFromHead(head: Buffer): Buffer | null {
  for (let i = head.indexOf('colrprof', 0, 'latin1'); i >= 4; i = head.indexOf('colrprof', i + 1, 'latin1')) {
    const size = head.readUInt32BE(i - 4)
    const end = i - 4 + size
    if (size < 140 || end > head.length) continue
    const icc = head.subarray(i + 8, end)
    if (icc.toString('latin1', 36, 40) !== 'acsp') continue // not an ICC profile
    const desc = profileDescription(icc)
    if (/linear|PQ|HLG/i.test(desc)) continue
    return Buffer.from(icc)
  }
  return null
}

export function profileDescription(icc: Buffer): string {
  try {
    const count = icc.readUInt32BE(128)
    for (let t = 0; t < count; t++) {
      const o = 132 + t * 12
      if (icc.toString('latin1', o, o + 4) !== 'desc') continue
      const off = icc.readUInt32BE(o + 4)
      const len = icc.readUInt32BE(o + 8)
      const d = icc.subarray(off, off + len)
      if (d.toString('latin1', 0, 4) === 'mluc') {
        const recLen = d.readUInt32BE(20)
        const recOff = d.readUInt32BE(24)
        return Buffer.from(d.subarray(recOff, recOff + recLen)).swap16().toString('utf16le')
      }
      return d.toString('latin1', 12).replace(/\0.*$/s, '')
    }
  } catch {
    /* fall through */
  }
  return ''
}

/** Insert an ICC profile into a JPEG as APP2 ICC_PROFILE segments, after SOI. */
export function tagJpeg(jpeg: Buffer, icc: Buffer | null): Buffer {
  if (!icc || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg
  const sig = Buffer.from('ICC_PROFILE\0', 'latin1')
  const max = 65533 - sig.length - 2
  const parts: Buffer[] = []
  const n = Math.ceil(icc.length / max)
  for (let k = 0; k < n; k++) {
    const chunk = icc.subarray(k * max, (k + 1) * max)
    const seg = Buffer.alloc(4 + sig.length + 2)
    seg[0] = 0xff
    seg[1] = 0xe2
    seg.writeUInt16BE(2 + sig.length + 2 + chunk.length, 2)
    sig.copy(seg, 4)
    seg[4 + sig.length] = k + 1
    seg[5 + sig.length] = n
    parts.push(seg, chunk)
  }
  return Buffer.concat([jpeg.subarray(0, 2), ...parts, jpeg.subarray(2)])
}

/**
 * Insert an ICC profile into a WebP. A simple (lossy VP8) file becomes an
 * extended one: VP8X with the ICC flag, then ICCP, then the image as before.
 */
export function tagWebp(webp: Buffer, icc: Buffer | null): Buffer {
  if (!icc || webp.toString('latin1', 0, 4) !== 'RIFF' || webp.toString('latin1', 8, 12) !== 'WEBP') return webp
  const first = webp.toString('latin1', 12, 16)
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'latin1')
    head.writeUInt32LE(data.length, 4)
    return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
  }
  const iccp = chunk('ICCP', icc)
  let body: Buffer
  if (first === 'VP8X') {
    const vp8x = Buffer.from(webp.subarray(12, 30))
    vp8x[8] = vp8x[8]! | 0x20
    body = Buffer.concat([vp8x, iccp, webp.subarray(30)])
  } else {
    const { width, height } = webpSize(webp)
    const x = Buffer.alloc(10)
    x[0] = 0x20 | (first === 'VP8L' && (webp[12 + 8 + 4]! & 0x10) ? 0x10 : 0)
    x.writeUIntLE(width - 1, 4, 3)
    x.writeUIntLE(height - 1, 7, 3)
    body = Buffer.concat([chunk('VP8X', x), iccp, webp.subarray(12)])
  }
  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(4 + body.length, 4)
  riff.write('WEBP', 8, 'latin1')
  return Buffer.concat([riff, body])
}

function webpSize(webp: Buffer): { width: number; height: number } {
  const type = webp.toString('latin1', 12, 16)
  if (type === 'VP8 ') {
    // Frame header: 3 bytes tag, 3 bytes start code, then 14-bit width and height.
    return { width: webp.readUInt16LE(26) & 0x3fff, height: webp.readUInt16LE(28) & 0x3fff }
  }
  if (type === 'VP8L') {
    const b = webp.readUInt32LE(21)
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
  }
  throw new Error(`unexpected WebP chunk ${type}`)
}
