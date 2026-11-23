import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { SaveAlbum, SaveFile, SaveItem } from './save.ts'
import { isVault } from './vault.ts'
import { mimeOf } from '../gallery/phone-session.ts'

/**
 * Photos and videos from an ordinary folder on this computer, as items the
 * vault saver can copy: the same verified copy, duplicate check and EXIF
 * reading as a save from a phone.
 *
 * - Files with the same name in the same folder are one item: a photo and its
 *   short video are a Live Photo; an .aae or .xmp travels with its photo; a
 *   JPEG beside a DNG or HEIC of the same shot is kept with it.
 * - The first folder level below what was chosen becomes an album, so
 *   "Trips/Goa/day 1" lands in an album called Trips.
 * - Hidden folders, system folders and vaults (including the one being saved
 *   into) are never entered, so a vault's own media and thumbnails can't be
 *   imported back into it.
 * - The capture time is the file's date only until the saver reads the
 *   photo's own EXIF date, which wins (timeSource 'filesystem').
 */

export const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.dng', '.avif', '.tif', '.tiff'])
export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.mkv', '.webm'])
export const SIDECAR_EXTS = new Set(['.aae', '.xmp'])

const IGNORE_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git', '.svn'])

/** A Live Photo's video is three seconds long. Anything bigger is a video in its own right. */
const LIVE_MOTION_MAX = 30 * 1024 * 1024

interface FoundFile {
  absPath: string
  name: string
  ext: string
  baseName: string
  /** The folder it was found in, relative to what was chosen. '' for the top. */
  relDir: string
  /** The chosen folder it was found under, for naming albums. Null for a file chosen by itself. */
  root: string | null
  size: number
  mtimeMs: number
}

export interface ScanOptions {
  /** Folders never to enter, such as the vault being saved into. */
  exclude?: string[]
}

export interface ImportScan {
  items: SaveItem[]
  albums: SaveAlbum[]
}

function wanted(ext: string): boolean {
  return PHOTO_EXTS.has(ext) || VIDEO_EXTS.has(ext) || SIDECAR_EXTS.has(ext)
}

function found(absPath: string, st: fs.Stats, relDir: string, root: string | null): FoundFile {
  const name = path.basename(absPath)
  return { absPath, name, ext: path.extname(name).toLowerCase(), baseName: path.parse(name).name, relDir, root, size: st.size, mtimeMs: st.mtimeMs }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Every wanted file under a folder. Asynchronous, so a big folder doesn't freeze the window. */
async function walkFolder(root: string, opts: ScanOptions, out: FoundFile[]): Promise<void> {
  const excluded = (opts.exclude ?? []).map((p) => path.resolve(p))
  const walk = async (dir: string, relDir: string): Promise<void> => {
    if (excluded.some((x) => isInside(dir, x)) || isVault(dir)) return
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name.toLowerCase())) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, relDir ? `${relDir}/${entry.name}` : entry.name)
      } else if (entry.isFile() && wanted(path.extname(entry.name).toLowerCase())) {
        try {
          const st = await fs.promises.stat(abs)
          if (st.size > 0) out.push(found(abs, st, relDir, root))
        } catch {
          /* gone or unreadable: skipped */
        }
      }
    }
  }
  await walk(root, '')
}

/** Everything in one folder and the folders below it. */
export async function scanFolderForImport(rootFolder: string, opts: ScanOptions = {}): Promise<ImportScan> {
  const root = path.resolve(rootFolder)
  let st: fs.Stats
  try {
    st = fs.statSync(root)
  } catch {
    throw new Error(`The folder "${rootFolder}" can't be found.`)
  }
  if (!st.isDirectory()) throw new Error(`"${rootFolder}" is not a folder.`)
  if ((opts.exclude ?? []).some((x) => isInside(path.resolve(x), root) && isInside(root, path.resolve(x)))) {
    throw new Error("That's the vault itself. Choose a folder outside it.")
  }
  if ((opts.exclude ?? []).some((x) => isInside(root, path.resolve(x)))) {
    throw new Error('That folder is inside the vault. Choose a folder outside it.')
  }
  if (isVault(root)) throw new Error('That folder is a vault. Open it from the sidebar, then save from it instead.')
  const files: FoundFile[] = []
  await walkFolder(root, opts, files)
  return groupFiles(files)
}

/** Files chosen one by one. */
export function scanFilesForImport(filePaths: string[]): ImportScan {
  const files: FoundFile[] = []
  for (const fp of filePaths) {
    try {
      const abs = path.resolve(fp)
      const st = fs.statSync(abs)
      if (st.isFile() && st.size > 0 && wanted(path.extname(abs).toLowerCase())) files.push(found(abs, st, '', null))
    } catch {
      /* not there: skipped */
    }
  }
  return groupFiles(files)
}

/**
 * Files and folders together, as dropped from File Explorer. A dropped
 * folder becomes an album named after it; its subfolders join that album.
 */
export async function scanPathsForImport(paths: string[], opts: ScanOptions = {}): Promise<ImportScan> {
  const files: FoundFile[] = []
  const excluded = (opts.exclude ?? []).map((p) => path.resolve(p))
  for (const p of paths) {
    const abs = path.resolve(p)
    let st: fs.Stats
    try {
      st = fs.statSync(abs)
    } catch {
      continue
    }
    if (excluded.some((x) => isInside(abs, x))) continue
    if (st.isDirectory()) {
      const inner: FoundFile[] = []
      await walkFolder(abs, opts, inner)
      // One level up, so the dropped folder's own name is the album.
      const name = path.basename(abs)
      for (const f of inner) files.push({ ...f, relDir: f.relDir ? `${name}/${f.relDir}` : name, root: path.dirname(abs) })
    } else if (st.isFile() && st.size > 0 && wanted(path.extname(abs).toLowerCase())) {
      files.push(found(abs, st, '', null))
    }
  }
  return groupFiles(files)
}

function groupFiles(files: FoundFile[]): ImportScan {
  // Same folder, same name before the extension: one shot.
  const groups = new Map<string, FoundFile[]>()
  for (const f of files) {
    const key = `${path.dirname(f.absPath).toLowerCase()}\0${f.baseName.toLowerCase()}`
    const list = groups.get(key)
    if (list) list.push(f)
    else groups.set(key, [f])
  }

  const items: SaveItem[] = []
  const albums = new Map<string, SaveAlbum>()
  for (const group of groups.values()) {
    const photos = group.filter((f) => PHOTO_EXTS.has(f.ext))
    const videos = group.filter((f) => VIDEO_EXTS.has(f.ext))
    const sidecars = group.filter((f) => SIDECAR_EXTS.has(f.ext))

    if (photos.length) {
      const master = primaryPhoto(photos)
      // A short .mov or .mp4 beside a photo is its Live Photo video; a long
      // one is a separate video that happens to share the name.
      const motion = videos.find((v) => (v.ext === '.mov' || v.ext === '.mp4') && v.size <= LIVE_MOTION_MAX) ?? null
      const files = [
        saveFile(master, 'master'),
        ...(motion ? [saveFile(motion, 'motion')] : []),
        ...photos.filter((p) => p !== master).map((p) => saveFile(p, 'render')),
        ...sidecars.map((s) => saveFile(s, 'sidecar')),
      ]
      add(items, albums, master, motion ? 'live' : 'photo', files)
      for (const v of videos) if (v !== motion) add(items, albums, v, 'video', [saveFile(v, 'master')])
    } else {
      for (const v of videos) add(items, albums, v, 'video', [saveFile(v, 'master'), ...sidecars.map((s) => saveFile(s, 'sidecar'))])
    }
    // A sidecar with nothing to go with is not worth saving on its own.
  }
  items.sort((a, b) => a.t - b.t || a.key.localeCompare(b.key))
  return { items, albums: [...albums.values()] }
}

function add(items: SaveItem[], albums: Map<string, SaveAlbum>, master: FoundFile, kind: SaveItem['kind'], files: SaveFile[]) {
  // Stable for the same file left where it was, so adding the folder again
  // skips what's already there without copying it first.
  const id = createHash('sha1').update(`${master.absPath.toLowerCase()}\0${master.size}\0${Math.floor(master.mtimeMs)}`).digest('hex')
  const key = `disk:${id.slice(0, 32)}`
  items.push({
    key,
    kind,
    t: Math.floor(master.mtimeMs),
    off: null,
    w: null,
    h: null,
    dur: null,
    fav: false,
    edited: false,
    subtype: null,
    sourceUuid: key,
    timeSource: 'filesystem',
    lat: null,
    lon: null,
    cloud: false,
    files,
  })
  const top = master.relDir.split('/').filter(Boolean)[0]
  if (!top || !master.root) return
  const albumPath = path.join(master.root, top)
  const uuid = `folder-${createHash('sha1').update(albumPath.toLowerCase()).digest('hex').slice(0, 24)}`
  const album = albums.get(uuid) ?? { uuid, name: top, keys: [] }
  album.keys.push(key)
  albums.set(uuid, album)
}

/** The original among several files of one shot: the raw, then HEIC, then whatever came first. */
function primaryPhoto(photos: FoundFile[]): FoundFile {
  return photos.find((p) => p.ext === '.dng') ?? photos.find((p) => p.ext === '.heic' || p.ext === '.heif') ?? photos[0]!
}

function saveFile(f: FoundFile, role: SaveFile['role']): SaveFile {
  return {
    name: f.name,
    role,
    mime: mimeOf(f.name),
    size: f.size,
    sha256: null,
    sourcePath: f.absPath,
    sourceMtimeMs: f.mtimeMs,
    // A fresh buffer per chunk: the saver may still hold one while the next is read.
    read: () => fs.createReadStream(f.absPath, { highWaterMark: 4 * 1024 * 1024 }),
  }
}
