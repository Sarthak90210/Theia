import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_EDIT, validateEdit } from '../src/media/edit-recipe.ts'
import { editPhoto, editPreview } from '../src/media/edit.ts'
import { applyColour, colourOps, tone } from '../src/media/edit-math.ts'
import { probe } from '../src/media/playback.ts'
import { saveEditedCopy } from '../src/vault/edit.ts'
import { createVault, type OpenVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'
import { purgeAssets, restoreAssets, trashAssets } from '../src/vault/delete.ts'
import { vaultCollections, vaultFiles, vaultItems } from '../src/gallery/vault-gallery.ts'
import { scratch, type Scratch } from './helpers.ts'

let s: Scratch
let v: OpenVault
beforeEach(() => { s = scratch(); v = createVault(path.join(s.dir, 'EditsVault')) })
afterEach(() => { v.db.close(); s.cleanup() })
const deps = { heic: { decode: async () => { throw new Error('unexpected HEIC decode') } } }
async function add(bytes: Buffer, video = false): Promise<string> {
  const item: SaveItem = {
    key: 'a', kind: video ? 'video' : 'photo', t: 1700000000000, off: 19800, w: 300, h: 200, dur: video ? 3000 : null,
    fav: true, edited: false, subtype: null, sourceUuid: 'a', lat: 12, lon: 77, cloud: false,
    files: [{ name: video ? 'clip.mp4' : 'photo.jpg', role: 'master', mime: video ? 'video/mp4' : 'image/jpeg',
      size: bytes.length, sha256: null, read: async function* () { yield bytes } }],
  }
  await saveToVault(v, [item], [{ uuid: 'album', name: 'Trip', keys: ['a'] }])
  return vaultItems(v.db, 'library')[0]!.key
}
const jpeg = () => sharp({ create: { width: 300, height: 200, channels: 3, background: '#c83a25' } }).jpeg().toBuffer()

describe('editing copies in a vault', () => {
  it('crops and rotates at full resolution, preserving original bytes, date and album', async () => {
    const original = await jpeg()
    const key = await add(original)
    const r = { ...structuredClone(DEFAULT_EDIT), rotation: 90 as const, crop: { x: 0.25, y: 0, width: 0.5, height: 1 }, saturation: 0 }
    const copy = await saveEditedCopy(v, key, r, deps)
    const file = vaultFiles(v.db, copy)[0]!
    const meta = await sharp(path.join(v.layout.media, file.path)).metadata()
    // Crop applies to the picture as shown: turned to 200x300, then the middle half across.
    expect([meta.width, meta.height]).toEqual([100, 300])
    const stats = await sharp(path.join(v.layout.media, file.path)).stats()
    expect(Math.abs(stats.channels[0]!.mean - stats.channels[1]!.mean)).toBeLessThan(2)
    expect(fs.readFileSync(path.join(v.layout.media, vaultFiles(v.db, key)[0]!.path))).toEqual(original)
    const items = vaultItems(v.db, 'album:1')
    expect(items).toHaveLength(2)
    expect(items.find(a => a.key === copy)).toMatchObject({ edited: true, t: 1700000000000, w: 100, h: 300 })
    expect(v.db.prepare('SELECT parent_id FROM edit_copy WHERE asset_id = ?').get(copy)).toEqual({ parent_id: Number(key) })
    expect((await sharp(await editPreview({ file: path.join(v.layout.media, vaultFiles(v.db, key)[0]!.path), mime: 'image/jpeg' }, r, deps)).metadata()).height).toBe(300)
  })

  it('makes separate copies on repeated saves and preserves the hidden state', async () => {
    const key = await add(await jpeg())
    v.db.prepare('UPDATE asset SET hidden = 1 WHERE id = ?').run(key)
    const first = await saveEditedCopy(v, key, DEFAULT_EDIT, deps)
    const second = await saveEditedCopy(v, key, DEFAULT_EDIT, deps)
    expect(first).not.toBe(second)
    expect(vaultItems(v.db, 'hidden')).toHaveLength(3)
    expect(vaultItems(v.db, 'library')).toHaveLength(0)
    expect(vaultItems(v.db, 'album:1')).toHaveLength(0)
    expect(vaultItems(v.db, 'favourites')).toHaveLength(0)
    trashAssets(v.db, [Number(first)])
    expect(vaultItems(v.db, 'hidden')).toHaveLength(2)
    expect(vaultItems(v.db, 'deleted')).toHaveLength(1)
    restoreAssets(v.db, [Number(first)])
    expect(vaultItems(v.db, 'hidden')).toHaveLength(3)
  })

  it('requires recovery before editing and leaves no partial output on invalid settings', async () => {
    const key = await add(await jpeg())
    await expect(saveEditedCopy(v, key, { ...DEFAULT_EDIT, exposure: NaN }, deps)).rejects.toThrow('Invalid edit')
    expect(fs.existsSync(path.join(v.layout.media, 'Edited Copies'))).toBe(false)
    trashAssets(v.db, [Number(key)])
    await expect(saveEditedCopy(v, key, DEFAULT_EDIT, deps)).rejects.toThrow('Restore')
  })

  it('keeps an edited copy when its parent is deleted permanently', async () => {
    const key = await add(await jpeg())
    const copy = await saveEditedCopy(v, key, DEFAULT_EDIT, deps)
    trashAssets(v.db, [Number(key)])
    await purgeAssets(v.db, v.layout.media, [Number(key)], async f => { fs.unlinkSync(f) })
    expect(v.db.prepare('SELECT parent_id FROM edit_copy WHERE asset_id = ?').get(copy)).toEqual({ parent_id: null })
    expect(fs.existsSync(path.join(v.layout.media, vaultFiles(v.db, copy)[0]!.path))).toBe(true)
  })

  it('shows both utility folders even when empty', () => {
    expect(vaultCollections(v.db).smart.filter(c => c.kind === 'utility').map(c => c.id)).toEqual(['hidden', 'deleted'])
  })
})

describe('edit input validation', () => {
  it('rejects invalid crops and time ranges', () => {
    expect(() => validateEdit({ ...DEFAULT_EDIT, crop: { x: 0.9, y: 0, width: 0.5, height: 1 } })).toThrow('Crop')
    expect(() => validateEdit({ ...DEFAULT_EDIT, start: 3, end: 2 })).toThrow('Invalid edit')
  })
  it('retains the colour profile for decoded HEIC photos', async () => {
    const p3 = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#237ad3' } }).withIccProfile('p3').png().toBuffer()
    const icc = (await sharp(p3).metadata()).icc!
    const box = Buffer.alloc(12); box.writeUInt32BE(12 + icc.length); box.write('colrprof', 4)
    const file = path.join(s.dir, 'profile.heic'); fs.writeFileSync(file, Buffer.concat([box, icc]))
    const data = await sharp(p3).keepIccProfile().ensureAlpha().raw().toBuffer()
    const result = await editPhoto({ file, mime: 'image/heic' }, DEFAULT_EDIT, { heic: { decode: async () => ({ data, width: 40, height: 30 }) } })
    expect((await sharp(result).metadata()).icc?.equals(icc)).toBe(true)
  })
})

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true }) } catch { hasFfmpeg = false }
describe('straighten and colour match the live preview', () => {
  const file = (name: string) => path.join(s.dir, name)

  it('turns clockwise for a positive angle, as CSS does in the editor', async () => {
    // A dark dot right of centre. Turned clockwise, it should move down.
    const dot = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#000' } }).png().toBuffer()
    await sharp({ create: { width: 400, height: 200, channels: 3, background: '#fff' } })
      .composite([{ input: dot, left: 285, top: 85 }]).jpeg({ quality: 95 }).toFile(file('dot.jpg'))
    const out = await editPhoto({ file: file('dot.jpg'), mime: 'image/jpeg' }, { ...DEFAULT_EDIT, straighten: 20 }, deps)
    const { data, info } = await sharp(out).greyscale().raw().toBuffer({ resolveWithObject: true })
    let sx = 0, sy = 0, n = 0
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (data[y * info.width + x]! < 80) { sx += x; sy += y; n++ }
    expect(n).toBeGreaterThan(100)
    expect(sy / n).toBeGreaterThan(info.height / 2 + 10)
    expect(sx / n).toBeGreaterThan(info.width / 2)
  })

  it('zooms just enough that no corner is left empty', async () => {
    await sharp({ create: { width: 400, height: 300, channels: 3, background: '#d23c28' } }).jpeg({ quality: 95 }).toFile(file('red.jpg'))
    for (const angle of [-45, -12, 7, 30, 45]) {
      const out = await editPhoto({ file: file('red.jpg'), mime: 'image/jpeg' }, { ...DEFAULT_EDIT, straighten: angle }, deps)
      const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
      for (const [x, y] of [[1, 1], [info.width - 2, 1], [1, info.height - 2], [info.width - 2, info.height - 2]]) {
        expect(data[(y! * info.width + x!) * 3]!).toBeGreaterThan(150)
      }
      expect(info.width / info.height).toBeCloseTo(400 / 300, 1)
    }
  })

  it('applies light and colour exactly as the shared formula says', async () => {
    const colours = [[200, 120, 40], [30, 60, 90], [128, 128, 128], [250, 250, 10]]
    const strip = await sharp(Buffer.from(colours.flat()), { raw: { width: 4, height: 1, channels: 3 } }).png().toFile(file('strip.png'))
    void strip
    const r = { ...DEFAULT_EDIT, exposure: 0.4, brightness: -0.2, contrast: 1.2, saturation: 1.4, warmth: 0.5, tint: -0.3 }
    const out = await editPhoto({ file: file('strip.png'), mime: 'image/png' }, r, deps)
    const got = await sharp(out).raw().toBuffer()
    const ops = colourOps(r)
    colours.forEach(([R, G, B], i) => {
      const want = applyColour(ops, [R! / 255, G! / 255, B! / 255]).map((v) => v * 255)
      // JPEG at quality 95 with full chroma: within a few levels.
      want.forEach((w, c) => expect(Math.abs(got[i * 3 + c]! - w)).toBeLessThan(6))
    })
  })

  it('brightens with exposure the way photo apps do: no clipping to white', () => {
    const up = { ...DEFAULT_EDIT, exposure: 1 }
    // A light sky gets brighter but keeps its detail; white stays white.
    expect(tone(up, 0.75, 1)).toBeGreaterThan(0.82)
    expect(tone(up, 0.75, 1)).toBeLessThan(0.97)
    expect(tone(up, 0.9, 1)).toBeLessThan(tone(up, 0.95, 1))
    expect(tone(up, 1, 1)).toBeCloseTo(1, 5)
    // Mid grey brightens noticeably, and darkening brings white down too.
    expect(tone(up, 0.46, 1)).toBeGreaterThan(0.58)
    expect(tone({ ...DEFAULT_EDIT, exposure: -1 }, 1, 1)).toBeLessThan(0.8)
    // Brightness lifts the middle and leaves the ends alone.
    const lift = { ...DEFAULT_EDIT, brightness: 0.5 }
    expect(tone(lift, 0.5, 0)).toBeGreaterThan(0.55)
    expect(tone(lift, 0, 0)).toBe(0)
    expect(tone(lift, 1, 0)).toBe(1)
  })
})

describe.skipIf(!hasFfmpeg)('video edits with real ffmpeg', () => {
  it('trims, crops, rotates and mutes a new video while preserving its source', async () => {
    const input = path.join(s.dir, 'input.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input], { windowsHide: true })
    const bytes = fs.readFileSync(input)
    const key = await add(bytes, true)
    const recipe = { ...structuredClone(DEFAULT_EDIT), rotation: 90 as const, crop: { x: 0, y: 0, width: 0.5, height: 1 }, start: 0.5, end: 1.8, mute: true }
    // Straighten and colour run through ffmpeg too.
    const tilted = { ...recipe, straighten: 8, warmth: 0.4, brightness: 0.1 }
    expect((await sharp(await editPreview({ file: input, mime: 'video/mp4' }, tilted, deps)).metadata()).format).toBe('jpeg')
    const preview = await editPreview({ file: input, mime: 'video/mp4' }, recipe, deps)
    expect((await sharp(preview).metadata()).format).toBe('jpeg')
    const copy = await saveEditedCopy(v, key, recipe, deps)
    const output = path.join(v.layout.media, vaultFiles(v.db, copy)[0]!.path)
    const info = await probe(output)
    expect(info.audio).toBeNull()
    expect(info.video?.codec).toBe('h264')
    expect(info.durationSec).toBeCloseTo(1.3, 1)
    expect(vaultItems(v.db, 'videos').find(i => i.key === copy)).toMatchObject({ w: 120, h: 320 })
    expect(fs.readFileSync(path.join(v.layout.media, vaultFiles(v.db, key)[0]!.path))).toEqual(bytes)
  })
})
