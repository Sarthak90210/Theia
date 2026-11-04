import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveAlbum, type SaveFile, type SaveItem } from '../src/vault/save.ts'
import { purgeAssets, restoreAssets, trashAssets } from '../src/vault/delete.ts'
import { vaultCollections, vaultItems } from '../src/gallery/vault-gallery.ts'
import { makeHeic, scratch, type Scratch } from './helpers.ts'

let s: Scratch
let base: string
beforeEach(() => {
  s = scratch()
  base = path.dirname(s.libraryRoot)
})
afterEach(() => s.cleanup())

function memFile(name: string, bytes: Buffer): SaveFile {
  return { name, role: 'master', mime: 'image/heic', size: bytes.length, sha256: null, read: async function* () { yield bytes } }
}
function item(key: string, files: SaveFile[]): SaveItem {
  return {
    key, kind: 'photo', t: Date.UTC(2026, 2, 1, 10), off: 0, w: 1, h: 1, dur: null, fav: false, edited: false,
    subtype: null, sourceUuid: `uuid-${key}`, lat: null, lon: null, cloud: false, files,
  }
}

describe('deleting from a vault', () => {
  it('hides, restores, and finally recycles every copy, but never a different photo with the same name', async () => {
    const v = createVault(path.join(base, 'V'))
    const mine = makeHeic({ mdatBytes: 1500 })
    const other = makeHeic({ mdatBytes: 900 })
    // A different photo already named IMG_0001.HEIC sits in "Best of".
    fs.mkdirSync(path.join(v.layout.root, 'Best of'), { recursive: true })
    const stranger = path.join(v.layout.root, 'Best of', 'IMG_0001.HEIC')
    fs.writeFileSync(stranger, other)
    const albums: SaveAlbum[] = [
      { uuid: 'AL1', name: 'Goa', keys: ['a'] },
      { uuid: 'AL2', name: 'Best of', keys: ['a'] },
      { uuid: 'AL3', name: 'Family', keys: ['a'] },
    ]
    await saveToVault(v, [item('a', [memFile('IMG_0001.HEIC', mine)])], albums)
    const id = Number(vaultItems(v.db, 'library')[0]!.key)

    expect(trashAssets(v.db, [id])).toBe(1)
    expect(vaultItems(v.db, 'library')).toHaveLength(0)
    expect(vaultItems(v.db, 'deleted').map((i) => i.key)).toEqual([String(id)])
    expect(vaultCollections(v.db).smart.find((c) => c.id === 'deleted')?.count).toBe(1)

    expect(restoreAssets(v.db, [id])).toBe(1)
    expect(vaultItems(v.db, 'library')).toHaveLength(1)

    trashAssets(v.db, [id])
    const recycled: string[] = []
    const r = await purgeAssets(v.db, v.layout.media, [id], async (p) => {
      recycled.push(path.relative(v.layout.root, p))
      fs.rmSync(p)
    })
    expect(r).toEqual({ removed: 1, failed: [] })
    expect(recycled.sort()).toEqual([path.join('Family', 'IMG_0001.HEIC'), path.join('Goa', 'IMG_0001.HEIC')])
    expect(fs.readFileSync(stranger)).toEqual(other)
    expect(vaultItems(v.db, 'deleted')).toHaveLength(0)
    v.db.close()
  })

  it('keeps an item whose files the Recycle Bin refused', async () => {
    const v = createVault(path.join(base, 'V'))
    await saveToVault(v, [item('a', [memFile('IMG_0002.HEIC', makeHeic({ mdatBytes: 500 }))])], [])
    const id = Number(vaultItems(v.db, 'library')[0]!.key)
    trashAssets(v.db, [id])
    const r = await purgeAssets(v.db, v.layout.media, [id], async () => {
      throw new Error('file in use')
    })
    expect(r.removed).toBe(0)
    expect(r.failed[0]?.reason).toBe('file in use')
    expect(vaultItems(v.db, 'deleted')).toHaveLength(1)
    v.db.close()
  })

  it('does not purge an item that is not in Recently Deleted', async () => {
    const v = createVault(path.join(base, 'V'))
    await saveToVault(v, [item('a', [memFile('IMG_0003.HEIC', makeHeic({ mdatBytes: 500 }))])], [])
    const id = Number(vaultItems(v.db, 'library')[0]!.key)
    const r = await purgeAssets(v.db, v.layout.media, [id], async () => {
      throw new Error('should not be called')
    })
    expect(r).toEqual({ removed: 0, failed: [] })
    v.db.close()
  })

  it('retries an album copy after the primary was already recycled', async () => {
    const v = createVault(path.join(base, 'retry'))
    await saveToVault(v, [item('a', [memFile('IMG_0004.HEIC', makeHeic())])], [
      { uuid: 'one', name: 'One', keys: ['a'] }, { uuid: 'two', name: 'Two', keys: ['a'] },
    ])
    const id = Number(vaultItems(v.db, 'library')[0]!.key)
    trashAssets(v.db, [id])
    const first = await purgeAssets(v.db, v.layout.media, [id], async p => {
      if (p.includes(`${path.sep}Two${path.sep}`)) throw new Error('locked')
      fs.unlinkSync(p)
    })
    expect(first.removed).toBe(0)
    expect(fs.existsSync(path.join(v.layout.media, 'Two', 'IMG_0004.HEIC'))).toBe(true)
    const second = await purgeAssets(v.db, v.layout.media, [id], async p => { fs.unlinkSync(p) })
    expect(second.removed).toBe(1)
    expect(fs.existsSync(path.join(v.layout.media, 'Two', 'IMG_0004.HEIC'))).toBe(false)
    v.db.close()
  })
})
