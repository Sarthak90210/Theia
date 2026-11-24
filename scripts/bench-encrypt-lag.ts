import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { encryptFile, decryptFile, openEncrypted } from '../src/vault/private-crypto.ts'

// How long hiding (encrypting) and restoring (decrypting) a big file stalls
// the event loop, which in the app is Electron's main thread: the window.
//   npx tsx scripts/bench-encrypt-lag.ts <dir> [mb=300]
const dir = path.resolve(process.argv[2]!)
const mb = Number(process.argv[3] ?? 300)
fs.mkdirSync(dir, { recursive: true })
const src = path.join(dir, 'big.bin')
if (!fs.existsSync(src) || fs.statSync(src).size !== mb << 20) {
  const fd = fs.openSync(src, 'w'); const block = crypto.randomBytes(1 << 20)
  for (let i = 0; i < mb; i++) fs.writeSync(fd, block)
  fs.closeSync(fd)
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
async function measure(label: string, f: () => Promise<unknown>) {
  // The longest gap between ticks of a 2 ms timer: how long the window could
  // not answer. (monitorEventLoopDelay misses a stall that lasts the whole run.)
  let last = performance.now(); let worst = 0; let total = 0; let ticks = 0
  const timer = setInterval(() => { const now = performance.now(); const gap = now - last; worst = Math.max(worst, gap); total += gap; ticks++; last = now }, 2)
  const s = performance.now(); await f(); const ms = performance.now() - s
  clearInterval(timer); worst = Math.max(worst, performance.now() - last)
  console.log(`${label}: ${(ms / 1000).toFixed(1)} s, ${(mb / (ms / 1000)).toFixed(0)} MB/s; longest freeze ${worst.toFixed(0)} ms, ${ticks} ticks (mean gap ${(total / Math.max(1, ticks)).toFixed(1)} ms)`)
}
const enc = path.join(dir, 'big.theia'); const out = path.join(dir, 'big.out')
fs.rmSync(enc, { force: true }); fs.rmSync(out, { force: true })
await measure(`encrypt ${mb} MB`, () => encryptFile(src, enc, publicKey))
await measure(`decrypt ${mb} MB`, () => decryptFile(enc, out, privateKey))
await measure(`stream-read ${mb} MB (video playback)`, async () => {
  const r = openEncrypted(enc, privateKey)
  try { for (let p = 0; p < r.size; p += 1 << 20) await r.read(p, 1 << 20) } finally { r.close() }
})
for (const f of [enc, out]) fs.rmSync(f, { force: true })
