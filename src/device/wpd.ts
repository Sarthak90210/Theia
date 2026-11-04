import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Windows Portable Devices objects, never AFC filesystem deletion. */
export interface PhoneObject {
  objectId: string
  persistentId: string
  name: string
  bytes: number
  path: string
  canDelete: boolean
}

export interface WpdInventory {
  deviceId: string
  serial: string
  deleteSupported: boolean
  objects: PhoneObject[]
}

export interface VerifiedWpdFile {
  object: PhoneObject
  bytes: number
  sha256: string
  /** The exact plaintext backup; held read-only and write/delete-locked during deletion. */
  destination: string
}

export function normalizePhoneIdentity(value: string): string {
  const clean = value.trim().toLowerCase().replaceAll('-', '')
  if (!/^(?:[a-f0-9]{24}|[a-f0-9]{40})$/.test(clean)) throw new Error('The iPhone identifier is not a recognized UDID.')
  return clean
}

export function validatePhoneObject(value: PhoneObject): void {
  if (!value || !value.objectId || !value.persistentId || !value.name || !value.path ||
      !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || typeof value.canDelete !== 'boolean' ||
      value.path.includes('\0')) throw new Error('Windows did not provide an unambiguous file identity.')
}

function helperDirectory(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.join(here, 'wpd'), path.resolve(here, '../../.release-tools/wpd')]
  const found = candidates.find(dir => fs.existsSync(path.join(dir, 'MediaDevices.dll')) && fs.existsSync(path.join(dir, 'wpd-helper.ps1')))
  if (!found) throw new Error('The Windows photo helper is missing. Rebuild or reinstall Theia before deleting from an iPhone.')
  return found
}

async function run<T>(request: object, signal?: AbortSignal, timeout = 600_000): Promise<T> {
  if (process.platform !== 'win32') throw new Error('Deleting iPhone photos requires Windows Portable Devices.')
  signal?.throwIfAborted()
  const helper = path.join(helperDirectory(), 'wpd-helper.ps1')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theia-wpd-'))
  const requestPath = path.join(dir, 'request.json')
  const cancelPath = path.join(dir, 'cancel')
  fs.writeFileSync(requestPath, JSON.stringify({ ...request, cancelPath }), 'utf8')
  const abort = () => { try { fs.writeFileSync(cancelPath, '') } catch { /* process has already finished */ } }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    return await new Promise<T>((resolve, reject) => {
      execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', helper, requestPath],
        { windowsHide: true, signal, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
          if (error) return reject(new Error(signal?.aborted ? 'Stopped. Any delete already accepted by Windows may have completed.' :
            `Windows photo verification failed: ${stderr.trim() || error.message}`))
          try {
            const result = JSON.parse(stdout.trim()) as T & { error?: string }
            if (result.error) reject(new Error(result.error))
            else resolve(result)
          } catch { reject(new Error('Windows returned an unreadable photo-verification result. No deletion will be retried automatically.')) }
        })
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    // This is the exact temporary directory created above, not a source or vault path.
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Enumerates only the device whose serial/PNP instance exactly identifies the AFC phone. */
export async function wpdInventory(udid: string, names: string[], signal?: AbortSignal): Promise<WpdInventory> {
  const identity = normalizePhoneIdentity(udid)
  if (!names.length || names.some(name => !name || /[\\/\0]/.test(name))) throw new Error('Choose specific iPhone filenames to verify.')
  const result = await run<WpdInventory>({ op: 'inventory', udid: identity, names: [...new Set(names)] }, signal)
  if (!result.deviceId || !result.serial || !Array.isArray(result.objects) || typeof result.deleteSupported !== 'boolean') {
    throw new Error('Windows could not establish the selected iPhone identity.')
  }
  for (const object of result.objects) validatePhoneObject(object)
  return result
}

/** Hashes the driver's actual representation; a transcoded representation will fail the later match. */
export async function wpdHashObject(udid: string, object: PhoneObject, signal?: AbortSignal): Promise<{ object: PhoneObject; bytes: number; sha256: string }> {
  const identity = normalizePhoneIdentity(udid)
  validatePhoneObject(object)
  const result = await run<{ object: PhoneObject; bytes: number; sha256: string }>({ op: 'hash', udid: identity, object }, signal)
  validatePhoneObject(result.object)
  if (!/^[a-f0-9]{64}$/.test(result.sha256) || result.bytes !== object.bytes ||
      result.object.objectId !== object.objectId || result.object.persistentId !== object.persistentId) {
    throw new Error('The Windows photo object changed while it was verified.')
  }
  return result
}

/**
 * Locks every backup and verifies every WPD resource before deleting any member.
 * There are no retries, recursive deletes, display-name device matches or AFC writes.
 */
export async function wpdDeleteVerified(udid: string, files: VerifiedWpdFile[], signal?: AbortSignal): Promise<{ deleted: Set<string>; failed: Map<string, string> }> {
  const identity = normalizePhoneIdentity(udid)
  if (!files.length) throw new Error('There are no verified iPhone files to delete.')
  const ids = new Set<string>()
  for (const file of files) {
    validatePhoneObject(file.object)
    if (!file.object.canDelete || file.bytes !== file.object.bytes || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !path.isAbsolute(file.destination) || ids.has(file.object.objectId)) throw new Error('The delete request is incomplete or ambiguous.')
    ids.add(file.object.objectId)
  }
  const result = await run<{ deleted: string[]; failed: { objectId: string; reason: string }[] }>({ op: 'delete', udid: identity, files }, signal)
  if (!Array.isArray(result.deleted) || !Array.isArray(result.failed) || result.deleted.some(id => !ids.has(id))) {
    throw new Error('Windows did not confirm which iPhone files were removed. Nothing will be retried automatically.')
  }
  const deleted = new Set(result.deleted)
  const failed = new Map(result.failed.map(f => [f.objectId, f.reason]))
  for (const id of ids) if (!deleted.has(id) && !failed.has(id)) failed.set(id, 'Windows did not confirm deletion.')
  return { deleted, failed }
}

/** Loads the pinned managed library and hashing code without accessing a phone. */
export async function wpdHelperSelfTest(): Promise<{ ok: boolean; version: string; sha256: string }> {
  return run({ op: 'self-test' })
}
