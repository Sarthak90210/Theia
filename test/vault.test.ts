import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canCreateVault, createVault, folderNameFor, isVault, NotAVault, openVault, vaultLayout } from '../src/vault/vault.ts'
import { existingInVault, saveToVault, type SaveAlbum, type SaveFile, type SaveItem } from '../src/vault/save.ts'
import { purgeAssets, trashAssets } from '../src/vault/delete.ts'
import { vaultCollections, vaultDetail, vaultItems } from '../src/gallery/vault-gallery.ts'
import { vaultSaveAlbums, vaultSaveItems } from '../src/gallery/save-sources.ts'
import { makeHeic, makeVideo, scratch, type Scratch } from './helpers.ts'

let s: Scratch
let base: string

beforeEach(() => {
  s = scratch()
  base = path.dirname(s.libraryRoot)
})
afterEach(() => s.cleanup())

function memFile(name: string, bytes: Buffer, role: SaveFile['role'] = 'master', mime = 'image/heic'): SaveFile {
  return {
    name,
    role,
    mime,
    size: bytes.length,
    sha256: null,
    read: async function* () {
      yield bytes
    },
  }
}

function item(key: string, files: SaveFile[], over: Partial<SaveItem> = {}): SaveItem {
  return {
    key,
    kind: 'photo',
    t: Date.UTC(2026, 2, 1, 10),
    off: 19800,
    w: 4032,
    h: 3024,
    dur: null,
    fav: false,
    edited: false,
    subtype: null,
    sourceUuid: `uuid-${key}`,
    lat: null,
    lon: null,
    cloud: false,
    files,
    ...over,
  }
}

describe('vault folders', () => {
  it('creates a vault in an empty folder and opens it again', () => {
    const root = path.join(base, 'Family')
    const v = createVault(root, 'Family 2026')
    v.db.close()
    expect(fs.existsSync(path.join(root, 'vault.json'))).toBe(true)
    expect(fs.existsSync(path.join(root, '.vault', 'library.db'))).toBe(true)
    const again = openVault(root)
    expect(again.manifest.name).toBe('Family 2026')
    expect(again.layout.kind).toBe('album')
    expect(again.layout.media).toBe(root)
    again.db.close()
  })

  it('refuses to make a vault in a folder that already has other things in it', () => {
    const root = path.join(base, 'Busy')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x')
    expect(canCreateVault(root)).toBe(false)
    expect(() => createVault(root)).toThrow(NotAVault)
    expect(() => openVault(root)).toThrow(NotAVault)
  })

  it('opens an import library as a vault, keeping its layout', () => {
    const root = path.join(base, 'PhotosLibrary')
    fs.mkdirSync(path.join(root, 'media'), { recursive: true })
    fs.writeFileSync(path.join(root, 'library.db'), '')
    expect(isVault(root)).toBe(true)
    expect(vaultLayout(root)).toMatchObject({ kind: 'library', media: path.join(root, 'media') })
  })

  it('makes album names safe as Windows folder names', () => {
    expect(folderNameFor('Trip: Goa / 2026?')).toBe('Trip_ Goa _ 2026_')
    expect(folderNameFor('CON')).toBe('CON_')
    expect(folderNameFor('trailing dots...')).toBe('trailing dots')
    expect(folderNameFor('   ')).toBe('Untitled')
  })
})

describe('saving into a vault', () => {
  it('puts album photos in the album folder and the rest in Library', async () => {
    const v = createVault(path.join(base, 'V'))
    const a = makeHeic({ mdatBytes: 1000 })
    const b = makeHeic({ mdatBytes: 2000 })
    const albums: SaveAlbum[] = [{ uuid: 'AL1', name: 'Goa trip', keys: ['a'] }]

    const r = await saveToVault(v, [item('a', [memFile('IMG_0001.HEIC', a)]), item('b', [memFile('IMG_0002.HEIC', b)])], albums)

    expect(r).toMatchObject({ saved: 2, alreadyThere: 0, failed: [] })
    expect(fs.readFileSync(path.join(v.layout.root, 'Goa trip', 'IMG_0001.HEIC'))).toEqual(a)
    expect(fs.readFileSync(path.join(v.layout.root, 'Library', 'IMG_0002.HEIC'))).toEqual(b)
    const c = vaultCollections(v.db)
    expect(c.albums.map((x) => `${x.name}:${x.count}`)).toEqual(['Goa trip:1'])
    v.db.close()
  })

  it('stores a photo in two albums once, hard-linked into the second folder', async () => {
    const v = createVault(path.join(base, 'V'))
    const bytes = makeHeic({ mdatBytes: 1500 })
    const albums: SaveAlbum[] = [
      { uuid: 'AL1', name: 'Goa', keys: ['a'] },
      { uuid: 'AL2', name: 'Best of', keys: ['a'] },
    ]
    await saveToVault(v, [item('a', [memFile('IMG_0001.HEIC', bytes)])], albums)

    const first = path.join(v.layout.root, 'Goa', 'IMG_0001.HEIC')
    const second = path.join(v.layout.root, 'Best of', 'IMG_0001.HEIC')
    expect(fs.readFileSync(second)).toEqual(bytes)
    expect(fs.statSync(first).nlink).toBe(2)
    expect(db(v).prepare(`SELECT COUNT(*) AS n FROM file`).get()).toEqual({ n: 1 })
    v.db.close()
  })

  it('keeps a Live Photo, its video and its edit recipe together as one item', async () => {
    const v = createVault(path.join(base, 'V'))
    const r = await saveToVault(
      v,
      [
        item(
          'a',
          [
            memFile('IMG_0001.HEIC', makeHeic()),
            memFile('IMG_0001.MOV', makeVideo(), 'motion', 'video/quicktime'),
            memFile('IMG_0001.AAE', Buffer.from('<plist/>'), 'sidecar', 'application/xml'),
          ],
          { kind: 'live', edited: true },
        ),
      ],
      [],
    )
    expect(r.saved).toBe(1)
    const items = vaultItems(v.db, 'live')
    expect(items).toHaveLength(1)
    const d = vaultDetail(v.db, v.layout.media, items[0]!.key)!
    expect(d.files.map((f) => `${f.name}:${f.role}`)).toEqual(['IMG_0001.HEIC:master', 'IMG_0001.MOV:motion', 'IMG_0001.AAE:sidecar'])
    expect(d.edited).toBe(true)
    v.db.close()
  })

  it('skips what the vault already has, and reports it', async () => {
    const v = createVault(path.join(base, 'V'))
    const bytes = makeHeic()
    await saveToVault(v, [item('a', [memFile('IMG_0001.HEIC', bytes)])], [])
    const again = await saveToVault(
      v,
      [item('a', [memFile('IMG_0001.HEIC', bytes)]), item('b', [memFile('IMG_0002.HEIC', makeHeic({ mdatBytes: 3000 }))])],
      [],
    )
    expect(again).toMatchObject({ saved: 1, alreadyThere: 1 })
    expect(db(v).prepare(`SELECT COUNT(*) AS n FROM asset`).get()).toEqual({ n: 2 })
    v.db.close()
  })

  it('tells which items the vault already has, before saving', async () => {
    const v = createVault(path.join(base, 'V'))
    await saveToVault(v, [item('a', [memFile('IMG_0001.HEIC', makeHeic())])], [])
    const found = existingInVault(v.db, [item('a', []), item('b', []), item('c', [], { cloud: true, sourceUuid: 'uuid-a' })])
    expect([...found.keys()]).toEqual(['a'])
    v.db.close()
  })

  it('replaces what the vault already has when asked, keeping its albums and Hidden', async () => {
    const v = createVault(path.join(base, 'V'))
    const old = makeHeic({ mdatBytes: 1000 })
    await saveToVault(v, [item('a', [memFile('IMG_0001.HEIC', old)])], [{ uuid: 'AL', name: 'Trip', keys: ['a'] }])
    db(v).prepare(`UPDATE asset SET hidden = 1`).run()
    const bin = path.join(base, 'bin')
    fs.mkdirSync(bin)
    const recycle = async (f: string) => fs.renameSync(f, path.join(bin, `${fs.readdirSync(bin).length}-${path.basename(f)}`))

    const fresh = makeHeic({ mdatBytes: 2000 })
    const r = await saveToVault(v, [item('a', [memFile('IMG_0001.HEIC', fresh)])], [], {
      duplicates: 'replace',
      replace: async (id) => {
        trashAssets(v.db, [id])
        await purgeAssets(v.db, v.layout.media, [id], recycle)
      },
    })

    expect(r).toMatchObject({ saved: 1, replaced: 1, alreadyThere: 0, failed: [] })
    expect(db(v).prepare(`SELECT COUNT(*) AS n, MAX(hidden) AS hidden FROM asset`).get()).toEqual({ n: 1, hidden: 1 })
    expect(fs.readFileSync(path.join(v.layout.root, 'Library', 'IMG_0001.HEIC'))).toEqual(fresh)
    expect(fs.readFileSync(path.join(v.layout.root, 'Trip', 'IMG_0001.HEIC'))).toEqual(fresh)
    expect(vaultCollections(v.db).albums.map((x) => x.name)).toEqual(['Trip'])
    expect(db(v).prepare(`SELECT COUNT(*) AS n FROM album_asset`).get()).toEqual({ n: 1 })
    expect(fs.readdirSync(bin)).toHaveLength(1)
    v.db.close()
  })

  it('keeps the old copy when it cannot be removed', async () => {
    const v = createVault(path.join(base, 'V'))
    const old = makeHeic({ mdatBytes: 1000 })
    await saveToVault(v, [item('a', [memFile('IMG_0001.HEIC', old)])], [])
    const r = await saveToVault(v, [item('a', [memFile('IMG_0001.HEIC', makeHeic({ mdatBytes: 2000 }))])], [], {
      duplicates: 'replace',
      replace: async () => { throw new Error('Recycle Bin refused') },
    })
    expect(r).toMatchObject({ saved: 0, replaced: 0 })
    expect(r.failed[0]!.reason).toMatch(/Kept the copy already in the vault.*Recycle Bin refused/)
    expect(r.assets).toEqual({})
    expect(fs.readFileSync(path.join(v.layout.root, 'Library', 'IMG_0001.HEIC'))).toEqual(old)
    expect(fs.readdirSync(path.join(v.layout.root, 'Library'))).toEqual(['IMG_0001.HEIC'])
    v.db.close()
  })

  it('recognises the same bytes under a different phone identifier', async () => {
    const v = createVault(path.join(base, 'V'))
    const bytes = makeHeic()
    await saveToVault(v, [item('a', [memFile('IMG_0001.HEIC', bytes)])], [])
    const r = await saveToVault(v, [item('z', [memFile('IMG_0001.HEIC', bytes)], { sourceUuid: 'other' })], [])
    expect(r).toMatchObject({ saved: 0, failed: [] })
    expect(db(v).prepare(`SELECT COUNT(*) AS n FROM file`).get()).toEqual({ n: 1 })
    v.db.close()
  })

  it('adds to an album that a previous save created, instead of making a second', async () => {
    const v = createVault(path.join(base, 'V'))
    await saveToVault(v, [item('a', [memFile('IMG_0001.HEIC', makeHeic({ mdatBytes: 100 }))])], [{ uuid: 'AL', name: 'Trip', keys: ['a', 'b'] }])
    await saveToVault(v, [item('b', [memFile('IMG_0002.HEIC', makeHeic({ mdatBytes: 200 }))])], [{ uuid: 'AL', name: 'Trip', keys: ['a', 'b'] }])
    const c = vaultCollections(v.db)
    expect(c.albums.map((x) => `${x.name}:${x.count}`)).toEqual(['Trip:2'])
    expect(fs.readdirSync(path.join(v.layout.root, 'Trip')).sort()).toEqual(['IMG_0001.HEIC', 'IMG_0002.HEIC'])
    v.db.close()
  })

  it('skips iCloud-only items and counts them', async () => {
    const v = createVault(path.join(base, 'V'))
    const r = await saveToVault(v, [item('a', [], { cloud: true })], [])
    expect(r).toMatchObject({ saved: 0, skippedCloud: 1 })
    v.db.close()
  })

  it('keeps a file that fails its checks out of the vault, with the reason', async () => {
    const v = createVault(path.join(base, 'V'))
    const broken = makeVideo({ moov: false })
    const r = await saveToVault(v, [item('a', [memFile('IMG_0001.MOV', broken, 'master', 'video/quicktime')], { kind: 'video' })], [])
    expect(r.saved).toBe(0)
    expect(r.failed[0]!.reason).toMatch(/moov/)
    expect(fs.existsSync(path.join(v.layout.root, 'Library', 'IMG_0001.MOV'))).toBe(false)
    expect(fs.readdirSync(path.join(v.layout.root, 'Library'))).toEqual([])
    v.db.close()
  })

  it('copies from one vault to another, albums and all', async () => {
    const from = createVault(path.join(base, 'From'))
    const bytes = makeHeic({ mdatBytes: 1234 })
    await saveToVault(from, [item('a', [memFile('IMG_0001.HEIC', bytes)])], [{ uuid: 'AL', name: 'Pets', keys: ['a'] }])
    const keys = vaultItems(from.db, 'library').map((i) => i.key)

    const to = createVault(path.join(base, 'To'))
    const r = await saveToVault(to, vaultSaveItems(from.db, from.layout.media, keys), vaultSaveAlbums(from.db))

    expect(r.saved).toBe(1)
    const sha = createHash('sha256').update(bytes).digest('hex')
    expect(db(to).prepare(`SELECT sha256 FROM file`).get()).toEqual({ sha256: sha })
    expect(fs.existsSync(path.join(to.layout.root, 'Pets', 'IMG_0001.HEIC'))).toBe(true)
    from.db.close()
    to.db.close()
  })
})

function db(v: { db: import('../src/library/db.ts').Db }) {
  return v.db
}
