import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { renderThumbnails } from '../src/thumbs/render.ts'
import { HeicPool } from '../src/thumbs/heic-pool.ts'

// Thumbnail throughput from a vault's originals at different concurrency, as
// the background drain runs it. Reads the vault read-only; writes thumbnails
// to a scratch folder (pass one on the same drive to include the writes).
//   npx tsx scripts/bench-thumb-concurrency.ts <vault root> <scratch dir> [per pass=60]
const root = path.resolve(process.argv[2]!)
const scratch = path.resolve(process.argv[3]!)
const per = Number(process.argv[4] ?? 60)
const db = new Database(path.join(root, '.vault', 'library.db'), { readonly: true })
const rows = db.prepare(`SELECT f.path, f.mime, f.sha256 FROM file f JOIN asset a ON a.id = f.asset_id
  WHERE f.is_primary = 1 AND f.encrypted_path IS NULL AND f.mime LIKE 'image/%' ORDER BY random() LIMIT ?`).all(per * 8) as { path: string; mime: string; sha256: string }[]
db.close()
const heic = new HeicPool(Math.max(1, Math.min(Math.floor(os.cpus().length / 4), 4)))
let next = 0
async function pass(concurrency: number) {
  const batch = rows.slice(next, (next += per))
  const cache = path.join(scratch, `c${next}`)
  let i = 0
  const s = performance.now()
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < batch.length) {
      const r = batch[i++]!
      await renderThumbnails(path.join(root, ...r.path.split('/')), r.mime, r.sha256, cache, { heic }).catch(() => {})
    }
  }))
  const sec = (performance.now() - s) / 1000
  console.log(`concurrency ${concurrency}: ${(batch.length / sec).toFixed(1)} photos/s`)
}
fs.mkdirSync(scratch, { recursive: true })
for (const c of [1, 2, 4, 1, 2, 4]) await pass(c)
await heic.close()
fs.rmSync(scratch, { recursive: true, force: true })
