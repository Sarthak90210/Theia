import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OpenVault, VaultManifest } from './vault.ts'
import { MANIFEST } from './vault.ts'

const equal = (a: string, b: string) => process.platform === 'win32'
  ? a.toLowerCase() === b.toLowerCase() : a === b

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** Reject links in the complete ancestry, including Windows directory junctions. */
function noLinks(absolute: string): void {
  let current = absolute
  for (;;) {
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`Cannot delete a vault through a symbolic link or junction: ${current}`)
    const parent = path.dirname(current)
    if (equal(parent, current)) break
    current = parent
  }
}

function canonical(absolute: string): string {
  const resolved = path.resolve(absolute)
  if (fs.existsSync(resolved)) {
    noLinks(resolved)
    return fs.realpathSync.native(resolved)
  }
  // Another open vault may have been removed externally. Its lexical location
  // still protects against deleting an overlapping parent or child.
  let ancestor = path.dirname(resolved)
  while (!fs.existsSync(ancestor)) {
    const next = path.dirname(ancestor)
    if (equal(next, ancestor)) throw new Error(`Cannot resolve this vault location: ${absolute}`)
    ancestor = next
  }
  noLinks(ancestor)
  return path.resolve(fs.realpathSync.native(ancestor), path.relative(ancestor, resolved))
}

function defaultProtectedRoots(): string[] {
  const home = os.homedir()
  const roots = [process.cwd(), path.dirname(process.execPath), home,
    ...['Documents', 'Desktop', 'Downloads'].map(name => path.join(home, name))]
  if (process.env.USERPROFILE) roots.push(process.env.USERPROFILE)
  if (process.env.OneDrive) roots.push(process.env.OneDrive, ...['Documents', 'Desktop', 'Downloads'].map(name => path.join(process.env.OneDrive!, name)))
  for (const value of [process.env.SystemRoot, process.env.APPDATA, process.env.LOCALAPPDATA]) if (value) roots.push(value)
  return roots
}

/**
 * Validate immediately before recycling or recursively removing a vault.
 * The name confirmation in the UI is separate from this filesystem boundary.
 * Call again after any awaited work or after closing the vault's DB handle.
 */
export function validateVaultDeletion(vault: OpenVault, otherRoots: string[], protectedRoots: string[] = []): string {
  if (!path.isAbsolute(vault.layout.root)) throw new Error('The vault location must be an absolute path.')
  const root = canonical(vault.layout.root)
  const initial = fs.lstatSync(root)
  if (!initial.isDirectory()) throw new Error('The vault location is not a directory.')
  if (equal(path.parse(root).root, root)) throw new Error('A drive or share root cannot be deleted as a vault.')

  for (const protectedRoot of [...defaultProtectedRoots(), ...protectedRoots]) {
    if (inside(root, canonical(protectedRoot))) throw new Error('This vault location contains a protected folder and cannot be deleted.')
  }
  // These trees contain application or operating-system files. A misplaced
  // vault manifest must never authorize removal of a folder inside them.
  for (const systemTree of [process.env.SystemRoot, process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (systemTree && inside(canonical(systemTree), root)) throw new Error('Vault deletion is not allowed inside an operating-system or application-data folder.')
  }
  for (const otherRoot of otherRoots) {
    const other = canonical(otherRoot)
    if (!equal(root, other) && (inside(root, other) || inside(other, root))) {
      throw new Error('This vault overlaps another open vault. Close the other vault before deleting it.')
    }
  }

  const manifestPath = path.join(root, MANIFEST)
  if (!fs.lstatSync(manifestPath).isFile()) throw new Error('The vault identity file is not a regular file.')
  noLinks(manifestPath)
  let manifest: VaultManifest
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as VaultManifest }
  catch { throw new Error('The vault identity file is unreadable. Nothing was deleted.') }
  const expected = vault.manifest
  if (manifest.format !== 'photos-vault' || manifest.version !== 1 ||
      manifest.id !== expected.id || manifest.name !== expected.name || manifest.createdAt !== expected.createdAt) {
    throw new Error('The vault identity changed since it was opened. Nothing was deleted.')
  }

  const expectedDb = path.join(root, vault.layout.kind === 'album' ? '.vault/library.db' : 'library.db')
  if (!equal(canonical(vault.layout.db), expectedDb) || !equal(canonical(vault.db.name), expectedDb)) {
    throw new Error('The open database does not belong to this vault folder.')
  }
  if (!fs.lstatSync(expectedDb).isFile()) throw new Error('The vault database is not a regular file.')
  const database = fs.openSync(expectedDb, 'r')
  try {
    const header = Buffer.alloc(16)
    if (fs.readSync(database, header, 0, header.length, 0) !== header.length || header.toString('binary') !== 'SQLite format 3\0') {
      throw new Error('The vault database is no longer a valid SQLite file.')
    }
  } finally { fs.closeSync(database) }
  for (const location of [vault.layout.cache, vault.layout.media]) {
    if (!inside(root, canonical(location))) throw new Error('A vault data directory is outside the vault folder.')
  }

  // A recursive delete must not encounter a junction to another folder. Never
  // follow one while counting or validating files, even if it points inward.
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    for (const name of fs.readdirSync(directory)) {
      const entry = path.join(directory, name)
      const stat = fs.lstatSync(entry)
      if (stat.isSymbolicLink()) throw new Error(`The vault contains a symbolic link or junction: ${entry}`)
      if (stat.isDirectory()) pending.push(entry)
      else if (!stat.isFile()) throw new Error(`The vault contains an unsupported filesystem object: ${entry}`)
    }
  }
  const final = fs.lstatSync(root)
  if (initial.dev !== final.dev || initial.ino !== final.ino || !final.isDirectory() || final.isSymbolicLink()) {
    throw new Error('The vault folder changed during validation. Nothing was deleted.')
  }
  return root
}

/** Logical folder bytes. Links are refused, so this never traverses another tree. */
export async function folderBytes(root: string): Promise<number> {
  const directory = canonical(root)
  if (!(await fs.promises.lstat(directory)).isDirectory()) throw new Error('The vault location is not a directory.')
  const pending = [directory]
  let bytes = 0
  while (pending.length) {
    const current = pending.pop()!
    for (const name of await fs.promises.readdir(current)) {
      const entry = path.join(current, name)
      const stat = await fs.promises.lstat(entry)
      if (stat.isSymbolicLink()) throw new Error('Cannot measure a vault containing symbolic links or junctions.')
      if (stat.isDirectory()) pending.push(entry)
      else if (stat.isFile()) bytes += stat.size
      else throw new Error('Cannot measure an unsupported filesystem object.')
    }
  }
  return bytes
}
