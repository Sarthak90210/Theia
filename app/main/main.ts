import fs from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { app, BrowserWindow, dialog, powerMonitor, ipcMain, nativeTheme, net, powerSaveBlocker, protocol, shell } from 'electron'
import { INVOKE_CHANNELS, MEDIA_SCHEME, STATE_CHANNEL, type AppState } from '../shared/api.ts'
import { GalleryService } from './gallery-service.ts'
import { MapTiles } from './map-tiles.ts'
import { rangeResponse } from '../../src/media/ranges.ts'
import { preparePackagedSmoke, runPackagedSmoke } from './packaged-smoke.ts'

declare const THEIA_DEVELOPMENT: boolean
const devHarnessDir = THEIA_DEVELOPMENT && !app.isPackaged ? process.env.PHOTOS_DEV_DIR : undefined
const smokeDirectory = app.commandLine.getSwitchValue('theia-smoke-dir')
if (smokeDirectory) app.setPath('userData', path.join(path.resolve(smokeDirectory), 'profile'))
// All existing media helpers use these names. Prefer the shipped tools only
// inside this process, without modifying the user's system PATH.
if (app.isPackaged) process.env.PATH = `${path.join(process.resourcesPath, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`

/**
 * Electron entry. Creates the window, serves images and videos on a custom
 * scheme, wires PhotosApi channels to the service, and keeps the machine awake
 * during a save. Everything else lives in GalleryService.
 */

/** Matches --titlebar-h in polish.css. */
const TITLEBAR_HEIGHT = 44

let win: BrowserWindow | null = null
let service: GalleryService | null = null
let blocker: number | null = null
let mapTiles: MapTiles | null = null
nativeTheme.themeSource = 'dark'

// Branding is independent of the existing profile's on-disk identity.
// Preserve a custom userData path, such as the integration test profile.
const initialProfile = app.getPath('userData')
if (path.resolve(initialProfile).toLowerCase() === path.resolve(app.getPath('appData'), app.getName()).toLowerCase()) {
  app.setPath('userData', path.join(app.getPath('appData'), 'photos-win-prototype'))
}
app.setName('Theia')

// Thumbnails and videos are files on disk. Serving them on a scheme of our own
// lets <img> and <video> load them directly, with range requests for seeking,
// instead of shipping bytes over IPC.
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: 'Theia',
    icon: path.join(__dirname, 'theia-logo.png'),
    backgroundColor: '#18181a',
    show: false,
    // Theia draws its own title bar with a full-size logo (TitleBar.tsx).
    // Windows keeps drawing the caption buttons, in Theia's colours.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#18181a', symbolColor: '#f1f1f3', height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !devHarnessDir && !smokeDirectory,
    },
  })
  win.removeMenu()
  win.once('ready-to-show', () => win?.show())
  win.webContents.once('did-finish-load', () => win?.show())
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('closed', () => (win = null))
}

app.whenReady().then(async () => {
  if (smokeDirectory) await preparePackagedSmoke(path.resolve(smokeDirectory))
  service = new GalleryService({
    userData: app.getPath('userData'),
    publish: (state: AppState) => win?.webContents.send(STATE_CHANNEL, state),
    pickFolder: async (title, defaultPath) => {
      const r = await dialog.showOpenDialog(win!, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] })
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    openPath: async (p) => {
      const err = await shell.openPath(p)
      if (err) throw new Error(err)
    },
    showInFolder: (p) => shell.showItemInFolder(p),
    openExternal: (url) => shell.openExternal(url),
    trash: (file) => shell.trashItem(file),
    recycleBinLimit,
    setBusy: (busy) => {
      if (busy && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
      if (!busy && blocker !== null) {
        powerSaveBlocker.stop(blocker)
        blocker = null
      }
    },
  })

  mapTiles = new MapTiles({
    cacheRoot: path.join(app.getPath('userData'), 'map-tiles'),
    enabled: () => service?.mapsEnabled() ?? false,
    fetch: (url, init) => net.fetch(url, init),
    userAgent: `Theia/${app.getVersion()} (Windows photo library app)`,
  })

  // photos-media://media/<source>/<what>/<key>, and photos-media://map/<z>/<x>/<y>
  protocol.handle(MEDIA_SCHEME, async (req) => {
    try {
      const url = new URL(req.url)
      if (url.hostname === 'map') return await mapTiles!.get(url.pathname)
      const [source, what, key] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      if (!source || !what || !key) return new Response('bad request', { status: 400 })
      const m = await service!.media(source, what, key)
      if (!m || ('path' in m && !fs.existsSync(m.path))) {
        if (process.env.PHOTOS_DEV_DIR) console.warn(`[media] 404 ${what} ${key}`)
        return new Response('not found', { status: 404 })
      }
      // Range answers by hand: protocol.handle does not do them, and without
      // a 206 a video cannot seek. Videos and previews can change (a
      // conversion finishing), so only images are cached for long.
      const cache = 'no-store'
      const res = await rangeResponse('path' in m ? { file: m.path } : { source: m.source }, req.headers.get('range'), {
        'Content-Type': m.mime,
        'Cache-Control': cache,
      })
      if (process.env.PHOTOS_DEV_DIR && what === 'video') {
        console.warn(`[media] video ${req.headers.get('range')} -> ${res.status} ${res.headers.get('content-range')} ${res.headers.get('content-length')}`)
      }
      return res
    } catch (e) {
      console.error(`[media] ${req.url}:`, (e as Error).message)
      return new Response((e as Error).message, { status: 500 })
    }
  })

  const methods: Record<string, string> = { getState: 'snapshot', save: 'saveItems' }
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(`photos:${channel}`, async (_e, ...args: unknown[]) => {
      const fn = (service as unknown as Record<string, (...a: unknown[]) => unknown>)[methods[channel] ?? channel]
      const result = await fn!.apply(service, args)
      if (['setUpProtection', 'lockVault', 'setHidden', 'remove', 'closeVault'].includes(channel)) await win?.webContents.session.clearCache()
      if (channel === 'setSettings' && !service!.mapsEnabled()) mapTiles?.cancel()
      return result
    })
  }

  createWindow()
  await win!.webContents.session.clearCache()
  if (smokeDirectory) await runPackagedSmoke(path.resolve(smokeDirectory), win!)
  else service.start()
  // Hidden and Recently Deleted lock again when Windows locks or sleeps.
  powerMonitor.on('lock-screen', () => service?.lockAll())
  powerMonitor.on('suspend', () => service?.lockAll())
  if (THEIA_DEVELOPMENT && devHarnessDir) startDevHarness(devHarnessDir)
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  void service?.stop()
})

/**
 * Development only, with PHOTOS_DEV_DIR set. Writes the window to window.png
 * and the state to state.json every couple of seconds, and runs lines from
 * commands.txt in the window as JavaScript (`js <code>`) or on the service
 * (`<method> <args>`). Lets the app be checked end to end without anyone at
 * the mouse.
 */
function startDevHarness(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  const commands = path.join(dir, 'commands.txt')
  fs.writeFileSync(commands, '')
  setInterval(async () => {
    if (!win || !service) return
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(service.snapshot(), null, 2))
    // stayAwake: a window behind others stops painting, and the capture goes stale.
    const img = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    fs.writeFileSync(path.join(dir, 'window.png'), img.toPNG())
  }, 1500)

  let offset = 0
  setInterval(() => {
    const text = fs.readFileSync(commands, 'utf8')
    if (text.length <= offset) return
    const lines = text.slice(offset).split(/\r?\n/).filter(Boolean)
    offset = text.length
    for (const line of lines) {
      console.log(`[dev] ${line}`)
      if (line.startsWith('js ')) {
        win?.webContents
          .executeJavaScript(line.slice(3))
          .then((r) => fs.writeFileSync(path.join(dir, 'js-result.json'), JSON.stringify(r ?? null, null, 2)))
          .catch((e) => console.error('[dev] js failed', e))
        continue
      }
      const [name, ...args] = line.trim().split(/\s+/)
      const fn = (service as unknown as Record<string, (...a: unknown[]) => unknown>)[name!]
      if (typeof fn === 'function') void Promise.resolve(fn.apply(service, args)).catch((e) => console.error(`[dev] ${name}`, e))
    }
  }, 300)
}

/**
 * The Recycle Bin's size limit for the drive holding `dir`. Windows keeps it
 * per volume in the registry (MaxCapacity, in MB), and deletes anything bigger
 * outright instead of recycling it, so deleting a vault checks it first.
 */
function recycleBinLimit(dir: string): Promise<{ maxBytes: number; nukeOnDelete: boolean } | null> {
  const drive = path.parse(path.resolve(dir)).root.slice(0, 1)
  if (!/^[A-Za-z]$/.test(drive)) return Promise.resolve(null)
  const script = [
    `$v = Get-Volume -DriveLetter ${drive} -ErrorAction Stop`,
    `$g = [regex]::Match($v.UniqueId, '[{][0-9a-fA-F-]+[}]').Value`,
    `$k = Get-ItemProperty -Path ('HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/BitBucket/Volume/' + $g) -ErrorAction Stop`,
    `@{ max = [int64]$k.MaxCapacity; nuke = [int]$k.NukeOnDelete } | ConvertTo-Json -Compress`,
  ].join('; ')
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 }, (err, out) => {
      if (err) return resolve(null)
      try {
        const j = JSON.parse(out) as { max: number; nuke: number }
        resolve(j.max > 0 ? { maxBytes: j.max * 1024 * 1024, nukeOnDelete: j.nuke === 1 } : null)
      } catch {
        resolve(null)
      }
    })
  })
}
