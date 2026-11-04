import os from 'node:os'
import { libraryLayout } from '../library/layout.ts'
import { openLibrary } from '../library/db.ts'
import { JobQueue } from '../jobs/queue.ts'
import { HeicPool } from '../thumbs/heic-pool.ts'
import { runVerify, verifySummary, VERIFY_DECODE } from '../verify/jobs.ts'

/**
 * Level 3 verification: decode every file in the library.
 *
 * Usage: tsx src/cli/verify.ts [libraryRoot] [--workers=N] [--recheck]
 *
 * Stoppable and resumable like the thumbnail run. Files already decoded in
 * full are skipped.
 */

const args = process.argv.slice(2)
const ROOT = args.find((a) => !a.startsWith('--')) ?? 'D:\\PhotosLibrary'
const workersArg = args.find((a) => a.startsWith('--workers='))
const WORKERS = workersArg ? Number(workersArg.split('=')[1]) : Math.max(1, Math.min(os.cpus().length - 2, 8))

function stamp(): string {
  return new Date().toISOString().slice(11, 19)
}

async function main() {
  const layout = libraryLayout(ROOT)
  const db = openLibrary(layout.db)
  const queue = new JobQueue(db)

  console.log(`\nphotos-win verify (level 3, decode)`)
  console.log(`media: ${layout.media}\n`)

  if (args.includes('--recheck')) {
    // Check flagged files again, after a fix to the check itself or a re-import.
    const flagged = db
      .prepare(`SELECT DISTINCT asset_id FROM file WHERE decode_error IS NOT NULL AND asset_id IS NOT NULL`)
      .all() as { asset_id: number }[]
    db.prepare(`UPDATE file SET decode_error = NULL WHERE decode_error IS NOT NULL`).run()
    for (const f of flagged) queue.enqueue(VERIFY_DECODE, f.asset_id)
    console.log(`rechecking ${flagged.length} assets with flagged files`)
  }
  const added = queue.enqueueAll(VERIFY_DECODE)
  const start = queue.counts(VERIFY_DECODE)
  console.log(`queued ${added} new. ${start.queued} to do, ${start.done} already done.\n`)

  const heic = new HeicPool(WORKERS)
  const ctrl = new AbortController()
  process.on('SIGINT', () => {
    console.log(`\nstopping after the jobs in flight. Run again to continue.`)
    ctrl.abort()
  })

  const began = Date.now()
  let settled = 0
  let lastLog = 0
  const total = start.queued
  try {
    await runVerify(db, queue, layout.media, { heic }, {
      concurrency: WORKERS + 2,
      signal: ctrl.signal,
      onSettled: (job, outcome, err) => {
        settled++
        if (outcome === 'failed') console.log(`[${stamp()}] could not check asset ${job.assetId}: ${(err as Error)?.message}`)
        const now = Date.now()
        if (now - lastLog < 2000 && settled !== total) return
        lastLog = now
        const rate = settled / ((now - began) / 1000)
        console.log(`[${stamp()}] ${settled}/${total}  ${rate.toFixed(1)}/s`)
      },
    })
  } finally {
    await heic.close()
  }

  const s = verifySummary(db)
  console.log(`\n[${stamp()}] done in ${((Date.now() - began) / 1000).toFixed(0)}s`)
  console.log(`  files     ${s.files}`)
  console.log(`  decoded   ${s.decoded}`)
  console.log(`  damaged   ${s.damaged.length}`)
  for (const d of s.damaged) console.log(`    ${d.path}  ${d.error}`)
  for (const u of s.unchecked) console.log(`  unchecked ${u.n} ${u.mime}`)
  db.close()
}

main().catch((e) => {
  console.error(`\nfailed: ${(e as Error).stack}`)
  process.exitCode = 1
})
