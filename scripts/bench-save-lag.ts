// How badly a save blocks the main thread. Saves `count` files of `mb` MB into
// a fresh vault in `dir` the way Theia does, while a timer measures how late
// the event loop runs. Every millisecond of lag is a millisecond the window
// can't get an answer: thumbnails, scrolling, the status bar.
//
//   npx tsx scripts/bench-save-lag.ts <dir> [count=24] [mb=40]
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'

const [dir = path.join(process.cwd(), '.bench'), countArg = '24', mbArg = '40'] = process.argv.slice(2)
const count = Number(countArg)
const mb = Number(mbArg)
const root = path.join(dir, `bench-${Date.now()}`)
fs.mkdirSync(dir, { recursive: true })
const vault = createVault(root)

// A real-looking MP4: ftyp, moov, then mdat holding random bytes.
function video(bytes: number): Buffer {
  const box = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(8 + body.length, 0)
    head.write(type, 4, 'latin1')
    return Buffer.concat([head, body])
  }
  return Buffer.concat([box('ftyp', Buffer.from('mp42\0\0\0\0', 'latin1')), box('moov', Buffer.alloc(64)), box('mdat', crypto.randomBytes(bytes))])
}
const body = video(mb * 1024 * 1024)
const items: SaveItem[] = Array.from({ length: count }, (_, i) => ({
  key: `k${i}`, kind: 'video', t: Date.UTC(2024, 0, 1) + i * 1000, off: 0, w: 1920, h: 1080, dur: 1000, fav: false, edited: false,
  subtype: null, sourceUuid: `bench-${i}`, lat: null, lon: null, cloud: false,
  files: [{
    name: `VID_${i}.MP4`, role: 'master', mime: 'video/mp4', size: body.length + 4, sha256: null,
    // A distinct file each time, so none is skipped as a duplicate.
    read: async function* () { const tag = Buffer.alloc(4); tag.writeUInt32BE(i); yield body; yield tag },
  }],
}))
// The trailing tag makes each file 4 bytes longer than its mdat claims; the
// container check accepts a short trailer after a whole video.

const lag = monitorEventLoopDelay({ resolution: 5 })
lag.enable()
const started = performance.now()
const r = await saveToVault(vault, items, [])
const seconds = (performance.now() - started) / 1000
lag.disable()
vault.db.close()
fs.rmSync(root, { recursive: true, force: true })

const ms = (ns: number) => (ns / 1e6).toFixed(0)
console.log(`saved ${r.saved}/${count} (${r.failed.length} failed) · ${(count * mb / seconds).toFixed(0)} MB/s · ${seconds.toFixed(1)} s`)
console.log(`event-loop lag: max ${ms(lag.max)} ms · p99 ${ms(lag.percentile(99))} ms · p90 ${ms(lag.percentile(90))} ms · mean ${ms(lag.mean)} ms`)
if (r.failed.length) console.log(r.failed.slice(0, 3))
