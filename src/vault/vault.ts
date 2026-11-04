import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { openLibrary, type Db } from '../library/db.ts'

/**
 * A vault is a folder of photos the app can open, browse and save into. Any
 * number can be open at once.
 *
 * Two layouts, told apart by what is on disk:
 *
 * ```
 * album layout (new vaults)            library layout (made by the import CLI)
 * Vault/                               PhotosLibrary/
 *   vault.json                           vault.json      (added when opened)
 *   .vault/library.db                    library.db
 *   .vault/cache/thumbs/...              cache/thumbs/...
 *   Trip to Goa/IMG_1234.HEIC            media/2026/2026-03/...
 *   Library/IMG_2001.HEIC   (no album)
 * ```
 *
 * In the album layout the folders are what a person sees in File Explorer, so
 * the app's own files live in a hidden `.vault` folder. A photo in two albums
 * is stored once and hard-linked into the second folder, which costs no space.
 */

export const MANIFEST = 'vault.json'

export interface VaultManifest {
  format: 'photos-vault'
  version: 1
  id: string
  name: string
  createdAt: string
}

export interface VaultLayout {
  root: string
  kind: 'album' | 'library'
  db: string
  cache: string
  /** Where file paths in the database are relative to. */
  media: string
}

export function vaultLayout(root: string): VaultLayout {
  const legacy = fs.existsSync(path.join(root, 'library.db')) && !fs.existsSync(path.join(root, '.vault'))
  if (legacy) {
    return {
      root,
      kind: 'library',
      db: path.join(root, 'library.db'),
      cache: path.join(root, 'cache'),
      media: path.join(root, 'media'),
    }
  }
  return {
    root,
    kind: 'album',
    db: path.join(root, '.vault', 'library.db'),
    cache: path.join(root, '.vault', 'cache'),
    media: root,
  }
}

export class NotAVault extends Error {
  constructor(root: string) {
    super(`${root} is not a vault. Choose an empty folder to make a new one, or a folder that already has a vault.json.`)
    this.name = 'NotAVault'
  }
}

export interface OpenVault {
  manifest: VaultManifest
  layout: VaultLayout
  db: Db
}

/** True when the folder holds a vault or an import library. */
export function isVault(root: string): boolean {
  return (
    fs.existsSync(path.join(root, MANIFEST)) ||
    fs.existsSync(path.join(root, 'library.db')) ||
    fs.existsSync(path.join(root, '.vault', 'library.db'))
  )
}

/** True when a new vault may be made here: missing, or an empty folder. */
export function canCreateVault(root: string): boolean {
  if (!fs.existsSync(root)) return true
  return fs.statSync(root).isDirectory() && fs.readdirSync(root).length === 0
}

export function createVault(root: string, name?: string): OpenVault {
  if (!canCreateVault(root)) throw new NotAVault(root)
  fs.mkdirSync(path.join(root, '.vault'), { recursive: true })
  hide(path.join(root, '.vault'))
  const manifest: VaultManifest = {
    format: 'photos-vault',
    version: 1,
    id: randomUUID(),
    name: name?.trim() || path.basename(root),
    createdAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify(manifest, null, 2))
  const layout = vaultLayout(root)
  return { manifest, layout, db: openLibrary(layout.db) }
}

export function openVault(root: string): OpenVault {
  if (!isVault(root)) throw new NotAVault(root)
  const layout = vaultLayout(root)
  let manifest = readManifest(root)
  if (!manifest) {
    // An import library from before vaults existed. Give it an identity so it
    // can be told apart from other open vaults.
    manifest = {
      format: 'photos-vault',
      version: 1,
      id: randomUUID(),
      name: path.basename(root),
      createdAt: new Date().toISOString(),
    }
    fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify(manifest, null, 2))
  }
  return { manifest, layout, db: openLibrary(layout.db) }
}

export function readManifest(root: string): VaultManifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8')) as VaultManifest
    return m.format === 'photos-vault' && m.id ? m : null
  } catch {
    return null
  }
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * A folder name Windows will accept for an album: no reserved characters, no
 * trailing dot or space, not a device name, and not too long.
 */
export function folderNameFor(album: string): string {
  let name = album.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/, '')
  if (!name) name = 'Untitled'
  if (RESERVED.test(name)) name = `${name}_`
  if (name === '.vault' || name.toLowerCase() === MANIFEST) name = `_${name}`
  return name.slice(0, 120)
}

/** Hidden on Windows, so File Explorer shows albums and nothing else. Best effort. */
function hide(dir: string) {
  if (process.platform !== 'win32') return
  execFile('attrib', ['+h', dir], { windowsHide: true }, () => {})
}
