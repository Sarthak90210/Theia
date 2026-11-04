import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDevice, type Fault } from '../src/device/fake-device.ts'
import { DeviceDetachedError } from '../src/device/types.ts'
import { openLibrary, type Db } from '../src/library/db.ts'
import { ImportCancelled, ImportEngine } from '../src/import/engine.ts'
import { libraryFiles, makeHeic, makeVideo, putOnDevice, scratch, type Scratch } from './helpers.ts'

/**
 * Every test drives the engine through the device seam and asserts on what a
 * user could observe: what is on disk, what the database says, what landed in
 * quarantine. Real filesystem, real SQLite file. Nothing is mocked, because
 * atomic rename and WAL recovery are the behaviour under test and a mock would
 * assert nothing about them.
 */

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

function device(faults?: Record<string, Fault>) {
  return new FakeDevice({ root: s.deviceRoot, faults })
}

function listQuarantineDir(): string[] {
  const dir = path.join(s.libraryRoot, '.quarantine')
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

function sha(buf: Buffer) {
  return createHash('sha256').update(buf).digest('hex')
}

describe('happy path', () => {
  it('imports every file, lays it out by date, and records it', async () => {
    const heic = makeHeic()
    const video = makeVideo()
    putOnDevice(s, 'IMG_0001.HEIC', heic, MTIME)
    putOnDevice(s, 'IMG_0001.MOV', video, MTIME)

    const report = await new ImportEngine(db, device()).run({ libraryRoot: s.libraryRoot })

    expect(report.imported).toBe(2)
    expect(report.quarantined).toBe(0)
    expect(report.failures).toEqual([])

    const files = libraryFiles(s.libraryRoot)
    expect(files).toHaveLength(2)
    for (const f of files) {
      expect(f).toMatch(/^2026\/2026-06\/20260608_\d{6}_IMG_0001\.(HEIC|MOV)$/)
    }

    // Bytes on disk are the bytes from the device, not merely the right count.
    const onDisk = fs.readFileSync(path.join(s.libraryRoot, files[0]!))
    expect([sha(heic), sha(video)]).toContain(sha(onDisk))

    const rows = db.prepare('SELECT path, bytes, sha256, verify_level FROM file').all() as {
      path: string
      bytes: number
      sha256: string
      verify_level: number
    }[]
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.verify_level === 2)).toBe(true)
    expect(rows.map((r) => r.sha256).sort()).toEqual([sha(heic), sha(video)].sort())
  })

  it('skips files it already imported on a second run', async () => {
    putOnDevice(s, 'IMG_0001.HEIC', makeHeic(), MTIME)
    const engine = new ImportEngine(db, device())

    const first = await engine.run({ libraryRoot: s.libraryRoot })
    expect(first.imported).toBe(1)
    expect(first.skipped).toBe(0)

    const second = await engine.run({ libraryRoot: s.libraryRoot })
    expect(second.imported).toBe(0)
    expect(second.skipped).toBe(1)
    expect(libraryFiles(s.libraryRoot)).toHaveLength(1)
  })
})

describe('verification', () => {
  it('quarantines a file whose byte count disagrees with the device', async () => {
    // The transcode-length-mismatch bug: stat says one thing, the bytes say
    // another, and the stock importer accepts it silently.
    const heic = makeHeic()
    const devPath = putOnDevice(s, 'IMG_0002.HEIC', heic, MTIME)
    const dev = device({ [devPath]: { kind: 'size-mismatch', reportSize: heic.length + 5000 } })

    const report = await new ImportEngine(db, dev).run({ libraryRoot: s.libraryRoot, retryBaseMs: 0 })

    expect(report.imported).toBe(0)
    expect(report.quarantined).toBe(1)
    expect(report.failures[0]!.level).toBe(0)
    expect(report.failures[0]!.detail).toMatch(/expected \d+ bytes, received \d+/)

    // Never in the library pretending to be fine.
    expect(libraryFiles(s.libraryRoot)).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM file').get()).toEqual({ n: 0 })
  })

  it('writes a quarantine report the user can act on', async () => {
    const heic = makeHeic()
    const devPath = putOnDevice(s, 'IMG_0003.HEIC', heic, MTIME)
    const dev = device({ [devPath]: { kind: 'size-mismatch', reportSize: heic.length + 100 } })

    await new ImportEngine(db, dev).run({ libraryRoot: s.libraryRoot, retryBaseMs: 0 })

    const reportPath = path.join(s.libraryRoot, '.quarantine', 'DCIM_100APPLE_IMG_0003.HEIC.json')
    const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    expect(parsed.devicePath).toBe(devPath)
    expect(parsed.expectedBytes).toBe(heic.length + 100)
    expect(parsed.receivedBytes).toBe(heic.length)
    expect(parsed.failedLevel).toBe(0)
    expect(parsed.attempts).toBe(3)
    expect(fs.existsSync(path.join(s.libraryRoot, '.quarantine', 'DCIM_100APPLE_IMG_0003.HEIC'))).toBe(true)
  })

  it('keeps two failures with the same name from different folders apart', async () => {
    // iPhone numbering wraps at IMG_9999 and starts again in the next folder.
    const a = makeHeic({ mdatBytes: 1000 })
    const b = makeHeic({ mdatBytes: 2000 })
    const pathA = putOnDevice(s, 'IMG_0042.HEIC', a, MTIME)
    fs.mkdirSync(path.join(s.deviceRoot, 'DCIM', '101APPLE'), { recursive: true })
    fs.writeFileSync(path.join(s.deviceRoot, 'DCIM', '101APPLE', 'IMG_0042.HEIC'), b)
    const pathB = '/DCIM/101APPLE/IMG_0042.HEIC'
    const dev = device({
      [pathA]: { kind: 'size-mismatch', reportSize: a.length + 10 },
      [pathB]: { kind: 'size-mismatch', reportSize: b.length + 10 },
    })

    const report = await new ImportEngine(db, dev).run({ libraryRoot: s.libraryRoot, retryBaseMs: 0 })

    expect(report.quarantined).toBe(2)
    const q = path.join(s.libraryRoot, '.quarantine')
    expect(fs.readFileSync(path.join(q, 'DCIM_100APPLE_IMG_0042.HEIC'))).toEqual(a)
    expect(fs.readFileSync(path.join(q, 'DCIM_101APPLE_IMG_0042.HEIC'))).toEqual(b)
  })

  it('quarantines a file the disk did not keep intact', async () => {
    const heic = makeHeic()
    putOnDevice(s, 'IMG_0006.HEIC', heic, MTIME)

    const report = await new ImportEngine(db, device()).run({
      libraryRoot: s.libraryRoot,
      // Flip one byte after the stream hash is taken, the way a bad write would.
      hooks: {
        afterFetch: (staged) => {
          const fd = fs.openSync(staged, 'r+')
          fs.writeSync(fd, Buffer.from([0xff]), 0, 1, 100)
          fs.closeSync(fd)
        },
      },
    })

    expect(report.imported).toBe(0)
    expect(report.failures[0]!.level).toBe(1)
    expect(report.failures[0]!.detail).toMatch(/bytes on disk differ from bytes received/)
    expect(libraryFiles(s.libraryRoot)).toEqual([])
  })

  it('skips the read-back when told to', async () => {
    putOnDevice(s, 'IMG_0007.HEIC', makeHeic(), MTIME)
    const report = await new ImportEngine(db, device()).run({
      libraryRoot: s.libraryRoot,
      readBack: false,
      hooks: {
        afterFetch: (staged) => {
          const fd = fs.openSync(staged, 'r+')
          fs.writeSync(fd, Buffer.from([0xff]), 0, 1, 100)
          fs.closeSync(fd)
        },
      },
    })
    // Structure still passes, because the flipped byte is inside mdat.
    expect(report.imported).toBe(1)
  })

  it('quarantines a structurally broken file that has the right byte count', async () => {
    // L0 cannot catch this: the length is exactly what the device reported.
    // Only the structure walk notices the index is gone.
    putOnDevice(s, 'IMG_0004.MOV', makeVideo({ moov: false }), MTIME)

    const report = await new ImportEngine(db, device()).run({ libraryRoot: s.libraryRoot })

    expect(report.imported).toBe(0)
    expect(report.failures[0]!.level).toBe(2)
    expect(report.failures[0]!.detail).toMatch(/no moov box/)
    expect(libraryFiles(s.libraryRoot)).toEqual([])
  })

  it('accepts the same broken file when structure checking is turned off', async () => {
    putOnDevice(s, 'IMG_0005.MOV', makeVideo({ moov: false }), MTIME)

    const report = await new ImportEngine(db, device()).run({
      libraryRoot: s.libraryRoot,
      maxVerifyLevel: 0,
    })

    expect(report.imported).toBe(1)
  })
})

describe('resume', () => {
  it('resumes from the byte it stopped at rather than starting over', async () => {
    const video = makeVideo({ mdatBytes: 64 * 1024 })
    const devPath = putOnDevice(s, 'IMG_0006.MOV', video, MTIME)
    const faults: Record<string, Fault> = { [devPath]: { kind: 'detach-at', at: 16 * 1024 } }
    const dev = device(faults)
    const engine = new ImportEngine(db, dev)

    await expect(
      engine.run({ libraryRoot: s.libraryRoot, chunkBytes: 4096 }),
    ).rejects.toBeInstanceOf(DeviceDetachedError)

    const stalled = db
      .prepare('SELECT stage, bytes_received FROM import_item WHERE device_path = ?')
      .get(devPath) as { stage: string; bytes_received: number }
    expect(stalled.stage).toBe('planned')
    expect(stalled.bytes_received).toBe(16 * 1024)
    expect(libraryFiles(s.libraryRoot)).toEqual([])

    // Cable replaced.
    dev.clearFault(devPath)
    dev.reattach()
    const report = await engine.run({ libraryRoot: s.libraryRoot, chunkBytes: 4096 })

    expect(report.imported).toBe(1)

    // The resumed attempt seeked instead of refetching from zero.
    expect(dev.seeks).toContainEqual({ path: devPath, offset: 16 * 1024 })
    expect(dev.bytesRequested(devPath)).toBe(video.length)

    // And the reassembled file is byte-identical, which is the point.
    const [only] = libraryFiles(s.libraryRoot)
    const onDisk = fs.readFileSync(path.join(s.libraryRoot, only!))
    expect(sha(onDisk)).toBe(sha(video))
  })

  it('survives the process dying mid-import and finishes in a fresh engine', async () => {
    const video = makeVideo({ mdatBytes: 32 * 1024 })
    const devPath = putOnDevice(s, 'IMG_0007.MOV', video, MTIME)
    const dev = device({ [devPath]: { kind: 'detach-at', at: 8 * 1024 } })

    await expect(
      new ImportEngine(db, dev).run({ libraryRoot: s.libraryRoot, chunkBytes: 4096 }),
    ).rejects.toBeInstanceOf(DeviceDetachedError)

    // Close the database as an unclean shutdown would leave it, then reopen.
    db.close()
    db = openLibrary(s.dbPath)

    dev.clearFault(devPath)
    dev.reattach()
    const report = await new ImportEngine(db, dev).run({
      libraryRoot: s.libraryRoot,
      chunkBytes: 4096,
    })

    expect(report.imported).toBe(1)
    const [only] = libraryFiles(s.libraryRoot)
    expect(sha(fs.readFileSync(path.join(s.libraryRoot, only!)))).toBe(sha(video))
  })

  it('handles a device that never fills a read', async () => {
    const video = makeVideo({ mdatBytes: 16 * 1024 })
    const devPath = putOnDevice(s, 'IMG_0008.MOV', video, MTIME)
    const dev = device({ [devPath]: { kind: 'short-reads', max: 997 } })

    const report = await new ImportEngine(db, dev).run({
      libraryRoot: s.libraryRoot,
      chunkBytes: 8192,
    })

    expect(report.imported).toBe(1)
    const [only] = libraryFiles(s.libraryRoot)
    expect(sha(fs.readFileSync(path.join(s.libraryRoot, only!)))).toBe(sha(video))
  })
})

describe('failures that are not corruption', () => {
  it('retries a transient failure, then quarantines it', async () => {
    putOnDevice(s, 'IMG_0009.HEIC', makeHeic(), MTIME)
    const bad = putOnDevice(s, 'IMG_0010.HEIC', makeHeic(), MTIME)
    const dev = device({ [bad]: { kind: 'open-fails', message: 'AFC FILE_OPEN failed: operation timeout' } })

    const report = await new ImportEngine(db, dev).run({
      libraryRoot: s.libraryRoot,
      maxAttempts: 3,
      retryBaseMs: 0,
    })

    // The healthy file still lands. One bad file does not sink the run.
    expect(report.imported).toBe(1)
    expect(report.quarantined).toBe(1)
    expect(report.failures[0]!.detail).toMatch(/after 3 attempts/)
    expect(report.failures[0]!.detail).toMatch(/operation timeout/)
    expect(report.failures[0]!.cls).toBe('transient')

    const attempts = db
      .prepare(`SELECT attempt, class FROM import_attempt ORDER BY attempt`)
      .all()
    expect(attempts).toEqual([
      { attempt: 1, class: 'transient' },
      { attempt: 2, class: 'transient' },
      { attempt: 3, class: 'transient' },
    ])
  })

  it('does not retry a failure that cannot get better', async () => {
    const bad = putOnDevice(s, 'IMG_0011.HEIC', makeHeic(), MTIME)
    const dev = device({ [bad]: { kind: 'open-fails', message: 'AFC FILE_OPEN failed: object not found' } })

    const report = await new ImportEngine(db, dev).run({ libraryRoot: s.libraryRoot, maxAttempts: 3 })

    expect(report.quarantined).toBe(1)
    expect(report.failures[0]!.cls).toBe('permanent')
    expect(report.failures[0]!.detail).toMatch(/not retried: .*object not found/)
    expect(dev.opened).toEqual([])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM import_attempt`).get()).toEqual({ n: 1 })
  })

  it('stops the run on a full disk instead of quarantining every file', async () => {
    putOnDevice(s, 'IMG_0012.HEIC', makeHeic(), MTIME)
    putOnDevice(s, 'IMG_0013.HEIC', makeHeic(), MTIME)
    const dev = device({
      '/DCIM/100APPLE/IMG_0012.HEIC': { kind: 'open-fails', message: 'ENOSPC: no space left on device' },
    })

    await expect(new ImportEngine(db, dev).run({ libraryRoot: s.libraryRoot })).rejects.toThrow(/ENOSPC/)

    // Parked, not quarantined, so the next run picks it up once space is freed.
    const row = db
      .prepare(`SELECT stage FROM import_item WHERE device_path = ?`)
      .get('/DCIM/100APPLE/IMG_0012.HEIC')
    expect(row).toEqual({ stage: 'planned' })
    expect(listQuarantineDir()).toEqual([])
  })

  it('waits longer between each transient retry', async () => {
    const bad = putOnDevice(s, 'IMG_0014.HEIC', makeHeic(), MTIME)
    const dev = device({ [bad]: { kind: 'open-fails', message: 'io error' } })
    const started = Date.now()

    await new ImportEngine(db, dev).run({ libraryRoot: s.libraryRoot, maxAttempts: 3, retryBaseMs: 40 })

    // 40 ms after the first failure, 80 ms after the second, none after the last.
    expect(Date.now() - started).toBeGreaterThanOrEqual(110)
  })

  it('leaves nothing in the library when cancelled', async () => {
    for (let i = 0; i < 4; i++) {
      putOnDevice(s, `IMG_01${i}0.HEIC`, makeHeic({ mdatBytes: 8192 }), MTIME)
    }
    const controller = new AbortController()

    const run = new ImportEngine(db, device()).run({
      libraryRoot: s.libraryRoot,
      signal: controller.signal,
      chunkBytes: 512,
      onProgress: () => controller.abort(),
    })

    await expect(run).rejects.toBeInstanceOf(ImportCancelled)
    expect(libraryFiles(s.libraryRoot)).toEqual([])
  })
})

describe('collisions', () => {
  it('keeps both files when two different photos want the same name', async () => {
    // Same capture second, same original name, different content.
    fs.mkdirSync(path.join(s.deviceRoot, 'DCIM', '101APPLE'), { recursive: true })
    const a = makeHeic({ mdatBytes: 1000 })
    const b = makeHeic({ mdatBytes: 2000 })
    putOnDevice(s, 'IMG_0100.HEIC', a, MTIME)
    fs.writeFileSync(path.join(s.deviceRoot, 'DCIM', '101APPLE', 'IMG_0100.HEIC'), b)
    fs.utimesSync(
      path.join(s.deviceRoot, 'DCIM', '101APPLE', 'IMG_0100.HEIC'),
      new Date(MTIME),
      new Date(MTIME),
    )

    const report = await new ImportEngine(db, device()).run({ libraryRoot: s.libraryRoot })

    expect(report.imported).toBe(2)
    const files = libraryFiles(s.libraryRoot)
    expect(files).toHaveLength(2)
    const hashes = files.map((f) => sha(fs.readFileSync(path.join(s.libraryRoot, f))))
    expect(new Set(hashes).size).toBe(2)
  })

  it('finishes the run when identical bytes in two folders want the same name', async () => {
    // file.path is UNIQUE. This used to insert the same path twice and stop the run.
    const bytes = makeHeic({ mdatBytes: 1500 })
    putOnDevice(s, 'IMG_0200.HEIC', bytes, MTIME)
    fs.mkdirSync(path.join(s.deviceRoot, 'DCIM', '101APPLE'), { recursive: true })
    const second = path.join(s.deviceRoot, 'DCIM', '101APPLE', 'IMG_0200.HEIC')
    fs.writeFileSync(second, bytes)
    fs.utimesSync(second, new Date(MTIME), new Date(MTIME))
    putOnDevice(s, 'IMG_0201.HEIC', makeHeic(), MTIME + 1000)

    const report = await new ImportEngine(db, device()).run({ libraryRoot: s.libraryRoot })

    expect(report.imported).toBe(3)
    expect(report.quarantined).toBe(0)
    // One copy of the shared bytes on disk, and both device files point at it.
    expect(libraryFiles(s.libraryRoot)).toHaveLength(2)
    const ids = db
      .prepare(`SELECT file_id FROM import_item WHERE device_path LIKE '%IMG_0200.HEIC'`)
      .all() as { file_id: number }[]
    expect(ids).toHaveLength(2)
    expect(ids[0]!.file_id).toBe(ids[1]!.file_id)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM file`).get()).toEqual({ n: 2 })
  })

  it('adopts a file left on disk by a crash between rename and record', async () => {
    const bytes = makeHeic({ mdatBytes: 1500 })
    putOnDevice(s, 'IMG_0300.HEIC', bytes, MTIME)
    const engine = new ImportEngine(db, device())
    await engine.run({ libraryRoot: s.libraryRoot })
    const [onDisk] = libraryFiles(s.libraryRoot)

    // Simulate the crash: the file reached its final path, the database never heard.
    db.prepare(`DELETE FROM import_item`).run()
    db.prepare(`DELETE FROM file`).run()

    const report = await engine.run({ libraryRoot: s.libraryRoot })

    expect(report.imported).toBe(1)
    // The same path, not IMG_0300_1 beside an orphan.
    expect(libraryFiles(s.libraryRoot)).toEqual([onDisk])
    expect(db.prepare(`SELECT path FROM file`).all()).toEqual([{ path: onDisk }])
  })

  it('puts the bytes back when the record exists but the file was deleted', async () => {
    const bytes = makeHeic({ mdatBytes: 1500 })
    putOnDevice(s, 'IMG_0500.HEIC', bytes, MTIME)
    const engine = new ImportEngine(db, device())
    await engine.run({ libraryRoot: s.libraryRoot })
    const [onDisk] = libraryFiles(s.libraryRoot)
    const fileId = (db.prepare(`SELECT id FROM file`).get() as { id: number }).id

    fs.rmSync(path.join(s.libraryRoot, onDisk!))
    db.prepare(`DELETE FROM import_item`).run()

    const report = await engine.run({ libraryRoot: s.libraryRoot })

    expect(report.imported).toBe(1)
    expect(libraryFiles(s.libraryRoot)).toEqual([onDisk])
    expect(sha(fs.readFileSync(path.join(s.libraryRoot, onDisk!)))).toBe(sha(bytes))
    expect(db.prepare(`SELECT id FROM file`).all()).toEqual([{ id: fileId }])
  })

  it('does not adopt a different file that happens to sit at the destination', async () => {
    const bytes = makeHeic({ mdatBytes: 1500 })
    putOnDevice(s, 'IMG_0400.HEIC', bytes, MTIME)
    const engine = new ImportEngine(db, device())
    await engine.run({ libraryRoot: s.libraryRoot })
    const [onDisk] = libraryFiles(s.libraryRoot)
    db.prepare(`DELETE FROM import_item`).run()
    db.prepare(`DELETE FROM file`).run()
    // Something else now lives at that path.
    fs.writeFileSync(path.join(s.libraryRoot, onDisk!), makeHeic({ mdatBytes: 900 }))

    await engine.run({ libraryRoot: s.libraryRoot })

    const files = libraryFiles(s.libraryRoot).sort()
    expect(files).toHaveLength(2)
    expect(files[1]).toMatch(/IMG_0400_1\.HEIC$/)
  })
})
