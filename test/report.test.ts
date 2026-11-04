import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDevice, type Fault } from '../src/device/fake-device.ts'
import { DeviceDetachedError } from '../src/device/types.ts'
import { openLibrary, type Db } from '../src/library/db.ts'
import { ImportEngine } from '../src/import/engine.ts'
import { buildRunReport, renderRunReport } from '../src/import/report.ts'
import { makeHeic, putOnDevice, scratch, type Scratch } from './helpers.ts'

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

function reportFiles(): string[] {
  const dir = path.join(s.libraryRoot, '.reports')
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}

describe('run reports', () => {
  it('writes a JSON and a text report for every finished run', async () => {
    putOnDevice(s, 'IMG_0001.HEIC', makeHeic(), MTIME)
    putOnDevice(s, 'IMG_0002.HEIC', makeHeic(), MTIME)

    const result = await new ImportEngine(db, device()).run({ libraryRoot: s.libraryRoot })

    const files = reportFiles()
    expect(files).toHaveLength(2)
    expect(files[0]).toMatch(/^run-0001-\d{8}T\d{6}\.json$/)
    expect(files[1]).toMatch(/^run-0001-\d{8}T\d{6}\.txt$/)
    expect(result.reportPath).toBe(path.join(s.libraryRoot, '.reports', files[1]!))
    expect(db.prepare(`SELECT report_path FROM import_run WHERE id = 1`).get()).toEqual({
      report_path: result.reportPath,
    })

    const json = JSON.parse(fs.readFileSync(path.join(s.libraryRoot, '.reports', files[0]!), 'utf8'))
    expect(json).toMatchObject({ runId: 1, status: 'done', imported: 2, skipped: 0, quarantined: 0, pending: 0 })
    expect(json.bytesImported).toBe(result.bytes)
    expect(json.device.name).toBe('Fake iPhone')
  })

  it('names every file that did not make it, and why', async () => {
    const bytes = makeHeic()
    const bad = putOnDevice(s, 'IMG_0003.HEIC', bytes, MTIME)
    const missing = putOnDevice(s, 'IMG_0004.HEIC', makeHeic(), MTIME)

    const result = await new ImportEngine(db, device({
      [bad]: { kind: 'size-mismatch', reportSize: bytes.length + 10 },
      [missing]: { kind: 'open-fails', message: 'AFC FILE_OPEN failed: object not found' },
    })).run({ libraryRoot: s.libraryRoot, retryBaseMs: 0 })

    const text = fs.readFileSync(result.reportPath!, 'utf8')
    expect(text).toContain('Quarantined  2')
    expect(text).toContain('/DCIM/100APPLE/IMG_0003.HEIC')
    expect(text).toMatch(/failed size check: expected \d+ bytes, received \d+/)
    expect(text).toContain('/DCIM/100APPLE/IMG_0004.HEIC')
    expect(text).toMatch(/read failed, not retried: .*object not found \(permanent\)/)
    expect(text).toMatch(/Started  \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}/)
  })

  it('counts which kinds of failure retries recovered', async () => {
    const flaky = putOnDevice(s, 'IMG_0005.HEIC', makeHeic(), MTIME)
    const dead = putOnDevice(s, 'IMG_0006.HEIC', makeHeic(), MTIME)

    const result = await new ImportEngine(db, device({
      [flaky]: { kind: 'open-fails-times', times: 2, message: 'AFC FILE_OPEN failed: operation timeout' },
      [dead]: { kind: 'open-fails', message: 'AFC FILE_OPEN failed: io error' },
    })).run({ libraryRoot: s.libraryRoot, retryBaseMs: 0, maxAttempts: 3 })

    expect(result.imported).toBe(1)
    const r = buildRunReport(db, result.runId)
    // Two failures on the flaky file, then success. Three on the dead one.
    expect(r.attempts.transient).toEqual({ failures: 5, files: 2, recovered: 1 })
    expect(r.attempts.permanent).toEqual({ failures: 0, files: 0, recovered: 0 })
    expect(renderRunReport(r)).toContain('transient  5 failures across 2 files, 1 recovered')
  })

  it('reports a stopped run, then the same run finished, without double counting', async () => {
    for (let i = 0; i < 3; i++) putOnDevice(s, `IMG_001${i}.HEIC`, makeHeic({ mdatBytes: 4096 }), MTIME + i)
    const dev = device({ '/DCIM/100APPLE/IMG_0011.HEIC': { kind: 'detach-at', at: 1000 } })
    const engine = new ImportEngine(db, dev)

    await expect(engine.run({ libraryRoot: s.libraryRoot })).rejects.toBeInstanceOf(DeviceDetachedError)

    const stopped = buildRunReport(db, 1)
    expect(stopped.status).toBe('stopped')
    expect(stopped.stopReason).toMatch(/^device disconnected/)
    expect(stopped.imported).toBe(1)
    expect(stopped.pending).toBe(2)
    const text = fs.readFileSync(reportFiles().map((f) => path.join(s.libraryRoot, '.reports', f)).find((f) => f.endsWith('.txt'))!, 'utf8')
    expect(text).toContain('Stopped: device disconnected')
    expect(text).toContain('2 files are still waiting')

    dev.clearFault('/DCIM/100APPLE/IMG_0011.HEIC')
    dev.reattach()
    const resumed = await engine.run({ libraryRoot: s.libraryRoot })

    expect(resumed.runId).toBe(1)
    const done = buildRunReport(db, 1)
    expect(done).toMatchObject({ status: 'done', stopReason: null, imported: 3, skipped: 0, pending: 0 })
    // Same run, same files, rewritten in place.
    expect(reportFiles()).toHaveLength(2)
  })

  it('counts a second import of the same phone as skips', async () => {
    putOnDevice(s, 'IMG_0020.HEIC', makeHeic(), MTIME)
    putOnDevice(s, 'IMG_0021.HEIC', makeHeic(), MTIME)
    const engine = new ImportEngine(db, device())
    await engine.run({ libraryRoot: s.libraryRoot })
    const second = await engine.run({ libraryRoot: s.libraryRoot })

    expect(buildRunReport(db, second.runId)).toMatchObject({ imported: 0, skipped: 2 })
    expect(reportFiles()).toHaveLength(4)
  })

  it('retires a file deleted from the phone between a stop and a resume', async () => {
    for (let i = 0; i < 3; i++) putOnDevice(s, `IMG_004${i}.HEIC`, makeHeic({ mdatBytes: 4096 }), MTIME + i)
    const dev = device({ '/DCIM/100APPLE/IMG_0041.HEIC': { kind: 'detach-at', at: 1000 } })
    const engine = new ImportEngine(db, dev)
    await expect(engine.run({ libraryRoot: s.libraryRoot })).rejects.toBeInstanceOf(DeviceDetachedError)

    // Deleted on the phone while it was unplugged.
    fs.rmSync(path.join(s.deviceRoot, 'DCIM', '100APPLE', 'IMG_0042.HEIC'))
    dev.clearFault('/DCIM/100APPLE/IMG_0041.HEIC')
    dev.reattach()
    const resumed = await engine.run({ libraryRoot: s.libraryRoot })

    expect(resumed.quarantined).toBe(0)
    expect(dev.opened).not.toContain('/DCIM/100APPLE/IMG_0042.HEIC')
    const r = buildRunReport(db, resumed.runId)
    expect(r).toMatchObject({ imported: 2, gone: 1, quarantined: 0, pending: 0 })
    expect(renderRunReport(r)).toContain('Gone         1 deleted from the phone')
    expect(db.prepare(`SELECT fail_detail FROM import_item WHERE stage = 'gone'`).get()).toEqual({
      fail_detail: 'deleted from the device before it was imported',
    })
  })

  it('clears an old read failure once the file is gone from the phone', async () => {
    const lost = putOnDevice(s, 'IMG_0050.HEIC', makeHeic(), MTIME)
    const dev = device({ [lost]: { kind: 'open-fails', message: 'AFC FILE_OPEN failed: io error' } })
    const engine = new ImportEngine(db, dev)
    await engine.run({ libraryRoot: s.libraryRoot, retryBaseMs: 0 })
    const q = path.join(s.libraryRoot, '.quarantine')
    expect(fs.readdirSync(q)).toEqual(['DCIM_100APPLE_IMG_0050.HEIC.json'])

    fs.rmSync(path.join(s.deviceRoot, 'DCIM', '100APPLE', 'IMG_0050.HEIC'))
    await engine.run({ libraryRoot: s.libraryRoot })

    expect(db.prepare(`SELECT stage FROM import_item`).get()).toEqual({ stage: 'gone' })
    expect(fs.readdirSync(q)).toEqual([])
  })

  it('keeps a quarantined file whose bytes are still there, even once the phone lost it', async () => {
    const bytes = makeHeic()
    const bad = putOnDevice(s, 'IMG_0060.HEIC', bytes, MTIME)
    const engine = new ImportEngine(db, device({ [bad]: { kind: 'size-mismatch', reportSize: bytes.length + 10 } }))
    await engine.run({ libraryRoot: s.libraryRoot, retryBaseMs: 0 })

    fs.rmSync(path.join(s.deviceRoot, 'DCIM', '100APPLE', 'IMG_0060.HEIC'))
    await engine.run({ libraryRoot: s.libraryRoot })

    // Those bytes may be the only copy left, so "accept anyway" must stay possible.
    expect(db.prepare(`SELECT stage FROM import_item`).get()).toEqual({ stage: 'quarantined' })
  })

  it('does not retire a file that a filtered listing merely hid', async () => {
    putOnDevice(s, 'IMG_0070.HEIC', makeHeic({ mdatBytes: 4096 }), MTIME)
    putOnDevice(s, 'IMG_0071.HEIC', makeHeic({ mdatBytes: 4096 }), MTIME + 1)
    const dev = device({ '/DCIM/100APPLE/IMG_0071.HEIC': { kind: 'detach-at', at: 1000 } })
    const engine = new ImportEngine(db, dev)
    await expect(engine.run({ libraryRoot: s.libraryRoot })).rejects.toBeInstanceOf(DeviceDetachedError)
    dev.clearFault('/DCIM/100APPLE/IMG_0071.HEIC')
    dev.reattach()

    // The smoke import does this: list only some files, while stat still sees all.
    const hiding = Object.create(dev) as FakeDevice
    hiding.list = async (dir: string) => (await dev.list(dir)).filter((n) => n !== 'IMG_0071.HEIC')
    await new ImportEngine(db, hiding).run({ libraryRoot: s.libraryRoot })

    expect(db.prepare(`SELECT stage FROM import_item WHERE device_path LIKE '%0071%'`).get()).toEqual({
      stage: 'committed',
    })
  })

  it('times a resumed run by the time it was working, not the gap between sittings', async () => {
    for (let i = 0; i < 2; i++) putOnDevice(s, `IMG_008${i}.HEIC`, makeHeic({ mdatBytes: 4096 }), MTIME + i)
    const dev = device({ '/DCIM/100APPLE/IMG_0081.HEIC': { kind: 'detach-at', at: 1000 } })
    const engine = new ImportEngine(db, dev)
    let clock = Date.UTC(2026, 8, 13)
    const now = () => (clock += 1000)

    await expect(engine.run({ libraryRoot: s.libraryRoot, now })).rejects.toBeInstanceOf(DeviceDetachedError)
    clock += 52 * 24 * 3600 * 1000 // seven weeks unplugged
    dev.clearFault('/DCIM/100APPLE/IMG_0081.HEIC')
    dev.reattach()
    const resumed = await engine.run({ libraryRoot: s.libraryRoot, now })

    const r = buildRunReport(db, resumed.runId)
    expect(r.sessions).toBe(2)
    expect(r.durationMs).toBeLessThan(60_000)
    expect(renderRunReport(r)).toMatch(/Active   \d+s, over 2 sessions/)
  })

  it('still finishes the import when the report cannot be written', async () => {
    putOnDevice(s, 'IMG_0030.HEIC', makeHeic(), MTIME)
    fs.mkdirSync(s.libraryRoot, { recursive: true })
    // A file where the reports folder should be makes mkdir fail.
    fs.writeFileSync(path.join(s.libraryRoot, '.reports'), '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await new ImportEngine(db, device()).run({ libraryRoot: s.libraryRoot })

    expect(result.imported).toBe(1)
    expect(result.reportPath).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not write the report for run 1/))
    warn.mockRestore()
  })
})
