import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { Db } from '../library/db.ts'
import { drain, PermanentJobError, type Job, type JobQueue, type RunOptions } from '../jobs/queue.ts'
import { openSource, thumbPath, type RenderDeps } from '../thumbs/render.ts'
import { THUMBNAIL } from '../thumbs/jobs.ts'
import { mergeDeepFaces } from '../people/maybe.ts'
import type { Embed } from './embedder.ts'
import type { ReadFaces } from './faces.ts'
import type { OcrResult, ReadText } from './ocr.ts'
import { DEEP_KEYS, type DeepStage } from './deep-keys.ts'
import { FACE_KEY } from './face-model.ts'
import { DIMENSIONS, MODEL_KEY } from './model.ts'
import { OCR_KEY } from './ocr-model.ts'
import { storedLines } from './text.ts'

sharp.cache(false)

/**
 * The closer look: an optional second pass over a vault, once every photo has
 * been read the ordinary way (src/search/index.ts), with the same models
 * working harder.
 *
 * Each photo is decoded once more from its original, at up to 3200 px instead
 * of the thumbnails, into a temporary JPEG that the three models read side by
 * side and that is deleted straight after:
 *
 * - faces: finer tiles, turned photos, a lower threshold, steadier
 *   descriptions (face-core.mjs). Merged into the photo's faces, so names and
 *   answers stay (src/people/maybe.ts).
 * - text: the whole photo and overlapping tiles at nearly full resolution,
 *   for small print (ocr-core.mjs). Kept when it reads at least as much.
 * - meaning: a vector for each quarter of the photo and its middle, beside the
 *   whole photo's, so something small in a corner can be found.
 *
 * Videos are left as they are: their thumbnail is all there is to look at.
 * Like the first pass: never for hidden, deleted or encrypted items, and what
 * is read of an item that becomes private meanwhile is kept nowhere.
 */

export const DEEP = 'deep'
/** The long edge of the copy the closer look reads. */
export const DEEP_EDGE = 3200

export interface DeepStages {
  faces?: ReadFaces | null
  ocr?: ReadText | null
  embed?: Embed | null
}

/** What each stage's first pass left, which the closer look needs first. */
const FIRST: Record<DeepStage, { table: string; key: string }> = {
  faces: { table: 'face_scan', key: FACE_KEY },
  ocr: { table: 'ocr_text', key: OCR_KEY },
  embed: { table: 'embedding', key: MODEL_KEY },
}

function enabled(stages: DeepStages): DeepStage[] {
  return (['faces', 'ocr', 'embed'] as const).filter((s) => !!stages[s])
}

/**
 * Visible stills with thumbnails, read by every enabled stage's first pass;
 * `pending` adds "and not yet looked at closely by some enabled stage".
 */
function eligible(stages: DeepStage[], pending: boolean, join = ''): { sql: string; args: string[] } {
  const args: string[] = []
  const firsts = stages.map((s) => {
    args.push(FIRST[s].key)
    return `EXISTS (SELECT 1 FROM ${FIRST[s].table} x WHERE x.asset_id = a.id AND x.model = ?)`
  })
  let missing = ''
  if (pending) {
    missing = ` AND (${stages.map(() => `NOT EXISTS (SELECT 1 FROM deep_scan d WHERE d.asset_id = a.id AND d.stage = ? AND d.model = ?)`).join(' OR ')})`
    for (const s of stages) args.push(s, DEEP_KEYS[s])
  }
  return {
    sql: `
  FROM asset a
  JOIN file f ON f.asset_id = a.id AND f.is_primary = 1
  JOIN job t ON t.asset_id = a.id AND t.kind = '${THUMBNAIL}' AND t.state = 'done'${join}
 WHERE a.hidden = 0 AND a.deleted_at IS NULL AND f.encrypted_path IS NULL AND a.kind <> 'video'
   AND ${firsts.join(' AND ')}${missing}`,
    args,
  }
}

/** Queue the closer look for every photo that needs it. Returns how many are waiting. */
export function queueDeep(db: Db, queue: JobQueue, stages: DeepStages): number {
  const names = enabled(stages)
  if (!names.length) return 0
  queue.recover(DEEP)
  const { sql, args } = eligible(names, true, `\n  LEFT JOIN job j ON j.asset_id = a.id AND j.kind = '${DEEP}'`)
  const rows = db.prepare(`SELECT a.id, j.state ${sql}`).all(...args) as {
    id: number
    state: string | null
  }[]
  db.transaction(() => {
    for (const r of rows) {
      // A failed look would only fail again; a done one missing a stage (switched on since) goes again.
      if (r.state === 'queued' || r.state === 'running' || r.state === 'failed') continue
      queue.enqueue(DEEP, r.id)
    }
  })()
  return queue.counts(DEEP).queued
}

/** Photos looked at closely by every enabled stage (or given up on), of those that can be. */
export function deepProgress(db: Db, stages: DeepStages): { done: number; total: number } {
  const names = enabled(stages)
  if (!names.length) return { done: 0, total: 0 }
  const all = eligible(names, false)
  const total = (db.prepare(`SELECT COUNT(*) AS n ${all.sql}`).get(...all.args) as { n: number }).n
  const pending = eligible(names, true)
  const left = (
    db
      .prepare(`SELECT COUNT(*) AS n ${pending.sql} AND NOT EXISTS (SELECT 1 FROM job g WHERE g.asset_id = a.id AND g.kind = '${DEEP}' AND g.state = 'failed')`)
      .get(...pending.args) as { n: number }
  ).n
  return { done: total - left, total }
}

type Primary = { path: string; mime: string; sha256: string; encrypted_path: string | null; hidden: number; deleted_at: number | null }
const isPrivate = (r: Primary | undefined) => !r || !!r.encrypted_path || r.hidden === 1 || r.deleted_at !== null

/**
 * The original, the right way up, at up to DEEP_EDGE, as a JPEG at `out`.
 * When the original can't be decoded here (a raw format, say), the large
 * thumbnail: the extra passes still find more in it.
 */
export async function writeDeepImage(original: string, mime: string, lgThumb: string, deps: RenderDeps, out: string): Promise<void> {
  try {
    const img = await openSource(original, mime, deps)
    await img.resize(DEEP_EDGE, DEEP_EDGE, { fit: 'inside', withoutEnlargement: true }).removeAlpha().jpeg({ quality: 92 }).toFile(out)
    return
  } catch {
    /* the thumbnail instead */
  }
  if (!fs.existsSync(lgThumb)) throw new PermanentJobError('no original or thumbnail to look at')
  await sharp(lgThumb).removeAlpha().jpeg({ quality: 92 }).toFile(out)
}

/**
 * The parts of a w x h picture that get vectors of their own: the four
 * quarters, overlapping a little in the middle, then the middle itself.
 * [left, top, width, height].
 */
export function partsOf(w: number, h: number): [number, number, number, number][] {
  const qw = Math.round(w * 0.55), qh = Math.round(h * 0.55)
  const cw = Math.round(w * 0.6), ch = Math.round(h * 0.6)
  return [
    [0, 0, qw, qh],
    [w - qw, 0, qw, qh],
    [0, h - qh, qw, qh],
    [w - qw, h - qh, qw, qh],
    [Math.round((w - cw) / 2), Math.round((h - ch) / 2), cw, ch],
  ]
}

async function embedParts(embed: Embed, image: string, dir: string, id: number): Promise<Float32Array[]> {
  const meta = await sharp(image).metadata()
  const vecs: Float32Array[] = []
  for (const [i, [left, top, width, height]] of partsOf(meta.width ?? 0, meta.height ?? 0).entries()) {
    if (width < 32 || height < 32) continue
    const part = path.join(dir, `${id}-part${i}.jpg`)
    try {
      await sharp(image).extract({ left, top, width, height }).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toFile(part)
      const vec = await embed.image(part)
      if (vec.length !== DIMENSIONS) throw new PermanentJobError(`vector has ${vec.length} dimensions, expected ${DIMENSIONS}`)
      vecs.push(vec)
    } finally {
      fs.rmSync(part, { force: true })
    }
  }
  return vecs
}

export interface DeepDeps extends RenderDeps {
  stages: DeepStages
}

export function deepHandler(db: Db, media: string, cache: string, deps: DeepDeps) {
  const primary = db.prepare(
    `SELECT f.path, f.mime, f.sha256, f.encrypted_path, a.hidden, a.deleted_at FROM file f JOIN asset a ON a.id = f.asset_id
      WHERE f.asset_id = ? AND f.is_primary = 1`,
  )
  const looked = db.prepare(`SELECT stage, model FROM deep_scan WHERE asset_id = ?`)
  const mark = db.prepare(`INSERT OR REPLACE INTO deep_scan (asset_id, stage, model) VALUES (?, ?, ?)`)
  const oldText = db.prepare(`SELECT text FROM ocr_text WHERE asset_id = ? AND model = ?`)
  const putText = db.prepare(`INSERT OR REPLACE INTO ocr_text (asset_id, model, text, lines) VALUES (?, ?, ?, ?)`)
  const dropParts = db.prepare(`DELETE FROM embedding_part WHERE asset_id = ? AND model = ?`)
  const putPart = db.prepare(`INSERT INTO embedding_part (asset_id, model, part, vec) VALUES (?, ?, ?, ?)`)
  const tmp = path.join(cache, 'deep-tmp')

  return async (job: Job) => {
    const row = primary.get(job.assetId) as Primary | undefined
    if (!row) throw new PermanentJobError(`asset ${job.assetId} has no primary file`)
    if (isPrivate(row)) return
    const done = new Map((looked.all(job.assetId) as { stage: string; model: string }[]).map((r) => [r.stage, r.model]))
    const todo = enabled(deps.stages).filter((s) => done.get(s) !== DEEP_KEYS[s])
    if (!todo.length) return

    fs.mkdirSync(tmp, { recursive: true })
    const image = path.join(tmp, `${job.assetId}.jpg`)
    try {
      await writeDeepImage(path.join(media, ...row.path.split('/')), row.mime, thumbPath(cache, row.sha256, 'lg'), deps, image)
      const { faces, ocr, embed } = deps.stages
      // The three models are in three workers: they read the copy at the same time.
      const stores = await Promise.all(
        todo.map(async (stage): Promise<() => void> => {
          if (stage === 'faces') {
            const r = await faces!.read(image, { deep: true })
            return () => void mergeDeepFaces(db, job.assetId, r)
          }
          if (stage === 'ocr') {
            const r: OcrResult = await ocr!.read(image, { deep: true })
            return () => {
              const text = r.lines.map((l) => l.text).join('\n')
              const before = (oldText.get(job.assetId, OCR_KEY) as { text: string } | undefined)?.text ?? ''
              // Keep whichever read more: the closer look rarely reads less, but a busy photo can.
              if (text.length >= before.length) putText.run(job.assetId, OCR_KEY, text, r.lines.length ? storedLines(r) : null)
              mark.run(job.assetId, 'ocr', DEEP_KEYS.ocr)
            }
          }
          const vecs = await embedParts(embed!, image, tmp, job.assetId)
          return () => {
            dropParts.run(job.assetId, MODEL_KEY)
            vecs.forEach((v, i) => putPart.run(job.assetId, MODEL_KEY, i, Buffer.from(v.buffer, v.byteOffset, v.byteLength)))
            mark.run(job.assetId, 'embed', DEEP_KEYS.embed)
          }
        }),
      )
      // Hidden or deleted while the models were busy: keep nothing.
      if (isPrivate(primary.get(job.assetId) as Primary | undefined)) return
      db.transaction(() => {
        for (const store of stores) store()
      })()
    } finally {
      fs.rmSync(image, { force: true })
    }
  }
}

/** Look closely at every queued photo of a vault, one at a time (each keeps three workers busy). */
export function runDeep(db: Db, queue: JobQueue, media: string, cache: string, deps: DeepDeps, opts: Omit<RunOptions, 'concurrency'>): Promise<void> {
  queue.recover(DEEP)
  // Copies left by a run that was stopped by force.
  fs.rmSync(path.join(cache, 'deep-tmp'), { recursive: true, force: true })
  return drain(queue, DEEP, deepHandler(db, media, cache, deps), { ...opts, concurrency: 1 })
}
