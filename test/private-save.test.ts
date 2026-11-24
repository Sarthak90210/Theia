import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDevice } from '../src/device/fake-device.ts'
import { PhoneSession } from '../src/gallery/phone-session.ts'
import { toAppleSeconds } from '../src/gallery/phone-library.ts'
import { phoneProbeItems, phoneSaveItems, vaultSaveItems } from '../src/gallery/save-sources.ts'
import { vaultItems } from '../src/gallery/vault-gallery.ts'
import { existingInVault, saveToVault } from '../src/vault/save.ts'
import { privacyWork, protectAsset, readKeyFile, setUpProtection } from '../src/vault/private.ts'
import { publicKeyOf } from '../src/vault/private-crypto.ts'
import { createVault, type OpenVault } from '../src/vault/vault.ts'
import { scratch, type Scratch } from './helpers.ts'

/** The phone's Hidden album and Recently Deleted, saved into a vault, stay private there. */

let s: Scratch
const vaults: OpenVault[] = []
const sessions: PhoneSession[] = []
const taken = Date.UTC(2026, 5, 8, 13, 4)
const trashed = Date.UTC(2026, 10, 1, 9, 0)
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

/** U1 in the Library, U2 in the Hidden album, U3 in Recently Deleted. */
async function phone() {
  fs.mkdirSync(path.join(s.deviceRoot, 'PhotoData'), { recursive: true })
  fs.mkdirSync(path.join(s.deviceRoot, 'DCIM', '100APPLE'), { recursive: true })
  const db = new Database(path.join(s.deviceRoot, 'PhotoData', 'Photos.sqlite'))
  db.exec(`CREATE TABLE ZASSET (Z_PK INTEGER PRIMARY KEY, ZUUID TEXT, ZDIRECTORY TEXT, ZFILENAME TEXT,
    ZDATECREATED REAL, ZKIND INTEGER, ZWIDTH INTEGER, ZHEIGHT INTEGER, ZHIDDEN INTEGER, ZTRASHEDSTATE INTEGER, ZTRASHEDDATE REAL)`)
  const add = db.prepare(`INSERT INTO ZASSET VALUES (?, ?, 'DCIM/100APPLE', ?, ?, 0, 40, 30, ?, ?, ?)`)
  const rows: [hidden: number, trashed: number][] = [[0, 0], [1, 0], [0, 1]]
  for (const [i, [hidden, inTrash]] of rows.entries()) {
    const name = `IMG_000${i + 1}.JPG`
    add.run(i + 1, `U${i + 1}`, name, toAppleSeconds(taken + i * 1000), hidden, inTrash, inTrash ? toAppleSeconds(trashed) : null)
    const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: ['#c33', '#3c3', '#33c'][i]! } }).jpeg().toBuffer()
    fs.writeFileSync(path.join(s.deviceRoot, 'DCIM', '100APPLE', name), bytes)
  }
  db.close()
  const device = new FakeDevice({ root: s.deviceRoot })
  const session = await PhoneSession.open({ device, udid: 'phone', name: 'Phone', cacheRoot: path.join(s.dir, 'cache'),
    heic: { decode: async () => { throw new Error('JPEG fixture must not need HEIC') } } })
  sessions.push(session)
  return { session, device }
}

const flags = (v: OpenVault, uuid: string) =>
  v.db.prepare(`SELECT hidden, deleted_at FROM asset WHERE source_uuid = ?`).get(uuid) as { hidden: number; deleted_at: number | null }

describe('saving hidden and deleted phone items', () => {
  it('marks each item with where it is on the phone', async () => {
    const { session, device } = await phone()
    const items = await phoneSaveItems(session, device, ['U1', 'U2', 'U3'])
    expect(items.map((i) => [i.key, i.hidden, i.deletedAt])).toEqual([
      ['U1', false, null],
      ['U2', true, null],
      ['U3', false, trashed],
    ])
    expect(phoneProbeItems(session, ['U2', 'U3']).map((i) => [i.hidden, i.deletedAt])).toEqual([[true, null], [false, trashed]])
  })

  it("lands them in the vault's Hidden and Recently Deleted, not its Library", async () => {
    const { session, device } = await phone()
    const v = vault('Saved')
    const result = await saveToVault(v, await phoneSaveItems(session, device, ['U1', 'U2', 'U3']), [])
    expect(result.failed).toEqual([])
    expect(result.saved).toBe(3)
    expect(flags(v, 'U1')).toEqual({ hidden: 0, deleted_at: null })
    expect(flags(v, 'U2')).toEqual({ hidden: 1, deleted_at: null })
    expect(flags(v, 'U3')).toEqual({ hidden: 0, deleted_at: trashed })
    expect(vaultItems(v.db, 'library')).toHaveLength(1)
    expect(vaultItems(v.db, 'hidden')).toHaveLength(1)
    expect(vaultItems(v.db, 'deleted')).toHaveLength(1)
  })

  it('leaves them for encryption, after which no plain copy is in the folder', async () => {
    const { session, device } = await phone()
    const v = vault('Saved')
    setUpProtection(v.layout, 'correct horse')
    const result = await saveToVault(v, await phoneSaveItems(session, device, ['U1', 'U2', 'U3']), [])
    const ids = Object.fromEntries(Object.entries(result.assets))
    expect(privacyWork(v.db).protect.sort()).toEqual([ids.U2, ids.U3].sort())
    const pub = publicKeyOf(readKeyFile(v.layout)!)
    for (const id of privacyWork(v.db).protect) await protectAsset(v, id, pub)
    expect(privacyWork(v.db).protect).toEqual([])
    const plain = v.db.prepare(`SELECT path FROM file WHERE asset_id IN (?, ?)`).all(ids.U2, ids.U3) as { path: string }[]
    expect(plain).toHaveLength(2)
    for (const f of plain) expect(fs.existsSync(path.join(v.layout.media, ...f.path.split('/')))).toBe(false)
  })

  it('does not copy a deleted item twice', async () => {
    const { session, device } = await phone()
    const v = vault('Saved')
    await saveToVault(v, await phoneSaveItems(session, device, ['U3']), [])
    expect(existingInVault(v.db, phoneProbeItems(session, ['U3'])).size).toBe(1)
    const again = await saveToVault(v, await phoneSaveItems(session, device, ['U3']), [])
    expect(again).toMatchObject({ saved: 0, alreadyThere: 1 })
  })

  it('keeps hidden items hidden when saved from one vault into another', async () => {
    const { session, device } = await phone()
    const from = vault('From')
    const r = await saveToVault(from, await phoneSaveItems(session, device, ['U2']), [])
    const to = vault('To')
    await saveToVault(to, vaultSaveItems(from.db, from.layout.media, [String(r.assets.U2)]), [])
    expect(flags(to, 'U2')).toEqual({ hidden: 1, deleted_at: null })
  })
})
