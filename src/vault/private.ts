import crypto, { type KeyObject } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Db } from '../library/db.ts'
import { thumbPath, SIZES, type ThumbSize } from '../thumbs/render.ts'
import { createVaultKeys, decryptFile, encryptFile, encryptedSha256, openEncrypted, publicKeyOf, type EncryptedReader, type VaultKeyFile } from './private-crypto.ts'
import type { OpenVault, VaultLayout } from './vault.ts'

/**
 * Hidden and Recently Deleted, encrypted at rest.
 *
 * An item is protected while it is hidden or deleted: every file it has (the
 * original, a Live Photo's video, edits, burst frames) is encrypted into the
 * vault's private folder, and the plain copies go: the file itself, its hard
 * links in album folders, and its thumbnails and cached previews. Unhiding or
 * recovering it puts every file back where it was, byte for byte.
 *
 * Write the encrypted copy and read it back, durably record it in the database,
 * and only then remove plaintext. Startup retains uncertain recovery copies;
 * authenticated cleanup can finish interrupted work after unlocking.
 *
 * What stays readable: the database's dates, places and camera details. The
 * pictures and videos are what is encrypted.
 */

export function privateDir(layout: VaultLayout): string {
  return layout.kind === 'library' ? path.join(layout.root, 'private') : path.join(layout.root, '.vault', 'private')
}

/** Check every existing component: a junction is not an owned file inside the vault. */
function noLinks(target: string): void {
  const absolute = path.resolve(target)
  const root = path.parse(absolute).root
  let current = root
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing a symbolic link or junction: ${current}`)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      break
    }
  }
}

function inside(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || relative.includes('\0') || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) ||
      relative.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.vault' || p.includes(':'))) throw new Error('Unsafe path in vault metadata.')
  const base = path.resolve(root)
  const target = path.resolve(base, ...relative.split('/'))
  const rel = path.relative(base, target)
  if (!rel || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) throw new Error('Path escapes the vault.')
  noLinks(base)
  noLinks(target)
  return target
}

function blobPath(layout: VaultLayout, name: string): string {
  if (!/^[a-zA-Z0-9-]+\.theia$/.test(name)) throw new Error('Unsafe encrypted-file name in vault metadata.')
  return inside(privateDir(layout), name)
}

function durable(db: Db, update: () => void): void {
  const previous = db.pragma('synchronous', { simple: true }) as number
  db.pragma('synchronous = FULL')
  try {
    db.transaction(update)()
    const checkpoint = db.pragma('wal_checkpoint(FULL)') as { busy: number }[]
    if (checkpoint.some(r => r.busy !== 0)) throw new Error('Vault database could not be flushed; originals have been retained.')
  } finally { db.pragma(`synchronous = ${previous}`) }
}

function writeKey(layout: VaultLayout, file: VaultKeyFile, create = false): void {
  noLinks(privateDir(layout))
  fs.mkdirSync(privateDir(layout), { recursive: true })
  const target = inside(privateDir(layout), 'key.json')
  const tmp = `${target}.${crypto.randomUUID()}.tmp`
  const fd = fs.openSync(tmp, 'wx')
  try { fs.writeFileSync(fd, JSON.stringify(file, null, 2)); fs.fsyncSync(fd) }
  finally { fs.closeSync(fd) }
  try {
    if (create) { fs.copyFileSync(tmp, target, fs.constants.COPYFILE_EXCL); fs.rmSync(tmp) }
    else fs.renameSync(tmp, target)
    const written = fs.openSync(target, 'r+')
    try { fs.fsyncSync(written) } finally { fs.closeSync(written) }
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e }
}

export function readKeyFile(layout: VaultLayout): VaultKeyFile | null {
  noLinks(privateDir(layout))
  try {
    const file = JSON.parse(fs.readFileSync(inside(privateDir(layout), 'key.json'), 'utf8')) as VaultKeyFile
    if (file.format !== 'theia-vault-key' || file.version !== 1 || !file.byPasscode || !file.byRecoveryKey || publicKeyOf(file).asymmetricKeyType !== 'x25519') {
      throw new Error('Invalid vault protection key file. Keep the existing key file and restore a backup.')
    }
    return file
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** Turn protection on. Returns the recovery key, shown once. */
export function setUpProtection(layout: VaultLayout, passcode: string): { recoveryKey: string; privateKey: KeyObject } {
  if (readKeyFile(layout)) throw new Error('This vault is already protected.')
  if (passcode.length < 6) throw new Error('Use a passcode of at least 6 characters.')
  const k = createVaultKeys(passcode)
  writeKey(layout, k.file, true)
  return { recoveryKey: k.recoveryKey, privateKey: k.privateKey }
}

export function writeKeyFile(layout: VaultLayout, file: VaultKeyFile): void {
  writeKey(layout, file)
}

interface FileRow {
  id: number
  path: string
  sha256: string
  encrypted_path: string | null
}

const filesOf = (db: Db, assetId: number) =>
  db.prepare(`SELECT id, path, sha256, encrypted_path FROM file WHERE asset_id = ?`).all(assetId) as FileRow[]

function albumFolders(db: Db, media: string, assetId: number): string[] {
  return (
    db
      .prepare(`SELECT al.folder FROM album_asset x JOIN album al ON al.id = x.album_id WHERE x.asset_id = ? AND al.folder IS NOT NULL`)
      .all(assetId) as { folder: string }[]
  ).map((r) => inside(media, r.folder))
}

function sha256File(file: string): string {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024)
    for (let pos = 0; ; ) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      if (!n) break
      hash.update(buf.subarray(0, n))
      pos += n
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/** Every plain copy of a file: where it lives, and its links in album folders with the same bytes. */
function plainCopies(media: string, folders: string[], f: FileRow): string[] {
  const main = inside(media, f.path)
  const out: string[] = []
  if (fs.existsSync(main)) {
    if (sha256File(main) !== f.sha256) throw new Error(`A different file now occupies ${f.path}; it has been retained.`)
    out.push(main)
  }
  for (const folder of folders) {
    const copy = path.join(folder, path.basename(main))
    noLinks(copy)
    if (copy !== main && fs.existsSync(copy) && sha256File(copy) === f.sha256) out.push(copy)
  }
  return out
}

/** Thumbnails, full-size previews and converted videos that show this file's picture. */
function cachedCopies(layout: VaultLayout, sha: string): string[] {
  if (!/^[a-f0-9]{64}$/i.test(sha)) throw new Error('Invalid file checksum in vault metadata.')
  noLinks(layout.cache)
  const out = (Object.keys(SIZES) as ThumbSize[]).map((s) => thumbPath(layout.cache, sha, s))
  const forThisHash = (name: string) => name === sha || name.startsWith(`${sha}-`) || name.startsWith(`${sha}.`)
  // Include old cache versions and unfinished previews, not just today's suffix.
  for (const name of ['full', 'video']) {
    const dir = path.join(layout.cache, name)
    noLinks(dir)
    if (fs.existsSync(dir)) for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (forThisHash(entry.name)) out.push(path.join(dir, entry.name))
    }
  }
  const thumbs = path.join(layout.cache, 'thumbs')
  noLinks(thumbs)
  if (fs.existsSync(thumbs)) for (const version of fs.readdirSync(thumbs, { withFileTypes: true })) {
    if (!version.isDirectory() && !version.isSymbolicLink()) continue
    const dir = path.join(thumbs, version.name, sha.slice(0, 2))
    noLinks(dir)
    if (version.isDirectory() && fs.existsSync(dir)) for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (forThisHash(entry.name)) out.push(path.join(dir, entry.name))
    }
  }
  return [...new Set(out)].filter((p) => { noLinks(p); return fs.existsSync(p) && fs.statSync(p).isFile() })
}

/** A plain file another, visible item still uses must stay. */
function sharedWithVisible(db: Db, f: FileRow, assetId: number): boolean {
  return !!db
    .prepare(`SELECT 1 FROM file f JOIN asset a ON a.id = f.asset_id WHERE f.sha256 = ? AND f.asset_id != ? AND f.encrypted_path IS NULL AND a.hidden = 0 AND a.deleted_at IS NULL LIMIT 1`)
    .get(f.sha256, assetId)
}

function removePlainCopies(vault: OpenVault, assetId: number, f: FileRow): number {
  const { db, layout } = vault
  const copies = plainCopies(layout.media, albumFolders(db, layout.media, assetId), f)
  const visible = db.prepare(`SELECT f.asset_id, f.path FROM file f JOIN asset a ON a.id = f.asset_id
    WHERE f.sha256 = ? AND f.asset_id != ? AND f.encrypted_path IS NULL AND a.hidden = 0 AND a.deleted_at IS NULL`).all(f.sha256, assetId) as { asset_id: number; path: string }[]
  const norm = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p
  const visiblePaths = new Set(visible.flatMap(r => [inside(layout.media, r.path),
    ...albumFolders(db, layout.media, r.asset_id).map(folder => path.join(folder, path.basename(r.path))) ]).map(norm))
  if (copies.some(p => visiblePaths.has(norm(p)))) throw new Error('A plaintext path is shared with a visible item. Unshare that item before protecting this one.')
  for (const p of copies) { noLinks(p); if (sha256File(p) !== f.sha256) throw new Error('The original changed while protection was running; it has been retained.'); fs.rmSync(p) }
  if (!sharedWithVisible(db, f, assetId)) for (const p of cachedCopies(layout, f.sha256)) fs.rmSync(p, { force: true })
  return copies.length
}

/**
 * Encrypt every file of an asset and remove its plain copies. Needs only the
 * public key. Safe to call again: files already encrypted are left alone.
 */
export async function protectAsset(vault: OpenVault, assetId: number, publicKey: KeyObject): Promise<void> {
  const { db, layout } = vault
  const dir = privateDir(layout)
  noLinks(dir)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of filesOf(db, assetId)) {
    if (f.encrypted_path) continue
    const src = inside(layout.media, f.path)
    if (!fs.existsSync(src)) throw new Error(`Can't protect ${f.path}: the file is missing from the vault.`)
    const name = `${crypto.randomUUID()}.theia`
    const { sha256 } = await encryptFile(src, path.join(dir, name), publicKey)
    if (sha256 !== f.sha256) {
      fs.rmSync(path.join(dir, name), { force: true })
      throw new Error(`Can't protect ${f.path}: the file on disk no longer matches what was saved.`)
    }
    durable(db, () => { db.prepare(`UPDATE file SET encrypted_path = ? WHERE id = ?`).run(name, f.id) })
    removePlainCopies(vault, assetId, f)
  }
}

/**
 * Decrypt every file of an asset back where it was, verify it, put back its
 * album links, and remove the encrypted copies.
 */
export async function releaseAsset(vault: OpenVault, assetId: number, privateKey: KeyObject): Promise<void> {
  const { db, layout } = vault
  const dir = privateDir(layout)
  const folders = albumFolders(db, layout.media, assetId)
  for (const f of filesOf(db, assetId)) {
    if (!f.encrypted_path) continue
    const blob = blobPath(layout, f.encrypted_path)
    const target = inside(layout.media, f.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target) && sha256File(target) !== f.sha256) throw new Error(`A different file now occupies ${f.path}; nothing was overwritten.`)
    if (!(fs.existsSync(target) && sha256File(target) === f.sha256)) {
      const sha = await decryptFile(blob, target, privateKey)
      if (sha !== f.sha256) {
        fs.rmSync(target, { force: true })
        throw new Error(`Can't restore ${f.path}: its encrypted copy doesn't hold the saved bytes.`)
      }
    }
    if (sha256File(target) !== f.sha256) throw new Error(`The restored copy of ${f.path} failed its read-back check.`)
    for (const folder of folders) {
      const copy = path.join(folder, path.basename(target))
      noLinks(copy)
      if (copy === target || fs.existsSync(copy)) continue
      fs.mkdirSync(folder, { recursive: true })
      try {
        fs.linkSync(target, copy)
      } catch {
        fs.copyFileSync(target, copy) // drives without hard links
      }
    }
    durable(db, () => { db.prepare(`UPDATE file SET encrypted_path = NULL WHERE id = ?`).run(f.id) })
    fs.rmSync(blob, { force: true })
  }
}

/** Assets that should be protected (hidden or deleted) and aren't yet, and the reverse. */
export function privacyWork(db: Db): { protect: number[]; release: number[] } {
  const protect = (
    db
      .prepare(
        `SELECT DISTINCT a.id FROM asset a JOIN file f ON f.asset_id = a.id
          WHERE (a.hidden = 1 OR a.deleted_at IS NOT NULL) AND f.encrypted_path IS NULL`,
      )
      .all() as { id: number }[]
  ).map((r) => r.id)
  const release = (
    db
      .prepare(
        `SELECT DISTINCT a.id FROM asset a JOIN file f ON f.asset_id = a.id
          WHERE a.hidden = 0 AND a.deleted_at IS NULL AND f.encrypted_path IS NOT NULL`,
      )
      .all() as { id: number }[]
  ).map((r) => r.id)
  return { protect, release }
}

/**
 * Inventory interrupted work without throwing away any potential recovery
 * copy. Authenticating a blob requires unlocking; only finishPrivateCleanup
 * may remove plaintext leftovers after that succeeds.
 */
export function sweepPrivate(vault: OpenVault): { orphans: number; leftovers: number; missing: string[] } {
  const { db, layout } = vault
  const dir = privateDir(layout)
  noLinks(dir)
  const out = { orphans: 0, leftovers: 0, missing: [] as string[] }
  if (!fs.existsSync(dir)) return out
  const rows = db.prepare(`SELECT id, asset_id, path, sha256, encrypted_path FROM file WHERE encrypted_path IS NOT NULL`).all() as (FileRow & {
    asset_id: number
  })[]
  const referenced = new Set(rows.map((r) => r.encrypted_path!))
  for (const n of fs.readdirSync(dir)) {
    if ((n.endsWith('.tmp') || n.endsWith('.theia')) && !referenced.has(n)) out.orphans++
  }
  for (const r of rows) {
    if (!fs.existsSync(blobPath(layout, r.encrypted_path!))) out.missing.push(r.path)
    for (const p of plainCopies(layout.media, albumFolders(db, layout.media, r.asset_id), r)) {
      out.leftovers++
    }
  }
  return out
}

/** Only an authenticated, readable encrypted copy may replace plaintext after a crash. */
export async function finishPrivateCleanup(vault: OpenVault, key: KeyObject): Promise<number> {
  const rows = vault.db.prepare(`SELECT id, asset_id, path, sha256, encrypted_path FROM file WHERE encrypted_path IS NOT NULL`).all() as (FileRow & { asset_id: number })[]
  let removed = 0
  for (const row of rows) {
    const blob = blobPath(vault.layout, row.encrypted_path!)
    if (await encryptedSha256(blob, key) !== row.sha256) throw new Error(`Encrypted backup for ${row.path} failed its read-back check; plaintext was retained.`)
    removed += removePlainCopies(vault, row.asset_id, row)
  }
  return removed
}

/** Open a protected file for reading (viewing, streaming, saving elsewhere). */
export function openProtected(layout: VaultLayout, encryptedPath: string, privateKey: KeyObject): EncryptedReader {
  return openEncrypted(blobPath(layout, encryptedPath), privateKey)
}

export { publicKeyOf }
