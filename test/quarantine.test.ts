import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDevice, type Fault } from '../src/device/fake-device.ts'
import { openLibrary, type Db } from '../src/library/db.ts'
import { ImportEngine } from '../src/import/engine.ts'
import { acceptQuarantined, listQuarantine, requeueQuarantined } from '../src/import/quarantine.ts'
import { StubMetadataReader } from '../src/metadata/reader.ts'
import { libraryFiles, makeHeic, makeVideo, putOnDevice, scratch, type Scratch } from './helpers.ts'
import { REAL_HEIC } from './fixtures/real-tags.ts'

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

/** Import one file that fails L0 because the device lies about its size. */
async function importWithBadFile(name = 'IMG_0001.HEIC') {
  const bytes = makeHeic()
  const devPath = putOnDevice(s, name, bytes, MTIME)
  const faults: Record<string, Fault> = {
    [devPath]: { kind: 'size-mismatch', reportSize: bytes.length + 4096 },
  }
  const device = new FakeDevice({ root: s.deviceRoot, faults })
  const engine = new ImportEngine(db, device)
  await engine.run({ libraryRoot: s.libraryRoot, retryBaseMs: 0 })
  return { device, engine, devPath, bytes }
}

describe('listing', () => {
  it('describes each failure well enough to act on', async () => {
    const { bytes } = await importWithBadFile()

    const [entry] = listQuarantine(db, s.libraryRoot)
    expect(entry).toBeDefined()
    expect(entry!.fileName).toBe('IMG_0001.HEIC')
    expect(entry!.failLevel).toBe(0)
    expect(entry!.failDetail).toMatch(/expected \d+ bytes, received \d+/)
    expect(entry!.expectedBytes).toBe(bytes.length + 4096)
    expect(entry!.receivedBytes).toBe(bytes.length)
    expect(entry!.quarantinePath).not.toBeNull()
    expect(fs.existsSync(entry!.quarantinePath!)).toBe(true)
  })

  it('is empty when nothing failed', async () => {
    putOnDevice(s, 'IMG_0002.HEIC', makeHeic(), MTIME)
    await new ImportEngine(db, new FakeDevice({ root: s.deviceRoot })).run({
      libraryRoot: s.libraryRoot,
    })
    expect(listQuarantine(db, s.libraryRoot)).toEqual([])
  })
})

describe('retry', () => {
  it('recovers the whole batch once the cause is fixed', async () => {
    // Three files, all failing the same way, as a bad cable would produce.
    const device = new FakeDevice({ root: s.deviceRoot, faults: {} })
    const paths: string[] = []
    for (let i = 0; i < 3; i++) {
      const bytes = makeHeic({ mdatBytes: 1024 + i })
      const p = putOnDevice(s, `IMG_010${i}.HEIC`, bytes, MTIME)
      paths.push(p)
      ;(device as any).opts.faults[p] = { kind: 'size-mismatch', reportSize: bytes.length + 512 }
    }

    const engine = new ImportEngine(db, device)
    const first = await engine.run({ libraryRoot: s.libraryRoot, retryBaseMs: 0 })
    expect(first.quarantined).toBe(3)
    expect(libraryFiles(s.libraryRoot)).toEqual([])

    // Cable replaced.
    for (const p of paths) device.clearFault(p)
    const requeued = requeueQuarantined(db, s.libraryRoot)
    expect(requeued).toBe(3)

    const second = await engine.run({ libraryRoot: s.libraryRoot, retryBaseMs: 0 })
    expect(second.imported).toBe(3)
    expect(listQuarantine(db, s.libraryRoot)).toEqual([])
    expect(libraryFiles(s.libraryRoot)).toHaveLength(3)
  })

  it('clears the quarantined bytes and the report when requeueing', async () => {
    await importWithBadFile()
    const [entry] = listQuarantine(db, s.libraryRoot)
    const reportPath = `${entry!.quarantinePath}.json`
    expect(fs.existsSync(reportPath)).toBe(true)

    requeueQuarantined(db, s.libraryRoot)

    expect(fs.existsSync(entry!.quarantinePath!)).toBe(false)
    expect(fs.existsSync(reportPath)).toBe(false)
    // Restarted from zero, not resumed onto bytes that already failed.
    const row = db.prepare('SELECT stage, bytes_received, attempts FROM import_item').get()
    expect(row).toMatchObject({ stage: 'planned', bytes_received: 0, attempts: 0 })
  })

  it('can requeue a chosen subset', async () => {
    await importWithBadFile('IMG_0200.HEIC')
    await importWithBadFile('IMG_0201.HEIC')
    const entries = listQuarantine(db, s.libraryRoot)
    expect(entries).toHaveLength(2)

    expect(requeueQuarantined(db, s.libraryRoot, [entries[0]!.itemId])).toBe(1)
    expect(listQuarantine(db, s.libraryRoot)).toHaveLength(1)
  })

  it('does nothing when there is nothing to retry', () => {
    expect(requeueQuarantined(db, s.libraryRoot)).toBe(0)
  })
})

describe('accept anyway', () => {
  it('takes the file into the library, marked as unverified', async () => {
    await importWithBadFile('IMG_0300.HEIC')
    const [entry] = listQuarantine(db, s.libraryRoot)

    const fileId = await acceptQuarantined(db, {
      libraryRoot: s.libraryRoot,
      itemId: entry!.itemId,
      metadata: new StubMetadataReader({ 'IMG_0300.HEIC': REAL_HEIC }),
    })
    expect(fileId).not.toBeNull()

    // Filed by its real capture time, like anything else.
    expect(libraryFiles(s.libraryRoot)).toEqual(['2026/2026-06/20260608_182619_IMG_0300.HEIC'])

    const row = db
      .prepare('SELECT accepted_unverified, verify_level, bytes FROM file WHERE id = ?')
      .get(fileId) as { accepted_unverified: number; verify_level: number; bytes: number }
    // The flag is the point: it must never look like a file that passed.
    expect(row.accepted_unverified).toBe(1)
    expect(row.bytes).toBeGreaterThan(0)

    expect(listQuarantine(db, s.libraryRoot)).toEqual([])
    expect(fs.existsSync(entry!.quarantinePath!)).toBe(false)
  })

  it('records the item as committed so a rerun does not fetch it again', async () => {
    await importWithBadFile('IMG_0400.HEIC')
    const [entry] = listQuarantine(db, s.libraryRoot)
    await acceptQuarantined(db, { libraryRoot: s.libraryRoot, itemId: entry!.itemId })

    const row = db.prepare('SELECT stage, file_id FROM import_item').get() as {
      stage: string
      file_id: number | null
    }
    expect(row.stage).toBe('committed')
    expect(row.file_id).not.toBeNull()
  })

  it('works without a metadata reader, falling back to the device timestamp', async () => {
    await importWithBadFile('IMG_0500.HEIC')
    const [entry] = listQuarantine(db, s.libraryRoot)
    const fileId = await acceptQuarantined(db, {
      libraryRoot: s.libraryRoot,
      itemId: entry!.itemId,
    })
    expect(fileId).not.toBeNull()
    expect(libraryFiles(s.libraryRoot)[0]).toMatch(/^2026\/2026-06\/20260608_\d{6}_IMG_0500\.HEIC$/)
  })

  it('returns null for an item that is not quarantined', async () => {
    putOnDevice(s, 'IMG_0600.HEIC', makeHeic(), MTIME)
    await new ImportEngine(db, new FakeDevice({ root: s.deviceRoot })).run({
      libraryRoot: s.libraryRoot,
    })
    expect(await acceptQuarantined(db, { libraryRoot: s.libraryRoot, itemId: 1 })).toBeNull()
  })

  it('keeps a structurally broken video that the user wants anyway', async () => {
    // Right byte count, missing moov. L0 passes, L2 rejects it.
    putOnDevice(s, 'IMG_0700.MOV', makeVideo({ moov: false }), MTIME)
    await new ImportEngine(db, new FakeDevice({ root: s.deviceRoot })).run({
      libraryRoot: s.libraryRoot,
    })

    const [entry] = listQuarantine(db, s.libraryRoot)
    expect(entry!.failLevel).toBe(2)

    const fileId = await acceptQuarantined(db, {
      libraryRoot: s.libraryRoot,
      itemId: entry!.itemId,
    })
    const row = db
      .prepare('SELECT accepted_unverified, verify_level FROM file WHERE id = ?')
      .get(fileId) as { accepted_unverified: number; verify_level: number }
    expect(row.accepted_unverified).toBe(1)
    // It passed L0 and L1 before failing L2, and the record says so.
    expect(row.verify_level).toBe(1)
  })
})
