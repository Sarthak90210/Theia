import path from 'node:path'
import type { Db } from '../library/db.ts'
import { drain, type Job, type JobQueue, type RunOptions } from '../jobs/queue.ts'
import { checkDecode, type DecodeDeps } from './decode.ts'

export const VERIFY_DECODE = 'verify-decode'

/**
 * One job per asset, checking every file behind it: the still and the motion
 * video of a Live Photo, the original and the rendered edit. A damaged file is
 * a finished check with a bad result, recorded on the file. The job itself only
 * fails when the check could not run, such as ffmpeg missing.
 */
export function verifyHandler(db: Db, mediaRoot: string, deps: DecodeDeps, now: () => number = Date.now) {
  const files = db.prepare(
    `SELECT id, path, mime, verify_level FROM file WHERE asset_id = ? AND encrypted_path IS NULL ORDER BY is_primary DESC, id`,
  )
  const pass = db.prepare(
    `UPDATE file SET verify_level = 3, verified_at = ?, decode_error = NULL WHERE id = ?`,
  )
  const damaged = db.prepare(`UPDATE file SET decode_error = ? WHERE id = ?`)

  return async (job: Job) => {
    const rows = files.all(job.assetId) as { id: number; path: string; mime: string; verify_level: number }[]
    for (const f of rows) {
      // Already decoded in full elsewhere, for example by the thumbnail job.
      if (f.verify_level >= 3) continue
      const abs = path.join(mediaRoot, ...f.path.split('/'))
      const result = await checkDecode(abs, f.mime, deps)
      if (result.status === 'ok') pass.run(now(), f.id)
      else if (result.status === 'damaged') damaged.run(result.detail, f.id)
    }
  }
}

export function runVerify(db: Db, queue: JobQueue, mediaRoot: string, deps: DecodeDeps, opts: RunOptions) {
  queue.recover(VERIFY_DECODE)
  return drain(queue, VERIFY_DECODE, verifyHandler(db, mediaRoot, deps), opts)
}

export interface VerifySummary {
  files: number
  decoded: number
  damaged: { path: string; mime: string; error: string }[]
  unchecked: { mime: string; n: number }[]
}

export function verifySummary(db: Db): VerifySummary {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM file WHERE asset_id IS NOT NULL`).get() as { n: number }
  const decoded = db
    .prepare(`SELECT COUNT(*) AS n FROM file WHERE asset_id IS NOT NULL AND verify_level >= 3`)
    .get() as { n: number }
  const damaged = (
    db
      .prepare(`SELECT path, mime, decode_error FROM file WHERE decode_error IS NOT NULL ORDER BY path`)
      .all() as { path: string; mime: string; decode_error: string }[]
  ).map((r) => ({ path: r.path, mime: r.mime, error: r.decode_error }))
  const unchecked = db
    .prepare(
      `SELECT mime, COUNT(*) AS n FROM file
        WHERE asset_id IS NOT NULL AND verify_level < 3 AND decode_error IS NULL
        GROUP BY mime ORDER BY n DESC`,
    )
    .all() as { mime: string; n: number }[]
  return { files: total.n, decoded: decoded.n, damaged, unchecked }
}
