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
import { phoneProbeItems, phoneSaveAlbums, phoneSaveItems, vaultSaveAlbums, vaultSaveItems } from '../../src/gallery/save-sources.ts'
import { backfillPlaceNames } from '../../src/gallery/place-backfill.ts'
import type { Collections, GalleryItem, ItemDetail } from '../../src/gallery/types.ts'
import { createVault, isVault, canCreateVault, openVault, NotAVault, type OpenVault } from '../../src/vault/vault.ts'
import { existingInVault, saveToVault, SaveCancelled } from '../../src/vault/save.ts'
import { purgeAssets, restoreAssets, trashAssets } from '../../src/vault/delete.ts'
import { keepBurstFrame, setBurstCover } from '../../src/vault/burst.ts'
import type { KeyObject } from 'node:crypto'
import {
  openProtected,
  privacyWork,
  privateDir,
  protectAsset,
  publicKeyOf,
  readKeyFile,
  releaseAsset,
  setUpProtection,
  sweepPrivate,
  finishPrivateCleanup,
  writeKeyFile,
} from '../../src/vault/private.ts'
import { changePasscode, unlockVaultKey, type VaultKeyFile } from '../../src/vault/private-crypto.ts'
import { profileFromHead, tagWebp } from '../../src/thumbs/colour.ts'
import { SIZES } from '../../src/thumbs/render.ts'
import { saveEditedCopy, vaultEditSource } from '../../src/vault/edit.ts'
import { editPreview } from '../../src/media/edit.ts'
import type { EditRecipe } from '../../src/media/edit-recipe.ts'
import { convert, planFor, probe, storyboard as makeStoryboard, type Plan, type Probe } from '../../src/media/playback.ts'
import type { ByteSource } from '../../src/media/ranges.ts'
import { sameVaultName, type AppState, type SaveRequest, type SaveState, type SourceId, type StoryboardInfo, type VaultDetails, type VaultInfo } from '../shared/api.ts'
import type { AppSettings } from '../shared/settings.ts'
import { SettingsStore } from './settings.ts'
import { folderBytes, validateVaultDeletion } from '../../src/vault/manage.ts'
import { cleanupSavedPhone } from '../../src/gallery/run-phone-cleanup.ts'
import { wpdInventory, wpdHashObject, wpdDeleteVerified } from '../../src/device/wpd.ts'
import { checkCleanupDecode } from '../../src/verify/cleanup-decode.ts'
import type { DeviceSource } from '../../src/device/types.ts'
import type { SaveItem } from '../../src/vault/save.ts'

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
  /** This drive's Recycle Bin limit in bytes, and whether it deletes outright. Null if unknown. */
  recycleBinLimit: (dir: string) => Promise<{ maxBytes: number; nukeOnDelete: boolean } | null>
  setBusy: (busy: boolean) => void
}

interface VaultEntry {
  id: SourceId
  vault: OpenVault
  queue: JobQueue
  revision: number
  /** Hidden and Recently Deleted: the key pair's public half, if protection is on. */
  keyFile: VaultKeyFile | null
  /** In memory only, while unlocked. Never written anywhere. */
  privateKey: KeyObject | null
  /** Protect and release work, one at a time per vault. */
  privacy: Promise<void>
  privacyError: string | null
  generation: number
}

/** Errors the window recognises and answers with the right dialog. */
const NEEDS_PROTECTION = 'PROTECTION_NEEDED: Set a passcode for Hidden and Recently Deleted first.'
const NEEDS_UNLOCK = 'LOCKED: Unlock Hidden and Recently Deleted first.'

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
  private thumbnailRun: Promise<void> | null = null
  private stopping = false
  private readonly rendering = new Map<string, Promise<void>>()
  private publishTimer: NodeJS.Timeout | null = null
  private converting: AppState['converting'] = null
  private readonly probes = new Map<string, Probe>()
  private readonly placesChecked = new WeakMap<PhoneSession, WeakSet<OpenVault>>()
  private readonly savingVaults = new Set<SourceId>()
  /** Vaults being closed: the thumbnail run leaves them alone. */
  private readonly closingVaults = new Set<SourceId>()
  /** The thumbnail drain working on a vault now, so closing it can stop just that one. */
  private readonly thumbDrains = new Map<SourceId, { abort: AbortController; done: Promise<void> }>()

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
      this.forgetPhonePrivate()
      this.publish(true)
    })
    this.watcher.on('change', () => this.publish())
    this.registry.start()
    this.watcher.start()
    this.publish(true)
    void this.runThumbnails()
  }

  async stop() {
    this.stopping = true
    this.saveAbort?.abort()
    this.watcher.stop()
    await this.registry.stop()
    await this.thumbnailRun?.catch(() => {})
    await Promise.all([...this.rendering.values()].map(job => job.catch(() => {})))
    await Promise.all([...this.vaults.values()].map(v => v.privacy.catch(() => {})))
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
    const pv = this.vaults.get(source)
    if (pv) {
      const privacy = pv.vault.db.prepare(`SELECT hidden, deleted_at FROM asset WHERE id = ?`).get(Number(key.split('~')[0])) as {hidden:number;deleted_at:number|null}|undefined
      if (privacy && (privacy.hidden || privacy.deleted_at !== null)) {
        if (!pv.privateKey) return null
        await pv.privacy
        const files = vaultFiles(pv.vault.db, key.split('~')[0]!)
        if (!files.length || files.some(f => !f.encryptedPath)) return null
        return this.protectedMedia(pv, files, what, key)
      }
      const files = vaultFiles(pv.vault.db, key.split('~')[0]!)
      if (files.some((f) => f.encryptedPath)) return this.protectedMedia(pv, files, what, key)
    } else {
      const s = this.registry.get(source.replace(/^device:/, ''))?.session
      if (s?.isPrivate(key)) return this.phonePrivateMedia(s, what, key)
    }
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
      if (this.privateItem(v, assetKey!)) return null
      return fs.existsSync(p) ? { path: p, mime: 'image/webp' } : null
    }
    if (what === 'motion') {
      const m = files.find((f) => f.role === 'motion')
      return m ? { path: abs(m.path), mime: m.mime === 'video/quicktime' ? 'video/mp4' : m.mime } : null
    }
    const rendered = await this.displayable(abs(shown.path), shown.mime, path.join(v.vault.layout.cache, 'full'), shown.sha256)
    if (this.privateItem(v, assetKey!)) {
      if (rendered.path.startsWith(path.resolve(v.vault.layout.cache) + path.sep)) fs.rmSync(rendered.path, {force:true})
      return null
    }
    return rendered
  }

  private privateItem(v: VaultEntry, key: string): boolean {
    const row = v.vault.db.prepare('SELECT hidden, deleted_at FROM asset WHERE id=?').get(Number(key)) as {hidden:number;deleted_at:number|null}|undefined
    return !row || !!row.hidden || row.deleted_at !== null
  }

  /** Decrypted pictures and their thumbnails, in memory only, while unlocked. */
  private readonly privateCache = new Map<string, Buffer>()

  /**
   * A hidden or deleted item, shown only while its vault is unlocked, and
   * never written to disk in the clear: thumbnails and full-size pictures are
   * made in memory; videos stream from the encrypted copy.
   */
  private async protectedMedia(
    v: VaultEntry,
    files: ReturnType<typeof vaultFiles>,
    what: string,
    key: string,
  ): Promise<{ source: ByteSource; mime: string } | null> {
    if (!v.privateKey || what === 'storyboard') return null
    const fileId = key.split('~')[1]
    const shown = displayFile(files, fileId ? Number(fileId) : null)
    const pick = what === 'motion' ? files.find((f) => f.role === 'motion') : what === 'video' ? shown : shown
    if (!pick?.encryptedPath) return null
    const privateKey = v.privateKey
    const generation = v.generation
    const authorized = () => v.privateKey === privateKey && v.generation === generation && this.vaults.get(v.id) === v
    const reader = openProtected(v.vault.layout, pick.encryptedPath, privateKey)
    if (what === 'video' || what === 'motion') {
      const size = reader.size
      reader.close()
      return { source: { size, read: async (start, length) => {
        if (!authorized()) throw new Error('Vault is locked.')
        const range = openProtected(v.vault.layout, pick.encryptedPath!, privateKey)
        try { const bytes = await range.read(start, length); if (!authorized()) throw new Error('Vault is locked.'); return bytes }
        finally { range.close() }
      } }, mime: pick.mime === 'video/quicktime' ? 'video/mp4' : pick.mime }
    }
    if (pick.mime.startsWith('video/')) {
      reader.close()
      return null // no thumbnail for a protected video: making one would need the file on disk
    }
    const cacheKey = `${v.id}|${pick.sha256}|${what}`
    let out = this.privateCache.get(cacheKey)
    if (!out) {
      let plain: Buffer
      try { plain = await reader.read(0, reader.size) } finally { reader.close() }
      out = await renderInMemory(plain, pick.mime, what, this.heic)
      if (!authorized()) return null
      this.privateCache.set(cacheKey, out)
      // Keep memory bounded: drop the oldest beyond a few hundred pictures.
      while (this.privateCache.size > 400) this.privateCache.delete(this.privateCache.keys().next().value!)
    } else reader.close()
    const body = out
    return { source: { size: body.length, read: async (s, n) => { if (!authorized()) throw new Error('Vault is locked.'); return body.subarray(s, s + n) } }, mime: what === 'full' ? 'image/jpeg' : 'image/webp' }
  }

  /**
   * An item in the phone's Hidden album or Recently Deleted: shown like any
   * other, but never written to Theia's cache. Pictures are made in memory;
   * videos stream from the phone.
   */
  private async phonePrivateMedia(s: PhoneSession, what: string, key: string): Promise<{ source: ByteSource; mime: string } | null> {
    const a = s.asset(key)
    if (!a || what === 'storyboard') return null
    if (what === 'video' || what === 'motion') {
      const p =
        what === 'motion' ? s.filesFor(key).find((f) => /\.mov$/i.test(f) && path.posix.basename(f) !== a.filename) : a.path
      if (!p) return null
      const size = await s.size(p)
      return { source: { size, read: (start, length) => s.readRange(p, start, length) }, mime: 'video/mp4' }
    }
    const cacheKey = `${s.udid}|${key}|${what}`
    let out = this.privateCache.get(cacheKey)
    if (!out) {
      if (what === 'sm' || what === 'ph') {
        const preview = await s.previewBytes(key)
        if (preview) out = await renderInMemory(preview, 'image/jpeg', what, this.heic)
      }
      if (!out) {
        if (a.kind === 'video') return null
        const shown = await s.displayBytes(key)
        if (!shown) return null
        out = await renderInMemory(shown.data, mimeOf(shown.name), what, this.heic)
      }
      this.privateCache.set(cacheKey, out)
      while (this.privateCache.size > 400) this.privateCache.delete(this.privateCache.keys().next().value!)
    }
    const body = out
    return { source: { size: body.length, read: async (st, n) => body.subarray(st, st + n) }, mime: what === 'full' ? 'image/jpeg' : 'image/webp' }
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
    // Private items play straight from where they are, never from a copy.
    const pv = this.vaults.get(source)
    if (pv && vaultFiles(pv.vault.db, key).some((f) => f.encryptedPath)) {
      return pv.privateKey ? { ok: true } : { ok: false, error: 'Unlock Hidden and Recently Deleted to play this.' }
    }
    const ps = pv ? null : this.registry.get(source.replace(/^device:/, ''))?.session
    if (ps?.isPrivate(key)) {
      const codec = ps.extras(key)?.video?.codec ?? ''
      return /^(hvc1|hev1|avc1|avc3|dvh1|dvhe)$/i.test(codec) || !codec
        ? { ok: true }
        : { ok: false, error: "This video is in your iPhone's Hidden album or Recently Deleted. Theia only plays those straight from the phone, and this format would need a converted copy." }
    }
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
    // Previews need a copy on disk; private items get none.
    const pv = this.vaults.get(source)
    if (pv && vaultFiles(pv.vault.db, key).some((f) => f.encryptedPath)) return null
    if (!pv && this.registry.get(source.replace(/^device:/, ''))?.session?.isPrivate(key)) return null
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
    const renderingKey = `${v.id}:${sha}`
    let p = this.rendering.get(renderingKey)
    if (!p) {
      p = renderThumbnails(file, mime, sha, v.vault.layout.cache, { heic: this.heic })
        .then(() => {
          const visible = v.vault.db.prepare(`SELECT 1 FROM file f JOIN asset a ON a.id=f.asset_id WHERE f.sha256=? AND a.hidden=0 AND a.deleted_at IS NULL AND f.encrypted_path IS NULL LIMIT 1`).get(sha)
          if (!visible) for (const size of Object.keys(SIZES) as ThumbSize[]) fs.rmSync(thumbPath(v.vault.layout.cache,sha,size),{force:true})
        })
        .catch(() => undefined)
        .finally(() => this.rendering.delete(renderingKey))
      this.rendering.set(renderingKey, p)
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
    if (this.savingVaults.has(id)) throw new Error('Wait for saving to finish before closing this vault.')
    // Stop this vault's thumbnails and wait for the few in flight, not for
    // every other vault's queue: a big library can take an hour to finish.
    this.closingVaults.add(id)
    try {
      const drain = this.thumbDrains.get(id)
      drain?.abort.abort()
      await drain?.done.catch(() => {})
      await v.privacy.catch(() => {})
      await Promise.all([...this.rendering.entries()].filter(([key]) => key.startsWith(`${id}:`)).map(([,job]) => job.catch(() => {})))
    } finally {
      this.closingVaults.delete(id)
    }
    this.lockVault(id)
    v.vault.db.close()
    this.vaults.delete(id)
    this.saveVaultList()
    this.publish(true)
  }

  async vaultDetails(id: SourceId): Promise<VaultDetails> {
    const v = this.vaults.get(id)
    if (!v) throw new Error('That vault is not open.')
    const root = v.vault.layout.root
    const [bytes, limit] = await Promise.all([folderBytes(root), this.deps.recycleBinLimit(root).catch(() => null)])
    return {
      ...this.vaultInfo(v),
      bytes,
      fitsRecycleBin: limit ? !limit.nukeOnDelete && bytes <= limit.maxBytes : null,
      recycleBinMax: limit?.maxBytes ?? null,
    }
  }

  async revealVault(id: SourceId) {
    const v = this.vaults.get(id)
    if (v) await this.deps.openPath(v.vault.layout.root)
  }

  async deleteVault(id: SourceId, confirmName: string, mode: 'recycle' | 'permanent') {
    const v = this.vaults.get(id)
    if (!v) throw new Error('That vault is not open.')
    const name = v.vault.manifest.name
    if (!sameVaultName(confirmName, name)) throw new Error(`Type the vault's name, ${name}, to delete it.`)
    if (!['recycle', 'permanent'].includes(mode)) throw new Error('Choose how to delete this vault.')
    if (this.editing.has(id) || this.savingVaults.has(id)) {
      throw new Error('Wait for the save into this vault to finish first.')
    }
    const otherRoots = [...this.vaults.values()].filter(other => other.id !== id).map(other => other.vault.layout.root)
    const root = validateVaultDeletion(v.vault, otherRoots, [this.deps.userData])
    if (mode === 'recycle') {
      const d = await this.vaultDetails(id)
      if (d.fitsRecycleBin !== true) {
        throw new Error("This vault is too big for the Recycle Bin, so Windows would delete it for good. Choose Delete permanently if that's what you want.")
      }
    }
    // Let go of it first: the database file is open while the vault is.
    await this.closeVault(id)
    try {
      validateVaultDeletion(v.vault, [...this.vaults.values()].map(other => other.vault.layout.root), [this.deps.userData])
      if (mode === 'recycle') {
        await this.deps.trash(root)
        if (fs.existsSync(root)) throw new Error(`Windows did not move ${root} to the Recycle Bin. Nothing was deleted.`)
      } else {
        fs.rmSync(root, { recursive: true, force: true })
      }
    } catch (e) {
      // Still there: open it again, so it doesn't vanish from Theia while its files stay.
      if (isVault(root)) {
        try {
          this.addVault(root)
          this.saveVaultList()
        } catch (again) {
          console.error(`could not reopen ${root}:`, (again as Error).message)
        }
      }
      this.publish(true)
      throw e
    }
    this.publish(true)
  }

  private addVault(root: string, create = false): VaultEntry {
    const vault = create ? createVault(root) : openVault(root)
    const id = `vault:${vault.manifest.id}`
    const entry: VaultEntry = {
      id,
      vault,
      queue: new JobQueue(vault.db),
      revision: 0,
      keyFile: readKeyFile(vault.layout),
      privateKey: null,
      privacy: Promise.resolve(),
      privacyError: null,
      generation: 0,
    }
    entry.queue.retryFailed(THUMBNAIL)
    this.vaults.set(id, entry)
    // Finish anything a crash interrupted, then protect whatever is hidden or
    // deleted and isn't yet (an item hidden before protection was set up).
    try {
      const swept = sweepPrivate(vault)
      if (swept.missing.length) console.warn(`vault ${vault.manifest.name}: encrypted copies missing for ${swept.missing.join(', ')}`)
    } catch (e) {
      console.warn('private sweep:', (e as Error).message)
    }
    void this.applyPrivacy(entry).catch(e => console.warn('Vault protection:', (e as Error).message))
    this.backfillPlaces()
    return entry
  }

  private readonly privateForgotten = new WeakSet<PhoneSession>()

  /** Once per phone session: remove cached copies of its Hidden and Recently Deleted items. */
  private forgetPhonePrivate() {
    for (const d of this.registry.devices) {
      const s = d.session
      if (d.state !== 'ready' || !s || this.privateForgotten.has(s)) continue
      this.privateForgotten.add(s)
      try {
        const n = s.forgetPrivate()
        if (n) console.log(`removed ${n} cached copies of private phone items`)
      } catch (e) {
        console.warn('forget private:', (e as Error).message)
      }
    }
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
    return {
      id: v.id,
      name: v.vault.manifest.name,
      root: v.vault.layout.root,
      count: n.n,
      kind: v.vault.layout.kind,
      revision: v.revision,
      protection: !v.keyFile ? 'off' : v.privateKey ? 'unlocked' : 'locked',
      protectionError: v.privacyError,
    }
  }

  /* ------------------------------------------------------------------ save */

  /** How many of the items the target vault already has, so the window can ask: skip or replace. */
  countDuplicates(req: SaveRequest): number {
    if (!('vault' in req.target)) return 0
    const target = this.vaults.get(req.target.vault)
    if (!target || target.id === req.source) return 0
    const fromVault = this.vaults.get(req.source)
    const items = fromVault
      ? vaultSaveItems(fromVault.vault.db, fromVault.vault.layout.media, req.keys)
      : phoneProbeItems(this.phone(req.source), req.keys, req.framesOnly)
    return existingInVault(target.vault.db, items).size
  }

  async saveItems(req: SaveRequest) {
    if (this.save.status === 'running') return
    if (req.deleteAfterSave && (!req.source.startsWith('device:') || req.framesOnly)) throw new Error('Delete after save is available only for complete iPhone items, not individual burst frames or vault copies.')
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
    this.savingVaults.add(target.id)
    if (this.vaults.has(req.source)) this.savingVaults.add(req.source)
    const abort = new AbortController()
    this.saveAbort = abort
    this.save = { status: 'running', target: name, itemsDone: 0, itemsTotal: req.keys.length, bytesDone: 0, current: null }
    this.publish(true)
    this.deps.setBusy(true)

    let device: AfcDevice | null = null
    let phoneSession: PhoneSession | null = null
    const previousSync = target.vault.db.pragma('synchronous', { simple: true }) as number
    try {
      if (req.deleteAfterSave) target.vault.db.pragma('synchronous = FULL')
      let items, albums
      const fromVault = this.vaults.get(req.source)
      if (fromVault) {
        const key = fromVault.privateKey
        items = vaultSaveItems(fromVault.vault.db, fromVault.vault.layout.media, req.keys, key ? (p) => decryptStream(fromVault.vault.layout, p, key) : undefined)
        albums = vaultSaveAlbums(fromVault.vault.db)
      } else {
        const s = this.phone(req.source)
        phoneSession = s
        if (req.deleteAfterSave) await s.load()
        // Its own connection: the gallery keeps browsing on the other one.
        device = await AfcDevice.attach(s.udid)
        items = await phoneSaveItems(s, device, req.keys, req.framesOnly)
        albums = phoneSaveAlbums(s)
      }
      const vault = target.vault
      const result = await saveToVault(vault, items, albums, {
        signal: abort.signal,
        metadata: this.metadata,
        duplicates: req.duplicates,
        // The old copy goes to the Windows Recycle Bin, every file of it, so a
        // replace can still be undone outside the app.
        replace: async (id) => {
          trashAssets(vault.db, [id])
          const r = await purgeAssets(vault.db, vault.layout.media, [id], this.deps.trash, privateDir(vault.layout))
          if (!r.removed) {
            restoreAssets(vault.db, [id])
            throw new Error(r.failed[0]?.reason ?? 'it could not go to the Recycle Bin')
          }
        },
        onProgress: (p) => {
          this.save = { status: 'running', target: name, ...p }
          this.publish()
        },
      })
      // A replaced hidden item stays hidden; its new copy is encrypted like the old one was.
      if (result.replaced) await this.applyPrivacy(target).catch((e) => console.warn('privacy after replace:', (e as Error).message))
      let cleanup: Extract<SaveState,{status:'done'}>['cleanup']
      if (req.deleteAfterSave && phoneSession && device) {
        const session = phoneSession
        const checkpoint = target.vault.db.pragma('wal_checkpoint(FULL)') as {busy:number}[]
        if (checkpoint[0]?.busy) throw new Error('Saved copies are present, but the vault database could not be flushed. Nothing was deleted from iPhone.')
        try {
          await session.load()
          cleanup = await cleanupSavedPhone(target.vault, session.udid, device, items, result.assets, {
            inventory: wpdInventory, hash: wpdHashObject, remove: wpdDeleteVerified,
            decode: (file, mime) => checkCleanupDecode(file, mime, this.heic, abort.signal),
            paths: item => currentPhonePaths(session, device!, item), signal: abort.signal,
            progress: (phase, current) => {
              this.save = {status:'running',target:name,itemsDone:result.saved + result.alreadyThere,itemsTotal:items.length,
                bytesDone:result.bytes,current,phase,etaMs:null}
              this.publish(true)
            },
          })
          if (cleanup.deleted) {
            try { await this.registry.reopen(session.udid) }
            catch (e) { cleanup.reasons.push({item:'iPhone library refresh',reason:(e as Error).message}) }
          }
        } catch (e) {
          cleanup = {deleted:0,kept:items.length,reasons:[{item:'iPhone cleanup',reason:(e as Error).message}]}
        }
      }
      this.save = { status: 'done', target: name, ...result, cancelled: abort.signal.aborted, cleanup }
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
      target.vault.db.pragma(`synchronous = ${previousSync}`)
      this.savingVaults.delete(target.id)
      this.savingVaults.delete(req.source)
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
    this.notProtected(v, key)
    const bytes = await editPreview(vaultEditSource(v.vault, key), recipe, { heic: this.heic })
    return `data:image/jpeg;base64,${bytes.toString('base64')}`
  }

  async saveEditedCopy(source: SourceId, key: string, recipe: EditRecipe): Promise<string> {
    const v = this.editable(source)
    this.notProtected(v, key)
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

  private notProtected(v: VaultEntry, key: string) {
    if (vaultFiles(v.vault.db, key).some((f) => f.encryptedPath)) throw new Error('Unhide or recover this item to edit it.')
  }

  private editable(source: SourceId): VaultEntry {
    const v = this.vaults.get(source)
    if (!v) throw new Error("The phone can't be changed from here. Save the items into a vault first.")
    if (this.savingVaults.has(source)) throw new Error('Wait for saving to finish before changing this vault.')
    if (this.converting?.source === source) throw new Error('Wait for the video preview to finish before changing this vault.')
    return v
  }

  private changed(v: VaultEntry) {
    v.revision++
    this.publish(true)
  }

  async remove(source: SourceId, keys: string[]): Promise<number> {
    const v = this.editable(source)
    if (!v.keyFile) throw new Error(NEEDS_PROTECTION)
    const n = trashAssets(v.vault.db, keys.map(Number))
    this.changed(v)
    await this.applyPrivacy(v)
    return n
  }

  async restore(source: SourceId, keys: string[]): Promise<number> {
    const v = this.editable(source)
    // Decrypt and verify first, and only then bring the item back, so a failed
    // restore leaves it safely in Recently Deleted.
    await this.release(v, keys.map(Number).filter((id) => !this.flag(v, id, 'hidden')))
    const n = restoreAssets(v.vault.db, keys.map(Number))
    this.changed(v)
    return n
  }

  async deleteForever(source: SourceId, keys: string[]): Promise<{ removed: number; failed: number }> {
    const v = this.editable(source)
    if (this.editing.has(source)) throw new Error('Wait for the edited copy to finish saving before deleting files.')
    const r = await purgeAssets(v.vault.db, v.vault.layout.media, keys.map(Number), this.deps.trash, privateDir(v.vault.layout))
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
    const v = this.editable(source)
    if (hidden) {
      if (!v.keyFile) throw new Error(NEEDS_PROTECTION)
      const n = this.setFlag(source, keys, 'hidden', true)
      await this.applyPrivacy(v)
      return n
    }
    await this.release(v, keys.map(Number).filter((id) => !this.flag(v, id, 'deleted')))
    return this.setFlag(source, keys, 'hidden', false)
  }

  /* ------------------------------------------------------------ protection */

  /** Turn on protection for a vault. Returns the recovery key, to show once. */
  async setUpProtection(id: SourceId, passcode: string): Promise<string> {
    const v = this.vaults.get(id)
    if (!v) throw new Error('That vault is not open.')
    const { recoveryKey, privateKey } = setUpProtection(v.vault.layout, passcode)
    v.keyFile = readKeyFile(v.vault.layout)
    v.privateKey = privateKey
    this.changed(v)
    await this.applyPrivacy(v)
    return recoveryKey
  }

  async unlockVault(id: SourceId, secret: string): Promise<void> {
    const v = this.vaults.get(id)
    if (!v?.keyFile) throw new Error('This vault has no passcode.')
    v.privateKey = unlockVaultKey(v.keyFile, secret)
    this.changed(v)
    await this.applyPrivacy(v)
  }

  lockVault(id: SourceId) {
    const v = this.vaults.get(id)
    if (!v) return
    v.privateKey = null
    v.generation++
    for (const k of [...this.privateCache.keys()]) if (k.startsWith(`${id}|`)) this.privateCache.delete(k)
    this.changed(v)
  }

  /** Windows locked or went to sleep: lock every vault. */
  lockAll() {
    for (const v of this.vaults.values()) if (v.privateKey) this.lockVault(v.id)
  }

  async changeVaultPasscode(id: SourceId, current: string, next: string): Promise<void> {
    const v = this.vaults.get(id)
    if (!v?.keyFile) throw new Error('This vault has no passcode.')
    if (next.length < 6) throw new Error('Use a passcode of at least 6 characters.')
    const file = changePasscode(v.keyFile, current, next)
    writeKeyFile(v.vault.layout, file)
    v.keyFile = file
  }

  private flag(v: VaultEntry, id: number, which: 'hidden' | 'deleted'): boolean {
    const r = v.vault.db.prepare(`SELECT hidden, deleted_at FROM asset WHERE id = ?`).get(id) as { hidden: number; deleted_at: number | null } | undefined
    return which === 'hidden' ? r?.hidden === 1 : r?.deleted_at != null
  }

  /** Decrypt these items back into the vault. Needs the vault unlocked if any is encrypted. */
  private async release(v: VaultEntry, ids: number[]) {
    const encrypted = ids.filter((id) => v.vault.db.prepare(`SELECT 1 FROM file WHERE asset_id = ? AND encrypted_path IS NOT NULL`).get(id))
    if (!encrypted.length) return
    if (!v.privateKey) throw new Error(NEEDS_UNLOCK)
    const key = v.privateKey
    await (v.privacy = v.privacy.catch(() => {}).then(async () => {
      for (const id of encrypted) await releaseAsset(v.vault, id, key)
    }))
    void this.runThumbnails()
  }

  /**
   * Bring the vault in line: encrypt what is hidden or deleted and isn't yet;
   * decrypt what is neither and still encrypted (only while unlocked).
   */
  private applyPrivacy(v: VaultEntry): Promise<void> {
    v.privacy = v.privacy.catch(() => {}).then(async () => {
      if (!v.keyFile || !this.vaults.has(v.id)) return
      const work = privacyWork(v.vault.db)
      const pub = publicKeyOf(v.keyFile)
      let changed = false
      const errors: string[] = []
      v.privacyError = null
      for (const id of work.protect) {
        try {
          await protectAsset(v.vault, id, pub)
          changed = true
        } catch (e) {
          errors.push(`Could not encrypt item ${id}: ${(e as Error).message}`)
        }
      }
      if (v.privateKey) {
        for (const id of work.release) {
          try {
            await releaseAsset(v.vault, id, v.privateKey)
            changed = true
          } catch (e) {
            errors.push(`Could not restore item ${id}: ${(e as Error).message}`)
          }
        }
      }
      if (v.privateKey) {
        try { await finishPrivateCleanup(v.vault, v.privateKey) } catch (e) { errors.push((e as Error).message) }
      }
      v.privacyError = errors.length ? errors.join(' ') : null
      if (changed) this.changed(v)
      if (errors.length) { this.changed(v); throw new Error(v.privacyError!) }
    })
    return v.privacy
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
      if (f?.encryptedPath) throw new Error('This item is encrypted, so there is no file to show. Unhide or recover it first.')
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
  private runThumbnails(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (this.thumbnailRun) return this.thumbnailRun
    this.thumbnailRun = this.runThumbnailsImpl().finally(() => { this.thumbnailRun = null })
    return this.thumbnailRun
  }

  private async runThumbnailsImpl() {
    if (this.thumbsRunning || this.stopping) return
    this.thumbsRunning = true
    try {
      for (; !this.stopping;) {
        const pending = [...this.vaults.values()].filter((v) => {
          if (this.closingVaults.has(v.id)) return false
          v.queue.recover(THUMBNAIL)
          queueThumbnails(v.vault.db, v.queue, v.vault.layout.cache)
          return v.queue.counts(THUMBNAIL).queued > 0
        })
        if (!pending.length) break
        for (const v of pending) {
          if (!this.vaults.has(v.id) || this.closingVaults.has(v.id)) continue
          const c = v.queue.counts(THUMBNAIL)
          const base = c.done
          const total = c.done + c.queued
          this.thumbs = { done: base, total }
          this.publish()
          const abort = new AbortController()
          const done = runThumbnails(v.vault.db, v.queue, v.vault.layout.media, v.vault.layout.cache, { heic: this.heic }, {
            concurrency: this.heic.size + 1,
            signal: abort.signal,
            onSettled: () => {
              if (!this.vaults.has(v.id)) return
              this.thumbs = { done: v.queue.counts(THUMBNAIL).done, total }
              this.publish()
            },
          })
          this.thumbDrains.set(v.id, { abort, done })
          try {
            await done
          } finally {
            this.thumbDrains.delete(v.id)
          }
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

/** Read the current companion-file list, never a cached DCIM listing. */
async function currentPhonePaths(session: PhoneSession, device: DeviceSource, item: SaveItem): Promise<string[]> {
  const asset = session.asset(item.key)
  if (!asset || asset.cloud || asset.kind !== item.kind) throw new Error('The iPhone item changed or became unavailable after saving.')
  const frameKeys = asset.kind === 'burst' && asset.burstId ? session.library.bursts.get(asset.burstId) ?? [asset.key] : [asset.key]
  const paths = new Set<string>()
  for (const key of frameKeys) {
    const frame = session.asset(key)
    if (!frame || frame.cloud) throw new Error('A burst frame became unavailable after saving.')
    const dir = path.posix.dirname(frame.path)
    const stem = path.posix.basename(frame.filename, path.posix.extname(frame.filename))
    const match = /^([A-Za-z]+_)(\d+)$/.exec(stem)
    const stems = new Set([stem.toLowerCase(), ...(match ? [`${match[1]}E${match[2]}`.toLowerCase()] : [])])
    for (const name of await device.list(dir)) if (stems.has(path.posix.basename(name, path.posix.extname(name)).toLowerCase())) paths.add(`${dir}/${name}`)
  }
  return [...paths]
}

/** Bytes in a folder and everything under it. */
async function folderSize(dir: string): Promise<number> {
  let total = 0
  const walk = async (d: string) => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) total += (await fs.promises.stat(p).catch(() => ({ size: 0 }))).size
    }
  }
  await walk(dir)
  return total
}

/** A protected file as a stream of plaintext chunks, decrypted as it is read. */
async function* decryptStream(layout: OpenVault['layout'], encryptedPath: string, key: KeyObject): AsyncIterable<Buffer> {
  const r = openProtected(layout, encryptedPath, key)
  try {
    for (let pos = 0; pos < r.size; pos += 4 * 1024 * 1024) yield await r.read(pos, 4 * 1024 * 1024)
  } finally {
    r.close()
  }
}

/** A thumbnail (WebP) or full-size picture (JPEG) from decrypted bytes, without touching disk. */
async function renderInMemory(plain: Buffer, mime: string, what: string, heic: HeicPool): Promise<Buffer> {
  let img: Sharp
  let icc: Buffer | null = null
  if (mime === 'image/heic' || mime === 'image/heif') {
    const d = await heic.decodeBuffer(plain)
    img = sharp(d.data, { raw: { width: d.width, height: d.height, channels: 4 } }).removeAlpha()
    icc = profileFromHead(plain.subarray(0, 512 * 1024))
  } else {
    img = sharp(plain, { failOn: 'none' }).rotate()
  }
  if (what === 'full') return tagJpeg(await img.jpeg({ quality: 90 }).toBuffer(), icc)
  const spec = SIZES[what as keyof typeof SIZES] ?? SIZES.sm
  let t = img.resize(spec.edge, spec.edge, { fit: 'inside', withoutEnlargement: true })
  if (what === 'ph') t = t.blur(1.2)
  return tagWebp(await t.webp({ quality: spec.quality }).toBuffer(), icc)
}
