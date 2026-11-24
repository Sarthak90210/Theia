import { layoutGrid, monthMarks } from '../app/renderer/layout.ts'
import type { GalleryItem } from '../app/shared/api.ts'

// The window's own work when the list or the zoom changes: grid layout in
// each view, and the timeline's month marks.
//   npx tsx scripts/bench-layout.ts [items=50000]
const n = Number(process.argv[2] ?? 50000)
const items: GalleryItem[] = Array.from({ length: n }, (_, i) => ({
  key: String(i), kind: 'photo', t: Date.UTC(2012, 0, 1) + i * 5_400_000, off: i % 3 ? 19800 : null, w: 4032, h: 3024,
  dur: null, fav: false, edited: false, cloud: false, subtype: null, revision: 1,
}))
const t = (label: string, f: () => unknown) => {
  const ts: number[] = []
  for (let i = 0; i < 9; i++) { const s = performance.now(); f(); ts.push(performance.now() - s) }
  ts.sort((a, b) => a - b)
  console.log(`${label}: median ${ts[4]!.toFixed(1)} ms`)
}
for (const view of ['all', 'days', 'months', 'years'] as const) t(`layoutGrid ${view} (${n})`, () => layoutGrid(items, view, 1400, 5))
const rows = layoutGrid(items, 'all', 1400, 5).rows
t('monthMarks', () => monthMarks(items, rows))
