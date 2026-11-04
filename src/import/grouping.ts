import fs from 'node:fs'
import path from 'node:path'
import type { Db } from '../library/db.ts'
import { unpackTags } from '../metadata/reader.ts'
import { deriveMetadata, type FileMetadata, type ResolveOptions } from '../metadata/tags.ts'
import { parsePlist } from '../protocol/plist-io.ts'

/**
 * Turns committed files into assets.
 *
 * An asset is one thing the user captured; a file is one thing on disk, and
 * the mapping is often not one to one. Grouping runs after import because it
 * needs every file present before it can decide what belongs with what.
 *
 * Grouping is by content identifier, never by filename. Measured on a real
 * device, a Live Photo's still reports `Apple:ContentIdentifier` and its video
 * reports `Keys:ContentIdentifier`, both the same UUID. Stems usually agree
 * too, and stop agreeing exactly where correctness matters.
 */

export interface GroupingOptions {
  libraryRoot: string
  /**
   * Move `.AAE` adjustment recipes into the database and drop the stray file,
   * so the library on disk is media and nothing else.
   */
  absorbSidecars?: boolean
  now?: () => number
  /** Must match whatever the import used, or the two passes disagree. */
  resolve?: ResolveOptions
}

export interface GroupingResult {
  assetsCreated: number
  /** How each asset's offset was arrived at: recorded, gps or host. */
  offsetSources: Record<string, number>
  stills: number
  videos: number
  livePhotos: number
  bursts: number
  sidecarsAbsorbed: number
  /** Files carrying a content id whose partner never arrived. */
  unpaired: number
  timeSources: Record<string, number>
}

interface Row {
  id: number
  path: string
  mime: string
  device_path: string
  device_mtime: number
  raw: Uint8Array | null
}

interface Candidate extends Row {
  meta: FileMetadata
  isVideo: boolean
}

const stemOf = (devicePath: string) => {
  const base = path.posix.basename(devicePath)
  const ext = path.posix.extname(base)
  return `${path.posix.dirname(devicePath)}/${base.slice(0, base.length - ext.length)}`
}

export function buildAssets(db: Db, opts: GroupingOptions): GroupingResult {
  const absorb = opts.absorbSidecars ?? true
  const now = opts.now ?? Date.now

  const rows = db
    .prepare(
      `SELECT f.id, f.path, f.mime, i.device_path, i.device_mtime, e.raw
         FROM file f
         JOIN import_item i ON i.file_id = f.id
         LEFT JOIN exif e ON e.file_id = f.id
        WHERE f.asset_id IS NULL`,
    )
    .all() as Row[]

  const sidecars: Row[] = []
  const media: Candidate[] = []

  for (const row of rows) {
    if (path.posix.extname(row.device_path).toLowerCase() === '.aae') {
      sidecars.push(row)
      continue
    }
    // Tags were captured at import, so grouping costs no second exiftool pass.
    const tags = row.raw ? unpackTags(row.raw) : {}
    media.push({
      ...row,
      meta: deriveMetadata(tags, row.device_mtime, opts.resolve),
      isVideo: row.mime.startsWith('video/'),
    })
  }

  // A file lands in exactly one group. Burst wins over content id so a burst
  // stays one asset rather than fragmenting into per-frame Live Photos.
  const groups = new Map<string, Candidate[]>()
  for (const c of media) {
    const key = c.meta.burstId
      ? `burst:${c.meta.burstId}`
      : c.meta.contentId
        ? `content:${c.meta.contentId}`
        : `solo:${c.id}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(c)
    else groups.set(key, [c])
  }

  const result: GroupingResult = {
    assetsCreated: 0,
    stills: 0,
    videos: 0,
    livePhotos: 0,
    bursts: 0,
    sidecarsAbsorbed: 0,
    unpaired: 0,
    timeSources: {},
    offsetSources: {},
  }

  const insertAsset = db.prepare(
    `INSERT INTO asset
       (kind, content_id, burst_id, is_burst_pick, has_adjustments,
        captured_utc, captured_offset, offset_inferred, offset_source, time_source,
        lat, lon, altitude, width, height, duration_ms, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const linkFile = db.prepare(`UPDATE file SET asset_id = ?, role = ?, is_primary = ? WHERE id = ?`)

  const assetIdByStem = new Map<string, number>()

  db.transaction(() => {
    for (const [key, members] of groups) {
      const stills = members.filter((m) => !m.isVideo)
      const videos = members.filter((m) => m.isVideo)
      const isBurst = key.startsWith('burst:')
      const isLive = stills.length > 0 && videos.length > 0

      const kind = isBurst ? 'burst' : isLive ? 'live' : stills.length > 0 ? 'still' : 'video'

      // A still is the representative whenever there is one, because it is what
      // the grid shows. Sorting the combined list by time would hand a Live
      // Photo's primary to the video, whose timestamp rounds a fraction earlier.
      const byTime = (a: Candidate, b: Candidate) =>
        (a.meta.capturedUtcMs ?? 0) - (b.meta.capturedUtcMs ?? 0)
      const pool = stills.length > 0 ? stills : videos
      const primary = [...pool].sort(byTime)[0]!
      const m = primary.meta
      const motion = videos[0]

      const assetId = Number(
        insertAsset.run(
          kind,
          m.contentId,
          m.burstId,
          m.capturedUtcMs,
          m.capturedOffsetSeconds,
          m.offsetInferred ? 1 : 0,
          m.offsetSource,
          m.timeSource,
          m.lat,
          m.lon,
          m.altitude,
          m.width,
          m.height,
          isLive ? (motion?.meta.durationMs ?? null) : m.durationMs,
          now(),
          now(),
        ).lastInsertRowid,
      )

      for (const member of members) {
        // In a Live Photo the video is the motion half, not a master.
        const role = isLive && member.isVideo ? 'motion' : 'master'
        linkFile.run(assetId, role, member.id === primary.id ? 1 : 0, member.id)
        assetIdByStem.set(stemOf(member.device_path), assetId)
      }

      result.assetsCreated++
      if (kind === 'burst') result.bursts++
      else if (kind === 'live') result.livePhotos++
      else if (kind === 'video') result.videos++
      else result.stills++

      // A content id with nothing to pair against means the other half never
      // arrived, or its MakerNote was stripped before we ever saw it.
      if (m.contentId && members.length === 1) result.unpaired++

      const source = m.timeSource ?? 'none'
      result.timeSources[source] = (result.timeSources[source] ?? 0) + 1
      const offsetFrom = m.offsetSource ?? 'none'
      result.offsetSources[offsetFrom] = (result.offsetSources[offsetFrom] ?? 0) + 1
    }
  })()

  if (absorb) {
    result.sidecarsAbsorbed = absorbSidecars(db, sidecars, assetIdByStem, opts.libraryRoot)
  }

  return result
}

/**
 * Adjustment recipes move into the database and off the disk.
 *
 * Measured on a real device: 384 AAE files and zero `IMG_E` renders, with
 * `adjustmentEditorBundleID: com.apple.camera`. So these are adjustments
 * applied at capture, the render is not available over AFC, and the copy the
 * user gets is the unadjusted capture. `has_adjustments` is how the UI can say
 * so rather than letting them find out later.
 */
function absorbSidecars(
  db: Db,
  sidecars: Row[],
  assetIdByStem: Map<string, number>,
  libraryRoot: string,
): number {
  if (sidecars.length === 0) return 0

  const insertAae = db.prepare(
    `INSERT INTO aae (asset_id, plist, editor) VALUES (?, ?, ?)
     ON CONFLICT(asset_id) DO UPDATE SET plist = excluded.plist, editor = excluded.editor`,
  )
  const flagAsset = db.prepare(`UPDATE asset SET has_adjustments = 1 WHERE id = ?`)
  const detach = db.prepare(`UPDATE import_item SET file_id = NULL WHERE file_id = ?`)
  const dropFile = db.prepare(`DELETE FROM file WHERE id = ?`)

  let absorbed = 0
  const toDelete: string[] = []

  db.transaction(() => {
    for (const sidecar of sidecars) {
      // The AAE has no content id of its own, so it pairs by stem within its
      // own album directory. That is safe here precisely because the AAE is
      // never the thing being grouped.
      const assetId = assetIdByStem.get(stemOf(sidecar.device_path))
      if (assetId === undefined) continue

      const full = path.join(libraryRoot, sidecar.path)
      let bytes: Buffer
      try {
        bytes = fs.readFileSync(full)
      } catch {
        continue
      }

      let editor: string | null = null
      try {
        const parsed = parsePlist(bytes) as Record<string, unknown>
        editor = parsed?.adjustmentEditorBundleID ? String(parsed.adjustmentEditorBundleID) : null
      } catch {
        // Keep the bytes even when we cannot parse them. We do not interpret
        // adjustmentData in any case, and discarding it loses the only record
        // of what the phone is showing.
      }

      insertAae.run(assetId, bytes, editor)
      flagAsset.run(assetId)
      // The foreign key from import_item must go before the file row can.
      detach.run(sidecar.id)
      dropFile.run(sidecar.id)
      toDelete.push(full)
      absorbed++
    }
  })()

  // Only after the transaction commits, so a rollback never leaves the
  // database pointing at a file that is already gone.
  for (const file of toDelete) {
    try {
      fs.rmSync(file)
    } catch {
      /* the row is already gone; a leftover file is cosmetic */
    }
  }

  return absorbed
}
