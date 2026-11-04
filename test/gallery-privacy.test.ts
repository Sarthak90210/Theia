import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GalleryService } from '../app/main/gallery-service.ts'
import { createVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'
import { makeVideo, scratch, type Scratch } from './helpers.ts'

let s: Scratch
let service: GalleryService
let id: string
let itemKey: string
let vaultRoot: string
let originalPath: string
let original: Buffer
const passcode = 'fixture passcode 123'

beforeEach(async () => {
  s = scratch()
  const profile = path.join(s.dir, 'profile')
  fs.mkdirSync(profile)
  fs.writeFileSync(path.join(profile, 'gallery.json'), JSON.stringify({ vaults: [] }))
  const vault = createVault(path.join(s.dir, 'Vault'))
  vaultRoot = vault.layout.root
  original = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#247d9a' } }).jpeg().toBuffer()
  const item: SaveItem = {
    key: 'fixture', kind: 'photo', t: Date.UTC(2026, 0, 1), off: 0, w: 80, h: 60, dur: null,
    fav: false, edited: false, subtype: null, sourceUuid: 'privacy-fixture', lat: null, lon: null, cloud: false,
    files: [{ name: 'IMG_0001.JPG', role: 'master', mime: 'image/jpeg', size: original.length, sha256: null,
      read: async function* () { yield original } }],
  }
  const saved = await saveToVault(vault, [item], [])
  itemKey = String(saved.newAssets[0]!)
  const file = vault.db.prepare('SELECT path FROM file WHERE asset_id = ?').get(Number(itemKey)) as { path: string }
  originalPath = path.join(vault.layout.media, ...file.path.split('/'))
  vault.db.close()
  service = new GalleryService({
    userData: profile,
    publish: () => {},
    pickFolder: async () => null,
    openPath: async () => {},
    showInFolder: () => {},
    openExternal: async () => {},
    trash: async () => { throw new Error('No files may be recycled by this fixture.') },
    recycleBinLimit: async () => null,
    setBusy: () => {},
  })
  // Do not start discovery: this test must never touch a connected phone or
  // the normal app profile. Only this generated vault is opened.
  id = service.openVaultAt(vaultRoot)
})

afterEach(async () => {
  await service.stop()
  s.cleanup()
})

const info = () => service.snapshot().vaults.find(vault => vault.id === id)!

describe('gallery privacy integration', () => {
  it('requires protection before hiding or deleting and keeps the original untouched', async () => {
    await expect(service.setHidden(id, [itemKey], true)).rejects.toThrow('PROTECTION_NEEDED')
    await expect(service.remove(id, [itemKey])).rejects.toThrow('PROTECTION_NEEDED')
    expect(info().protection).toBe('off')
    expect((await service.items(id, 'library')).map(item => item.key)).toContain(itemKey)
    expect(fs.readFileSync(originalPath)).toEqual(original)
  })

  it('serves decrypted images only while unlocked and permanently revokes old byte readers after locking', async () => {
    const recovery = await service.setUpProtection(id, passcode)
    await service.setHidden(id, [itemKey], true)
    expect(fs.existsSync(originalPath)).toBe(false)
    expect(info().protectionError).toBeNull()
    const full = await service.media(id, 'full', itemKey)
    expect(full && 'source' in full).toBe(true)
    if (!full || !('source' in full)) throw new Error('Protected image did not expose an in-memory byte source.')
    const bytes = await full.source.read(0, full.source.size)
    expect((await sharp(bytes).metadata())).toMatchObject({ width: 80, height: 60 })
    const thumbnail = await service.media(id, 'sm', itemKey)
    expect(thumbnail && 'source' in thumbnail).toBe(true)
    service.lockVault(id)
    expect(info().protection).toBe('locked')
    await expect(full.source.read(0, 1)).rejects.toThrow('locked')
    if (thumbnail && 'source' in thumbnail) await expect(thumbnail.source.read(0, 1)).rejects.toThrow('locked')
    expect(await service.media(id, 'full', itemKey)).toBeNull()
    await expect(service.unlockVault(id, 'incorrect')).rejects.toThrow()
    expect(info().protection).toBe('locked')
    await service.unlockVault(id, recovery)
    expect(info().protection).toBe('unlocked')
    // An old request must not become usable again after a later unlock.
    await expect(full.source.read(0, 1)).rejects.toThrow('locked')
    expect(await service.media(id, 'full', itemKey)).not.toBeNull()
  })

  it.each(['missing', 'tampered'] as const)('reports a %s plaintext copy as a protection failure', async failure => {
    await service.setUpProtection(id, passcode)
    if (failure === 'missing') fs.rmSync(originalPath)
    else {
      const changed = Buffer.from(original)
      changed[changed.length - 10]! ^= 0xff
      fs.writeFileSync(originalPath, changed)
    }
    const before = fs.existsSync(originalPath) ? fs.readFileSync(originalPath) : null
    await expect(service.setHidden(id, [itemKey], true)).rejects.toThrow(/Could not encrypt/)
    expect(info().protectionError).toMatch(/Could not encrypt/)
    expect(info().protectionError).toMatch(failure === 'missing' ? /missing/ : /no longer matches/)
    expect(fs.existsSync(originalPath) ? fs.readFileSync(originalPath) : null).toEqual(before)
  })

  it('revokes an already-open Live Photo motion reader on lock and close', async () => {
    const motionVault = createVault(path.join(s.dir, 'Motion Vault'))
    const still = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#9a7424' } }).jpeg().toBuffer()
    const motion = makeVideo()
    const saved = await saveToVault(motionVault, [{
      key: 'live', kind: 'live', t: 1, off: 0, w: 80, h: 60, dur: null, fav: false, edited: false,
      subtype: null, sourceUuid: 'motion-fixture', lat: null, lon: null, cloud: false,
      files: [
        { name: 'IMG_LIVE.JPG', role: 'master', mime: 'image/jpeg', size: still.length, sha256: null,
          read: async function* () { yield still } },
        { name: 'IMG_LIVE.MOV', role: 'motion', mime: 'video/quicktime', size: motion.length, sha256: null,
          read: async function* () { yield motion } },
      ],
    }], [])
    const liveKey = String(saved.newAssets[0]!)
    motionVault.db.close()
    const motionId = service.openVaultAt(motionVault.layout.root)
    await service.setUpProtection(motionId, passcode)
    await service.setHidden(motionId, [liveKey], true)
    const resource = await service.media(motionId, 'motion', liveKey)
    if (!resource || !('source' in resource)) throw new Error('Protected motion reader missing.')
    expect(await resource.source.read(13, 101)).toEqual(motion.subarray(13, 114))
    expect(await resource.source.read(0, resource.source.size)).toEqual(motion)
    service.lockVault(motionId)
    await expect(resource.source.read(0, 16)).rejects.toThrow('locked')
    await service.unlockVault(motionId, passcode)
    await expect(resource.source.read(0, 16)).rejects.toThrow('locked')
    const fresh = await service.media(motionId, 'motion', liveKey)
    if (!fresh || !('source' in fresh)) throw new Error('Fresh protected motion reader missing.')
    await service.closeVault(motionId)
    await expect(fresh.source.read(0, 16)).rejects.toThrow('locked')
  })

  it('waits for encryption before closing the vault, then reopens its ciphertext locked', async () => {
    await service.setUpProtection(id, passcode)
    const hiding = service.setHidden(id, [itemKey], true)
    const closing = service.closeVault(id)
    await Promise.all([hiding, closing])
    expect(service.snapshot().vaults).toEqual([])
    expect(fs.existsSync(originalPath)).toBe(false)
    id = service.openVaultAt(vaultRoot)
    expect(info().protection).toBe('locked')
    expect(await service.media(id, 'full', itemKey)).toBeNull()
    await service.unlockVault(id, passcode)
    const result = await service.media(id, 'full', itemKey)
    expect(result && 'source' in result).toBe(true)
  })
})
