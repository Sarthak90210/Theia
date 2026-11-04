import { describe, expect, it } from 'vitest'
import type { GalleryItem } from '../src/gallery/types.ts'
import { groups, layoutGrid, rowOf, visibleRows } from '../app/renderer/layout.ts'

const DAY = 86_400_000
const base = Date.UTC(2026, 0, 10, 12) // noon UTC, 10 Jan 2026

function item(i: number, t: number, off: number | null = 0): GalleryItem {
  return { key: `k${i}`, kind: 'photo', t, off, w: 4032, h: 3024, dur: null, fav: false, edited: false, cloud: false, subtype: null }
}

describe('grid layout', () => {
  it('splits All Photos into rows of perRow square tiles', () => {
    const items = Array.from({ length: 23 }, (_, i) => item(i, base + i))
    const l = layoutGrid(items, 'all', 1000, 5)
    expect(l.perRow).toBe(5)
    expect(l.rows).toHaveLength(5)
    expect(l.rows.every((r) => r.kind === 'tiles' && r.height === l.tile)).toBe(true)
    expect(l.rows.at(-1)).toMatchObject({ start: 20, end: 23 })
    // 16 px padding each side, 2 px gaps.
    expect(l.tile * 5 + 2 * 4).toBeLessThanOrEqual(1000 - 32)
  })

  it('groups by the local day where the photo was taken, not UTC', () => {
    // 23:30 UTC on the 10th is 05:00 on the 11th in India (+05:30).
    const late = Date.UTC(2026, 0, 10, 23, 30)
    const items = [item(0, base, 19800), item(1, late, 19800), item(2, late + 60_000, 0)]
    const g = groups(items, 'days')
    expect(g.map((x) => x.label)).toEqual(['Saturday, 10 January 2026', 'Sunday, 11 January 2026', 'Saturday, 10 January 2026'])
  })

  it('puts a header before each month and keeps rows inside their group', () => {
    const items = [item(0, base), item(1, base + DAY), item(2, base + 40 * DAY), item(3, base + 41 * DAY)]
    const l = layoutGrid(items, 'months', 1200, 7)
    const kinds = l.rows.map((r) => r.kind)
    expect(kinds).toEqual(['header', 'tiles', 'header', 'tiles'])
    expect(l.rows[1]).toMatchObject({ start: 0, end: 2 })
    expect(l.rows[3]).toMatchObject({ start: 2, end: 4 })
  })

  it('finds the tile row for an item even when a header shares its start', () => {
    const items = Array.from({ length: 30 }, (_, i) => item(i, base + Math.floor(i / 10) * DAY))
    const l = layoutGrid(items, 'days', 800, 4)
    for (let i = 0; i < items.length; i++) {
      const r = rowOf(l.rows, i)
      expect(r?.kind).toBe('tiles')
      expect(i >= r!.start && i < r!.end).toBe(true)
    }
    expect(rowOf(l.rows, 30)).toBeNull()
  })

  it('returns only rows overlapping the viewport', () => {
    const items = Array.from({ length: 1000 }, (_, i) => item(i, base + i))
    const l = layoutGrid(items, 'all', 1000, 10)
    const rows = visibleRows(l.rows, 5000, 5600)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(10)
    for (const r of rows) expect(r.top + r.height >= 5000 && r.top < 5600).toBe(true)
  })
})
