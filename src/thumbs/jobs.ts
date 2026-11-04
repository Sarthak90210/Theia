import path from 'node:path'
import fs from 'node:fs'
import type { Db } from '../library/db.ts'
import { drain, PermanentJobError, type Job, type JobQueue, type RunOptions } from '../jobs/queue.ts'
import { hasThumbs, renderThumbnails, thumbPath, SIZES, type ThumbSize, type RenderDeps } from './render.ts'

export const THUMBNAIL = 'thumbnail'

interface PrimaryFile {
  path: string
  mime: string
  sha256: string
  width: number | null
}

/**
 * Make sure every asset has a thumbnail job, and that every job marked done
 * still has its files. The second half is what makes the cache disposable:
 * delete the folder, run this, and the queue refills itself.
 */
export function queueThumbnails(db: Db, queue: JobQueue, cacheRoot: string): { added: number; requeued: number } {
  const added = queue.enqueueAll(THUMBNAIL)
  const done = db
    .prepare(
      `SELECT j.asset_id, f.sha256
         FROM job j JOIN file f ON f.asset_id = j.asset_id AND f.is_primary = 1 JOIN asset a ON a.id = j.asset_id
        WHERE j.kind = ? AND j.state = 'done' AND f.encrypted_path IS NULL AND a.hidden = 0 AND a.deleted_at IS NULL`,
    )
    .all(THUMBNAIL) as { asset_id: number; sha256: string }[]

  let requeued = 0
  for (const row of done) {
    if (!hasThumbs(cacheRoot, row.sha256)) {
      queue.enqueue(THUMBNAIL, row.asset_id)
      requeued++
    }
  }
  return { added, requeued }
}

export function thumbnailHandler(db: Db, mediaRoot: string, cacheRoot: string, deps: RenderDeps) {
  const primary = db.prepare(
    `SELECT f.path, f.mime, f.sha256, a.width, f.encrypted_path, a.hidden, a.deleted_at
       FROM file f JOIN asset a ON a.id = f.asset_id
      WHERE f.asset_id = ? AND f.is_primary = 1`,
  )
  const setSize = db.prepare(`UPDATE asset SET width = ?, height = ?, updated_at = ? WHERE id = ?`)
  // libheif decodes the whole primary image to make a thumbnail, which is
  // exactly the level 3 check. Record it, so verification does not pay
  // another half second per photo to learn the same thing.
  const decodedHeic = db.prepare(
    `UPDATE file SET verify_level = 3, verified_at = ?, decode_error = NULL
      WHERE asset_id = ? AND is_primary = 1 AND verify_level < 3`,
  )

  return async (job: Job) => {
    const file = primary.get(job.assetId) as PrimaryFile | undefined
    if (!file) throw new PermanentJobError(`asset ${job.assetId} has no primary file`)
    // Hidden or deleted, so encrypted: a thumbnail on disk would show it.
    const privacy = file as PrimaryFile & { encrypted_path?: string | null; hidden: number; deleted_at: number | null }
    if (privacy.encrypted_path || privacy.hidden || privacy.deleted_at !== null) return
    // Content-addressed: identical bytes already rendered for another asset.
    if (hasThumbs(cacheRoot, file.sha256) && file.width !== null) return

    const abs = path.join(mediaRoot, ...file.path.split('/'))
    const size = await renderThumbnails(abs, file.mime, file.sha256, cacheRoot, deps)
    const now = primary.get(job.assetId) as typeof privacy | undefined
    if (!now || now.encrypted_path || now.hidden || now.deleted_at !== null) {
      const visible = db.prepare(`SELECT 1 FROM file f JOIN asset a ON a.id=f.asset_id WHERE f.sha256=? AND a.hidden=0 AND a.deleted_at IS NULL AND f.encrypted_path IS NULL LIMIT 1`).get(file.sha256)
      if (!visible) for (const s of Object.keys(SIZES) as ThumbSize[]) fs.rmSync(thumbPath(cacheRoot,file.sha256,s),{force:true})
      return
    }
    // Dimensions fall out of the decode for free, and the grid needs them to
    // lay out cells before any thumbnail has loaded.
    if (file.width === null && size.width > 0) setSize.run(size.width, size.height, Date.now(), job.assetId)
    if (file.mime === 'image/heic' || file.mime === 'image/heif') decodedHeic.run(Date.now(), job.assetId)
  }
}

export function runThumbnails(
  db: Db,
  queue: JobQueue,
  mediaRoot: string,
  cacheRoot: string,
  deps: RenderDeps,
  opts: RunOptions,
): Promise<void> {
  queue.recover(THUMBNAIL)
  return drain(queue, THUMBNAIL, thumbnailHandler(db, mediaRoot, cacheRoot, deps), opts)
}
