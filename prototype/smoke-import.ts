import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AfcDevice } from '../src/device/afc-device.ts'
import type { DeviceFile, DeviceHandle, DeviceIdentity, DeviceSource } from '../src/device/types.ts'
import { openLibrary } from '../src/library/db.ts'
import { ImportEngine } from '../src/import/engine.ts'
import { buildAssets } from '../src/import/grouping.ts'
import { ExifToolReader } from '../src/metadata/reader.ts'

/**
 * End to end against the real phone: transfer, verify, extract, group.
 *
 * The file selection is a decorator over the real device rather than an option
 * on the engine. The seam paying for itself again: the engine cannot tell the
 * difference, so none of this needed a test-only code path.
 */

const LIMIT = Number(process.argv[2] ?? 40)
const MAX_FILE_BYTES = 120 * 1024 ** 2

const IMAGE = /\.(heic|heif|jpe?g|png|dng)$/i
const VIDEO = /\.(mov|mp4|m4v)$/i

interface Stem {
  dir: string
  names: string[]
}

class Selected implements DeviceSource {
  private allowed = new Set<string>()

  constructor(private readonly inner: DeviceSource, private readonly n: number) {}

  /**
   * A representative mix rather than the most interesting category.
   *
   * Three corrections learned by running this. Preferring merely "multi-file"
   * stems picks up HEIC-plus-AAE and pairs nothing. Looking at only the first
   * album misses Live Photos entirely, since 105APPLE has none and 104APPLE is
   * full of them. And taking Live Photos exclusively hides every code path that
   * handles a missing offset, because Live Photos always record one.
   *
   * So: round-robin across categories, which is what a real camera roll holds.
   */
  async prepare(): Promise<{ albums: number; stems: number; picked: Record<string, number> }> {
    const albums = (await this.inner.list('/DCIM')).filter((a) => !a.startsWith('.'))
    const stems: Stem[] = []

    for (const album of albums) {
      const dir = `/DCIM/${album}`
      const byStem = new Map<string, string[]>()
      for (const name of await this.inner.list(dir)) {
        const stem = name.slice(0, name.length - path.extname(name).length)
        byStem.set(stem, [...(byStem.get(stem) ?? []), name])
      }
      for (const names of byStem.values()) stems.push({ dir, names })
    }

    const isLive = (s: Stem) =>
      s.names.some((n) => IMAGE.test(n)) && s.names.some((n) => VIDEO.test(n))

    const buckets: [string, Stem[]][] = [
      ['live', stems.filter(isLive)],
      ['sidecar', stems.filter((s) => s.names.length > 1 && !isLive(s))],
      // Screenshots are the case with no offset tag and no GPS to derive one.
      ['screenshot', stems.filter((s) => s.names.length === 1 && /\.png$/i.test(s.names[0]!))],
      ['video', stems.filter((s) => s.names.length === 1 && VIDEO.test(s.names[0]!))],
      [
        'photo',
        stems.filter(
          (s) => s.names.length === 1 && IMAGE.test(s.names[0]!) && !/\.png$/i.test(s.names[0]!),
        ),
      ],
    ]

    const cursor = buckets.map(() => 0)
    const picked: Record<string, number> = {}
    let count = 0
    let taken = 0

    for (let progressed = true; progressed && count < this.n; ) {
      progressed = false
      for (let i = 0; i < buckets.length && count < this.n; i++) {
        const [label, bucket] = buckets[i]!
        while (cursor[i]! < bucket.length) {
          const stem = bucket[cursor[i]!]!
          cursor[i] = cursor[i]! + 1
          if (count + stem.names.length > this.n) continue

          let bytes = 0
          for (const name of stem.names) {
            bytes += (await this.inner.stat(`${stem.dir}/${name}`)).size
          }
          if (bytes > MAX_FILE_BYTES) continue

          for (const name of stem.names) this.allowed.add(`${stem.dir}/${name}`)
          count += stem.names.length
          taken++
          picked[label] = (picked[label] ?? 0) + 1
          progressed = true
          break
        }
      }
    }
    return { albums: albums.length, stems: taken, picked }
  }

  async list(dir: string): Promise<string[]> {
    if (dir === '/DCIM') {
      return [...new Set([...this.allowed].map((p) => p.split('/')[2]!))]
    }
    return [...this.allowed]
      .filter((p) => p.startsWith(`${dir}/`))
      .map((p) => p.slice(dir.length + 1))
  }
  identity(): Promise<DeviceIdentity> {
    return this.inner.identity()
  }
  freeBytes(): Promise<number> {
    return this.inner.freeBytes()
  }
  stat(p: string): Promise<DeviceFile> {
    return this.inner.stat(p)
  }
  open(p: string): Promise<DeviceHandle> {
    return this.inner.open(p)
  }
  dispose(): Promise<void> {
    return this.inner.dispose()
  }
}

const fmt = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`)

function offsetLabel(seconds: number | null): string {
  if (seconds === null) return 'unknown'
  const sign = seconds < 0 ? '-' : '+'
  const abs = Math.abs(seconds)
  return `${sign}${String(Math.floor(abs / 3600)).padStart(2, '0')}:${String(Math.floor((abs % 3600) / 60)).padStart(2, '0')}`
}

async function main() {
  const root = path.join(os.tmpdir(), 'photos-win-smoke')
  fs.rmSync(root, { recursive: true, force: true })
  const libraryRoot = path.join(root, 'library')
  fs.mkdirSync(libraryRoot, { recursive: true })

  const real = await AfcDevice.attach()
  const ident = await real.identity()
  console.log(`\n\x1b[1msmoke import\x1b[0m  ${ident.name}, ${ident.model}, iOS ${ident.osVersion}`)

  const device = new Selected(real, LIMIT)
  const { albums, stems, picked } = await device.prepare()
  console.log(`        scanned ${albums} albums, selected ${stems} stems: ${JSON.stringify(picked)}`)

  const db = openLibrary(path.join(root, 'library.db'))
  const metadata = new ExifToolReader()
  const engine = new ImportEngine(db, device)

  step('transfer and verify')
  const t0 = performance.now()
  let lastShown = ''
  const report = await engine.run({
    libraryRoot,
    metadata,
    onProgress: (p) => {
      // One line per file rather than one per chunk.
      const line = `${p.filesDone + 1}/${p.filesTotal} ${path.basename(p.devicePath)}`
      if (line === lastShown) return
      lastShown = line
      process.stdout.write(`\r  ${line}`.padEnd(60))
    },
  })
  process.stdout.write('\r'.padEnd(62) + '\r')
  const secs = (performance.now() - t0) / 1000

  console.log(`  imported ${report.imported}, skipped ${report.skipped}, quarantined ${report.quarantined}`)
  console.log(`  ${fmt(report.bytes)} in ${secs.toFixed(1)}s`)
  for (const f of report.failures) console.log(`    ${path.basename(f.devicePath)} L${f.level} ${f.detail}`)

  step('grouping')
  const grouped = buildAssets(db, { libraryRoot })
  console.log(`  assets ${grouped.assetsCreated}: ${grouped.stills} still, ${grouped.videos} video, ${grouped.livePhotos} live, ${grouped.bursts} burst`)
  console.log(`  sidecars absorbed ${grouped.sidecarsAbsorbed}, unpaired ${grouped.unpaired}`)
  console.log(`  time sources:   ${JSON.stringify(grouped.timeSources)}`)
  console.log(`  offset sources: ${JSON.stringify(grouped.offsetSources)}`)

  step('assets')
  const assets = db
    .prepare(
      `SELECT a.id, a.kind, a.captured_utc, a.captured_offset, a.offset_source, a.time_source,
              a.has_adjustments, a.lat, a.lon, a.width, a.height, a.duration_ms,
              COUNT(f.id) AS files
         FROM asset a LEFT JOIN file f ON f.asset_id = a.id
        GROUP BY a.id ORDER BY a.captured_utc DESC LIMIT 14`,
    )
    .all() as any[]

  for (const a of assets) {
    const when = a.captured_utc
      ? new Date(a.captured_utc + (a.captured_offset ?? 0) * 1000).toISOString().replace('T', ' ').slice(0, 19)
      : '(no date)'
    const geo = a.lat ? `${a.lat.toFixed(3)},${a.lon.toFixed(3)}` : '-'
    const dims = a.width ? `${a.width}x${a.height}` : '-'
    const dur = a.duration_ms ? ` ${(a.duration_ms / 1000).toFixed(1)}s` : ''
    console.log(
      `  ${String(a.kind).padEnd(5)} ${when} ${offsetLabel(a.captured_offset).padEnd(6)}` +
        ` ${String(a.files)}f ${dims.padEnd(10)} ${geo.padEnd(16)}` +
        ` ${a.time_source}/${a.offset_source}${a.has_adjustments ? ' adj' : ''}${dur}`,
    )
  }

  step('live photo pairs')
  const livePhotos = db
    .prepare(
      `SELECT a.id, a.content_id, GROUP_CONCAT(f.role || ':' || f.mime) AS parts
         FROM asset a JOIN file f ON f.asset_id = a.id
        WHERE a.kind = 'live' GROUP BY a.id LIMIT 5`,
    )
    .all() as any[]
  if (livePhotos.length === 0) console.log('  none in this selection')
  for (const p of livePhotos) console.log(`  ${p.content_id}  ${p.parts}`)

  step('library on disk')
  const onDisk = db.prepare('SELECT path FROM file ORDER BY path LIMIT 10').all() as { path: string }[]
  for (const f of onDisk) console.log(`  ${f.path}`)

  await metadata.close()
  db.close()
  await real.dispose()
}

main().catch(async (e) => {
  console.error(`\n\x1b[31mfailed\x1b[0m ${(e as Error).stack}`)
  process.exitCode = 1
})
