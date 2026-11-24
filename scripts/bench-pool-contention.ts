import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { thumbPath, SIZES, type ThumbSize } from '../src/thumbs/render.ts'

// How long one thumbnail read the window is waiting on takes while a
// background scan of the thumbnail cache runs, at different numbers of checks
// in flight. libuv runs async fs on a small shared thread pool, so a flood of
// checks queues in front of the read. Read-only.
//   npx tsx scripts/bench-pool-contention.ts <vault root> [in flight...]
const root = path.resolve(process.argv[2]!)
const levels = process.argv.slice(3).map(Number)
const cache = path.join(root, '.vault', 'cache')
const db = new Database(path.join(root, '.vault', 'library.db'), { readonly: true })
const shas = (db.prepare(`SELECT f.sha256 FROM file f JOIN asset a ON a.id = f.asset_id WHERE f.is_primary = 1 AND f.encrypted_path IS NULL AND a.hidden = 0 AND a.deleted_at IS NULL ORDER BY random()`).all() as { sha256: string }[]).map((r) => r.sha256)
db.close()
const sizes = Object.keys(SIZES) as ThumbSize[]
let cursor = 0
async function scan(inFlight: number, stop: { done: boolean }) {
  await Promise.all(Array.from({ length: inFlight }, async () => {
    while (!stop.done) {
      const sha = shas[cursor++ % shas.length]!
      await fs.promises.access(thumbPath(cache, sha, sizes[cursor % 3]!)).catch(() => {})
    }
  }))
}
async function probe(label: string, inFlight: number) {
  const stop = { done: false }
  const running = inFlight ? scan(inFlight, stop) : Promise.resolve()
  const times: number[] = []
  for (let i = 0; i < 25; i++) {
    const sha = shas[(i * 7919 + 13) % shas.length]!
    const s = performance.now()
    await fs.promises.readFile(thumbPath(cache, sha, 'sm')).catch(() => {})
    times.push(performance.now() - s)
    await new Promise((r) => setTimeout(r, 40))
  }
  stop.done = true
  await running
  times.sort((a, b) => a - b)
  console.log(`${label}: thumbnail read median ${times[12]!.toFixed(1)} ms, worst ${times[24]!.toFixed(1)} ms`)
}
await probe('no scan', 0)
for (const n of levels) await probe(`scan with ${n} checks in flight`, n)
await probe('no scan', 0)
