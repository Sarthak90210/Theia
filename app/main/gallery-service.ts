import { heicProfile, tagJpeg, IMAGE_CACHE_VERSION } from '../../src/thumbs/colour.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp, { type Sharp } from 'sharp'
import { AfcDevice } from '../../src/device/afc-device.ts'
import { DeviceRegistry } from '../../src/device/registry.ts'
import { DeviceWatcher } from '../../src/device/watcher.ts'
import { HeicPool } from '../../src/thumbs/heic-pool.ts'
import { ExifToolReader } from '../../src/metadata/reader.ts'
import { JobQueue } from '../../src/jobs/queue.ts'
import { renderThumbnails, thumbPath, type ThumbSize } from '../../src/thumbs/render.ts'
import { queueThumbnails, runThumbnails, THUMBNAIL } from '../../src/thumbs/jobs.ts'
import { PhoneSession, mimeOf } from '../../src/gallery/phone-session.ts'
import { displayFile, vaultCollections, vaultDetail, vaultFiles, vaultItems } from '../../src/gallery/vault-gallery.ts'
import { phoneSaveAlbums, phoneSaveItems, vaultSaveAlbums, vaultSaveItems } from '../../src/gallery/save-sources.ts'
import { backfillPlaceNames } from '../../src/gallery/place-backfill.ts'
import type { Collections, GalleryItem, ItemDetail } from '../../src/gallery/types.ts'
import { createVault, isVault, canCreateVault, openVault, NotAVault, type OpenVault } from '../../src/vault/vault.ts'
import { saveToVault, SaveCancelled } from '../../src/vault/save.ts'
import { purgeAssets, restoreAssets, trashAssets } from '../../src/vault/delete.ts'
import { keepBurstFrame, setBurstCover } from '../../src/vault/burst.ts'
import { saveEditedCopy, vaultEditSource } from '../../src/vault/edit.ts'
import { editPreview } from '../../src/media/edit.ts'
import type { EditRecipe } from '../../src/media/edit-recipe.ts'
import { convert, planFor, probe, storyboard as makeStoryboard, type Plan, type Probe } from '../../src/media/playback.ts'
import type { ByteSource } from '../../src/media/ranges.ts'
import type { AppState, SaveRequest, SaveState, SourceId, StoryboardInfo, VaultInfo } from '../shared/api.ts'
import type { AppSettings } from '../shared/settings.ts'
import { SettingsStore } from './settings.ts'

sharp.cache(false)

/**
 * Everything the gallery does, without Electron in it. Electron-specific calls
 * (dialogs, the shell) come in through ServiceDeps.
 */

export interface ServiceDeps {
  userData: string
  publish: (state: AppState) => void
  pickFolder: (title: string, defaultPath?: string) => Promise<string | null>
  openPath: (p: string) => Promise<void>
  showInFolder: (p: string) => void
  openExternal: (url: string) => Promise<void>
  /** Move a file to the Recycle Bin. */
  trash: (file: string) => Promise<void>
  setBusy: (busy: boolean) => void
}

interface VaultEntry {
  id: SourceId
  vault: OpenVault
  queue: JobQueue
  revision: number
}

const DEFAULT_LIBRARY = process.platform === 'win32' ? 'D:\\PhotosLibrary' : path.join(os.homedir(), 'PhotosLibrary')

export class GalleryService {
  private readonly settings: SettingsStore
  private readonly vaults = new Map<SourceId, VaultEntry>()
  private readonly registry: DeviceRegistry<PhoneSession>
  private readonly watcher = new DeviceWatcher()
  private readonly heic = new HeicPool(Math.max(1, Math.min(os.cpus().length - 2, 6)))
  private readonly metadata = new ExifToolReader()
  private save: SaveState = { status: 'idle' }
  private saveAbort: AbortController | null = null
  private thumbs: { done: number; total: number } | null = null
  private thumbsRunning = false
  private readonly rendering = new Map<string, Promise<void>>()
  private publishTimer: NodeJS.Timeout | null = null
  private converting: AppState['converting'] = null
  private readonly probes = new Map<string, Probe>()
  private readonly placesChecked = new WeakMap<PhoneSession, WeakSet<OpenVault>>()

  constructor(private readonly deps: ServiceDeps) {
    this.settings = new SettingsStore(deps.userData)
    this.registry = new DeviceRegistry<PhoneSession>({
      open: async (udid) => {
        const device = await AfcDevice.attach(udid)
        const ident = await device.identity()
        try {
          return await PhoneSession.open({
            device,
            udid,
            name: ident.name,
            cacheRoot: path.join(deps.userData, 'phones'),
            heic: this.heic,
            metadata: this.metadata,
            reconnect: () => AfcDevice.attach(udid),
            // Locked, unplugged or untrusted now. Reopening puts the phone
            // back through the registry, which shows why and retries.
            onLost: () => void this.registry.reopen(udid).then(() => this.watcher.refresh()),
          })
        } catch (e) {
          await device.dispose().catch(() => {})
          throw e
        }
      },
      close: (s) => s.close(),
      nameOf: (s) => s.name,
    })
  }

  start() {
    for (const root of this.loadVaultList()) {
      try {
        this.addVault(root)
      } catch (e) {
        console.error(`could not open vault ${root}:`, (e as Error).message)
      }
    }
    this.registry.on('change', () => {
      this.backfillPlaces()
      this.publish(true)
    })
    this.watcher.on('change', () => this.publish())
    this.registry.start()
    this.watcher.start()
    this.publish(true)
    void this.runThumbnails()
  }

  async stop() {
    this.saveAbort?.abort()
    this.watcher.stop()
    await this.registry.stop()
    await this.heic.close()
    await this.metadata.close().catch(() => {})
    for (const v of this.vaults.values()) v.vault.db.close()
  }

  snapshot(): AppState {
    const devices = this.registry.devices.map((d) => ({
      id: `device:${d.udid}`,
      udid: d.udid,
      name: d.name ?? 'iPhone',
      state: d.state,
      error: d.error,
      count: d.session ? d.session.library.assets.length : null,
    }))
    const anyReady = devices.some((d) => d.state === 'ready')
    return {
      settings: this.settings.get(),
      devices,
      vaults: [...this.vaults.values()].map((v) => this.vaultInfo(v)),
      diagnosis: anyReady ? null : (this.watcher.current.diagnosis ?? null),
      save: this.save,
      thumbnails: this.thumbs,
      converting: this.converting,
    }
  }

  /* ------------------------------------------------------------- browsing */

  mapsEnabled(): boolean { return this.settings.get().mapsEnabled }

  async setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const settings = this.settings.set(patch)
    this.publish(true)
    return settings
  }

  async collections(source: SourceId): Promise<Collections> {
    const v = this.vaults.get(source)
    if (v) return vaultCollections(v.vault.db)
    return this.phone(source).collections()
  }

  async items(source: SourceId, collection: string): Promise<GalleryItem[]> {
    const v = this.vaults.get(source)
    if (v) return vaultItems(v.vault.db, collection)
    // Strip the phone-only fields; the window needs only the tile.
    const s = this.phone(source)
    return s
      .items(collection)
      .map(({ key, kind, t, off, w, h, dur, fav, edited, cloud, subtype, deletedAt, burstId }) => ({
        frames: kind === 'burst' && burstId ? s.library.bursts.get(burstId)?.length : undefined,
        key,
        kind,
        t,
        off,
        w,
        h,
        dur,
        fav,
        edited,
        cloud,
        subtype,
        deletedAt,
      }))
  }

  async detail(source: SourceId, key: string): Promise<ItemDetail | null> {
    const v = this.vaults.get(source)
    if (v) return vaultDetail(v.vault.db, v.vault.layout.media, key)
    const s = this.phone(source)
    const a = s.asset(key)
    return s.detail(key, a ? this.vaultsHolding(s.udid, a.key, a.path) : [])
  }

  /** Every frame of a burst in shooting order, and which one is the cover. */
  async burstFrames(source: SourceId, key: string): Promise<{ frames: string[]; cover: string }> {
    const v = this.vaults.get(source)
    if (v) {
      const files = vaultFiles(v.vault.db, key)
        .filter((f) => f.mime.startsWith('image/') && f.role === 'master')
        .sort((a, b) => a.path.localeCompare(b.path))
      if (files.length < 2) return { frames: [key], cover: key }
      const cover = files.find((f) => f.primary) ?? files[0]!
      return { frames: files.map((f) => `${key}~${f.id}`), cover: `${key}~${cover.id}` }
    }
    const s = this.phone(source)
    const a = s.asset(key)
    // On the phone the burst's tile is its pick, which is the cover.
    return { frames: (a?.burstId && s.library.bursts.get(a.burstId)) || [key], cover: key }
  }

  /**
   * Names of open vaults that already hold this phone item. Vaults filled by
   * saving record the phone's UUID. A library filled by the import engine
   * predates that and only knows the file's path on the phone.
   */
  private vaultsHolding(udid: string, uuid: string, devicePath: string): string[] {
    const out: string[] = []
    for (const v of this.vaults.values()) {
      const db = v.vault.db
      const hit =
        db.prepare(`SELECT 1 FROM asset WHERE source_uuid = ? AND deleted_at IS NULL`).get(uuid) ??
        db
          .prepare(`SELECT 1 FROM import_item WHERE device_udid = ? AND device_path = ? AND stage = 'committed' LIMIT 1`)
          .get(udid, devicePath)
      if (hit) out.push(v.vault.manifest.name)
    }
    return out
  }

  /* ---------------------------------------------------------------- media */

  /**
   * A local file for one image or video, made on first request when needed.
   * Null when there is nothing to show (an iCloud-only original, say).
   */
  async media(
    source: SourceId,
    what: string,
    key: string,
  ): Promise<{ path: string; mime: string } | { source: ByteSource; mime: string } | null> {
    if (what === 'video') {
      const p = await this.playable(source, key, false, false)
      if (!p) return null
      if ('file' in p) return { path: p.file, mime: videoMime(p.file) }
      const { session, devicePath } = p
      const size = await session.size(devicePath)
      return { source: { size, read: (start, length) => session.readRange(devicePath, start, length) }, mime: 'video/mp4' }
    }
    if (what === 'storyboard') {
      const file = this.storyboardFile(source, key)
      return file && fs.existsSync(file) ? { path: file, mime: 'image/jpeg' } : null
    }
    const v = this.vaults.get(source)
    if (v) return this.vaultMedia(v, what, key)
    const s = this.phone(source)
    if (what === 'sm' || what === 'lg' || what === 'ph') {
      const p = await s.thumb(key, what)
      return p ? { path: p, mime: 'image/webp' } : null
    }
    const a = s.asset(key)
    if (!a) return null
    if (what === 'motion') {
      const mov = s.filesFor(key).find((f) => /\.mov$/i.test(f) && path.posix.basename(f) !== a.filename)
      if (!mov) return null
      const local = await s.localCopy(mov)
      return local ? { path: local, mime: 'video/mp4' } : null
    }
    const shown = await s.display(key)
    if (!shown) return null
    return this.displayable(shown.path, mimeOf(shown.name), path.join(this.deps.userData, 'phones', 'full'), `${s.udid}-${safeName(shown.name)}-${key}`)
  }

  private async vaultMedia(v: VaultEntry, what: string, key: string) {
    // `<asset>~<file>` asks for one particular file, such as a burst frame.
    const [assetKey, fileId] = key.split('~')
    const files = vaultFiles(v.vault.db, assetKey!)
    const shown = displayFile(files, fileId ? Number(fileId) : null)
    if (!shown) return null
    const abs = (rel: string) => path.join(v.vault.layout.media, ...rel.split('/'))

    if (what === 'sm' || what === 'lg' || what === 'ph') {
      const p = thumbPath(v.vault.layout.cache, shown.sha256, what as ThumbSize)
      if (!fs.existsSync(p)) await this.renderNow(v, shown.sha256, abs(shown.path), shown.mime)
      return fs.existsSync(p) ? { path: p, mime: 'image/webp' } : null
    }
    if (what === 'motion') {
      const m = files.find((f) => f.role === 'motion')
      return m ? { path: abs(m.path), mime: m.mime === 'video/quicktime' ? 'video/mp4' : m.mime } : null
    }
    return this.displayable(abs(shown.path), shown.mime, path.join(v.vault.layout.cache, 'full'), shown.sha256)
  }

  /* ---------------------------------------------------------------- video */

  /**
   * A form of the video the window can play: a local file, or, for iPhone
   * HEVC and H.264, the file on the phone streamed in pieces so a 5 GB video
   * starts at once. Anything else is copied (from a phone) and converted, once.
   * `convertNow` false: only report what's ready, never start work.
   */
  private async playable(
    source: SourceId,
    key: string,
    force: boolean,
    convertNow = true,
  ): Promise<{ file: string } | { session: PhoneSession; devicePath: string } | null> {
    const v = this.vaults.get(source)
    let input: string
    let out: string
    if (v) {
      const shown = displayFile(vaultFiles(v.vault.db, key.split('~')[0]!), null)
      if (!shown || !shown.mime.startsWith('video/')) return null
      input = path.join(v.vault.layout.media, ...shown.path.split('/'))
      out = path.join(v.vault.layout.cache, 'video', `${shown.sha256}.mp4`)
    } else {
      const s = this.phone(source)
      const a = s.asset(key)
      if (!a || a.cloud) return null
      out = path.join(s.cacheDir, 'video', `${safeName(key)}.mp4`)
      if (fs.existsSync(out)) return { file: out }
      const codec = s.extras(key)?.video?.codec ?? ''
      if (!force && /^(hvc1|hev1|avc1|avc3|dvh1|dvhe)$/i.test(codec)) return { session: s, devicePath: a.path }
      if (!convertNow) {
        const cached = path.join(s.cacheDir, 'originals', a.directory.replace(/[\\/]/g, '_'), a.filename)
        return fs.existsSync(cached) ? { file: cached } : null
      }
      this.setConverting(source, key, 'copying', null)
      const local = await s.localCopy(a.path)
      if (!local) {
        this.setConverting(null)
        return null
      }
      input = local
    }
    if (fs.existsSync(out)) return { file: out }
    try {
      let pr = this.probes.get(input)
      if (!pr) {
        pr = await probe(input)
        this.probes.set(input, pr)
      }
      const plan: Plan = force ? 'transcode' : planFor(pr)
      if (plan === 'direct') return { file: input }
      if (!convertNow) return null
      this.setConverting(source, key, 'converting', 0)
      await convert(plan, input, out, pr.durationSec, (f) => this.setConverting(source, key, 'converting', f))
      return { file: out }
    } finally {
      if (this.converting?.key === key) this.setConverting(null)
    }
  }

  async playback(source: SourceId, key: string, force = false): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const p = await this.playable(source, key, force)
      return p ? { ok: true } : { ok: false, error: 'There is no video file to play.' }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  private storyboardFile(source: SourceId, key: string): string | null {
    const v = this.vaults.get(source)
    if (v) {
      const shown = displayFile(vaultFiles(v.vault.db, key), null)
      return shown ? path.join(v.vault.layout.cache, 'video', `${shown.sha256}-frames.jpg`) : null
    }
    const s = this.registry.get(source.replace(/^device:/, ''))?.session
    return s ? path.join(s.cacheDir, 'video', `${safeName(key)}-frames.jpg`) : null
  }

  /**
   * Scrub-bar previews. Needs the video on local disk: a vault's file, or a
   * phone video once copied or converted. A phone video up to 500 MB is
   * copied in the background for this; bigger ones go without.
   */
  async storyboard(source: SourceId, key: string): Promise<StoryboardInfo | null> {
    const target = this.storyboardFile(source, key)
    if (!target) return null
    let local = await this.playable(source, key, false, false)
    if (local && !('file' in local)) {
      const { session, devicePath } = local
      if ((await session.size(devicePath)) > 500 * 1024 * 1024) return null
      const copied = await session.localCopy(devicePath)
      local = copied ? { file: copied } : null
    }
    if (!local || !('file' in local)) return null
    try {
      const pr = this.probes.get(local.file) ?? (await probe(local.file))
      this.probes.set(local.file, pr)
      if (!pr.durationSec || !pr.video) return null
      const sb = await makeStoryboard(local.file, target, pr.durationSec)
      return { cols: sb.cols, rows: sb.rows, count: sb.count, interval: sb.interval, width: sb.width, height: sb.height }
    } catch (e) {
      console.warn('storyboard:', (e as Error).message)
      return null
    }
  }

  private setConverting(source: SourceId | null, key?: string, stage?: 'copying' | 'converting', progress?: number | null) {
    this.converting = source && key && stage ? { source, key, stage, progress: progress ?? null } : null
    this.publish()
  }

  /** Chromium cannot draw HEIC or DNG. Those become a full-size JPEG, cached. */
  private async displayable(file: string, mime: string, cacheDir: string, id: string) {
    if (mime.startsWith('video/') || mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/gif') {
      return { path: file, mime }
    }
    const out = path.join(cacheDir, `${id}-${IMAGE_CACHE_VERSION}.jpg`)
    if (!fs.existsSync(out)) {
      fs.mkdirSync(cacheDir, { recursive: true })
      let icc: Buffer | null = null
      let img: Sharp
      if (mime === 'image/heic' || mime === 'image/heif') {
        icc = heicProfile(file)
        const d = await this.heic.decode(file)
        img = sharp(d.data, { raw: { width: d.width, height: d.height, channels: 4 } }).removeAlpha()
      } else {
        img = sharp(file, { failOn: 'none' }).rotate()
      }
      const tmp = `${out}.${process.pid}.tmp`
      fs.writeFileSync(tmp, tagJpeg(await img.jpeg({ quality: 90, mozjpeg: false }).toBuffer(), icc))
      fs.renameSync(tmp, out)
    }
    return { path: out, mime: 'image/jpeg' }
  }

  private renderNow(v: VaultEntry, sha: string, file: string, mime: string): Promise<void> {
    let p = this.rendering.get(sha)
    if (!p) {
      p = renderThumbnails(file, mime, sha, v.vault.layout.cache, { heic: this.heic })
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => this.rendering.delete(sha))
      this.rendering.set(sha, p)
    }
    return p
  }

  /* ---------------------------------------------------------------- vaults */

  async openVault(): Promise<SourceId | null> {
    const picked = await this.deps.pickFolder(
      'Choose a vault folder, or an empty folder to make a new vault',
      fs.existsSync(DEFAULT_LIBRARY) ? path.dirname(DEFAULT_LIBRARY) : undefined,
    )
    if (!picked) return null
    return this.openVaultAt(picked)
  }

  /** Open a vault folder, or make one in an empty folder. */
  openVaultAt(picked: string): SourceId {
    for (const v of this.vaults.values()) if (path.resolve(v.vault.layout.root) === path.resolve(picked)) return v.id
    const entry = isVault(picked) ? this.addVault(picked) : canCreateVault(picked) ? this.addVault(picked, true) : null
    if (!entry) throw new NotAVault(picked)
    this.saveVaultList()
    this.publish(true)
    void this.runThumbnails()
    return entry.id
  }

  async closeVault(id: SourceId) {
    const v = this.vaults.get(id)
    if (!v) return
    if (this.editing.has(id)) throw new Error('Wait for the edited copy to finish saving before closing this vault.')
    if (this.save.status === 'running' && this.save.target === v.vault.manifest.name) return
    v.vault.db.close()
    this.vaults.delete(id)
    this.saveVaultList()
    this.publish(true)
  }

  private addVault(root: string, create = false): VaultEntry {
    const vault = create ? createVault(root) : openVault(root)
    const id = `vault:${vault.manifest.id}`
    const entry: VaultEntry = { id, vault, queue: new JobQueue(vault.db), revision: 0 }
    this.vaults.set(id, entry)
    this.backfillPlaces()
    return entry
  }

  /** Reconnecting a phone or opening a vault can supply names old imports lack. */
  private backfillPlaces() {
    for (const device of this.registry.devices) {
      if (device.state !== 'ready' || !device.session) continue
      const session = device.session
      let checked = this.placesChecked.get(session)
      if (!checked) {
        checked = new WeakSet<OpenVault>()
        this.placesChecked.set(session, checked)
      }
      for (const entry of this.vaults.values()) {
        if (checked.has(entry.vault)) continue
        checked.add(entry.vault)
        try {
          if (backfillPlaceNames(entry.vault.db, session)) entry.revision++
        } catch (e) {
          console.warn('place names:', (e as Error).message)
        }
      }
    }
  }

  private vaultInfo(v: VaultEntry): VaultInfo {
    const n = v.vault.db.prepare(`SELECT COUNT(*) AS n FROM asset WHERE deleted_at IS NULL AND hidden = 0`).get() as { n: number }
    return { id: v.id, name: v.vault.manifest.name, root: v.vault.layout.root, count: n.n, kind: v.vault.layout.kind, revision: v.revision }
  }

  /* ------------------------------------------------------------------ save */

  async saveItems(req: SaveRequest) {
    if (this.save.status === 'running') return
    let target: VaultEntry | undefined
    if ('newVault' in req.target) {
      const picked = await this.deps.pickFolder('Choose an empty folder for the new vault')
      if (!picked) return
      if (!canCreateVault(picked) && !isVault(picked)) {
        this.save = { status: 'error', target: path.basename(picked), error: new NotAVault(picked).message }
        this.publish(true)
        return
      }
      target = isVault(picked) ? this.addVault(picked) : this.addVault(picked, true)
      this.saveVaultList()
    } else {
      target = this.vaults.get(req.target.vault)
    }
    if (!target) return
    if (target.id === req.source) {
      this.save = { status: 'error', target: target.vault.manifest.name, error: 'Those items are already in this vault.' }
      this.publish(true)
      return
    }

    const name = target.vault.manifest.name
    const abort = new AbortController()
    this.saveAbort = abort
    this.save = { status: 'running', target: name, itemsDone: 0, itemsTotal: req.keys.length, bytesDone: 0, current: null }
    this.publish(true)
    this.deps.setBusy(true)

    let device: AfcDevice | null = null
    try {
      let items, albums
      const fromVault = this.vaults.get(req.source)
      if (fromVault) {
        items = vaultSaveItems(fromVault.vault.db, fromVault.vault.layout.media, req.keys)
        albums = vaultSaveAlbums(fromVault.vault.db)
      } else {
        const s = this.phone(req.source)
        // Its own connection: the gallery keeps browsing on the other one.
        device = await AfcDevice.attach(s.udid)
        items = await phoneSaveItems(s, device, req.keys, req.framesOnly)
        albums = phoneSaveAlbums(s)
      }
      const result = await saveToVault(target.vault, items, albums, {
        signal: abort.signal,
        metadata: this.metadata,
        onProgress: (p) => {
          this.save = { status: 'running', target: name, ...p }
          this.publish()
        },
      })
      this.save = { status: 'done', target: name, ...result, cancelled: false }
    } catch (e) {
      if (e instanceof SaveCancelled) {
        const s = this.save
        this.save = {
          status: 'done',
          target: name,
          saved: s.status === 'running' ? s.itemsDone : 0,
          alreadyThere: 0,
          skippedCloud: 0,
          failed: [],
          cancelled: true,
        }
      } else {
        this.save = { status: 'error', target: name, error: (e as Error).message }
      }
    } finally {
      target.revision++
      this.saveAbort = null
      this.deps.setBusy(false)
      await device?.dispose().catch(() => {})
      this.publish(true)
    }
    void this.runThumbnails()
  }

  cancelSave() {
    this.saveAbort?.abort()
  }

  dismissSave() {
    if (this.save.status !== 'running') this.save = { status: 'idle' }
    this.publish(true)
  }

  /* --------------------------------------------------------------- changes */

  private editing = new Set<SourceId>()

  async editPreview(source: SourceId, key: string, recipe: EditRecipe): Promise<string> {
    const v = this.editable(source)
    const bytes = await editPreview(vaultEditSource(v.vault, key), recipe, { heic: this.heic })
    return `data:image/jpeg;base64,${bytes.toString('base64')}`
  }

  async saveEditedCopy(source: SourceId, key: string, recipe: EditRecipe): Promise<string> {
    const v = this.editable(source)
    if (this.editing.has(source)) throw new Error('An edited copy is already being saved in this vault.')
    this.editing.add(source)
    this.deps.setBusy(true)
    try {
      const id = await saveEditedCopy(v.vault, key, recipe, { heic: this.heic })
      this.changed(v)
      void this.runThumbnails()
      return id
    } finally {
      this.editing.delete(source)
      this.deps.setBusy(this.editing.size > 0 || this.save.status === 'running')
    }
  }

  private editable(source: SourceId): VaultEntry {
    const v = this.vaults.get(source)
    if (!v) throw new Error("The phone can't be changed from here. Save the items into a vault first.")
    return v
  }

  private changed(v: VaultEntry) {
    v.revision++
    this.publish(true)
  }

  async remove(source: SourceId, keys: string[]): Promise<number> {
    const v = this.editable(source)
    const n = trashAssets(v.vault.db, keys.map(Number))
    this.changed(v)
    return n
  }

  async restore(source: SourceId, keys: string[]): Promise<number> {
    const v = this.editable(source)
    const n = restoreAssets(v.vault.db, keys.map(Number))
    this.changed(v)
    return n
  }

  async deleteForever(source: SourceId, keys: string[]): Promise<{ removed: number; failed: number }> {
    const v = this.editable(source)
    if (this.editing.has(source)) throw new Error('Wait for the edited copy to finish saving before deleting files.')
    const r = await purgeAssets(v.vault.db, v.vault.layout.media, keys.map(Number), this.deps.trash)
    for (const f of r.failed) console.warn(`could not recycle ${f.path}: ${f.reason}`)
    this.changed(v)
    return { removed: r.removed, failed: r.failed.length }
  }

  /** `frameKey` is a burst frame as burstFrames() names it: `<asset>~<file>`. */
  async setBurstCover(source: SourceId, key: string, frameKey: string): Promise<void> {
    const v = this.editable(source)
    if (!frameKey.startsWith(`${key}~`) || !/^\d+~\d+$/.test(frameKey)) throw new Error('That frame is not part of this burst.')
    setBurstCover(v.vault.db, Number(key), Number(frameKey.split('~')[1]))
    this.changed(v)
  }

  /** Keep one frame of a burst as a photo of its own. Returns the new item's key. */
  async keepBurstFrame(source: SourceId, key: string, frameKey: string): Promise<string> {
    const v = this.editable(source)
    if (!frameKey.startsWith(`${key}~`) || !/^\d+~\d+$/.test(frameKey)) throw new Error('That frame is not part of this burst.')
    const id = keepBurstFrame(v.vault.db, Number(key), Number(frameKey.split('~')[1]))
    this.changed(v)
    void this.runThumbnails()
    return String(id)
  }

  async setHidden(source: SourceId, keys: string[], hidden: boolean): Promise<number> {
    return this.setFlag(source, keys, 'hidden', hidden)
  }

  async setFavourite(source: SourceId, keys: string[], favourite: boolean): Promise<number> {
    return this.setFlag(source, keys, 'favourite', favourite)
  }

  private setFlag(source: SourceId, keys: string[], column: 'hidden' | 'favourite', on: boolean): number {
    const v = this.editable(source)
    const run = v.vault.db.prepare(`UPDATE asset SET ${column} = ?, updated_at = ? WHERE id = ?`)
    let n = 0
    v.vault.db.transaction(() => {
      for (const k of keys) n += run.run(on ? 1 : 0, Date.now(), Number(k)).changes
    })()
    this.changed(v)
    return n
  }

  /* ----------------------------------------------------------------- misc */

  async reveal(source: SourceId, key: string) {
    const v = this.vaults.get(source)
    if (v) {
      const f = vaultFiles(v.vault.db, key)[0]
      if (f) this.deps.showInFolder(path.join(v.vault.layout.media, ...f.path.split('/')))
      return
    }
    const local = await this.phone(source).original(key)
    if (local) this.deps.showInFolder(local)
  }

  /** Open the original video in the system player. A phone video is copied off first. */
  async openExternally(source: SourceId, key: string) {
    const v = this.vaults.get(source)
    if (v) {
      const shown = displayFile(vaultFiles(v.vault.db, key), null)
      if (shown) await this.deps.openPath(path.join(v.vault.layout.media, ...shown.path.split('/')))
      return
    }
    const local = await this.phone(source).original(key)
    if (local) await this.deps.openPath(local)
  }

  async openMap(lat: number, lon: number) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
    await this.deps.openExternal(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`)
  }

  async retryDevice(id: SourceId) {
    await this.registry.reopen(id.replace(/^device:/, ''))
    await this.watcher.refresh()
  }

  private phone(source: SourceId): PhoneSession {
    const udid = source.replace(/^device:/, '')
    const s = this.registry.get(udid)?.session
    if (!s) throw new Error('That phone is not connected any more.')
    return s
  }

  /** Thumbnails for every open vault, one vault at a time, newest photos first. */
  private async runThumbnails() {
    if (this.thumbsRunning) return
    this.thumbsRunning = true
    try {
      for (;;) {
        const pending = [...this.vaults.values()].filter((v) => {
          v.queue.recover(THUMBNAIL)
          queueThumbnails(v.vault.db, v.queue, v.vault.layout.cache)
          return v.queue.counts(THUMBNAIL).queued > 0
        })
        if (!pending.length) break
        for (const v of pending) {
          if (!this.vaults.has(v.id)) continue
          const c = v.queue.counts(THUMBNAIL)
          const base = c.done
          const total = c.done + c.queued
          this.thumbs = { done: base, total }
          this.publish()
          await runThumbnails(v.vault.db, v.queue, v.vault.layout.media, v.vault.layout.cache, { heic: this.heic }, {
            concurrency: this.heic.size + 1,
            onSettled: () => {
              if (!this.vaults.has(v.id)) return
              this.thumbs = { done: v.queue.counts(THUMBNAIL).done, total }
              this.publish()
            },
          })
        }
      }
    } catch (e) {
      console.error('thumbnails stopped:', (e as Error).message)
    } finally {
      this.thumbsRunning = false
      this.thumbs = null
      this.publish(true)
    }
  }

  private loadVaultList(): string[] {
    try {
      const s = JSON.parse(fs.readFileSync(this.settingsPath(), 'utf8')) as { vaults?: string[] }
      if (Array.isArray(s.vaults)) return s.vaults.filter((p) => fs.existsSync(p))
    } catch {
      /* first run */
    }
    // First run: open the library the import made, if there is one.
    return isVault(DEFAULT_LIBRARY) ? [DEFAULT_LIBRARY] : []
  }

  private saveVaultList() {
    fs.mkdirSync(this.deps.userData, { recursive: true })
    fs.writeFileSync(
      this.settingsPath(),
      JSON.stringify({ vaults: [...this.vaults.values()].map((v) => v.vault.layout.root) }, null, 2),
    )
  }

  private settingsPath() {
    return path.join(this.deps.userData, 'gallery.json')
  }

  private publish(now = false) {
    if (now) {
      if (this.publishTimer) clearTimeout(this.publishTimer)
      this.publishTimer = null
      this.deps.publish(this.snapshot())
      return
    }
    if (this.publishTimer) return
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null
      this.deps.publish(this.snapshot())
    }, 150)
  }
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]/g, '_')
}

function videoMime(file: string): string {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.webm' || ext === '.mkv') return 'video/webm'
  if (ext === '.ogv' || ext === '.ogg') return 'video/ogg'
  return 'video/mp4'
}
