import type { GalleryItem } from '../shared/api.ts'
import { dayKey, dayLabel, monthKey, monthLabel, plural, wall } from './format.ts'

/**
 * Where every row of the grid goes, worked out from the item list alone.
 *
 * The grid draws only the rows near the viewport, so it needs every row's
 * position before any image loads. Tiles are square, so a row's height is
 * known from the width. Pure, so it is tested without a window.
 */

export type View = 'years' | 'months' | 'days' | 'all'

export interface HeaderRow {
  kind: 'header'
  top: number
  height: number
  label: string
  sub: string
  /** Item range the header covers, for "select this day". */
  start: number
  end: number
}

export interface TileRow {
  kind: 'tiles'
  top: number
  height: number
  /** Item indices [start, end). */
  start: number
  end: number
}

export type Row = HeaderRow | TileRow

export interface Layout {
  rows: Row[]
  height: number
  tile: number
  perRow: number
  gap: number
}

export const HEADER_HEIGHT = 64
export const PAD = 24

/** Tiles per row for a view, from the zoom slider's value. */
export function perRowFor(view: View, zoom: number): number {
  if (view === 'years') return Math.min(28, zoom * 2 + 4)
  if (view === 'months') return Math.min(20, zoom + 4)
  return zoom
}

export function layoutGrid(items: GalleryItem[], view: View, width: number, zoom: number): Layout {
  const perRow = Math.max(1, perRowFor(view, zoom))
  const gap = view === 'years' ? 2 : 6
  const inner = Math.max(0, width - PAD * 2)
  const tile = Math.max(1, Math.floor((inner - gap * (perRow - 1)) / perRow))
  const rows: Row[] = []
  let top = view === 'all' ? PAD : 0

  const pushTiles = (start: number, end: number) => {
    for (let i = start; i < end; i += perRow) {
      rows.push({ kind: 'tiles', top, height: tile, start: i, end: Math.min(end, i + perRow) })
      top += tile + gap
    }
  }

  if (view === 'all') {
    pushTiles(0, items.length)
  } else {
    for (const g of groups(items, view)) {
      rows.push({ kind: 'header', top, height: HEADER_HEIGHT, label: g.label, sub: plural(g.end - g.start, 'item'), start: g.start, end: g.end })
      top += HEADER_HEIGHT
      pushTiles(g.start, g.end)
      top += 8
    }
  }
  return { rows, height: top + PAD, tile, perRow, gap }
}

interface Group {
  label: string
  start: number
  end: number
}

/** Runs of items on the same local day, month or year. Items arrive in order. */
export function groups(items: GalleryItem[], view: Exclude<View, 'all'>): Group[] {
  const out: Group[] = []
  let key = ''
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    const d = wall(it.t, it.off)
    const k = view === 'years' ? String(d.getUTCFullYear()) : view === 'months' ? monthKey(d) : dayKey(d)
    if (k !== key || !out.length) {
      key = k
      const label = view === 'years' ? String(d.getUTCFullYear()) : view === 'months' ? monthLabel(d) : dayLabel(d)
      out.push({ label, start: i, end: i + 1 })
    } else {
      out[out.length - 1]!.end = i + 1
    }
  }
  return out
}

/** The rows that overlap [from, to), found by binary search. */
export function visibleRows(rows: Row[], from: number, to: number): Row[] {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const r = rows[mid]!
    if (r.top + r.height < from) lo = mid + 1
    else hi = mid
  }
  const out: Row[] = []
  for (let i = lo; i < rows.length && rows[i]!.top < to; i++) out.push(rows[i]!)
  return out
}

/** The tile row holding an item, for scrolling it into view. */
export function rowOf(rows: Row[], index: number): TileRow | null {
  // Last row starting at or before the index. A header starts where its first
  // tile row starts and comes before it, so this always lands on tiles.
  let lo = 0
  let hi = rows.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid]!.start <= index) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  const r = found >= 0 ? rows[found]! : null
  return r && r.kind === 'tiles' && index < r.end ? r : null
}
