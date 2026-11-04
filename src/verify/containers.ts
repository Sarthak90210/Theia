import { BufferAccess, type RandomAccess } from './random-access.ts'

/**
 * Level 2 verification: walk the container without decoding pixels.
 *
 * This is the level that catches the failure actually observed on the
 * reference device. The iPhone writes captured video with the `moov` index at
 * the end of the file, because it only knows the index once recording stops. A
 * truncated transfer loses the index entirely, so the file will not play at
 * all rather than playing partially. Reading a handful of box headers detects
 * that in milliseconds.
 *
 * Everything here reads through RandomAccess, never a whole Buffer. The
 * largest file in the reference library is 4.90 GB.
 */

export interface StructureResult {
  ok: boolean
  format: string
  detail?: string
}

const pass = (format: string, detail?: string): StructureResult => ({ ok: true, format, detail })
const fail = (format: string, detail: string): StructureResult => ({ ok: false, format, detail })

export type Format = 'jpeg' | 'isobmff' | 'png' | 'tiff' | 'gif' | 'plist' | 'unknown'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function sniffFormat(src: RandomAccess): Format {
  const head = src.read(0, 16)
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png'
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') return 'isobmff'
  if (head.length >= 4) {
    const magic = head.subarray(0, 4)
    if (magic.equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))) return 'tiff'
    if (magic.equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) return 'tiff'
  }
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif'
  if (head.subarray(0, 8).toString('latin1') === 'bplist00') return 'plist'
  if (head.subarray(0, 5).toString('latin1') === '<?xml') return 'plist'
  return 'unknown'
}

/* ------------------------------------------------------------------ JPEG */

/** Markers carrying no length field. */
const STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9])

export function checkJpeg(src: RandomAccess): StructureResult {
  if (src.size < 4) return fail('jpeg', 'file is too short to be a JPEG')
  const head = src.read(0, 2)
  if (head[0] !== 0xff || head[1] !== 0xd8) return fail('jpeg', 'missing SOI marker at offset 0')

  // Headers live at the front. Walking them needs at most a few hundred KB,
  // and entropy-coded scan data is not length-prefixed so it is not walkable.
  let i = 2
  let sawSos = false
  while (i + 4 <= src.size) {
    const marker = src.read(i, 4)
    if (marker[0] !== 0xff) {
      return fail('jpeg', `expected a marker at offset ${i}, found 0x${marker[0]!.toString(16)}`)
    }
    let code = marker[1]!
    // Fill bytes between markers are legal.
    let skip = 0
    while (code === 0xff && i + 2 + skip < src.size) {
      skip++
      code = src.read(i + 1 + skip, 1)[0]!
    }
    i += 2 + skip

    if (STANDALONE.has(code)) continue

    const lenBytes = src.read(i, 2)
    if (lenBytes.length < 2) return fail('jpeg', `segment 0x${code.toString(16)} header runs past end of file`)
    const segLength = lenBytes.readUInt16BE(0)
    if (segLength < 2) {
      return fail('jpeg', `segment 0x${code.toString(16)} declares an impossible length of ${segLength}`)
    }
    if (i + segLength > src.size) {
      return fail(
        'jpeg',
        `segment 0x${code.toString(16)} declares ${segLength} bytes but only ${src.size - i} remain`,
      )
    }
    i += segLength
    if (code === 0xda) {
      sawSos = true
      break
    }
  }

  if (!sawSos) return fail('jpeg', 'no start-of-scan marker, the image carries no pixel data')

  const tail = src.read(src.size - 2, 2)
  if (tail.length < 2 || tail[0] !== 0xff || tail[1] !== 0xd9) {
    return fail('jpeg', 'missing EOI marker at end of file, the image is truncated')
  }
  return pass('jpeg')
}

/* --------------------------------------------------------------- ISO BMFF */

export interface Box {
  type: string
  start: number
  size: number
}

export function walkBoxes(src: RandomAccess): { boxes: Box[]; error?: string } {
  const boxes: Box[] = []
  let offset = 0

  while (offset + 8 <= src.size) {
    const header = src.read(offset, 16)
    if (header.length < 8) {
      return { boxes, error: `box header at ${offset} is incomplete, the file is truncated` }
    }
    const declared = header.readUInt32BE(0)
    const type = header.subarray(4, 8).toString('latin1')
    let size = declared
    let headerBytes = 8

    if (declared === 1) {
      if (header.length < 16) {
        return { boxes, error: `64-bit size for box "${type}" runs past end of file` }
      }
      const large = header.readBigUInt64BE(8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { boxes, error: `box "${type}" declares an implausible size` }
      }
      size = Number(large)
      headerBytes = 16
    } else if (declared === 0) {
      // Legal only as the final box: runs to end of file.
      size = src.size - offset
    }

    if (size < headerBytes) {
      return { boxes, error: `box "${type}" at ${offset} declares size ${size}, smaller than its own header` }
    }
    if (offset + size > src.size) {
      return {
        boxes,
        error: `box "${type}" at ${offset} declares ${size} bytes but only ${src.size - offset} remain, the file is truncated`,
      }
    }

    boxes.push({ type, start: offset, size })
    offset += size
  }

  if (offset !== src.size) {
    return { boxes, error: `${src.size - offset} trailing bytes after the last complete box` }
  }
  return { boxes }
}

const STILL_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif'])

export function checkIsoBmff(src: RandomAccess): StructureResult {
  if (src.size < 16) return fail('isobmff', 'file is too short to hold a single box')

  const { boxes, error } = walkBoxes(src)
  const types = new Set(boxes.map((b) => b.type))
  const first = boxes[0]
  const brand = first?.type === 'ftyp' ? src.read(first.start + 8, 4).toString('latin1') : ''
  const isStill = STILL_BRANDS.has(brand)
  const format = first?.type === 'ftyp' ? (isStill ? `heif/${brand}` : `mp4/${brand}`) : 'isobmff'

  // Report the missing index ahead of the byte-level complaint. Both are true
  // of a truncated video, and "no moov" is the one that explains the symptom.
  if (!isStill && boxes.length > 0 && !types.has('moov')) {
    return fail(
      format,
      'no moov box, the video has no index and will not play; the transfer was truncated',
    )
  }
  if (error) return fail(format, error)
  if (!first || first.type !== 'ftyp') return fail(format, 'no ftyp box at the start of the file')

  if (isStill) {
    if (!types.has('meta')) return fail(format, 'no meta box, a HEIF still cannot be located without one')
    if (!types.has('mdat') && !types.has('idat')) return fail(format, 'no mdat box, the image data is missing')
    return pass(format)
  }

  if (!types.has('mdat')) return fail(format, 'no mdat box, the video carries no samples')
  return pass(format)
}

/* ------------------------------------------------------------------- PNG */

export function checkPng(src: RandomAccess): StructureResult {
  if (src.size < 12 || !src.read(0, 8).equals(PNG_SIGNATURE)) {
    return fail('png', 'missing PNG signature')
  }
  let offset = 8
  let sawIhdr = false
  let sawIend = false
  while (offset + 12 <= src.size) {
    const header = src.read(offset, 8)
    if (header.length < 8) break
    const length = header.readUInt32BE(0)
    const type = header.subarray(4, 8).toString('latin1')
    const total = 12 + length
    if (offset + total > src.size) {
      return fail('png', `chunk "${type}" declares ${length} bytes of payload but the file ends first`)
    }
    if (offset === 8 && type !== 'IHDR') return fail('png', 'first chunk is not IHDR')
    if (type === 'IHDR') sawIhdr = true
    if (type === 'IEND') {
      sawIend = true
      break
    }
    offset += total
  }
  if (!sawIhdr) return fail('png', 'no IHDR chunk')
  if (!sawIend) return fail('png', 'no IEND chunk, the file is truncated')
  return pass('png')
}

/* ----------------------------------------------------------------- entry */

export function checkStructure(src: RandomAccess, hintExtension?: string): StructureResult {
  switch (sniffFormat(src)) {
    case 'jpeg':
      return checkJpeg(src)
    case 'isobmff':
      return checkIsoBmff(src)
    case 'png':
      return checkPng(src)
    case 'tiff':
      // DNG and friends. An IFD walk belongs here eventually; saying so beats
      // reporting a pass that checked almost nothing.
      return pass('tiff', 'header only, IFD walk not implemented')
    case 'gif': {
      const tail = src.read(src.size - 1, 1)
      return tail[0] === 0x3b ? pass('gif') : fail('gif', 'missing trailer byte, the file is truncated')
    }
    case 'plist':
      return pass('plist')
    default:
      return pass(`unknown${hintExtension ? ` (${hintExtension})` : ''}`, 'no structural check for this format')
  }
}

/** Convenience for tests and small in-memory payloads. */
export function checkStructureBuffer(buf: Buffer, hintExtension?: string): StructureResult {
  return checkStructure(new BufferAccess(buf), hintExtension)
}
