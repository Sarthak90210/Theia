import fs from 'node:fs'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import sharp from 'sharp'
import { GalleryService } from '../app/main/gallery-service.ts'
import { createVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'
import { Readable } from 'node:stream'
import { rangeResponse } from '../src/media/ranges.ts'

// What the grid costs the main process: thumbnails served the way the
// photos-media:// handler serves them, as a scroll would ask for them.
//   npx tsx scripts/bench-media.ts <empty dir> [photos=600] [--old: the handler as it was before 0.5.3]
const dir = path.resolve(process.argv[2]!)
const count = Number(process.argv[3] ?? 600)
fs.mkdirSync(dir, { recursive: true })
const vaultRoot = path.join(dir, 'V')
if (!fs.existsSync(vaultRoot)) {
  const v = createVault(vaultRoot)
  const items: SaveItem[] = []
  for (let i = 0; i < count; i++) {
    // Distinct for every i, so none is skipped as a duplicate.
    const bytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: i % 251, g: Math.floor(i / 251) % 251, b: (i * 37) % 251 } } }).jpeg().toBuffer()
    items.push({
      key: `p${i}`, kind: 'photo', t: Date.UTC(2020, 0, 1) + i * 60000, off: 0, w: 1200, h: 900, dur: null, fav: false, edited: false,
      subtype: null, sourceUuid: `p${i}`, lat: null, lon: null, cloud: false,
      files: [{ name: `IMG_${i}.JPG`, role: 'master', mime: 'image/jpeg', size: bytes.length, sha256: null, read: async function* () { yield bytes } }],
    })
  }
  await saveToVault(v, items, [])
  v.db.close()
}
const profile = path.join(dir, 'profile')
fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(path.join(profile, 'gallery.json'), JSON.stringify({ vaults: [] }))
const service = new GalleryService({
  userData: profile, publish: () => {}, pickFolder: async () => null, openPath: async () => {}, showInFolder: () => {},
  openExternal: async () => {}, trash: async () => {}, recycleBinLimit: async () => null, setBusy: () => {},
  pickSavePath: async () => null,
} as never)
const id = service.openVaultAt(vaultRoot)
const db = (service as any).vaults.get(id).vault.db
const keys = (db.prepare('SELECT id FROM asset ORDER BY id').all() as { id: number }[]).map((r) => String(r.id))

const OLD = process.argv.includes('--old')
// The protocol handler, as in app/main/main.ts.
async function serve(key: string): Promise<number> {
  const m = await service.media(id, 'sm', key)
  if (!m) return 0
  if (OLD) {
    // Before: an existsSync in the handler (and two in the service), a
    // statSync, and every file streamed through a Node-to-web stream bridge.
    if ('path' in m && (!fs.existsSync(m.path) || !fs.existsSync(m.path) || !fs.existsSync(m.path))) return 0
    const file = (m as { path: string }).path
    const size = fs.statSync(file).size
    const res = new Response(Readable.toWeb(fs.createReadStream(file, { start: 0, end: size - 1, highWaterMark: 1024 * 1024 })) as ReadableStream)
    return (await res.arrayBuffer()).byteLength
  }
  const res = await rangeResponse('path' in m ? { file: m.path } : { source: (m as any).source }, null, { 'Content-Type': m.mime }).catch(() => null)
  return res ? (await res.arrayBuffer()).byteLength : 0
}

async function pass(label: string, concurrency = 24) {
  const lag = monitorEventLoopDelay({ resolution: 5 })
  lag.enable()
  const s = performance.now()
  let next = 0
  let bytes = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < keys.length) { const n = await serve(keys[next++]!); bytes += n }
  }))
  const ms = performance.now() - s
  lag.disable()
  console.log(`${label}: ${keys.length} thumbs in ${ms.toFixed(0)} ms = ${(ms / keys.length).toFixed(3)} ms each, ${(keys.length / (ms / 1000)).toFixed(0)}/s, ${(bytes / 1024 / 1024).toFixed(1)} MB; loop lag max ${(lag.max / 1e6).toFixed(1)} ms p99 ${(lag.percentile(99) / 1e6).toFixed(1)} ms`)
}

{ const m = await service.media(id, "sm", keys[0]!); console.log("probe", keys.length, m) }
await pass("first (renders missing)")
for (let i = 1; i <= 3; i++) await pass(`warm ${i}`)
await service.stop()
