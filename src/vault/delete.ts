import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Db } from '../library/db.ts'

/**
 * Deleting from a vault works the way it does on the phone. Delete moves an
 * item to Recently Deleted, where it can be put back. Deleting it from there
 * sends its files to the Windows Recycle Bin, so even that can be undone
 * outside the app. Nothing here unlinks a file directly.
 *
 * Phones are never written to.
 */

/** Hide items from every collection except Recently Deleted. */
export function trashAssets(db: Db, ids: number[], now = Date.now()): number {
  const run = db.prepare(`UPDATE asset SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
  let n = 0
  db.transaction(() => {
    for (const id of ids) n += run.run(now, now, id).changes
  })()
  return n
}

export function restoreAssets(db: Db, ids: number[], now = Date.now()): number {
  const run = db.prepare(`UPDATE asset SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL`)
  let n = 0
  db.transaction(() => {
    for (const id of ids) n += run.run(now, id).changes
  })()
  return n
}

export interface PurgeResult {
  removed: number
  /** Files the Recycle Bin refused, with why. The item stays when any of its files fail. */
  failed: { path: string; reason: string }[]
}

/**
 * Send items already in Recently Deleted to the Recycle Bin, every copy of
 * every file, then forget them.
 *
 * Album folders hold hard links that the database does not list. A link is
 * found by album folder and file name, and only taken when it is the same
 * file (same inode, or the same bytes where the drive has no hard links),
 * because saving skips a name that is already taken by a different photo.
 */
export async function purgeAssets(
  db: Db,
  mediaRoot: string,
  ids: number[],
  trash: (file: string) => Promise<void>,
  /** Where protected (encrypted) files live, for items that are. */
  privateFolder?: string,
): Promise<PurgeResult> {
  const result: PurgeResult = { removed: 0, failed: [] }
  for (const id of ids) {
    const deleted = db.prepare(`SELECT 1 FROM asset WHERE id = ? AND deleted_at IS NOT NULL`).get(id)
    if (!deleted) continue
    const files = db.prepare(`SELECT id, path, sha256, encrypted_path FROM file WHERE asset_id = ?`).all(id) as {
      id: number
      path: string
      sha256: string
      encrypted_path: string | null
    }[]
    const folders = (
      db
        .prepare(`SELECT al.folder FROM album_asset x JOIN album al ON al.id = x.album_id WHERE x.asset_id = ? AND al.folder IS NOT NULL`)
        .all(id) as { folder: string }[]
    ).map((r) => path.join(mediaRoot, ...r.folder.split('/')))

    const targets: string[] = []
    for (const f of files) {
      // A protected file has only its encrypted copy left.
      if (f.encrypted_path) {
        if (!privateFolder) throw new Error('This item is encrypted; its private folder is needed to delete it.')
        const blob = path.join(privateFolder, f.encrypted_path)
        if (fs.existsSync(blob)) targets.push(blob)
        continue
      }
      const main = path.join(mediaRoot, ...f.path.split('/'))
      if (fs.existsSync(main)) targets.push(main)
      for (const folder of folders) {
        const copy = path.join(folder, path.basename(main))
        if (copy !== main && fs.existsSync(copy) && sameFile(main, copy, f.sha256)) targets.push(copy)
      }
    }

    let ok = true
    for (const t of new Set(targets)) {
      try {
        await trash(t)
      } catch (e) {
        ok = false
        result.failed.push({ path: t, reason: (e as Error).message })
      }
    }
    if (!ok) continue
    db.transaction(() => {
      // The import engine's rows point at files; they stay, without the link.
      if (hasTable(db, 'import_item')) {
        db.prepare(`UPDATE import_item SET file_id = NULL WHERE file_id IN (SELECT id FROM file WHERE asset_id = ?)`).run(id)
      }
      db.prepare(`DELETE FROM file WHERE asset_id = ?`).run(id)
      db.prepare(`DELETE FROM album_asset WHERE asset_id = ?`).run(id)
      db.prepare(`DELETE FROM asset WHERE id = ?`).run(id)
    })()
    result.removed++
  }
  return result
}

function sameFile(a: string, b: string, sha256: string): boolean {
  try {
    const sa = fs.statSync(a, { bigint: true })
    const sb = fs.statSync(b, { bigint: true })
    if (sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev) return true
    if (sa.size !== sb.size) return false
  } catch {
    // A previous attempt may have recycled the primary before an album link
    // failed. The recorded checksum still identifies that remaining copy.
    if (!fs.existsSync(b)) return false
  }
  // No hard links on this drive (FAT, exFAT): saving made a copy. Same bytes?
  return createHash('sha256').update(fs.readFileSync(b)).digest('hex') === sha256
}

function hasTable(db: Db, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)
}
