import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exiftool } from 'exiftool-vendored'
import { UsbmuxConnection } from '../src/protocol/usbmux.ts'
import { LockdownClient, LOCKDOWN_PORT, TLS_STRATEGIES, type PairRecord } from '../src/protocol/lockdown.ts'
import { AfcClient } from '../src/protocol/afc.ts'
import { parsePlist } from '../src/protocol/plist-io.ts'

/**
 * Checks the grouping and metadata assumptions in the spec against the real
 * camera roll: what the library is actually made of, whether Apple's
 * ContentIdentifier survives an AFC read, and whether it really pairs Live
 * Photos.
 */

const ok = (s: string) => console.log(`  \x1b[32mok\x1b[0m    ${s}`)
const bad = (s: string) => console.log(`  \x1b[31mfail\x1b[0m  ${s}`)
const info = (s: string) => console.log(`        ${s}`)
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`)

const MB = 1024 * 1024
const fmt = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / MB).toFixed(1)} MB`)

const OUT = path.join(os.tmpdir(), 'photos-win-probe')

async function main() {
  const mux = await UsbmuxConnection.open()
  const devices = await mux.listDevices()
  mux.close()
  const dev = devices.find((d) => d.Properties.ConnectionType === 'USB')
  if (!dev) throw new Error('no USB device, plug the phone in and unlock it')
  const deviceId = dev.Properties.DeviceID

  const mux2 = await UsbmuxConnection.open()
  const pairData = await mux2.readPairRecord(dev.Properties.SerialNumber)
  mux2.close()
  if (!pairData) throw new Error('no pairing record')
  const pair = parsePlist(pairData) as PairRecord

  const muxL = await UsbmuxConnection.open()
  const lockdown = new LockdownClient(await muxL.connectToPort(deviceId, LOCKDOWN_PORT))
  await lockdown.queryType()
  const session = await lockdown.startSession(pair)
  if (session.ssl) await lockdown.enableSSL(pair, TLS_STRATEGIES[0]!)
  const svc = await lockdown.startService('com.apple.afc')
  const muxA = await UsbmuxConnection.open()
  const afc = new AfcClient(await muxA.connectToPort(deviceId, svc.port))

  // ------------------------------------------------------------- survey
  step('library composition')
  const albums = await afc.readDir('/DCIM')
  const byExt = new Map<string, { count: number; bytes: number }>()
  const stems = new Map<string, Set<string>>()
  const sizeOf = new Map<string, number>()

  for (const album of albums) {
    for (const name of await afc.readDir(`/DCIM/${album}`)) {
      const full = `/DCIM/${album}/${name}`
      const st = await afc.stat(full)
      if (st.isDirectory) continue
      const ext = (path.extname(name) || '(none)').toUpperCase()
      const acc = byExt.get(ext) ?? { count: 0, bytes: 0 }
      acc.count++
      acc.bytes += st.size
      byExt.set(ext, acc)

      const stem = `${album}/${path.basename(name, path.extname(name))}`
      if (!stems.has(stem)) stems.set(stem, new Set())
      stems.get(stem)!.add(ext)
      sizeOf.set(full, st.size)
    }
  }

  for (const [ext, v] of [...byExt.entries()].sort((a, b) => b[1].count - a[1].count)) {
    info(`${ext.padEnd(8)} ${String(v.count).padStart(5)} files  ${fmt(v.bytes)}`)
  }

  // ------------------------------------------------------- candidate sets
  step('grouping candidates')
  const livePairs = [...stems.entries()].filter(
    ([, e]) => e.has('.HEIC') && e.has('.MOV'),
  )
  const jpgLivePairs = [...stems.entries()].filter(([, e]) => e.has('.JPG') && e.has('.MOV'))
  const edited = [...stems.keys()].filter((s) => /\/IMG_E\d+$/.test(s))
  const aae = [...stems.entries()].filter(([, e]) => e.has('.AAE'))

  info(`stem pairs with both HEIC and MOV: ${livePairs.length}`)
  info(`stem pairs with both JPG and MOV:  ${jpgLivePairs.length}`)
  info(`edited renders (IMG_E*):           ${edited.length}`)
  info(`stems carrying an AAE:             ${aae.length}`)

  if (livePairs.length === 0) {
    bad('no HEIC + MOV stem pair found, cannot test Live Photo pairing')
    afc.destroy()
    await lockdown.stopSession()
    lockdown.destroy()
    await exiftool.end()
    return
  }

  // ------------------------------------------------------------ download
  step('pulling samples over AFC')
  fs.mkdirSync(OUT, { recursive: true })

  async function pull(devPath: string): Promise<string> {
    const local = path.join(OUT, path.basename(devPath))
    const h = await afc.open(devPath)
    const chunks: Buffer[] = []
    for (;;) {
      const b = await afc.read(h, 4 * MB)
      if (b.length === 0) break
      chunks.push(b)
    }
    await afc.close(h)
    fs.writeFileSync(local, Buffer.concat(chunks))
    return local
  }

  // Smallest Live Photo pair, so the video is quick to pull.
  const ranked = livePairs
    .map(([stem]) => ({
      stem,
      still: `/DCIM/${stem}.HEIC`,
      motion: `/DCIM/${stem}.MOV`,
    }))
    .filter((c) => sizeOf.has(c.still) && sizeOf.has(c.motion))
    .sort((a, b) => sizeOf.get(a.motion)! - sizeOf.get(b.motion)!)

  const sample = ranked[0]!
  info(`${sample.stem}  still ${fmt(sizeOf.get(sample.still)!)}, motion ${fmt(sizeOf.get(sample.motion)!)}`)
  const stillLocal = await pull(sample.still)
  const motionLocal = await pull(sample.motion)
  ok('both halves on disk')

  // --------------------------------------------------------- the real test
  step('does ContentIdentifier survive, and does it pair?')

  // -G1 gives family-1 group names: Apple MakerNote tags land under "Apple:",
  // the QuickTime Keys atom under "Keys:". With -G0 the same tags read as
  // "MakerNotes:" and "QuickTime:". The spec used the -G0 spelling.
  const stillTags = (await exiftool.readRaw(stillLocal, ['-G1'])) as unknown as Record<string, unknown>
  const motionTags = (await exiftool.readRaw(motionLocal, ['-G1'])) as unknown as Record<string, unknown>

  const findId = (tags: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(tags)) {
      if (/ContentIdentifier$/i.test(k)) return { key: k, value: String(v) }
    }
    return null
  }

  const stillId = findId(stillTags)
  const motionId = findId(motionTags)

  if (!stillId) bad('still carries no ContentIdentifier, MakerNote may be absent')
  else ok(`still: ${stillId.key} = ${stillId.value}`)

  if (!motionId) bad('motion carries no ContentIdentifier')
  else ok(`motion: ${motionId.key} = ${motionId.value}`)

  if (stillId && motionId) {
    if (stillId.value === motionId.value) {
      ok('identifiers match, pairing by ContentIdentifier is valid')
    } else {
      bad('identifiers differ, this stem pair is NOT one Live Photo')
    }
  }

  // ------------------------------------------------------ metadata fields
  step('fields the spec calls canonical')
  const want = [
    'DateTimeOriginal',
    'OffsetTimeOriginal',
    'CreateDate',
    'GPSLatitude',
    'GPSLongitude',
    'Make',
    'Model',
    'LensModel',
    'Orientation',
    'BurstUUID',
    'MediaGroupUUID',
  ]
  for (const field of want) {
    const hit = Object.entries(stillTags).find(([k]) => k.endsWith(`:${field}`) || k === field)
    if (hit) ok(`${field.padEnd(20)} ${String(hit[1]).slice(0, 48)}`)
    else info(`${field.padEnd(20)} absent`)
  }

  const makerNoteKeys = Object.keys(stillTags).filter((k) => /^(MakerNotes|Apple):/i.test(k))
  step('Apple MakerNote')
  if (makerNoteKeys.length === 0) {
    bad('no MakerNote tags at all, Live Photo pairing would be impossible')
  } else {
    ok(`${makerNoteKeys.length} MakerNote tags present`)
    info(makerNoteKeys.slice(0, 12).map((k) => k.split(':').pop()).join(', '))
  }

  // ------------------------------------------------------------- edits
  step('edits: AAE sidecars with no IMG_E renders')
  const aaeStems = aae.slice(0, 6)
  for (const [stem, exts] of aaeStems) {
    info(`${stem}: ${[...exts].sort().join(' ')}`)
  }

  const firstAae = aaeStems[0]
  if (firstAae) {
    const local = await pull(`/DCIM/${firstAae[0]}.AAE`)
    const raw = fs.readFileSync(local)
    try {
      const parsed = parsePlist(raw) as Record<string, unknown>
      ok(`AAE parsed as a plist, ${raw.length} bytes`)
      for (const [k, v] of Object.entries(parsed)) {
        const shown = Buffer.isBuffer(v) ? `<${v.length} bytes>` : String(v).slice(0, 60)
        info(`  ${k} = ${shown}`)
      }
    } catch (e) {
      bad(`AAE did not parse as a plist: ${(e as Error).message}`)
      info(raw.subarray(0, 160).toString('utf8').replace(/[^\x20-\x7e\n]/g, '.'))
    }
  }

  info(`\nsamples left in ${OUT} for use as test fixtures`)

  afc.destroy()
  await lockdown.stopSession()
  lockdown.destroy()
  await exiftool.end()
}

main().catch(async (e) => {
  console.error(`\n\x1b[31mfailed\x1b[0m ${(e as Error).stack}`)
  await exiftool.end().catch(() => {})
  process.exitCode = 1
})
