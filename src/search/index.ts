import fs from 'node:fs'
import type { Db } from '../library/db.ts'
import { drain, PermanentJobError, type Job, type JobQueue, type RunOptions } from '../jobs/queue.ts'
import { thumbPath } from '../thumbs/render.ts'
import { THUMBNAIL } from '../thumbs/jobs.ts'
import type { Embed } from './embedder.ts'
import type { ReadText } from './ocr.ts'
import type { ReadFaces } from './faces.ts'
import { FACE_KEY } from './face-model.ts'
import { forgetFaces, peopleInQuery, storeFaces } from '../people/people.ts'
import { DIMENSIONS, MODEL_KEY } from './model.ts'
import { OCR_KEY } from './ocr-model.ts'
import { hasFilter, parseQuery, type ParsedQuery, type SearchFilter } from './query.ts'
import { contentWords, storedLines, textMatches } from './text.ts'

/**
 * The search index of a vault, all of it in the vault's own library.db next
 * to everything else known about each item, keyed by asset:
 *
 * - embedding: one EmbeddingGemma 2 vector per item, from its grid thumbnail
 *   (already decoded from HEIC, and plenty at 70 vision tokens).
 * - ocr_text: the text written in it, read from the 1600px thumbnail.
 * - dates, places and albums are the item's own columns, already there.
 *
 * Each model is a stage: a job kind that runs after thumbnails, and a table
 * whose rows name the model that made them, so a new model re-runs its own
 * stage and nothing else. Hidden and Recently Deleted items are never read,
 * and what was read is erased when they get there: a vector or a line of text
 * says what is in the photo.
 */

export const EMBED = 'embed'
export const OCR = 'ocr'
export const FACES = 'faces'

export interface Stages {
  embed?: Embed | null
  ocr?: ReadText | null
  faces?: ReadFaces | null
}

type StageName = 'embed' | 'ocr' | 'faces'

interface Stage {
  kind: string
  table: 'embedding' | 'ocr_text' | 'face_scan'
  key: string
}
const STAGES: Record<StageName, Stage> = {
  embed: { kind: EMBED, table: 'embedding', key: MODEL_KEY },
  ocr: { kind: OCR, table: 'ocr_text', key: OCR_KEY },
  faces: { kind: FACES, table: 'face_scan', key: FACE_KEY },
}

/** Visible, with thumbnails made, and not yet read by the stage's current model. */
function needs(s: Stage): string {
  return `
  FROM asset a
  JOIN file f ON f.asset_id = a.id AND f.is_primary = 1
  JOIN job t ON t.asset_id = a.id AND t.kind = '${THUMBNAIL}' AND t.state = 'done'
  LEFT JOIN ${s.table} e ON e.asset_id = a.id AND e.model = ?
  LEFT JOIN job j ON j.asset_id = a.id AND j.kind = '${s.kind}'
 WHERE a.hidden = 0 AND a.deleted_at IS NULL AND f.encrypted_path IS NULL AND e.asset_id IS NULL`
}

/**
 * Queue a stage for every item that needs it. A job that failed stays failed
 * (it would only fail again); one marked done whose row is missing or from an
 * older model goes back in the queue.
 */
function queueStage(db: Db, queue: JobQueue, s: Stage): number {
  const rows = db.prepare(`SELECT a.id, j.state ${needs(s)}`).all(s.key) as { id: number; state: string | null }[]
  let added = 0
  db.transaction(() => {
    for (const r of rows) {
      if (r.state === 'queued' || r.state === 'running' || r.state === 'failed') continue
      queue.enqueue(s.kind, r.id)
      added++
    }
  })()
  return added
}

export function queueEmbeddings(db: Db, queue: JobQueue): number {
  return queueStage(db, queue, STAGES.embed)
}

export function queueOcr(db: Db, queue: JobQueue): number {
  return queueStage(db, queue, STAGES.ocr)
}

/** Queue every stage that has a model. Returns how many jobs are waiting. */
export function queueSearchJobs(db: Db, queue: JobQueue, stages: Stages): number {
  let waiting = 0
  for (const [name, s] of Object.entries(STAGES) as [StageName, Stage][]) {
    if (!stages[name]) continue
    queue.recover(s.kind)
    queueStage(db, queue, s)
    waiting += queue.counts(s.kind).queued
  }
  return waiting
}

/**
 * Items read by every stage that has a model, and items that could be. For
 * "Preparing search · 1,200 of 4,288".
 */
export function indexProgress(db: Db, stages: { embed?: unknown; ocr?: unknown; faces?: unknown } = { embed: true }): { done: number; total: number } {
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM asset WHERE hidden = 0 AND deleted_at IS NULL`).get() as { n: number }).n
  // Read by the stage's current model, or given up on (a file it cannot read):
  // either way there is nothing left to do for that item.
  const conds: string[] = []
  const args: string[] = []
  for (const [name, s] of Object.entries(STAGES) as [StageName, Stage][]) {
    if (!stages[name]) continue
    conds.push(`(EXISTS (SELECT 1 FROM ${s.table} t WHERE t.asset_id = a.id AND t.model = ?)
              OR EXISTS (SELECT 1 FROM job j WHERE j.asset_id = a.id AND j.kind = '${s.kind}' AND j.state = 'failed'))`)
    args.push(s.key)
  }
  if (!conds.length) return { done: 0, total }
  const done = (
    db.prepare(`SELECT COUNT(*) AS n FROM asset a WHERE a.hidden = 0 AND a.deleted_at IS NULL AND ${conds.join(' AND ')}`).get(...args) as { n: number }
  ).n
  return { done, total }
}

type Primary = { sha256: string; encrypted_path: string | null; hidden: number; deleted_at: number | null }
const isPrivate = (r: Primary | undefined) => !r || !!r.encrypted_path || r.hidden === 1 || r.deleted_at !== null

/** Run `read` on the item's thumbnail and store what it returns, unless the item became private meanwhile. */
function stageHandler<T>(db: Db, cacheRoot: string, sizes: ('sm' | 'lg')[], read: (thumb: string) => Promise<T>, store: (id: number, value: T) => void) {
  const primary = db.prepare(
    `SELECT f.sha256, f.encrypted_path, a.hidden, a.deleted_at FROM file f JOIN asset a ON a.id = f.asset_id
      WHERE f.asset_id = ? AND f.is_primary = 1`,
  )
  return async (job: Job) => {
    const row = primary.get(job.assetId) as Primary | undefined
    if (!row) throw new PermanentJobError(`asset ${job.assetId} has no primary file`)
    if (isPrivate(row)) return
    const thumb = sizes.map((s) => thumbPath(cacheRoot, row.sha256, s)).find((p) => fs.existsSync(p))
    if (!thumb) throw new PermanentJobError('no thumbnail to read')
    const value = await read(thumb)
    // Hidden or deleted while the model was busy: keep nothing.
    if (isPrivate(primary.get(job.assetId) as Primary | undefined)) return
    store(job.assetId, value)
  }
}

export function embeddingHandler(db: Db, cacheRoot: string, embed: Embed) {
  const store = db.prepare(`INSERT OR REPLACE INTO embedding (asset_id, model, vec) VALUES (?, ?, ?)`)
  return stageHandler(
    db, cacheRoot, ['sm'],
    async (thumb) => {
      const vec = await embed.image(thumb)
      if (vec.length !== DIMENSIONS) throw new PermanentJobError(`vector has ${vec.length} dimensions, expected ${DIMENSIONS}`)
      return vec
    },
    (id, vec) => store.run(id, MODEL_KEY, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)),
  )
}

export function ocrHandler(db: Db, cacheRoot: string, ocr: ReadText) {
  const store = db.prepare(`INSERT OR REPLACE INTO ocr_text (asset_id, model, text, lines) VALUES (?, ?, ?, ?)`)
  // The large thumbnail: small print is unreadable at grid size.
  return stageHandler(
    db, cacheRoot, ['lg', 'sm'],
    (thumb) => ocr.read(thumb),
    (id, r) => store.run(id, OCR_KEY, r.lines.map((l) => l.text).join('\n'), r.lines.length ? storedLines(r) : null),
  )
}

export function runEmbeddings(db: Db, queue: JobQueue, cacheRoot: string, embed: Embed, opts: Omit<RunOptions, 'concurrency'>): Promise<void> {
  queue.recover(EMBED)
  // The worker reads one photo at a time; queueing more only adds waiting.
  return drain(queue, EMBED, embeddingHandler(db, cacheRoot, embed), { ...opts, concurrency: 1 })
}

export function runOcr(db: Db, queue: JobQueue, cacheRoot: string, ocr: ReadText, opts: Omit<RunOptions, 'concurrency'>): Promise<void> {
  queue.recover(OCR)
  return drain(queue, OCR, ocrHandler(db, cacheRoot, ocr), { ...opts, concurrency: 1 })
}

export function faceHandler(db: Db, cacheRoot: string, faces: ReadFaces) {
  return stageHandler(db, cacheRoot, ['lg', 'sm'], (thumb) => faces.read(thumb), (id, r) => storeFaces(db, id, r))
}

export function runFaces(db: Db, queue: JobQueue, cacheRoot: string, faces: ReadFaces, opts: Omit<RunOptions, 'concurrency'>): Promise<void> {
  queue.recover(FACES)
  return drain(queue, FACES, faceHandler(db, cacheRoot, faces), { ...opts, concurrency: 1 })
}

/** Every stage with a model, side by side: each has its own worker and threads. */
export async function runSearchJobs(db: Db, queue: JobQueue, cacheRoot: string, stages: Stages, opts: Omit<RunOptions, 'concurrency'>): Promise<void> {
  await Promise.all([
    stages.embed ? runEmbeddings(db, queue, cacheRoot, stages.embed, opts) : null,
    stages.ocr ? runOcr(db, queue, cacheRoot, stages.ocr, opts) : null,
    stages.faces ? runFaces(db, queue, cacheRoot, stages.faces, opts) : null,
  ])
}

/** Erase what was read from items just hidden or deleted. They are read again if they come back. */
export function forgetSearchData(db: Db, ids: number[]): void {
  const stmts = [
    ...Object.values(STAGES).flatMap((s) => [
      db.prepare(`DELETE FROM ${s.table} WHERE asset_id = ?`),
      db.prepare(`DELETE FROM job WHERE kind = '${s.kind}' AND asset_id = ?`),
    ]),
    // The closer look's (src/search/deep.ts).
    db.prepare(`DELETE FROM embedding_part WHERE asset_id = ?`),
    db.prepare(`DELETE FROM deep_scan WHERE asset_id = ?`),
    db.prepare(`DELETE FROM job WHERE kind = 'deep' AND asset_id = ?`),
  ]
  db.transaction(() => {
    for (const id of ids) for (const s of stmts) s.run(id)
  })()
  forgetFaces(db, ids)
}


export interface SearchHit {
  assetId: number
  /** Cosine similarity, or null for a match on text, name or date only. */
  score: number | null
}

/**
 * Rank visible items for a query. Dates and media types typed in the query
 * ("last december", "videos") are taken out first and become a hard filter.
 * What is left is looked for three ways, merged by reciprocal rank fusion:
 *
 * - by meaning: cosine between the query vector and each photo vector.
 *   These scores bunch together: on a real library an unrelated photo scores
 *   about 0.62 to 0.68 and the best match 0.70 to 0.78, so a fixed cut-off
 *   means nothing. What does is how far a photo stands above the typical
 *   (median) score of the library: kept when at least halfway from the median
 *   to the best match among the photos the filter allows, and clearly above
 *   the median even when nothing matches well. Below about 20 photos the
 *   median says little, and a window under the best is used.
 * - by the text written in the photo, forgiving of typos (src/search/text.ts).
 *   A photo with every word of the query counts a little more than a visual
 *   match at the same rank: "aadhar" puts the card first.
 * - by name: the place it was taken or an album it is in contains the query,
 *   so "kyoto" finds Kyoto even when Kyoto looks like anywhere.
 * - by meaning, in part of the photo: photos given a closer look (deep.ts)
 *   also have vectors for their quarters and middle. Each photo's best part
 *   is ranked like the whole photos, with its own cut-off, as a list of its
 *   own: a dog in a corner of a wide shot is found without every busy photo
 *   outranking the clear matches.
 *
 * With nothing left after the filter ("photos from 2024"), the filter alone
 * is the answer, newest first.
 *
 * Brute force over every vector. 40,000 photos at 256 dimensions is about
 * 40 MB read and 10 million multiply-adds: tens of milliseconds.
 */
export function searchVault(
  db: Db,
  query: Float32Array | null,
  input: string | ParsedQuery,
  opts: { limit?: number; now?: Date; /** Match the words written in photos (on unless switched off). */ text?: boolean } = {},
): SearchHit[] {
  const limit = opts.limit ?? 300
  let parsed = typeof input === 'string' ? parseQuery(input, opts.now) : input
  // Named people are a filter too: "mom beach" is beaches with Mom in them.
  const people = parsed.text ? peopleInQuery(db, parsed.text) : null
  if (people?.ids.length) {
    parsed = { ...parsed, text: contentWords(people.rest).length ? people.rest : '', filter: { ...parsed.filter, people: people.ids } }
  }
  const allowed = hasFilter(parsed.filter) ? filteredIds(db, parsed.filter) : null
  const ok = (id: number) => !allowed || allowed.has(id)

  if (!parsed.text) {
    if (!allowed) return []
    return newestFirst(db, parsed.filter).map((assetId) => ({ assetId, score: null }))
  }

  const semantic: { id: number; score: number }[] = []
  if (query) {
    const all: number[] = []
    const rows = db
      .prepare(
        `SELECT e.asset_id, e.vec FROM embedding e JOIN asset a ON a.id = e.asset_id
          WHERE e.model = ? AND a.hidden = 0 AND a.deleted_at IS NULL`,
      )
      .iterate(MODEL_KEY) as Iterable<{ asset_id: number; vec: Buffer }>
    for (const r of rows) {
      const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
      if (v.length !== query.length) continue
      let s = 0
      for (let i = 0; i < v.length; i++) s += v[i]! * query[i]!
      all.push(s)
      if (ok(r.asset_id)) semantic.push({ id: r.asset_id, score: s })
    }
    all.sort((a, b) => b - a)
    semantic.sort((a, b) => b.score - a.score)
    const cutoff = relevanceCutoff(all, semantic[0]?.score)
    let keep = semantic.findIndex((h) => h.score < cutoff)
    if (keep < 0) keep = semantic.length
    semantic.length = Math.min(keep, limit)
  }
  const parts = query ? partMatches(db, query, ok, limit) : []

  const written = opts.text === false ? [] : textMatches(db, parsed.text, limit).filter((h) => ok(h.assetId))
  const named = nameMatches(db, parsed.text, limit).filter(ok)

  const fused = new Map<number, { rrf: number; score: number | null }>()
  const add = (id: number, rank: number, score: number | null, weight: number) => {
    const f = fused.get(id) ?? { rrf: 0, score: null }
    f.rrf += weight / (60 + rank)
    if (score !== null) f.score = score
    fused.set(id, f)
  }
  semantic.forEach((h, i) => add(h.id, i, h.score, 1))
  // A little below the whole photo: a part matching is weaker evidence.
  parts.forEach((h, i) => add(h.id, i, fused.get(h.id)?.score ?? h.score, 0.85))
  written.forEach((h, i) => add(h.assetId, i, null, h.full ? 1.1 : 0.8))
  // A place or album name that contains the query is the more literal match,
  // so at the same rank it goes first.
  named.forEach((id, i) => add(id, i, null, 1.2))
  return [...fused.entries()]
    .sort((a, b) => b[1].rrf - a[1].rrf || (b[1].score ?? -1) - (a[1].score ?? -1))
    .slice(0, limit)
    .map(([assetId, f]) => ({ assetId, score: f.score }))
}

/** Each photo's best-matching part (deep.ts), best first, above that list's own cut-off. */
function partMatches(db: Db, query: Float32Array, ok: (id: number) => boolean, limit: number): { id: number; score: number }[] {
  const best = new Map<number, number>()
  const rows = db
    .prepare(
      `SELECT p.asset_id, p.vec FROM embedding_part p JOIN asset a ON a.id = p.asset_id
        WHERE p.model = ? AND a.hidden = 0 AND a.deleted_at IS NULL`,
    )
    .iterate(MODEL_KEY) as Iterable<{ asset_id: number; vec: Buffer }>
  for (const r of rows) {
    const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
    if (v.length !== query.length) continue
    let s = 0
    for (let i = 0; i < v.length; i++) s += v[i]! * query[i]!
    if (s > (best.get(r.asset_id) ?? -Infinity)) best.set(r.asset_id, s)
  }
  if (!best.size) return []
  const all = [...best.values()].sort((a, b) => b - a)
  const hits = [...best].filter(([id]) => ok(id)).map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score)
  const cutoff = relevanceCutoff(all, hits[0]?.score)
  return hits.filter((h) => h.score >= cutoff).slice(0, limit)
}

/**
 * The lowest score still worth showing, from all scores sorted best first.
 * `best` is the best among the photos a filter allows, when there is one.
 * See searchVault.
 */
export function relevanceCutoff(sorted: number[], best = sorted[0] ?? 0): number {
  if (sorted.length < 20) return best - 0.1
  const median = sorted[Math.floor(sorted.length / 2)]!
  return Math.max(median + 0.5 * (best - median), median + 0.04)
}

/** The item's local time: capture time plus its offset, or when it was saved. */
const LOCAL_MS = `(COALESCE(a.captured_utc + COALESCE(a.captured_offset, 0) * 1000, a.created_at))`

function filterSql(f: SearchFilter): { where: string; args: (number | string)[] } {
  const parts = ['a.hidden = 0', 'a.deleted_at IS NULL']
  const args: (number | string)[] = []
  if (f.range) {
    if (Number.isFinite(f.range.from)) { parts.push(`${LOCAL_MS} >= ?`); args.push(f.range.from) }
    if (Number.isFinite(f.range.to)) { parts.push(`${LOCAL_MS} < ?`); args.push(f.range.to) }
  }
  if (f.month !== undefined) {
    parts.push(`CAST(strftime('%m', ${LOCAL_MS} / 1000, 'unixepoch') AS INTEGER) = ?`)
    args.push(f.month + 1)
  }
  if (f.day !== undefined) {
    parts.push(`CAST(strftime('%d', ${LOCAL_MS} / 1000, 'unixepoch') AS INTEGER) = ?`)
    args.push(f.day)
  }
  if (f.kinds?.length) {
    parts.push(`a.kind IN (${f.kinds.map(() => '?').join(', ')})`)
    args.push(...f.kinds)
  }
  if (f.favourite) parts.push('a.favourite = 1')
  for (const p of f.people ?? []) {
    parts.push('EXISTS (SELECT 1 FROM face fp WHERE fp.asset_id = a.id AND fp.person_id = ?)')
    args.push(p)
  }
  return { where: parts.join(' AND '), args }
}

function filteredIds(db: Db, f: SearchFilter): Set<number> {
  const { where, args } = filterSql(f)
  return new Set((db.prepare(`SELECT a.id FROM asset a WHERE ${where}`).all(...args) as { id: number }[]).map((r) => r.id))
}

function newestFirst(db: Db, f: SearchFilter): number[] {
  const { where, args } = filterSql(f)
  return (db.prepare(`SELECT a.id FROM asset a WHERE ${where} ORDER BY ${LOCAL_MS} DESC, a.id DESC`).all(...args) as { id: number }[]).map((r) => r.id)
}

/** Items whose place or album name contains all the query's words, newest first. */
function nameMatches(db: Db, text: string, limit: number): number[] {
  const words = contentWords(text).map((w) => w.replace(/[%_\\]/g, '')).filter((w) => w.length >= 3)
  if (!words.length) return []
  const one = `(lower(COALESCE(p.label,'') || ' ' || COALESCE(p.city,'') || ' ' || COALESCE(p.region,'') || ' ' || COALESCE(p.country,'')) LIKE ? ESCAPE '\\'
               OR EXISTS (SELECT 1 FROM album_asset x JOIN album al ON al.id = x.album_id WHERE x.asset_id = a.id AND lower(al.name) LIKE ? ESCAPE '\\'))`
  const where = words.map(() => one).join(' AND ')
  const args = words.flatMap((w) => [`%${w}%`, `%${w}%`])
  return (
    db
      .prepare(
        `SELECT a.id FROM asset a LEFT JOIN place p ON p.id = a.place_id
          WHERE a.hidden = 0 AND a.deleted_at IS NULL AND ${where}
          ORDER BY COALESCE(a.captured_utc, a.created_at) DESC LIMIT ?`,
      )
      .all(...args, limit) as { id: number }[]
  ).map((r) => r.id)
}
