import type { Db } from '../library/db.ts'
import { backoffMs, sleep } from '../import/retry.ts'

/**
 * A persisted queue of background work, one row per kind per asset.
 *
 * The same idea as the import state machine. Every job carries its own state,
 * so a crash, a quit and a cancel all recover the same way: anything left
 * `running` was interrupted and goes back to `queued`.
 *
 * Jobs are claimed most recent capture first, so the photos a person is most
 * likely to look at get their thumbnails, and later their search index, before
 * the ones from five years ago.
 */

export type JobState = 'queued' | 'running' | 'done' | 'failed'

export interface Job {
  id: number
  kind: string
  assetId: number
  attempts: number
}

/** Thrown by a handler when trying again cannot help, such as an unsupported format. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentJobError'
  }
}

export interface JobCounts {
  queued: number
  running: number
  done: number
  failed: number
}

export class JobQueue {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Queue `kind` for every live asset that does not have it yet. Returns how many were added. */
  enqueueAll(kind: string): number {
    const at = this.now()
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO job (kind, asset_id, state, created_at, updated_at)
         SELECT ?, id, 'queued', ?, ? FROM asset WHERE deleted_at IS NULL`,
      )
      .run(kind, at, at).changes
  }

  enqueue(kind: string, assetId: number): void {
    const at = this.now()
    this.db
      .prepare(
        `INSERT INTO job (kind, asset_id, state, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)
         ON CONFLICT(kind, asset_id) DO UPDATE SET
           state = 'queued', attempts = 0, last_error = NULL, not_before = 0, updated_at = excluded.updated_at`,
      )
      .run(kind, assetId, at, at)
  }

  /** Put interrupted jobs back. Call once at startup, before any worker runs. */
  recover(kind?: string): number {
    const sql = kind
      ? `UPDATE job SET state = 'queued', updated_at = ? WHERE state = 'running' AND kind = ?`
      : `UPDATE job SET state = 'queued', updated_at = ? WHERE state = 'running'`
    const stmt = this.db.prepare(sql)
    return (kind ? stmt.run(this.now(), kind) : stmt.run(this.now())).changes
  }

  /** Requeue failed jobs, for when the cause has been fixed. */
  retryFailed(kind: string): number {
    return this.db
      .prepare(
        `UPDATE job SET state = 'queued', attempts = 0, last_error = NULL, not_before = 0, updated_at = ?
          WHERE kind = ? AND state = 'failed'`,
      )
      .run(this.now(), kind).changes
  }

  /** The next ready job of `kind`, marked running. Null when none is ready. */
  claim(kind: string): Job | null {
    const at = this.now()
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT j.id, j.kind, j.asset_id, j.attempts
             FROM job j JOIN asset a ON a.id = j.asset_id
            WHERE j.kind = ? AND j.state = 'queued' AND j.not_before <= ?
            ORDER BY a.captured_utc DESC, j.id ASC
            LIMIT 1`,
        )
        .get(kind, at) as { id: number; kind: string; asset_id: number; attempts: number } | undefined
      if (!row) return null
      this.db
        .prepare(`UPDATE job SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`)
        .run(at, row.id)
      return { id: row.id, kind: row.kind, assetId: row.asset_id, attempts: row.attempts + 1 }
    })()
  }

  complete(jobId: number): void {
    this.db
      .prepare(`UPDATE job SET state = 'done', last_error = NULL, updated_at = ? WHERE id = ? AND state = 'running'`)
      .run(this.now(), jobId)
  }

  /**
   * Record a failure. A transient one goes back in the queue after a backoff
   * until it runs out of attempts. A permanent one fails straight away.
   */
  fail(job: Job, error: unknown, opts: { maxAttempts: number; retryBaseMs: number }): 'queued' | 'failed' {
    const message = (error as Error)?.message ?? String(error)
    const permanent = error instanceof PermanentJobError
    const giveUp = permanent || job.attempts >= opts.maxAttempts
    const at = this.now()
    this.db
      .prepare(
        `UPDATE job SET state = ?, last_error = ?, not_before = ?, updated_at = ? WHERE id = ? AND state = 'running'`,
      )
      .run(giveUp ? 'failed' : 'queued', message, giveUp ? 0 : at + backoffMs(job.attempts, opts.retryBaseMs), at, job.id)
    return giveUp ? 'failed' : 'queued'
  }

  counts(kind: string): JobCounts {
    const out: JobCounts = { queued: 0, running: 0, done: 0, failed: 0 }
    const rows = this.db
      .prepare(`SELECT state, COUNT(*) AS n FROM job WHERE kind = ? GROUP BY state`)
      .all(kind) as { state: JobState; n: number }[]
    for (const r of rows) out[r.state] = r.n
    return out
  }

  failures(kind: string): { assetId: number; error: string }[] {
    return (
      this.db
        .prepare(`SELECT asset_id, last_error FROM job WHERE kind = ? AND state = 'failed' ORDER BY asset_id`)
        .all(kind) as { asset_id: number; last_error: string | null }[]
    ).map((r) => ({ assetId: r.asset_id, error: r.last_error ?? 'unknown error' }))
  }

  /** The earliest time a queued job becomes ready, or null if none is waiting on a backoff. */
  nextReadyAt(kind: string): number | null {
    const row = this.db
      .prepare(`SELECT MIN(not_before) AS t FROM job WHERE kind = ? AND state = 'queued'`)
      .get(kind) as { t: number | null }
    return row.t
  }
}

export interface RunOptions {
  /** How many jobs run at once. Match it to what the handler is bound by. */
  concurrency: number
  maxAttempts?: number
  retryBaseMs?: number
  signal?: AbortSignal
  onSettled?: (job: Job, outcome: 'done' | 'queued' | 'failed', error?: unknown) => void
}

/**
 * Drain the queue for one kind. Returns when nothing is queued, or when the
 * signal aborts, in which case jobs in flight finish and nothing new starts.
 *
 * Claims happen on this thread against a synchronous database, so two loops
 * can never claim the same job. Handlers do their heavy work elsewhere (worker
 * threads, child processes) and only report back here.
 */
export async function drain(
  queue: JobQueue,
  kind: string,
  handler: (job: Job) => Promise<void>,
  opts: RunOptions,
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 3
  const retryBaseMs = opts.retryBaseMs ?? 1000

  async function loop() {
    for (;;) {
      if (opts.signal?.aborted) return
      const job = queue.claim(kind)
      if (!job) {
        // Nothing ready. Wait out a backoff if one is pending, else this loop is done.
        const next = queue.nextReadyAt(kind)
        if (next === null) return
        await sleep(Math.max(10, next - Date.now()), opts.signal)
        continue
      }
      try {
        await handler(job)
        queue.complete(job.id)
        opts.onSettled?.(job, 'done')
      } catch (e) {
        const outcome = queue.fail(job, e, { maxAttempts, retryBaseMs })
        opts.onSettled?.(job, outcome, e)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, loop))
}
