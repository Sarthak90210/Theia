import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { sha256Of } from './hash.ts'
import type { Db } from '../library/db.ts'
import type { MetadataReader } from '../metadata/reader.ts'
import { packTags } from '../metadata/reader.ts'
import { checkStructure } from '../verify/containers.ts'
import { FileAccess } from '../verify/random-access.ts'
import { classify, backoffMs, sleep } from '../import/retry.ts'
import { DeviceDetachedError } from '../device/types.ts'
import { folderNameFor, type OpenVault } from './vault.ts'
import type { ItemKind } from '../gallery/types.ts'
import { SaveProgressTracker, type SaveFileProgress, type SaveProgress } from './save-progress.ts'
export type { SaveProgress } from './save-progress.ts'

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
 * identifier, and files by their bytes. With `duplicates: 'replace'`, an item
 * already there is saved again and the old copy goes, through `replace`, once
 * the new files have been verified.
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
  /** Phone identity captured before the copy, used only by verified cleanup. */
  sourcePath?: string
  sourceMtimeMs?: number
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
  /** Hidden at the source (the phone's Hidden album, a vault's Hidden). Saved hidden, so it is encrypted. */
  hidden?: boolean
  /** When it went into the source's Recently Deleted. Saved into the vault's Recently Deleted. */
  deletedAt?: number | null
  /**
   * Where `t` came from. 'phone' (the default) and the vault's own values are
   * trusted as they are: a date the person corrected on the phone lives in its
   * database, not in the file. 'filesystem' is only a file date, so the
   * photo's own EXIF capture time replaces it when there is one.
   */
  timeSource?: string | null
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

export interface SaveResult {
  saved: number
  alreadyThere: number
  /** Saved again over a copy that was already there (counted in `saved` too). */
  replaced: number
  skippedCloud: number
  failed: { item: string; file: string; reason: string }[]
  bytes: number
  /** Asset ids created in the vault, for thumbnails. */
  newAssets: number[]
  /**
   * Which vault asset each saved item is now, by item key: new, or already
   * there. Items that failed or were skipped are absent. Used to check each
   * one before deleting it from the phone.
   */
  assets: Record<string, number>
}

export interface SaveOptions {
  signal?: AbortSignal
  onProgress?: (p: SaveProgress) => void
  metadata?: MetadataReader
  maxAttempts?: number
  retryBaseMs?: number
  now?: () => number
  /** Items already in the vault: leave them (default), or save them again. */
  duplicates?: DuplicateChoice
  /**
   * Take the old copy of an item being replaced out of the vault: its files
   * and its rows. Throw to keep it; the item then counts as failed. Called
   * only after the new copy's files are verified.
   */
  replace?: (assetId: number) => Promise<void>
}

export type DuplicateChoice = 'skip' | 'replace'

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
  const result: SaveResult = { saved: 0, alreadyThere: 0, replaced: 0, skippedCloud: 0, failed: [], bytes: 0, newAssets: [], assets: {} }
  const keys = new Set(items.map((i) => i.key))
  const relevantAlbums = albums.filter((a) => a.keys.some((k) => keys.has(k)))
  const albumIds = new Map(relevantAlbums.map((a) => [a.uuid, ensureAlbum(db, layout.root, a, now())]))
  const replacing = opts.duplicates === 'replace'
  if (replacing && !opts.replace) throw new Error('Replacing needs a way to remove the old copy.')
  const progress = new SaveProgressTracker(items.map(item => ({ files: item.files,
    skip: item.cloud || (!replacing && findExisting(db, item) !== null) })), now, opts.onProgress)

  try {
  for (const [index, item] of items.entries()) {
    if (opts.signal?.aborted) throw new SaveCancelled()
    progress.startItem(index, item.key)

    if (item.cloud) {
      progress.skipItem(index)
      result.skippedCloud++
    } else {
      const existing = findExisting(db, item)
      if (existing !== null && !replacing) {
        progress.skipItem(index)
        result.alreadyThere++
        result.assets[item.key] = existing
        // Already here, but maybe not in this album yet.
        await linkAlbums(db, layout.media, existing, item.key, relevantAlbums, albumIds)
      } else {
        const outcome = await saveItem(vault, item, relevantAlbums, albumIds, opts,
          fileIndex => progress.file(index, fileIndex), () => progress.finishing(), existing)
        if (outcome.assetId !== null) {
          result.saved++
          if (outcome.replaced) result.replaced++
          result.bytes += outcome.bytes
          result.newAssets.push(outcome.assetId)
          // Only an item with every file saved counts as saved for clean-up.
          if (!outcome.failed.length) result.assets[item.key] = outcome.assetId
        } else if (!outcome.failed.length && outcome.dupAssetId) {
          result.alreadyThere++
          result.assets[item.key] = outcome.dupAssetId
        }
        result.failed.push(...outcome.failed)
      }
    }
    progress.itemDone()
  }
  progress.complete()
  return result
  } finally { progress.close() }
}

/* ----------------------------------------------------------------- items */

/** Which of these items the vault already has: item key to vault asset. */
export function existingInVault(db: Db, items: SaveItem[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const item of items) {
    if (item.cloud) continue
    const id = findExisting(db, item)
    if (id !== null) out.set(item.key, id)
  }
  return out
}

/**
 * Which vault items count as "already there". A deleted item from the source
 * matches the vault's Recently Deleted too, so saving it twice doesn't copy it
 * twice; anything else matches only items that aren't deleted.
 */
const liveFor = (item: SaveItem) => (item.deletedAt != null ? '' : 'AND a.deleted_at IS NULL')

function findExisting(db: Db, item: SaveItem): number | null {
  if (item.sourceUuid) {
    const row = db.prepare(`SELECT a.id FROM asset a WHERE a.source_uuid = ? ${liveFor(item)}`).get(item.sourceUuid) as
      | { id: number }
      | undefined
    if (row) return row.id
  }
  const master = item.files.find((f) => f.role === 'master')
  if (master?.sha256 && item.kind !== 'burst') {
    const row = db
      .prepare(`SELECT f.asset_id FROM file f JOIN asset a ON a.id = f.asset_id WHERE f.sha256 = ? AND a.kind <> 'burst' ${liveFor(item)} LIMIT 1`)
      .get(master.sha256) as { asset_id: number } | undefined
    if (row) return row.asset_id
  }
  return null
}

function matchingBurst(db: Db, hashes: string[], except: number): { asset_id: number } | undefined {
  const candidates = db.prepare(`SELECT DISTINCT a.id AS asset_id FROM asset a JOIN file f ON f.asset_id = a.id
    WHERE a.kind = 'burst' AND a.deleted_at IS NULL AND f.role = 'master' AND f.sha256 = ?`).all(hashes[0]) as { asset_id: number }[]
  const originals = db.prepare(`SELECT sha256 FROM file WHERE asset_id = ? AND role = 'master' ORDER BY sha256`)
  const wanted = [...hashes].sort()
  return candidates.find(({ asset_id }) => {
    if (asset_id === except) return false
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
  fileProgress: (index: number) => SaveFileProgress,
  finishing: () => void,
  /** The copy already in the vault that this one replaces. */
  replacing: number | null = null,
): Promise<{ assetId: number | null; bytes: number; failed: SaveResult['failed']; replaced?: boolean; dupAssetId?: number }> {
  const { db, layout } = vault
  const now = opts.now ?? Date.now
  const home = albums.find((a) => a.keys.includes(item.key))
  const folder = home ? albumIds.get(home.uuid)!.folder : 'Library'
  const dir = path.join(layout.media, folder)
  fs.mkdirSync(dir, { recursive: true })

  const staged: { file: SaveFile; tmp: string; sha: string; bytes: number }[] = []
  const failed: SaveResult['failed'] = []

  for (const [index, file] of item.files.entries()) {
    const progress = fileProgress(index)
    try {
      staged.push({ file, ...(await fetchVerified(file, path.join(dir, `.${file.name}.partial`), opts, progress)) })
    } catch (e) {
      if (e instanceof SaveCancelled || e instanceof DeviceDetachedError) {
        for (const s of staged) fs.rmSync(s.tmp, { force: true })
        throw e
      }
      progress.failed()
      failed.push({ item: item.key, file: file.name, reason: (e as Error).message })
    }
  }
  finishing()
  // Publish the phase before metadata and the final database transaction.
  await new Promise<void>(resolve => setImmediate(resolve))

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
  // The copy being replaced most likely has the same bytes; that one doesn't count.
  const except = replacing ?? -1
  const dup = (item.kind === 'burst'
    ? matchingBurst(db, hashes, except)
    : db.prepare(`SELECT f.asset_id FROM file f JOIN asset a ON a.id = f.asset_id WHERE f.sha256 = ? AND a.kind <> 'burst' ${liveFor(item)} AND a.id <> ? LIMIT 1`).get(master.sha, except)) as
    | { asset_id: number }
    | undefined
  if (dup) {
    for (const s of staged) fs.rmSync(s.tmp, { force: true })
    await linkAlbums(db, layout.media, dup.asset_id, item.key, albums, albumIds)
    return { assetId: null, bytes: 0, failed, dupAssetId: dup.asset_id }
  }

  // What the vault added to the old copy stays with the new one: its albums
  // and whether it was hidden. The old copy goes before the new files take
  // their names, so the new copy keeps the original file names.
  let carried: { hidden: boolean; albums: { album_id: number; position: number; folder: string | null }[] } | null = null
  if (replacing !== null && failed.length) {
    // A partial new copy never pushes out a whole old one.
    for (const s of staged) fs.rmSync(s.tmp, { force: true })
    return { assetId: null, bytes: 0, failed: failed.map(f => ({ ...f, reason: `${f.reason} Kept the copy already in the vault.` })) }
  }
  if (replacing !== null) {
    const old = db.prepare(`SELECT hidden FROM asset WHERE id = ?`).get(replacing) as { hidden: number } | undefined
    carried = {
      hidden: old?.hidden === 1,
      albums: db.prepare(`SELECT x.album_id, x.position, al.folder FROM album_asset x JOIN album al ON al.id = x.album_id WHERE x.asset_id = ?`)
        .all(replacing) as { album_id: number; position: number; folder: string | null }[],
    }
    try {
      await opts.replace!(replacing)
    } catch (e) {
      for (const s of staged) fs.rmSync(s.tmp, { force: true })
      failed.push({ item: item.key, file: master.file.name, reason: `Kept the copy already in the vault. Could not remove it: ${(e as Error).message}` })
      return { assetId: null, bytes: 0, failed }
    }
  }

  let bytes = 0
  const placed: { s: (typeof staged)[number]; rel: string }[] = []
  for (const s of staged) {
    const target = freeName(dir, s.file.name)
    await fs.promises.rename(s.tmp, target)
    await fs.promises.utimes(target, new Date(item.t), new Date(item.t))
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
    // The file's own capture time replaces only a guessed one (see SaveItem.timeSource).
    const fromFile = item.timeSource === 'filesystem' && exif?.meta.capturedUtcMs != null
    const capturedUtc = fromFile ? exif!.meta.capturedUtcMs! : item.t
    const capturedOffset = fromFile ? exif!.meta.capturedOffsetSeconds : item.off
    const timeSource = fromFile ? (exif!.meta.timeSource ?? 'exif') : (item.timeSource ?? 'phone')
    // Size and place: what the source knows, else what the file says.
    const width = item.w ?? exif?.meta.width ?? null
    const height = item.h ?? exif?.meta.height ?? null
    const hasPlace = item.lat !== null && item.lon !== null
    const lat = hasPlace ? item.lat : (exif?.meta.lat ?? null)
    const lon = hasPlace ? item.lon : (exif?.meta.lon ?? null)

    const placeId =
      item.place && lat !== null && lon !== null
        ? Number(
            db
              .prepare(`INSERT INTO place (country, region, city, label, lat, lon) VALUES (?, ?, ?, ?, ?, ?)`)
              .run(item.place.country, item.place.region, item.place.city, item.place.label, lat, lon).lastInsertRowid,
          )
        : null
    assetId = Number(
      db
        .prepare(
          `INSERT INTO asset (kind, captured_utc, captured_offset, time_source, width, height, duration_ms,
             favourite, hidden, deleted_at, has_adjustments, subtype, source_uuid, lat, lon, place_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.kind === 'photo' ? 'still' : item.kind,
          capturedUtc,
          capturedOffset,
          timeSource,
          width,
          height,
          item.dur,
          item.fav ? 1 : 0,
          // Hidden or deleted at the source stays so here. The caller encrypts
          // it straight after (privacyWork in private.ts finds it).
          item.hidden || carried?.hidden ? 1 : 0,
          item.deletedAt ?? null,
          item.edited ? 1 : 0,
          item.subtype,
          item.sourceUuid,
          lat,
          lon,
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

  await linkAlbums(db, layout.media, assetId, item.key, albums, albumIds)
  for (const a of carried?.albums ?? []) {
    db.prepare(`INSERT OR IGNORE INTO album_asset (album_id, asset_id, position) VALUES (?, ?, ?)`).run(a.album_id, assetId, a.position)
    if (a.folder) await linkInto(db, layout.media, assetId, a.folder)
  }
  return { assetId, bytes, failed, replaced: replacing !== null }
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
async function linkAlbums(
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
    await linkInto(db, media, assetId, al.folder, files)
  }
}

/**
 * A hard link (or a copy) of each of the asset's files in an album folder.
 * Asynchronous: on a drive without hard links (exFAT, FAT, as many USB drives
 * come) each is a whole copy, and a synchronous copy of a video froze the
 * window for as long as it took.
 */
/** An asset's files linked into the folder of every album it is in: for copies added to albums outside a save. */
export async function linkIntoAlbumFolders(db: Db, media: string, assetId: number): Promise<void> {
  const folders = db.prepare(`SELECT al.folder FROM album_asset x JOIN album al ON al.id = x.album_id WHERE x.asset_id = ? AND al.folder IS NOT NULL`)
    .all(assetId) as { folder: string }[]
  for (const f of folders) await linkInto(db, media, assetId, f.folder)
}

async function linkInto(db: Db, media: string, assetId: number, albumFolder: string,
  files = db.prepare(`SELECT path FROM file WHERE asset_id = ?`).all(assetId) as { path: string }[]) {
  const folder = path.join(media, ...albumFolder.split('/'))
  await fs.promises.mkdir(folder, { recursive: true })
  for (const f of files) {
    const src = path.join(media, ...f.path.split('/'))
    if (path.dirname(src) === folder) continue
    const dest = path.join(folder, path.basename(src))
    try {
      await fs.promises.link(src, dest)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      // exFAT and FAT have no hard links. A copy keeps the folder complete,
      // without replacing anything already there.
      await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err
      })
    }
  }
}

/* ----------------------------------------------------------------- files */

async function fetchVerified(
  file: SaveFile,
  tmp: string,
  opts: SaveOptions,
  progress: SaveFileProgress,
): Promise<{ tmp: string; sha: string; bytes: number }> {
  const maxAttempts = opts.maxAttempts ?? 3
  for (let attempt = 1; ; attempt++) {
    try {
      progress.beginAttempt()
      return await fetchOnce(file, tmp, opts, progress)
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
  progress: SaveFileProgress,
): Promise<{ tmp: string; sha: string; bytes: number }> {
  const hash = createHash('sha256')
  // Asynchronous writes and fsync: on a USB hard drive a synchronous fsync
  // held the main thread for over half a second per file, and the window with
  // it (scripts/bench-save-lag.ts).
  const fh = await fs.promises.open(tmp, 'w')
  let bytes = 0
  try {
    for await (const chunk of file.read()) {
      if (opts.signal?.aborted) throw new SaveCancelled()
      hash.update(chunk)
      await writeAll(fh, chunk)
      bytes += chunk.length
      progress.copied(chunk.length)
    }
    await fh.sync()
  } finally {
    await fh.close()
  }
  const sha = hash.digest('hex')

  if (file.size !== null && bytes !== file.size) throw new Error(`expected ${file.size} bytes, received ${bytes}`)
  if (file.sha256 && file.sha256 !== sha) throw new Error('checksum differs from the source')

  // Read it back, in chunks: a phone video can be several gigabytes. The disk
  // has to have kept what it was given.
  progress.verifying()
  if (await hashFile(tmp, n => progress.checked(n), opts.signal) !== sha) throw new Error('bytes on disk differ from bytes received')

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

/** FileHandle.write may write less than asked; loop until all of it is down. */
async function writeAll(fh: fs.promises.FileHandle, chunk: Buffer): Promise<void> {
  for (let off = 0; off < chunk.length; ) {
    const { bytesWritten } = await fh.write(chunk, off, chunk.length - off)
    off += bytesWritten
  }
}

/** Waits for the file to be closed too, so the rename that follows can't hit EPERM (see hash.ts). */
async function hashFile(file: string, onBytes: (n: number) => void, signal?: AbortSignal): Promise<string> {
  try {
    return await sha256Of(file, { signal, onBytes })
  } catch (e) {
    if (signal?.aborted) throw new SaveCancelled()
    throw e
  }
}

function freeName(dir: string, name: string): string {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = path.join(dir, name)
  for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${stem}_${n}${ext}`)
  return candidate
}
