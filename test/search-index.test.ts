import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JobQueue } from '../src/jobs/queue.ts'
import { createVault, type OpenVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'
import { queueThumbnails, runThumbnails } from '../src/thumbs/jobs.ts'
import { SIZES, thumbPath, type ThumbSize } from '../src/thumbs/render.ts'
import { EMBED, forgetSearchData, indexProgress, queueEmbeddings, queueOcr, queueSearchJobs, relevanceCutoff, retryMissingThumbnailJobs, runEmbeddings, runSearchJobs, searchVault } from '../src/search/index.ts'
import type { ReadText } from '../src/search/ocr.ts'
import { OCR_KEY } from '../src/search/ocr-model.ts'
import { textMarks, textMatches, wordMatch } from '../src/search/text.ts'
import { DIMENSIONS, MODEL_KEY } from '../src/search/model.ts'
import type { Embed } from '../src/search/embedder.ts'
import { scratch, type Scratch } from './helpers.ts'

/**
 * The index without the model: a fake embedder gives each photo a vector by
 * its colour, and each query a vector by its word, so rankings are known.
 */

let s: Scratch
let v: OpenVault
let queue: JobQueue
const ids: Record<string, number> = {}

const colours = { beach: '#e8d27a', forest: '#2f7d32', night: '#101030' } as const
type Name = keyof typeof colours

/** A unit vector pointing mostly along one axis per subject. */
function axis(n: number, mix = 0): Float32Array {
  const v = new Float32Array(DIMENSIONS)
  v[n] = 1
  v[(n + 1) % 3] = mix
  const len = Math.hypot(...v)
  return v.map((x) => x / len)
}
const subjects: Name[] = ['beach', 'forest', 'night']

class FakeEmbed implements Embed {
  images: string[] = []
  constructor(private readonly byThumb: Map<string, Name>) {}
  async image(file: string) {
    this.images.push(file)
    const sha = path.basename(file).split('-')[0]!
    return axis(subjects.indexOf(this.byThumb.get(sha)!))
  }
  async query(text: string) {
    return axis(Math.max(0, subjects.indexOf(text as Name)), 0.2)
  }
}

let fake: FakeEmbed

/** Text "written" on each subject's photo. */
const writing: Record<Name, string[]> = {
  beach: ['GOVERNMENT OF INDIA', 'AADHAAR', '4821 7735 0962'],
  forest: ['Arashiyama Bamboo Grove', 'आधार केंद्र'],
  night: [],
}
class FakeOcr implements ReadText {
  files: string[] = []
  constructor(private readonly byThumb: Map<string, Name>) {}
  async read(file: string) {
    this.files.push(file)
    const sha = path.basename(file).split('-')[0]!
    // One line per 10 pixels down a 64 by 48 thumbnail, characters evenly spaced.
    const lines = writing[this.byThumb.get(sha)!].map((text, i) => ({
      text, conf: 0.99,
      box: [[2, 2 + i * 10], [62, 2 + i * 10], [62, 10 + i * 10], [2, 10 + i * 10]] as [number, number][],
      at: [...text].map((_, k) => (k + 0.5) / text.length),
    }))
    return { width: 64, height: 48, lines }
  }
}
let ocr: FakeOcr

beforeEach(async () => {
  s = scratch()
  v = createVault(path.join(s.dir, 'V'))
  const byThumb = new Map<string, Name>()
  const items: SaveItem[] = []
  for (const [i, name] of subjects.entries()) {
    const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: colours[name] } }).jpeg().toBuffer()
    byThumb.set(createHash('sha256').update(bytes).digest('hex'), name)
    items.push({
      key: name, kind: 'photo', t: Date.UTC(2026, 0, 1 + i), off: 0, w: 64, h: 48, dur: null, fav: false, edited: false,
      subtype: null, sourceUuid: name, lat: null, lon: null, cloud: false,
      place: name === 'forest' ? { label: 'Arashiyama, Kyoto', city: 'Kyoto', region: null, country: 'Japan' } : null,
      files: [{ name: `${name}.jpg`, role: 'master', mime: 'image/jpeg', size: bytes.length, sha256: null, read: async function* () { yield bytes } }],
    })
  }
  // Forest's place needs coordinates to be stored.
  items[1]!.lat = 35.0
  items[1]!.lon = 135.7
  const r = await saveToVault(v, items, [{ uuid: 'AL', name: 'Goa Trip', keys: ['beach'] }])
  for (const n of subjects) ids[n] = r.assets[n]!
  queue = new JobQueue(v.db)
  queueThumbnails(v.db, queue, v.layout.cache)
  await runThumbnails(v.db, queue, v.layout.media, v.layout.cache, { heic: { decode: async () => { throw new Error('no heic here') } } }, { concurrency: 2 })
  fake = new FakeEmbed(byThumb)
  ocr = new FakeOcr(byThumb)
})

afterEach(() => {
  v.db.close()
  s.cleanup()
})

async function index() {
  queueEmbeddings(v.db, queue)
  await runEmbeddings(v.db, queue, v.layout.cache, fake, {})
}

describe('search index', () => {
  it('embeds every visible item once, from its thumbnail', async () => {
    expect(indexProgress(v.db)).toEqual({ done: 0, total: 3 })
    await index()
    expect(indexProgress(v.db)).toEqual({ done: 3, total: 3 })
    expect(fake.images.every((f) => f.startsWith(v.layout.cache) && f.endsWith('-sm.webp'))).toBe(true)
    // Nothing more to do on a second pass.
    expect(queueEmbeddings(v.db, queue)).toBe(0)
  })

  it('ranks by meaning and drops what is far below the best match', async () => {
    await index()
    const hits = searchVault(v.db, await fake.query('night'), 'night')
    expect(hits.map((h) => h.assetId)).toEqual([ids.night])
    expect(hits[0]!.score).toBeGreaterThan(0.9)
  })

  it('also finds items by place and album name', async () => {
    await index()
    const kyoto = searchVault(v.db, await fake.query('kyoto'), 'kyoto')
    expect(kyoto[0]!.assetId).toBe(ids.forest)
    const goa = searchVault(v.db, null, 'goa trip')
    expect(goa.map((h) => h.assetId)).toEqual([ids.beach])
    expect(searchVault(v.db, null, 'zz')).toEqual([])
  })

  it('never indexes or returns hidden items, and erases their vectors', async () => {
    await index()
    v.db.prepare(`UPDATE asset SET hidden = 1 WHERE id = ?`).run(ids.night)
    forgetSearchData(v.db, [ids.night!])
    expect(v.db.prepare(`SELECT COUNT(*) AS n FROM embedding WHERE asset_id = ?`).get(ids.night)).toEqual({ n: 0 })
    expect(searchVault(v.db, await fake.query('night'), 'night').map((h) => h.assetId)).not.toContain(ids.night)
    expect(queueEmbeddings(v.db, queue)).toBe(0)
    expect(indexProgress(v.db)).toEqual({ done: 2, total: 2 })

    // Unhidden: indexed again.
    v.db.prepare(`UPDATE asset SET hidden = 0 WHERE id = ?`).run(ids.night)
    expect(queueEmbeddings(v.db, queue)).toBe(1)
  })

  it('re-embeds vectors made by another model', async () => {
    await index()
    v.db.prepare(`UPDATE embedding SET model = 'older-model'`).run()
    expect(queueEmbeddings(v.db, queue)).toBe(3)
    expect(searchVault(v.db, await fake.query('night'), 'night')).toEqual([])
    await runEmbeddings(v.db, queue, v.layout.cache, fake, {})
    expect(v.db.prepare(`SELECT COUNT(*) AS n FROM embedding WHERE model = ?`).get(MODEL_KEY)).toEqual({ n: 3 })
  })

  it('keeps what stands out from the typical score, measured on a real library', () => {
    // Score shapes from 300 real photos: best, then #5, #10, #20, #40, #100, median.
    const shape = (pts: number[]) => {
      const [best, p5, p10, p20, p40, p100, median] = pts as [number, number, number, number, number, number, number]
      const at = (i: number) => i < 5 ? best + (p5 - best) * i / 4 : i < 10 ? p5 + (p10 - p5) * (i - 4) / 5
        : i < 20 ? p10 + (p20 - p10) * (i - 9) / 10 : i < 40 ? p20 + (p40 - p20) * (i - 19) / 20
        : i < 100 ? p40 + (p100 - p40) * (i - 39) / 60 : p100 + (median - p100) * Math.min(1, (i - 99) / 50)
      return Array.from({ length: 300 }, (_, i) => at(i))
    }
    const kept = (pts: number[]) => { const s = shape(pts); const c = relevanceCutoff(s); return s.filter((x) => x >= c).length }
    // Plenty of temples: a screenful, not the whole library.
    expect(kept([0.764, 0.748, 0.738, 0.704, 0.678, 0.655, 0.643])).toBeGreaterThan(10)
    expect(kept([0.764, 0.748, 0.738, 0.704, 0.678, 0.655, 0.643])).toBeLessThan(30)
    // One bowl of ramen stands far above the rest: just that.
    expect(kept([0.781, 0.662, 0.65, 0.638, 0.622, 0.601, 0.59])).toBeLessThan(5)
    // Nothing matches well: a few, not hundreds.
    expect(kept([0.679, 0.667, 0.655, 0.651, 0.645, 0.63, 0.621])).toBeLessThan(15)
    // A small library falls back to a window under the best.
    expect(relevanceCutoff([0.9, 0.85, 0.7])).toBeCloseTo(0.8)
  })

  it('does not retry an item that failed, on every pass', async () => {
    const broken: Embed = { image: async () => { throw new Error('bad image') }, query: fake.query.bind(fake) }
    queueEmbeddings(v.db, queue)
    await runEmbeddings(v.db, queue, v.layout.cache, broken, { maxAttempts: 1 })
    expect(queue.counts(EMBED).failed).toBe(3)
    expect(queueEmbeddings(v.db, queue)).toBe(0)
  })

  it('reads the text in every visible item from its large thumbnail, alongside the vectors', async () => {
    expect(queueSearchJobs(v.db, queue, { embed: fake, ocr })).toBe(6)
    await runSearchJobs(v.db, queue, v.layout.cache, { embed: fake, ocr }, {})
    expect(ocr.files.every((f) => f.endsWith('-lg.webp'))).toBe(true)
    expect(indexProgress(v.db, { embed: true, ocr: true })).toEqual({ done: 3, total: 3 })
    expect(v.db.prepare(`SELECT text FROM ocr_text WHERE asset_id = ? AND model = ?`).get(ids.night, OCR_KEY)).toEqual({ text: '' })
    expect(queueOcr(v.db, queue)).toBe(0)

    v.db.prepare(`UPDATE asset SET hidden = 1 WHERE id = ?`).run(ids.beach)
    forgetSearchData(v.db, [ids.beach!])
    expect(v.db.prepare(`SELECT COUNT(*) AS n FROM ocr_text WHERE asset_id = ?`).get(ids.beach)).toEqual({ n: 0 })
    expect(textMatches(v.db, 'aadhaar')).toEqual([])
  })

  it('finds words written in photos, forgiving a misspelling, before what only looks alike', async () => {
    await runSearchJobs(v.db, queue, v.layout.cache, { embed: fake, ocr }, {})
    queueSearchJobs(v.db, queue, { embed: fake, ocr })
    await runSearchJobs(v.db, queue, v.layout.cache, { embed: fake, ocr }, {})
    // The query vector points at "night"; the words point at the card.
    const hits = searchVault(v.db, await fake.query('night'), 'aadhar')
    expect(hits[0]!.assetId).toBe(ids.beach)
    expect(searchVault(v.db, null, '482177350962').map((h) => h.assetId)).toEqual([ids.beach])
    expect(searchVault(v.db, null, 'आधार').map((h) => h.assetId)).toEqual([ids.forest])
    expect(searchVault(v.db, null, 'bamboo grove').map((h) => h.assetId)).toEqual([ids.forest])
    expect(searchVault(v.db, null, 'india bamboo').map((h) => h.assetId).sort()).toEqual([ids.beach, ids.forest].sort())
    expect(searchVault(v.db, null, 'giraffe')).toEqual([])
  })

  it('filters by the dates and kinds in the query', async () => {
    await index()
    const now = new Date(2026, 5, 1)
    // Only the forest photo was taken on 2 January 2026.
    expect(searchVault(v.db, null, '2 january 2026', { now }).map((h) => h.assetId)).toEqual([ids.forest])
    // A date alone lists everything in it, newest first.
    expect(searchVault(v.db, null, 'photos from january 2026', { now }).map((h) => h.assetId)).toEqual([ids.night, ids.forest, ids.beach])
    // Meaning within the date: the night photo is not in the first two days.
    const early = { now, limit: 10 }
    expect(searchVault(v.db, await fake.query('night'), 'night before 3 january 2026', early).map((h) => h.assetId)).not.toContain(ids.night)
    expect(searchVault(v.db, await fake.query('night'), 'night this year', early).map((h) => h.assetId)).toContain(ids.night)
    expect(searchVault(v.db, null, 'videos', { now })).toEqual([])
  })

  it('marks where the words are written, word by word', async () => {
    queueSearchJobs(v.db, queue, { embed: fake, ocr })
    await runSearchJobs(v.db, queue, v.layout.cache, { embed: fake, ocr }, {})
    const stored = (id: number) => (v.db.prepare(`SELECT lines FROM ocr_text WHERE asset_id = ?`).get(id) as { lines: string | null }).lines
    expect(stored(ids.night!)).toBeNull()

    // "AADHAAR" is the whole second line: x 2 to 62, y 12 to 20.
    expect(textMarks(stored(ids.beach!), 'aadhar')).toEqual({ w: 64, h: 48, quads: [[2, 12, 62, 12, 62, 20, 2, 20]] })
    // "Bamboo Grove" is the middle of "Arashiyama Bamboo Grove": characters 11 to 23 of 23.
    const grove = textMarks(stored(ids.forest!), 'bamboo grove')!.quads
    expect(grove).toHaveLength(1)
    expect(grove[0]![0]).toBeCloseTo(2 + (60 * 11) / 23, -0.5)
    expect(grove[0]![2]).toBe(62)
    // Devanagari read without spaces: just the word.
    expect(textMarks(stored(ids.forest!), 'आधार')!.quads[0]!.slice(1, 2)).toEqual([12])
    // A long number typed without spaces: its line.
    expect(textMarks(stored(ids.beach!), '482177350962')!.quads).toEqual([[2, 22, 62, 22, 62, 30, 2, 30]])
    expect(textMarks(stored(ids.beach!), 'giraffe')).toBeNull()
    // A Devanagari line read without spaces: only the word's own characters, at its start.
    const run = 'आधारआमआदमी'
    const joined = JSON.stringify({ w: 100, h: 20, lines: [{ t: run, q: [0, 0, 100, 0, 100, 10, 0, 10], x: [...run].map((_, k) => Math.round(((k + 0.5) / run.length) * 1000)) }] })
    expect(textMarks(joined, 'आधार')!.quads).toEqual([[0, 0, 40, 0, 40, 10, 0, 10]])
    // A Latin word that begins a longer one is marked whole.
    const plural = JSON.stringify({ w: 100, h: 20, lines: [{ t: 'invoices', q: [0, 0, 100, 0, 100, 10, 0, 10], x: [...'invoices'].map((_, k) => Math.round(((k + 0.5) / 8) * 1000)) }] })
    expect(textMarks(plural, 'invoice')!.quads).toEqual([[0, 0, 100, 0, 100, 10, 0, 10]])
  })

  it('matches words loosely but not wildly', () => {
    expect(wordMatch('aadhar', 'aadhaar')).toBeGreaterThan(0)
    expect(wordMatch('receipt', 'reciept')).toBe(0)
    expect(wordMatch('receipts', 'receipt')).toBeGreaterThan(0)
    expect(wordMatch('invoice', 'invoices')).toBeGreaterThan(0)
    expect(wordMatch('cat', 'catalogue')).toBe(0)
    expect(wordMatch('cart', 'card')).toBe(0)
    expect(wordMatch('1234', '1243')).toBe(0)
    expect(wordMatch('आधार', 'आधारकार्ड')).toBeGreaterThan(0)
  })
})

describe('an item whose thumbnails are missing', () => {
  // Hiding an item removes its thumbnails; unhiding it used to leave search
  // giving up on it for good ("no thumbnail to read"), so it never came back
  // into search, text search or People.
  it('is waited for, not given up on, and is read once its thumbnail is back', async () => {
    const sha = (v.db.prepare('SELECT sha256 FROM file WHERE asset_id = ?').get(ids.beach) as { sha256: string }).sha256
    const saved = new Map<string, Buffer>()
    for (const size of Object.keys(SIZES) as ThumbSize[]) {
      const p = thumbPath(v.layout.cache, sha, size)
      saved.set(p, fs.readFileSync(p))
      fs.rmSync(p)
    }
    queueSearchJobs(v.db, queue, { embed: fake })
    await runSearchJobs(v.db, queue, v.layout.cache, { embed: fake }, { retryBaseMs: 1, maxAttempts: 2 })
    const job = () => v.db.prepare(`SELECT state, last_error FROM job WHERE kind = ? AND asset_id = ?`).get(EMBED, ids.beach) as { state: string; last_error: string }
    expect(job().state).toBe('failed')
    expect(job().last_error).toMatch(/no thumbnail to read/)

    // A vault from before: such jobs are queued again when it opens.
    expect(retryMissingThumbnailJobs(v.db)).toBe(1)
    for (const [p, bytes] of saved) fs.writeFileSync(p, bytes)
    await runSearchJobs(v.db, queue, v.layout.cache, { embed: fake }, {})
    expect(job().state).toBe('done')
    expect(searchVault(v.db, await fake.query('beach'), 'beach').map((h) => h.assetId)).toContain(ids.beach)
  })
})
