import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Db } from '../library/db.ts'
import type { MetadataReader } from '../metadata/reader.ts'
import { packTags } from '../metadata/reader.ts'
import { checkStructure } from '../verify/containers.ts'
import { FileAccess } from '../verify/random-access.ts'
import { classify, backoffMs, sleep } from '../import/retry.ts'
import { DeviceDetachedError } from '../device/types.ts'
import { folderNameFor, type OpenVault } from './vault.ts'
import type { ItemKind } from '../gallery/types.ts'

/**
 * Save a selection into a vault: from a phone, or from another vault.
 *
 * Every file gets the same guarantees as an import: hashed while it streams,
 * checked against the size the source declared, structure-checked, and read
 * back from disk before it counts. A file that fails stays out of the vault and
 * is listed in the result with the reason.
 *
 * Layout is album folders. An item goes in the folder of the first album it
 * belongs to (in the source's album order), or `Library/` when it is in none.
 * Every other album it is in gets a hard link, which takes no extra space.
 *
 * Saving the same thing twice is a no-op: items are recognised by the phone's
 * identifier, and files by their bytes.
 */

export interface SaveFile {
  name: string
  /** master, motion (Live Photo video), render (edited version), sidecar (.AAE) */
  role: 'master' | 'motion' | 'render' | 'sidecar'
  mime: string
  /** Declared size, when the source knows it. A mismatch fails the file. */
  size: number | null
  /** Known checksum, when the source is a vault. Lets duplicates skip without copying. */
  sha256: string | null
  read(): AsyncIterable<Buffer>
}

export interface SaveItem {
  key: string
  kind: ItemKind
  t: number
  off: number | null
  w: number | null
  h: number | null
  dur: number | null
  fav: boolean
  edited: boolean
  subtype: string | null
  sourceUuid: string | null
  lat: number | null
  lon: number | null
  /** The source's name for where it was taken, kept so the vault shows the same. */
  place?: { label: string; city: string | null; region: string | null; country: string | null } | null
  cloud: boolean
  files: SaveFile[]
}

export interface SaveAlbum {
  /** The source's identifier, so saving the same album again adds to it. */
  uuid: string
  name: string
  /** Item keys in album order. Only the ones being saved matter. */
  keys: string[]
}

export interface SaveProgress {
  itemsDone: number
  itemsTotal: number
  bytesDone: number
  current: string | null
}

export interface SaveResult {
  saved: number
  alreadyThere: number
  skippedCloud: number
  failed: { item: string; file: string; reason: string }[]
  bytes: number
  /** Asset ids created in the vault, for thumbnails. */
  newAssets: number[]
}

export interface SaveOptions {
  signal?: AbortSignal
  onProgress?: (p: SaveProgress) => void
  metadata?: MetadataReader
  maxAttempts?: number
  retryBaseMs?: number
  now?: () => number
}

export class SaveCancelled extends Error {
  constructor() {
    super('save cancelled')
    this.name = 'SaveCancelled'
  }
}

export async function saveToVault(
  vault: OpenVault,
  items: SaveItem[],
  albums: SaveAlbum[],
  opts: SaveOptions = {},
): Promise<SaveResult> {
  const { db, layout } = vault
  const now = opts.now ?? Date.now
  const result: SaveResult = { saved: 0, alreadyThere: 0, skippedCloud: 0, failed: [], bytes: 0, newAssets: [] }
  const keys = new Set(items.map((i) => i.key))
  const relevantAlbums = albums.filter((a) => a.keys.some((k) => keys.has(k)))
  const albumIds = new Map(relevantAlbums.map((a) => [a.uuid, ensureAlbum(db, layout.root, a, now())]))
  const progress: SaveProgress = { itemsDone: 0, itemsTotal: items.length, bytesDone: 0, current: null }

  for (const item of items) {
    if (opts.signal?.aborted) throw new SaveCancelled()
    progress.current = item.files[0]?.name ?? item.key
    opts.onProgress?.({ ...progress })

    if (item.cloud) {
      result.skippedCloud++
    } else {
      const existing = findExisting(db, item)
      if (existing !== null) {
        result.alreadyThere++
        // Already here, but maybe not in this album yet.
        linkAlbums(db, layout.media, existing, item.key, relevantAlbums, albumIds)
      } else {
        const outcome = await saveItem(vault, item, relevantAlbums, albumIds, opts, (n) => {
          progress.bytesDone += n
          opts.onProgress?.({ ...progress })
        })
        if (outcome.assetId !== null) {
          result.saved++
          result.bytes += outcome.bytes
          result.newAssets.push(outcome.assetId)
        }
        result.failed.push(...outcome.failed)
      }
    }
    progress.itemsDone++
    opts.onProgress?.({ ...progress })
  }
  progress.current = null
  opts.onProgress?.({ ...progress })
  return result
}

/* ----------------------------------------------------------------- items */

function findExisting(db: Db, item: SaveItem): number | null {
  if (item.sourceUuid) {
    const row = db.prepare(`SELECT id FROM asset WHERE source_uuid = ? AND deleted_at IS NULL`).get(item.sourceUuid) as
      | { id: number }
      | undefined
    if (row) return row.id
  }
  const master = item.files.find((f) => f.role === 'master')
  if (master?.sha256 && item.kind !== 'burst') {
    const row = db
      .prepare(`SELECT f.asset_id FROM file f JOIN asset a ON a.id = f.asset_id WHERE f.sha256 = ? AND a.kind <> 'burst' AND a.deleted_at IS NULL LIMIT 1`)
      .get(master.sha256) as { asset_id: number } | undefined
    if (row) return row.asset_id
  }
  return null
}

function matchingBurst(db: Db, hashes: string[]): { asset_id: number } | undefined {
  const candidates = db.prepare(`SELECT DISTINCT a.id AS asset_id FROM asset a JOIN file f ON f.asset_id = a.id
    WHERE a.kind = 'burst' AND a.deleted_at IS NULL AND f.role = 'master' AND f.sha256 = ?`).all(hashes[0]) as { asset_id: number }[]
  const originals = db.prepare(`SELECT sha256 FROM file WHERE asset_id = ? AND role = 'master' ORDER BY sha256`)
  const wanted = [...hashes].sort()
  return candidates.find(({ asset_id }) => {
    const existing = originals.all(asset_id) as { sha256: string }[]
    return existing.length === wanted.length && existing.every((f, i) => f.sha256 === wanted[i])
  })
}

async function saveItem(
  vault: OpenVault,
  item: SaveItem,
  albums: SaveAlbum[],
  albumIds: Map<string, { id: number; folder: string }>,
  opts: SaveOptions,
  onBytes: (n: number) => void,
): Promise<{ assetId: number | null; bytes: number; failed: SaveResult['failed'] }> {
  const { db, layout } = vault
  const now = opts.now ?? Date.now
  const home = albums.find((a) => a.keys.includes(item.key))
  const folder = home ? albumIds.get(home.uuid)!.folder : 'Library'
  const dir = path.join(layout.media, folder)
  fs.mkdirSync(dir, { recursive: true })

  const staged: { file: SaveFile; tmp: string; sha: string; bytes: number }[] = []
  const failed: SaveResult['failed'] = []

  for (const file of item.files) {
    try {
      staged.push({ file, ...(await fetchVerified(file, path.join(dir, `.${file.name}.partial`), opts, onBytes)) })
    } catch (e) {
      if (e instanceof SaveCancelled || e instanceof DeviceDetachedError) {
        for (const s of staged) fs.rmSync(s.tmp, { force: true })
        throw e
      }
      failed.push({ item: item.key, file: file.name, reason: (e as Error).message })
    }
  }

  const master = staged.find((s) => s.file.role === 'master') ?? staged[0]
  if (!master || !staged.some((s) => s.file.role === 'master')) {
    // Without the original there is nothing worth keeping. The rest goes too.
    for (const s of staged) fs.rmSync(s.tmp, { force: true })
    if (!failed.length) failed.push({ item: item.key, file: '', reason: 'no original to save' })
    return { assetId: null, bytes: 0, failed }
  }

  // Bytes already in the vault under another item: link to that instead.
  // A frame's bytes cannot identify an entire burst. Compare all originals,
  // and keep standalone photos separate from the burst that contains them.
  const hashes = staged.filter(s => s.file.role === 'master').map(s => s.sha)
  const dup = (item.kind === 'burst'
    ? matchingBurst(db, hashes)
    : db.prepare(`SELECT f.asset_id FROM file f JOIN asset a ON a.id = f.asset_id WHERE f.sha256 = ? AND a.kind <> 'burst' AND a.deleted_at IS NULL LIMIT 1`).get(master.sha)) as
    | { asset_id: number }
    | undefined
  if (dup) {
    for (const s of staged) fs.rmSync(s.tmp, { force: true })
    linkAlbums(db, layout.media, dup.asset_id, item.key, albums, albumIds)
    return { assetId: null, bytes: 0, failed }
  }

  let bytes = 0
  const placed: { s: (typeof staged)[number]; rel: string }[] = []
  for (const s of staged) {
    const target = freeName(dir, s.file.name)
    fs.renameSync(s.tmp, target)
    fs.utimesSync(target, new Date(item.t), new Date(item.t))
    bytes += s.bytes
    placed.push({ s, rel: path.relative(layout.media, target).split(path.sep).join('/') })
  }

  let exif: Awaited<ReturnType<MetadataReader['read']>> | null = null
  const masterPlaced = placed.find((p) => p.s.file.role === 'master')!
  if (opts.metadata && !masterPlaced.s.file.mime.startsWith('video/')) {
    try {
      exif = await opts.metadata.read(path.join(layout.media, ...masterPlaced.rel.split('/')), item.t)
    } catch {
      exif = null
    }
  }

  let assetId = 0
  db.transaction(() => {
    const placeId =
      item.place && item.lat !== null && item.lon !== null
        ? Number(
            db
              .prepare(`INSERT INTO place (country, region, city, label, lat, lon) VALUES (?, ?, ?, ?, ?, ?)`)
              .run(item.place.country, item.place.region, item.place.city, item.place.label, item.lat, item.lon).lastInsertRowid,
          )
        : null
    assetId = Number(
      db
        .prepare(
          `INSERT INTO asset (kind, captured_utc, captured_offset, time_source, width, height, duration_ms,
             favourite, has_adjustments, subtype, source_uuid, lat, lon, place_id, created_at, updated_at)
           VALUES (?, ?, ?, 'phone', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.kind === 'photo' ? 'still' : item.kind,
          item.t,
          item.off,
          item.w,
          item.h,
          item.dur,
          item.fav ? 1 : 0,
          item.edited ? 1 : 0,
          item.subtype,
          item.sourceUuid,
          item.lat,
          item.lon,
          placeId,
          now(),
          now(),
        ).lastInsertRowid,
    )
    for (const p of placed) {
      if (p.s.file.role === 'sidecar') {
        db.prepare(`INSERT OR REPLACE INTO aae (asset_id, plist, editor) VALUES (?, ?, NULL)`).run(
          assetId,
          fs.readFileSync(path.join(layout.media, ...p.rel.split('/'))),
        )
      }
      const fileId = Number(
        db
          .prepare(
            `INSERT INTO file (asset_id, role, is_primary, path, bytes, sha256, mime, verified_at, verify_level, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
          )
          .run(assetId, p.s.file.role, p === masterPlaced ? 1 : 0, p.rel, p.s.bytes, p.s.sha, p.s.file.mime, now(), now())
          .lastInsertRowid,
      )
      if (p === masterPlaced && exif) {
        const m = exif.meta
        db.prepare(
          `INSERT INTO exif (file_id, raw, make, model, lens, iso, f_number, exposure, focal_mm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(fileId, packTags(exif.raw), m.make, m.model, m.lens, m.iso, m.fNumber, m.exposure, m.focalMm)
      }
    }
  })()

  linkAlbums(db, layout.media, assetId, item.key, albums, albumIds)
  return { assetId, bytes, failed }
}

/* ---------------------------------------------------------------- albums */

function ensureAlbum(db: Db, root: string, a: SaveAlbum, at: number): { id: number; folder: string } {
  const row = db.prepare(`SELECT id, folder FROM album WHERE source_uuid = ?`).get(a.uuid) as
    | { id: number; folder: string | null }
    | undefined
  if (row) return { id: row.id, folder: row.folder ?? folderNameFor(a.name) }

  // Two albums can share a name. Their folders cannot.
  const base = folderNameFor(a.name)
  let folder = base
  for (let n = 2; db.prepare(`SELECT 1 FROM album WHERE lower(folder) = lower(?)`).get(folder) || folder.toLowerCase() === 'library'; n++) {
    folder = `${base} (${n})`
  }
  fs.mkdirSync(path.join(root, folder), { recursive: true })
  const position = (db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM album`).get() as { p: number }).p
  const id = Number(
    db
      .prepare(`INSERT INTO album (name, source_uuid, position, folder, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(a.name, a.uuid, position, folder, at).lastInsertRowid,
  )
  return { id, folder }
}

/**
 * Put an asset in every album it belongs to: a row for the app, and a hard
 * link in the album's folder for File Explorer.
 */
function linkAlbums(
  db: Db,
  media: string,
  assetId: number,
  itemKey: string,
  albums: SaveAlbum[],
  albumIds: Map<string, { id: number; folder: string }>,
) {
  const files = db.prepare(`SELECT path FROM file WHERE asset_id = ?`).all(assetId) as { path: string }[]
  for (const a of albums) {
    const pos = a.keys.indexOf(itemKey)
    if (pos < 0) continue
    const al = albumIds.get(a.uuid)!
    db.prepare(`INSERT OR IGNORE INTO album_asset (album_id, asset_id, position) VALUES (?, ?, ?)`).run(al.id, assetId, pos)
    const folder = path.join(media, al.folder)
    fs.mkdirSync(folder, { recursive: true })
    for (const f of files) {
      const src = path.join(media, ...f.path.split('/'))
      if (path.dirname(src) === folder) continue
      const dest = path.join(folder, path.basename(src))
      if (fs.existsSync(dest)) continue
      try {
        fs.linkSync(src, dest)
      } catch {
        // exFAT and FAT have no hard links. A copy keeps the folder complete.
        fs.copyFileSync(src, dest)
      }
    }
  }
}

/* ----------------------------------------------------------------- files */

async function fetchVerified(
  file: SaveFile,
  tmp: string,
  opts: SaveOptions,
  onBytes: (n: number) => void,
): Promise<{ tmp: string; sha: string; bytes: number }> {
  const maxAttempts = opts.maxAttempts ?? 3
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchOnce(file, tmp, opts, onBytes)
    } catch (e) {
      fs.rmSync(tmp, { force: true })
      if (e instanceof SaveCancelled || e instanceof DeviceDetachedError) throw e
      const c = classify(e)
      if (c.cls !== 'transient' || attempt >= maxAttempts) throw e
      await sleep(backoffMs(attempt, opts.retryBaseMs ?? 250), opts.signal)
    }
  }
}

async function fetchOnce(
  file: SaveFile,
  tmp: string,
  opts: SaveOptions,
  onBytes: (n: number) => void,
): Promise<{ tmp: string; sha: string; bytes: number }> {
  const hash = createHash('sha256')
  const fd = fs.openSync(tmp, 'w')
  let bytes = 0
  try {
    for await (const chunk of file.read()) {
      if (opts.signal?.aborted) throw new SaveCancelled()
      fs.writeSync(fd, chunk)
      hash.update(chunk)
      bytes += chunk.length
      onBytes(chunk.length)
    }
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  const sha = hash.digest('hex')

  if (file.size !== null && bytes !== file.size) throw new Error(`expected ${file.size} bytes, received ${bytes}`)
  if (file.sha256 && file.sha256 !== sha) throw new Error('checksum differs from the source')

  // Read it back, in chunks: a phone video can be several gigabytes. The disk
  // has to have kept what it was given.
  if (hashFile(tmp) !== sha) throw new Error('bytes on disk differ from bytes received')

  if (file.role !== 'sidecar') {
    const access = FileAccess.open(tmp)
    try {
      const r = checkStructure(access, path.extname(file.name))
      if (!r.ok) throw new Error(`${r.format}: ${r.detail}`)
    } finally {
      access.close()
    }
  }
  return { tmp, sha, bytes }
}

function hashFile(file: string): string {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024)
    for (let pos = 0; ; ) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      if (n === 0) break
      hash.update(buf.subarray(0, n))
      pos += n
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function freeName(dir: string, name: string): string {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = path.join(dir, name)
  for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${stem}_${n}${ext}`)
  return candidate
}
