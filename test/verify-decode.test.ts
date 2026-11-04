import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openLibrary, type Db } from '../src/library/db.ts'
import { JobQueue } from '../src/jobs/queue.ts'
import { HeicPool } from '../src/thumbs/heic-pool.ts'
import { checkDecode, decodeErrors } from '../src/verify/decode.ts'
import { runVerify, verifySummary, VERIFY_DECODE } from '../src/verify/jobs.ts'
import { scratch, type Scratch } from './helpers.ts'

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0

let s: Scratch
let db: Db
let heic: HeicPool

beforeAll(() => {
  heic = new HeicPool(1)
})
afterAll(async () => {
  await heic.close()
})
beforeEach(() => {
  s = scratch()
  db = openLibrary(s.dbPath)
})
afterEach(() => {
  db.close()
  s.cleanup()
})

/** A photographic-ish JPEG, so the entropy-coded scan is long enough to cut. */
async function photoJpeg(): Promise<Buffer> {
  const w = 640
  const h = 480
  const raw = Buffer.alloc(w * h * 3)
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + ((i / 7) | 0)) & 0xff
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer()
}

function write(name: string, bytes: Buffer): string {
  const p = path.join(s.libraryRoot, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, bytes)
  return p
}

function makeVideo(name: string): string {
  const out = path.join(s.libraryRoot, name)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '4', '-pix_fmt', 'yuv420p', out],
    { windowsHide: true },
  )
  expect(r.status).toBe(0)
  return out
}

describe('checkDecode', () => {
  it('passes an intact JPEG', async () => {
    expect(await checkDecode(write('ok.jpg', await photoJpeg()), 'image/jpeg', { heic })).toEqual({ status: 'ok' })
  })

  it('catches a JPEG cut off partway through its scan', async () => {
    // Structure checks pass this if the end marker is put back. Decoding does not.
    const full = await photoJpeg()
    const cut = Buffer.concat([full.subarray(0, Math.floor(full.length * 0.6)), Buffer.from([0xff, 0xd9])])
    const r = await checkDecode(write('cut.jpg', cut), 'image/jpeg', { heic })
    expect(r.status).toBe('damaged')
  })

  it('catches a PNG with a corrupted chunk', async () => {
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#3a7' } }).png().toBuffer()
    const bad = Buffer.from(png)
    const at = bad.length - 30
    bad[at] = bad[at]! ^ 0xff
    const r = await checkDecode(write('bad.png', bad), 'image/png', { heic })
    expect(r.status).toBe('damaged')
  })

  it('reports a damaged HEIC through the decoder pool', async () => {
    const r = await checkDecode(write('bad.heic', Buffer.from('ftypheic but not really')), 'image/heic', { heic })
    expect(r.status).toBe('damaged')
  })

  it('does not call a DNG damaged just because it cannot check it', async () => {
    const r = await checkDecode(write('x.dng', Buffer.alloc(10)), 'image/x-adobe-dng', { heic })
    expect(r).toEqual({ status: 'unchecked', detail: 'no raw decoder for DNG' })
  })

  it.skipIf(!hasFfmpeg)('passes an intact video and catches one cut short', async () => {
    const good = makeVideo('good.mp4')
    expect(await checkDecode(good, 'video/mp4', { heic })).toEqual({ status: 'ok' })

    // The iPhone layout: samples first, index last. Cutting it loses the index.
    const bytes = fs.readFileSync(good)
    const cut = write('cut.mp4', bytes.subarray(0, Math.floor(bytes.length * 0.7)))
    const r = await checkDecode(cut, 'video/mp4', { heic })
    expect(r.status).toBe('damaged')
  })
})

describe('ffmpeg output', () => {
  it('ignores the null muxer complaining about timestamps', () => {
    // Seen on 65 real iPhone videos that all play fine.
    const noise =
      '[null @ 00000276e3f69780] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 47 >= 47\n'
    expect(decodeErrors(noise)).toBeNull()
  })

  it('still reports a real decode error printed alongside it', () => {
    const mixed =
      '[null @ 0000] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 1 >= 1\n' +
      '[hevc @ 0000] Invalid NAL unit size (1234 > 567).\n'
    expect(decodeErrors(mixed)).toBe('[hevc @ 0000] Invalid NAL unit size (1234 > 567).')
  })
})

describe('verify jobs', () => {
  function addAsset(files: { rel: string; bytes: Buffer; mime: string; primary: boolean }[]): number {
    const assetId = Number(
      db.prepare(`INSERT INTO asset (kind, captured_utc, created_at, updated_at) VALUES ('still', 1, 0, 0)`).run()
        .lastInsertRowid,
    )
    for (const f of files) {
      write(f.rel, f.bytes)
      db.prepare(
        `INSERT INTO file (asset_id, role, is_primary, path, bytes, sha256, mime, verify_level, created_at)
         VALUES (?, 'master', ?, ?, ?, ?, ?, 2, 0)`,
      ).run(assetId, f.primary ? 1 : 0, f.rel, f.bytes.length, createHash('sha256').update(f.bytes).digest('hex'), f.mime)
    }
    return assetId
  }

  it('checks every file of an asset and records each result on the file', async () => {
    const good = await photoJpeg()
    const cut = Buffer.concat([good.subarray(0, Math.floor(good.length * 0.5)), Buffer.from([0xff, 0xd9])])
    addAsset([
      { rel: '2026/IMG_1.JPG', bytes: good, mime: 'image/jpeg', primary: true },
      { rel: '2026/IMG_E1.JPG', bytes: cut, mime: 'image/jpeg', primary: false },
    ])
    addAsset([{ rel: '2026/raw.dng', bytes: Buffer.alloc(10), mime: 'image/x-adobe-dng', primary: true }])

    const q = new JobQueue(db)
    q.enqueueAll(VERIFY_DECODE)
    await runVerify(db, q, s.libraryRoot, { heic }, { concurrency: 2 })

    // A damaged file is a finished check, not a failed job.
    expect(q.counts(VERIFY_DECODE)).toMatchObject({ done: 2, failed: 0 })
    const summary = verifySummary(db)
    expect(summary.decoded).toBe(1)
    expect(summary.damaged.map((d) => d.path)).toEqual(['2026/IMG_E1.JPG'])
    expect(summary.unchecked).toEqual([{ mime: 'image/x-adobe-dng', n: 1 }])
  })

  it('skips a file that is already decoded in full', async () => {
    const assetId = addAsset([{ rel: '2026/gone.jpg', bytes: await photoJpeg(), mime: 'image/jpeg', primary: true }])
    db.prepare(`UPDATE file SET verify_level = 3 WHERE asset_id = ?`).run(assetId)
    // If the handler tried to decode it, this would mark it damaged.
    fs.rmSync(path.join(s.libraryRoot, '2026', 'gone.jpg'))

    const q = new JobQueue(db)
    q.enqueueAll(VERIFY_DECODE)
    await runVerify(db, q, s.libraryRoot, { heic }, { concurrency: 1 })

    expect(verifySummary(db).damaged).toEqual([])
  })
})
