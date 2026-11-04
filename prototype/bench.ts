import { UsbmuxConnection, type DeviceEntry } from '../src/protocol/usbmux.ts'
import { LockdownClient, LOCKDOWN_PORT, TLS_STRATEGIES, type PairRecord } from '../src/protocol/lockdown.ts'
import { AfcClient } from '../src/protocol/afc.ts'
import { parsePlist } from '../src/protocol/plist-io.ts'

/**
 * Measures the three numbers the spec currently asserts without evidence:
 * how long enumeration takes, what USB actually sustains, and whether more
 * than one file in flight helps.
 */

const ok = (s: string) => console.log(`  \x1b[32mok\x1b[0m    ${s}`)
const info = (s: string) => console.log(`        ${s}`)
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`)

const MB = 1024 * 1024
const fmt = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / MB).toFixed(1)} MB`)

interface Entry {
  path: string
  size: number
}

async function main() {
  // ------------------------------------------------------------- connect
  const mux = await UsbmuxConnection.open()
  const devices: DeviceEntry[] = await mux.listDevices()
  mux.close()
  const usb = devices.find((d) => d.Properties.ConnectionType === 'USB')
  if (!usb) throw new Error('no USB device, plug the phone in and unlock it')
  const deviceId = usb.Properties.DeviceID

  const mux2 = await UsbmuxConnection.open()
  const pairData = await mux2.readPairRecord(usb.Properties.SerialNumber)
  mux2.close()
  if (!pairData) throw new Error('no pairing record')
  const pair = parsePlist(pairData) as PairRecord

  const muxL = await UsbmuxConnection.open()
  const lockdown = new LockdownClient(await muxL.connectToPort(deviceId, LOCKDOWN_PORT))
  await lockdown.queryType()
  const session = await lockdown.startSession(pair)
  if (session.ssl) await lockdown.enableSSL(pair, TLS_STRATEGIES[0]!)

  /** Each concurrent reader needs its own service channel. */
  async function openAfc(): Promise<AfcClient> {
    const svc = await lockdown.startService('com.apple.afc')
    const m = await UsbmuxConnection.open()
    return new AfcClient(await m.connectToPort(deviceId, svc.port))
  }

  // ----------------------------------------------------------- enumerate
  step('enumeration cost')
  const afc = await openAfc()

  const t0 = performance.now()
  const albums = await afc.readDir('/DCIM')
  const listOnly: string[] = []
  for (const album of albums) {
    for (const name of await afc.readDir(`/DCIM/${album}`)) {
      listOnly.push(`/DCIM/${album}/${name}`)
    }
  }
  const tList = performance.now() - t0
  ok(`readDir over ${albums.length} albums: ${listOnly.length} paths in ${(tList / 1000).toFixed(2)}s`)

  const t1 = performance.now()
  const files: Entry[] = []
  let total = 0
  for (const p of listOnly) {
    const st = await afc.stat(p)
    if (st.isDirectory) continue
    files.push({ path: p, size: st.size })
    total += st.size
  }
  const tStat = performance.now() - t1
  ok(`stat on ${files.length} files in ${(tStat / 1000).toFixed(2)}s`)
  info(`${(tStat / files.length).toFixed(2)} ms per stat, ${fmt(total)} total`)
  info(`full enumeration: ${((tList + tStat) / 1000).toFixed(2)}s`)

  // ------------------------------------------------------------ throughput
  step('throughput, cold files only')
  const largest = [...files].sort((a, b) => b.size - a.size)
  info(`largest file ${fmt(largest[0]!.size)}, ${largest.length} candidates`)

  const PER_CHANNEL = 128 * MB
  let picked = 0

  async function readCapped(client: AfcClient, entry: Entry, cap: number): Promise<number> {
    const h = await client.open(entry.path)
    let read = 0
    const budget = Math.min(entry.size, cap)
    while (read < budget) {
      const b = await client.read(h, Math.min(4 * MB, budget - read))
      if (b.length === 0) break
      read += b.length
    }
    await client.close(h)
    return read
  }

  for (const concurrency of [1, 2, 4]) {
    // Distinct files each round so nothing is served from the device cache.
    const round = largest.slice(picked, picked + concurrency)
    picked += concurrency
    if (round.length < concurrency) {
      info(`not enough large files for concurrency ${concurrency}, skipped`)
      continue
    }

    const clients = await Promise.all(Array.from({ length: concurrency }, () => openAfc()))
    const start = performance.now()
    const readBytes = await Promise.all(
      clients.map((c, i) => readCapped(c, round[i]!, PER_CHANNEL)),
    )
    const secs = (performance.now() - start) / 1000
    const sum = readBytes.reduce((a, b) => a + b, 0)
    for (const c of clients) c.destroy()

    ok(`${concurrency} channel${concurrency > 1 ? 's' : ''}: ${fmt(sum)} in ${secs.toFixed(2)}s = ${(sum / MB / secs).toFixed(1)} MB/s`)
  }

  // -------------------------------------------------------------- chunk size
  step('chunk size, single channel')
  const probe = largest[picked]!
  for (const chunkMb of [1, 4, 16]) {
    const c = await openAfc()
    const h = await c.open(probe.path)
    const budget = Math.min(probe.size, 64 * MB)
    const start = performance.now()
    let read = 0
    while (read < budget) {
      const b = await c.read(h, Math.min(chunkMb * MB, budget - read))
      if (b.length === 0) break
      read += b.length
    }
    const secs = (performance.now() - start) / 1000
    await c.close(h)
    c.destroy()
    ok(`${chunkMb} MB chunks: ${(read / MB / secs).toFixed(1)} MB/s`)
  }

  // ------------------------------------------------------------ projection
  step('projection for this library')
  info(`${files.length} files, ${fmt(total)}`)

  afc.destroy()
  await lockdown.stopSession()
  lockdown.destroy()
}

main().catch((e) => {
  console.error(`\n\x1b[31mfailed\x1b[0m ${(e as Error).stack}`)
  process.exitCode = 1
})
