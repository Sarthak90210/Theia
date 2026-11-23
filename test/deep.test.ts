import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JobQueue } from '../src/jobs/queue.ts'
import { createVault, type OpenVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'
import { queueThumbnails, runThumbnails } from '../src/thumbs/jobs.ts'
import { DEEP, DEEP_EDGE, deepProgress, partsOf, queueDeep, runDeep, type DeepStages } from '../src/search/deep.ts'
import { DEEP_KEYS } from '../src/search/deep-keys.ts'
import { searchVault, forgetSearchData } from '../src/search/index.ts'
import { DIMENSIONS, MODEL_KEY } from '../src/search/model.ts'
import { OCR_KEY } from '../src/search/ocr-model.ts'
import type { ClusterInput, FaceResult, ReadFaces } from '../src/search/faces.ts'
import type { OcrResult, ReadText } from '../src/search/ocr.ts'
import type { Embed } from '../src/search/embedder.ts'
import { clusterFaces } from '../src/search/cluster-core.mjs'
import { mergeLines, tiles } from '../src/search/ocr-core.mjs'
import { tileStarts, unturnPoint } from '../src/search/face-core.mjs'
import { storeFaces, listPeople, namePerson, settlePeople } from '../src/people/people.ts'
import { answerMaybes, findMaybes, listMaybes, mergeDeepFaces } from '../src/people/maybe.ts'
import { scratch, type Scratch } from './helpers.ts'

/**
 * The closer look without the models: fakes that record what they were
 * given, on a real vault with real thumbnails and originals.
 */

let s: Scratch
let v: OpenVault
let queue: JobQueue
let ids: number[]

const heic = { decode: async () => { throw new Error('no HEIC here') } }

/** A person is a direction in face space; their faces point that way with a little noise. */
function face(who: number, jitter: number): Float32Array {
  const vec = new Float32Array(128)
  vec[who] = 1
  vec[(who + 7) % 128] = jitter
  vec[(who + 13) % 128] = -jitter / 2
  const len = Math.hypot(...vec)
  return vec.map((x) => x / len)
}

function found(...faces: { who: number; jitter: number; box?: [number, number, number, number]; sharpness?: number }[]): FaceResult {
  return {
    width: 1000,
    height: 800,
    faces: faces.map((f, i) => ({
      box: f.box ?? [100 + i * 300, 200, 160, 200],
      landmarks: [[150, 280], [210, 280], [180, 320], [155, 350], [205, 350]],
      score: 0.95,
      sharpness: f.sharpness ?? 300,
      vec: face(f.who, f.jitter),
    })),
  }
}

const unit = (n: number) => {
  const x = new Float32Array(DIMENSIONS)
  x[n] = 1
  return x
}

beforeEach(async () => {
  s = scratch()
  v = createVault(path.join(s.dir, 'V'))
  const items: SaveItem[] = []
  for (let i = 0; i < 4; i++) {
    // Bigger than the large thumbnail, so reading the original shows.
    const bytes = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: `#${(i * 40 + 16).toString(16).padStart(2, '0')}6060` } }).jpeg().toBuffer()
    items.push({
      key: `p${i}`, kind: 'photo', t: Date.UTC(2026, 0, 1 + i), off: 0, w: 2400, h: 1800, dur: null, fav: false, edited: false,
      subtype: null, sourceUuid: `p${i}`, lat: null, lon: null, cloud: false,
      files: [{ name: `p${i}.jpg`, role: 'master', mime: 'image/jpeg', size: bytes.length, sha256: null, read: async function* () { yield bytes } }],
    })
  }
  const r = await saveToVault(v, items, [])
  ids = items.map((it) => r.assets[it.key]!)
  queue = new JobQueue(v.db)
  queueThumbnails(v.db, queue, v.layout.cache)
  await runThumbnails(v.db, queue, v.layout.media, v.layout.cache, { heic }, { concurrency: 2 })
})

afterEach(() => {
  v.db.close()
  s.cleanup()
})

/** What the ordinary pass leaves behind, without running it. */
function firstPass(stages: ('faces' | 'ocr' | 'embed')[], only = ids) {
  for (const id of only) {
    if (stages.includes('faces')) storeFaces(v.db, id, { width: 1000, height: 800, faces: [] })
    if (stages.includes('ocr')) v.db.prepare(`INSERT OR REPLACE INTO ocr_text (asset_id, model, text, lines) VALUES (?, ?, ?, NULL)`).run(id, OCR_KEY, 'short')
    if (stages.includes('embed')) {
      const vec = unit(0)
      v.db.prepare(`INSERT OR REPLACE INTO embedding (asset_id, model, vec) VALUES (?, ?, ?)`).run(id, MODEL_KEY, Buffer.from(vec.buffer))
    }
  }
}

class Fakes {
  faceCalls: { file: string; deep: boolean; width: number }[] = []
  ocrCalls: { file: string; deep: boolean }[] = []
  embedCalls: string[] = []
  onFaces: ((file: string) => void) | null = null
  faces: ReadFaces = {
    read: async (file, opts) => {
      this.faceCalls.push({ file, deep: !!opts?.deep, width: (await sharp(file).metadata()).width! })
      this.onFaces?.(file)
      return found({ who: 5, jitter: 0.1 })
    },
    cluster: async (input: ClusterInput) => clusterFaces(input),
  }
  ocr: ReadText = {
    read: async (file, opts): Promise<OcrResult> => {
      this.ocrCalls.push({ file, deep: !!opts?.deep })
      return { width: 100, height: 100, lines: [{ text: 'a much longer reading of small print', conf: 0.9, box: [[0, 0], [90, 0], [90, 10], [0, 10]], at: [] }] }
    },
  }
  embed: Embed = {
    image: async (file) => {
      this.embedCalls.push(file)
      // The second part (top right) holds a dog; nothing else does.
      return unit(/part1\.jpg$/.test(file) ? 9 : 1)
    },
    query: async () => unit(9),
  }
}

describe('queueing the closer look', () => {
  it('waits for the first pass, and skips what it has already looked at', async () => {
    const f = new Fakes()
    const stages: DeepStages = { faces: f.faces, ocr: f.ocr }
    expect(queueDeep(v.db, queue, stages)).toBe(0)
    firstPass(['faces'], ids.slice(0, 2))
    // OCR's first pass isn't done for any photo yet.
    expect(queueDeep(v.db, queue, stages)).toBe(0)
    firstPass(['faces', 'ocr'])
    expect(queueDeep(v.db, queue, stages)).toBe(4)
    expect(deepProgress(v.db, stages)).toEqual({ done: 0, total: 4 })
    await runDeep(v.db, queue, v.layout.media, v.layout.cache, { heic, stages }, {})
    expect(deepProgress(v.db, stages)).toEqual({ done: 4, total: 4 })
    expect(queueDeep(v.db, queue, stages)).toBe(0)
  })

  it('looks again with only the stage switched on since', async () => {
    const f = new Fakes()
    firstPass(['faces', 'ocr'])
    queueDeep(v.db, queue, { faces: f.faces })
    await runDeep(v.db, queue, v.layout.media, v.layout.cache, { heic, stages: { faces: f.faces } }, {})
    expect(f.faceCalls).toHaveLength(4)
    const both = { faces: f.faces, ocr: f.ocr }
    expect(queueDeep(v.db, queue, both)).toBe(4)
    await runDeep(v.db, queue, v.layout.media, v.layout.cache, { heic, stages: both }, {})
    expect(f.faceCalls).toHaveLength(4)
    expect(f.ocrCalls).toHaveLength(4)
  })
})

describe('looking closer at a photo', () => {
  it('reads the original at full size with every model, keeps what it found, and leaves no copies behind', async () => {
    const f = new Fakes()
    firstPass(['faces', 'ocr', 'embed'])
    const stages = { faces: f.faces, ocr: f.ocr, embed: f.embed }
    queueDeep(v.db, queue, stages)
    await runDeep(v.db, queue, v.layout.media, v.layout.cache, { heic, stages }, {})

    // The original (2400 px), not the 1600 px thumbnail, and asked to look hard.
    expect(f.faceCalls.every((c) => c.deep && c.width === Math.min(2400, DEEP_EDGE))).toBe(true)
    expect(f.ocrCalls.every((c) => c.deep)).toBe(true)
    expect(f.embedCalls).toHaveLength(4 * 5)
    expect(fs.readdirSync(path.join(v.layout.cache, 'deep-tmp'))).toEqual([])

    const looked = v.db.prepare(`SELECT stage, model FROM deep_scan WHERE asset_id = ? ORDER BY stage`).all(ids[0]) as { stage: string; model: string }[]
    expect(looked).toEqual([
      { stage: 'embed', model: DEEP_KEYS.embed },
      { stage: 'faces', model: DEEP_KEYS.faces },
      { stage: 'ocr', model: DEEP_KEYS.ocr },
    ])
    expect((v.db.prepare(`SELECT COUNT(*) AS n FROM embedding_part WHERE asset_id = ?`).get(ids[0]) as { n: number }).n).toBe(5)
    expect((v.db.prepare(`SELECT text FROM ocr_text WHERE asset_id = ?`).get(ids[0]) as { text: string }).text).toMatch(/small print/)
    expect((v.db.prepare(`SELECT COUNT(*) AS n FROM face WHERE asset_id = ?`).get(ids[0]) as { n: number }).n).toBe(1)

    // Hiding a photo forgets all of it.
    forgetSearchData(v.db, [ids[0]!])
    expect(v.db.prepare(`SELECT 1 FROM embedding_part WHERE asset_id = ?`).get(ids[0])).toBeUndefined()
    expect(v.db.prepare(`SELECT 1 FROM deep_scan WHERE asset_id = ?`).get(ids[0])).toBeUndefined()
  })

  it('keeps the first reading of the text when the closer one reads less', async () => {
    const f = new Fakes()
    firstPass(['ocr'])
    const long = 'x'.repeat(200)
    v.db.prepare(`UPDATE ocr_text SET text = ?`).run(long)
    queueDeep(v.db, queue, { ocr: f.ocr })
    await runDeep(v.db, queue, v.layout.media, v.layout.cache, { heic, stages: { ocr: f.ocr } }, {})
    expect((v.db.prepare(`SELECT text FROM ocr_text WHERE asset_id = ?`).get(ids[0]) as { text: string }).text).toBe(long)
    expect(v.db.prepare(`SELECT model FROM deep_scan WHERE asset_id = ? AND stage = 'ocr'`).get(ids[0])).toEqual({ model: DEEP_KEYS.ocr })
  })

  it('keeps nothing of a photo hidden while it was being looked at', async () => {
    const f = new Fakes()
    firstPass(['faces'])
    f.onFaces = (file) => {
      if (path.basename(file) === `${ids[1]}.jpg`) v.db.prepare(`UPDATE asset SET hidden = 1 WHERE id = ?`).run(ids[1])
    }
    queueDeep(v.db, queue, { faces: f.faces })
    await runDeep(v.db, queue, v.layout.media, v.layout.cache, { heic, stages: { faces: f.faces } }, {})
    expect((v.db.prepare(`SELECT COUNT(*) AS n FROM face WHERE asset_id = ?`).get(ids[1]) as { n: number }).n).toBe(0)
    expect((v.db.prepare(`SELECT COUNT(*) AS n FROM face WHERE asset_id = ?`).get(ids[0]) as { n: number }).n).toBe(1)
  })
})

describe('faces found by the closer look', () => {
  it('updates the faces it finds again, keeping who they are and every answer, and adds new ones', () => {
    storeFaces(v.db, ids[0]!, found({ who: 1, jitter: 0.1, box: [100, 200, 160, 200] }))
    const old = v.db.prepare(`SELECT id FROM face WHERE asset_id = ?`).get(ids[0]) as { id: number }
    const person = Number(v.db.prepare(`INSERT INTO person (name, created_at, updated_at) VALUES ('Asha', 0, 0)`).run().lastInsertRowid)
    const other = Number(v.db.prepare(`INSERT INTO person (name, created_at, updated_at) VALUES ('Ravi', 0, 0)`).run().lastInsertRowid)
    v.db.prepare(`UPDATE face SET person_id = ? WHERE id = ?`).run(person, old.id)
    v.db.prepare(`INSERT INTO face_not (face_id, person_id) VALUES (?, ?)`).run(old.id, other)

    // The same face, boxed a little differently, and a small face nobody saw before.
    const added = mergeDeepFaces(v.db, ids[0]!, found({ who: 1, jitter: 0.12, box: [104, 196, 158, 206] }, { who: 2, jitter: 0.1, box: [700, 100, 40, 50] }))
    expect(added).toBe(1)
    const rows = v.db.prepare(`SELECT id, person_id, x FROM face WHERE asset_id = ? ORDER BY id`).all(ids[0]) as { id: number; person_id: number | null; x: number }[]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ id: old.id, person_id: person, x: 0.104 })
    expect(rows[1]!.person_id).toBeNull()
    expect(v.db.prepare(`SELECT 1 FROM face_not WHERE face_id = ? AND person_id = ?`).get(old.id, other)).toBeTruthy()
    expect(v.db.prepare(`SELECT model FROM deep_scan WHERE asset_id = ? AND stage = 'faces'`).get(ids[0])).toEqual({ model: DEEP_KEYS.faces })

    // A first pass again (a new face model) starts over, and the closer look with it.
    storeFaces(v.db, ids[0]!, found({ who: 1, jitter: 0.1 }))
    expect(v.db.prepare(`SELECT 1 FROM deep_scan WHERE asset_id = ? AND stage = 'faces'`).get(ids[0])).toBeUndefined()
  })
})

describe('asking about faces that might be someone', () => {
  /** Asha is named, in photos 0 to 2. Photo 3 has a face a little like her. */
  async function setUp(maybeJitter: number) {
    for (let i = 0; i < 3; i++) storeFaces(v.db, ids[i]!, found({ who: 1, jitter: 0.1 + i * 0.05 }))
    await settlePeople(v.db, { read: async () => { throw new Error('unused') }, cluster: async (x) => clusterFaces(x) })
    const asha = listPeople(v.db)[0]!
    namePerson(v.db, asha.id, 'Asha')
    storeFaces(v.db, ids[3]!, found({ who: 1, jitter: maybeJitter, sharpness: 25 }))
    return asha.id
  }

  it('asks about a blurred face like a named person, and adds it on yes', async () => {
    const asha = await setUp(0.4)
    expect(findMaybes(v.db)).toBe(1)
    const asks = listMaybes(v.db, asha)
    expect(asks.map((a) => a.assetId)).toEqual([ids[3]])
    expect(listPeople(v.db).find((p) => p.id === asha)!.maybe).toBe(1)
    expect(answerMaybes(v.db, asha, [asks[0]!.face], [])).toBe(1)
    expect(listPeople(v.db).find((p) => p.id === asha)!.photos).toBe(4)
    expect(findMaybes(v.db)).toBe(0)
  })

  it('remembers no, and never asks about someone unlike them', async () => {
    const asha = await setUp(0.4)
    findMaybes(v.db)
    const [ask] = listMaybes(v.db, asha)
    expect(answerMaybes(v.db, asha, [], [ask!.face])).toBe(0)
    expect(findMaybes(v.db)).toBe(0)
    expect(v.db.prepare(`SELECT 1 FROM face_not WHERE face_id = ? AND person_id = ?`).get(ask!.face, asha)).toBeTruthy()

    // Someone else entirely is never asked about.
    storeFaces(v.db, ids[3]!, found({ who: 40, jitter: 0.1, sharpness: 25 }))
    expect(findMaybes(v.db)).toBe(0)
  })
})

describe('search by part of a photo', () => {
  it('finds a photo whose corner matches when the whole does not', async () => {
    const f = new Fakes()
    firstPass(['embed'])
    const stages = { embed: f.embed }
    // Before the closer look: no photo stands out, the whole photos say nothing about a dog.
    expect(searchVault(v.db, unit(9), 'dog').every((h) => h.score === 0)).toBe(true)
    queueDeep(v.db, queue, stages)
    // Only one photo has the dog in a corner.
    f.embed.image = async (file) => unit(/part1\.jpg$/.test(file) && path.basename(file).startsWith(`${ids[2]}-`) ? 9 : 1)
    await runDeep(v.db, queue, v.layout.media, v.layout.cache, { heic, stages }, {})
    expect(searchVault(v.db, unit(9), 'dog')[0]).toEqual({ assetId: ids[2], score: 0 })
  })
})

describe('the geometry', () => {
  it('cuts four overlapping quarters and the middle', () => {
    expect(partsOf(1000, 800)).toEqual([[0, 0, 550, 440], [450, 0, 550, 440], [0, 360, 550, 440], [450, 360, 550, 440], [200, 160, 600, 480]])
  })

  it('covers a picture with overlapping tiles', () => {
    expect(tiles(3200, 2400, 1280, 192)).toHaveLength(3 * 3)
    for (const [x, y, w, h] of tiles(3200, 2400, 1280, 192)) {
      expect(x + w).toBeLessThanOrEqual(3200)
      expect(y + h).toBeLessThanOrEqual(2400)
    }
    expect(tiles(800, 600, 1280, 192)).toEqual([[0, 0, 800, 600]])
    // The face finder's windows: same as before for the ordinary look.
    expect(tileStarts(1152)).toEqual([0, 512])
    expect(tileStarts(640)).toEqual([0])
    expect(tileStarts(3200)).toHaveLength(6)
  })

  it('maps a point found in a turned photo back', () => {
    // A 100 x 50 photo turned 90° clockwise is 50 x 100; its top-left corner lands top right.
    expect(unturnPoint([50, 0], 90, 100, 50)).toEqual([0, 0])
    expect(unturnPoint([0, 100], 90, 100, 50)).toEqual([100, 50])
    expect(unturnPoint([0, 100], 270, 100, 50)).toEqual([0, 0])
    expect(unturnPoint([50, 0], 270, 100, 50)).toEqual([100, 50])
  })

  it('keeps one reading of a line read twice: the longer', () => {
    const line = (text: string, x: number, y: number, conf = 0.9) => ({ text, conf, box: [[x, y], [x + 100, y], [x + 100, y + 20], [x, y + 20]] as [number, number][], at: [] })
    const merged = mergeLines([line('INVOI', 0, 0), line('INVOICE 2041', 2, 1), line('Total', 0, 100)])
    expect(merged.map((l: { text: string }) => l.text)).toEqual(['INVOICE 2041', 'Total'])
  })
})

it('names its job kind', () => {
  expect(DEEP).toBe('deep')
})
