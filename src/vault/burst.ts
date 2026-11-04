import type { Db } from '../library/db.ts'

/**
 * Bursts in a vault, handled the way the iPhone does: one item with every
 * frame inside, shown by its cover frame. You can pick a different cover, or
 * keep a frame as a photo of its own.
 *
 * A burst is one asset (kind 'burst') whose frames are its 'master' files;
 * the cover is the primary file. Nothing here copies or moves bytes on disk:
 * a frame kept as a photo is the same file, now belonging to a new item.
 */

function frame(db: Db, assetId: number, fileId: number) {
  const f = db
    .prepare(`SELECT id, is_primary FROM file WHERE id = ? AND asset_id = ? AND role = 'master'`)
    .get(fileId, assetId) as { id: number; is_primary: number } | undefined
  if (!f) throw new Error('That frame is not part of this burst.')
  const burst = db.prepare(`SELECT kind FROM asset WHERE id = ?`).get(assetId) as { kind: string } | undefined
  if (burst?.kind !== 'burst') throw new Error('That item is not a burst.')
  return f
}

/** Make one frame the burst's cover: the one the grid and viewer show. */
export function setBurstCover(db: Db, assetId: number, fileId: number, now = Date.now()): void {
  frame(db, assetId, fileId)
  db.transaction(() => {
    db.prepare(`UPDATE file SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE asset_id = ? AND role = 'master'`).run(fileId, assetId)
    db.prepare(`UPDATE asset SET updated_at = ? WHERE id = ?`).run(now, assetId)
  })()
}

/**
 * Keep one frame as a photo of its own. The new photo takes the burst's
 * time, place and albums. A burst left with one frame becomes a photo too.
 * Returns the new photo's id.
 */
export function keepBurstFrame(db: Db, assetId: number, fileId: number, now = Date.now()): number {
  const f = frame(db, assetId, fileId)
  let id = 0
  db.transaction(() => {
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM file WHERE asset_id = ? AND role = 'master'`).get(assetId) as { n: number }).n
    if (total < 2) throw new Error('A burst needs at least two frames.')
    id = Number(
      db
        .prepare(
          `INSERT INTO asset (kind, content_id, burst_id, is_burst_pick, has_adjustments, captured_utc, captured_offset,
             offset_inferred, time_source, lat, lon, altitude, place_id, width, height, duration_ms, favourite, hidden,
             deleted_at, created_at, updated_at)
           SELECT 'still', NULL, NULL, 0, 0, captured_utc, captured_offset, offset_inferred, time_source, lat, lon, altitude,
             place_id, width, height, NULL, 0, hidden, NULL, ?, ?
           FROM asset WHERE id = ?`,
        )
        .run(now, now, assetId).lastInsertRowid,
    )
    db.prepare(`UPDATE file SET asset_id = ?, is_primary = 1 WHERE id = ?`).run(id, fileId)
    db.prepare(`INSERT OR IGNORE INTO album_asset (album_id, asset_id, position) SELECT album_id, ?, position FROM album_asset WHERE asset_id = ?`).run(id, assetId)
    // The burst keeps a cover, and stops being a burst at one frame.
    if (f.is_primary) {
      db.prepare(
        `UPDATE file SET is_primary = 1 WHERE id = (SELECT id FROM file WHERE asset_id = ? AND role = 'master' ORDER BY path LIMIT 1)`,
      ).run(assetId)
    }
    if (total - 1 < 2) db.prepare(`UPDATE asset SET kind = 'still', burst_id = NULL WHERE id = ?`).run(assetId)
    db.prepare(`UPDATE asset SET updated_at = ? WHERE id = ?`).run(now, assetId)
  })()
  return id
}

/** How many frames each burst has, for the badge on its tile. */
export function burstFrameCounts(db: Db, assetIds: number[]): Map<number, number> {
  const out = new Map<number, number>()
  if (!assetIds.length) return out
  const rows = db
    .prepare(
      `SELECT asset_id AS id, COUNT(*) AS n FROM file WHERE role = 'master' AND asset_id IN (${assetIds.map(() => '?').join(',')}) GROUP BY asset_id`,
    )
    .all(...assetIds) as { id: number; n: number }[]
  for (const r of rows) out.set(r.id, r.n)
  return out
}
