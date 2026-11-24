// How long claiming the next job takes with a big backlog: every thumbnail
// queued at once, as after a large import. Run it on a COPY of a vault's
// library.db; it migrates and rewrites the copy.
//
//   npx tsx scripts/bench-queue.ts <copy of library.db>
import { openLibrary } from '../src/library/db.ts'
import { JobQueue } from '../src/jobs/queue.ts'

const db = openLibrary(process.argv[2]!)
db.prepare(`UPDATE job SET state = 'queued', not_before = 0 WHERE kind = 'thumbnail'`).run()
const queued = (db.prepare(`SELECT COUNT(*) n FROM job WHERE kind = 'thumbnail' AND state = 'queued'`).get() as { n: number }).n

const old = db.prepare(`SELECT j.id FROM job j JOIN asset a ON a.id = j.asset_id
  WHERE j.kind = ? AND j.state = 'queued' AND j.not_before <= ? ORDER BY a.captured_utc DESC, j.id ASC LIMIT 1`)
let s = performance.now()
for (let i = 0; i < 200; i++) old.get('thumbnail', Date.now())
console.log(`old claim, ${queued} queued: ${((performance.now() - s) / 200).toFixed(3)} ms`)

// The real thing: claim and complete every job, as a drain does.
const q = new JobQueue(db)
s = performance.now()
let n = 0
for (let job = q.claim('thumbnail'); job; job = q.claim('thumbnail')) { q.complete(job.id); n++ }
console.log(`new claim+complete over ${n} jobs: ${((performance.now() - s) / n).toFixed(3)} ms each, ${((performance.now() - s) / 1000).toFixed(1)} s total`)
