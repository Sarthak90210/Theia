import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { profileDescription, profileFromHead, tagJpeg, tagWebp } from '../src/thumbs/colour.ts'

async function p3(): Promise<Buffer> {
  const tagged = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#808080' } }).withIccProfile('p3').png().toBuffer()
  return (await sharp(tagged).metadata()).icc!
}

const pixels = () => sharp({ create: { width: 48, height: 32, channels: 3, background: { r: 30, g: 140, b: 220 } } })

function colr(icc: Buffer): Buffer {
  const head = Buffer.alloc(12)
  head.writeUInt32BE(12 + icc.length, 0)
  head.write('colrprof', 4, 'latin1')
  return Buffer.concat([head, icc])
}

describe('colour profiles for iPhone photos', () => {
  it('attaches a profile to a JPEG without touching the pixels', async () => {
    const icc = await p3()
    const jpeg = await pixels().jpeg().toBuffer()
    const tagged = tagJpeg(jpeg, icc)
    expect((await sharp(tagged).metadata()).icc?.equals(icc)).toBe(true)
    const a = await sharp(jpeg).raw().toBuffer()
    const b = await sharp(tagged).keepIccProfile().raw().toBuffer()
    expect(b.equals(a)).toBe(true)
  })

  it('attaches a profile to lossy and lossless WebP', async () => {
    const icc = await p3()
    for (const opts of [{ quality: 80 }, { lossless: true }]) {
      const webp = await pixels().webp(opts).toBuffer()
      const tagged = tagWebp(webp, icc)
      const m = await sharp(tagged).metadata()
      expect(m.icc?.equals(icc)).toBe(true)
      expect([m.width, m.height]).toEqual([48, 32])
    }
  })

  it("picks the photo's own profile, not the HDR gain map's", async () => {
    const photo = await p3()
    expect(profileDescription(photo)).toMatch(/P3/)
    // An iPhone's HDR gain-map profile is labelled "... PQ ...". Same length, so swap in place.
    const pq = Buffer.from(photo)
    const at = pq.indexOf(Buffer.from('P3', 'utf16le').swap16())
    Buffer.from('PQ', 'utf16le').swap16().copy(pq, at)
    expect(profileDescription(pq)).toMatch(/PQ/)
    const head = Buffer.concat([Buffer.from('....meta'), colr(pq), colr(photo)])
    expect(profileFromHead(head)?.equals(photo)).toBe(true)
    expect(profileFromHead(Buffer.from('no boxes here'))).toBeNull()
  })
})
