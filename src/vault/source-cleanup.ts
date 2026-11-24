import fs from 'node:fs'
import { sha256Of } from './hash.ts'
import path from 'node:path'
import type { OpenVault } from './vault.ts'
import type { SaveItem } from './save.ts'

/**
 * "Delete the originals once they're in the vault", for photos added from a
 * folder on this computer. Nothing is deleted on trust:
 *
 * 1. The whole item was saved, every file of it (`assets` from the save).
 * 2. The original is the same file that was read: same size, same date.
 * 3. Its bytes, hashed again now, are in the vault, in an item that is not
 *    deleted, as a plain file (a protected copy can't be reread here).
 * 4. That vault file, reread from disk now, still has exactly those bytes.
 * 5. The drive has a Recycle Bin that will keep it: not one set to delete
 *    straight away, and the file not bigger than it takes (Windows deletes
 *    those for good).
 *
 * Then it goes to the Recycle Bin, never further, and only then is it counted
 * as deleted. Anything else stays where it is, with the reason. Files the
 * import didn't take (anything not a photo, video or sidecar) are never
 * looked at. A stopped run deletes nothing more.
 */

export interface SourceCleanupDeps {
  /** Move one file to the Recycle Bin. */
  trash: (file: string) => Promise<void>
  /** The Recycle Bin of the drive holding `dir`, or null when it has none. */
  recycleBin: (dir: string) => Promise<{ maxBytes: number; nukeOnDelete: boolean } | null>
  /** The file about to be checked. */
  progress?: (file: string) => void
  signal?: AbortSignal
}

export interface SourceCleanup {
  /** Originals moved to the Recycle Bin. */
  deleted: number
  /** Originals left where they were. */
  kept: number
  reasons: { item: string; reason: string }[]
}

/** Closed before it returns: the original is moved to the Recycle Bin straight after (see hash.ts). */
const hashFile = (file: string) => sha256Of(file)

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export async function recycleImportedSources(
  vault: OpenVault,
  items: SaveItem[],
  assets: Record<string, number>,
  deps: SourceCleanupDeps,
): Promise<SourceCleanup> {
  const out: SourceCleanup = { deleted: 0, kept: 0, reasons: [] }
  const keep = (file: string, reason: string) => {
    out.kept++
    out.reasons.push({ item: path.basename(file), reason })
  }
  const inVault = vault.db.prepare(
    `SELECT f.path, f.encrypted_path AS encryptedPath FROM file f JOIN asset a ON a.id = f.asset_id
      WHERE f.sha256 = ? AND a.deleted_at IS NULL ORDER BY f.encrypted_path IS NOT NULL LIMIT 1`,
  )
  const bins = new Map<string, Promise<{ maxBytes: number; nukeOnDelete: boolean } | null>>()
  const binFor = (file: string) => {
    const root = path.parse(file).root.toLowerCase()
    if (!bins.has(root)) bins.set(root, deps.recycleBin(path.dirname(file)).catch(() => null))
    return bins.get(root)!
  }
  const vaultRoot = path.resolve(vault.layout.root)

  for (const item of items) {
    const originals = item.files.filter((f) => f.sourcePath)
    if (!originals.length) continue
    if (!assets[item.key]) {
      for (const f of originals) keep(f.sourcePath!, 'Not every file of it was saved, so its originals stay.')
      continue
    }
    for (const f of originals) {
      const file = path.resolve(f.sourcePath!)
      if (deps.signal?.aborted) {
        keep(file, 'Stopped before it was checked.')
        continue
      }
      deps.progress?.(path.basename(file))
      try {
        if (inside(file, vaultRoot)) throw new Error('It is inside the vault itself.')
        const before = fs.statSync(file, { throwIfNoEntry: false })
        if (!before) throw new Error('It is no longer in the folder.')
        if (before.size !== f.size || (f.sourceMtimeMs !== undefined && Math.floor(before.mtimeMs) !== Math.floor(f.sourceMtimeMs))) {
          throw new Error('It changed after Theia read it.')
        }
        const bin = await binFor(file)
        if (!bin || bin.nukeOnDelete) throw new Error('This drive has no Recycle Bin to keep it in, so Theia won’t delete it. Delete it yourself if you’re sure.')
        if (before.size > bin.maxBytes) throw new Error('It is bigger than this drive’s Recycle Bin takes; Windows would delete it for good.')

        const sha = await hashFile(file)
        const copy = inVault.get(sha) as { path: string; encryptedPath: string | null } | undefined
        if (!copy) throw new Error('Its exact bytes are not in the vault.')
        if (copy.encryptedPath) throw new Error('Its copy in the vault is protected, so Theia can’t reread it to check.')
        const stored = path.join(vault.layout.media, ...copy.path.split('/'))
        if (path.resolve(stored).toLowerCase() === file.toLowerCase()) throw new Error('It is the vault’s own copy.')
        if ((await hashFile(stored)) !== sha) throw new Error('The vault’s copy didn’t read back the same.')

        // Last look, straight before it goes.
        const now = fs.statSync(file, { throwIfNoEntry: false })
        if (!now || now.size !== before.size || now.mtimeMs !== before.mtimeMs) throw new Error('It changed while it was being checked.')
        if (deps.signal?.aborted) throw new Error('Stopped before it was moved.')
        await deps.trash(file)
        if (fs.existsSync(file)) throw new Error('Windows didn’t move it to the Recycle Bin.')
        out.deleted++
      } catch (e) {
        keep(file, (e as Error).message)
      }
    }
  }
  return out
}
