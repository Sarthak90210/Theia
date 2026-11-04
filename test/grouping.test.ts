import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDevice } from '../src/device/fake-device.ts'
import { openLibrary, type Db } from '../src/library/db.ts'
import { ImportEngine } from '../src/import/engine.ts'
import { buildAssets } from '../src/import/grouping.ts'
import { StubMetadataReader } from '../src/metadata/reader.ts'
import type { RawTags } from '../src/metadata/tags.ts'
import { libraryFiles, makeHeic, makePng, makeVideo, putOnDevice, scratch, type Scratch } from './helpers.ts'
import { REAL_HEIC, REAL_MOV } from './fixtures/real-tags.ts'

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

/** Fixed host zone so these assertions do not depend on the machine. */
const IST = { hostOffsetAt: () => 19800 }

function reader(byName: Record<string, RawTags>) {
  return new StubMetadataReader(byName, IST)
}

async function importAll(byName: Record<string, RawTags>) {
  const engine = new ImportEngine(db, new FakeDevice({ root: s.deviceRoot }))
  return engine.run({ libraryRoot: s.libraryRoot, metadata: reader(byName) })
}

function group() {
  return buildAssets(db, { libraryRoot: s.libraryRoot, resolve: IST })
}

describe('capture time drives the layout', () => {
  it('files a photo under the time it was taken, not the importer timezone', async () => {
    putOnDevice(s, 'IMG_0001.HEIC', makeHeic(), MTIME)
    await importAll({ 'IMG_0001.HEIC': REAL_HEIC })

    // Taken at 18:26:19 in Tokyo. It belongs under 1826 wherever it is imported.
    expect(libraryFiles(s.libraryRoot)).toEqual(['2026/2026-06/20260608_182619_IMG_0001.HEIC'])
  })

  it('falls back to the filesystem when no reader is supplied, and records that', async () => {
    putOnDevice(s, 'IMG_0002.HEIC', makeHeic(), MTIME)
    const engine = new ImportEngine(db, new FakeDevice({ root: s.deviceRoot }))
    await engine.run({ libraryRoot: s.libraryRoot })
    buildAssets(db, { libraryRoot: s.libraryRoot })

    const asset = db.prepare('SELECT time_source, offset_inferred FROM asset').get() as {
      time_source: string
      offset_inferred: number
    }
    expect(asset.time_source).toBe('filesystem')
    expect(asset.offset_inferred).toBe(1)
  })

  it('stores the instant and the original offset separately', async () => {
    putOnDevice(s, 'IMG_0003.HEIC', makeHeic(), MTIME)
    await importAll({ 'IMG_0003.HEIC': REAL_HEIC })
    buildAssets(db, { libraryRoot: s.libraryRoot })

    const asset = db
      .prepare('SELECT captured_utc, captured_offset, offset_inferred, time_source FROM asset')
      .get() as {
      captured_utc: number
      captured_offset: number
      offset_inferred: number
      time_source: string
    }
    expect(asset.captured_utc).toBe(Date.UTC(2026, 5, 8, 9, 26, 19, 698))
    expect(asset.captured_offset).toBe(32400)
    expect(asset.offset_inferred).toBe(0)
    expect(asset.time_source).toBe('exif')
  })
})

describe('offsets that the file never recorded', () => {
  // A screenshot: DateTimeOriginal with no offset tag and no GPS anywhere.
  const SCREENSHOT: RawTags = {
    'File:ImageWidth': 1320,
    'File:ImageHeight': 2868,
    'ExifIFD:DateTimeOriginal': '2026:09:09 21:31:03',
  }

  it('assumes the host zone and stores a real instant, not a mislabelled wall clock', async () => {
    putOnDevice(s, 'IMG_0200.PNG', makePng(), MTIME)
    await importAll({ 'IMG_0200.PNG': SCREENSHOT })
    const result = group()

    expect(result.offsetSources).toEqual({ host: 1 })

    const asset = db
      .prepare('SELECT captured_utc, captured_offset, offset_inferred, offset_source FROM asset')
      .get() as {
      captured_utc: number
      captured_offset: number
      offset_inferred: number
      offset_source: string
    }
    expect(asset.offset_source).toBe('host')
    expect(asset.offset_inferred).toBe(1)
    expect(asset.captured_offset).toBe(19800)
    expect(asset.captured_utc).toBe(Date.UTC(2026, 8, 9, 21, 31, 3) - 19800 * 1000)
    // Instant plus offset still shows the user the reading they remember.
    expect(asset.captured_utc + asset.captured_offset * 1000).toBe(
      Date.UTC(2026, 8, 9, 21, 31, 3),
    )
  })

  it('still files the screenshot under the time on its face', async () => {
    putOnDevice(s, 'IMG_0201.PNG', makePng(), MTIME)
    await importAll({ 'IMG_0201.PNG': SCREENSHOT })
    expect(libraryFiles(s.libraryRoot)).toEqual(['2026/2026-09/20260909_213103_IMG_0201.PNG'])
  })

  it('prefers a GPS-derived offset over the host assumption', async () => {
    const travelling: RawTags = {
      'ExifIFD:DateTimeOriginal': '2026:06:08 18:26:19',
      'Composite:GPSDateTime': '2026:06:08 09:26:19Z',
      'Composite:GPSLatitude': 35.6565,
      'Composite:GPSLongitude': 139.7025,
    }
    putOnDevice(s, 'IMG_0202.HEIC', makeHeic(), MTIME)
    await importAll({ 'IMG_0202.HEIC': travelling })
    const result = group()

    expect(result.offsetSources).toEqual({ gps: 1 })
    const asset = db.prepare('SELECT captured_offset, offset_source FROM asset').get() as {
      captured_offset: number
      offset_source: string
    }
    // Tokyo recovered from the file itself, on a machine sitting in IST.
    expect(asset.captured_offset).toBe(32400)
    expect(asset.offset_source).toBe('gps')
  })

  it('marks a recorded offset as recorded', async () => {
    putOnDevice(s, 'IMG_0203.HEIC', makeHeic(), MTIME)
    await importAll({ 'IMG_0203.HEIC': REAL_HEIC })
    expect(group().offsetSources).toEqual({ recorded: 1 })
  })

  it('sorts a screenshot correctly against a foreign photo taken minutes apart', async () => {
    // The bug this change fixes: a wall clock labelled UTC sorts against a real
    // instant as though the two were comparable, and they are not.
    putOnDevice(s, 'IMG_0210.HEIC', makeHeic(), MTIME)
    putOnDevice(s, 'IMG_0211.PNG', makePng(), MTIME)
    await importAll({
      // 18:26:19 +09:00 is 09:26:19 UTC.
      'IMG_0210.HEIC': REAL_HEIC,
      // 15:00:00 +05:30 is 09:30:00 UTC, so this is the later of the two.
      'IMG_0211.PNG': { 'ExifIFD:DateTimeOriginal': '2026:06:08 15:00:00' },
    })
    group()

    const order = db
      .prepare('SELECT captured_utc FROM asset ORDER BY captured_utc ASC')
      .all() as { captured_utc: number }[]
    expect(order[0]!.captured_utc).toBe(Date.UTC(2026, 5, 8, 9, 26, 19, 698))
    expect(order[1]!.captured_utc).toBe(Date.UTC(2026, 5, 8, 9, 30, 0))
  })
})

describe('live photos', () => {
  it('pairs a still and a video on content id, as one asset', async () => {
    putOnDevice(s, 'IMG_0010.HEIC', makeHeic(), MTIME)
    putOnDevice(s, 'IMG_0010.MOV', makeVideo(), MTIME)

    const report = await importAll({ 'IMG_0010.HEIC': REAL_HEIC, 'IMG_0010.MOV': REAL_MOV })
    expect(report.imported).toBe(2)

    const result = buildAssets(db, { libraryRoot: s.libraryRoot })
    expect(result.assetsCreated).toBe(1)
    expect(result.livePhotos).toBe(1)
    expect(result.unpaired).toBe(0)

    const asset = db.prepare('SELECT kind, content_id, duration_ms FROM asset').get() as {
      kind: string
      content_id: string
      duration_ms: number
    }
    expect(asset.kind).toBe('live')
    expect(asset.content_id).toBe('4B23D938-CC54-4D95-B0F6-55FE602F2CDA')
    expect(asset.duration_ms).toBe(100)

    const files = db
      .prepare('SELECT mime, role, is_primary FROM file ORDER BY mime')
      .all() as { mime: string; role: string; is_primary: number }[]
    expect(files).toEqual([
      { mime: 'image/heic', role: 'master', is_primary: 1 },
      { mime: 'video/quicktime', role: 'motion', is_primary: 0 },
    ])
  })

  it('pairs on content id even when the filenames disagree', async () => {
    // Stems match in the common case and stop matching exactly where it counts,
    // which is why the identifier is the rule and the stem is not.
    putOnDevice(s, 'IMG_0020.HEIC', makeHeic(), MTIME)
    putOnDevice(s, 'IMG_9999.MOV', makeVideo(), MTIME)

    await importAll({ 'IMG_0020.HEIC': REAL_HEIC, 'IMG_9999.MOV': REAL_MOV })
    const result = buildAssets(db, { libraryRoot: s.libraryRoot })

    expect(result.assetsCreated).toBe(1)
    expect(result.livePhotos).toBe(1)
  })

  it('does not pair two files that merely share a stem', async () => {
    putOnDevice(s, 'IMG_0030.HEIC', makeHeic(), MTIME)
    putOnDevice(s, 'IMG_0030.MOV', makeVideo(), MTIME)

    // Same names, different content ids: two separate captures.
    await importAll({
      'IMG_0030.HEIC': REAL_HEIC,
      'IMG_0030.MOV': { ...REAL_MOV, 'Keys:ContentIdentifier': 'DIFFERENT-UUID' },
    })
    const result = buildAssets(db, { libraryRoot: s.libraryRoot })

    expect(result.assetsCreated).toBe(2)
    expect(result.livePhotos).toBe(0)
    expect(result.unpaired).toBe(2)
  })

  it('counts a half whose partner never arrived', async () => {
    putOnDevice(s, 'IMG_0040.MOV', makeVideo(), MTIME)
    await importAll({ 'IMG_0040.MOV': REAL_MOV })

    const result = buildAssets(db, { libraryRoot: s.libraryRoot })
    expect(result.videos).toBe(1)
    expect(result.unpaired).toBe(1)
  })

  it('treats a file with no content id as a plain still', async () => {
    const { 'Apple:ContentIdentifier': _drop, ...noId } = REAL_HEIC
    putOnDevice(s, 'IMG_0050.HEIC', makeHeic(), MTIME)
    await importAll({ 'IMG_0050.HEIC': noId })

    const result = buildAssets(db, { libraryRoot: s.libraryRoot })
    expect(result.stills).toBe(1)
    expect(result.unpaired).toBe(0)
  })
})

describe('adjustment sidecars', () => {
  const AAE = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>adjustmentEditorBundleID</key><string>com.apple.camera</string>
  <key>adjustmentFormatIdentifier</key><string>com.apple.photo</string>
  <key>adjustmentFormatVersion</key><string>1.4</string>
</dict></plist>`,
    'utf8',
  )

  it('moves the recipe into the database and leaves the library as media only', async () => {
    putOnDevice(s, 'IMG_0060.HEIC', makeHeic(), MTIME)
    putOnDevice(s, 'IMG_0060.AAE', AAE, MTIME)

    const report = await importAll({ 'IMG_0060.HEIC': REAL_HEIC })
    expect(report.imported).toBe(2)

    const result = buildAssets(db, { libraryRoot: s.libraryRoot })
    expect(result.sidecarsAbsorbed).toBe(1)

    // User story 38: the library is media files and nothing else.
    expect(libraryFiles(s.libraryRoot)).toEqual(['2026/2026-06/20260608_182619_IMG_0060.HEIC'])

    const row = db.prepare('SELECT asset_id, editor, plist FROM aae').get() as {
      asset_id: number
      editor: string
      plist: Uint8Array
    }
    expect(row.editor).toBe('com.apple.camera')
    expect(Buffer.from(row.plist).toString('utf8')).toContain('adjustmentFormatVersion')

    const asset = db.prepare('SELECT id, has_adjustments FROM asset').get() as {
      id: number
      has_adjustments: number
    }
    // The copy on disk is the unadjusted capture, so the UI has to be able to say so.
    expect(asset.has_adjustments).toBe(1)
    expect(row.asset_id).toBe(asset.id)

    expect(db.prepare("SELECT COUNT(*) AS n FROM file WHERE mime = 'application/xml'").get()).toEqual(
      { n: 0 },
    )
  })

  it('keeps the sidecar file when absorbing is turned off', async () => {
    putOnDevice(s, 'IMG_0070.HEIC', makeHeic(), MTIME)
    putOnDevice(s, 'IMG_0070.AAE', AAE, MTIME)
    await importAll({ 'IMG_0070.HEIC': REAL_HEIC })

    const result = buildAssets(db, { libraryRoot: s.libraryRoot, absorbSidecars: false })
    expect(result.sidecarsAbsorbed).toBe(0)
    expect(libraryFiles(s.libraryRoot)).toHaveLength(2)
  })

  it('does not lose the bytes when the recipe will not parse', async () => {
    putOnDevice(s, 'IMG_0080.HEIC', makeHeic(), MTIME)
    putOnDevice(s, 'IMG_0080.AAE', Buffer.from('<?xml version="1.0"?><not-a-plist/>'), MTIME)
    await importAll({ 'IMG_0080.HEIC': REAL_HEIC })

    buildAssets(db, { libraryRoot: s.libraryRoot })
    const row = db.prepare('SELECT editor, LENGTH(plist) AS n FROM aae').get() as {
      editor: string | null
      n: number
    }
    expect(row.n).toBeGreaterThan(0)
    expect(row.editor).toBeNull()
  })
})

describe('idempotence', () => {
  it('does not create a second asset when grouping runs again', async () => {
    putOnDevice(s, 'IMG_0090.HEIC', makeHeic(), MTIME)
    putOnDevice(s, 'IMG_0090.MOV', makeVideo(), MTIME)
    await importAll({ 'IMG_0090.HEIC': REAL_HEIC, 'IMG_0090.MOV': REAL_MOV })

    buildAssets(db, { libraryRoot: s.libraryRoot })
    const second = buildAssets(db, { libraryRoot: s.libraryRoot })

    expect(second.assetsCreated).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM asset').get()).toEqual({ n: 1 })
  })
})

describe('exif records', () => {
  it('keeps the raw tags so a bad normalisation can be fixed without re-reading the library', async () => {
    putOnDevice(s, 'IMG_0100.HEIC', makeHeic(), MTIME)
    await importAll({ 'IMG_0100.HEIC': REAL_HEIC })

    const row = db.prepare('SELECT make, model, lens, iso, f_number, raw FROM exif').get() as {
      make: string
      model: string
      lens: string
      iso: number
      f_number: number
      raw: Uint8Array
    }
    expect(row.make).toBe('Apple')
    expect(row.model).toBe('iPhone 16 Pro Max')
    expect(row.iso).toBe(80)
    expect(row.f_number).toBe(1.78)
    // Compressed, and smaller than the JSON it came from.
    expect(row.raw.byteLength).toBeGreaterThan(0)
    expect(row.raw.byteLength).toBeLessThan(JSON.stringify(REAL_HEIC).length)
  })
})

describe('file timestamps', () => {
  it('stamps the file with the capture instant', async () => {
    putOnDevice(s, 'IMG_0110.HEIC', makeHeic(), MTIME)
    await importAll({ 'IMG_0110.HEIC': REAL_HEIC })

    const [only] = libraryFiles(s.libraryRoot)
    const st = fs.statSync(path.join(s.libraryRoot, only!))
    expect(Math.floor(st.mtimeMs / 1000)).toBe(
      Math.floor(Date.UTC(2026, 5, 8, 9, 26, 19, 698) / 1000),
    )
  })
})
