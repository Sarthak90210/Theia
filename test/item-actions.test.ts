import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GalleryService } from '../app/main/gallery-service.ts'
import { createVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'
import { openWithChoices, parseReply, type ShellCommand } from '../src/shell/desktop.ts'
import { markAt, monthMarks, planTimeline, layoutGrid } from '../app/renderer/layout.ts'
import type { GalleryItem } from '../app/shared/api.ts'

/**
 * The right-click menu's file actions on a real vault. Share, Open with and
 * Set as go to Windows itself, so they are checked by hand, not here: a test
 * would open windows on the desktop or change its background.
 */

let dir: string
let service: GalleryService
let saveAs: string | null
let folder: string | null
let vaultId: string
let keys: string[]
let jpeg: Buffer

beforeEach(async () => {
  fs.mkdirSync(path.resolve('transcripts'), { recursive: true })
  dir = fs.mkdtempSync(path.resolve('transcripts', 'theia-actions-'))
  const v = createVault(path.join(dir, 'V'))
  jpeg = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#3a6' } }).jpeg().toBuffer()
  const other = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#a63' } }).jpeg().toBuffer()
  // Two photos with the same file name, as two phones would name them.
  const items: SaveItem[] = [jpeg, other].map((bytes, i) => ({
    key: `p${i}`, kind: 'photo', t: Date.UTC(2026, 0, 1 + i), off: 0, w: 400, h: 300, dur: null, fav: false, edited: false,
    subtype: null, sourceUuid: `p${i}`, lat: null, lon: null, cloud: false,
    files: [{ name: 'IMG_0001.JPG', role: 'master', mime: 'image/jpeg', size: bytes.length, sha256: null, read: async function* () { yield bytes } }],
  }))
  const r = await saveToVault(v, items, [])
  keys = items.map((it) => String(r.assets[it.key]))
  v.db.close()
  const profile = path.join(dir, 'profile')
  fs.mkdirSync(profile)
  fs.writeFileSync(path.join(profile, 'gallery.json'), JSON.stringify({ vaults: [] }))
  saveAs = null
  folder = null
  service = new GalleryService({
    userData: profile, publish: () => {}, pickFolder: async () => folder, openPath: async () => {}, showInFolder: () => {},
    openExternal: async () => {}, trash: async () => {}, recycleBinLimit: async () => null, setBusy: () => {},
    pickSavePath: async () => saveAs,
  })
  vaultId = service.openVaultAt(path.join(dir, 'V'))
})

afterEach(async () => {
  await service?.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

const originalOf = (key: string) => {
  const db = (service as unknown as { vaults: Map<string, { vault: { db: import('better-sqlite3').Database; layout: { media: string } } }> }).vaults.get(vaultId)!.vault
  const f = db.db.prepare('SELECT path FROM file WHERE asset_id = ? AND is_primary = 1').get(Number(key)) as { path: string }
  return { db: db.db, file: path.join(db.layout.media, ...f.path.split('/')) }
}

describe('save as', () => {
  it('saves a byte-exact copy where asked, and never over the original', async () => {
    saveAs = path.join(dir, 'out', 'copy.jpg')
    fs.mkdirSync(path.dirname(saveAs))
    expect(await service.saveItemsAs(vaultId, [keys[0]!])).toBe(saveAs)
    expect(fs.readFileSync(saveAs)).toEqual(jpeg)
    saveAs = originalOf(keys[0]!).file.toUpperCase()
    await expect(service.saveItemsAs(vaultId, [keys[0]!])).rejects.toThrow(/original itself/)
    saveAs = null
    expect(await service.saveItemsAs(vaultId, [keys[0]!])).toBeNull()
  })

  it('puts several into a folder, numbering names that clash', async () => {
    folder = path.join(dir, 'many')
    fs.mkdirSync(folder)
    fs.writeFileSync(path.join(folder, 'IMG_0001.JPG'), 'already here')
    expect(await service.saveItemsAs(vaultId, keys)).toBe(folder)
    expect(fs.readdirSync(folder).sort()).toEqual(['IMG_0001 (2).JPG', 'IMG_0001.JPG', 'IMG_0001_1.JPG'])
    expect(fs.readFileSync(path.join(folder, 'IMG_0001.JPG'), 'utf8')).toBe('already here')
    expect(fs.readFileSync(path.join(folder, 'IMG_0001 (2).JPG'))).toEqual(jpeg)
  })
})

it('copies paths as File Explorer does: quoted, one per line', async () => {
  const text = await service.itemPaths(vaultId, keys)
  expect(text.split('\r\n')).toEqual(keys.map((k) => `"${originalOf(k).file}"`))
})

describe('resize', () => {
  it('fits the picture inside the size, in the format asked, and refuses nonsense', async () => {
    saveAs = path.join(dir, 'small.jpg')
    expect(await service.resizeItem(vaultId, keys[0]!, { width: 100, height: 100, format: 'jpeg', quality: 80 })).toBe(saveAs)
    expect(await sharp(saveAs).metadata()).toMatchObject({ width: 100, height: 75, format: 'jpeg' })
    saveAs = path.join(dir, 'big.png')
    await service.resizeItem(vaultId, keys[0]!, { width: 4000, height: 4000, format: 'png', quality: 80 })
    // Never enlarged.
    expect(await sharp(saveAs).metadata()).toMatchObject({ width: 400, height: 300, format: 'png' })
    await expect(service.resizeItem(vaultId, keys[0]!, { width: 2, height: 2, format: 'jpeg', quality: 80 })).rejects.toThrow(/between 16/)
  })
})

it('refuses to hand a protected item to Windows, before Windows is asked', async () => {
  const { db } = originalOf(keys[0]!)
  db.prepare(`UPDATE file SET encrypted_path = 'private/x.enc' WHERE asset_id = ?`).run(Number(keys[0]))
  for (const action of [
    () => service.copyItems(vaultId, [keys[0]!]),
    () => service.itemPaths(vaultId, [keys[0]!]),
    () => service.shareItems(vaultId, [keys[0]!], { x: 0, y: 0 }),
    () => service.saveItemsAs(vaultId, [keys[0]!]),
    () => service.setItemAs(vaultId, keys[0]!, 'desktop'),
  ]) await expect(action()).rejects.toThrow(/protected/)
})

describe('open with', () => {
  // What Windows listed for a PNG on a real computer (src/shell/desktop-helper.ps1 verbs).
  const listed: ShellCommand[] = [
    { verb: 'open', label: 'Open' },
    { verb: '{BFE0E2A4-C70C-4AD7-AC3D-10D1ECEBB5B4}', label: 'Edit with Photos' },
    { verb: '{DB6BACB1-FC31-4B28-9C53-7240A4F98404}', label: 'Ask Copilot' },
    { verb: '{2430F218-B743-4FD6-97BF-5C76541B4AE9}', label: 'Edit with Paint' },
    { verb: '{8AB635F8-9A67-4698-AB99-784AD929F3B4}', label: 'Edit with Clipchamp' },
    { verb: 'setdesktopwallpaper', label: 'Set as desktop background' },
    { verb: 'print', label: 'Print' },
    { verb: '{CA6CC9F1-867A-481E-951E-A28C5E4F01EA}', label: 'Edit in Notepad' },
    { verb: 'SevenZipExtract', label: '7-Zip > Extract files...' },
    { verb: '', label: 'Open with > Open with' },
    { verb: 'copyaspath', label: 'Copy as path' },
    { verb: 'Windows.ModernShare', label: 'Share' },
    { verb: 'copy', label: 'Copy' },
    { verb: 'delete', label: 'Delete' },
  ]

  it('offers the default app and the editors, not Explorer housekeeping', () => {
    expect(openWithChoices(listed)).toEqual([
      { id: 'open', label: 'Default app' },
      { id: '{BFE0E2A4-C70C-4AD7-AC3D-10D1ECEBB5B4}', label: 'Photos' },
      { id: '{2430F218-B743-4FD6-97BF-5C76541B4AE9}', label: 'Paint' },
      { id: '{8AB635F8-9A67-4698-AB99-784AD929F3B4}', label: 'Clipchamp' },
    ])
  })

  it("reads the helper's answer, and its errors as errors", () => {
    expect(parseReply<{ ok: boolean }>('noise\r\n{"ok":true}\r\n')).toEqual({ ok: true })
    expect(() => parseReply('{"error":"Windows can\'t find the file."}')).toThrow("Windows can't find the file.")
    expect(() => parseReply('')).toThrow(/no answer/)
  })
})

describe('the timeline', () => {
  const item = (y: number, m: number, d = 1): GalleryItem => ({
    key: `${y}-${m}-${d}`, kind: 'photo', t: Date.UTC(y, m, d), off: 0, w: 1, h: 1, dur: null, fav: false, edited: false, cloud: false, subtype: null,
  })
  // A few old scans, then a few years of phone photos.
  const items = [item(1980, 5), ...[2022, 2023, 2024, 2025, 2026].flatMap((y) => Array.from({ length: 12 }, (_, m) => Array.from({ length: 10 }, (_, d) => item(y, m, d + 1))).flat())]
  const layout = layoutGrid(items, 'all', 800, 5)

  it('marks where each month starts, in order', () => {
    const marks = monthMarks(items, layout.rows)
    expect(marks).toHaveLength(1 + 5 * 12)
    expect(marks[0]).toMatchObject({ year: 1980, month: 5, index: 0 })
    expect(marks.every((m, i) => i === 0 || m.top >= marks[i - 1]!.top)).toBe(true)
    expect(markAt(marks, marks[13]!.top + 1)).toBe(marks[13])
    expect(markAt(marks, -5)).toBe(marks[0])
  })

  it('labels each year that fits, always the newest, with dots for months between', () => {
    const marks = monthMarks(items, layout.rows)
    const roomy = planTimeline(marks, layout.height, 900)
    // One 1980 scan is one row: 2022 starts a few pixels below it, too close to label.
    expect(roomy.years.map((y) => y.year)).toEqual([1980, 2023, 2024, 2025, 2026])
    expect(roomy.dots.length).toBeGreaterThan(40)
    for (let i = 1; i < roomy.dots.length; i++) expect(roomy.dots[i]!.y - roomy.dots[i - 1]!.y).toBeGreaterThanOrEqual(6)
    // A short rail drops labels that would overlap, but keeps the newest year.
    const cramped = planTimeline(marks, layout.height, 60)
    expect(cramped.years.at(-1)!.year).toBe(2026)
    for (let i = 1; i < cramped.years.length; i++) expect(cramped.years[i]!.y - cramped.years[i - 1]!.y).toBeGreaterThanOrEqual(20)
  })
})
