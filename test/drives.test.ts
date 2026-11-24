import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GalleryService } from '../app/main/gallery-service.ts'
import { createVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'
import type { AppState } from '../app/shared/api.ts'

/**
 * A vault's drive unplugged while Theia is open, plugged back in, and missing
 * when Theia starts. `subst` stands in for the USB drive: it gives a folder a
 * drive letter, and taking the letter away makes the drive vanish the way
 * unplugging does, with no administrator rights needed.
 */

const isWindows = process.platform === 'win32'
let dir: string
let letter: string
let service: GalleryService | null
let states: AppState[]

function freeLetter(): string {
  for (const l of 'QRSTUVWXYZ') if (!fs.existsSync(`${l}:\\`)) return l
  throw new Error('no free drive letter')
}
const plugIn = () => execFileSync('subst', [`${letter}:`, dir])
const unplug = () => execFileSync('subst', [`${letter}:`, '/d'])

function newService() {
  return new GalleryService({
    userData: path.join(dir, 'profile'), publish: (s: AppState) => states.push(s), pickFolder: async () => null,
    openPath: async () => {}, showInFolder: () => {}, openExternal: async () => {}, trash: async () => {},
    recycleBinLimit: async () => null, setBusy: () => {}, pickSavePath: async () => null,
  } as never)
}

beforeEach(async () => {
  if (!isWindows) return
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theia-drive-'))
  letter = freeLetter()
  plugIn()
  const v = createVault(`${letter}:\\Photos`)
  const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#468' } }).jpeg().toBuffer()
  const items: SaveItem[] = [{
    key: 'a', kind: 'photo', t: Date.UTC(2026, 0, 1), off: 0, w: 64, h: 48, dur: null, fav: false, edited: false, subtype: null,
    sourceUuid: 'a', lat: null, lon: null, cloud: false,
    files: [{ name: 'IMG_0001.JPG', role: 'master', mime: 'image/jpeg', size: bytes.length, sha256: null, read: async function* () { yield bytes } }],
  }]
  await saveToVault(v, items, [])
  v.db.close()
  fs.mkdirSync(path.join(dir, 'profile'))
  fs.writeFileSync(path.join(dir, 'profile', 'gallery.json'), JSON.stringify({ vaults: [`${letter}:\\Photos`] }))
  states = []
  service = null
})

afterEach(async () => {
  if (!isWindows) return
  await service?.stop()
  try { unplug() } catch { /* already */ }
  fs.rmSync(dir, { recursive: true, force: true })
})

const last = () => states.at(-1)!
const remembered = () => JSON.parse(fs.readFileSync(path.join(dir, 'profile', 'gallery.json'), 'utf8')).vaults as string[]

describe.skipIf(!isWindows)('a vault drive unplugged and plugged back in', () => {
  it('closes the vault cleanly, keeps listing it, and opens it again when the drive is back', async () => {
    service = newService()
    service.start()
    expect(last().vaults.map((v) => v.name)).toEqual(['Photos'])
    const id = last().vaults[0]!.id

    unplug()
    await service.checkDrives()
    expect(last().vaults).toEqual([])
    expect(last().offlineVaults).toEqual([{ root: `${letter}:\\Photos`, name: 'Photos' }])
    // Nothing trips over it any more: state, lists and pictures answer calmly.
    expect(() => service!.snapshot()).not.toThrow()
    await expect(service.items(id, 'library')).rejects.toThrow()
    expect(remembered()).toEqual([`${letter}:\\Photos`])

    plugIn()
    await service.checkDrives()
    expect(last().offlineVaults).toEqual([])
    expect(last().vaults.map((v) => [v.id, v.count])).toEqual([[id, 1]])
    expect(await service.items(id, 'library')).toHaveLength(1)
  })

  it('survives the database failing under it before the drive check notices', async () => {
    service = newService()
    service.start()
    const entry = [...(service as unknown as { vaults: Map<string, { vault: { db: { prepare: unknown } } }> }).vaults.values()][0]!
    // What SQLite says when the file it is reading has gone.
    entry.vault.db.prepare = () => { throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR_READ' }) }
    unplug()
    expect(() => service!.snapshot()).not.toThrow()
    expect(service.snapshot().vaults).toEqual([])
    await service.checkDrives()
    expect(last().offlineVaults.map((o) => o.name)).toEqual(['Photos'])
  })

  it('remembers a vault whose drive is missing when Theia starts, instead of forgetting it', async () => {
    unplug()
    service = newService()
    service.start()
    expect(last().vaults).toEqual([])
    expect(last().offlineVaults).toEqual([{ root: `${letter}:\\Photos`, name: 'Photos' }])
    // Opening or closing another vault rewrites the list: it must still be there.
    ;(service as unknown as { saveVaultList(): void }).saveVaultList()
    expect(remembered()).toEqual([`${letter}:\\Photos`])

    plugIn()
    await service.checkDrives()
    expect(last().vaults.map((v) => v.name)).toEqual(['Photos'])
  })

  it('forgets a vault only when asked, without touching its files', async () => {
    unplug()
    service = newService()
    service.start()
    service.forgetVault(`${letter}:\\Photos`)
    expect(last().offlineVaults).toEqual([])
    expect(remembered()).toEqual([])
    expect(fs.existsSync(path.join(dir, 'Photos', '.vault', 'library.db'))).toBe(true)
  })
})
