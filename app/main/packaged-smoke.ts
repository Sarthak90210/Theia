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
  fs.writeFileSync(path.join(root, 'profile', 'settings.json'), JSON.stringify({ mapsEnabled: false }))
  await sharp({ create: { width: 64, height: 48, channels: 3, background: '#4c7a82' } })
    .jpeg().toFile(path.join(root, 'generated.jpg'))
  fs.writeFileSync(path.join(root, 'invalid.heic'), 'Theia invalid HEIC fixture')
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
        if (logo?.naturalWidth > 0 && document.querySelector('.welcome')) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const logo = document.querySelector('.titlebar img')
      if (!logo || logo.naturalWidth <= 0) throw new Error('Title-bar logo failed to load')
      if (!document.querySelector('.welcome')) throw new Error('Welcome screen did not render')
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
