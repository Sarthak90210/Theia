import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openLibrary, type Db } from '../src/library/db.ts'
import { drain, JobQueue, PermanentJobError, type Job } from '../src/jobs/queue.ts'
import { scratch, type Scratch } from './helpers.ts'

let s: Scratch
let db: Db

beforeEach(() => {
  s = scratch()
  db = openLibrary(s.dbPath)
})

afterEach(() => {
  db.close()
  s.cleanup()
})

function asset(capturedUtc: number, deleted = false): number {
  return Number(
    db
      .prepare(
        `INSERT INTO asset (kind, captured_utc, deleted_at, created_at, updated_at) VALUES ('still', ?, ?, 0, 0)`,
      )
      .run(capturedUtc, deleted ? 1 : null).lastInsertRowid,
  )
}

describe('job queue', () => {
  it('queues every live asset once, however often it is asked', () => {
    asset(1)
    asset(2)
    asset(3, true)
    const q = new JobQueue(db)
    expect(q.enqueueAll('thumbnail')).toBe(2)
    expect(q.enqueueAll('thumbnail')).toBe(0)
    expect(q.counts('thumbnail')).toEqual({ queued: 2, running: 0, done: 0, failed: 0 })
  })

  it('hands out the most recent capture first', () => {
    const old = asset(1_000)
    const recent = asset(9_000)
    const middle = asset(5_000)
    const q = new JobQueue(db)
    q.enqueueAll('thumbnail')
    expect([q.claim('thumbnail'), q.claim('thumbnail'), q.claim('thumbnail')].map((j) => j!.assetId)).toEqual([
      recent,
      middle,
      old,
    ])
    expect(q.claim('thumbnail')).toBeNull()
  })

  it('puts jobs interrupted by a crash back in the queue', () => {
    asset(1)
    const q = new JobQueue(db)
    q.enqueueAll('thumbnail')
    q.claim('thumbnail')
    expect(q.counts('thumbnail').running).toBe(1)

    expect(new JobQueue(db).recover('thumbnail')).toBe(1)
    expect(q.counts('thumbnail')).toMatchObject({ queued: 1, running: 0 })
  })

  it('retries a transient failure after a backoff, then gives up', () => {
    asset(1)
    let clock = 1_000_000
    const q = new JobQueue(db, () => clock)
    q.enqueueAll('thumbnail')
    const opts = { maxAttempts: 2, retryBaseMs: 500 }

    const first = q.claim('thumbnail')!
    expect(q.fail(first, new Error('busy'), opts)).toBe('queued')
    // Not ready until the backoff has passed.
    expect(q.claim('thumbnail')).toBeNull()
    clock += 500
    const second = q.claim('thumbnail')!
    expect(second.attempts).toBe(2)
    expect(q.fail(second, new Error('still busy'), opts)).toBe('failed')
    expect(q.failures('thumbnail')).toEqual([{ assetId: 1, error: 'still busy' }])
  })

  it('fails a permanent error on the first attempt', () => {
    asset(1)
    const q = new JobQueue(db)
    q.enqueueAll('thumbnail')
    const job = q.claim('thumbnail')!
    expect(q.fail(job, new PermanentJobError('no renderer for image/x-foo'), { maxAttempts: 5, retryBaseMs: 0 })).toBe(
      'failed',
    )
  })

  it('requeues failed jobs on request, with their attempts reset', () => {
    asset(1)
    const q = new JobQueue(db)
    q.enqueueAll('thumbnail')
    q.fail(q.claim('thumbnail')!, new PermanentJobError('x'), { maxAttempts: 3, retryBaseMs: 0 })
    expect(q.retryFailed('thumbnail')).toBe(1)
    expect(q.claim('thumbnail')!.attempts).toBe(1)
  })
})

describe('drain', () => {
  it('runs every job exactly once across concurrent loops', async () => {
    for (let i = 0; i < 40; i++) asset(i)
    const q = new JobQueue(db)
    q.enqueueAll('thumbnail')
    const seen: number[] = []
    let inFlight = 0
    let peak = 0

    await drain(
      q,
      'thumbnail',
      async (job: Job) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 2))
        seen.push(job.assetId)
        inFlight--
      },
      { concurrency: 6 },
    )

    expect(seen).toHaveLength(40)
    expect(new Set(seen).size).toBe(40)
    expect(peak).toBe(6)
    expect(q.counts('thumbnail')).toEqual({ queued: 0, running: 0, done: 40, failed: 0 })
  })

  it('waits out a backoff and finishes the retry before returning', async () => {
    asset(1)
    const q = new JobQueue(db)
    q.enqueueAll('thumbnail')
    let calls = 0

    await drain(
      q,
      'thumbnail',
      async () => {
        if (++calls === 1) throw new Error('flaky')
      },
      { concurrency: 2, retryBaseMs: 20 },
    )

    expect(calls).toBe(2)
    expect(q.counts('thumbnail').done).toBe(1)
  })

  it('stops taking new work when aborted, and leaves the rest queued', async () => {
    for (let i = 0; i < 10; i++) asset(i)
    const q = new JobQueue(db)
    q.enqueueAll('thumbnail')
    const ctrl = new AbortController()
    let ran = 0

    await drain(
      q,
      'thumbnail',
      async () => {
        if (++ran === 3) ctrl.abort()
      },
      { concurrency: 1, signal: ctrl.signal },
    )

    expect(ran).toBe(3)
    expect(q.counts('thumbnail')).toMatchObject({ done: 3, queued: 7, running: 0 })
  })
})
