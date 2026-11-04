import fs from 'node:fs'
import path from 'node:path'
import { UsbmuxConnection, type DeviceEntry, type Recorder } from '../src/protocol/usbmux.ts'
import { LockdownClient, LOCKDOWN_PORT, TLS_STRATEGIES, type PairRecord } from '../src/protocol/lockdown.ts'
import { AfcClient } from '../src/protocol/afc.ts'
import { parsePlist } from '../src/protocol/plist-io.ts'

const transcript: unknown[] = []
const record: Recorder = (dir, layer, msg) => {
  transcript.push({ t: Date.now(), dir, layer, msg })
}

const ok = (s: string) => console.log(`  \x1b[32mok\x1b[0m    ${s}`)
const bad = (s: string) => console.log(`  \x1b[31mfail\x1b[0m  ${s}`)
const info = (s: string) => console.log(`        ${s}`)
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`)

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function loadPairRecordFromDisk(udid: string): PairRecord | null {
  const dir = 'C:\\ProgramData\\Apple\\Lockdown'
  for (const name of [`${udid}.plist`, `${udid.replace('-', '')}.plist`]) {
    const p = path.join(dir, name)
    try {
      return parsePlist(fs.readFileSync(p)) as PairRecord
    } catch {
      /* try the next spelling */
    }
  }
  return null
}

async function openLockdown(deviceId: number): Promise<LockdownClient> {
  const mux = await UsbmuxConnection.open(record)
  const tunnel = await mux.connectToPort(deviceId, LOCKDOWN_PORT)
  return new LockdownClient(tunnel, record)
}

async function main() {
  console.log('\n\x1b[1mphotos-win transport probe\x1b[0m')
  console.log('Answering: can Node reach the camera roll over AFC, and does seek work?')

  // ---------------------------------------------------------------- device
  step('1. usbmuxd')
  let devices: DeviceEntry[]
  const mux = await UsbmuxConnection.open(record)
  try {
    devices = await mux.listDevices()
  } finally {
    mux.close()
  }
  ok(`connected to usbmuxd on 127.0.0.1:27015`)

  const usb = devices.find((d) => d.Properties.ConnectionType === 'USB')
  if (!usb) {
    bad(`no USB device found (${devices.length} device records total)`)
    info('Plug the phone in over USB, unlock it, and make sure you tapped Trust.')
    process.exitCode = 1
    return
  }
  const deviceId = usb.Properties.DeviceID
  const udid = usb.Properties.SerialNumber
  ok(`device ${deviceId} over USB`)
  info(`udid ${udid}`)

  // ------------------------------------------------------------ pair record
  step('2. pairing record')
  let pair: PairRecord | null = null
  const mux2 = await UsbmuxConnection.open(record)
  try {
    const data = await mux2.readPairRecord(udid)
    if (data) {
      pair = parsePlist(data) as PairRecord
      ok('read from usbmuxd, no elevation needed')
    }
  } catch (e) {
    info(`usbmuxd ReadPairRecord failed: ${(e as Error).message}`)
  } finally {
    mux2.close()
  }
  if (!pair) {
    pair = loadPairRecordFromDisk(udid)
    if (pair) ok('read from C:\\ProgramData\\Apple\\Lockdown')
  }
  if (!pair?.HostCertificate || !pair.HostPrivateKey) {
    bad('no usable pairing record')
    info('Unlock the phone and tap Trust, then run this again.')
    process.exitCode = 1
    return
  }
  info(`HostID ${pair.HostID}`)
  info(`cert ${pair.HostCertificate.length} bytes, key ${pair.HostPrivateKey.length} bytes`)

  // ------------------------------------------------------------------- TLS
  step('3. lockdownd handshake and TLS upgrade')
  info('This is the risk this probe exists to measure.')
  let lockdown: LockdownClient | null = null

  for (const strategy of TLS_STRATEGIES) {
    let attempt: LockdownClient | null = null
    try {
      attempt = await openLockdown(deviceId)
      const type = await attempt.queryType()
      if (type !== 'com.apple.mobile.lockdown') throw new Error(`unexpected service type ${type}`)
      const session = await attempt.startSession(pair)
      if (!session.ssl) {
        ok(`${strategy.name}: device did not ask for SSL at all`)
        lockdown = attempt
        break
      }
      await attempt.enableSSL(pair, strategy)
      // Prove the encrypted channel actually carries lockdown traffic.
      const name = await attempt.getValue('DeviceName')
      ok(`${strategy.name}`)
      info(`device name over TLS: ${name}`)
      lockdown = attempt
      break
    } catch (e) {
      bad(`${strategy.name}: ${(e as Error).message}`)
      attempt?.destroy()
    }
  }

  if (!lockdown) {
    console.log('')
    bad('every TLS strategy failed')
    info('Fall back to bundling libimobiledevice binaries. Nothing above the')
    info('device seam changes, only the transport module.')
    process.exitCode = 1
    return
  }
  info(`working strategy: ${lockdown.tlsStrategy ?? 'none needed'}`)

  const product = await lockdown.getValue('ProductType')
  const version = await lockdown.getValue('ProductVersion')
  info(`${product} on iOS ${version}`)

  // ------------------------------------------------------------------- AFC
  step('4. AFC service')
  const svc = await lockdown.startService('com.apple.afc')
  ok(`com.apple.afc on port ${svc.port}, service ssl ${svc.ssl}`)
  if (svc.ssl) {
    bad('AFC wants its own SSL layer, which this probe does not implement')
    process.exitCode = 1
    return
  }

  const mux3 = await UsbmuxConnection.open(record)
  const afcStream = await mux3.connectToPort(deviceId, svc.port)
  const afc = new AfcClient(afcStream, record)

  const dev = await afc.deviceInfo()
  ok('AFC handshake')
  info(`model ${dev.Model}, ${bytes(Number(dev.FSFreeBytes))} free of ${bytes(Number(dev.FSTotalBytes))}`)

  // -------------------------------------------------------------- the roll
  step('5. camera roll')
  const albums = await afc.readDir('/DCIM')
  ok(`/DCIM has ${albums.length} entries: ${albums.slice(0, 6).join(', ')}${albums.length > 6 ? ' ...' : ''}`)

  let target: { path: string; size: number } | null = null
  let totalFiles = 0
  let totalBytes = 0

  for (const album of albums) {
    const entries = await afc.readDir(`/DCIM/${album}`)
    let albumBytes = 0
    for (const name of entries) {
      const st = await afc.stat(`/DCIM/${album}/${name}`)
      if (st.isDirectory) continue
      totalFiles++
      albumBytes += st.size
      totalBytes += st.size
      if (!target && st.size > 200_000) target = { path: `/DCIM/${album}/${name}`, size: st.size }
    }
    info(`${album}: ${entries.length} entries, ${bytes(albumBytes)}`)
  }
  ok(`${totalFiles} files, ${bytes(totalBytes)} total`)

  if (!target) {
    bad('no file large enough to test ranged reads')
    afc.destroy()
    await lockdown.stopSession()
    lockdown.destroy()
    return
  }

  // ------------------------------------------------------------ seek proof
  step('6. ranged read, the thing resume depends on')
  info(`${target.path}, ${bytes(target.size)}`)

  const A = 4096
  const B = 4096

  // Contiguous baseline.
  let h = await afc.open(target.path)
  const whole = Buffer.concat([await afc.read(h, A), await afc.read(h, B)])
  await afc.close(h)

  // First half only, as if the transfer died at byte A.
  h = await afc.open(target.path)
  const firstHalf = await afc.read(h, A)
  await afc.close(h)

  // Resume: reopen, seek past what we already have, read the rest.
  h = await afc.open(target.path)
  await afc.seek(h, BigInt(A))
  const tell = await afc.tell(h)
  const secondHalf = await afc.read(h, B)
  await afc.close(h)

  const resumed = Buffer.concat([firstHalf, secondHalf])

  info(`magic: ${whole.subarray(4, 12).toString('ascii').replace(/[^\x20-\x7e]/g, '.')}`)
  if (tell !== BigInt(A)) bad(`seek reported offset ${tell}, expected ${A}`)
  else ok(`seek to ${A} confirmed by tell`)

  if (resumed.equals(whole)) {
    ok(`resumed read matches contiguous read byte for byte (${resumed.length} bytes)`)
  } else {
    bad('resumed read does NOT match the contiguous read')
    process.exitCode = 1
  }

  // Throughput, so the perf target in the spec has a real number behind it.
  step('7. throughput')
  const chunk = 4 * 1024 * 1024
  const budget = Math.min(target.size, 64 * 1024 * 1024)
  h = await afc.open(target.path)
  const t0 = performance.now()
  let read = 0
  while (read < budget) {
    const b = await afc.read(h, Math.min(chunk, budget - read))
    if (b.length === 0) break
    read += b.length
  }
  const secs = (performance.now() - t0) / 1000
  await afc.close(h)
  ok(`${bytes(read)} in ${secs.toFixed(2)}s = ${bytes(read / secs)}/s`)

  // ------------------------------------------------------------- teardown
  afc.destroy()
  await lockdown.stopSession()
  lockdown.destroy()

  fs.mkdirSync('transcripts', { recursive: true })
  const out = path.join('transcripts', `probe-${Date.now()}.json`)
  fs.writeFileSync(out, JSON.stringify(transcript, null, 2))
  step('done')
  info(`transcript written to ${out} (${transcript.length} frames, secrets redacted)`)
}

main().catch((e) => {
  console.error(`\n\x1b[31munhandled\x1b[0m ${(e as Error).stack}`)
  process.exitCode = 1
})
