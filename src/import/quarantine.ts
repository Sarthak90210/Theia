import fs from 'node:fs'
import path from 'node:path'
import type { Db } from '../library/db.ts'
import { destinationFor, quarantineName, wallClock } from './engine.ts'
import { moveItem } from './stages.ts'
import { packTags, type MetadataReader } from '../metadata/reader.ts'

/**
 * What the user can do about files that failed verification.
 *
 * Quarantine exists so nothing fails silently, but a list you cannot act on is
 * only half the feature. Fixing a cable should recover the whole batch in one
 * action, and a partially readable photo should be keepable, because most of an
 * image beats none of it.
 */

export interface QuarantineEntry {
  itemId: number
  devicePath: string
  fileName: string
  /** Absolute path of the quarantined bytes, if they are still there. */
  quarantinePath: string | null
  expectedBytes: number
  receivedBytes: number
  failLevel: number
  failDetail: string
  /** transient, permanent or fatal. Null for verification failures. */
  failClass: string | null
  attempts: number
}

function quarantineDir(libraryRoot: string): string {
  return path.join(libraryRoot, '.quarantine')
}

/**
 * Where an item's quarantined bytes are, if anywhere. Files quarantined before
 * names carried the device path sit under their basename, so look there too.
 */
function quarantinedBytes(libraryRoot: string, devicePath: string): string | null {
  const dir = quarantineDir(libraryRoot)
  for (const name of [quarantineName(devicePath), path.posix.basename(devicePath)]) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

export function listQuarantine(db: Db, libraryRoot: string): QuarantineEntry[] {
  const rows = db
    .prepare(
      `SELECT id, device_path, device_size, bytes_received, fail_level, fail_detail, fail_class, attempts
         FROM import_item
        WHERE stage = 'quarantined'
        ORDER BY id`,
    )
    .all() as {
    id: number
    device_path: string
    device_size: number
    bytes_received: number
    fail_level: number | null
    fail_detail: string | null
    fail_class: string | null
    attempts: number
  }[]

  return rows.map((r) => {
    const fileName = path.posix.basename(r.device_path)
    const onDisk = quarantinedBytes(libraryRoot, r.device_path)
    const exists = onDisk !== null
    return {
      itemId: r.id,
      devicePath: r.device_path,
      fileName,
      quarantinePath: exists ? onDisk : null,
      expectedBytes: r.device_size,
      receivedBytes: exists ? fs.statSync(onDisk).size : r.bytes_received,
      failClass: r.fail_class,
      failLevel: r.fail_level ?? 0,
      failDetail: r.fail_detail ?? 'unknown failure',
      attempts: r.attempts,
    }
  })
}

/**
 * Put failed files back in the queue.
 *
 * Starts them from zero rather than resuming: whatever is in quarantine failed
 * verification, so splicing new bytes onto it would build on a bad foundation.
 */
export function requeueQuarantined(db: Db, libraryRoot: string, itemIds?: number[]): number {
  const entries = listQuarantine(db, libraryRoot).filter(
    (e) => !itemIds || itemIds.includes(e.itemId),
  )
  if (entries.length === 0) return 0

  const at = Date.now()
  db.transaction(() => {
    for (const e of entries) {
      moveItem(
        db,
        e.itemId,
        'planned',
        {
          bytes_received: 0,
          attempts: 0,
          fail_level: null,
          fail_detail: null,
          fail_class: null,
          staging_path: null,
          sha256: null,
        },
        at,
      )
    }
  })()

  for (const e of entries) {
    if (e.quarantinePath) {
      safeRemove(e.quarantinePath)
      safeRemove(`${e.quarantinePath}.json`)
    }
    safeRemove(path.join(quarantineDir(libraryRoot), `${quarantineName(e.devicePath)}.json`))
  }

  return entries.length
}

export interface AcceptOptions {
  libraryRoot: string
  itemId: number
  /** Used for the capture date. A damaged file often still has readable tags. */
  metadata?: MetadataReader
  now?: () => number
}

/**
 * Keep a file that failed verification, marked as what it is.
 *
 * It enters the library like any other file, except `accepted_unverified` is
 * set, so nothing downstream can mistake it for one that passed.
 */
export async function acceptQuarantined(db: Db, opts: AcceptOptions): Promise<number | null> {
  const entry = listQuarantine(db, opts.libraryRoot).find((e) => e.itemId === opts.itemId)
  if (!entry?.quarantinePath) return null

  const now = opts.now ?? Date.now
  const item = db
    .prepare(`SELECT device_mtime, sha256 FROM import_item WHERE id = ?`)
    .get(opts.itemId) as { device_mtime: number; sha256: string | null }

  let extracted: Awaited<ReturnType<MetadataReader['read']>> | null = null
  if (opts.metadata) {
    try {
      extracted = await opts.metadata.read(entry.quarantinePath, item.device_mtime)
    } catch {
      extracted = null
    }
  }

  const capturedUtc = extracted?.meta.capturedUtcMs ?? item.device_mtime
  const offset = extracted?.meta.capturedOffsetSeconds ?? null
  let dest = destinationFor(opts.libraryRoot, wallClock(capturedUtc, offset), entry.fileName)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  while (fs.existsSync(dest)) {
    const ext = path.extname(dest)
    dest = `${dest.slice(0, -ext.length)}_1${ext}`
  }

  fs.renameSync(entry.quarantinePath, dest)
  const bytes = fs.statSync(dest).size
  fs.utimesSync(dest, new Date(capturedUtc), new Date(capturedUtc))
  safeRemove(`${entry.quarantinePath}.json`)

  const rel = path.relative(opts.libraryRoot, dest).split(path.sep).join('/')
  const digest = item.sha256 ?? ''

  let fileId = 0
  db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO file
           (asset_id, role, is_primary, path, bytes, sha256, mime, verified_at, verify_level,
            accepted_unverified, created_at)
         VALUES (NULL, 'master', 1, ?, ?, ?, ?, NULL, ?, 1, ?)`,
      )
      .run(rel, bytes, digest, mimeOf(entry.fileName), Math.max(0, entry.failLevel - 1), now())
    fileId = Number(res.lastInsertRowid)

    if (extracted) {
      const m = extracted.meta
      db.prepare(
        `INSERT INTO exif (file_id, raw, make, model, lens, iso, f_number, exposure, focal_mm)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(fileId, packTags(extracted.raw), m.make, m.model, m.lens, m.iso, m.fNumber, m.exposure, m.focalMm)
    }

    moveItem(db, opts.itemId, 'committed', { file_id: fileId }, now())
  })()

  return fileId
}

const MIME_BY_EXT: Record<string, string> = {
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.dng': 'image/x-adobe-dng',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.aae': 'application/xml',
}

function mimeOf(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
}

function safeRemove(file: string) {
  try {
    fs.rmSync(file)
  } catch {
    /* already gone */
  }
}
