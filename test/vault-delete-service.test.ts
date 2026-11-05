import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GalleryService } from '../app/main/gallery-service.ts'
import { sameVaultName } from '../app/shared/api.ts'
import { createVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'
import { makeHeic } from './helpers.ts'

/**
 * Found in use: deleting a small vault did nothing while a big library was
 * still making thumbnails. Closing the vault waited for every vault's
 * thumbnails, and the error, if any, showed behind the dialog.
 */

// Vault deletion refuses anything under AppData, where the system temp folder is.
let dir: string
let service: GalleryService
let releaseDecodes: (() => void) | null = null
beforeEach(() => {
  fs.mkdirSync(path.resolve('transcripts'), { recursive: true })
  dir = fs.mkdtempSync(path.resolve('transcripts', 'theia-delete-'))
})
afterEach(async () => {
  releaseDecodes?.()
  await service?.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function vaultWith(name: string, photos: number): Promise<string> {
  const v = createVault(path.join(dir, name))
  const items: SaveItem[] = Array.from({ length: photos }, (_, i) => {
    const bytes = makeHeic({ mdatBytes: 500 + i })
    return {
      key: `${name}-${i}`, kind: 'photo', t: Date.UTC(2026, 0, 1, 0, i), off: 0, w: 80, h: 60, dur: null, fav: false, edited: false,
      subtype: null, sourceUuid: `${name}-${i}`, lat: null, lon: null, cloud: false,
      files: [{ name: `IMG_${i}.HEIC`, role: 'master', mime: 'image/heic', size: bytes.length, sha256: null, read: async function* () { yield bytes } }],
    }
  })
  await saveToVault(v, items, [])
  v.db.close()
  return v.layout.root
}

describe('deleting a vault', () => {
  it('does not wait for another vault to finish its thumbnails', async () => {
    const big = await vaultWith('Big', 3)
    const small = await vaultWith('Iphone_16_5-11-26', 1)
    const profile = path.join(dir, 'profile')
    fs.mkdirSync(profile)
    fs.writeFileSync(path.join(profile, 'gallery.json'), JSON.stringify({ vaults: [] }))
    const bin = path.join(dir, 'bin')
    service = new GalleryService({
      userData: profile, publish: () => {}, pickFolder: async () => null, openPath: async () => {}, showInFolder: () => {},
      openExternal: async () => {}, trash: async (f) => fs.renameSync(f, bin),
      recycleBinLimit: async () => ({ maxBytes: 1e12, nukeOnDelete: false }), setBusy: () => {},
    })
    // Decoding never finishes until released: the big library's thumbnails stay busy.
    const stuck = new Promise<never>((_, reject) => { releaseDecodes = () => reject(new Error('released')) })
    stuck.catch(() => {})
    ;(service as unknown as { heic: unknown }).heic = { size: 1, decode: () => stuck, close: async () => {} }
    const bigId = service.openVaultAt(big)
    const smallId = service.openVaultAt(small)
    await new Promise((r) => setTimeout(r, 200))
    expect(service.snapshot().thumbnails).not.toBeNull()

    const deleted = service.deleteVault(smallId, '  iphone_16_5-11-26 ', 'recycle')
    const outcome = await Promise.race([deleted.then(() => 'deleted'), new Promise((r) => setTimeout(() => r('still waiting'), 3000))])

    expect(outcome).toBe('deleted')
    expect(fs.existsSync(small)).toBe(false)
    expect(fs.existsSync(bin)).toBe(true)
    expect(service.snapshot().vaults.map((v) => v.id)).toEqual([bigId])
  })

  it('keeps the vault open in Theia when the Recycle Bin refuses it', async () => {
    const root = await vaultWith('Keep', 1)
    const profile = path.join(dir, 'profile')
    fs.mkdirSync(profile)
    fs.writeFileSync(path.join(profile, 'gallery.json'), JSON.stringify({ vaults: [] }))
    service = new GalleryService({
      userData: profile, publish: () => {}, pickFolder: async () => null, openPath: async () => {}, showInFolder: () => {},
      openExternal: async () => {}, trash: async () => { throw new Error('The file is in use') },
      recycleBinLimit: async () => ({ maxBytes: 1e12, nukeOnDelete: false }), setBusy: () => {},
    })
    const id = service.openVaultAt(root)
    await expect(service.deleteVault(id, 'Keep', 'recycle')).rejects.toThrow('in use')
    expect(fs.existsSync(root)).toBe(true)
    expect(service.snapshot().vaults.map((v) => v.name)).toEqual(['Keep'])
  })
})

describe('the typed vault name', () => {
  it('ignores case and surrounding spaces, but not other differences', () => {
    expect(sameVaultName('Iphone_16_5-11-26', 'Iphone_16_5-11-26')).toBe(true)
    expect(sameVaultName(' iphone_16_5-11-26  ', 'Iphone_16_5-11-26')).toBe(true)
    expect(sameVaultName('Iphone_16_5-11-2', 'Iphone_16_5-11-26')).toBe(false)
    expect(sameVaultName('', '')).toBe(false)
  })
})
