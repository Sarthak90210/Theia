import fs from 'node:fs'
import path from 'node:path'

// Whether a drive wants one read at a time (a spinning disk: parallel reads
// make the heads seek between files) or many (an SSD). Read-only. Each pass
// reads different files, so the OS cache from the last pass doesn't help.
//   npx tsx scripts/bench-disk-concurrency.ts <folder with big files> [files per pass=4] [MB per file=64]
const root = path.resolve(process.argv[2]!)
const per = Number(process.argv[3] ?? 4)
const mb = Number(process.argv[4] ?? 64)
const files: string[] = []
const walk = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (fs.statSync(p).size >= mb * 1024 * 1024) files.push(p)
    if (files.length >= per * 6) return
    if (process.env.MAX_MB && files.length && fs.statSync(files.at(-1)!).size > Number(process.env.MAX_MB) * 1024 * 1024) files.pop()
  }
}
walk(root)
if (files.length < per * 4) throw new Error(`need ${per * 4} files of ${mb} MB+, found ${files.length}`)
async function readHead(file: string) {
  const fh = await fs.promises.open(file, 'r')
  const buf = Buffer.allocUnsafe(1024 * 1024)
  try { for (let pos = 0; pos < mb * 1024 * 1024; pos += buf.length) await fh.read(buf, 0, buf.length, pos) } finally { await fh.close() }
}
const pass = async (label: string, batch: string[], parallel: number) => {
  const s = performance.now()
  for (let i = 0; i < batch.length; i += parallel) await Promise.all(batch.slice(i, i + parallel).map(readHead))
  const sec = (performance.now() - s) / 1000
  console.log(`${label}: ${(batch.length * mb / sec).toFixed(0)} MB/s`)
}
let next = 0
const take = () => files.slice(next, (next += per))
await pass('one at a time', take(), 1)
await pass(`${per} at once`, take(), per)
await pass('one at a time', take(), 1)
await pass(`${per} at once`, take(), per)
