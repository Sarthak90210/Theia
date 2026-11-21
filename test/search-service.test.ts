import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GalleryService } from '../app/main/gallery-service.ts'
import { searchCollection } from '../app/shared/api.ts'
import { createVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'
import { Embedder } from '../src/search/embedder.ts'
import { scratch, type Scratch } from './helpers.ts'

/**
 * Search through the app's service with the real bundled model: photos are
 * read for search in the background after thumbnails, a query finds them,
 * and hiding one erases its vector and takes it out of the results.
 */

const modelsDir = path.resolve('.release-tools/models')
const modelDir = path.join(modelsDir, 'embeddinggemma-2')
let s: Scratch
let service: GalleryService
let id: string
let keys: Record<string, string>
let dbPath: string

/** A white page with a line of print on it. */
async function page(words: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="100%" height="100%" fill="#fbfbf7"/>
    <text x="24" y="130" font-family="Arial" font-size="34" font-weight="bold" fill="#111">${words}</text></svg>`
  return sharp(Buffer.from(svg)).jpeg().toBuffer()
}

async function photo(colour: string, stripe?: string): Promise<Buffer> {
  const base = sharp({ create: { width: 320, height: 240, channels: 3, background: colour } })
  if (!stripe) return base.jpeg().toBuffer()
  const band = await sharp({ create: { width: 320, height: 90, channels: 3, background: stripe } }).png().toBuffer()
  return base.composite([{ input: band, top: 150, left: 0 }]).jpeg().toBuffer()
}

beforeEach(async () => {
  s = scratch()
  const profile = path.join(s.dir, 'profile')
  fs.mkdirSync(profile)
  fs.writeFileSync(path.join(profile, 'gallery.json'), JSON.stringify({ vaults: [] }))
  const vault = createVault(path.join(s.dir, 'Vault'))
  const subjects = { sunset: await photo('#f08a24', '#0b1e4a'), grass: await photo('#3f9b3a'), paper: await page('INVOICE 2291') }
  const items: SaveItem[] = Object.entries(subjects).map(([name, bytes], i) => ({
    key: name, kind: 'photo', t: Date.UTC(2026, 0, 1 + i), off: 0, w: 320, h: 240, dur: null, fav: false, edited: false,
    subtype: null, sourceUuid: name, lat: null, lon: null, cloud: false,
    files: [{ name: `${name}.jpg`, role: 'master', mime: 'image/jpeg', size: bytes.length, sha256: null, read: async function* () { yield bytes } }],
  }))
  const r = await saveToVault(vault, items, [])
  keys = Object.fromEntries(Object.entries(r.assets).map(([k, v]) => [k, String(v)]))
  dbPath = vault.layout.db
  vault.db.close()
  service = new GalleryService({
    userData: profile, publish: () => {}, pickFolder: async () => null, openPath: async () => {}, showInFolder: () => {},
    openExternal: async () => {}, trash: async () => {}, recycleBinLimit: async () => null, setBusy: () => {}, modelsDir,
  })
  id = service.openVaultAt(vault.layout.root)
})

afterEach(async () => {
  await service.stop()
  s.cleanup()
})

function embedded(table = 'embedding'): number {
  const db = new Database(dbPath, { readonly: true })
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  } finally {
    db.close()
  }
}

async function indexed(n: number) {
  for (let i = 0; i < 600 && (embedded() < n || embedded('ocr_text') < n); i++) await new Promise((r) => setTimeout(r, 100))
  for (let i = 0; i < 100 && service.snapshot().search.indexing; i++) await new Promise((r) => setTimeout(r, 100))
}

describe.skipIf(!Embedder.available(modelDir))('search in the app', () => {
  it('indexes in the background, finds by meaning, and forgets hidden photos', async () => {
    expect(service.snapshot().search.available).toBe(true)
    await indexed(3)
    expect(embedded()).toBe(3)
    expect(embedded('ocr_text')).toBe(3)

    const sunset = await service.items(id, searchCollection('orange sunset sky'))
    expect(sunset[0]?.key).toBe(keys.sunset)
    // Words in the photo, misspelt, and the date it was taken.
    const invoice = await service.items(id, searchCollection('invoce'))
    expect(invoice[0]?.key).toBe(keys.paper)
    // Highlighted where it is printed: about the left half of the page, around y 130.
    const [quad] = invoice[0]!.marks!.quads
    expect(invoice[0]!.marks).toMatchObject({ w: 320, h: 240 })
    expect(quad![0]).toBeLessThan(40)
    expect(quad![2]).toBeGreaterThan(120)
    expect(quad![2]).toBeLessThan(200)
    expect(quad![1]).toBeGreaterThan(80)
    expect(quad![5]).toBeLessThan(160)
    expect((await service.items(id, searchCollection('2 january 2026'))).map((i) => i.key)).toEqual([keys.grass])

    await service.setUpProtection(id, 'fixture passcode 123')
    await service.setHidden(id, [keys.sunset!], true)
    expect(embedded()).toBe(2)
    expect(embedded('ocr_text')).toBe(2)
    const after = await service.items(id, searchCollection('orange sunset sky'))
    expect(after.map((i) => i.key)).not.toContain(keys.sunset)
  }, 180_000)

  it('returns nothing for a phone or an empty query', async () => {
    expect(await service.items(id, searchCollection('   '))).toEqual([])
    expect(await service.items('device:none', searchCollection('beach'))).toEqual([])
  })
})
