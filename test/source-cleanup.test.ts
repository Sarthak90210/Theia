import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVault, type OpenVault } from '../src/vault/vault.ts'
import { saveToVault } from '../src/vault/save.ts'
import { scanFolderForImport } from '../src/vault/import-folder.ts'
import { recycleImportedSources, type SourceCleanupDeps } from '../src/vault/source-cleanup.ts'
import { makeVideo, scratch, type Scratch } from './helpers.ts'

/**
 * Deleting the originals after a folder import: only what is provably in the
 * vault, only to the Recycle Bin, and everything else kept with a reason.
 * The Recycle Bin here is a folder files are moved into.
 */

let s: Scratch
let v: OpenVault
let src: string
let bin: string
beforeEach(() => {
  s = scratch()
  v = createVault(path.join(s.dir, 'vault'))
  src = path.join(s.dir, 'from phone')
  bin = path.join(s.dir, 'recycle bin')
  fs.mkdirSync(src, { recursive: true })
  fs.mkdirSync(bin)
})
afterEach(() => {
  v.db.close()
  s.cleanup()
})

const jpeg = (colour: string) => sharp({ create: { width: 64, height: 48, channels: 3, background: colour } }).jpeg().toBuffer()
const put = (name: string, data: Buffer | string) => {
  const p = path.join(src, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
  return p
}

function deps(over: Partial<SourceCleanupDeps> = {}): SourceCleanupDeps {
  return {
    trash: async (file) => fs.renameSync(file, path.join(bin, path.basename(file))),
    recycleBin: async () => ({ maxBytes: 1e12, nukeOnDelete: false }),
    ...over,
  }
}

async function importFolder() {
  const { items, albums } = await scanFolderForImport(src)
  const result = await saveToVault(v, items, albums)
  return { items, result }
}

describe('deleting originals after a folder import', () => {
  it('moves exactly the imported originals to the Recycle Bin, and nothing else', async () => {
    put('a.jpg', await jpeg('#a33'))
    put('b.jpg', await jpeg('#3a3'))
    put('live.jpg', await jpeg('#33a'))
    put('live.mov', makeVideo())
    put('b.aae', '<plist></plist>')
    put('notes.txt', 'not a photo')
    put('Trip/c.jpg', await jpeg('#aa3'))
    const { items, result } = await importFolder()
    expect(result.failed).toEqual([])

    const r = await recycleImportedSources(v, items, result.assets, deps())
    expect(r).toEqual({ deleted: 6, kept: 0, reasons: [] })
    expect(fs.readdirSync(bin).sort()).toEqual(['a.jpg', 'b.aae', 'b.jpg', 'c.jpg', 'live.jpg', 'live.mov'])
    // The note, and the folders, stay.
    expect(fs.readdirSync(src).sort()).toEqual(['Trip', 'notes.txt'])
    // The vault still has every byte.
    expect((v.db.prepare('SELECT COUNT(*) AS n FROM file').get() as { n: number }).n).toBe(6)
  })

  it('also lets go of an original the vault already had under another name', async () => {
    const bytes = await jpeg('#a33')
    put('first.jpg', bytes)
    await importFolder()
    fs.renameSync(path.join(src, 'first.jpg'), path.join(s.dir, 'elsewhere.jpg'))
    put('again.jpg', bytes)
    const { items, result } = await importFolder()
    expect(result.alreadyThere).toBe(1)
    expect((await recycleImportedSources(v, items, result.assets, deps())).deleted).toBe(1)
  })

  it('keeps an original that changed after it was read, or whose vault copy no longer reads back', async () => {
    put('a.jpg', await jpeg('#a33'))
    put('b.jpg', await jpeg('#3a3'))
    const { items, result } = await importFolder()
    fs.appendFileSync(path.join(src, 'a.jpg'), 'edited meanwhile')
    const stored = v.db.prepare(`SELECT path FROM file WHERE path LIKE '%b.jpg'`).get() as { path: string }
    fs.appendFileSync(path.join(v.layout.media, ...stored.path.split('/')), 'damaged')

    const r = await recycleImportedSources(v, items, result.assets, deps())
    expect(r.deleted).toBe(0)
    expect(r.reasons.map((x) => [x.item, x.reason])).toEqual([
      ['a.jpg', 'It changed after Theia read it.'],
      ['b.jpg', 'The vault’s copy didn’t read back the same.'],
    ])
    expect(fs.readdirSync(src).sort()).toEqual(['a.jpg', 'b.jpg'])
  })

  it('never deletes where the Recycle Bin would not keep it', async () => {
    put('a.jpg', await jpeg('#a33'))
    const { items, result } = await importFolder()
    for (const recycleBin of [async () => null, async () => ({ maxBytes: 1e12, nukeOnDelete: true }), async () => ({ maxBytes: 10, nukeOnDelete: false })]) {
      const r = await recycleImportedSources(v, items, result.assets, deps({ recycleBin }))
      expect(r.deleted).toBe(0)
      expect(r.reasons[0]!.reason).toMatch(/Recycle Bin/)
    }
    expect(fs.existsSync(path.join(src, 'a.jpg'))).toBe(true)
  })

  it('keeps every original of an item that was not completely saved', async () => {
    put('a.jpg', await jpeg('#a33'))
    const { items } = await importFolder()
    const r = await recycleImportedSources(v, items, {}, deps())
    expect(r).toMatchObject({ deleted: 0, kept: 1 })
    expect(r.reasons[0]!.reason).toMatch(/Not every file/)
  })

  it('keeps an original whose vault copy is protected, or that Windows did not move, or once stopped', async () => {
    put('a.jpg', await jpeg('#a33'))
    put('b.jpg', await jpeg('#3a3'))
    const { items, result } = await importFolder()
    v.db.prepare(`UPDATE file SET encrypted_path = 'private/x' WHERE path LIKE '%a.jpg'`).run()
    const stuck = await recycleImportedSources(v, items, result.assets, deps({ trash: async () => {} }))
    expect(stuck.reasons.map((x) => x.reason)).toEqual([
      'Its copy in the vault is protected, so Theia can’t reread it to check.',
      'Windows didn’t move it to the Recycle Bin.',
    ])
    const stop = new AbortController()
    stop.abort()
    const stopped = await recycleImportedSources(v, items, result.assets, deps({ signal: stop.signal }))
    expect(stopped).toMatchObject({ deleted: 0, kept: 2 })
    expect(fs.readdirSync(src).sort()).toEqual(['a.jpg', 'b.jpg'])
  })
})
