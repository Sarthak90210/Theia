import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { HeicPool } from '../src/thumbs/heic-pool.ts'
import { renderThumbnails, thumbPath } from '../src/thumbs/render.ts'
import { heicProfile, profileDescription, tagJpeg } from '../src/thumbs/colour.ts'

const file = process.argv[2]!
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'photos-colour-check-'))
const heic = new HeicPool(1)
try {
  const icc = heicProfile(file)
  assert(icc, 'source profile missing')
  console.log('Source profile:', profileDescription(icc))
  await renderThumbnails(file, 'image/heic', 'sample', cache, { heic })
  for (const size of ['sm', 'lg', 'ph'] as const) {
    const out = thumbPath(cache, 'sample', size)
    const m = await sharp(out).metadata()
    assert(m.icc?.equals(icc), `${size}: missing source ICC profile`)
    console.log(size, `${m.width}x${m.height}`, fs.statSync(out).size, 'bytes, matching ICC')
  }
  const d = await heic.decode(file)
  const full = tagJpeg(await sharp(d.data, { raw: { width: d.width, height: d.height, channels: 4 } }).removeAlpha().jpeg({ quality: 90 }).toBuffer(), icc)
  assert((await sharp(full).metadata()).icc?.equals(icc))
  const normalize = (input: Buffer) => sharp(input).resize(160, 160, { fit: 'fill' }).removeAlpha().raw().toBuffer()
  const a = await normalize(full)
  const b = await normalize(fs.readFileSync(thumbPath(cache, 'sample', 'sm')))
  const meanError = a.reduce((total, value, i) => total + Math.abs(value - b[i]!), 0) / a.length
  assert(meanError < 5, `colour difference ${meanError}`)
  console.log('Thumbnail vs viewer mean RGB difference:', meanError.toFixed(2), '/255')
} finally {
  await heic.close()
  // Only remove the temporary directory created by this check.
  fs.rmSync(cache, { recursive: true, force: true })
}
