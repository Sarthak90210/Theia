import path from 'node:path'
import type { Db } from '../library/db.ts'
import { unpackTags } from '../metadata/reader.ts'
import { burstFrameCounts } from '../vault/burst.ts'
import { pick, type RawTags } from '../metadata/tags.ts'
import type { CollectionInfo, Collections, GalleryItem, ItemDetail, ItemFile, ItemKind } from './types.ts'

/**
 * Gallery queries over a vault's database. Read only.
 *
 * Library order is capture time, oldest first, the way the phone's Library
 * scrolls. An album keeps the order it had on the phone.
 */

const RECENT_MS = 30 * 24 * 3600 * 1000

/** `live: false` means the collection is not limited to live (undeleted) items. */
const SMART: { id: string; name: string; where: string; always?: boolean; live?: false; utility?: true }[] = [
  { id: 'library', name: 'Library', where: '1 = 1', always: true },
  { id: 'favourites', name: 'Favourites', where: 'a.favourite = 1' },
  { id: 'videos', name: 'Videos', where: "a.kind = 'video'" },
  { id: 'live', name: 'Live Photos', where: "a.kind = 'live'" },
  { id: 'screenshots', name: 'Screenshots', where: "a.subtype = 'screenshot'" },
  { id: 'selfies', name: 'Selfies', where: "a.subtype = 'selfie'" },
  { id: 'panoramas', name: 'Panoramas', where: "a.subtype = 'panorama'" },
  { id: 'bursts', name: 'Bursts', where: "a.kind = 'burst'" },
  { id: 'edited', name: 'Edited', where: 'a.has_adjustments = 1' },
  { id: 'recent', name: 'Recently Saved', where: `a.created_at > (CAST(strftime('%s','now') AS INTEGER) * 1000 - ${RECENT_MS})` },
  { id: 'hidden', name: 'Hidden', where: 'a.hidden = 1 AND a.deleted_at IS NULL', live: false, utility: true },
  { id: 'deleted', name: 'Recently Deleted', where: 'a.deleted_at IS NOT NULL', live: false, utility: true },
]

const LIVE = 'a.deleted_at IS NULL AND a.hidden = 0'

function where(s: (typeof SMART)[number]): string {
  return s.live === false ? s.where : `${s.where} AND ${LIVE}`
}

export function vaultCollections(db: Db): Collections {
  const smart: CollectionInfo[] = []
  for (const s of SMART) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n, (SELECT a2.id FROM asset a2 WHERE ${where(s).replaceAll('a.', 'a2.')}
                                ORDER BY a2.captured_utc DESC LIMIT 1) AS cover
           FROM asset a WHERE ${where(s)}`,
      )
      .get() as { n: number; cover: number | null }
    if (row.n > 0 || s.always || s.utility) {
      smart.push({ id: s.id, name: s.name, kind: s.utility ? 'utility' : 'smart', count: row.n, cover: row.cover === null ? null : String(row.cover) })
    }
  }

  const albums = (
    db
      .prepare(
        `SELECT al.id, al.name,
                (SELECT COUNT(*) FROM album_asset x JOIN asset a ON a.id = x.asset_id WHERE x.album_id = al.id AND ${LIVE}) AS n,
                (SELECT x.asset_id FROM album_asset x WHERE x.album_id = al.id ORDER BY x.position DESC LIMIT 1) AS cover
           FROM album al ORDER BY al.position, al.id`,
      )
      .all() as { id: number; name: string; n: number; cover: number | null }[]
  ).map(
    (a): CollectionInfo => ({
      id: `album:${a.id}`,
      name: a.name,
      kind: 'album',
      count: a.n,
      cover: a.cover === null ? null : String(a.cover),
    }),
  )

  return { smart, albums }
}

interface ItemRow {
  id: number
  kind: string
  captured_utc: number | null
  captured_offset: number | null
  width: number | null
  height: number | null
  duration_ms: number | null
  favourite: number
  has_adjustments: number
  subtype: string | null
  created_at: number
  deleted_at: number | null
  updated_at: number
}

const ITEM_COLUMNS = `a.id, a.kind, a.captured_utc, a.captured_offset, a.width, a.height, a.duration_ms,
                      a.favourite, a.has_adjustments, a.subtype, a.created_at, a.deleted_at, a.updated_at`

export function vaultItems(db: Db, collectionId: string): GalleryItem[] {
  let rows: ItemRow[]
  const album = /^album:(\d+)$/.exec(collectionId)
  if (album) {
    rows = db
      .prepare(
        `SELECT ${ITEM_COLUMNS} FROM album_asset x JOIN asset a ON a.id = x.asset_id
          WHERE x.album_id = ? AND ${LIVE} ORDER BY x.position, a.captured_utc, a.id`,
      )
      .all(Number(album[1])) as ItemRow[]
  } else {
    const smart = SMART.find((s) => s.id === collectionId)
    if (!smart) return []
    rows = db
      .prepare(
        `SELECT ${ITEM_COLUMNS} FROM asset a WHERE ${where(smart)}
          ORDER BY COALESCE(a.captured_utc, a.created_at), a.id`,
      )
      .all() as ItemRow[]
  }
  const items = rows.map(toItem)
  const bursts = items.filter((i) => i.kind === 'burst').map((i) => Number(i.key))
  const counts = burstFrameCounts(db, bursts)
  for (const i of items) if (i.kind === 'burst') i.frames = counts.get(Number(i.key))
  return items
}

function toItem(r: ItemRow): GalleryItem {
  return {
    key: String(r.id),
    kind: kindOf(r.kind),
    t: r.captured_utc ?? r.created_at,
    off: r.captured_offset,
    w: r.width,
    h: r.height,
    dur: r.duration_ms,
    fav: r.favourite === 1,
    edited: r.has_adjustments === 1,
    cloud: false,
    subtype: r.subtype,
    deletedAt: r.deleted_at,
    revision: r.updated_at,
  }
}

function kindOf(k: string): ItemKind {
  if (k === 'video' || k === 'live' || k === 'burst') return k
  return 'photo'
}

export function vaultDetail(db: Db, mediaRoot: string, key: string): ItemDetail | null {
  const a = db
    .prepare(
      `SELECT a.*, p.label AS place FROM asset a LEFT JOIN place p ON p.id = a.place_id WHERE a.id = ?`,
    )
    .get(Number(key)) as
    | (ItemRow & {
        time_source: string | null
        lat: number | null
        lon: number | null
        altitude: number | null
        place: string | null
      })
    | undefined
  if (!a) return null

  const files = db
    .prepare(
      `SELECT f.id, f.path, f.role, f.is_primary, f.bytes, f.mime, f.verify_level, f.decode_error,
              e.make, e.model, e.lens, e.iso, e.f_number, e.exposure, e.focal_mm, e.raw
         FROM file f LEFT JOIN exif e ON e.file_id = f.id
        WHERE f.asset_id = ? ORDER BY f.is_primary DESC, f.id`,
    )
    .all(Number(key)) as {
    id: number
    path: string
    role: string
    is_primary: number
    bytes: number
    mime: string
    verify_level: number
    decode_error: string | null
    make: string | null
    model: string | null
    lens: string | null
    iso: number | null
    f_number: number | null
    exposure: number | null
    focal_mm: number | null
    raw: Buffer | null
  }[]

  const primary = files[0]
  // The values the stored columns don't have, from the full tag set.
  const tags = primary?.raw ? safeUnpack(primary.raw) : null
  const tagNum = (...names: string[]) => {
    if (!tags) return null
    const v = Number(pick(tags, ...names))
    return Number.isFinite(v) ? v : null
  }
  const tagStr = (...names: string[]) => {
    const v = tags ? pick(tags, ...names) : undefined
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }
  const isVideo = a.kind === 'video'
  const albums = (
    db
      .prepare(`SELECT al.name FROM album_asset x JOIN album al ON al.id = x.album_id WHERE x.asset_id = ? ORDER BY al.position`)
      .all(Number(key)) as { name: string }[]
  ).map((r) => r.name)

  const verified = (f: (typeof files)[number]): string | null => {
    if (f.decode_error) return `damaged: ${f.decode_error}`
    return ['size checked', 'checksum verified', 'structure verified', 'fully decoded'][f.verify_level] ?? null
  }

  return {
    key,
    kind: kindOf(a.kind),
    title: primary ? path.posix.basename(primary.path) : `Item ${key}`,
    capturedUtc: a.captured_utc,
    offsetSeconds: a.captured_offset,
    timeSource: a.time_source,
    width: a.width,
    height: a.height,
    durationMs: a.duration_ms,
    camera: primary && (primary.make || primary.model) ? { make: primary.make, model: primary.model, lens: primary.lens } : null,
    exposure:
      primary && (primary.iso || primary.f_number || primary.exposure || primary.focal_mm)
        ? {
            iso: primary.iso,
            fNumber: primary.f_number,
            exposureSeconds: primary.exposure,
            focalMm: primary.focal_mm,
            focal35: tagNum('FocalLengthIn35mmFormat'),
            ev: tagNum('ExposureCompensation'),
            zoom: tagNum('DigitalZoomRatio'),
          }
        : null,
    video: isVideo ? { codec: tagStr('CompressorID'), fps: tagNum('VideoFrameRate') } : null,
    caption: tagStr('ImageDescription', 'Caption-Abstract', 'Description'),
    location:
      a.lat !== null && a.lon !== null ? { lat: a.lat, lon: a.lon, altitude: a.altitude, place: a.place } : null,
    favourite: a.favourite === 1,
    edited: a.has_adjustments === 1,
    cloud: false,
    subtype: a.subtype,
    albums,
    files: files.map(
      (f): ItemFile => ({
        name: path.posix.basename(f.path),
        role: f.role,
        bytes: f.bytes,
        mime: f.mime,
        location: path.join(mediaRoot, ...f.path.split('/')),
        verified: verified(f),
      }),
    ),
    savedIn: [],
  }
}

/** The files behind one item, for viewing and saving. Primary first. */
export function vaultFiles(
  db: Db,
  key: string,
): { id: number; path: string; role: string; mime: string; sha256: string; bytes: number; primary: boolean; encryptedPath: string | null }[] {
  return (
    db
      .prepare(
        `SELECT id, path, role, mime, sha256, bytes, is_primary, encrypted_path AS encryptedPath FROM file WHERE asset_id = ? ORDER BY is_primary DESC, id`,
      )
      .all(Number(key)) as {
      id: number
      path: string
      role: string
      mime: string
      sha256: string
      bytes: number
      is_primary: number
      encryptedPath: string | null
    }[]
  ).map((f) => ({ ...f, primary: f.is_primary === 1 }))
}

function safeUnpack(blob: Buffer): RawTags | null {
  try {
    return unpackTags(blob)
  } catch {
    return null
  }
}

type VaultFile = ReturnType<typeof vaultFiles>[number]

/**
 * The file to draw for an asset. A particular file when asked (a burst
 * frame), else the edited render when there is one, since the vault shows
 * edits by default like the phone does, else the primary.
 */
export function displayFile(files: VaultFile[], fileId: number | null): VaultFile | null {
  if (fileId !== null) return files.find((f) => f.id === fileId) ?? null
  const primary = files.find((f) => f.primary) ?? files[0] ?? null
  if (!primary) return null
  const family = primary.mime.split('/')[0]
  return files.find((f) => f.role === 'render' && f.mime.split('/')[0] === family) ?? primary
}
