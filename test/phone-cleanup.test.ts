import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDevice } from '../src/device/fake-device.ts'
import { checkForDeletion } from '../src/gallery/phone-cleanup.ts'
import { createVault, type OpenVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'
import { putOnDevice, scratch, type Scratch } from './helpers.ts'

let s: Scratch
let v: OpenVault
let device: FakeDevice
beforeEach(() => {
  s = scratch()
  v = createVault(path.join(s.dir, 'V'))
  device = new FakeDevice({ root: s.deviceRoot })
})
afterEach(() => {
  v.db.close()
  s.cleanup()
})

async function savedFromPhone() {
  const jpg = await sharp({ create: { width: 50, height: 40, channels: 3, background: '#3a6' } }).jpeg().toBuffer()
  const aae = Buffer.from('<?xml version="1.0"?><plist><dict/></plist>')
  const photo = putOnDevice(s, 'IMG_0001.JPG', jpg)
  const recipe = putOnDevice(s, 'IMG_0001.AAE', aae)
  const paths = [photo, recipe]
  const atSave = new Map<string, { size: number; mtimeMs: number }>()
  for (const p of paths) {
    const st = await device.stat(p)
    atSave.set(p, { size: st.size, mtimeMs: st.mtimeMs })
  }
  const read = (p: string) =>
    async function* () {
      const h = await device.open(p)
      for (;;) {
        const b = await h.read(65536)
        if (!b.length) break
        yield b
      }
      await h.close()
    }
  const item: SaveItem = {
    key: 'U1', kind: 'photo', t: Date.UTC(2026, 3, 1), off: 0, w: 50, h: 40, dur: null, fav: false, edited: false, subtype: null,
    sourceUuid: 'U1', lat: null, lon: null, cloud: false,
    files: [
      { name: 'IMG_0001.JPG', role: 'master', mime: 'image/jpeg', size: jpg.length, sha256: null, read: read(photo) },
      { name: 'IMG_0001.AAE', role: 'sidecar', mime: 'application/xml', size: aae.length, sha256: null, read: read(recipe) },
    ],
  }
  const r = await saveToVault(v, [item], [])
  return { assetId: r.assets.U1!, paths, atSave, photo, recipe }
}

describe('checking an item three times before it may leave the phone', () => {
  it('passes when every file is in the vault, unchanged on both sides', async () => {
    const { assetId, paths, atSave } = await savedFromPhone()
    expect(assetId).toBeTypeOf('number')
    const r = await checkForDeletion(v, assetId, device, paths, atSave)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.files.map((f) => f.name).sort()).toEqual(['IMG_0001.AAE', 'IMG_0001.JPG'])
  })

  it("keeps it on the phone if the vault's copy no longer matches", async () => {
    const { assetId, paths, atSave } = await savedFromPhone()
    const row = v.db.prepare(`SELECT path FROM file WHERE asset_id = ? AND role = 'master'`).get(assetId) as { path: string }
    const abs = path.join(v.layout.media, ...row.path.split('/'))
    const b = fs.readFileSync(abs)
    b[b.length - 10]! ^= 0xff
    fs.writeFileSync(abs, b)
    const r = await checkForDeletion(v, assetId, device, paths, atSave)
    expect(r).toMatchObject({ ok: false })
    if (!r.ok) expect(r.reason).toMatch(/no longer matches its checksum/)
  })

  it('keeps it if the phone file changed since the save', async () => {
    const { assetId, paths, atSave, photo } = await savedFromPhone()
    const local = path.join(s.deviceRoot, ...photo.split('/').filter(Boolean))
    const t = new Date(Date.now() + 60_000)
    fs.utimesSync(local, t, t)
    const r = await checkForDeletion(v, assetId, device, paths, atSave)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/changed on the phone after it was saved/)
  })

  it("keeps it if the phone has a file the vault doesn't (a Live Photo's video, say)", async () => {
    const { assetId, paths, atSave } = await savedFromPhone()
    const extra = putOnDevice(s, 'IMG_0001.MOV', Buffer.alloc(500, 3))
    const r = await checkForDeletion(v, assetId, device, [...paths, extra], atSave)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/IMG_0001\.MOV.*(doesn't match any copy|no source identity)/)
  })

  it('keeps it if the phone file reads back different bytes', async () => {
    const { assetId, paths, recipe } = await savedFromPhone()
    fs.writeFileSync(path.join(s.deviceRoot, ...recipe.split('/').filter(Boolean)), Buffer.from('<?xml version="1.0"?><plist><dict>x</dict></plist>'))
    // No record from the save, so only the bytes can tell.
    const r = await checkForDeletion(v, assetId, device, paths, new Map())
    expect(r.ok).toBe(false)
  })

  it('keeps it if the item was deleted or hidden in the vault meanwhile', async () => {
    const { assetId, paths, atSave } = await savedFromPhone()
    v.db.prepare(`UPDATE asset SET deleted_at = 1 WHERE id = ?`).run(assetId)
    expect((await checkForDeletion(v, assetId, device, paths, atSave)).ok).toBe(false)
  })
})
