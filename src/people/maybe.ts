import type { Db } from '../library/db.ts'
import type { FaceResult } from '../search/faces.ts'
import { DEEP_KEYS } from '../search/deep-keys.ts'
import { MIN_SHARPNESS } from './people.ts'

/**
 * What the closer look adds to People.
 *
 * Its faces are merged into the photo's existing ones rather than replacing
 * them: a face found again (boxes overlapping) keeps its row, so its person,
 * name and every "not this person" answer stay; a face found for the first
 * time is added, free, for grouping to place.
 *
 * Then, for each named person, faces that might be them but are not alike
 * enough to add without asking (a little less alike, side-on, or blurred)
 * become questions: "Might be Mom". Yes adds the face to them; no is
 * remembered like any "not this person".
 */

/** A face found again overlaps its old box at least this much (intersection over union). */
const SAME_FACE = 0.4
/** How alike, as the mean of the best three matches, to ask about a face. Joining without asking takes 0.55. */
export const MAYBE_SCORE = 0.45
/** How near the person's average face. Joining without asking takes 0.45. */
export const MAYBE_CENTRE = 0.38
/** Blurrier faces than grouping uses may be asked about: the person answering can see them. */
export const MAYBE_SHARPNESS = 20

const VISIBLE = 'a.hidden = 0 AND a.deleted_at IS NULL'

const vecOf = (b: Buffer) => new Float32Array(b.buffer, b.byteOffset, 128)

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < 128; i++) s += a[i]! * b[i]!
  return s
}

function iou(a: number[], b: number[]): number {
  const [ax, ay, aw, ah] = a as [number, number, number, number]
  const [bx, by, bw, bh] = b as [number, number, number, number]
  const iw = Math.min(ax + aw, bx + bw) - Math.max(ax, bx)
  const ih = Math.min(ay + ah, by + bh) - Math.max(ay, by)
  if (iw <= 0 || ih <= 0) return 0
  const inter = iw * ih
  return inter / (aw * ah + bw * bh - inter)
}

const round = (v: number) => Math.round(v * 10000) / 10000

/** Merge the closer look's faces into the photo's (see above). Returns how many faces are new. */
export function mergeDeepFaces(db: Db, assetId: number, r: FaceResult): number {
  const W = r.width || 1
  const H = r.height || 1
  const old = db.prepare(`SELECT id, x, y, w, h FROM face WHERE asset_id = ?`).all(assetId) as { id: number; x: number; y: number; w: number; h: number }[]
  const update = db.prepare(`UPDATE face SET x = ?, y = ?, w = ?, h = ?, landmarks = ?, score = ?, sharpness = ?, vec = ? WHERE id = ?`)
  const insert = db.prepare(`INSERT INTO face (asset_id, x, y, w, h, landmarks, score, sharpness, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const mark = db.prepare(`INSERT OR REPLACE INTO deep_scan (asset_id, stage, model) VALUES (?, 'faces', ?)`)
  const taken = new Set<number>()
  let added = 0
  db.transaction(() => {
    for (const f of r.faces) {
      const box = [f.box[0] / W, f.box[1] / H, f.box[2] / W, f.box[3] / H].map(round)
      const landmarks = JSON.stringify(f.landmarks.map(([lx, ly]) => [round(lx / W), round(ly / H)]))
      const vec = Buffer.from(f.vec.buffer, f.vec.byteOffset, f.vec.byteLength)
      let best: { id: number; overlap: number } | null = null
      for (const o of old) {
        if (taken.has(o.id)) continue
        const overlap = iou(box, [o.x, o.y, o.w, o.h])
        if (overlap >= SAME_FACE && (!best || overlap > best.overlap)) best = { id: o.id, overlap }
      }
      if (best) {
        taken.add(best.id)
        update.run(box[0], box[1], box[2], box[3], landmarks, f.score, f.sharpness, vec, best.id)
      } else {
        insert.run(assetId, box[0], box[1], box[2], box[3], landmarks, f.score, f.sharpness, vec)
        added++
      }
    }
    // Faces the first look found and this one didn't are kept as they were.
    mark.run(assetId, DEEP_KEYS.faces)
  })()
  return added
}

/**
 * Remake the questions: free faces in visible photos that might be a named
 * person, the best person for each, at most one face per photo per person.
 * Returns how many there are.
 */
export function findMaybes(db: Db): number {
  const held = db
    .prepare(
      `SELECT f.person_id, f.asset_id, f.vec FROM face f JOIN asset a ON a.id = f.asset_id JOIN person p ON p.id = f.person_id
        WHERE ${VISIBLE} AND p.name IS NOT NULL AND p.hidden = 0 AND p.kind = 'person' AND f.sharpness >= ?`,
    )
    .all(MIN_SHARPNESS) as { person_id: number; asset_id: number; vec: Buffer }[]
  const people = new Map<number, { faces: Float32Array[]; assets: Set<number>; centre: Float32Array }>()
  for (const r of held) {
    const p = people.get(r.person_id) ?? { faces: [], assets: new Set<number>(), centre: new Float32Array(128) }
    p.faces.push(vecOf(r.vec))
    p.assets.add(r.asset_id)
    people.set(r.person_id, p)
  }
  // Everyone's photos, so a face is never asked about for someone already in that photo.
  for (const r of db.prepare(`SELECT person_id, asset_id FROM face WHERE person_id IS NOT NULL`).all() as { person_id: number; asset_id: number }[]) {
    people.get(r.person_id)?.assets.add(r.asset_id)
  }
  for (const p of people.values()) {
    for (const v of p.faces) for (let i = 0; i < 128; i++) p.centre[i]! += v[i]!
    const n = Math.hypot(...p.centre) || 1
    for (let i = 0; i < 128; i++) p.centre[i]! /= n
  }

  const free = db
    .prepare(
      `SELECT f.id, f.asset_id, f.vec FROM face f JOIN asset a ON a.id = f.asset_id
        WHERE ${VISIBLE} AND f.person_id IS NULL AND f.sharpness >= ?`,
    )
    .all(MAYBE_SHARPNESS) as { id: number; asset_id: number; vec: Buffer }[]
  const refused = new Set((db.prepare(`SELECT face_id, person_id FROM face_not`).all() as { face_id: number; person_id: number }[]).map((r) => `${r.face_id}:${r.person_id}`))

  // Best question per photo and person.
  const asks = new Map<string, { face: number; person: number; score: number }>()
  for (const f of free) {
    const v = vecOf(f.vec)
    let best: { person: number; score: number } | null = null
    for (const [id, p] of people) {
      if (p.assets.has(f.asset_id) || refused.has(`${f.id}:${id}`)) continue
      if (dot(v, p.centre) < MAYBE_CENTRE) continue
      const top = p.faces.map((x) => dot(v, x)).sort((a, b) => b - a).slice(0, 3)
      const score = top.reduce((s, x) => s + x, 0) / top.length
      if (score >= MAYBE_SCORE && (!best || score > best.score)) best = { person: id, score }
    }
    if (!best) continue
    const key = `${f.asset_id}:${best.person}`
    const other = asks.get(key)
    if (!other || best.score > other.score) asks.set(key, { face: f.id, ...best })
  }

  const put = db.prepare(`INSERT INTO face_maybe (face_id, person_id, score) VALUES (?, ?, ?)`)
  db.transaction(() => {
    db.prepare(`DELETE FROM face_maybe`).run()
    for (const a of asks.values()) put.run(a.face, a.person, Math.round(a.score * 1000) / 1000)
  })()
  return asks.size
}

export interface MaybeFace {
  /** The face, for its picture. */
  face: number
  assetId: number
  score: number
}

/** Faces that might be this person, most alike first. */
export function listMaybes(db: Db, personId: number, limit = 200): MaybeFace[] {
  return db
    .prepare(
      `SELECT m.face_id AS face, f.asset_id AS assetId, m.score FROM face_maybe m
         JOIN face f ON f.id = m.face_id JOIN asset a ON a.id = f.asset_id
        WHERE m.person_id = ? AND ${VISIBLE} AND f.person_id IS NULL
        ORDER BY m.score DESC LIMIT ?`,
    )
    .all(personId, limit) as MaybeFace[]
}

/**
 * Answers about faces that might be this person: yes adds each to them (unless
 * they are already in that photo); no is remembered and never asked again.
 * Returns how many faces were added.
 */
export function answerMaybes(db: Db, personId: number, yes: number[], no: number[]): number {
  const ask = db.prepare(`SELECT f.asset_id FROM face_maybe m JOIN face f ON f.id = m.face_id WHERE m.face_id = ? AND m.person_id = ? AND f.person_id IS NULL`)
  const inPhoto = db.prepare(`SELECT 1 FROM face WHERE asset_id = ? AND person_id = ? LIMIT 1`)
  const join = db.prepare(`UPDATE face SET person_id = ? WHERE id = ? AND person_id IS NULL`)
  const refuse = db.prepare(`INSERT OR IGNORE INTO face_not (face_id, person_id) VALUES (?, ?)`)
  const done = db.prepare(`DELETE FROM face_maybe WHERE face_id = ?`)
  const touch = db.prepare(`UPDATE person SET updated_at = ? WHERE id = ?`)
  let added = 0
  db.transaction(() => {
    for (const face of yes) {
      const row = ask.get(face, personId) as { asset_id: number } | undefined
      if (row && !inPhoto.get(row.asset_id, personId)) added += join.run(personId, face).changes
      done.run(face)
    }
    for (const face of no) {
      if (ask.get(face, personId)) refuse.run(face, personId)
      done.run(face)
    }
    if (added) touch.run(Date.now(), personId)
  })()
  return added
}

/** Questions waiting, per named person. */
export function maybeCounts(db: Db): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT m.person_id, COUNT(*) AS n FROM face_maybe m JOIN face f ON f.id = m.face_id JOIN asset a ON a.id = f.asset_id
        WHERE ${VISIBLE} AND f.person_id IS NULL GROUP BY m.person_id`,
    )
    .all() as { person_id: number; n: number }[]
  return new Map(rows.map((r) => [r.person_id, r.n]))
}
