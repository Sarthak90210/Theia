import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanFolderForImport, scanFilesForImport, scanPathsForImport, PHOTO_EXTS, VIDEO_EXTS, SIDECAR_EXTS } from '../src/vault/import-folder.ts'
import { createVault, type OpenVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'
import type { MetadataReader } from '../src/metadata/reader.ts'
import type { FileMetadata } from '../src/metadata/tags.ts'
import { makeHeic, makeJpeg, makeVideo, scratch, type Scratch } from './helpers.ts'

let s: Scratch
const vaults: OpenVault[] = []
beforeEach(() => (s = scratch()))
afterEach(() => {
  for (const v of vaults.splice(0)) v.db.close()
  s.cleanup()
})

const put = (rel: string, data: Buffer | string) => {
  const p = path.join(s.dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
  return p
}
const named = (items: SaveItem[], name: string) => items.find((i) => i.files[0]!.name === name)

function vault(name = 'vault') {
  const v = createVault(path.join(s.dir, name))
  vaults.push(v)
  return v
}

/** A reader that says every photo was taken at one fixed time, with a place and a size. */
function exifSays(meta: Partial<FileMetadata>): MetadataReader {
  const base: FileMetadata = {
    contentId: null, burstId: null, capturedUtcMs: null, capturedOffsetSeconds: null, offsetInferred: false, offsetSource: null,
    timeSource: null, lat: null, lon: null, altitude: null, width: null, height: null, durationMs: null, make: 'Canon',
    model: 'EOS', lens: null, iso: null, fNumber: null, exposure: null, focalMm: null, orientation: null,
  }
  return { read: async () => ({ meta: { ...base, ...meta }, raw: {} }), close: async () => {} }
}

describe('finding photos in a folder', () => {
  it('knows photo, video and sidecar extensions', () => {
    for (const e of ['.jpg', '.heic', '.png', '.tif', '.tiff']) expect(PHOTO_EXTS.has(e)).toBe(true)
    for (const e of ['.mov', '.mp4']) expect(VIDEO_EXTS.has(e)).toBe(true)
    for (const e of ['.aae', '.xmp']) expect(SIDECAR_EXTS.has(e)).toBe(true)
  })

  it('finds nothing in an empty folder', async () => {
    const res = await scanFolderForImport(s.dir)
    expect(res).toEqual({ items: [], albums: [] })
  })

  it('pairs Live Photos and sidecars, and leaves out hidden and other files', async () => {
    put('DSC_0001.JPG', makeJpeg())
    put('IMG_0002.HEIC', makeHeic())
    put('IMG_0002.MOV', makeVideo())
    put('IMG_0003.JPG', makeJpeg())
    put('IMG_0003.AAE', '<plist></plist>')
    put('VID_0004.MP4', makeVideo())
    put('.DS_Store', 'ignored')
    put('document.pdf', 'ignored')
    put('.hidden/IMG_9.JPG', makeJpeg())

    const { items } = await scanFolderForImport(s.dir)
    expect(items).toHaveLength(4)
    expect(named(items, 'DSC_0001.JPG')!.kind).toBe('photo')
    const live = named(items, 'IMG_0002.HEIC')!
    expect(live.kind).toBe('live')
    expect(live.files.map((f) => [f.name, f.role])).toEqual([['IMG_0002.HEIC', 'master'], ['IMG_0002.MOV', 'motion']])
    expect(named(items, 'IMG_0003.JPG')!.files.map((f) => f.role)).toEqual(['master', 'sidecar'])
    expect(named(items, 'VID_0004.MP4')!.kind).toBe('video')
  })

  it("keeps a long video that shares a photo's name as a video of its own", async () => {
    put('clip.jpg', makeJpeg())
    put('clip.mp4', makeVideo({ mdatBytes: 31 * 1024 * 1024 }))
    const { items } = await scanFolderForImport(s.dir)
    expect(items.map((i) => i.kind).sort()).toEqual(['photo', 'video'])
  })

  it('makes an album of each first-level folder, kept apart from same-named folders elsewhere', async () => {
    put('A/Summer Trip/beach.jpg', makeJpeg())
    put('A/Summer Trip/day 2/sunset.jpg', makeJpeg())
    put('A/home.jpg', makeJpeg())
    put('B/Summer Trip/other.jpg', makeJpeg())
    const a = await scanFolderForImport(path.join(s.dir, 'A'))
    expect(a.items).toHaveLength(3)
    expect(a.albums).toHaveLength(1)
    expect(a.albums[0]!.name).toBe('Summer Trip')
    expect(a.albums[0]!.keys).toHaveLength(2)
    const b = await scanFolderForImport(path.join(s.dir, 'B'))
    expect(b.albums[0]!.name).toBe('Summer Trip')
    expect(b.albums[0]!.uuid).not.toBe(a.albums[0]!.uuid)
  })

  it('never goes into a vault, and refuses the vault itself or a folder inside it', async () => {
    put('Pictures/a.jpg', makeJpeg())
    const v = vault('Pictures/My Vault')
    put('Pictures/My Vault/media/2024/copy.jpg', makeJpeg())
    const { items } = await scanFolderForImport(path.join(s.dir, 'Pictures'), { exclude: [v.layout.root] })
    expect(items.map((i) => i.files[0]!.name)).toEqual(['a.jpg'])
    await expect(scanFolderForImport(v.layout.root, { exclude: [v.layout.root] })).rejects.toThrow(/vault itself/)
    await expect(scanFolderForImport(path.join(v.layout.root, 'media'), { exclude: [v.layout.root] })).rejects.toThrow(/inside the vault/)
    // Another vault, not the one being saved into, is still never read as a folder of photos.
    await expect(scanFolderForImport(v.layout.root)).rejects.toThrow(/is a vault/)
  })

  it('takes files one by one, skipping ones that are not there', () => {
    const f1 = put('a.jpg', makeJpeg())
    const f2 = put('b.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(scanFilesForImport([f1, f2, path.join(s.dir, 'missing.jpg')]).items).toHaveLength(2)
  })

  it('takes dropped files and folders together, a dropped folder becoming an album', async () => {
    const sub = path.join(s.dir, 'SubDir')
    put('SubDir/nested.jpg', makeJpeg())
    put('SubDir/deeper/more.jpg', makeJpeg())
    const single = put('standalone.jpg', makeJpeg())
    const res = await scanPathsForImport([sub, single])
    expect(res.items).toHaveLength(3)
    expect(res.albums.map((a) => [a.name, a.keys.length])).toEqual([['SubDir', 2]])
  })
})

describe('saving a folder into a vault', () => {
  it('copies every byte, makes albums, and skips everything when added again without copying', async () => {
    const big = makeJpeg({ scanBytes: 5 * 1024 * 1024 }) // more than one 4 MB read chunk
    put('source/Trip/photo1.jpg', big)
    put('source/Trip/live.jpg', makeJpeg({ scanBytes: 1500 }))
    put('source/Trip/live.mov', makeVideo())
    const { items, albums } = await scanFolderForImport(path.join(s.dir, 'source'))
    expect(items).toHaveLength(2)

    const v = vault()
    const first = await saveToVault(v, items, albums)
    expect(first).toMatchObject({ saved: 2, alreadyThere: 0, failed: [] })
    const kinds = (v.db.prepare('SELECT kind FROM asset ORDER BY kind').all() as { kind: string }[]).map((r) => r.kind)
    expect(kinds).toEqual(['live', 'still'])
    const master = v.db.prepare(`SELECT path FROM file WHERE bytes = ?`).get(big.length) as { path: string }
    // Buffer.equals, not toEqual: a deep compare of 5 MB took up to 36 s and made this test time out.
    expect(fs.readFileSync(path.join(v.layout.media, ...master.path.split('/'))).equals(big)).toBe(true)
    expect((v.db.prepare('SELECT name FROM album').all() as { name: string }[]).map((a) => a.name)).toEqual(['Trip'])

    // Known by identity: nothing is read from disk the second time.
    const again = (await scanFolderForImport(path.join(s.dir, 'source'))).items.map((i) => ({
      ...i,
      files: i.files.map((f) => ({ ...f, read: () => { throw new Error('read again') } })),
    }))
    expect(await saveToVault(v, again, albums)).toMatchObject({ saved: 0, alreadyThere: 2, failed: [] })
  })

  it('counts bytes already in the vault under another name as already there', async () => {
    const jpeg = makeJpeg()
    put('one/a.jpg', jpeg)
    put('two/b.jpg', jpeg)
    const v = vault()
    await saveToVault(v, (await scanFolderForImport(path.join(s.dir, 'one'))).items, [])
    const res = await saveToVault(v, (await scanFolderForImport(path.join(s.dir, 'two'))).items, [])
    expect(res).toMatchObject({ saved: 0, alreadyThere: 1, failed: [] })
  })

  it("uses the photo's own capture time over the file's date, but never over a phone's", async () => {
    const taken = Date.UTC(2019, 6, 4, 10, 0, 0)
    put('folder/a.jpg', makeJpeg({ scanBytes: 700 }))
    const { items } = await scanFolderForImport(path.join(s.dir, 'folder'))
    const metadata = exifSays({ capturedUtcMs: taken, capturedOffsetSeconds: 7200, timeSource: 'exif', width: 4000, height: 3000, lat: 12.9, lon: 77.6 })

    const v = vault()
    await saveToVault(v, items, [], { metadata })
    expect(v.db.prepare('SELECT captured_utc, captured_offset, time_source, width, height, lat, lon FROM asset').get()).toEqual({
      captured_utc: taken, captured_offset: 7200, time_source: 'exif', width: 4000, height: 3000, lat: 12.9, lon: 77.6,
    })

    // A phone's date may have been corrected on the phone: the database wins.
    const fromPhone = { ...items[0]!, key: 'phone-1', sourceUuid: 'phone-1', timeSource: 'phone', t: Date.UTC(2020, 0, 1), w: 10, h: 20,
      files: items[0]!.files.map((f) => ({ ...f, read: () => fs.createReadStream(path.join(s.dir, 'folder', 'a.jpg')) })) }
    const w = vault('other')
    await saveToVault(w, [fromPhone], [], { metadata })
    expect(w.db.prepare('SELECT captured_utc, time_source, width, height, lat FROM asset').get()).toEqual({
      captured_utc: Date.UTC(2020, 0, 1), time_source: 'phone', width: 10, height: 20, lat: 12.9,
    })
  })
})
