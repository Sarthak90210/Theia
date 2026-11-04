import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DeviceSource } from '../device/types.ts'
import type { OpenVault } from '../vault/vault.ts'
import type { DecodeResult } from '../verify/decode.ts'

/**
 * Before Theia deletes anything from the iPhone, each item is checked three
 * times, file by file, and kept on the phone if any check fails:
 *
 *  1. At save: the bytes received from the phone hashed the same as the bytes
 *     written to the vault (the save does this, and records the file as
 *     checksum-verified).
 *  2. Now, from the vault: the vault's copy is read again from disk and still
 *     matches the checksum recorded for it.
 *  3. Now, from the phone: the phone's file is read again, in full, and matches
 *     the vault's copy byte for byte; and it hasn't changed since the save.
 *
 * And every file the phone has for the item (the original, a Live Photo's
 * video, the edited version, the edit recipe) must be among the files checked,
 * so no part of an item is ever left only on the phone.
 */

export interface CheckedFile {
  /** Path on the phone, over AFC. */
  devicePath: string
  name: string
  size: number
  sha256: string
  /** Where its copy is in the vault. */
  vaultPath: string
  destination: string
  sourceMtimeMs: number
}

export type CheckResult = { ok: true; files: CheckedFile[] } | { ok: false; reason: string }

interface VaultRow {
  path: string
  sha256: string
  bytes: number
  verify_level: number
  encrypted_path: string | null
  mime: string
}

async function hashDevice(device: DeviceSource, devicePath: string, signal?: AbortSignal): Promise<{ sha256: string; size: number }> {
  const h = await device.open(devicePath)
  const hash = crypto.createHash('sha256')
  let size = 0
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('stopped')
      const b = await h.read(4 * 1024 * 1024)
      if (!b.length) break
      hash.update(b)
      size += b.length
    }
  } finally {
    await h.close().catch(() => {})
  }
  return { sha256: hash.digest('hex'), size }
}

async function hashLocal(file: string, signal?: AbortSignal): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    if (signal?.aborted) throw new Error('stopped')
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/**
 * Check one item for deletion from the phone. `devicePaths` is every file the
 * phone has for it; `atSave` is each file's size and modification time when
 * it was saved, when known.
 */
export async function checkForDeletion(
  vault: OpenVault,
  assetId: number,
  device: DeviceSource,
  devicePaths: string[],
  atSave: Map<string, { size: number; mtimeMs: number }>,
  signal?: AbortSignal,
  decode?: (file: string, mime: string) => Promise<DecodeResult>,
): Promise<CheckResult> {
  const { db, layout } = vault
  const asset = db.prepare(`SELECT deleted_at, hidden FROM asset WHERE id = ?`).get(assetId) as
    | { deleted_at: number | null; hidden: number }
    | undefined
  if (!asset) return { ok: false, reason: "it isn't in the vault" }
  if (asset.deleted_at !== null) return { ok: false, reason: "it's in the vault's Recently Deleted" }
  const rows = db.prepare(`SELECT path, sha256, bytes, verify_level, encrypted_path, mime FROM file WHERE asset_id = ?`).all(assetId) as VaultRow[]
  if (rows.some((r) => r.encrypted_path)) return { ok: false, reason: "it's hidden in the vault, so its copy can't be re-read without the passcode" }
  if (!devicePaths.length) return { ok: false, reason: 'no files found for it on the phone' }
  if (new Set(devicePaths).size !== devicePaths.length) return { ok: false, reason: 'the source manifest contains a repeated file' }
  const snapshots = new Map<string, fs.Stats>()

  // Check 1: the save verified each file's checksum.
  for (const r of rows) if (r.verify_level < 2 || r.bytes <= 0 || !/^[a-f0-9]{64}$/.test(r.sha256)) return { ok: false, reason: `${path.posix.basename(r.path)} was never fully verified in the vault` }

  // Check 2: the vault's copies, read again from disk.
  for (const r of rows) {
    if (signal?.aborted) return { ok: false, reason: 'stopped' }
    const abs = safeSavedPath(layout.media, r.path)
    let st: fs.Stats
    try {
      st = fs.statSync(abs)
    } catch {
      return { ok: false, reason: `${path.posix.basename(r.path)} is missing from the vault` }
    }
    if (st.size !== r.bytes) return { ok: false, reason: `${path.posix.basename(r.path)} in the vault is not the size it was saved at` }
    if ((await hashLocal(abs, signal)) !== r.sha256) return { ok: false, reason: `${path.posix.basename(r.path)} in the vault no longer matches its checksum` }
    snapshots.set(r.path, st)
  }

  // Check 3: each file on the phone, read again in full, matches a vault copy.
  const unused = [...rows]
  const files: CheckedFile[] = []
  for (const p of devicePaths) {
    if (signal?.aborted) return { ok: false, reason: 'stopped' }
    const name = path.posix.basename(p)
    let st
    try {
      st = await device.stat(p)
    } catch (e) {
      return { ok: false, reason: `couldn't read ${name} on the phone (${(e as Error).message})` }
    }
    const before = atSave.get(p)
    if (!before) return { ok: false, reason: `${name} has no source identity recorded from the save` }
    if (st.isDirectory || st.size <= 0 || before.size !== st.size || before.mtimeMs !== st.mtimeMs) {
      return { ok: false, reason: `${name} changed on the phone after it was saved` }
    }
    let got
    try {
      got = await hashDevice(device, p, signal)
    } catch (e) {
      return { ok: false, reason: `couldn't re-read ${name} from the phone (${(e as Error).message})` }
    }
    if (got.size !== st.size) return { ok: false, reason: `${name} read back a different size from the phone` }
    const after = await device.stat(p)
    if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) return { ok: false, reason: `${name} changed while it was being checked` }
    const i = unused.findIndex((r) => r.sha256 === got.sha256 && r.bytes === got.size)
    if (i < 0) return { ok: false, reason: `${name} on the phone doesn't match any copy in the vault` }
    const [row] = unused.splice(i, 1)
    const destination = safeSavedPath(layout.media, row!.path)
    if (decode) {
      const decoded = await decode(destination, row!.mime)
      if (decoded.status !== 'ok') return { ok: false, reason: `${name} could not be fully decoded: ${decoded.detail ?? decoded.status}` }
    }
    const savedBefore = snapshots.get(row!.path)!
    const savedAfter = fs.statSync(destination)
    if (savedAfter.size !== savedBefore.size || savedAfter.mtimeMs !== savedBefore.mtimeMs || savedAfter.ino !== savedBefore.ino ||
        await hashLocal(destination, signal) !== got.sha256) return { ok: false, reason: `${name} changed in the vault while it was being checked` }
    files.push({ devicePath: p, name, size: got.size, sha256: got.sha256, vaultPath: row!.path, destination, sourceMtimeMs: st.mtimeMs })
  }
  if (unused.length) return { ok: false, reason: 'the source and saved file manifests do not match completely' }
  if (signal?.aborted) return { ok: false, reason: 'stopped' }
  return { ok: true, files }
}

/** Never read or authorize deletion against a path outside this vault. */
function safeSavedPath(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe saved file path.')
  const absoluteRoot = fs.realpathSync(root)
  let current = absoluteRoot
  for (const part of relative.split(/[\\/]/)) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('A saved copy is a symbolic link or junction.')
  }
  const resolved = fs.realpathSync(current)
  if (!resolved.startsWith(absoluteRoot + path.sep)) throw new Error('A saved copy escaped the vault.')
  return resolved
}

/** One line per deleted file, appended to the vault's clean-up log, so there is always a record. */
export function logDeletion(logFile: string, entry: { at: string; phone: string; item: string; files: CheckedFile[] }): void {
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const fd = fs.openSync(logFile, 'a')
  try { fs.writeSync(fd, `${JSON.stringify(entry)}\n`); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
