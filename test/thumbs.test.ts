import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openLibrary, type Db } from '../src/library/db.ts'
import { JobQueue } from '../src/jobs/queue.ts'
import { HeicPool } from '../src/thumbs/heic-pool.ts'
import { hasThumbs, thumbPath, renderThumbnails } from '../src/thumbs/render.ts'
import { queueThumbnails, runThumbnails, THUMBNAIL } from '../src/thumbs/jobs.ts'
import { scratch, type Scratch } from './helpers.ts'

/**
 * Real decoders, real files. HEIC is covered by the pool's error path here and
 * by the run against the real library: sharp cannot encode HEVC, so there is
 * no way to synthesise a HEIC fixture without shipping someone's photo.
 */

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0

let s: Scratch
let db: Db
let media: string
let cache: string
let heic: HeicPool

beforeAll(() => {
  heic = new HeicPool(2)
})

afterAll(async () => {
  await heic.close()
})

beforeEach(() => {
  s = scratch()
  db = openLibrary(s.dbPath)
  media = s.libraryRoot
  cache = path.join(path.dirname(s.libraryRoot), 'cache')
})

afterEach(() => {
  db.close()
  s.cleanup()
})

/** Put a file in the library and record it as an asset's primary file. */
function addAsset(rel: string, bytes: Buffer, mime: string, capturedUtc = 1): { assetId: number; sha: string } {
  const abs = path.join(media, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, bytes)
  const sha = createHash('sha256').update(bytes).digest('hex')
  const assetId = Number(
    db
      .prepare(`INSERT INTO asset (kind, captured_utc, created_at, updated_at) VALUES (?, ?, 0, 0)`)
      .run(mime.startsWith('video/') ? 'video' : 'still', capturedUtc).lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO file (asset_id, role, is_primary, path, bytes, sha256, mime, created_at)
     VALUES (?, 'master', 1, ?, ?, ?, ?, 0)`,
  ).run(assetId, rel, bytes.length, sha, mime)
  return { assetId, sha }
}

async function jpeg(width: number, height: number, orientation?: number): Promise<Buffer> {
  let img = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } }).jpeg()
  if (orientation) img = img.withMetadata({ orientation })
  return img.toBuffer()
}

async function run(queue = new JobQueue(db)) {
  queueThumbnails(db, queue, cache)
  await runThumbnails(db, queue, media, cache, { heic }, { concurrency: 2, retryBaseMs: 0 })
  return queue
}

describe('thumbnails', () => {
  it('writes three sizes for a JPEG and records its dimensions', async () => {
    const { assetId, sha } = addAsset('2026/a.jpg', await jpeg(3000, 2000), 'image/jpeg')

    const q = await run()

    expect(q.counts(THUMBNAIL)).toMatchObject({ done: 1, failed: 0 })
    const sm = await sharp(thumbPath(cache, sha, 'sm')).metadata()
    const lg = await sharp(thumbPath(cache, sha, 'lg')).metadata()
    const ph = await sharp(thumbPath(cache, sha, 'ph')).metadata()
    expect([sm.format, sm.width, sm.height]).toEqual(['webp', 800, 534])
    expect([lg.width, lg.height]).toEqual([1600, 1067])
    expect([ph.width, ph.height]).toEqual([32, 21])
    expect(db.prepare(`SELECT width, height FROM asset WHERE id = ?`).get(assetId)).toEqual({ width: 3000, height: 2000 })
  })

  it('preserves the HEIC colour profile in every thumbnail size', async () => {
    const p3 = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#258bd5' } })
      .withIccProfile('p3').png().toBuffer()
    const icc = (await sharp(p3).metadata()).icc!
    const box = Buffer.alloc(12)
    box.writeUInt32BE(12 + icc.length)
    box.write('colrprof', 4, 'latin1')
    const file = path.join(media, 'colour.heic')
    fs.writeFileSync(file, Buffer.concat([box, icc]))
    const data = await sharp(p3).keepIccProfile().ensureAlpha().raw().toBuffer()
    const decoder = { decode: async () => ({ data, width: 800, height: 600 }) }
    await renderThumbnails(file, 'image/heic', 'colour', cache, { heic: decoder })
    for (const size of ['sm', 'lg', 'ph'] as const) {
      expect((await sharp(thumbPath(cache, 'colour', size)).metadata()).icc?.equals(icc)).toBe(true)
    }
  })

  it('applies EXIF orientation, so a portrait photo stays portrait', async () => {
    // Stored landscape, tagged "rotate 90", which is how phones save portrait JPEGs.
    const { assetId, sha } = addAsset('2026/p.jpg', await jpeg(1200, 800, 6), 'image/jpeg')
    await run()
    const sm = await sharp(thumbPath(cache, sha, 'sm')).metadata()
    expect([sm.width, sm.height]).toEqual([533, 800])
    expect(db.prepare(`SELECT width, height FROM asset WHERE id = ?`).get(assetId)).toEqual({ width: 800, height: 1200 })
  })

  it('never enlarges a small image', async () => {
    const png = await sharp({ create: { width: 120, height: 90, channels: 4, background: '#08f' } }).png().toBuffer()
    const { sha } = addAsset('2026/small.png', png, 'image/png')
    await run()
    const lg = await sharp(thumbPath(cache, sha, 'lg')).metadata()
    expect([lg.width, lg.height]).toEqual([120, 90])
  })

  it('fails a file it cannot read once, with the reason, and carries on', async () => {
    addAsset('2026/broken.jpg', Buffer.from('not a jpeg at all'), 'image/jpeg', 2)
    const { sha } = addAsset('2026/fine.jpg', await jpeg(800, 600), 'image/jpeg', 1)

    const q = await run()

    expect(q.counts(THUMBNAIL)).toMatchObject({ done: 1, failed: 1 })
    expect(q.failures(THUMBNAIL)[0]!.error).toMatch(/cannot read image\/jpeg/)
    expect(hasThumbs(cache, sha)).toBe(true)
  })

  it('requeues completed jobs with thumbnails from the previous renderer', async () => {
    const { sha } = addAsset('2026/a.jpg', await jpeg(800, 600), 'image/jpeg')
    const q = new JobQueue(db)
    queueThumbnails(db, q, cache)
    const job = q.claim(THUMBNAIL)
    q.complete(job!.id)
    const old = path.join(cache, 'thumbs', sha.slice(0, 2))
    fs.mkdirSync(old, { recursive: true })
    for (const size of ['sm', 'lg', 'ph']) fs.writeFileSync(path.join(old, `${sha}-${size}.webp`), Buffer.from('old'))
    expect(hasThumbs(cache, sha)).toBe(false)
    expect(queueThumbnails(db, q, cache)).toEqual({ added: 0, requeued: 1 })
  })

  it('rebuilds everything after the cache folder is deleted', async () => {
    const { sha } = addAsset('2026/a.jpg', await jpeg(800, 600), 'image/jpeg')
    const q = await run()
    fs.rmSync(cache, { recursive: true, force: true })

    expect(queueThumbnails(db, q, cache)).toEqual({ added: 0, requeued: 1 })
    await runThumbnails(db, q, media, cache, { heic }, { concurrency: 1 })
    expect(hasThumbs(cache, sha)).toBe(true)
  })

  it.each(['hidden', 'deleted'] as const)('does not recreate disk thumbnails or endlessly requeue a %s item', async privacy => {
    const { assetId, sha } = addAsset('2026/private.jpg', await jpeg(800, 600), 'image/jpeg')
    const queue = new JobQueue(db)
    if (privacy === 'hidden') db.prepare('UPDATE asset SET hidden = 1 WHERE id = ?').run(assetId)
    // Seed a queued job first: a visible item may become private while waiting.
    queue.enqueue(THUMBNAIL, assetId)
    if (privacy === 'deleted') db.prepare('UPDATE asset SET deleted_at = 1 WHERE id = ?').run(assetId)
    await runThumbnails(db, queue, media, cache, { heic }, { concurrency: 1 })
    expect(queue.counts(THUMBNAIL)).toMatchObject({ done: 1, queued: 0, failed: 0 })
    expect(hasThumbs(cache, sha)).toBe(false)
    expect(queueThumbnails(db, queue, cache)).toEqual({ added: 0, requeued: 0 })
    expect(queueThumbnails(db, queue, cache)).toEqual({ added: 0, requeued: 0 })
    expect(queue.counts(THUMBNAIL)).toMatchObject({ done: 1, queued: 0, running: 0 })
  })

  it('renders identical bytes once for two assets', async () => {
    const bytes = await jpeg(800, 600)
    addAsset('2026/one.jpg', bytes, 'image/jpeg')
    const { sha } = addAsset('2026/two.jpg', bytes, 'image/jpeg')
    const q = await run()
    expect(q.counts(THUMBNAIL).done).toBe(2)
    expect(fs.readdirSync(path.join(cache, 'thumbs', 'v2', sha.slice(0, 2)))).toHaveLength(3)
  })

  it.skipIf(!hasFfmpeg)('takes a frame from a video', async () => {
    const out = path.join(s.libraryRoot, '..', 'clip.mp4')
    const made = spawnSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-t', '1', '-pix_fmt', 'yuv420p', out],
      { windowsHide: true },
    )
    expect(made.status).toBe(0)
    const { assetId, sha } = addAsset('2026/clip.mp4', fs.readFileSync(out), 'video/mp4')

    await run()

    const sm = await sharp(thumbPath(cache, sha, 'sm')).metadata()
    expect([sm.width, sm.height]).toEqual([640, 360])
    expect(db.prepare(`SELECT width, height FROM asset WHERE id = ?`).get(assetId)).toEqual({ width: 640, height: 360 })
  })
})

describe('HEIC pool', () => {
  it('reports a file that is not HEIC as an error and keeps working', async () => {
    const bogus = path.join(s.libraryRoot, '..', 'bogus.heic')
    fs.writeFileSync(bogus, Buffer.from('nope'))
    await expect(heic.decode(bogus)).rejects.toThrow()
    await expect(heic.decode(bogus)).rejects.toThrow()
    expect(heic.size).toBe(2)
  })
})
