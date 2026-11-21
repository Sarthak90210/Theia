import type { Db } from '../library/db.ts'
import type { FaceResult, ReadFaces } from '../search/faces.ts'
import { FACE_KEY } from '../search/face-model.ts'

/**
 * People in a vault: faces found in photos (src/search/face-core.mjs),
 * grouped by likeness (cluster-core.mjs) into people that someone can name.
 *
 * Grouping is conservative, and only ever adds: a face already in a person is
 * never moved by it. Naming two people the same merges them; "not this
 * person" takes a photo out and keeps it out. Everything lives in the vault's
 * library.db, and nothing about hidden or deleted items is kept.
 */

/** Faces less sharp than this are kept for the record but never grouped: they describe poorly. */
export const MIN_SHARPNESS = 40
/** How alike two faces must be to group them (cosine of SFace vectors). Tuned on a real library; see docs/05-search.md. */
export const SAME_PERSON = 0.55
/**
 * How alike faces must be to start a new group together: stricter than
 * joining someone, because in one pass over a whole library look-alike people
 * chain together at 0.55 (one group of 789 photos of several young men); at
 * 0.6 the same library's largest group was one person throughout.
 */
export const GROUP_START = 0.6
/** A group seen in fewer photos than this waits for more before it is shown. */
export const MIN_PHOTOS = 3
/**
 * Two groups whose average faces are this alike are one person, merged
 * without asking. Measured on a real library: groups of one person split
 * apart scored 0.79 to 0.95; groups of different people at most 0.71.
 */
export const SAME_GROUP = 0.75
/** Below SAME_GROUP but this alike: ask "Same person?". */
export const MAYBE_SAME_GROUP = 0.55
/**
 * How far the nose sits from the middle of the eyes, in eye widths, beyond
 * which a face is side-on. Faces looking at the camera measured under 0.35.
 */
export const SIDE_ON = 0.6
/**
 * A face this far from its person's average face is taken back out: grouping
 * once let in faces that matched three of a big group's faces by chance.
 * Faces of the person themselves measured above 0.44 in 99 cases of 100.
 */
export const STRAY = 0.4

const VISIBLE = 'a.hidden = 0 AND a.deleted_at IS NULL'

/** Replace an asset's faces with what was just found, as fractions of the image. */
export function storeFaces(db: Db, assetId: number, r: FaceResult): void {
  const del = db.prepare(`DELETE FROM face WHERE asset_id = ?`)
  const put = db.prepare(
    `INSERT INTO face (asset_id, x, y, w, h, landmarks, score, sharpness, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const scan = db.prepare(`INSERT OR REPLACE INTO face_scan (asset_id, model) VALUES (?, ?)`)
  const W = r.width || 1
  const H = r.height || 1
  db.transaction(() => {
    del.run(assetId)
    for (const f of r.faces) {
      const [x, y, w, h] = f.box
      const landmarks = JSON.stringify(f.landmarks.map(([lx, ly]) => [round(lx / W), round(ly / H)]))
      put.run(assetId, round(x / W), round(y / H), round(w / W), round(h / H), landmarks, f.score, f.sharpness,
        Buffer.from(f.vec.buffer, f.vec.byteOffset, f.vec.byteLength))
    }
    scan.run(assetId, FACE_KEY)
  })()
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000
}

/** Erase faces of assets just hidden or deleted. They are looked at again if they come back. */
export function forgetFaces(db: Db, assetIds: number[]): void {
  const faces = db.prepare(`DELETE FROM face WHERE asset_id = ?`)
  const scan = db.prepare(`DELETE FROM face_scan WHERE asset_id = ?`)
  db.transaction(() => {
    for (const id of assetIds) {
      faces.run(id)
      scan.run(id)
    }
    dropEmpty(db)
  })()
}

/** Everything about faces and people, for when face grouping is switched off. */
export function eraseFaces(db: Db): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM face_not`).run()
    db.prepare(`DELETE FROM face`).run()
    db.prepare(`DELETE FROM face_scan`).run()
    db.prepare(`DELETE FROM person`).run()
    db.prepare(`DELETE FROM job WHERE kind = 'faces'`).run()
  })()
}

/** Unnamed people left with no faces at all go; named ones stay, in case their photos come back. */
function dropEmpty(db: Db): void {
  db.prepare(`DELETE FROM person WHERE name IS NULL AND NOT EXISTS (SELECT 1 FROM face f WHERE f.person_id = person.id)`).run()
}

/**
 * Put ungrouped faces with the people they look like, and make new people of
 * new groups. Returns how many faces joined someone and how many people are new.
 */
export async function settlePeople(db: Db, reader: ReadFaces): Promise<{ joined: number; created: number; merged: number }> {
  type Row = { id: number; asset_id: number; person_id: number | null; vec: Buffer; landmarks: string }
  const rows = db
    .prepare(
      `SELECT f.id, f.asset_id, f.person_id, f.vec, f.landmarks FROM face f JOIN asset a ON a.id = f.asset_id
        WHERE ${VISIBLE} AND (f.person_id IS NOT NULL OR f.sharpness >= ?)`,
    )
    .all(MIN_SHARPNESS) as Row[]
  const free = rows.filter((r) => r.person_id === null)
  const held = rows.filter((r) => r.person_id !== null)
  if (!free.length) {
    evictStrays(db)
    return { joined: 0, created: 0, merged: mergeLookalikes(db) }
  }
  const pack = (list: Row[]) => {
    const out = new Float32Array(list.length * 128)
    list.forEach((r, i) => out.set(new Float32Array(r.vec.buffer, r.vec.byteOffset, 128), i * 128))
    return out
  }
  const index = new Map(free.map((r, i) => [r.id, i]))
  const rejects = (db.prepare(`SELECT face_id, person_id FROM face_not`).all() as { face_id: number; person_id: number }[])
    .filter((r) => index.has(r.face_id))
    .map((r) => [index.get(r.face_id)!, r.person_id] as [number, number])

  const result = await reader.cluster({
    free: pack(free),
    freeAsset: Int32Array.from(free.map((r) => r.asset_id)),
    held: pack(held),
    heldAsset: Int32Array.from(held.map((r) => r.asset_id)),
    heldPerson: Int32Array.from(held.map((r) => r.person_id!)),
    rejects,
    threshold: SAME_PERSON,
    groupThreshold: GROUP_START,
    minPhotos: MIN_PHOTOS,
    frontal: Uint8Array.from(free.map((r) => (sideOn(r.landmarks) <= SIDE_ON ? 1 : 0))),
  })

  // The grid may have changed while the worker was busy: only faces still
  // ungrouped, in visible assets, of people who still exist, are placed.
  let joined = 0
  let created = 0
  const now = Date.now()
  const join = db.prepare(
    `UPDATE face SET person_id = ? WHERE id = ? AND person_id IS NULL
        AND EXISTS (SELECT 1 FROM person p WHERE p.id = ?)
        AND EXISTS (SELECT 1 FROM asset a WHERE a.id = face.asset_id AND ${VISIBLE})`,
  )
  const newPerson = db.prepare(`INSERT INTO person (name, created_at, updated_at) VALUES (NULL, ?, ?)`)
  db.transaction(() => {
    free.forEach((r, i) => {
      const p = result.person[i]!
      if (p >= 0) joined += join.run(p, r.id, p).changes
    })
    const groups = new Map<number, number[]>()
    free.forEach((r, i) => {
      const g = result.group[i]!
      if (g < 0) return
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g)!.push(r.id)
    })
    for (const faces of groups.values()) {
      const person = Number(newPerson.run(now, now).lastInsertRowid)
      let placed = 0
      for (const f of faces) placed += join.run(person, f, person).changes
      if (placed) created++
    }
    dropEmpty(db)
  })()
  evictStrays(db)
  return { joined, created, merged: mergeLookalikes(db) }
}

/** Faces far from their person's average face go back to ungrouped. Returns how many. */
export function evictStrays(db: Db): number {
  let evicted = 0
  const free = db.prepare(`UPDATE face SET person_id = NULL WHERE id = ?`)
  const rows = db
    .prepare(`SELECT f.id, f.person_id, f.vec FROM face f JOIN asset a ON a.id = f.asset_id WHERE f.person_id IS NOT NULL AND ${VISIBLE}`)
    .all() as { id: number; person_id: number; vec: Buffer }[]
  const byPerson = new Map<number, { id: number; v: Float32Array }[]>()
  for (const r of rows) {
    if (!byPerson.has(r.person_id)) byPerson.set(r.person_id, [])
    byPerson.get(r.person_id)!.push({ id: r.id, v: new Float32Array(r.vec.buffer, r.vec.byteOffset, 128) })
  }
  db.transaction(() => {
    for (const faces of byPerson.values()) {
      // A small group's average is mostly its own faces; judge only groups big enough to have a stable one.
      if (faces.length < 10) continue
      const c = new Float32Array(128)
      for (const f of faces) for (let i = 0; i < 128; i++) c[i]! += f.v[i]!
      const n = Math.hypot(...c) || 1
      for (let i = 0; i < 128; i++) c[i]! /= n
      for (const f of faces) if (dot(f.v, c) < STRAY) evicted += free.run(f.id).changes
    }
  })()
  return evicted
}

/** How side-on a face is: the nose's distance from the middle of the eyes, along the eyes, in eye widths. */
export function sideOn(landmarks: string): number {
  try {
    const [e0, e1, nose] = JSON.parse(landmarks) as [number, number][]
    const ex = e1![0] - e0![0]
    const ey = e1![1] - e0![1]
    const d2 = ex * ex + ey * ey
    if (!d2) return Infinity
    const mx = (e0![0] + e1![0]) / 2
    const my = (e0![1] + e1![1]) / 2
    return Math.abs(((nose![0] - mx) * ex + (nose![1] - my) * ey) / d2)
  } catch {
    return Infinity
  }
}

interface Group {
  id: number
  name: string | null
  hidden: boolean
  faces: Float32Array[]
  centre: Float32Array
}

/** Each person's clear, frontal faces in visible photos, and their average direction. */
function groups(db: Db): Map<number, Group> {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.hidden, f.vec, f.landmarks FROM person p
         JOIN face f ON f.person_id = p.id JOIN asset a ON a.id = f.asset_id
        WHERE ${VISIBLE} AND f.sharpness >= ?`,
    )
    .all(MIN_SHARPNESS) as { id: number; name: string | null; hidden: number; vec: Buffer; landmarks: string }[]
  const out = new Map<number, Group>()
  for (const r of rows) {
    if (sideOn(r.landmarks) > SIDE_ON) continue
    let g = out.get(r.id)
    if (!g) out.set(r.id, (g = { id: r.id, name: r.name, hidden: r.hidden === 1, faces: [], centre: new Float32Array(128) }))
    g.faces.push(new Float32Array(r.vec.buffer, r.vec.byteOffset, 128))
  }
  for (const g of out.values()) centre(g)
  return out
}

function centre(g: Group): void {
  const c = new Float32Array(128)
  for (const f of g.faces) for (let i = 0; i < 128; i++) c[i]! += f[i]!
  const n = Math.hypot(...c) || 1
  for (let i = 0; i < 128; i++) c[i]! /= n
  g.centre = c
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < 128; i++) s += a[i]! * b[i]!
  return s
}

/** Mean likeness over every pair of faces from the two groups: a check that a high centre score is not one odd face. */
function linkage(a: Group, b: Group): number {
  let s = 0
  for (const x of a.faces) for (const y of b.faces) s += dot(x, y)
  return s / (a.faces.length * b.faces.length || 1)
}

function differentPairs(db: Db): Set<string> {
  return new Set((db.prepare(`SELECT a, b FROM person_not`).all() as { a: number; b: number }[]).map((r) => pairKey(r.a, r.b)))
}

const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`)

/**
 * One person split into several groups (different glasses, hair, light) is
 * put back together when the groups' average faces are clearly alike. Never
 * two named people, never a pair someone said are different. Named people
 * keep their name; a group someone hid stays hidden. Returns how many merged.
 */
export function mergeLookalikes(db: Db): number {
  const all = groups(db)
  const different = differentPairs(db)
  let merged = 0
  for (;;) {
    let best: [Group, Group, number] | null = null
    const list = [...all.values()]
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!, b = list[j]!
        if (a.name !== null && b.name !== null) continue
        if (different.has(pairKey(a.id, b.id))) continue
        const s = dot(a.centre, b.centre)
        if (s >= SAME_GROUP && (!best || s > best[2]) && linkage(a, b) >= 0.4) best = [a, b, s]
      }
    }
    if (!best) return merged
    const [a, b] = best
    // Into the named one, else the one someone hid, else the bigger one.
    const into = a.name !== null ? a : b.name !== null ? b : a.hidden !== b.hidden ? (a.hidden ? a : b) : a.faces.length >= b.faces.length ? a : b
    const from = into === a ? b : a
    mergePeople(db, from.id, into.id, { keepHidden: true })
    into.faces.push(...from.faces)
    centre(into)
    all.delete(from.id)
    merged++
  }
}

export interface Suggestion {
  /** The group to ask about, never named. */
  person: number
  /** Who they might be: named, or another unnamed group. */
  other: number
  score: number
}

/**
 * Groups that might be the same person as someone else, to ask about: an
 * unnamed, shown group and its most alike other shown person, between
 * MAYBE_SAME_GROUP and SAME_GROUP, not already answered. Each group at most once.
 */
export function suggestions(db: Db, limit = 12): Suggestion[] {
  const all = [...groups(db).values()].filter((g) => !g.hidden)
  const different = differentPairs(db)
  const kinds = new Map((db.prepare(`SELECT id, kind FROM person`).all() as { id: number; kind: string }[]).map((r) => [r.id, r.kind]))
  const out: Suggestion[] = []
  const asked = new Set<number>()
  const candidates: Suggestion[] = []
  for (const a of all) {
    if (a.name !== null || kinds.get(a.id) === 'object') continue
    for (const b of all) {
      if (a === b || kinds.get(b.id) === 'object' || different.has(pairKey(a.id, b.id))) continue
      const s = dot(a.centre, b.centre)
      if (s >= MAYBE_SAME_GROUP && s < SAME_GROUP) candidates.push({ person: a.id, other: b.id, score: s })
    }
  }
  for (const c of candidates.sort((x, y) => y.score - x.score)) {
    if (asked.has(c.person) || asked.has(c.other)) continue
    asked.add(c.person)
    asked.add(c.other)
    out.push({ ...c, score: Math.round(c.score * 1000) / 1000 })
    if (out.length >= limit) break
  }
  return out
}

/** The answer to "Same person?". Same merges (into the named one); different is remembered. */
export function answerSuggestion(db: Db, a: number, b: number, same: boolean): number {
  if (!same) {
    db.prepare(`INSERT OR IGNORE INTO person_not (a, b) VALUES (?, ?)`).run(Math.min(a, b), Math.max(a, b))
    return a
  }
  const named = db.prepare(`SELECT id, name FROM person WHERE id IN (?, ?)`).all(a, b) as { id: number; name: string | null }[]
  if (named.length !== 2) throw new Error('That person is not in this vault any more.')
  if (named.every((p) => p.name !== null)) throw new Error('Both have names already. Rename one to the other\u2019s name to put them together.')
  const into = named.find((p) => p.name !== null)?.id ?? b
  mergePeople(db, into === a ? b : a, into)
  return into
}

/** Groups not yet checked for being a statue, carving or drawing, and up to `n` of their clearest frontal faces each. */
export function uncheckedGroups(db: Db, n = 5): { person: number; faces: number[] }[] {
  const people = db.prepare(`SELECT id FROM person WHERE checked = 0 AND name IS NULL`).all() as { id: number }[]
  const faces = db.prepare(
    `SELECT f.id, f.landmarks FROM face f JOIN asset a ON a.id = f.asset_id
      WHERE f.person_id = ? AND ${VISIBLE} AND f.sharpness >= ? ORDER BY f.sharpness * f.w * f.h DESC LIMIT 20`,
  )
  return people.map((p) => ({
    person: p.id,
    faces: (faces.all(p.id, MIN_SHARPNESS) as { id: number; landmarks: string }[]).filter((f) => sideOn(f.landmarks) <= SIDE_ON).slice(0, n).map((f) => f.id),
  }))
}

/** Record what a group is. An object (statue, drawing) is hidden, so it is not asked about. */
export function setKind(db: Db, id: number, kind: 'person' | 'object'): void {
  db.prepare(`UPDATE person SET kind = ?, checked = 1, hidden = CASE WHEN ? = 'object' THEN 1 ELSE hidden END, updated_at = ? WHERE id = ?`)
    .run(kind, kind, Date.now(), id)
}

export interface PersonInfo {
  id: number
  name: string | null
  hidden: boolean
  /** 'object' for a statue, carving or drawing, found by the search model. */
  kind: 'person' | 'object'
  /** Visible photos with this person in them. */
  photos: number
  /** The face to show for them: the largest clear one. */
  cover: number | null
}

/** Named people first, most photographed first; then people not yet named. */
export function listPeople(db: Db, opts: { includeHidden?: boolean } = {}): PersonInfo[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.hidden, p.kind,
              COUNT(DISTINCT f.asset_id) AS photos,
              (SELECT f2.id FROM face f2 JOIN asset a2 ON a2.id = f2.asset_id
                WHERE f2.person_id = p.id AND a2.hidden = 0 AND a2.deleted_at IS NULL
                ORDER BY (f2.sharpness >= ${MIN_SHARPNESS}) DESC, f2.w * f2.h * f2.score DESC LIMIT 1) AS cover
         FROM person p
         JOIN face f ON f.person_id = p.id
         JOIN asset a ON a.id = f.asset_id AND ${VISIBLE}
        ${opts.includeHidden ? '' : 'WHERE p.hidden = 0'}
        GROUP BY p.id
       HAVING photos > 0
        ORDER BY p.name IS NULL, photos DESC, p.name COLLATE NOCASE`,
    )
    .all() as { id: number; name: string | null; hidden: number; kind: string; photos: number; cover: number | null }[]
  return rows.map((r) => ({ id: r.id, name: r.name, hidden: r.hidden === 1, kind: r.kind === 'object' ? 'object' : 'person', photos: r.photos, cover: r.cover }))
}

export function getPerson(db: Db, id: number): PersonInfo | null {
  return listPeople(db, { includeHidden: true }).find((p) => p.id === id) ?? null
}

/** Visible assets with this person in them, oldest first like the Library, so the grid opens on the newest. */
export function personAssetIds(db: Db, personId: number): number[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT a.id FROM face f JOIN asset a ON a.id = f.asset_id
          WHERE f.person_id = ? AND ${VISIBLE}
          ORDER BY COALESCE(a.captured_utc, a.created_at), a.id`,
      )
      .all(personId) as { id: number }[]
  ).map((r) => r.id)
}

/**
 * Name someone, rename them, or clear the name (empty). A name another
 * person already has merges the two, and the other one stays: naming a new
 * group "Mom" adds those photos to Mom. Returns the person the faces are with now.
 */
export function namePerson(db: Db, id: number, name: string): { person: number; merged: boolean } {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 80)
  if (!db.prepare(`SELECT 1 FROM person WHERE id = ?`).get(id)) throw new Error('That person is not in this vault any more.')
  if (clean) {
    const same = db.prepare(`SELECT id FROM person WHERE id != ? AND name = ? COLLATE NOCASE`).get(id, clean) as { id: number } | undefined
    if (same) {
      mergePeople(db, id, same.id)
      return { person: same.id, merged: true }
    }
  }
  db.prepare(`UPDATE person SET name = ?, hidden = 0, kind = 'person', checked = 1, updated_at = ? WHERE id = ?`).run(clean || null, Date.now(), id)
  return { person: id, merged: false }
}

/** Everyone in `from` becomes `into`; `from` goes. */
export function mergePeople(db: Db, from: number, into: number, opts: { keepHidden?: boolean } = {}): void {
  if (from === into) return
  db.transaction(() => {
    db.prepare(`UPDATE face SET person_id = ? WHERE person_id = ?`).run(into, from)
    db.prepare(`INSERT OR IGNORE INTO face_not (face_id, person_id) SELECT face_id, ? FROM face_not WHERE person_id = ?`).run(into, from)
    // "Different from X" carries over to the merged person.
    db.prepare(`INSERT OR IGNORE INTO person_not (a, b)
                SELECT MIN(@into, other), MAX(@into, other)
                  FROM (SELECT CASE WHEN a = @from THEN b ELSE a END AS other FROM person_not WHERE a = @from OR b = @from)
                 WHERE other != @into`).run({ into, from })
    db.prepare(`DELETE FROM person WHERE id = ?`).run(from)
    if (!opts.keepHidden) db.prepare(`UPDATE person SET hidden = 0, updated_at = ? WHERE id = ?`).run(Date.now(), into)
  })()
}

/** "Not this person": their faces in these assets leave them, for good. Returns how many photos changed. */
export function removeFromPerson(db: Db, personId: number, assetIds: number[]): number {
  const faces = db.prepare(`SELECT id FROM face WHERE person_id = ? AND asset_id = ?`)
  const free = db.prepare(`UPDATE face SET person_id = NULL WHERE id = ?`)
  const not = db.prepare(`INSERT OR IGNORE INTO face_not (face_id, person_id) VALUES (?, ?)`)
  let changed = 0
  db.transaction(() => {
    for (const a of assetIds) {
      const ids = (faces.all(personId, a) as { id: number }[]).map((r) => r.id)
      for (const f of ids) {
        free.run(f)
        not.run(f, personId)
      }
      if (ids.length) changed++
    }
    dropEmpty(db)
  })()
  return changed
}

/** Hidden people stay out of the People list; their faces keep going to them, so they do not come back as new. */
export function hidePerson(db: Db, id: number, hidden: boolean): void {
  // Shown again by hand: a person after all, whatever the check thought.
  db.prepare(`UPDATE person SET hidden = ?, kind = CASE WHEN ? = 0 THEN 'person' ELSE kind END, checked = 1, updated_at = ? WHERE id = ?`)
    .run(hidden ? 1 : 0, hidden ? 1 : 0, Date.now(), id)
}

/**
 * Named people mentioned in a query, longest names first, and what is left of
 * the query without them: "mom and dad at the beach" finds both, leaving "and
 * at the beach".
 */
export function peopleInQuery(db: Db, text: string): { ids: number[]; names: string[]; rest: string } {
  const named = (db.prepare(`SELECT id, name FROM person WHERE name IS NOT NULL`).all() as { id: number; name: string }[])
    .sort((a, b) => b.name.length - a.name.length)
  let rest = text
  const ids: number[] = []
  const names: string[] = []
  for (const p of named) {
    const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escaped}(?:'s)?(?![\\p{L}\\p{M}\\p{N}])`, 'iu')
    if (!re.test(rest)) continue
    rest = rest.replace(re, ' ')
    if (!ids.includes(p.id)) {
      ids.push(p.id)
      names.push(p.name)
    }
  }
  return { ids, names, rest: rest.replace(/\s+/g, ' ').trim() }
}

/** The face's asset and where it is, for cutting out its picture. */
export function faceBox(db: Db, faceId: number): { assetId: number; x: number; y: number; w: number; h: number } | null {
  return (
    (db
      .prepare(`SELECT f.asset_id AS assetId, f.x, f.y, f.w, f.h FROM face f JOIN asset a ON a.id = f.asset_id WHERE f.id = ? AND ${VISIBLE}`)
      .get(faceId) as { assetId: number; x: number; y: number; w: number; h: number } | undefined) ?? null
  )
}

/** People with a face in each of these assets, for the info panel. */
export function peopleInAsset(db: Db, assetId: number): { id: number; name: string | null; face: number }[] {
  return db
    .prepare(
      `SELECT p.id, p.name, MIN(f.id) AS face FROM face f JOIN person p ON p.id = f.person_id
        WHERE f.asset_id = ? AND p.hidden = 0 GROUP BY p.id ORDER BY p.name IS NULL, p.name`,
    )
    .all(assetId) as { id: number; name: string | null; face: number }[]
}
