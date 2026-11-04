import os from 'node:os'
import { libraryLayout } from '../library/layout.ts'
import { openLibrary } from '../library/db.ts'
import { JobQueue } from '../jobs/queue.ts'
import { HeicPool } from '../thumbs/heic-pool.ts'
import { queueThumbnails, runThumbnails, THUMBNAIL } from '../thumbs/jobs.ts'

/**
 * Render thumbnails for every asset that lacks them.
 *
 * Usage: tsx src/cli/thumbs.ts [libraryRoot] [--retry-failed] [--workers=N]
 *
 * Safe to stop at any point and run again. Finished thumbnails are kept, and
 * interrupted jobs go back in the queue.
 */

const args = process.argv.slice(2)
const ROOT = args.find((a) => !a.startsWith('--')) ?? 'D:\\PhotosLibrary'
const RETRY = args.includes('--retry-failed')
const workersArg = args.find((a) => a.startsWith('--workers='))
// Leave cores for the rest of the machine. HEIC decode is the bottleneck and
// each worker holds a decoded 12 MP image (about 50 MB) at a time.
const WORKERS = workersArg ? Number(workersArg.split('=')[1]) : Math.max(1, Math.min(os.cpus().length - 2, 8))

function stamp(): string {
  return new Date().toISOString().slice(11, 19)
}

async function main() {
  const layout = libraryLayout(ROOT)
  const db = openLibrary(layout.db)
  const queue = new JobQueue(db)

  console.log(`\nphotos-win thumbnails`)
  console.log(`media: ${layout.media}`)
  console.log(`cache: ${layout.cache}`)
  console.log(`HEIC workers: ${WORKERS}\n`)

  if (RETRY) console.log(`requeued ${queue.retryFailed(THUMBNAIL)} failed jobs`)
  const { added, requeued } = queueThumbnails(db, queue, layout.cache)
  const start = queue.counts(THUMBNAIL)
  console.log(`queued ${added} new, ${requeued} with missing files. ${start.queued} to do, ${start.done} already done.\n`)

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
    await runThumbnails(db, queue, layout.media, layout.cache, { heic }, {
      concurrency: WORKERS + 2,
      signal: ctrl.signal,
      onSettled: (_job, outcome, err) => {
        settled++
        if (outcome === 'failed') console.log(`[${stamp()}] failed asset ${_job.assetId}: ${(err as Error)?.message}`)
        const now = Date.now()
        if (now - lastLog < 2000 && settled !== total) return
        lastLog = now
        const secs = (now - began) / 1000
        const rate = settled / secs
        const eta = rate > 0 ? Math.round((total - settled) / rate) : 0
        console.log(`[${stamp()}] ${settled}/${total}  ${rate.toFixed(1)}/s  eta ${eta}s`)
      },
    })
  } finally {
    await heic.close()
  }

  const end = queue.counts(THUMBNAIL)
  const secs = (Date.now() - began) / 1000
  console.log(`\n[${stamp()}] done in ${secs.toFixed(0)}s: ${end.done} done, ${end.failed} failed, ${end.queued} still queued`)
  for (const f of queue.failures(THUMBNAIL).slice(0, 20)) console.log(`  asset ${f.assetId}: ${f.error}`)
  db.close()
}

main().catch((e) => {
  console.error(`\nfailed: ${(e as Error).stack}`)
  process.exitCode = 1
})
