import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVault, type OpenVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveFile, type SaveItem } from '../src/vault/save.ts'
import { burstFrameCounts, keepBurstFrame, setBurstCover } from '../src/vault/burst.ts'
import { displayFile, vaultFiles, vaultItems } from '../src/gallery/vault-gallery.ts'
import { scratch, type Scratch } from './helpers.ts'

let s: Scratch
let v: OpenVault
beforeEach(() => { s = scratch(); v = createVault(path.join(s.dir, 'V')) })
afterEach(() => { v.db.close(); s.cleanup() })

const frameFile = async (name: string, colour: string): Promise<SaveFile> => {
  const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: colour } }).jpeg().toBuffer()
  return { name, role: 'master', mime: 'image/jpeg', size: bytes.length, sha256: null, read: async function* () { yield bytes } }
}

async function burst(): Promise<number> {
  const item: SaveItem = {
    key: 'b', kind: 'burst', t: Date.UTC(2026, 5, 8, 13, 4), off: 19800, w: 40, h: 30, dur: null, fav: false, edited: false,
    subtype: null, sourceUuid: 'burst-1', lat: 12.9, lon: 77.6, cloud: false,
    files: [await frameFile('IMG_0001.JPG', '#c33'), await frameFile('IMG_0002.JPG', '#3c3'), await frameFile('IMG_0003.JPG', '#33c')],
  }
  await saveToVault(v, [item], [{ uuid: 'trip', name: 'Trip', keys: ['b'] }])
  return Number(vaultItems(v.db, 'library')[0]!.key)
}

describe('bursts in a vault', () => {
  it('is one item with every frame, and a count for its badge', async () => {
    const id = await burst()
    expect(vaultItems(v.db, 'library')).toHaveLength(1)
    expect(vaultItems(v.db, 'library')[0]!.kind).toBe('burst')
    expect(burstFrameCounts(v.db, [id]).get(id)).toBe(3)
    expect(vaultFiles(v.db, String(id)).filter((f) => f.primary)).toHaveLength(1)
  })

  it('makes any frame the cover', async () => {
    const id = await burst()
    const third = vaultFiles(v.db, String(id)).find((f) => f.path.endsWith('IMG_0003.JPG'))!
    setBurstCover(v.db, id, third.id)
    expect(displayFile(vaultFiles(v.db, String(id)), null)?.id).toBe(third.id)
  })

  it('keeps a frame as its own photo, in the same albums, and the last frame ends the burst', async () => {
    const id = await burst()
    const files = vaultFiles(v.db, String(id))
    const kept = keepBurstFrame(v.db, id, files.find((f) => f.primary)!.id)
    const items = vaultItems(v.db, 'library')
    expect(items).toHaveLength(2)
    expect(items.find((i) => i.key === String(kept))).toMatchObject({ kind: 'photo', t: Date.UTC(2026, 5, 8, 13, 4) })
    expect(vaultItems(v.db, 'album:1').map((i) => i.key).sort()).toEqual([String(id), String(kept)].sort())
    // The burst still has a cover after losing its old one.
    expect(vaultFiles(v.db, String(id)).filter((f) => f.primary)).toHaveLength(1)
    keepBurstFrame(v.db, id, vaultFiles(v.db, String(id))[0]!.id)
    expect(vaultItems(v.db, 'library').find((i) => i.key === String(id))?.kind).toBe('photo')
    expect(() => keepBurstFrame(v.db, id, vaultFiles(v.db, String(id))[0]!.id)).toThrow()
  })

  it('refuses a frame that belongs to another item', async () => {
    const id = await burst()
    expect(() => setBurstCover(v.db, id, 99999)).toThrow('not part of this burst')
  })
})
