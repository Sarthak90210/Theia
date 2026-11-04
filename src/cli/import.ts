import path from 'node:path'
import { AfcDevice } from '../device/afc-device.ts'
import { DeviceDetachedError } from '../device/types.ts'
import { openLibrary } from '../library/db.ts'
import { ImportEngine, ImportCancelled, PreflightFailed } from '../import/engine.ts'
import { buildAssets } from '../import/grouping.ts'
import { ExifToolReader } from '../metadata/reader.ts'

/**
 * Import everything off the attached phone.
 *
 * Usage: tsx src/cli/import.ts [libraryRoot] [--dry-run] [--second-copy=PATH]
 *
 * Output is one line every couple of seconds rather than a redrawn line, so it
 * stays readable when piped to a log.
 */

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const LIBRARY_ROOT = args.find((a) => !a.startsWith('--')) ?? 'D:\\PhotosLibrary'

const GB = 1024 ** 3
const fmt = (n: number) => (n >= GB ? `${(n / GB).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19)
}

async function main() {
  console.log(`\nphotos-win import`)
  console.log(`library: ${LIBRARY_ROOT}`)

  const device = await AfcDevice.attach()
  const ident = await device.identity()
  console.log(`device:  ${ident.name}, ${ident.model}, iOS ${ident.osVersion}\n`)

  const db = openLibrary(path.join(LIBRARY_ROOT, 'library.db'))
  const metadata = new ExifToolReader()
  const engine = new ImportEngine(db, device)
  const secondArg = args.find((a) => a.startsWith('--second-copy='))
  const opts = {
    libraryRoot: path.join(LIBRARY_ROOT, 'media'),
    metadata,
    secondCopyRoot: secondArg ? secondArg.slice('--second-copy='.length) : undefined,
  }
  if (opts.secondCopyRoot) console.log(`second copy: ${opts.secondCopyRoot}`)

  console.log(`[${stamp()}] enumerating...`)
  const enumStart = Date.now()
  const pre = await engine.preflight(opts)
  console.log(`[${stamp()}] enumerated in ${duration(Date.now() - enumStart)}`)
  console.log(`  on device:        ${pre.filesOnDevice} files`)
  console.log(`  to import:        ${pre.filesToImport} files, ${fmt(pre.bytesToTransfer)}`)
  console.log(`  already imported: ${pre.filesAlreadyImported}`)
  console.log(
    `  destination:      ${pre.destinationFreeBytes === null ? 'free space unknown' : `${fmt(pre.destinationFreeBytes)} free`}, ${pre.destinationWritable ? 'writable' : 'NOT WRITABLE'}`,
  )
  for (const p of pre.problems) console.log(`  problem: ${p}`)

  if (DRY_RUN || !pre.ok) {
    if (!pre.ok) process.exitCode = 1
    await metadata.close()
    db.close()
    await device.dispose()
    return
  }
  // No early exit when there is nothing new. The run still has bookkeeping to
  // do, such as retiring items for files deleted from the phone, and with
  // nothing to transfer it costs one more enumeration.
  if (pre.filesToImport === 0) console.log(`\nnothing new to import. Checking for deleted files...`)

  console.log(`\n[${stamp()}] transferring...`)
  const started = Date.now()
  let lastLog = 0

  try {
    const report = await engine.run({
      ...opts,
      onProgress: (p) => {
        const now = Date.now()
        if (now - lastLog < 2000) return
        lastLog = now
        const pct = p.bytesTotal > 0 ? ((p.bytesDone / p.bytesTotal) * 100).toFixed(1) : '0.0'
        const rate = `${(p.bytesPerSecond / 1024 ** 2).toFixed(1)} MB/s`
        const eta = p.etaMs === null ? '?' : duration(p.etaMs)
        console.log(
          `[${stamp()}] ${pct}%  ${p.filesDone}/${p.filesTotal}  ${fmt(p.bytesDone)}/${fmt(p.bytesTotal)}  ${rate}  eta ${eta}  ${path.basename(p.devicePath)}`,
        )
      },
    })

    console.log(`\n[${stamp()}] transfer done in ${duration(report.durationMs)}`)
    console.log(`  imported     ${report.imported} files, ${fmt(report.bytes)}`)
    console.log(`  skipped      ${report.skipped}`)
    console.log(`  quarantined  ${report.quarantined}`)
    for (const f of report.failures) {
      console.log(`    ${path.basename(f.devicePath)}  L${f.level}  ${f.detail}`)
    }
    if (report.reportPath) console.log(`  report       ${report.reportPath}`)

    console.log(`\n[${stamp()}] grouping...`)
    const grouped = buildAssets(db, { libraryRoot: opts.libraryRoot })
    console.log(
      `  assets ${grouped.assetsCreated}: ${grouped.stills} still, ${grouped.videos} video, ${grouped.livePhotos} live, ${grouped.bursts} burst`,
    )
    console.log(`  sidecars absorbed ${grouped.sidecarsAbsorbed}, unpaired ${grouped.unpaired}`)
    console.log(`  time sources:   ${JSON.stringify(grouped.timeSources)}`)
    console.log(`  offset sources: ${JSON.stringify(grouped.offsetSources)}`)
    console.log(`\ntotal wall clock ${duration(Date.now() - started)}`)
  } catch (e) {
    if (e instanceof DeviceDetachedError) {
      // Not a failure so much as an interruption. Every byte already verified
      // stays put, and the next run seeks to where this one stopped.
      console.log(`\n[${stamp()}] device disconnected after ${duration(Date.now() - started)}`)
      console.log(`  progress is saved. Reconnect and run this again to resume.`)
      process.exitCode = 2
    } else if (e instanceof ImportCancelled) {
      console.log(`\ncancelled. Progress is saved.`)
      process.exitCode = 2
    } else if (e instanceof PreflightFailed) {
      console.log(`\nrefused: ${e.message}`)
      process.exitCode = 1
    } else {
      throw e
    }
    // The engine writes a report for a stopped run too. Point at it. A refused
    // preflight never opened a run, so the latest one would be someone else's.
    if (e instanceof PreflightFailed) return
    const last = db
      .prepare(`SELECT report_path FROM import_run ORDER BY id DESC LIMIT 1`)
      .get() as { report_path: string | null } | undefined
    if (last?.report_path) console.log(`  report: ${last.report_path}`)
  } finally {
    await metadata.close()
    db.close()
    await device.dispose()
  }
}

main().catch((e) => {
  console.error(`\nfailed: ${(e as Error).stack}`)
  process.exitCode = 1
})
