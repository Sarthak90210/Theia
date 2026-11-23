import { describe, expect, it } from 'vitest'
import { checkStructureBuffer } from '../src/verify/containers.ts'
import { makeHeic, makeJpeg, makePng, makeVideo } from './helpers.ts'

describe('video structure', () => {
  it('accepts a complete QuickTime file', () => {
    const r = checkStructureBuffer(makeVideo())
    expect(r.ok).toBe(true)
    expect(r.format).toBe('mp4/qt  ')
  })

  it('rejects a video whose moov index was lost to truncation', () => {
    // The exact shape of the reported corruption: the iPhone writes moov last,
    // so a cut transfer leaves a file that will not play at all.
    const r = checkStructureBuffer(makeVideo({ moov: false }))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/no moov box/)
    expect(r.detail).toMatch(/will not play/)
  })

  it('rejects a video cut mid-box', () => {
    const whole = makeVideo()
    const r = checkStructureBuffer(whole.subarray(0, whole.length - 200))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/truncated|no moov/)
  })

  it('rejects a box that lies about its size instead of reading past the end', () => {
    const v = makeVideo()
    // The ftyp size field sits at offset 0. Claim the box is 2GB.
    v.writeUInt32BE(0x7fffffff, 0)
    const r = checkStructureBuffer(v)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/declares 2147483647 bytes but only \d+ remain/)
  })

  it('rejects a lying mdat size', () => {
    const v = makeVideo()
    // ftyp is 16 bytes, so mdat's size field starts at offset 16.
    v.writeUInt32BE(0x7fffffff, 16)
    expect(checkStructureBuffer(v).ok).toBe(false)
  })
})

describe('still structure', () => {
  it('accepts a complete HEIC', () => {
    const r = checkStructureBuffer(makeHeic())
    expect(r.ok).toBe(true)
    expect(r.format).toBe('heif/heic')
  })

  it('rejects a HEIC with no meta box', () => {
    const r = checkStructureBuffer(makeHeic({ meta: false }))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/meta/)
  })

  it('accepts a complete JPEG', () => {
    expect(checkStructureBuffer(makeJpeg()).ok).toBe(true)
  })

  it('rejects a JPEG missing its end marker', () => {
    const r = checkStructureBuffer(makeJpeg({ eoi: false }))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/EOI|truncated/)
  })

  it('accepts data after the end marker: Samsung trailers, Motion Photo videos', () => {
    // Samsung Gallery appends its metadata after the image, ending "SEFT".
    // Three real photos were refused as truncated for this.
    const samsung = Buffer.concat([makeJpeg(), Buffer.from('\x00\x00SEFH image_utc_data 1749759652760 SEFT', 'latin1')])
    const r = checkStructureBuffer(samsung)
    expect(r.ok).toBe(true)
    expect(r.detail).toMatch(/after the end of the image/)
    // A whole video after it, with the end marker past the first read chunk.
    const motion = Buffer.concat([makeJpeg({ scanBytes: 1024 * 1024 + 7 }), Buffer.alloc(3 * 1024 * 1024, 0x11)])
    expect(checkStructureBuffer(motion).ok).toBe(true)
    // An end marker split across two 1 MB chunks is still found: the scan data
    // starts at byte 34, so its FF is the last byte of the first chunk.
    const split = makeJpeg({ scanBytes: 1024 * 1024 - 1 })
    expect(split[34 + 1024 * 1024 - 1]).toBe(0xff)
    expect(checkStructureBuffer(Buffer.concat([split, Buffer.from('trailer')])).ok).toBe(true)
  })

  it('still rejects a JPEG cut off before its end marker, trailer or not', () => {
    const cut = makeJpeg({ eoi: false })
    expect(checkStructureBuffer(cut).ok).toBe(false)
    expect(checkStructureBuffer(Buffer.concat([cut, Buffer.from('SEFT', 'latin1')])).ok).toBe(false)
  })

  it('rejects a JPEG whose segment runs past the end of the file', () => {
    const j = makeJpeg()
    j.writeUInt16BE(0x7000, 4) // APP0 claims 28KB of payload
    const r = checkStructureBuffer(j)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/declares/)
  })

  it('accepts a complete PNG and rejects one without IEND', () => {
    expect(checkStructureBuffer(makePng()).ok).toBe(true)
    const r = checkStructureBuffer(makePng({ iend: false }))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/IEND/)
  })
})

describe('formats with no checker', () => {
  it('passes but says the check is absent rather than claiming a pass', () => {
    const r = checkStructureBuffer(Buffer.from('not a media file at all'), '.xyz')
    expect(r.ok).toBe(true)
    expect(r.detail).toMatch(/no structural check/)
  })
})
