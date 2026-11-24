import fs from 'node:fs'
import path from 'node:path'
import v8 from 'node:v8'
import { createVault } from '../src/vault/vault.ts'
import { vaultCollections, vaultItems } from '../src/gallery/vault-gallery.ts'

// The cost of loading a vault's list into the window: the query, and the copy
// across IPC (v8 serialization, as Electron's structured clone does).
//   npx tsx scripts/bench-items.ts <empty dir> [items=50000]
const dir = path.resolve(process.argv[2]!)
const n = Number(process.argv[3] ?? 50000)
fs.rmSync(dir, { recursive: true, force: true })
const v = createVault(path.join(dir, 'V'))
const db = v.db as any
const insert = db.prepare(`INSERT INTO asset (kind, captured_utc, captured_offset, width, height, favourite, has_adjustments, created_at, updated_at, hidden)
  VALUES (?, ?, 0, 4032, 3024, ?, 0, ?, ?, 0)`)
db.transaction(() => {
  for (let i = 0; i < n; i++) insert.run(i % 9 === 0 ? 'video' : i % 5 === 0 ? 'live' : 'photo', Date.UTC(2015, 0, 1) + i * 3_600_000, i % 50 === 0 ? 1 : 0, Date.now(), Date.now())
})()
const t = <T>(label: string, f: () => T, runs = 5): T => {
  let r!: T
  const times: number[] = []
  for (let i = 0; i < runs; i++) { const s = performance.now(); r = f(); times.push(performance.now() - s) }
  times.sort((a, b) => a - b)
  console.log(`${label}: median ${times[runs >> 1]!.toFixed(1)} ms, min ${times[0]!.toFixed(1)} ms`)
  return r
}
const items = t(`vaultItems(${n})`, () => vaultItems(db, 'library'))
const wire = t('serialize for IPC', () => v8.serialize(items))
console.log(`  ${(wire.length / 1024 / 1024).toFixed(2)} MB on the wire`)
t('deserialize in window', () => v8.deserialize(wire))
t('vaultCollections', () => vaultCollections(db))
t('live count', () => db.prepare(`SELECT COUNT(*) AS n FROM asset WHERE deleted_at IS NULL AND hidden = 0`).get())
console.log(db.prepare(`EXPLAIN QUERY PLAN SELECT a.id FROM asset a WHERE 1 = 1 AND a.deleted_at IS NULL AND a.hidden = 0 ORDER BY COALESCE(a.captured_utc, a.created_at), a.id`).all().map((r: any) => r.detail).join(' | '))
db.close()
fs.rmSync(dir, { recursive: true, force: true })
