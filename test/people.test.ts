import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVault, type OpenVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'
import { clusterFaces } from '../src/search/cluster-core.mjs'
import type { ClusterInput, FaceResult, ReadFaces } from '../src/search/faces.ts'
import { forgetSearchData, searchVault } from '../src/search/index.ts'
import { checkGroups } from '../src/people/objects.ts'
import type { Embed } from '../src/search/embedder.ts'
import {
  answerSuggestion, evictStrays, getPerson, hidePerson, mergeLookalikes, sideOn, suggestions, setKind, listPeople, namePerson, peopleInQuery, personAssetIds, removeFromPerson, settlePeople, storeFaces,
} from '../src/people/people.ts'
import { scratch, type Scratch } from './helpers.ts'

/**
 * People without the face models: each "person" is a direction in face space,
 * and a photo's faces are that direction with a little noise, so who is who is
 * known. Grouping runs the real clustering code.
 */

let s: Scratch
let v: OpenVault
let ids: number[]

function face(who: number, jitter: number): Float32Array {
  const vec = new Float32Array(128)
  vec[who] = 1
  vec[(who + 7) % 128] = jitter
  vec[(who + 13) % 128] = -jitter / 2
  const len = Math.hypot(...vec)
  return vec.map((x) => x / len)
}

function found(...people: [number, number][]): FaceResult {
  return {
    width: 1000,
    height: 800,
    faces: people.map(([who, jitter], i) => ({
      box: [100 + i * 300, 200, 160, 200], landmarks: [[150, 280], [210, 280], [180, 320], [155, 350], [205, 350]],
      score: 0.95, sharpness: 300, vec: face(who, jitter),
    })),
  }
}

const reader: ReadFaces = {
  read: async () => { throw new Error('not used') },
  cluster: async (input: ClusterInput) => clusterFaces(input),
}

beforeEach(async () => {
  s = scratch()
  v = createVault(path.join(s.dir, 'V'))
  const items: SaveItem[] = []
  for (let i = 0; i < 8; i++) {
    const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: `#${(i * 30 + 16).toString(16).padStart(2, '0')}8080` } }).jpeg().toBuffer()
    items.push({
      key: `p${i}`, kind: 'photo', t: Date.UTC(2026, 0, 1 + i), off: 0, w: 64, h: 48, dur: null, fav: false, edited: false,
      subtype: null, sourceUuid: `p${i}`, lat: null, lon: null, cloud: false,
      files: [{ name: `p${i}.jpg`, role: 'master', mime: 'image/jpeg', size: bytes.length, sha256: null, read: async function* () { yield bytes } }],
    })
  }
  const r = await saveToVault(v, items, [])
  ids = items.map((it) => r.assets[it.key]!)
  // Person 1 in photos 0 to 4, person 2 in photos 3 to 6, someone in photo 7 only.
  for (let i = 0; i <= 7; i++) {
    const people: [number, number][] = []
    if (i <= 4) people.push([1, 0.1 + i * 0.05])
    if (i >= 3 && i <= 6) people.push([2, 0.12 + i * 0.03])
    if (i === 7) people.push([3, 0.1])
    storeFaces(v.db, ids[i]!, found(...people))
  }
})

afterEach(() => {
  v.db.close()
  s.cleanup()
})

describe('people', () => {
  it('groups faces into people, one per person, and leaves a face seen once alone', async () => {
    expect(await settlePeople(v.db, reader)).toEqual({ joined: 0, created: 2, merged: 0 })
    const people = listPeople(v.db)
    expect(people.map((p) => p.photos).sort()).toEqual([4, 5])
    expect(people.every((p) => p.name === null && p.cover !== null)).toBe(true)
    const one = people.find((p) => p.photos === 5)!
    expect(personAssetIds(v.db, one.id)).toEqual(ids.slice(0, 5))
    // Nothing new: a second pass changes nothing.
    expect(await settlePeople(v.db, reader)).toEqual({ joined: 0, created: 0, merged: 0 })
  })

  it('puts a new photo of someone with them', async () => {
    await settlePeople(v.db, reader)
    const alice = listPeople(v.db).find((p) => p.photos === 5)!
    storeFaces(v.db, ids[7]!, found([3, 0.1], [1, 0.3]))
    expect(await settlePeople(v.db, reader)).toEqual({ joined: 1, created: 0, merged: 0 })
    expect(getPerson(v.db, alice.id)!.photos).toBe(6)
  })

  it('names people, and naming two the same merges them', async () => {
    await settlePeople(v.db, reader)
    const [a, b] = listPeople(v.db)
    expect(namePerson(v.db, a!.id, '  Aai  ')).toEqual({ person: a!.id, merged: false })
    expect(getPerson(v.db, a!.id)!.name).toBe('Aai')
    // Same name, any case: b's photos join a.
    expect(namePerson(v.db, b!.id, 'aai')).toEqual({ person: a!.id, merged: true })
    expect(getPerson(v.db, b!.id)).toBeNull()
    expect(getPerson(v.db, a!.id)!.photos).toBe(7)
    // Empty clears the name.
    namePerson(v.db, a!.id, '')
    expect(getPerson(v.db, a!.id)!.name).toBeNull()
  })

  it('keeps a photo out of someone once told it is not them', async () => {
    await settlePeople(v.db, reader)
    const alice = listPeople(v.db).find((p) => p.photos === 5)!
    expect(removeFromPerson(v.db, alice.id, [ids[0]!])).toBe(1)
    expect(getPerson(v.db, alice.id)!.photos).toBe(4)
    await settlePeople(v.db, reader)
    expect(personAssetIds(v.db, alice.id)).not.toContain(ids[0])
  })

  it('hides someone from the list without losing them', async () => {
    await settlePeople(v.db, reader)
    const [a] = listPeople(v.db)
    hidePerson(v.db, a!.id, true)
    expect(listPeople(v.db).map((p) => p.id)).not.toContain(a!.id)
    expect(listPeople(v.db, { includeHidden: true }).map((p) => p.id)).toContain(a!.id)
    // Naming brings them back.
    namePerson(v.db, a!.id, 'Ravi')
    expect(listPeople(v.db).map((p) => p.id)).toContain(a!.id)
  })

  it('forgets faces of hidden photos', async () => {
    await settlePeople(v.db, reader)
    const alice = listPeople(v.db).find((p) => p.photos === 5)!
    v.db.prepare(`UPDATE asset SET hidden = 1 WHERE id = ?`).run(ids[1])
    forgetSearchData(v.db, [ids[1]!])
    expect(v.db.prepare(`SELECT COUNT(*) AS n FROM face WHERE asset_id = ?`).get(ids[1])).toEqual({ n: 0 })
    expect(getPerson(v.db, alice.id)!.photos).toBe(4)
  })

  it('finds named people in a search, alone or with other words', async () => {
    await settlePeople(v.db, reader)
    const [a, b] = listPeople(v.db)
    namePerson(v.db, a!.id, 'Aai')
    namePerson(v.db, b!.id, 'Ravi Kumar')
    expect(peopleInQuery(v.db, "ravi kumar's birthday with aai")).toEqual({ ids: [b!.id, a!.id], names: ['Ravi Kumar', 'Aai'], rest: 'birthday with' })
    expect(peopleInQuery(v.db, 'aaiza').ids).toEqual([])
    // A name alone: all their photos, newest first.
    expect(searchVault(v.db, null, 'aai').map((h) => h.assetId)).toEqual(personAssetIds(v.db, a!.id).reverse())
    // Two names: only photos with both.
    const both = searchVault(v.db, null, 'aai and ravi kumar').map((h) => h.assetId).sort()
    const together = personAssetIds(v.db, a!.id).filter((x) => personAssetIds(v.db, b!.id).includes(x)).sort()
    expect(both).toEqual(together)
    expect(together.length).toBe(2)
  })

  it('tells a face looking at the camera from one seen side-on', () => {
    expect(sideOn(JSON.stringify([[0.4, 0.4], [0.6, 0.4], [0.5, 0.5]]))).toBeCloseTo(0)
    expect(sideOn(JSON.stringify([[0.4, 0.4], [0.5, 0.4], [0.62, 0.5]]))).toBeGreaterThan(0.6)
    expect(sideOn('not json')).toBe(Infinity)
  })

  it('puts one person split into two groups back together, and never two named people', async () => {
    await settlePeople(v.db, reader)
    const [a, b] = listPeople(v.db)
    // Make b look just like a: their faces all point a's way.
    const aFaces = v.db.prepare(`SELECT vec FROM face WHERE person_id = ? LIMIT 1`).get(a!.id) as { vec: Buffer }
    v.db.prepare(`UPDATE face SET vec = ? WHERE person_id = ?`).run(aFaces.vec, b!.id)
    namePerson(v.db, a!.id, 'Aai')
    namePerson(v.db, b!.id, 'Baba')
    expect(mergeLookalikes(v.db)).toBe(0)
    namePerson(v.db, b!.id, '')
    expect(mergeLookalikes(v.db)).toBe(1)
    expect(getPerson(v.db, b!.id)).toBeNull()
    expect(getPerson(v.db, a!.id)!.name).toBe('Aai')
  })

  it('asks about groups that only might be one person, and remembers the answer', async () => {
    await settlePeople(v.db, reader)
    const [a, b] = listPeople(v.db)
    // Half-way between the two directions: alike, not certain.
    const mix = new Float32Array(128)
    mix[1] = 1
    mix[2] = 1.2
    const len = Math.hypot(...mix)
    const vec = Buffer.from(mix.map((x) => x / len).buffer)
    v.db.prepare(`UPDATE face SET vec = ? WHERE person_id = ?`).run(vec, b!.id)
    const asked = suggestions(v.db)
    expect(asked.map((s) => [s.person, s.other].sort())).toEqual([[a!.id, b!.id].sort()])
    answerSuggestion(v.db, a!.id, b!.id, false)
    expect(suggestions(v.db)).toEqual([])
    expect(mergeLookalikes(v.db)).toBe(0)
    expect(answerSuggestion(v.db, a!.id, b!.id, true)).toBe(b!.id)
    expect(listPeople(v.db)).toHaveLength(1)
  })

  it('takes faces far from their person back out', async () => {
    await settlePeople(v.db, reader)
    const alice = listPeople(v.db).find((p) => p.photos === 5)!
    // A big group, then one face in it that is someone else entirely.
    for (let i = 0; i < 6; i++) {
      v.db.prepare(`INSERT INTO face (asset_id, x, y, w, h, landmarks, score, sharpness, vec, person_id) SELECT asset_id, x, y, w, h, landmarks, score, sharpness, vec, person_id FROM face WHERE person_id = ? LIMIT 1`).run(alice.id)
    }
    const stranger = Buffer.from(face(90, 0).buffer)
    const odd = v.db.prepare(`SELECT id FROM face WHERE person_id = ? AND asset_id = ?`).get(alice.id, ids[2]) as { id: number }
    v.db.prepare(`UPDATE face SET vec = ? WHERE id = ?`).run(stranger, odd.id)
    expect(evictStrays(v.db)).toBe(1)
    expect(v.db.prepare(`SELECT person_id FROM face WHERE id = ?`).get(odd.id)).toEqual({ person_id: null })
  })

  it('hides a group the search model sees as a statue or drawing, and keeps real people', async () => {
    await settlePeople(v.db, reader)
    const [a, b] = listPeople(v.db)
    // Thumbnails for the faces to be cut from.
    const { queueThumbnails, runThumbnails } = await import('../src/thumbs/jobs.ts')
    const { JobQueue } = await import('../src/jobs/queue.ts')
    const q = new JobQueue(v.db)
    queueThumbnails(v.db, q, v.layout.cache)
    await runThumbnails(v.db, q, v.layout.media, v.layout.cache, { heic: { decode: async () => { throw new Error('none') } } }, { concurrency: 2 })
    // Text "made" prompts point one way, "real" another; a's crops look made.
    const made = new Float32Array(256); made[0] = 1
    const real = new Float32Array(256); real[1] = 1
    const embed: Embed = {
      query: async (t) => (/statue|sculpture|cartoon|painting|carved|mascot|printed|doll/.test(t) ? made : real),
      image: async (file) => {
        const faceId = Number(path.basename(file).split('.')[0])
        const owner = (v.db.prepare(`SELECT person_id FROM face WHERE id = ?`).get(faceId) as { person_id: number }).person_id
        return owner === a!.id ? made : real
      },
    }
    expect(await checkGroups(v.db, v.layout.cache, embed)).toEqual([a!.id])
    expect(listPeople(v.db).map((p) => p.id)).toEqual([b!.id])
    expect(listPeople(v.db, { includeHidden: true }).find((p) => p.id === a!.id)).toMatchObject({ kind: 'object', hidden: true })
    // Checked once: nothing to do the second time.
    expect(await checkGroups(v.db, v.layout.cache, embed)).toEqual([])
    // "It's a real person" puts them back.
    hidePerson(v.db, a!.id, false)
    expect(listPeople(v.db).find((p) => p.id === a!.id)).toMatchObject({ kind: 'person', hidden: false })
    void setKind
  })
})
