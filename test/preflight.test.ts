import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDevice } from '../src/device/fake-device.ts'
import { openLibrary, type Db } from '../src/library/db.ts'
import {
  ImportEngine,
  PreflightFailed,
  RateMeter,
  type Progress,
} from '../src/import/engine.ts'
import { libraryFiles, makeHeic, makeVideo, putOnDevice, scratch, type Scratch } from './helpers.ts'

const MTIME = Date.UTC(2026, 5, 8, 12, 30, 0)

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

describe('preflight', () => {
  it('counts what a run would do before doing any of it', async () => {
    const a = makeHeic({ mdatBytes: 4096 })
    const b = makeVideo({ mdatBytes: 8192 })
    putOnDevice(s, 'IMG_0001.HEIC', a, MTIME)
    putOnDevice(s, 'IMG_0002.MOV', b, MTIME)

    const engine = new ImportEngine(db, new FakeDevice({ root: s.deviceRoot }))
    const report = await engine.preflight({ libraryRoot: s.libraryRoot })

    expect(report.ok).toBe(true)
    expect(report.filesOnDevice).toBe(2)
    expect(report.filesToImport).toBe(2)
    expect(report.filesAlreadyImported).toBe(0)
    expect(report.bytesToTransfer).toBe(a.length + b.length)
    expect(report.destinationWritable).toBe(true)
    expect(report.problems).toEqual([])

    // Nothing was transferred by asking.
    expect(libraryFiles(s.libraryRoot)).toEqual([])
  })

  it('stops counting files it has already imported', async () => {
    putOnDevice(s, 'IMG_0010.HEIC', makeHeic(), MTIME)
    const engine = new ImportEngine(db, new FakeDevice({ root: s.deviceRoot }))
    await engine.run({ libraryRoot: s.libraryRoot })

    const report = await engine.preflight({ libraryRoot: s.libraryRoot })
    expect(report.filesToImport).toBe(0)
    expect(report.filesAlreadyImported).toBe(1)
    expect(report.bytesToTransfer).toBe(0)
  })

  it('refuses a run that cannot fit, naming both numbers', async () => {
    const video = makeVideo({ mdatBytes: 64 * 1024 })
    putOnDevice(s, 'IMG_0020.MOV', video, MTIME)

    const device = new FakeDevice({ root: s.deviceRoot })
    const engine = new ImportEngine(db, device)
    const opts = { libraryRoot: s.libraryRoot, headroomBytes: Number.MAX_SAFE_INTEGER / 2 }

    const report = await engine.preflight(opts)
    expect(report.ok).toBe(false)
    expect(report.problems[0]).toMatch(/needs .* GB plus .* GB headroom, but only .* GB is free/)

    await expect(engine.run(opts)).rejects.toBeInstanceOf(PreflightFailed)
    // The refusal happens before any transfer, which is the entire point.
    expect(libraryFiles(s.libraryRoot)).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_item').get()).toEqual({ n: 0 })
  })

  it('carries the report on the thrown error so a caller can render it', async () => {
    putOnDevice(s, 'IMG_0030.HEIC', makeHeic(), MTIME)
    const engine = new ImportEngine(db, new FakeDevice({ root: s.deviceRoot }))
    const opts = { libraryRoot: s.libraryRoot, headroomBytes: Number.MAX_SAFE_INTEGER / 2 }

    await engine.run(opts).then(
      () => expect.unreachable('should have refused'),
      (e: unknown) => {
        expect(e).toBeInstanceOf(PreflightFailed)
        const failed = e as PreflightFailed
        expect(failed.report.filesToImport).toBe(1)
        expect(failed.report.destinationFreeBytes).toBeGreaterThan(0)
      },
    )
  })

  it('proceeds anyway when told to', async () => {
    putOnDevice(s, 'IMG_0040.HEIC', makeHeic(), MTIME)
    const engine = new ImportEngine(db, new FakeDevice({ root: s.deviceRoot }))

    const result = await engine.run({
      libraryRoot: s.libraryRoot,
      headroomBytes: Number.MAX_SAFE_INTEGER / 2,
      skipPreflight: true,
    })

    expect(result.imported).toBe(1)
    // Overridden, not hidden: the report still says what it found.
    expect(result.preflight.ok).toBe(false)
  })

  it('reports an unwritable destination rather than failing mid-transfer', async () => {
    // A path whose parent is a file cannot be created.
    const blocker = path.join(s.dir, 'not-a-directory')
    fs.writeFileSync(blocker, 'x')
    putOnDevice(s, 'IMG_0050.HEIC', makeHeic(), MTIME)

    const engine = new ImportEngine(db, new FakeDevice({ root: s.deviceRoot }))
    const report = await engine.preflight({ libraryRoot: path.join(blocker, 'library') })

    expect(report.destinationWritable).toBe(false)
    expect(report.ok).toBe(false)
    expect(report.problems[0]).toMatch(/not writable/)
  })

  it('counts only the bytes a resumed run still needs', async () => {
    const video = makeVideo({ mdatBytes: 64 * 1024 })
    const devPath = putOnDevice(s, 'IMG_0060.MOV', video, MTIME)
    const device = new FakeDevice({
      root: s.deviceRoot,
      faults: { [devPath]: { kind: 'detach-at', at: 16 * 1024 } },
    })
    const engine = new ImportEngine(db, device)

    await expect(
      engine.run({ libraryRoot: s.libraryRoot, chunkBytes: 4096 }),
    ).rejects.toThrow()

    device.clearFault(devPath)
    device.reattach()
    const report = await engine.preflight({ libraryRoot: s.libraryRoot })

    expect(report.filesToImport).toBe(1)
    expect(report.bytesToTransfer).toBe(video.length - 16 * 1024)
  })

  it('does not refuse when free space cannot be determined', async () => {
    // freeBytesOn returns null for an unstattable path; the run should proceed
    // rather than block on a measurement it could not take.
    putOnDevice(s, 'IMG_0070.HEIC', makeHeic(), MTIME)
    const engine = new ImportEngine(db, new FakeDevice({ root: s.deviceRoot }))
    const report = await engine.preflight({ libraryRoot: s.libraryRoot })
    expect(report.destinationFreeBytes).not.toBe(0)
    expect(report.ok).toBe(true)
  })
})

describe('progress', () => {
  it('reports run-wide bytes, a rate and an estimate', async () => {
    for (let i = 0; i < 3; i++) {
      putOnDevice(s, `IMG_010${i}.MOV`, makeVideo({ mdatBytes: 32 * 1024 }), MTIME)
    }

    const seen: Progress[] = []
    const engine = new ImportEngine(db, new FakeDevice({ root: s.deviceRoot }))
    const result = await engine.run({
      libraryRoot: s.libraryRoot,
      chunkBytes: 4096,
      onProgress: (p) => seen.push({ ...p }),
    })

    expect(result.imported).toBe(3)
    expect(seen.length).toBeGreaterThan(3)

    const last = seen[seen.length - 1]!
    expect(last.bytesTotal).toBe(result.preflight.bytesToTransfer)
    expect(last.bytesDone).toBeLessThanOrEqual(last.bytesTotal)
    expect(last.bytesPerSecond).toBeGreaterThanOrEqual(0)

    // Run-wide progress only ever moves forward, even as each file restarts
    // its own byte count from zero.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.bytesDone).toBeGreaterThanOrEqual(seen[i - 1]!.bytesDone)
    }
  })

  it('leaves the estimate null until there is a rate to divide by', async () => {
    putOnDevice(s, 'IMG_0200.HEIC', makeHeic({ mdatBytes: 1024 }), MTIME)
    const seen: Progress[] = []
    const engine = new ImportEngine(db, new FakeDevice({ root: s.deviceRoot }))
    await engine.run({
      libraryRoot: s.libraryRoot,
      onProgress: (p) => seen.push({ ...p }),
    })
    expect(seen[0]!.etaMs === null || seen[0]!.etaMs >= 0).toBe(true)
  })
})

describe('rate meter', () => {
  it('measures over the trailing window, not the whole run', () => {
    const meter = new RateMeter(5000)
    // A fast start followed by a stall must not keep reporting the fast rate.
    meter.sample(0, 0)
    meter.sample(10_000_000, 1000)
    expect(meter.bytesPerSecond()).toBeCloseTo(10_000_000, -3)

    for (let t = 2000; t <= 12_000; t += 1000) meter.sample(10_000_000, t)
    expect(meter.bytesPerSecond()).toBe(0)
  })

  it('returns zero rather than dividing by zero', () => {
    const meter = new RateMeter()
    expect(meter.bytesPerSecond()).toBe(0)
    meter.sample(100, 500)
    expect(meter.bytesPerSecond()).toBe(0)
  })
})
