import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import { app, type BrowserWindow } from 'electron'
import { ExifToolReader } from '../../src/metadata/reader.ts'
import { HeicPool } from '../../src/thumbs/heic-pool.ts'
import { videoFrame } from '../../src/thumbs/video.ts'
import { Embedder } from '../../src/search/embedder.ts'
import { DIMENSIONS, MODEL_NAME } from '../../src/search/model.ts'
import { OcrReader } from '../../src/search/ocr.ts'
import { OCR_NAME } from '../../src/search/ocr-model.ts'
import { FaceReader } from '../../src/search/faces.ts'
import { FACE_NAME } from '../../src/search/face-model.ts'

const exec = promisify(execFile)
const options = { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }

interface Check {
  name: string
  ok: boolean
  detail?: unknown
  error?: string
}

/** A smoke run owns an isolated profile, never the user's normal vault list. */
export async function preparePackagedSmoke(root: string): Promise<void> {
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true })
  fs.writeFileSync(path.join(root, 'profile', 'gallery.json'), JSON.stringify({ vaults: [] }))
  fs.writeFileSync(path.join(root, 'profile', 'settings.json'), JSON.stringify({ mapsEnabled: false, setupDone: true }))
  await sharp({ create: { width: 64, height: 48, channels: 3, background: '#4c7a82' } })
    .jpeg().toFile(path.join(root, 'generated.jpg'))
  fs.writeFileSync(path.join(root, 'invalid.heic'), 'Theia invalid HEIC fixture')
  const print = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200"><rect width="100%" height="100%" fill="#fff"/>
    <text x="40" y="115" font-family="Arial" font-size="56" font-weight="bold" fill="#111">THEIA 2026</text></svg>`
  await sharp(Buffer.from(print)).webp().toFile(path.join(root, 'printed.webp'))
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function within<T>(work: Promise<T>, description: string, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), ms)
    })])
  } finally { clearTimeout(timer) }
}

/** Run against the installed files and Electron runtime, then write a machine-readable receipt. */
export async function runPackagedSmoke(root: string, win: BrowserWindow): Promise<void> {
  const checks: Check[] = []
  const versions: Record<string, string | undefined> = {
    app: app.getVersion(), electron: process.versions.electron, node: process.versions.node,
  }
  const check = async (name: string, work: () => unknown | Promise<unknown>) => {
    try { checks.push({ name, ok: true, detail: await work() }) }
    catch (e) { checks.push({ name, ok: false, error: (e as Error).message }) }
  }
  const jpeg = path.join(root, 'generated.jpg')
  const video = path.join(root, 'generated.mp4')

  await check('packaged runtime and isolated profile', () => {
    assert(app.isPackaged, 'Smoke check must run from a packaged app.')
    assert(path.resolve(app.getPath('userData')) === path.resolve(root, 'profile'), 'Unexpected profile directory.')
    return { packaged: app.isPackaged, resources: process.resourcesPath, profile: app.getPath('userData') }
  })

  await check('native SQLite', () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE smoke (value TEXT); INSERT INTO smoke VALUES (\'Theia\')')
      const row = db.prepare('SELECT value, sqlite_version() AS version FROM smoke').get() as { value: string; version: string }
      assert(row.value === 'Theia', 'SQLite round-trip failed.')
      versions.sqlite = row.version
      return row
    } finally { db.close() }
  })

  await check('native image decode', async () => {
    const result = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true })
    assert(result.info.width === 64 && result.info.height === 48, 'JPEG dimensions did not survive decoding.')
    versions.sharp = sharp.versions.sharp
    return { width: result.info.width, height: result.info.height, bytes: result.data.length }
  })

  await check('bundled ExifTool', async () => {
    const reader = new ExifToolReader()
    try {
      const tags = await within(reader.read(jpeg), 'ExifTool read')
      assert(tags.meta.width === 64 && tags.meta.height === 48, 'ExifTool could not read the generated JPEG.')
      return { width: tags.meta.width, height: tags.meta.height }
    } finally { await reader.close() }
  })

  await check('bundled FFmpeg and FFprobe', async () => {
    const ffmpeg = await exec('ffmpeg', ['-version'], options)
    const ffprobe = await exec('ffprobe', ['-version'], options)
    versions.ffmpeg = ffmpeg.stdout.split(/\r?\n/)[0]
    versions.ffprobe = ffprobe.stdout.split(/\r?\n/)[0]
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc2=size=160x120:rate=10:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', video], options)
    const result = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height,codec_name', '-of', 'json', video], options)
    const stream = JSON.parse(result.stdout).streams?.[0]
    assert(stream?.width === 160 && stream?.height === 120 && stream?.codec_name === 'h264', 'Generated H.264 video failed probing.')
    const frame = await within(videoFrame(video), 'video thumbnail')
    const info = await sharp(frame).metadata()
    assert(info.width === 160 && info.height === 120, 'Video thumbnail failed decoding.')
    return { stream, thumbnailBytes: frame.length }
  })

  await check('HEIC worker loads its WebAssembly decoder and rejects invalid input', async () => {
    const pool = new HeicPool(1)
    try {
      let failure = ''
      try { await within(pool.decode(path.join(root, 'invalid.heic')), 'HEIC worker response') }
      catch (e) { failure = (e as Error).message }
      assert(failure === 'no image in HEIF container', `Unexpected HEIC response: ${failure || 'invalid input decoded'}`)
      return { workerLoaded: true, invalidInputRejected: true, realHeicDecodeTested: false }
    } finally { await pool.close() }
  })

  await check('bundled search model embeds a photo and a query offline', async () => {
    const modelDir = path.join(process.resourcesPath, 'models', MODEL_NAME)
    assert(Embedder.available(modelDir), `Search model files missing from ${modelDir}.`)
    // 'auto': the graphics card when it runs the model and agrees with the
    // processor, else the processor. Either passes; the receipt says which.
    let device: unknown = null
    const embedder = new Embedder(modelDir, { device: 'auto', onDevice: (d) => { device = d } })
    try {
      const started = Date.now()
      const image = await within(embedder.image(jpeg), 'search image embedding', 120_000)
      const query = await within(embedder.query('a teal coloured picture'), 'search query embedding', 60_000)
      assert(image.length === DIMENSIONS && query.length === DIMENSIONS, 'Search vectors have the wrong size.')
      const score = image.reduce((sum, x, i) => sum + x * query[i]!, 0)
      assert(Number.isFinite(score) && score > 0, `Implausible search score ${score}.`)
      return { modelDir, dimensions: image.length, score: Number(score.toFixed(3)), ms: Date.now() - started, device }
    } finally { await embedder.close() }
  })

  await check('bundled text reader reads printed words offline', async () => {
    const modelDir = path.join(process.resourcesPath, 'models', OCR_NAME)
    assert(OcrReader.available(modelDir), `Text reading models missing from ${modelDir}.`)
    const reader = new OcrReader(modelDir)
    try {
      const started = Date.now()
      const { lines } = await within(reader.read(path.join(root, 'printed.webp')), 'text reading', 60_000)
      const text = lines.map((l) => l.text).join(' ')
      assert(text.includes('THEIA 2026'), `Read "${text}" instead of THEIA 2026.`)
      return { modelDir, text, ms: Date.now() - started }
    } finally { await reader.close() }
  })

  await check('bundled face models load, find no face in a plain picture, and group faces', async () => {
    const modelDir = path.join(process.resourcesPath, 'models', FACE_NAME)
    assert(FaceReader.available(modelDir), `Face models missing from ${modelDir}.`)
    const reader = new FaceReader(modelDir)
    try {
      const started = Date.now()
      const found = await within(reader.read(jpeg), 'face finding', 60_000)
      assert(found.faces.length === 0, `Found ${found.faces.length} faces in a plain picture.`)
      // Three photos of one face make a group.
      const one = new Float32Array(128); one[5] = 1
      const free = new Float32Array(3 * 128); for (let i = 0; i < 3; i++) free.set(one, i * 128)
      const grouped = await reader.cluster({
        free, freeAsset: Int32Array.from([1, 2, 3]), held: new Float32Array(0), heldAsset: new Int32Array(0), heldPerson: new Int32Array(0), rejects: [],
      })
      assert([...grouped.group].every((g) => g === 0), 'Three copies of one face did not make one group.')
      return { modelDir, ms: Date.now() - started }
    } finally { await reader.close() }
  })

  await check('renderer, preload bridge and title-bar logo', async () => {
    win.webContents.setBackgroundThrottling(false)
    if (win.webContents.isLoadingMainFrame()) {
      await within(new Promise<void>((resolve, reject) => {
        win.webContents.once('did-finish-load', () => resolve())
        win.webContents.once('did-fail-load', (_e, code, description) => reject(new Error(`${code}: ${description}`)))
      }), 'renderer load')
    }
    const state = await within(win.webContents.executeJavaScript(`(async () => {
      const until = Date.now() + 15000
      while (Date.now() < until) {
        const logo = document.querySelector('.titlebar img')
        if (logo?.naturalWidth > 0 && document.querySelector('.welcome-hero')) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const logo = document.querySelector('.titlebar img')
      if (!logo || logo.naturalWidth <= 0) throw new Error('Title-bar logo failed to load')
      if (!document.querySelector('.welcome-hero')) throw new Error('Welcome screen did not render')
      if (!window.photos || typeof window.photos.getState !== 'function') throw new Error('Preload bridge missing')
      const state = await window.photos.getState()
      if (state.vaults.length !== 0) throw new Error('Unexpected vault in smoke profile')
      return { title: document.title, logoWidth: logo.naturalWidth, vaults: state.vaults.length, mapsEnabled: state.settings.mapsEnabled }
    })()`), 'renderer and bridge')
    fs.writeFileSync(path.join(root, 'window.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
    return state
  })

  const ok = checks.every(check => check.ok)
  const receipt = {
    ok, createdAt: new Date().toISOString(), checks, versions,
    error: ok ? null : checks.filter(check => !check.ok).map(check => `${check.name}: ${check.error}`).join('; '),
  }
  fs.writeFileSync(path.join(root, 'packaged-smoke.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt, null, 2))
  app.exit(ok ? 0 : 1)
}
