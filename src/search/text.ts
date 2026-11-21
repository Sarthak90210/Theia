import type { Db } from '../library/db.ts'
import type { TextMarks } from '../gallery/types.ts'
import type { OcrResult } from './ocr.ts'

/**
 * Finding photos by the words written in them. Forgiving on purpose: people
 * misspell ("aadhar" for "Aadhaar"), OCR misreads a letter, and Devanagari
 * often comes back without its spaces. So a query word matches a word in the
 * photo exactly, as its beginning, inside it (for scripts read without
 * spaces), or one or two letters off (for longer words).
 *
 * Brute force over the vault's text, which stays small: most photos have
 * none, and a busy screenshot has a few hundred words.
 */

/** Words that carry no meaning on their own, in a query or on a sign. */
const STOP = new Set([
  'a', 'an', 'and', 'are', 'at', 'by', 'for', 'from', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'the', 'to', 'with',
  'show', 'photo', 'photos', 'picture', 'pictures', 'pic', 'pics', 'image', 'images', 'all',
  'का', 'की', 'के', 'में', 'से', 'और', 'है', 'फोटो', 'फ़ोटो',
])

export function textWords(s: string): string[] {
  return s.toLowerCase().normalize('NFKC').match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
}

/** The words of a query worth looking for in photos. */
export function contentWords(query: string): string[] {
  return [...new Set(textWords(query).filter((w) => !STOP.has(w) && (/^\p{N}+$/u.test(w) ? w.length >= 2 : w.length >= 3)))]
}

/** How well query word `q` matches photo word `t`: 1 exact, less for looser matches, 0 none. */
export function wordMatch(q: string, t: string): number {
  if (q === t) return 1
  if (q.length >= 4 && t.length > q.length && t.startsWith(q)) return 0.9
  // Devanagari (and other scripts) is often read with the spaces lost.
  if (!/^[\p{Script=Latin}\p{N}]+$/u.test(q) && t.includes(q)) return 0.85
  if (/^\p{N}+$/u.test(q)) return 0
  const n = Math.max(q.length, t.length)
  if (Math.min(q.length, t.length) < 5 || Math.abs(q.length - t.length) > 2) return 0
  const d = editDistance(q, t, 2)
  if (d === 1) return 0.8
  if (d === 2 && n >= 8) return 0.7
  return 0
}

export interface TextHit {
  assetId: number
  /** Every word of the query was found. */
  full: boolean
}

/**
 * Visible items whose text matches the query: those with more of its words
 * first, then rarer and closer matches. An item needs at least half the
 * query's words, so one common word does not drag in every sign.
 */
export function textMatches(db: Db, query: string, limit = 300): TextHit[] {
  const words = contentWords(query)
  if (!words.length) return []
  const digits = words.join('')
  const rows = db
    .prepare(
      `SELECT o.asset_id, o.text FROM ocr_text o JOIN asset a ON a.id = o.asset_id
        WHERE o.text != '' AND a.hidden = 0 AND a.deleted_at IS NULL`,
    )
    .all() as { asset_id: number; text: string }[]
  if (!rows.length) return []

  // Per query word, each item's best match. Distinct words first, then items.
  const vocab = new Map<string, number[]>()
  const compact = new Map<number, string>()
  for (const r of rows) {
    for (const w of new Set(textWords(r.text))) {
      const ids = vocab.get(w)
      if (ids) ids.push(r.asset_id)
      else vocab.set(w, [r.asset_id])
    }
    // A long number typed without its spaces: "482177350962".
    if (/^\p{N}{6,}$/u.test(digits)) compact.set(r.asset_id, r.text.replace(/\s+/g, ''))
  }
  const found = words.map(() => new Map<number, number>())
  words.forEach((q, i) => {
    for (const [t, ids] of vocab) {
      const m = wordMatch(q, t)
      if (!m) continue
      for (const id of ids) if ((found[i]!.get(id) ?? 0) < m) found[i]!.set(id, m)
    }
  })
  if (compact.size) {
    for (const [id, text] of compact) if (text.includes(digits)) words.forEach((_, i) => found[i]!.set(id, 1))
  }

  const total = rows.length
  const scores = new Map<number, { count: number; score: number }>()
  found.forEach((m) => {
    // Rarer words say more: "aadhaar" is on one card, "india" on many things.
    const idf = Math.log(1 + total / Math.max(1, m.size))
    for (const [id, quality] of m) {
      const s = scores.get(id) ?? { count: 0, score: 0 }
      s.count++
      s.score += quality * idf
      scores.set(id, s)
    }
  })
  const need = Math.max(1, Math.ceil(words.length / 2))
  return [...scores.entries()]
    .filter(([, s]) => s.count >= need)
    .sort((a, b) => b[1].count - a[1].count || b[1].score - a[1].score)
    .slice(0, limit)
    .map(([assetId, s]) => ({ assetId, full: s.count === words.length }))
}

/** Levenshtein distance, giving up (returning max + 1) once it is past `max`. */
function editDistance(a: string, b: string, max: number): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      cur.push(v)
      if (v < best) best = v
    }
    if (best > max) return max + 1
    prev = cur
  }
  return prev[b.length]!
}

/** How a reading is kept in ocr_text.lines: corners rounded to pixels, character positions in thousandths. */
interface StoredLines {
  w: number
  h: number
  lines: { t: string; q: number[]; x: number[] }[]
}

export function storedLines(r: OcrResult): string {
  const stored: StoredLines = {
    w: r.width,
    h: r.height,
    lines: r.lines.map((l) => ({ t: l.text, q: l.box.flat().map(Math.round), x: l.at.map((a) => Math.round(a * 1000)) })),
  }
  return JSON.stringify(stored)
}

/**
 * Where the query's words are written in a photo: one shape per matched word,
 * or per run of matched words next to each other ("team gati"), cut out of
 * its line by where the characters sit along it.
 */
export function textMarks(stored: string | null, query: string): TextMarks | null {
  if (!stored) return null
  const words = contentWords(query)
  if (!words.length) return null
  let s: StoredLines
  try {
    s = JSON.parse(stored) as StoredLines
  } catch {
    return null
  }
  const digits = words.join('')
  const quads: number[][] = []
  for (const line of s.lines) {
    const lower = line.t.toLowerCase()
    const spans: [number, number][] = []
    for (const m of lower.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
      const token = m[0]
      const q = words.find((w) => wordMatch(w, token.normalize('NFKC')) > 0)
      if (q === undefined) continue
      // A word inside a longer run (Devanagari read without its spaces): just that part.
      const inner = token !== q && !/^[\p{Script=Latin}\p{N}]+$/u.test(q) ? token.indexOf(q) : -1
      spans.push(inner >= 0 ? [m.index + inner, m.index + inner + q.length] : [m.index, m.index + token.length])
    }
    if (/^\p{N}{6,}$/u.test(digits) && line.t.replace(/\s+/g, '').includes(digits)) spans.push([0, line.t.length])
    for (const [a, b] of mergeSpans(spans)) quads.push(cut(line, a, b))
  }
  return quads.length ? { w: s.w, h: s.h, quads } : null
}

/** Overlapping spans, or ones only a space apart, become one. */
function mergeSpans(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = []
  for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** Characters a to b (exclusive) of a line, as the part of its box they occupy. */
function cut(line: StoredLines['lines'][number], a: number, b: number): number[] {
  const x = line.x.map((v) => v / 1000)
  const n = x.length
  let from = 0
  let to = 1
  if (n === line.t.length && n > 1 && b > a) {
    const step = (x[n - 1]! - x[0]!) / (n - 1) || 0.02
    from = a > 0 ? (x[a - 1]! + x[a]!) / 2 : Math.max(0, x[0]! - step / 2)
    to = b < n ? (x[b - 1]! + x[b]!) / 2 : Math.min(1, x[n - 1]! + step / 2)
  }
  const q = line.q
  const along = (i: number, j: number, f: number) => [q[2 * i]! + f * (q[2 * j]! - q[2 * i]!), q[2 * i + 1]! + f * (q[2 * j + 1]! - q[2 * i + 1]!)]
  // Top edge runs corner 0 to 1, bottom edge corner 3 to 2.
  return [...along(0, 1, from), ...along(0, 1, to), ...along(3, 2, to), ...along(3, 2, from)].map((v) => Math.round(v))
}
