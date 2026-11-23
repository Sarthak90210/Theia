import { createHash } from 'node:crypto'
import path from 'node:path'
import type { DeviceSource, ScanRequest, ScanResult, ScannedFile } from '../device/types.ts'
import type { PhoneAlbum, PhoneAsset, PhoneLibrary } from './phone-library.ts'

/**
 * An Android phone's gallery, built from its folders.
 *
 * Android has no Photos database reachable over USB, so this does what the
 * phone's own gallery does with "folders on this device": everything under
 * DCIM, Pictures, Movies and Download, plus WhatsApp's media, one album per
 * folder. Folders that start with a dot or hold a .nomedia file (trash,
 * thumbnails, app caches) are left out, as the phone leaves them out.
 *
 * Capture time comes from the file name when it carries one (IMG_20240501_
 * 101500.jpg, PXL_…, Screenshot_…), because copying a file resets its date
 * but not its name. Otherwise the date the phone reports.
 */

export const ANDROID_ROOTS = [
  'DCIM',
  'Pictures',
  'Movies',
  'Download',
  'Android/media/com.whatsapp/WhatsApp/Media',
  'WhatsApp/Media',
]

/** Not photos anyone took: stickers, wallpapers apps cache, voice notes. */
export const ANDROID_SKIP = ['WhatsApp Stickers', 'WhatsApp Profile Photos', 'WhatsApp Voice Notes', 'WhatsApp Audio', 'thumbnails']

const PHOTO_EXT = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.dng', '.avif']
const VIDEO_EXT = ['.mp4', '.3gp', '.mov', '.mkv', '.webm', '.m4v']

export const ANDROID_SCAN: ScanRequest = { roots: ANDROID_ROOTS, skip: ANDROID_SKIP, extensions: [...PHOTO_EXT, ...VIDEO_EXT] }

/**
 * Every media file in the phone's photo folders. One request when the device
 * can answer it whole (Android over MTP); otherwise a walk with list and stat.
 */
export async function scanMedia(device: DeviceSource, request: ScanRequest = ANDROID_SCAN): Promise<ScanResult> {
  if (device.scan) return device.scan(request)
  const exts = new Set(request.extensions.map((e) => e.toLowerCase()))
  const skip = new Set(request.skip.map((s) => s.toLowerCase()))
  const files: ScannedFile[] = []
  let folders = 0
  const storages = (await device.list('/')).filter((n) => !n.startsWith('.'))
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12) return
    let names: string[]
    try {
      names = await device.list(dir)
    } catch {
      return
    }
    if (names.includes('.nomedia')) return
    for (const name of names) {
      if (name.startsWith('.')) continue
      const p = `${dir}/${name}`
      const st = await device.stat(p)
      if (st.isDirectory) {
        if (!skip.has(name.toLowerCase())) await walk(p, depth + 1)
      } else if (exts.has(path.posix.extname(name).toLowerCase()) && st.size > 0) {
        files.push({ path: p, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: 0 })
      }
    }
  }
  for (const storage of storages) {
    for (const root of request.roots) {
      const dir = `/${storage}/${root}`
      const st = await device.stat(dir).catch(() => null)
      if (!st?.isDirectory) continue
      folders++
      await walk(dir, 0)
    }
  }
  return { storages, folders, files }
}

/** A key that stays the same between connections, so saving twice finds the first copy. */
export function androidKey(file: Pick<ScannedFile, 'path' | 'size'>): string {
  return createHash('sha1').update(`${file.path}\0${file.size}`).digest('hex').slice(0, 24)
}

export function androidKind(name: string): 'photo' | 'video' | null {
  const ext = path.posix.extname(name).toLowerCase()
  if (PHOTO_EXT.includes(ext)) return 'photo'
  if (VIDEO_EXT.includes(ext)) return 'video'
  return null
}

const EARLIEST = Date.UTC(2000, 0, 1)

function plausible(ms: number, now: number): boolean {
  return Number.isFinite(ms) && ms >= EARLIEST && ms <= now + 86_400_000
}

/** A valid local or UTC time from parts, or null when the parts aren't a real date. */
function at(utc: boolean, y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null
  const date = utc ? new Date(Date.UTC(y, mo - 1, d, h, mi, s)) : new Date(y, mo - 1, d, h, mi, s)
  const back = utc ? date.getUTCDate() : date.getDate()
  return back === d ? date.getTime() : null
}

/**
 * When a file was taken, from its name if that says, else from the phone.
 * Names are local time, except Pixel's PXL_ names, which are UTC.
 */
export function captureTime(name: string, file: Pick<ScannedFile, 'mtimeMs' | 'ctimeMs'>, now = Date.now()): number {
  const fromName = timeFromName(name, file, now)
  if (fromName !== null) return fromName
  if (plausible(file.mtimeMs, now)) return file.mtimeMs
  if (plausible(file.ctimeMs, now)) return file.ctimeMs
  return file.mtimeMs > 0 ? file.mtimeMs : 0
}

function timeFromName(name: string, file: Pick<ScannedFile, 'mtimeMs'>, now: number): number | null {
  const utc = /^PXL_/i.test(name)
  const n = (s: string | undefined) => Number(s)
  // 20240501_101500, 20240501-101500 (IMG_, VID_, PXL_, Screenshot_, Samsung's bare names)
  let m = /(?:^|[^\d])(20\d{2})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/.exec(name)
  // 2024-05-01-10-15-00, 2024-05-01 10.15.00, 2024-05-01-101500
  m ??= /(?:^|[^\d])(20\d{2})-(\d{2})-(\d{2})[-_ T](\d{2})[-.:]?(\d{2})[-.:]?(\d{2})/.exec(name)
  if (m) {
    const t = at(utc, n(m[1]), n(m[2]), n(m[3]), n(m[4]), n(m[5]), n(m[6]))
    if (t !== null && plausible(t, now)) return t
  }
  // Milliseconds since 1970: FB_IMG_1714558500123.jpg, 1714558500123.jpg
  const ms = /(?:^|[^\d])(1\d{12})(?:[^\d]|$)/.exec(name)
  if (ms && plausible(Number(ms[1]), now)) return Number(ms[1])
  // A day without a time: IMG-20240501-WA0003.jpg. The file's own time if it
  // falls on that day, else noon.
  const day = /(?:^|[^\d])(20\d{2})(\d{2})(\d{2})(?:[^\d]|$)/.exec(name) ?? /(?:^|[^\d])(20\d{2})-(\d{2})-(\d{2})(?:[^\d]|$)/.exec(name)
  if (day) {
    const start = at(false, n(day[1]), n(day[2]), n(day[3]))
    if (start !== null && plausible(start, now)) {
      const end = start + 86_400_000
      return file.mtimeMs >= start && file.mtimeMs < end ? file.mtimeMs : start + 12 * 3_600_000
    }
  }
  return null
}

function subtypeOf(dir: string, name: string): string | null {
  if (/screen[\s_-]?record/i.test(dir) || /^screen[\s_-]?record/i.test(name)) return 'screen-recording'
  if (/screenshot/i.test(dir) || /^screenshot/i.test(name)) return 'screenshot'
  if (/^PANO_/i.test(name) || /\.PANO\./i.test(name)) return 'panorama'
  if (/selfie/i.test(dir)) return 'selfie'
  return null
}

/** The phone's files as a library: assets in capture order, and an album per folder. */
export function readAndroidLibrary(files: ScannedFile[], now = Date.now()): PhoneLibrary {
  const assets: PhoneAsset[] = []
  const byKey = new Map<string, PhoneAsset>()
  for (const f of files) {
    const filename = path.posix.basename(f.path)
    const kind = androidKind(filename)
    if (!kind || f.size <= 0) continue
    const key = androidKey(f)
    if (byKey.has(key)) continue
    const dir = path.posix.dirname(f.path)
    const asset: PhoneAsset = {
      key,
      kind,
      t: captureTime(filename, f, now),
      off: null,
      w: null,
      h: null,
      dur: null,
      fav: false,
      edited: false,
      cloud: false,
      subtype: subtypeOf(dir, filename),
      path: f.path,
      directory: dir.replace(/^\/+/, ''),
      filename,
      originalName: null,
      lat: null,
      lon: null,
      burstId: null,
    }
    assets.push(asset)
    byKey.set(key, asset)
  }
  assets.sort((a, b) => a.t - b.t || a.path.localeCompare(b.path))
  return {
    assets,
    byKey,
    bursts: new Map(),
    hidden: [],
    deleted: [],
    albums: folderAlbums(assets),
    schema: { assetTable: 'folders', albumJoin: null, columns: 0 },
    utilities: false,
  }
}

/**
 * One album per folder, named after it. Two folders with the same name
 * ("Sent" under both WhatsApp Images and WhatsApp Video) take their parent's
 * name too. The camera comes first, then the fullest folders.
 */
function folderAlbums(assets: PhoneAsset[]): PhoneAlbum[] {
  const byDir = new Map<string, string[]>()
  for (const a of assets) {
    const dir = path.posix.dirname(a.path)
    const keys = byDir.get(dir) ?? []
    keys.push(a.key)
    byDir.set(dir, keys)
  }
  const dirs = [...byDir.keys()]
  const parts = (dir: string) => dir.split('/').filter(Boolean)
  const nameOf = (dir: string, depth: number) => parts(dir).slice(-depth).join(' › ')
  const names = new Map<string, string>()
  for (const dir of dirs) {
    let depth = 1
    const max = parts(dir).length
    while (depth < max && dirs.some((other) => other !== dir && nameOf(other, depth) === nameOf(dir, depth))) depth++
    names.set(dir, nameOf(dir, depth))
  }
  const camera = (dir: string) => /\/DCIM\/Camera$/i.test(dir)
  return dirs
    .sort((x, y) => Number(camera(y)) - Number(camera(x)) || byDir.get(y)!.length - byDir.get(x)!.length || x.localeCompare(y))
    .map((dir) => ({ uuid: `folder-${createHash('sha1').update(dir).digest('hex').slice(0, 16)}`, name: names.get(dir)!, keys: byDir.get(dir)! }))
}
