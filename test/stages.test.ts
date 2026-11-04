import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openLibrary, type Db } from '../src/library/db.ts'
import { canMove, IllegalTransition, moveItem, type Stage } from '../src/import/stages.ts'
import { backoffMs, classify } from '../src/import/retry.ts'
import { scratch, type Scratch } from './helpers.ts'

let s: Scratch
let db: Db

beforeEach(() => {
  s = scratch()
  db = openLibrary(s.dbPath)
  db.prepare(`INSERT INTO device (udid, name) VALUES ('u', 'phone')`).run()
  db.prepare(
    `INSERT INTO import_run (id, device_udid, library_root, started_at, status) VALUES (1, 'u', '/lib', 0, 'running')`,
  ).run()
})

afterEach(() => {
  db.close()
  s.cleanup()
})

function item(stage: Stage): number {
  const res = db
    .prepare(
      `INSERT INTO import_item (run_id, device_udid, device_path, device_size, device_mtime, stage, updated_at)
       VALUES (1, 'u', ?, 10, 0, ?, 0)`,
    )
    .run(`/DCIM/${Math.random()}`, stage)
  return Number(res.lastInsertRowid)
}

function stageOf(id: number): Stage {
  return (db.prepare(`SELECT stage FROM import_item WHERE id = ?`).get(id) as { stage: Stage }).stage
}

describe('stage transitions', () => {
  it('walks the happy path', () => {
    const id = item('planned')
    for (const to of ['fetching', 'verifying', 'committed'] as const) moveItem(db, id, to)
    expect(stageOf(id)).toBe('committed')
  })

  it('refuses to commit twice, the bug this guard exists to catch', () => {
    const id = item('committed')
    expect(() => moveItem(db, id, 'committed')).toThrow(IllegalTransition)
    expect(() => moveItem(db, id, 'committed')).toThrow(/cannot move from committed to committed/)
  })

  it('refuses to skip verification', () => {
    const id = item('fetching')
    expect(() => moveItem(db, id, 'committed')).toThrow(IllegalTransition)
    expect(stageOf(id)).toBe('fetching')
  })

  it('leaves the row untouched when it refuses', () => {
    const id = item('committed')
    expect(() => moveItem(db, id, 'fetching', { bytes_received: 999 })).toThrow()
    expect(db.prepare(`SELECT bytes_received FROM import_item WHERE id = ?`).get(id)).toEqual({
      bytes_received: 0,
    })
  })

  it('names a missing item rather than reporting a bad move', () => {
    expect(() => moveItem(db, 12345, 'fetching')).toThrow(/does not exist/)
  })

  it('sets fields in the same statement as the stage', () => {
    const id = item('planned')
    moveItem(db, id, 'fetching', { attempts: 2, bytes_received: 7, staging_path: '/s' }, 42)
    expect(
      db.prepare(`SELECT stage, attempts, bytes_received, staging_path, updated_at FROM import_item WHERE id = ?`).get(id),
    ).toEqual({ stage: 'fetching', attempts: 2, bytes_received: 7, staging_path: '/s', updated_at: 42 })
  })

  it('lets quarantine go back to planned or forward to committed, and nowhere else', () => {
    expect(canMove('quarantined', 'planned')).toBe(true)
    expect(canMove('quarantined', 'committed')).toBe(true)
    expect(canMove('quarantined', 'fetching')).toBe(false)
    expect(canMove('quarantined', 'verifying')).toBe(false)
  })

  it('never writes skipped', () => {
    for (const from of ['planned', 'fetching', 'verifying', 'committed', 'quarantined'] as const) {
      expect(canMove(from, 'skipped')).toBe(false)
    }
  })
})

describe('failure classes', () => {
  it.each([
    ['AFC FILE_READ failed: operation timeout', 'transient'],
    ['AFC FILE_READ failed: io error', 'transient'],
    ['socket hang up', 'transient'],
    ['AFC FILE_OPEN failed: object not found', 'permanent'],
    ['AFC FILE_OPEN failed: permission denied', 'permanent'],
    ['ENOSPC: no space left on device, write', 'fatal'],
  ])('%s is %s', (message, cls) => {
    expect(classify(new Error(message)).cls).toBe(cls)
  })

  it('reads the Node error code as well as the message', () => {
    const e = Object.assign(new Error('write failed'), { code: 'ENOSPC' })
    expect(classify(e).cls).toBe('fatal')
  })

  it('doubles the backoff and caps it', () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n, 250))).toEqual([250, 500, 1000, 2000])
    expect(backoffMs(20, 250)).toBe(8000)
    expect(backoffMs(3, 0)).toBe(0)
  })
})
