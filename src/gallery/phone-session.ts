import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { DeviceSource } from '../device/types.ts'
import { IMAGE_CACHE_VERSION } from '../thumbs/colour.ts'
import type { HeicPool } from '../thumbs/heic-pool.ts'
import { renderThumbnails, SIZES, thumbPath, type ThumbSize } from '../thumbs/render.ts'
import type { MetadataReader } from '../metadata/reader.ts'
import Database from 'better-sqlite3'
import {
  phoneCollections,
  phoneItems,
  readPhoneExtras,
  readPhoneLibrary,
  type PhoneAsset,
  type PhoneExtras,
  type PhoneLibrary,
} from './phone-library.ts'
import { ANDROID_SCAN, readAndroidLibrary, scanMedia } from './android-library.ts'
import type { ScanResult } from '../device/types.ts'
import type { Collections, ItemDetail, ItemFile } from './types.ts'

sharp.cache(false)

/**
 * One connected phone, open for browsing.
 *
 * Holds its own connection (AFC for an iPhone, MTP for Android), separate
 * from any save in progress, so scrolling the gallery and copying files do
 * not queue behind each other.
 *
 * An iPhone's gallery comes from its Photos database. An Android phone's
 * comes from its photo folders (see android-library.ts): no favourites,
 * edits, Hidden album or Recently Deleted, one item per file.
 *
 * Everything fetched is cached per phone under `cacheRoot/<udid>/`: the Photos
 * database copy, thumbnails, and originals opened in the viewer. Nothing in
 * there is the only copy of anything.
 */

const PHOTOS_DB = '/PhotoData/Photos.sqlite'
const MAX_OPEN_FILES = 8
/** An Android video with no preview of its own is copied to make one only up to this size. */
const ANDROID_VIDEO_THUMB_MAX = 200 * 1024 * 1024

export type PhonePlatform = 'iphone' | 'android'

export interface PhoneSessionOptions {
  device: DeviceSource
  udid: string
  name: string
  /** iphone when left out. */
  platform?: PhonePlatform
  cacheRoot: string
  heic: Pick<HeicPool, 'decode'>
  metadata?: MetadataReader
  ffmpeg?: string
  /**
   * A fresh connection to the same phone. iOS ends an idle AFC connection by
   * itself while USB and trust stay up, so the session reconnects once and
   * retries instead of failing every request after the drop.
   */
  reconnect?: () => Promise<DeviceSource>
  /** Reconnecting failed: the phone is locked, unplugged or untrusted now. */
  onLost?: (e: Error) => void
  /** Android scan progress counts inspected entries, not just usable media. */
  onScanProgress?: (checked: number) => void
  /** The interactive browser can publish a partial catalogue, then finish in the background. */
  progressive?: boolean
  openIndexDevice?: () => Promise<DeviceSource>
}

/** The connection to the phone is gone and a new one could not be made. */
/** An MTP device with storage but none of the folders photos live in: not a phone or camera. */
export class NoPhotoFoldersError extends Error {
  constructor() {
    super('This device has no photo folders.')
    this.name = 'NoPhotoFoldersError'
  }
}

export class PhoneLostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PhoneLostError'
  }
}

export class PhoneSession {
  readonly udid: string
  readonly name: string
  readonly platform: PhonePlatform
  library!: PhoneLibrary
  indexing = false
  indexError = false
  private pendingIndex: (() => Promise<void>) | null = null
  private indexTask: Promise<void> | null = null
  private indexDevice: DeviceSource | null = null
  private closed = false
  private itemCache: { collection: string; items: PhoneAsset[] } | null = null
  private privateInventory: PhoneLibrary | null = null
  /** Every file in /DCIM by directory, lower-cased names, for "is it on the phone" and siblings. */
  private dcim = new Map<string, string[]>()
  private readonly dir: string
  private readonly inflight = new Map<string, Promise<string | null>>()
  private phoneThumbs: boolean | null = null
  private previewMisses = 0
  private device: DeviceSource
  private reconnecting: Promise<void> | null = null
  /** Files open on the phone now, and requests waiting for a turn. */
  private db: Database.Database | null = null
  private openFiles = 0
  private readonly waiting: (() => void)[] = []
  /** File name of the largest preview, learned from the first item that had one. */
  private previewName: string | null = null

  private constructor(private readonly opts: PhoneSessionOptions) {
    this.device = opts.device
    this.udid = opts.udid
    this.name = opts.name
    this.platform = opts.platform ?? 'iphone'
    this.dir = path.join(opts.cacheRoot, opts.udid.replace(/[^\w-]/g, '_'))
  }

  static async open(opts: PhoneSessionOptions): Promise<PhoneSession> {
    const s = new PhoneSession(opts)
    await s.loadLibrary(!!opts.progressive)
    return s
  }

  /** A fresh, complete inventory for workflows that need a consistent snapshot. */
  async load(): Promise<void> {
    await this.indexTask
    await this.loadLibrary(false)
  }

  finishIndexing(changed: () => void): Promise<void> {
    if (!this.pendingIndex || this.closed) return this.indexTask ?? Promise.resolve()
    const work = this.pendingIndex
    this.pendingIndex = null
    this.indexTask = work().catch(() => { this.indexError = !this.closed }).finally(() => {
      this.indexing = false
      this.indexTask = null
      if (!this.closed) changed()
    })
    return this.indexTask
  }

  private async loadLibrary(progressive: boolean): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true })
    if (this.platform === 'android') return this.loadAndroid(progressive)
    // The copy in use stays open, and Windows refuses to delete an open file.
    // Each load gets a fresh folder; older ones go once nothing holds them.
    const dbDir = fs.mkdtempSync(path.join(this.dir, 'db-'))
    const local = path.join(dbDir, 'Photos.sqlite')
    let next: Database.Database | null = null
    try {
      // The -wal holds recent changes not yet folded into the main file. Without
      // it, the newest photos would be missing.
      for (const suffix of ['', '-wal', '-shm']) {
        const got = await this.copyFrom(`${PHOTOS_DB}${suffix}`, `${local}${suffix}`)
        if (!got && suffix === '') throw new Error('could not read the Photos database from the phone')
      }

      const dcim = new Map<string, string[]>()
      const folders = (await this.io((d) => d.list('/DCIM'))).filter(a => !a.startsWith('.')).sort().reverse()
      let checked = 0
      const listFolder = async (album: string) => {
        const dir = `/DCIM/${album}`
        const names = await this.io((d) => d.list(dir))
        dcim.set(dir, names)
        checked += names.length
        this.opts.onScanProgress?.(checked)
      }
      const initial = progressive ? folders.slice(0, 3) : folders
      for (const album of initial) await listFolder(album)

      const library = readPhoneLibrary(local, (p) => onDcim(dcim, p))
      next = new Database(local, { readonly: true, fileMustExist: true })
      this.dcim = dcim
      const remaining = folders.slice(initial.length)
      const partial = remaining.length ? knownPhoneLibrary(library, dcim) : null
      if (partial?.byKey.size) {
        this.setLibrary(partial)
        // The Photos DB knows every private key before its directory is read.
        // Use that complete inventory for clearing any old cached copies.
        this.privateInventory = library
        this.deferIndex(async () => {
          for (const album of remaining) {
            if (this.closed) return
            await listFolder(album)
          }
          if (this.closed) return
          for (const asset of library.byKey.values()) asset.cloud = !onDcim(dcim, asset.path)
          this.setLibrary(library)
          this.privateInventory = null
        })
      } else {
        for (const album of remaining) await listFolder(album)
        if (remaining.length) for (const asset of library.byKey.values()) asset.cloud = !onDcim(dcim, asset.path)
        this.setLibrary(library)
      }
    } catch (e) {
      next?.close()
      removeQuietly(dbDir)
      throw e
    }
    const previous = this.db
    this.db = next
    previous?.close()
    for (const entry of fs.readdirSync(this.dir)) {
      if (/^db(-.+)?$/.test(entry) && entry !== path.basename(dbDir)) removeQuietly(path.join(this.dir, entry))
    }
  }

  /** Show Camera first, then add other folders over a separate MTP connection. */
  private async loadAndroid(progressive: boolean): Promise<void> {
    if (progressive && this.opts.openIndexDevice) {
      const first = await this.io((d) => scanMedia(d, { ...ANDROID_SCAN, roots: ['DCIM'] }, this.opts.onScanProgress))
      if (first.files.length) {
        this.useAndroidScan(first)
        this.deferIndex(async () => {
          const index = await this.opts.openIndexDevice!()
          if (this.closed) {
            await index.dispose().catch(() => {})
            return
          }
          this.indexDevice = index
          try {
            const more = await scanMedia(index, { ...ANDROID_SCAN, roots: ANDROID_SCAN.roots.filter(r => r !== 'DCIM') },
              n => this.opts.onScanProgress?.(first.files.length + n))
            if (this.closed) return
            if (!more.storages.length) throw new Error('The phone stopped sharing its storage.')
            this.useAndroidScan({ ...more, folders: first.folders + more.folders, files: [...first.files, ...more.files] })
          } finally {
            if (this.indexDevice === index) {
              this.indexDevice = null
              await index.dispose().catch(() => {})
            }
          }
        })
        return
      }
    }
    this.useAndroidScan(await this.io((d) => scanMedia(d, undefined, this.opts.onScanProgress)))
  }

  private deferIndex(work: () => Promise<void>) {
    this.pendingIndex = work
    this.indexing = true
    this.indexError = false
  }

  private setLibrary(library: PhoneLibrary) {
    this.library = library
    this.privateKeys = null
    this.itemCache = null
  }

  private useAndroidScan(scan: ScanResult) {
    if (!scan.storages.length) {
      throw new Error("The phone isn't sharing its files. Unlock it, then tap the USB notification and choose File transfer.")
    }
    if (!scan.folders) throw new NoPhotoFoldersError()
    const dirs = new Map<string, string[]>()
    for (const f of scan.files) {
      const dir = path.posix.dirname(f.path)
      const names = dirs.get(dir) ?? []
      names.push(path.posix.basename(f.path))
      dirs.set(dir, names)
      this.sizes.set(f.path, f.size)
    }
    this.setLibrary(readAndroidLibrary(scan.files))
    this.dcim = dirs
  }

  onPhone(devicePath: string): boolean {
    return onDcim(this.dcim, devicePath)
  }

  collections(): Collections {
    return phoneCollections(this.library)
  }

  items(collectionId: string): PhoneAsset[] {
    if (this.itemCache?.collection === collectionId) return this.itemCache.items
    const items = phoneItems(this.library, collectionId)
    this.itemCache = { collection: collectionId, items }
    return items
  }

  itemPage(collectionId: string, page?: { fromEnd: number; limit: number }): PhoneAsset[] {
    const items = this.items(collectionId)
    if (!page) return items
    const end = Math.max(0, items.length - (Number.isSafeInteger(page.fromEnd) ? Math.max(0, page.fromEnd) : 0))
    const limit = Number.isSafeInteger(page.limit) ? Math.max(1, Math.min(2048, page.limit)) : 2048
    return items.slice(Math.max(0, end - limit), end)
  }

  asset(key: string): PhoneAsset | undefined {
    return this.library.byKey.get(key)
  }

  /**
   * Every file on the phone that belongs to this item: the original, a
   * rendered edit (IMG_E1234), the edit recipe (.AAE) and a Live Photo's
   * video. Same folder, same number. What a save copies.
   */
  filesFor(key: string): string[] {
    const a = this.asset(key)
    if (!a || a.cloud) return []
    // Android keeps an edit, a motion photo's video and the rest inside the one file.
    if (this.platform === 'android') return this.onPhone(a.path) ? [a.path] : []
    const dir = path.posix.dirname(a.path)
    const stem = path.posix.basename(a.filename, path.posix.extname(a.filename))
    const m = /^([A-Za-z]+_)(\d+)$/.exec(stem)
    const stems = new Set([stem.toLowerCase()])
    if (m) stems.add(`${m[1]}E${m[2]}`.toLowerCase())
    return (this.dcim.get(dir) ?? [])
      .filter((n) => stems.has(path.posix.basename(n, path.posix.extname(n)).toLowerCase()))
      .sort((x, y) => (x === a.filename ? -1 : y === a.filename ? 1 : x.localeCompare(y)))
      .map((n) => `${dir}/${n}`)
  }

  /** A thumbnail on local disk, fetching or rendering it on first request. */
  thumb(key: string, size: ThumbSize): Promise<string | null> {
    const id = `${key}:${size}`
    let p = this.inflight.get(id)
    if (!p) {
      p = this.makeThumb(key, size).finally(() => this.inflight.delete(id))
      this.inflight.set(id, p)
    }
    return p
  }

  /** The original on local disk, for the viewer and the info panel. */
  async original(key: string): Promise<string | null> {
    const a = this.asset(key)
    if (!a || a.cloud) return null
    return this.localCopy(a.path)
  }

  /**
   * What the viewer shows: the edited version when the phone has one
   * (IMG_E1234 beside IMG_1234), otherwise the original. The phone's own
   * Photos app shows edits by default, and so does this.
   */
  /**
   * The phone's own Hidden album and Recently Deleted. Theia never writes these
   * to its cache: thumbnails and full pictures are made in memory, and videos
   * stream straight from the phone.
   */
  isPrivate(key: string): boolean {
    return this.privacyOf(key) !== null
  }

  /** Which of the two it is in, if either. Saved into a vault, it lands in the same place there. */
  privacyOf(key: string): 'hidden' | 'deleted' | null {
    this.privateKeys ??= {
      hidden: new Set(this.library.hidden),
      deleted: new Set(this.library.deleted),
    }
    return this.privateKeys.deleted.has(key) ? 'deleted' : this.privateKeys.hidden.has(key) ? 'hidden' : null
  }
  private privateKeys: { hidden: Set<string>; deleted: Set<string> } | null = null

  /** The phone's small preview of an item, in memory. */
  async previewBytes(key: string): Promise<Buffer | null> {
    const a = this.asset(key)
    return a ? this.phonePreview(a) : null
  }

  /** The bytes the viewer shows (the edit if there is one), read straight into memory. */
  async displayBytes(key: string): Promise<{ data: Buffer; name: string } | null> {
    const a = this.asset(key)
    if (!a || a.cloud) return null
    const edited = a.edited
      ? this.filesFor(key).find((p) => /^[A-Za-z]+_E\d+\.(heic|heif|jpe?g|png)$/i.test(path.posix.basename(p)))
      : undefined
    const devicePath = edited ?? a.path
    try {
      return { data: await this.readAll(devicePath), name: path.posix.basename(devicePath) }
    } catch {
      return null
    }
  }

  /**
   * Remove anything already cached for the phone's private items (from before
   * this rule, or from when they were still in the Library). Returns how many files went.
   */
  forgetPrivate(): number {
    let n = 0
    const rm = (p: string) => {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true })
        n++
      }
    }
    const walk = (dir: string, match: (name: string) => boolean) => {
      if (!fs.existsSync(dir)) return
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p, match)
        else if (match(e.name)) rm(p)
      }
    }
    const inventory = this.privateInventory ?? this.library
    const keys = [...inventory.hidden, ...inventory.deleted]
    const ids = new Set(keys.map((k) => safe(k)))
    const names = new Set(keys.flatMap((k) => this.filesFor(k).map((p) => path.posix.basename(p))))
    const originals = new Map<string, Set<string>>()
    for (const key of keys) {
      const asset = inventory.byKey.get(key)
      if (!asset) continue
      const folder = path.posix.dirname(asset.path).replace(/^\/+/, '').replace(/[\\/]/g, '_')
      const stems = originals.get(folder) ?? new Set<string>()
      const stem = path.posix.parse(asset.filename).name.toLowerCase()
      stems.add(stem)
      const edited = /^([a-z]+_)(\d+)$/.exec(stem)
      if (edited) stems.add(`${edited[1]}e${edited[2]}`)
      originals.set(folder, stems)
    }
    walk(path.join(this.dir, 'thumbs'), (name) => ids.has(name.replace(/-(sm|lg|ph)\.webp$/, '')))
    walk(path.join(this.dir, 'rendered'), (name) => [...ids].some((id) => name.includes(id)))
    walk(path.join(this.dir, 'originals'), (name) => names.has(name))
    for (const [folder, stems] of originals) {
      walk(path.join(this.dir, 'originals', folder), (name) => stems.has(path.parse(name).name.toLowerCase()))
    }
    walk(path.join(this.dir, 'video'), (name) => [...ids].some((id) => name.startsWith(id)))
    return n
  }

  async display(key: string): Promise<{ path: string; name: string } | null> {
    const a = this.asset(key)
    if (!a || a.cloud) return null
    const edited = a.edited
      ? this.filesFor(key).find((p) => /^[A-Za-z]+_E\d+\.(heic|heif|jpe?g|png)$/i.test(path.posix.basename(p)))
      : undefined
    const devicePath = edited ?? a.path
    const local = await this.localCopy(devicePath)
    return local ? { path: local, name: path.posix.basename(devicePath) } : null
  }

  /** Where this phone's copies, thumbnails and converted videos live. */
  get cacheDir(): string {
    return this.dir
  }

  private readonly sizes = new Map<string, number>()

  /** A file's size on the phone, asked once. */
  async size(devicePath: string): Promise<number> {
    let n = this.sizes.get(devicePath)
    if (n === undefined) {
      n = (await this.io((d) => d.stat(devicePath))).size
      this.sizes.set(devicePath, n)
    }
    return n
  }

  /**
   * Bytes straight from a file on the phone, for streaming a video without
   * copying it first. The window asks for a few MB at a time as it plays.
   */
  readRange(devicePath: string, start: number, length: number): Promise<Buffer> {
    return this.withFile(() =>
      this.io(async (d) => {
        const h = await d.open(devicePath)
        try {
          if (start > 0) await h.seek(start)
          const parts: Buffer[] = []
          let got = 0
          while (got < length) {
            const b = await h.read(Math.min(1024 * 1024, length - got))
            if (!b.length) break
            parts.push(b)
            got += b.length
          }
          return Buffer.concat(parts)
        } finally {
          await h.close().catch(() => {})
        }
      }),
    )
  }

  /**
   * Any file on the phone, copied once into this phone's cache. Requests for
   * the same file that arrive together share one copy.
   */
  async localCopy(devicePath: string): Promise<string | null> {
    const dir = path.posix.dirname(devicePath).replace(/^\/+/, '').replace(/[\/]/g, '_')
    const target = path.join(this.dir, 'originals', dir, path.posix.basename(devicePath))
    if (fs.existsSync(target)) return target
    const id = `copy:${devicePath}`
    let p = this.inflight.get(id)
    if (!p) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      p = this.copyFrom(devicePath, target)
        .then((ok) => (ok ? target : null))
        .finally(() => this.inflight.delete(id))
      this.inflight.set(id, p)
    }
    return p
  }

  async detail(key: string, savedIn: string[]): Promise<ItemDetail | null> {
    const a = this.asset(key)
    if (!a) return null
    const files: ItemFile[] = []
    for (const p of this.filesFor(key)) {
      // A handful of files per item, so a stat each is cheap.
      const bytes = await this.io((d) => d.stat(p))
        .then((st) => st.size)
        .catch(() => 0)
      files.push({ name: path.posix.basename(p), role: roleOf(p, a), bytes, mime: mimeOf(p), location: p, verified: null })
    }

    // The phone keeps the EXIF summary it shows in its own database, which
    // covers videos and iCloud-only items too. Older iOS without it: read the
    // original, if it is a photo (videos can be gigabytes).
    const extras = this.extras(key)
    let camera: ItemDetail['camera'] = extras?.camera ?? null
    let exposure: ItemDetail['exposure'] = extras?.exposure ?? null
    // Android keeps no location outside the file, so it comes from the photo here.
    let fileLocation: { lat: number; lon: number } | null = null
    if (!camera && this.opts.metadata && a.kind !== 'video' && !a.cloud) {
      const local = await this.original(key)
      if (local) {
        try {
          const { meta } = await this.opts.metadata.read(local, a.t)
          camera = meta.make || meta.model ? { make: meta.make, model: meta.model, lens: meta.lens } : null
          exposure = {
            iso: meta.iso,
            fNumber: meta.fNumber,
            exposureSeconds: meta.exposure,
            focalMm: meta.focalMm,
            focal35: null,
            ev: null,
            zoom: null,
          }
          if (meta.lat !== null && meta.lon !== null) fileLocation = { lat: meta.lat, lon: meta.lon }
        } catch {
          /* the info panel shows what it has */
        }
      }
    }

    return {
      key,
      kind: a.kind,
      title: a.originalName ?? a.filename,
      capturedUtc: a.t || null,
      offsetSeconds: a.off,
      timeSource: 'phone',
      width: a.w,
      height: a.h,
      durationMs: a.dur,
      camera,
      exposure,
      video: a.kind === 'video' ? (extras?.video ?? null) : null,
      location:
        a.lat !== null && a.lon !== null
          ? { lat: a.lat, lon: a.lon, altitude: null, place: extras?.place?.label ?? null }
          : fileLocation
            ? { ...fileLocation, altitude: null, place: null }
            : null,
      caption: extras?.caption ?? null,
      favourite: a.fav,
      edited: a.edited,
      cloud: a.cloud,
      subtype: a.subtype,
      albums: this.library.albums.filter((al) => al.keys.includes(key)).map((al) => al.name),
      files,
      savedIn,
    }
  }

  /** Camera, exposure, place and caption from the phone's database. */
  extras(key: string): PhoneExtras | null {
    if (!this.db) return null
    try {
      return readPhoneExtras(this.db, key)
    } catch {
      return null
    }
  }

  async close(): Promise<void> {
    this.closed = true
    const index = this.indexDevice
    this.indexDevice = null
    this.pendingIndex = null
    this.db?.close()
    this.db = null
    await Promise.all([index, this.device].map(d => d?.dispose().catch(() => {})))
  }

  /**
   * At most MAX_OPEN_FILES files open on the phone at once. iOS refuses the
   * 241st open on one connection ("no resources"), and a grid asks for
   * hundreds of tiles together. The connection runs one request at a time
   * anyway, so a few in flight are as fast as hundreds.
   */
  private async withFile<T>(fn: () => Promise<T>): Promise<T> {
    if (this.openFiles < MAX_OPEN_FILES) this.openFiles++
    else await new Promise<void>((r) => this.waiting.push(r)) // the slot is handed over
    try {
      return await fn()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.openFiles--
    }
  }

  /**
   * Run one operation on the phone. If the connection turns out to be dead,
   * reconnect (once, however many requests noticed together) and run it again.
   */
  private async io<T>(fn: (d: DeviceSource) => Promise<T>): Promise<T> {
    const d = this.device
    try {
      return await fn(d)
    } catch (e) {
      if (!this.opts.reconnect || !isConnectionLost(e)) throw e
      await this.replace(d)
      return fn(this.device)
    }
  }

  private async replace(failed: DeviceSource): Promise<void> {
    if (this.closed) throw new PhoneLostError('The phone session is closed.')
    if (this.device !== failed) return // another request already reconnected
    if (!this.reconnecting) {
      this.reconnecting = (async () => {
        try {
          const next = await this.opts.reconnect!()
          if (this.closed) {
            await next.dispose().catch(() => {})
            throw new PhoneLostError('The phone session is closed.')
          }
          this.device = next
          await failed.dispose().catch(() => {})
        } catch (e) {
          if (!this.closed) this.opts.onLost?.(e as Error)
          throw new PhoneLostError((e as Error).message)
        }
      })().finally(() => (this.reconnecting = null))
    }
    await this.reconnecting
  }

  /* ------------------------------------------------------------- internal */

  private async makeThumb(key: string, size: ThumbSize): Promise<string | null> {
    const a = this.asset(key)
    if (!a) return null
    const out = path.join(this.dir, 'thumbs', IMAGE_CACHE_VERSION, `${safe(key)}-${size}.webp`)
    if (fs.existsSync(out)) return out
    fs.mkdirSync(path.dirname(out), { recursive: true })

    // Android: the phone's own preview for the blurred placeholder and for
    // videos, which would otherwise be copied whole to make a tile. Stills
    // render from the original, like the iPhone's, because the phone's
    // previews are often only a few hundred pixels across.
    if (this.platform === 'android' && (size === 'ph' || a.kind === 'video')) {
      const preview = await this.phonePreview(a)
      if (preview) {
        const spec = SIZES[size]
        let img = sharp(preview).rotate().resize(spec.edge, spec.edge, { fit: 'inside', withoutEnlargement: true })
        if (size === 'ph') img = img.blur(1.2)
        try {
          fs.writeFileSync(out, await img.webp({ quality: spec.quality }).toBuffer())
          return out
        } catch {
          /* not a picture after all: make one from the file */
        }
      }
      if (a.kind === 'video' && (await this.size(a.path).catch(() => Infinity)) > ANDROID_VIDEO_THUMB_MAX) return null
    }

    // Local stills use the same edited/original source as the viewer. Phone
    // previews can be tiny and have different tone mapping. Keep previews
    // for videos and cloud assets whose originals are unavailable.
    if (size !== 'lg' && (a.cloud || mimeOf(a.filename).startsWith('video/'))) {
      const preview = await this.phonePreview(a)
      if (preview) {
        const spec = SIZES[size]
        let img = sharp(preview).rotate().resize(spec.edge, spec.edge, { fit: 'inside', withoutEnlargement: true })
        if (size === 'ph') img = img.blur(1.2)
        fs.writeFileSync(out, await img.webp({ quality: spec.quality }).toBuffer())
        return out
      }
    }

    const renderRoot = path.join(this.dir, 'rendered')
    const renderKey = `phone-${safe(key)}`
    const existing = thumbPath(renderRoot, renderKey, size)
    if (fs.existsSync(existing)) return existing
    const shown = await this.display(key)
    if (!shown) return null
    const local = shown.path
    // Renders all three sizes at once, keyed by item, so the other two sizes
    // are free when they are asked for.
    await renderThumbnails(local, mimeOf(shown.name), renderKey, renderRoot, {
      heic: this.opts.heic,
      ffmpeg: this.opts.ffmpeg,
    })
    const src = thumbPath(renderRoot, renderKey, size)
    if (!fs.existsSync(src)) return null
    fs.copyFileSync(src, out)
    return out
  }

  /**
   * The phone keeps JPEG previews for every photo, including iCloud-only ones,
   * under /PhotoData/Thumbnails/V2/<directory>/<filename>/. The file names are
   * numbers that differ by iOS version, so take the largest JPEG there.
   */
  private async phonePreview(a: PhoneAsset): Promise<Buffer | null> {
    if (this.phoneThumbs === false) return null
    if (this.platform === 'android') return this.androidPreview(a)
    const dir = `/PhotoData/Thumbnails/V2/${a.directory}/${a.filename}`
    // Every folder uses the same file name for its largest preview, so after
    // the first hit open it directly: one round trip instead of a listing and
    // a stat per file. A grid of 400 tiles goes from minutes to seconds.
    if (this.previewName) {
      try {
        return await this.readAll(`${dir}/${this.previewName}`)
      } catch (e) {
        if (isConnectionLost(e)) throw e
        /* this item has a different set; list it */
      }
    }
    try {
      const names = (await this.io((d) => d.list(dir))).filter((n) => /\.jpe?g$/i.test(n))
      if (!names.length) return null
      let best: { name: string; size: number } | null = null
      for (const n of names) {
        const st = await this.io((d) => d.stat(`${dir}/${n}`))
        if (!best || st.size > best.size) best = { name: n, size: st.size }
      }
      const bytes = await this.readAll(`${dir}/${best!.name}`)
      this.phoneThumbs = true
      this.previewName ??= best!.name
      return bytes
    } catch (e) {
      if (isConnectionLost(e)) throw e
      if (!isNotFound(e)) console.warn(`phone preview ${dir}:`, (e as Error).message)
      // Some items have no preview (a video still processing, say). Many
      // misses before a single hit means this iOS keeps them elsewhere: stop
      // asking, and render from originals instead.
      if (this.phoneThumbs === null && ++this.previewMisses >= 20) this.phoneThumbs = false
      return null
    }
  }

  /** What the phone itself shows in its file browser, when it has made one. */
  private async androidPreview(a: PhoneAsset): Promise<Buffer | null> {
    const bytes = await this.withFile(() => this.io((d) => (d.thumbnail ? d.thumbnail(a.path) : Promise.resolve(null))))
    if (bytes?.length) {
      this.phoneThumbs = true
      return bytes
    }
    if (this.phoneThumbs === null && ++this.previewMisses >= 20) this.phoneThumbs = false
    return null
  }

  private readAll(devicePath: string): Promise<Buffer> {
    return this.withFile(() => this.io((d) => readAllFrom(d, devicePath)))
  }

  private async copyFrom(devicePath: string, target: string): Promise<boolean> {
    try {
      await this.withFile(() => this.io((d) => copyOnce(d, devicePath, target)))
      return true
    } catch (e) {
      if (isConnectionLost(e)) throw e
      if (!isNotFound(e)) console.warn(`phone copy ${devicePath}:`, (e as Error).message)
      return false
    }
  }
}

async function readAllFrom(device: DeviceSource, devicePath: string): Promise<Buffer> {
  const h = await device.open(devicePath)
  const parts: Buffer[] = []
  try {
    for (;;) {
      const b = await h.read(1024 * 1024)
      if (!b.length) break
      parts.push(b)
    }
  } finally {
    await h.close().catch(() => {})
  }
  return Buffer.concat(parts)
}

async function copyOnce(device: DeviceSource, devicePath: string, target: string): Promise<void> {
  const h = await device.open(devicePath)
  const tmp = `${target}.partial`
  const fd = fs.openSync(tmp, 'w')
  try {
    for (;;) {
      const b = await h.read(4 * 1024 * 1024)
      if (!b.length) break
      fs.writeSync(fd, b)
    }
  } finally {
    fs.closeSync(fd)
    await h.close().catch(() => {})
  }
  fs.renameSync(tmp, target)
}

/** The socket is gone, as opposed to the phone refusing one request. */
export function isConnectionLost(e: unknown): boolean {
  if (e instanceof PhoneLostError || (e as Error)?.name === 'DeviceDetachedError') return true
  return /ended by the other party|stream was destroyed|stream ended|ECONNRESET|EPIPE|socket hang up|service not connected/i.test(
    (e as Error)?.message ?? '',
  )
}

/** Do not expose originals as cloud-only until their folder has actually been checked. */
function knownPhoneLibrary(full: PhoneLibrary, dcim: Map<string, string[]>): PhoneLibrary {
  const known = (a: PhoneAsset) => dcim.has(path.posix.dirname(a.path))
  const byKey = new Map([...full.byKey].filter(([, a]) => known(a)))
  const keys = (list: string[]) => list.filter(k => byKey.has(k))
  return {
    ...full,
    byKey,
    assets: full.assets.filter(a => byKey.has(a.key)),
    hidden: keys(full.hidden),
    deleted: keys(full.deleted),
    bursts: new Map([...full.bursts].map(([id, list]) => [id, keys(list)])),
    albums: full.albums.map(a => ({ ...a, keys: keys(a.keys) })),
  }
}

function onDcim(dcim: Map<string, string[]>, devicePath: string): boolean {
  const dir = path.posix.dirname(devicePath)
  const name = path.posix.basename(devicePath).toLowerCase()
  return (dcim.get(dir) ?? []).some((n) => n.toLowerCase() === name)
}

/** A cache folder another session still holds open goes on a later load. */
function removeQuietly(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Still open somewhere (Windows). Harmless: it is only a cache.
  }
}

function isNotFound(e: unknown): boolean {
  return /object not found/i.test((e as Error)?.message ?? '')
}

function safe(key: string): string {
  return key.replace(/[^\w-]/g, '_')
}

function roleOf(p: string, a: PhoneAsset): string {
  const name = path.posix.basename(p)
  if (name === a.filename) return 'original'
  if (/\.aae$/i.test(name)) return 'edit recipe'
  if (/^[A-Za-z]+_E\d+/.test(name)) return 'edited version'
  if (/\.mov$/i.test(name) && a.kind === 'live') return 'Live Photo video'
  return 'related'
}

const MIME: Record<string, string> = {
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.dng': 'image/x-adobe-dng',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.3gp': 'video/3gpp',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.aae': 'application/xml',
  '.xmp': 'application/xml',
}

export function mimeOf(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
}
