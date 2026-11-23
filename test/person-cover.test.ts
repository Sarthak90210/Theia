import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVault, type OpenVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'
import type { FaceResult } from '../src/search/faces.ts'
import { clusterFaces } from '../src/search/cluster-core.mjs'
import { listPeople, personFaceIn, personFaces, removeFromPerson, setPersonCover, settlePeople, storeFaces } from '../src/people/people.ts'
import { scratch, type Scratch } from './helpers.ts'

/** Choosing the photo shown for someone in People. */

let s: Scratch
let v: OpenVault
let ids: number[]

function face(who: number, jitter: number): Float32Array {
  const vec = new Float32Array(128)
  vec[who] = 1
  vec[(who + 7) % 128] = jitter
  const len = Math.hypot(...vec)
  return vec.map((x) => x / len)
}
/** One face; `size` sets how big, which the automatic choice prefers. */
const found = (who: number, size: number): FaceResult => ({
  width: 1000, height: 800,
  faces: [{ box: [100, 100, size, size], landmarks: [[150, 180], [210, 180], [180, 220], [155, 250], [205, 250]], score: 0.95, sharpness: 300, vec: face(who, 0.1 + size / 10000) }],
})

beforeEach(async () => {
  s = scratch()
  v = createVault(path.join(s.dir, 'V'))
  const items: SaveItem[] = []
  for (let i = 0; i < 5; i++) {
    const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: `#${(i * 40 + 16).toString(16).padStart(2, '0')}7070` } }).jpeg().toBuffer()
    items.push({
      key: `p${i}`, kind: 'photo', t: Date.UTC(2026, 0, 1 + i), off: 0, w: 64, h: 48, dur: null, fav: false, edited: false,
      subtype: null, sourceUuid: `p${i}`, lat: null, lon: null, cloud: false,
      files: [{ name: `p${i}.jpg`, role: 'master', mime: 'image/jpeg', size: bytes.length, sha256: null, read: async function* () { yield bytes } }],
    })
  }
  const r = await saveToVault(v, items, [])
  ids = items.map((it) => r.assets[it.key]!)
  // Asha in photos 0 to 3, biggest in photo 3; someone else in photo 4.
  ids.slice(0, 4).forEach((id, i) => storeFaces(v.db, id, found(1, 100 + i * 50)))
  storeFaces(v.db, ids[4]!, found(40, 300))
  await settlePeople(v.db, { read: async () => { throw new Error('unused') }, cluster: async (x) => clusterFaces(x) })
})
afterEach(() => {
  ashaId = 0
  v.db.close()
  s.cleanup()
})

let ashaId = 0
/** Asha: whoever has photo 0's face. */
const asha = () => {
  ashaId ||= (v.db.prepare('SELECT person_id FROM face WHERE asset_id = ?').get(ids[0]) as { person_id: number }).person_id
  return listPeople(v.db).find((p) => p.id === ashaId)!
}
const faceIn = (assetId: number) => (v.db.prepare('SELECT id FROM face WHERE asset_id = ?').get(assetId) as { id: number }).id

describe("choosing someone's photo", () => {
  it('shows the largest clear face by itself, and the chosen one once chosen', () => {
    expect(asha().cover).toBe(faceIn(ids[3]!))
    setPersonCover(v.db, asha().id, faceIn(ids[0]!))
    expect(asha().cover).toBe(faceIn(ids[0]!))
    expect(personFaces(v.db, asha().id).map((f) => f.assetId)).toEqual([ids[3], ids[2], ids[1], ids[0]])
  })

  it('picks their face in a photo, and refuses a face that is not theirs', () => {
    const p = asha()
    expect(personFaceIn(v.db, p.id, ids[1]!)).toBe(faceIn(ids[1]!))
    expect(personFaceIn(v.db, p.id, ids[4]!)).toBeNull()
    expect(() => setPersonCover(v.db, p.id, faceIn(ids[4]!))).toThrow(/isn’t one of theirs/)
    v.db.prepare('UPDATE asset SET hidden = 1 WHERE id = ?').run(ids[2])
    expect(() => setPersonCover(v.db, p.id, faceIn(ids[2]!))).toThrow(/isn’t one of theirs/)
  })

  it('goes back to choosing by itself when the chosen photo leaves them, or when asked', () => {
    const p = asha()
    setPersonCover(v.db, p.id, faceIn(ids[0]!))
    removeFromPerson(v.db, p.id, [ids[0]!])
    expect(asha().cover).toBe(faceIn(ids[3]!))
    setPersonCover(v.db, p.id, faceIn(ids[1]!))
    v.db.prepare('UPDATE asset SET hidden = 1 WHERE id = ?').run(ids[1])
    expect(asha().cover).toBe(faceIn(ids[3]!))
    v.db.prepare('UPDATE asset SET hidden = 0 WHERE id = ?').run(ids[1])
    expect(asha().cover).toBe(faceIn(ids[1]!))
    setPersonCover(v.db, p.id, null)
    expect(asha().cover).toBe(faceIn(ids[3]!))
  })
})
