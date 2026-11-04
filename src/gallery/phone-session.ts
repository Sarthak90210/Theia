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
import type { Collections, ItemDetail, ItemFile } from './types.ts'

sharp.cache(false)

/**
 * One connected phone, open for browsing.
 *
 * Holds its own AFC connection, separate from any save in progress, so
 * scrolling the gallery and copying files do not queue behind each other.
 *
 * Everything fetched is cached per phone under `cacheRoot/<udid>/`: the Photos
 * database copy, thumbnails, and originals opened in the viewer. Nothing in
 * there is the only copy of anything.
 */

const PHOTOS_DB = '/PhotoData/Photos.sqlite'
const MAX_OPEN_FILES = 8

export interface PhoneSessionOptions {
  device: DeviceSource
  udid: string
  name: string
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
}

/** The connection to the phone is gone and a new one could not be made. */
export class PhoneLostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PhoneLostError'
  }
}

export class PhoneSession {
  readonly udid: string
  readonly name: string
  library!: PhoneLibrary
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
    this.dir = path.join(opts.cacheRoot, opts.udid.replace(/[^\w-]/g, '_'))
  }

  static async open(opts: PhoneSessionOptions): Promise<PhoneSession> {
    const s = new PhoneSession(opts)
    await s.load()
    return s
  }

  /** Copy the Photos database and list /DCIM. A few seconds for thousands of photos. */
  async load(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true })
    const dbDir = path.join(this.dir, 'db')
    fs.rmSync(dbDir, { recursive: true, force: true })
    fs.mkdirSync(dbDir, { recursive: true })
    const local = path.join(dbDir, 'Photos.sqlite')
    // The -wal holds recent changes not yet folded into the main file. Without
    // it, the newest photos would be missing.
    for (const suffix of ['', '-wal', '-shm']) {
      const got = await this.copyFrom(`${PHOTOS_DB}${suffix}`, `${local}${suffix}`)
      if (!got && suffix === '') throw new Error('could not read the Photos database from the phone')
    }

    this.dcim.clear()
    for (const album of await this.io((d) => d.list('/DCIM'))) {
      if (album.startsWith('.')) continue
      const dir = `/DCIM/${album}`
      this.dcim.set(dir, await this.io((d) => d.list(dir)))
    }

    this.library = readPhoneLibrary(local, (p) => this.onPhone(p))
    this.db?.close()
    this.db = new Database(local, { readonly: true, fileMustExist: true })
  }

  onPhone(devicePath: string): boolean {
    const dir = path.posix.dirname(devicePath)
    const name = path.posix.basename(devicePath).toLowerCase()
    return (this.dcim.get(dir) ?? []).some((n) => n.toLowerCase() === name)
  }

  collections(): Collections {
    return phoneCollections(this.library)
  }

  items(collectionId: string): PhoneAsset[] {
    return phoneItems(this.library, collectionId)
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
        a.lat !== null && a.lon !== null ? { lat: a.lat, lon: a.lon, altitude: null, place: extras?.place?.label ?? null } : null,
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
    this.db?.close()
    this.db = null
    await this.device.dispose().catch(() => {})
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
    if (this.device !== failed) return // another request already reconnected
    if (!this.reconnecting) {
      this.reconnecting = (async () => {
        try {
          const next = await this.opts.reconnect!()
          this.device = next
          await failed.dispose().catch(() => {})
        } catch (e) {
          this.opts.onLost?.(e as Error)
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
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.aae': 'application/xml',
}

export function mimeOf(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
}
