import path from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import { OcrReader } from '../src/search/ocr.ts'
import { storedLines, textMarks } from '../src/search/text.ts'
import { scratch } from './helpers.ts'

/** The bundled text reader on a made-up card, tilted the way a phone photo of one is. Skipped without the models. */

const modelDir = path.resolve('.release-tools/models/ppocr')
const present = OcrReader.available(modelDir)
const reader = new OcrReader(modelDir, { idleMs: 60_000 })
const s = scratch()

afterAll(async () => {
  await reader.close()
  s.cleanup()
})

describe.skipIf(!present)('reading text in photos', () => {
  it('reads English, Devanagari and numbers off a tilted card', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="880"><rect width="100%" height="100%" fill="#e9e3d3"/>
      <g transform="rotate(-6 700 440)"><rect x="150" y="120" width="1100" height="640" rx="30" fill="#fff" stroke="#333" stroke-width="3"/>
      <text x="220" y="230" font-family="Arial" font-size="54" font-weight="bold" fill="#c0392b">भारत सरकार</text>
      <text x="620" y="230" font-family="Arial" font-size="48" fill="#1a1a1a">Government of India</text>
      <text x="380" y="650" font-family="Arial" font-size="64" font-weight="bold" fill="#111">4821 7735 0962</text>
      <text x="380" y="720" font-family="Arial" font-size="44" fill="#c0392b">आधार</text></g></svg>`
    const file = path.join(s.dir, 'card.webp')
    await sharp(Buffer.from(svg)).webp().toFile(file)
    const { lines, width, height } = await reader.read(file)
    expect([width, height]).toEqual([1400, 880])
    const text = lines.map((l) => l.text).join('\n')
    expect(text).toContain('Government of India')
    expect(text).toContain('4821 7735 0962')
    expect(text.replace(/\s/g, '')).toContain('भारतसरकार')
    expect(text).toContain('आधार')

    // "India" alone is marked: the last fifth or so of its line, not the whole line.
    const line = lines.find((l) => l.text.includes('Government of India'))!
    const lineWidth = Math.hypot(line.box[1]![0] - line.box[0]![0], line.box[1]![1] - line.box[0]![1])
    const [q] = textMarks(storedLines({ width, height, lines }), 'india')!.quads
    const markWidth = Math.hypot(q![2]! - q![0]!, q![3]! - q![1]!)
    expect(markWidth / lineWidth).toBeGreaterThan(0.15)
    expect(markWidth / lineWidth).toBeLessThan(0.35)
    expect(Math.abs(q![2]! - line.box[1]![0])).toBeLessThan(lineWidth * 0.1)
  }, 60_000)

  it('finds no text in a plain photo', async () => {
    const file = path.join(s.dir, 'sky.webp')
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#6fa8dc' } }).webp().toFile(file)
    expect((await reader.read(file)).lines).toEqual([])
  }, 60_000)
})
