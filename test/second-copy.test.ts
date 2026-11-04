import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDevice } from '../src/device/fake-device.ts'
import { openLibrary, type Db } from '../src/library/db.ts'
import { ImportEngine, PreflightFailed } from '../src/import/engine.ts'
import { buildRunReport, renderRunReport } from '../src/import/report.ts'
import { libraryFiles, makeHeic, makeVideo, putOnDevice, scratch, type Scratch } from './helpers.ts'

const MTIME = Date.UTC(2026, 5, 8, 12, 30, 0)

let s: Scratch
let db: Db
let mirror: string

beforeEach(() => {
  s = scratch()
  db = openLibrary(s.dbPath)
  mirror = path.join(path.dirname(s.libraryRoot), 'backup')
})

afterEach(() => {
  db.close()
  s.cleanup()
})

describe('second copy', () => {
  it('copies every imported file to the same path under the second root, verified', async () => {
    putOnDevice(s, 'IMG_0001.HEIC', makeHeic(), MTIME)
    putOnDevice(s, 'IMG_0001.MOV', makeVideo(), MTIME)

    const result = await new ImportEngine(db, new FakeDevice({ root: s.deviceRoot })).run({
      libraryRoot: s.libraryRoot,
      secondCopyRoot: mirror,
    })

    expect(libraryFiles(mirror).sort()).toEqual(libraryFiles(s.libraryRoot).sort())
    for (const rel of libraryFiles(s.libraryRoot)) {
      expect(fs.readFileSync(path.join(mirror, rel))).toEqual(fs.readFileSync(path.join(s.libraryRoot, rel)))
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM file WHERE mirror_verified_at IS NOT NULL`).get()).toEqual({ n: 2 })
    expect(renderRunReport(buildRunReport(db, result.runId))).toContain('Second copy  2 verified, 0 failed')
  })

  it('keeps the import when the second copy fails, and records why', async () => {
    putOnDevice(s, 'IMG_0002.HEIC', makeHeic(), MTIME)
    fs.mkdirSync(mirror, { recursive: true })
    // A file where the year folder should go makes the copy fail.
    fs.writeFileSync(path.join(mirror, '2026'), '')

    const result = await new ImportEngine(db, new FakeDevice({ root: s.deviceRoot })).run({
      libraryRoot: s.libraryRoot,
      secondCopyRoot: mirror,
    })

    expect(result.imported).toBe(1)
    expect(libraryFiles(s.libraryRoot)).toHaveLength(1)
    const row = db.prepare(`SELECT mirror_verified_at, mirror_error FROM file`).get() as {
      mirror_verified_at: number | null
      mirror_error: string | null
    }
    expect(row.mirror_verified_at).toBeNull()
    expect(row.mirror_error).toBeTruthy()
    expect(renderRunReport(buildRunReport(db, result.runId))).toContain('Second copy  0 verified, 1 failed')
  })

  it('refuses up front when the second destination cannot be written', async () => {
    putOnDevice(s, 'IMG_0003.HEIC', makeHeic(), MTIME)
    fs.mkdirSync(path.dirname(mirror), { recursive: true })
    fs.writeFileSync(mirror, '') // a file, not a folder

    await expect(
      new ImportEngine(db, new FakeDevice({ root: s.deviceRoot })).run({
        libraryRoot: s.libraryRoot,
        secondCopyRoot: mirror,
      }),
    ).rejects.toThrow(PreflightFailed)
  })

  it('does nothing extra when no second copy is configured', async () => {
    putOnDevice(s, 'IMG_0004.HEIC', makeHeic(), MTIME)
    const result = await new ImportEngine(db, new FakeDevice({ root: s.deviceRoot })).run({ libraryRoot: s.libraryRoot })
    expect(fs.existsSync(mirror)).toBe(false)
    expect(renderRunReport(buildRunReport(db, result.runId))).not.toContain('Second copy')
  })
})
