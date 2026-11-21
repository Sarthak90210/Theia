import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import { Embedder } from '../src/search/embedder.ts'
import { DIMENSIONS } from '../src/search/model.ts'
import { scratch } from './helpers.ts'

/**
 * The real model, as the app runs it: the bundled files, a worker thread, no
 * network. Skipped until `node scripts/prepare-models.mjs` has put the model
 * in .release-tools (it is a build input, kept out of git).
 */

const modelDir = path.resolve('.release-tools/models/embeddinggemma-2')
const present = Embedder.available(modelDir)
const s = scratch()
const embedder = new Embedder(modelDir, { idleMs: 60_000 })
afterAll(async () => {
  await embedder.close()
  s.cleanup()
})

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * b[i]!, 0)

describe.skipIf(!present)('EmbeddingGemma 2 search model', () => {
  it('puts a photo nearer the query that describes it', async () => {
    // A sunset sky: orange over dark blue, the kind of photo people search for.
    const file = path.join(s.dir, 'sunset.webp')
    await sharp({ create: { width: 400, height: 300, channels: 3, background: '#f08a24' } })
      .composite([{ input: await sharp({ create: { width: 400, height: 120, channels: 3, background: '#0b1e4a' } }).png().toBuffer(), top: 180, left: 0 }])
      .webp()
      .toFile(file)

    const photo = await embedder.image(file)
    const [sunset, receipt] = await Promise.all([embedder.query('orange sunset sky'), embedder.query('a paper receipt')])

    expect(photo.length).toBe(DIMENSIONS)
    expect(Math.abs(Math.hypot(...photo) - 1)).toBeLessThan(1e-4)
    expect(dot(photo, sunset)).toBeGreaterThan(dot(photo, receipt))
  }, 120_000)

  it('understands a query in Hindi as well', async () => {
    const [temple, hindi, receipt] = await Promise.all([
      embedder.query('temple'), embedder.query('मंदिर'), embedder.query('a paper receipt'),
    ])
    expect(dot(temple, hindi)).toBeGreaterThan(dot(temple, receipt))
  }, 120_000)

  it('reports a missing model instead of fetching one', () => {
    expect(Embedder.available(path.join(s.dir, 'nowhere'))).toBe(false)
    expect(fs.existsSync(path.join(modelDir, 'onnx', 'model_fp16.onnx_data'))).toBe(true)
  })
})
