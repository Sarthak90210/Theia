import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDevice } from '../src/device/fake-device.ts'
import { PhoneSession } from '../src/gallery/phone-session.ts'
import { toAppleSeconds } from '../src/gallery/phone-library.ts'
import { phoneSaveItems, vaultSaveAlbums, vaultSaveItems } from '../src/gallery/save-sources.ts'
import { displayFile, vaultFiles, vaultItems } from '../src/gallery/vault-gallery.ts'
import { keepBurstFrame, setBurstCover } from '../src/vault/burst.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'
import { createVault, openVault, type OpenVault } from '../src/vault/vault.ts'
import { scratch, type Scratch } from './helpers.ts'

let s: Scratch
const vaults: OpenVault[] = []
const sessions: PhoneSession[] = []
const captureTime = Date.UTC(2026, 5, 8, 13, 4)
beforeEach(() => { s = scratch() })
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
  for (const vault of vaults.splice(0)) vault.db.close()
  s.cleanup()
})

function vault(name: string) {
  const v = createVault(path.join(s.dir, name))
  vaults.push(v)
  return v
}

async function images() {
  return Promise.all(['#c33', '#3c3', '#33c'].map(background =>
    sharp({ create: { width: 40, height: 30, channels: 3, background } }).jpeg().toBuffer()))
}

async function saveBurst(v: OpenVault) {
  const files = (await images()).map((bytes, i) => ({
    name: `IMG_000${i + 1}.JPG`, role: 'master' as const, mime: 'image/jpeg', size: bytes.length, sha256: null,
    read: async function* () { yield bytes },
  }))
  const item: SaveItem = {
    key: 'burst', kind: 'burst', t: captureTime, off: 19800, w: 40, h: 30, dur: null, fav: true, edited: false,
    subtype: null, sourceUuid: 'source-burst', lat: 12.9, lon: 77.6, cloud: false, files,
  }
  const saved = await saveToVault(v, [item], [{ uuid: 'trip', name: 'Trip', keys: [item.key] }])
  return String(saved.newAssets[0]!)
}

function fileBytes(v: OpenVault, key: string) {
  return vaultFiles(v.db, key).map(f => ({
    name: path.basename(f.path), sha: f.sha256, bytes: fs.readFileSync(path.join(v.layout.media, ...f.path.split('/'))),
  })).sort((a, b) => a.name.localeCompare(b.name))
}

describe('saving burst originals between vaults', () => {
  it('compares repeated frame bytes by their counts when identifying duplicate bursts', async () => {
    const source = vault('Source')
    const key = await saveBurst(source)
    const [base] = vaultSaveItems(source.db, source.layout.media, [key])
    const [a, b] = (await images())
    const group = (uuid: string, bytes: Buffer[]): SaveItem => ({ ...base!, key: uuid, sourceUuid: uuid,
      files: bytes.map((data, i) => ({ name: `${uuid}-${i}.JPG`, role: 'master', mime: 'image/jpeg', size: data.length, sha256: null,
        read: async function* () { yield data } })) })
    const target = vault('Target')
    await saveToVault(target, [group('aab', [a!, a!, b!])], [])
    const different = await saveToVault(target, [group('abb', [a!, b!, b!])], [])
    expect(different.saved).toBe(1)
    expect(vaultItems(target.db, 'library')).toHaveLength(2)
    const repeat = await saveToVault(target, [group('same-abb', [a!, b!, b!])], [])
    expect(repeat.newAssets).toEqual([])
    expect(vaultItems(target.db, 'library')).toHaveLength(2)
  })
  it('retains every original and the selected cover through saving and reopening', async () => {
    const source = vault('Source')
    const key = await saveBurst(source)
    const selected = vaultFiles(source.db, key).find(f => f.path.endsWith('IMG_0003.JPG'))!
    setBurstCover(source.db, Number(key), selected.id)
    const target = vault('Target')
    const saved = await saveToVault(target, vaultSaveItems(source.db, source.layout.media, [key]), vaultSaveAlbums(source.db))
    const targetKey = String(saved.newAssets[0]!)
    expect(saved.failed).toEqual([])
    expect(fileBytes(target, targetKey)).toEqual(fileBytes(source, key))
    expect(vaultFiles(target.db, targetKey).map(f => f.role)).toEqual(['master', 'master', 'master'])
    expect(displayFile(vaultFiles(target.db, targetKey), null)?.path).toMatch(/IMG_0003\.JPG$/)
    expect(vaultItems(target.db, 'album:1')).toHaveLength(1)
    const reopened = openVault(target.layout.root)
    vaults.push(reopened)
    expect(vaultItems(reopened.db, 'library')[0]).toMatchObject({ kind: 'burst', frames: 3 })
    expect(displayFile(vaultFiles(reopened.db, targetKey), null)?.path).toMatch(/IMG_0003\.JPG$/)
  })

  it('retains all bytes and album membership when a frame is split and both items are saved', async () => {
    const source = vault('Source')
    const key = await saveBurst(source)
    const before = fileBytes(source, key)
    const second = vaultFiles(source.db, key).find(f => f.path.endsWith('IMG_0002.JPG'))!
    const kept = String(keepBurstFrame(source.db, Number(key), second.id))
    const target = vault('Target')
    const saved = await saveToVault(target, vaultSaveItems(source.db, source.layout.media, [key, kept]), vaultSaveAlbums(source.db))
    expect(saved.saved).toBe(2)
    expect(saved.failed).toEqual([])
    const got = saved.newAssets.flatMap(id => fileBytes(target, String(id))).sort((a, b) => a.name.localeCompare(b.name))
    expect(got).toEqual(before)
    expect(vaultItems(target.db, 'album:1').map(i => i.kind).sort()).toEqual(['burst', 'photo'])
    expect(vaultItems(target.db, 'library').find(i => i.kind === 'burst')?.frames).toBe(2)
  })

  it('rejects a real frame belonging to a different item without mutating either item', async () => {
    const v = vault('Source')
    const key = await saveBurst(v)
    const files = vaultFiles(v.db, key)
    const kept = String(keepBurstFrame(v.db, Number(key), files[1]!.id))
    const foreign = vaultFiles(v.db, kept)[0]!
    const before = vaultFiles(v.db, key)
    expect(() => setBurstCover(v.db, Number(key), foreign.id)).toThrow('not part of this burst')
    expect(() => keepBurstFrame(v.db, Number(key), foreign.id)).toThrow('not part of this burst')
    expect(vaultFiles(v.db, key)).toEqual(before)
    expect(vaultFiles(v.db, kept)).toEqual([foreign])
  })
})

async function phoneBurst() {
  fs.mkdirSync(path.join(s.deviceRoot, 'PhotoData'), { recursive: true })
  fs.mkdirSync(path.join(s.deviceRoot, 'DCIM', '100APPLE'), { recursive: true })
  const db = new Database(path.join(s.deviceRoot, 'PhotoData', 'Photos.sqlite'))
  db.exec(`CREATE TABLE ZASSET (Z_PK INTEGER PRIMARY KEY, ZUUID TEXT, ZDIRECTORY TEXT, ZFILENAME TEXT,
    ZDATECREATED REAL, ZKIND INTEGER, ZVISIBILITYSTATE INTEGER, ZWIDTH INTEGER, ZHEIGHT INTEGER, ZAVALANCHEUUID TEXT)`)
  const add = db.prepare(`INSERT INTO ZASSET VALUES (?, ?, 'DCIM/100APPLE', ?, ?, 0, ?, 40, 30, 'burst-uuid')`)
  const bytes = await images()
  for (let i = 1; i <= 3; i++) {
    const name = `IMG_000${i}.JPG`
    add.run(i, `U${i}`, name, toAppleSeconds(captureTime + i * 100), i === 2 ? 0 : 1)
    fs.writeFileSync(path.join(s.deviceRoot, 'DCIM', '100APPLE', name), bytes[i - 1]!)
  }
  db.close()
  const device = new FakeDevice({ root: s.deviceRoot })
  const session = await PhoneSession.open({ device, udid: 'phone', name: 'Phone', cacheRoot: path.join(s.dir, 'cache'),
    heic: { decode: async () => { throw new Error('JPEG fixture must not need HEIC') } } })
  sessions.push(session)
  return { session, device, bytes }
}

describe('saving bursts from a phone', () => {
  it('reports an unavailable original rather than silently saving an incomplete burst', async () => {
    const { session, device } = await phoneBurst()
    session.library.byKey.get('U3')!.cloud = true
    await expect(phoneSaveItems(session, device, ['U2'])).rejects.toThrow('Some burst frames are unavailable')
    expect((await phoneSaveItems(session, device, ['U2'], true))[0]?.kind).toBe('photo')
  })
  it('copies all frames when only the cover is visible in the phone library', async () => {
    const { session, device, bytes } = await phoneBurst()
    expect(session.items('library').map(i => i.key)).toEqual(['U2'])
    const items = await phoneSaveItems(session, device, ['U2'])
    expect(items[0]?.files.map(f => [f.name, f.role])).toEqual([
      ['IMG_0002.JPG', 'master'], ['IMG_0001.JPG', 'master'], ['IMG_0003.JPG', 'master'],
    ])
    const v = vault('Saved')
    const result = await saveToVault(v, items, [])
    const key = String(result.newAssets[0]!)
    expect(result.failed).toEqual([])
    expect(vaultItems(v.db, 'library')[0]).toMatchObject({ kind: 'burst', frames: 3 })
    expect(displayFile(vaultFiles(v.db, key), null)?.path).toMatch(/IMG_0002\.JPG$/)
    expect(fileBytes(v, key).map(f => f.bytes)).toEqual(bytes)
  })

  it('saves only the requested frame as a photo when the single-frame action is used', async () => {
    const { session, device, bytes } = await phoneBurst()
    const [item] = await phoneSaveItems(session, device, ['U3'], true)
    expect(item).toMatchObject({ kind: 'photo', sourceUuid: 'U3:frame' })
    expect(item?.files.map(f => f.name)).toEqual(['IMG_0003.JPG'])
    const v = vault('Saved')
    const result = await saveToVault(v, [item!], [])
    expect(vaultItems(v.db, 'library')[0]?.kind).toBe('photo')
    expect(fileBytes(v, String(result.newAssets[0]!))[0]?.bytes).toEqual(bytes[2])
  })

  it('keeps the full burst when its cover was already saved as a standalone photo', async () => {
    const { session, device, bytes } = await phoneBurst()
    const v = vault('Saved')
    await saveToVault(v, await phoneSaveItems(session, device, ['U2'], true), [])
    const result = await saveToVault(v, await phoneSaveItems(session, device, ['U2']), [])
    expect(result.failed).toEqual([])
    const burst = vaultItems(v.db, 'library').find(i => i.kind === 'burst')
    expect(burst?.frames).toBe(3)
    expect(fileBytes(v, burst!.key).map(f => f.bytes)).toEqual(bytes)
  })

  it('saves a standalone frame even when those bytes already belong to a saved burst', async () => {
    const { session, device, bytes } = await phoneBurst()
    const v = vault('Saved')
    await saveToVault(v, await phoneSaveItems(session, device, ['U2']), [])
    const result = await saveToVault(v, await phoneSaveItems(session, device, ['U2'], true), [])
    expect(result.failed).toEqual([])
    const photo = vaultItems(v.db, 'library').find(i => i.kind === 'photo')
    expect(photo).toBeDefined()
    expect(vaultItems(v.db, 'library').find(i => i.kind === 'burst')?.frames).toBe(3)
    expect(fileBytes(v, photo!.key)).toHaveLength(1)
    expect(fileBytes(v, photo!.key)[0]?.bytes).toEqual(bytes[1])
  })
})
