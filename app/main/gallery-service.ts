import { heicProfile, tagJpeg, IMAGE_CACHE_VERSION } from '../../src/thumbs/colour.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp, { type Sharp } from 'sharp'
import { AfcDevice } from '../../src/device/afc-device.ts'
import { DeviceRegistry, listenUsb, listUsb } from '../../src/device/registry.ts'
import { AndroidPhones, isAndroidId } from '../../src/device/mtp-device.ts'
import { DeviceWatcher } from '../../src/device/watcher.ts'
import { HeicPool } from '../../src/thumbs/heic-pool.ts'
import { ExifToolReader } from '../../src/metadata/reader.ts'
import { JobQueue } from '../../src/jobs/queue.ts'
import { openSource, renderThumbnails, thumbPath, type ThumbSize } from '../../src/thumbs/render.ts'
import { requeueMissingThumbnails, runThumbnails, THUMBNAIL } from '../../src/thumbs/jobs.ts'
import { RenderHost, type ChildLike } from '../../src/thumbs/render-host.ts'
import { NoPhotoFoldersError, PhoneSession, mimeOf } from '../../src/gallery/phone-session.ts'
import { displayFile, hiddenFolders, vaultCollections, vaultDetail, vaultFiles, vaultItems, vaultItemsByIds } from '../../src/gallery/vault-gallery.ts'
import { Embedder } from '../../src/search/embedder.ts'
import { forgetSearchData, indexProgress, queueSearchJobs, retryMissingThumbnailJobs, runSearchJobs, searchVault } from '../../src/search/index.ts'
import { deepProgress, queueDeep, runDeep, type DeepStages } from '../../src/search/deep.ts'
import { answerMaybes, findMaybes, listMaybes } from '../../src/people/maybe.ts'
import { OcrReader } from '../../src/search/ocr.ts'
import { FaceReader } from '../../src/search/faces.ts'
import { FACE_NAME } from '../../src/search/face-model.ts'
import { MODEL_KEY } from '../../src/search/model.ts'
import { AccelChoices } from '../../src/search/accel.ts'
import { answerSuggestion, eraseFaces, faceBox, getPerson, hidePerson, listPeople, namePerson, personAssetIds, personFaceIn, personFaces, removeFromPerson, setPersonCover, settlePeople, suggestions, type PersonInfo } from '../../src/people/people.ts'
import { checkGroups } from '../../src/people/objects.ts'
import { MODEL_NAME } from '../../src/search/model.ts'
import { OCR_NAME } from '../../src/search/ocr-model.ts'
import { parseQuery } from '../../src/search/query.ts'
import { textMarks } from '../../src/search/text.ts'
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
import { sameVaultName, searchQueryOf, type AppState, type MaybeFace, type OfflineVaultInfo, type SaveRequest, type SaveState, type SourceId, type StoryboardInfo, type VaultDetails, type VaultInfo } from '../shared/api.ts'
import { PACE_REST, type AppSettings } from '../shared/settings.ts'
import { SettingsStore } from './settings.ts'
import { folderBytes, validateVaultDeletion } from '../../src/vault/manage.ts'
import { cleanupSavedPhone } from '../../src/gallery/run-phone-cleanup.ts'
import { wpdInventory, wpdHashObject, wpdDeleteVerified } from '../../src/device/wpd.ts'
import { checkCleanupDecode } from '../../src/verify/cleanup-decode.ts'
import type { DeviceSource } from '../../src/device/types.ts'
import type { SaveAlbum, SaveItem } from '../../src/vault/save.ts'
import { scanFolderForImport, scanPathsForImport } from '../../src/vault/import-folder.ts'
import { recycleImportedSources } from '../../src/vault/source-cleanup.ts'
import { chooseApp, copyFiles, openWithChoices, runShellCommand, setLockScreen, setWallpaper, shareFiles, shellCommands, type AppChoice } from '../../src/shell/desktop.ts'

sharp.cache(false)

/**
 * Everything the gallery does, without Electron in it. Electron-specific calls
 * (dialogs, the shell) come in through ServiceDeps.
 */

/** Adding photos from a folder on this computer. */
export interface ImportOptions {
  /** Move each original to the Recycle Bin once it is checked to be in the vault (src/vault/source-cleanup.ts). */
  deleteSources?: boolean
}

export interface ServiceDeps {
  userData: string
  publish: (state: AppState) => void
  pickFolder: (title: string, defaultPath?: string) => Promise<string | null>
  pickFiles?: (title: string, defaultPath?: string) => Promise<string[]>
  /** Where to save one file: a Save As dialog. Null when cancelled. */
  pickSavePath?: (title: string, defaultPath: string, filters?: { name: string; extensions: string[] }[]) => Promise<string | null>
  /** The Windows print dialog for a picture. */
  printImage?: (file: string) => Promise<void>
  openPath: (p: string) => Promise<void>
  showInFolder: (p: string) => void
  openExternal: (url: string) => Promise<void>
  /** Move a file to the Recycle Bin. */
  trash: (file: string) => Promise<void>
  /** This drive's Recycle Bin limit in bytes, and whether it deletes outright. Null if unknown. */
  recycleBinLimit: (dir: string) => Promise<{ maxBytes: number; nukeOnDelete: boolean } | null>
  setBusy: (busy: boolean) => void
  /**
   * The bundled models' folder, holding embeddinggemma-2 (search by meaning)
   * and ppocr (text in photos). Each kind of search is off when its model is missing.
   */
  modelsDir?: string | null
  /**
   * Start the thumbnail process (src/thumbs/render-host.ts). Without it,
   * thumbnails render in this process, and a native crash in a decoder takes
   * the app down with it.
   */
  spawnThumbnailProcess?: () => ChildLike
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
/** The same, for a vault other than the one on screen: the window opens set-up for that vault. */
const needsProtectionIn = (id: SourceId, name: string) =>
  `PROTECTION_NEEDED[${id}]: Some of these are hidden or recently deleted. Set a passcode for Hidden and Recently Deleted in ${name} first, so they stay private there.`
const NEEDS_UNLOCK = 'LOCKED: Unlock Hidden and Recently Deleted first.'

const DEFAULT_LIBRARY = process.platform === 'win32' ? 'D:\\PhotosLibrary' : path.join(os.homedir(), 'PhotosLibrary')

export class GalleryService {
  private readonly settings: SettingsStore
  private readonly vaults = new Map<SourceId, VaultEntry>()
  private readonly registry: DeviceRegistry<PhoneSession>
  /** Android phones through Windows Portable Devices. iPhones go through usbmuxd. */
  private readonly android = new AndroidPhones()
  private readonly watcher = new DeviceWatcher()
  // A quarter of the processor for HEIC decoding: thumbnails run in the
  // background and should leave room for everything else.
  /** Thumbnails in their own process, when the app can start one (see ServiceDeps). */
  private readonly renderHost: RenderHost | null
  private readonly heic = new HeicPool(Math.max(1, Math.min(Math.floor(os.cpus().length / 4), 4)))
  private readonly metadata = new ExifToolReader()
  private save: SaveState = { status: 'idle' }
  private saveAbort: AbortController | null = null
  private thumbs: { done: number; total: number } | null = null
  private thumbsRunning = false
  private thumbnailRun: Promise<void> | null = null
  private stopping = false
  private readonly rendering = new Map<string, Promise<void>>()
  /**
   * Pictures that failed to render on demand this session. Not tried again
   * each time their tile scrolls back into view: a file that crashes the
   * decoder would crash the thumbnail process every time, and could take
   * background jobs that happened to be running with it.
   */
  private readonly renderFailed = new Set<string>()
  private publishTimer: NodeJS.Timeout | null = null
  private converting: AppState['converting'] = null
  private readonly probes = new Map<string, Probe>()
  private readonly placesChecked = new WeakMap<PhoneSession, WeakSet<OpenVault>>()
  private readonly savingVaults = new Set<SourceId>()
  /**
   * Vaults whose drive is not connected, by folder: remembered, shown as not
   * connected, and opened again by themselves when the drive comes back.
   */
  private readonly offline = new Map<string, OfflineVaultInfo>()
  private driveWatch: NodeJS.Timeout | null = null
  private drivesChecking: Promise<void> | null = null
  /** Vaults being closed: the thumbnail run leaves them alone. */
  private readonly closingVaults = new Set<SourceId>()
  /** The thumbnail drain working on a vault now, so closing it can stop just that one. */
  private readonly thumbDrains = new Map<SourceId, { abort: AbortController; done: Promise<void> }>()
  /** EmbeddingGemma 2 in a worker, or null when the model isn't bundled. */
  private readonly embedder: Embedder | null
  /** PaddleOCR in a worker, or null when the models aren't bundled. */
  private readonly ocr: OcrReader | null
  /** YuNet and SFace in a worker, or null when the models aren't bundled. */
  private readonly faces: FaceReader | null
  /** Where each model runs on this computer, as last decided. */
  private readonly devices: AppState['search']['devices'] = { embed: null, ocr: null }
  /** Grouping faces into people, per vault, one at a time. */
  private readonly settling = new Map<SourceId, Promise<void>>()
  /** Changes whenever people change, so the window reloads them. */
  private peopleRevision = 0
  private searchRun: Promise<void> | null = null
  /** The vault being indexed for search now, so closing it or a thumbnail run can stop it. */
  private searchDrain: { vault: SourceId; abort: AbortController; done: Promise<void> } | null = null
  private searchIndexing: AppState['search']['indexing'] = null

  constructor(private readonly deps: ServiceDeps) {
    this.renderHost = deps.spawnThumbnailProcess ? new RenderHost(deps.spawnThumbnailProcess) : null
    this.settings = new SettingsStore(deps.userData)
    const gemma = deps.modelsDir ? path.join(deps.modelsDir, MODEL_NAME) : null
    const ppocr = deps.modelsDir ? path.join(deps.modelsDir, OCR_NAME) : null
    const faceDir = deps.modelsDir ? path.join(deps.modelsDir, FACE_NAME) : null
    // The graphics card when it works and agrees with the processor, any make
    // (WebGPU on Direct3D 12); the processor otherwise. Remembered per computer.
    const accel = new AccelChoices(deps.userData)
    const onDevice = (model: 'embed', key: string) => (d: { device: 'gpu' | 'cpu'; reason: string | null }) => {
      accel.remember(model, key, d)
      this.devices[model] = d.device
      if (d.reason) console.warn(`${model} runs on the processor: ${d.reason}`)
      this.publish()
    }
    this.embedder = gemma && Embedder.available(gemma)
      ? new Embedder(gemma, { device: accel.device('embed', MODEL_KEY), onDevice: onDevice('embed', MODEL_KEY) })
      : null
    // Text and faces stay on the processor, beside the search model. ONNX
    // Runtime's WebGPU crashes the process when two threads use it at once,
    // and these models gain little from it (text 1.5 times, faces nothing),
    // while the search model gains 15 times.
    this.ocr = ppocr && OcrReader.available(ppocr)
      ? new OcrReader(ppocr, { device: 'cpu', threads: 3 })
      : null
    if (this.ocr) this.devices.ocr = 'cpu'
    this.faces = faceDir && FaceReader.available(faceDir) ? new FaceReader(faceDir) : null
    if (faceDir && !this.faces) console.warn(`face models missing from ${faceDir}; people are off`)
    if (gemma && !this.embedder) console.warn(`search model missing from ${gemma}; search by meaning is off`)
    if (ppocr && !this.ocr) console.warn(`text reading models missing from ${ppocr}; search by text in photos is off`)
    this.registry = new DeviceRegistry<PhoneSession>({
      open: async (udid, onScanProgress) => {
        if (isAndroidId(udid)) return this.openAndroid(udid, onScanProgress)
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
            progressive: true,
            onScanProgress,
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
      onReady: (s, changed) => { void s.finishIndexing(changed) },
      nameOf: (s) => s.name,
      // Both kinds of phone. One failing (Apple's service not installed, say)
      // must not hide the other.
      list: async () => {
        const [iphones, androids] = await Promise.all([listUsb().catch(() => []), this.android.list()])
        return [...iphones, ...androids]
      },
      listen: listenUsb,
    })
  }

  private async openAndroid(id: string, onScanProgress: (checked: number) => void): Promise<PhoneSession> {
    const device = await this.android.attach(id)
    try {
      return await PhoneSession.open({
        device,
        udid: id,
        name: (await device.identity()).name,
        platform: 'android',
        progressive: true,
        openIndexDevice: () => this.android.attach(id),
        cacheRoot: path.join(this.deps.userData, 'phones'),
        heic: this.heic,
        metadata: this.metadata,
        reconnect: () => this.android.attach(id),
        onLost: () => void this.registry.reopen(id),
        onScanProgress,
      })
    } catch (e) {
      await device.dispose().catch(() => {})
      // A watch or music player: stop offering it until it is plugged in again.
      if (e instanceof NoPhotoFoldersError) this.android.ignore(id)
      throw e
    }
  }

  start() {
    for (const { root, name } of this.loadVaultList()) {
      // A vault on a drive that isn't plugged in: remembered, and opened when it is.
      if (!driveThere(root)) {
        this.offline.set(root, { root, name: name ?? path.basename(root) })
        continue
      }
      if (!isVault(root)) continue // its folder was deleted or moved
      try {
        this.addVault(root)
      } catch (e) {
        console.error(`could not open vault ${root}:`, (e as Error).message)
        this.offline.set(root, { root, name: name ?? path.basename(root) })
      }
    }
    // Drives come and go: notice a vault's drive being unplugged before
    // anything trips over it, and reopen it when it is plugged back in.
    this.driveWatch = setInterval(() => void this.checkDrives(), DRIVE_CHECK_MS)
    this.driveWatch.unref?.()
    this.registry.on('change', () => {
      this.backfillPlaces()
      this.forgetPhonePrivate()
      this.publish(true)
    })
    this.registry.on('progress', () => this.publish())
    this.watcher.on('change', () => this.publish())
    this.registry.start()
    this.watcher.start()
    this.publish(true)
    void this.runThumbnails()
  }

  async stop() {
    this.stopping = true
    if (this.driveWatch) clearInterval(this.driveWatch)
    this.saveAbort?.abort()
    this.watcher.stop()
    await this.registry.stop()
    await this.android.close()
    await this.thumbnailRun?.catch(() => {})
    this.searchDrain?.abort.abort()
    await this.searchRun?.catch(() => {})
    await this.embedder?.close()
    await this.ocr?.close()
    await Promise.all([...this.settling.values()].map((p) => p.catch(() => {})))
    await this.faces?.close()
    await Promise.all([...this.rendering.values()].map(job => job.catch(() => {})))
    await Promise.all([...this.vaults.values()].map(v => v.privacy.catch(() => {})))
    await this.heic.close()
    this.renderHost?.close()
    await this.metadata.close().catch(() => {})
    for (const v of this.vaults.values()) {
      try { v.vault.db.close() } catch { /* its drive is gone */ }
    }
  }

  snapshot(): AppState {
    const devices = this.registry.devices.map((d) => ({
      id: `device:${d.udid}`,
      udid: d.udid,
      platform: isAndroidId(d.udid) ? ('android' as const) : ('iphone' as const),
      name: d.name ?? (isAndroidId(d.udid) ? this.android.nameOf(d.udid) ?? 'Android phone' : 'iPhone'),
      state: d.state,
      error: d.error,
      count: d.session ? d.session.library.assets.length : null,
      scanChecked: d.scanChecked,
      indexing: d.session?.indexing,
      indexError: d.session?.indexError,
    }))
    const anyReady = devices.some((d) => d.state === 'ready')
    return {
      settings: this.settings.get(),
      devices,
      vaults: [...this.vaults.values()].flatMap((v) => {
        try {
          return [this.vaultInfo(v)]
        } catch (e) {
          // Most likely its drive was just unplugged: check, and close it if so.
          console.warn(`vault ${v.vault.manifest.name}:`, (e as Error).message)
          void this.checkDrives()
          return []
        }
      }),
      offlineVaults: [...this.offline.values()],
      diagnosis: anyReady ? null : (this.watcher.current.diagnosis ?? null),
      save: this.save,
      thumbnails: this.thumbs,
      search: {
        available: !!this.embedder || !!this.ocr,
        indexing: this.searchIndexing,
        devices: { ...this.devices },
        people: !!this.faces && this.settings.get().faceGrouping,
        peopleRevision: this.peopleRevision,
      },
      converting: this.converting,
    }
  }

  /* ------------------------------------------------------------- browsing */

  mapsEnabled(): boolean { return this.settings.get().mapsEnabled }

  async setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const before = this.settings.get()
    const settings = this.settings.set(patch)
    if (before.faceGrouping && !settings.faceGrouping) {
      // (Only face grouping being switched off erases anything: the other
      // kinds of search keep what they read, ready if switched back on.)
      // Off means gone: faces, groups and names, from every open vault.
      this.searchDrain?.abort.abort()
      await this.searchRun?.catch(() => {})
      await Promise.all([...this.settling.values()].map((p) => p.catch(() => {})))
      for (const v of this.vaults.values()) {
        eraseFaces(v.vault.db)
        fs.rmSync(path.join(v.vault.layout.cache, 'faces'), { recursive: true, force: true })
      }
      this.peopleRevision++
      void this.runSearchIndex()
    }
    const what = (x: AppSettings) => [x.indexing, x.searchByMeaning, x.searchText, x.faceGrouping, x.deepIndexing].join()
    if (what(before) !== what(settings) && !(before.faceGrouping && !settings.faceGrouping)) {
      // Something was switched on or off: stop, then start again with the new set.
      this.searchDrain?.abort.abort()
      void (this.searchRun ?? Promise.resolve()).catch(() => {}).then(() => this.runSearchIndex())
    }
    this.publish(true)
    return settings
  }

  /** How long background work rests after each photo, from the chosen pace. */
  /** Until when the person is busy in the window (scrolling): background jobs hold off till then. */
  private userBusyUntil = 0

  /** The window says the person is scrolling; called at most a few times a second. */
  userActive(): void {
    this.userBusyUntil = Date.now() + 700
  }

  /** Hiding or restoring (encrypting or decrypting files) going on, in any vault. */
  private privacyRunning = 0

  /**
   * How long background jobs (thumbnails, search, people, the closer look)
   * hold off before starting another: while the person scrolls, and for as
   * long as a save, import, hide or restore runs. Those read and write the
   * same drive, and one spinning disk read from in several places at once
   * does less in total, not more: measured on a USB hard drive, 25 to 35% less.
   */
  private yieldTo(): number {
    if (this.save.status === 'running' || this.privacyRunning > 0) return 1000
    return Math.max(0, this.userBusyUntil - Date.now())
  }

  private rest(): number {
    return PACE_REST[this.settings.get().indexingPace] ?? 0.5
  }

  /** The models indexing runs, from what is switched on in Settings. */
  private stages() {
    const s = this.settings.get()
    if (!s.indexing) return { embed: null, ocr: null, faces: null }
    return {
      embed: s.searchByMeaning ? this.embedder : null,
      ocr: s.searchText ? this.ocr : null,
      faces: this.peopleOn() ? this.faces : null,
    }
  }

  /** The stages the closer look runs: the same ones, when it is switched on. */
  private deepStages(): DeepStages | null {
    if (!this.settings.get().deepIndexing) return null
    const s = this.stages()
    return s.embed || s.ocr || s.faces ? s : null
  }

  /* ---------------------------------------------------------------- people */

  private peopleOn(): boolean {
    const s = this.settings.get()
    return !!this.faces && s.faceGrouping && s.indexing
  }

  private peopleVault(source: SourceId): VaultEntry {
    const v = this.vaults.get(source)
    if (!v) throw new Error('People are only in vaults.')
    if (!this.peopleOn()) throw new Error('Face grouping is switched off in Settings.')
    return v
  }

  async people(source: SourceId, includeHidden = false): Promise<PersonInfo[]> {
    const v = this.vaults.get(source)
    return v && this.peopleOn() ? listPeople(v.vault.db, { includeHidden: !!includeHidden }) : []
  }

  async person(source: SourceId, id: number): Promise<PersonInfo | null> {
    const v = this.vaults.get(source)
    return v && this.peopleOn() ? getPerson(v.vault.db, Number(id)) : null
  }

  /** Name, rename or unname someone. A name another person has merges them into that person. */
  async namePerson(source: SourceId, id: number, name: string): Promise<{ person: number; merged: boolean }> {
    const v = this.peopleVault(source)
    const r = namePerson(v.vault.db, Number(id), String(name ?? ''))
    this.peopleChanged()
    return r
  }

  /** "Not this person" for these photos. */
  async removeFromPerson(source: SourceId, id: number, keys: string[]): Promise<number> {
    const v = this.peopleVault(source)
    const n = removeFromPerson(v.vault.db, Number(id), keys.map(Number))
    this.peopleChanged()
    return n
  }

  /** "Same person?" questions: an unnamed group and who it might be. */
  async peopleSuggestions(source: SourceId): Promise<{ person: PersonInfo; other: PersonInfo; score: number }[]> {
    const v = this.vaults.get(source)
    if (!v || !this.peopleOn()) return []
    const all = new Map(listPeople(v.vault.db).map((p) => [p.id, p]))
    return suggestions(v.vault.db).flatMap((s) => {
      const person = all.get(s.person)
      const other = all.get(s.other)
      return person && other ? [{ person, other, score: s.score }] : []
    })
  }

  /** The answer to "Same person?". Returns who they are now. */
  async answerSuggestion(source: SourceId, a: number, b: number, same: boolean): Promise<number> {
    const v = this.peopleVault(source)
    const into = answerSuggestion(v.vault.db, Number(a), Number(b), !!same)
    this.peopleChanged()
    return into
  }

  /** This person's faces, to choose their picture from. */
  async personFaces(source: SourceId, id: number): Promise<{ face: number; assetId: number }[]> {
    const v = this.vaults.get(source)
    if (!v || !this.peopleOn()) return []
    return personFaces(v.vault.db, Number(id))
  }

  /** Use this face as their picture; null to let Theia choose again. */
  async setPersonCover(source: SourceId, id: number, face: number | null): Promise<void> {
    const v = this.peopleVault(source)
    setPersonCover(v.vault.db, Number(id), face === null ? null : Number(face))
    this.peopleChanged()
  }

  /** Use their face in this photo as their picture. */
  async setPersonCoverFromPhoto(source: SourceId, id: number, key: string): Promise<void> {
    const v = this.peopleVault(source)
    const face = personFaceIn(v.vault.db, Number(id), Number(key))
    if (face === null) throw new Error('They aren’t in that photo as far as Theia knows.')
    setPersonCover(v.vault.db, Number(id), face)
    this.peopleChanged()
  }

  /** Faces the closer look thinks might be this person, to say yes or no to. */
  async personMaybes(source: SourceId, id: number): Promise<MaybeFace[]> {
    const v = this.vaults.get(source)
    if (!v || !this.peopleOn()) return []
    return listMaybes(v.vault.db, Number(id))
  }

  async answerMaybes(source: SourceId, id: number, yes: number[], no: number[]): Promise<number> {
    const v = this.peopleVault(source)
    const n = answerMaybes(v.vault.db, Number(id), (yes ?? []).map(Number), (no ?? []).map(Number))
    this.peopleChanged()
    return n
  }

  async hidePerson(source: SourceId, id: number, hidden: boolean): Promise<void> {
    const v = this.peopleVault(source)
    hidePerson(v.vault.db, Number(id), !!hidden)
    this.peopleChanged()
  }

  /**
   * Everything search knows about these items, gone: vectors, text, faces,
   * and the face pictures cut from them. For items just hidden or deleted.
   */
  private forgetSearchData(v: VaultEntry, ids: number[]) {
    const faces = v.vault.db.prepare('SELECT id FROM face WHERE asset_id = ?')
    const crops = ids.flatMap((id) => (faces.all(id) as { id: number }[]).map((f) => f.id))
    forgetSearchData(v.vault.db, ids)
    for (const f of crops) fs.rmSync(path.join(v.vault.layout.cache, 'faces', `${f}.webp`), { force: true })
    if (crops.length) this.peopleChanged()
  }

  private peopleChanged() {
    this.peopleRevision++
    this.publish(true)
  }

  /** Group the vault's new faces into people, unless that is already happening. */
  /**
   * Group the vault's new faces into people, unless that is already
   * happening. `report`: this is the last step of indexing the vault, shown
   * in the status bar ("Grouping people"); grouping in the middle of reading
   * photos leaves the bar on reading.
   */
  private settle(v: VaultEntry, report = false): Promise<void> {
    const reader = this.faces
    if (!reader || !this.peopleOn()) return Promise.resolve()
    const show = (done: number, total: number) => {
      if (!report || !this.vaults.has(v.id)) return
      this.searchIndexing = { vault: v.vault.manifest.name, step: 'people', done, total }
      this.publish()
    }
    const running = this.settling.get(v.id)
    if (running) return report ? running.then(() => this.settle(v, true)) : running
    show(0, 0)
    const run = settlePeople(v.vault.db, reader)
      .then(async (r) => {
        if (r.joined || r.created || r.merged) this.peopleChanged()
        // After a closer look: faces that might be someone named, to ask about.
        if (this.settings.get().deepIndexing && findMaybes(v.vault.db)) this.peopleChanged()
        // Statues, carvings, drawings: hidden before anyone is asked to name them.
        if (this.embedder && !this.stopping) {
          const objects = await checkGroups(v.vault.db, v.vault.layout.cache, this.embedder, { onProgress: show })
          if (objects.length) this.peopleChanged()
        }
      })
      .catch((e) => console.warn('grouping faces:', (e as Error).message))
      .finally(() => this.settling.delete(v.id))
    this.settling.set(v.id, run)
    return run
  }

  async collections(source: SourceId): Promise<Collections> {
    const v = this.vaults.get(source)
    if (v) {
      const c = vaultCollections(v.vault.db)
      // Their names and sizes say something too: only while Hidden is open.
      if (v.privateKey) c.hiddenFolders = hiddenFolders(v.vault.db)
      if (this.peopleOn()) {
        const people = listPeople(v.vault.db)
        c.people = { count: people.length, unnamed: people.filter((p) => p.name === null).length }
      }
      return c
    }
    return this.phone(source).collections()
  }

  async items(source: SourceId, collection: string, page?: { fromEnd: number; limit: number }): Promise<GalleryItem[]> {
    const v = this.vaults.get(source)
    const query = searchQueryOf(collection)
    if (query !== null) return v ? this.search(v, query) : []
    if (v && collection === 'people') return []
    if (v && collection.startsWith('person:')) {
      if (!this.peopleOn()) return []
      return vaultItemsByIds(v.vault.db, personAssetIds(v.vault.db, Number(collection.slice(7))))
    }
    if (v && /^hidden:\d+$/.test(collection) && !v.privateKey) return []
    if (v) return vaultItems(v.vault.db, collection)
    // Strip the phone-only fields; the window needs only the tile.
    const s = this.phone(source)
    return s
      .itemPage(collection, page)
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
    if (what === 'face') return this.faceMedia(source, key)
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
      // The grid's path: one lookup of the files, not one per step.
      if (what === 'sm' || what === 'lg' || what === 'ph') return this.vaultMedia(pv, what, key, files)
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

  /**
   * A face, cut square from its photo's large thumbnail with some room
   * around it, 256 px, cached. Nothing for a face in a hidden or deleted item.
   */
  private async faceMedia(source: SourceId, key: string): Promise<{ path: string; mime: string } | null> {
    const v = this.vaults.get(source)
    if (!v || !this.peopleOn()) return null
    const box = faceBox(v.vault.db, Number(key))
    if (!box) return null
    const out = path.join(v.vault.layout.cache, 'faces', `${Number(key)}.webp`)
    if (fs.existsSync(out)) return { path: out, mime: 'image/webp' }
    const lg = await this.vaultMedia(v, 'lg', String(box.assetId))
    if (!lg || !('path' in lg)) return null
    const img = sharp(await fs.promises.readFile(lg.path))
    const { width = 0, height = 0 } = await img.metadata()
    const side = Math.min(width, height, Math.round(Math.max(box.w * width, box.h * height) * 1.45))
    const cx = (box.x + box.w / 2) * width
    const cy = (box.y + box.h / 2) * height
    const left = Math.max(0, Math.min(width - side, Math.round(cx - side / 2)))
    const top = Math.max(0, Math.min(height - side, Math.round(cy - side / 2)))
    if (side < 8) return null
    const bytes = await img.extract({ left, top, width: side, height: side }).resize(256, 256).webp({ quality: 86 }).toBuffer()
    // Hidden while it was being cut: keep nothing.
    if (!faceBox(v.vault.db, Number(key))) return null
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, bytes)
    return { path: out, mime: 'image/webp' }
  }

  private async vaultMedia(v: VaultEntry, what: string, key: string, known?: ReturnType<typeof vaultFiles>) {
    // `<asset>~<file>` asks for one particular file, such as a burst frame.
    const [assetKey, fileId] = key.split('~')
    const files = known ?? vaultFiles(v.vault.db, assetKey!)
    const shown = displayFile(files, fileId ? Number(fileId) : null)
    if (!shown) return null
    const abs = (rel: string) => path.join(v.vault.layout.media, ...rel.split('/'))

    if (what === 'sm' || what === 'lg' || what === 'ph') {
      const p = thumbPath(v.vault.layout.cache, shown.sha256, what as ThumbSize)
      // Checked asynchronously: hundreds of these arrive at once as the grid
      // scrolls, and a synchronous stat each on a USB disk froze the window.
      // The protocol handler answers 404 if the file is still missing.
      if (!(await fileExists(p))) await this.renderNow(v, shown.sha256, abs(shown.path), shown.mime)
      if (this.privateItem(v, assetKey!)) return null
      return { path: p, mime: 'image/webp' }
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
    if (this.renderFailed.has(renderingKey)) return Promise.resolve()
    let p = this.rendering.get(renderingKey)
    if (!p) {
      // In the thumbnail process when there is one, like the background jobs:
      // a file that crashes the decoder while the grid scrolls must not take
      // the whole app with it, and the decode stays off this process.
      const host = this.renderHost
      const rendered = host
        ? host.render({ file, mime, sha256: sha, cacheRoot: v.vault.layout.cache })
        : renderThumbnails(file, mime, sha, v.vault.layout.cache, { heic: this.heic })
      p = rendered
        .then(() => {
          const visible = v.vault.db.prepare(`SELECT 1 FROM file f JOIN asset a ON a.id=f.asset_id WHERE f.sha256=? AND a.hidden=0 AND a.deleted_at IS NULL AND f.encrypted_path IS NULL LIMIT 1`).get(sha)
          if (!visible) for (const size of Object.keys(SIZES) as ThumbSize[]) fs.rmSync(thumbPath(v.vault.layout.cache,sha,size),{force:true})
        })
        .catch(() => { this.renderFailed.add(renderingKey) })
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

  /**
   * Add photos and videos from a folder on this computer to a vault.
   * Without a vault: the only open one, or ask for one. Without a folder: ask.
   * Returns once the folder is read; the copying runs on, shown in the status bar.
   */
  async addFolderToVault(vaultId?: SourceId, folderPath?: string, opts: ImportOptions = {}): Promise<{ count: number; vaultName: string } | null> {
    this.assertNotSaving()
    const target = await this.importTarget(vaultId)
    if (!target) return null
    const root = folderPath ?? (await this.deps.pickFolder('Choose a folder of photos and videos to add'))
    if (!root) return null
    const { items, albums } = await scanFolderForImport(root, { exclude: [target.vault.layout.root] })
    if (!items.length) throw new Error(`No photos or videos found in "${path.basename(root)}".`)
    return this.startImport(target, items, albums, { deleteSources: opts?.deleteSources === true })
  }

  /** Add chosen or dropped files and folders to a vault. Without paths: ask for files. */
  async addFilesToVault(vaultId?: SourceId, filePaths?: string[], opts: ImportOptions = {}): Promise<{ count: number; vaultName: string } | null> {
    this.assertNotSaving()
    const target = await this.importTarget(vaultId)
    if (!target) return null
    const paths = filePaths?.length ? filePaths : ((await this.deps.pickFiles?.('Choose photos and videos to add')) ?? [])
    if (!paths.length) return null
    const { items, albums } = await scanPathsForImport(paths, { exclude: [target.vault.layout.root] })
    if (!items.length) throw new Error('None of those are photos or videos Theia can add.')
    return this.startImport(target, items, albums, { deleteSources: opts?.deleteSources === true })
  }

  private assertNotSaving() {
    if (this.save.status === 'running') throw new Error('A save is already running. Add these once it finishes.')
  }

  /** The vault asked for, the only one open, or one the person picks or makes now. */
  private async importTarget(vaultId?: SourceId): Promise<VaultEntry | null> {
    if (vaultId) {
      const v = this.vaults.get(vaultId)
      if (!v) throw new Error('That vault is not open any more.')
      return v
    }
    if (this.vaults.size === 1) return [...this.vaults.values()][0]!
    const picked = await this.deps.pickFolder('Choose a vault, or an empty folder for a new one')
    if (!picked) return null
    if (!isVault(picked) && !canCreateVault(picked)) throw new NotAVault(picked)
    const entry = isVault(picked) ? this.addVault(picked) : this.addVault(picked, true)
    this.saveVaultList()
    return entry
  }

  private startImport(target: VaultEntry, items: SaveItem[], albums: SaveAlbum[], opts: ImportOptions): { count: number; vaultName: string } {
    // Checked again: the folder may have taken a while to read.
    this.assertNotSaving()
    void this.runImportToVault(target, items, albums, opts)
    return { count: items.length, vaultName: target.vault.manifest.name }
  }

  private async runImportToVault(target: VaultEntry, items: SaveItem[], albums: SaveAlbum[], opts: ImportOptions = {}): Promise<void> {
    const name = target.vault.manifest.name
    this.savingVaults.add(target.id)
    const abort = new AbortController()
    this.saveAbort = abort
    this.save = { status: 'running', target: name, itemsDone: 0, itemsTotal: items.length, bytesDone: 0, current: null }
    this.publish(true)
    this.deps.setBusy(true)

    const previousSync = target.vault.db.pragma('synchronous', { simple: true }) as number
    try {
      const vault = target.vault
      // Originals will be deleted: every vault write reaches the disk first.
      if (opts.deleteSources) vault.db.pragma('synchronous = FULL')
      const result = await saveToVault(vault, items, albums, {
        signal: abort.signal,
        metadata: this.metadata,
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
      if (result.replaced) await this.applyPrivacy(target).catch((e) => console.warn('privacy after replace:', (e as Error).message))
      let cleanup: Extract<SaveState, { status: 'done' }>['cleanup']
      if (opts.deleteSources) {
        // A stopped import deletes nothing; a finished one, only what checks out (source-cleanup.ts).
        if (abort.signal.aborted) cleanup = { from: 'folder', deleted: 0, kept: 0, reasons: [{ item: 'Originals', reason: 'The import was stopped, so nothing was deleted.' }] }
        else {
          const checkpoint = vault.db.pragma('wal_checkpoint(FULL)') as { busy: number }[]
          if (checkpoint[0]?.busy) {
            cleanup = { from: 'folder', deleted: 0, kept: 0, reasons: [{ item: 'Originals', reason: 'The vault couldn’t be written to disk completely, so nothing was deleted.' }] }
          } else {
            const done = result.saved + result.alreadyThere
            const r = await recycleImportedSources(vault, items, result.assets, {
              trash: this.deps.trash,
              recycleBin: this.deps.recycleBinLimit,
              signal: abort.signal,
              progress: (current) => {
                this.save = { status: 'running', target: name, itemsDone: done, itemsTotal: items.length, bytesDone: result.bytes, current, phase: 'recycling-originals', etaMs: null }
                this.publish()
              },
            })
            cleanup = { from: 'folder', ...r }
          }
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
        this.save = { status: 'error', target: name, error: await this.saveError(target, e) }
      }
      if (!this.vaults.has(target.id)) this.save = { status: 'error', target: name, error: await this.saveError(target, e) }
    } finally {
      try { target.vault.db.pragma(`synchronous = ${previousSync}`) } catch { /* its drive is gone */ }
      this.savingVaults.delete(target.id)
      this.changed(target)
      this.saveAbort = null
      this.deps.setBusy(false)
      this.publish(true)
    }
    void this.runThumbnails()
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
      const search = this.searchDrain?.vault === id ? this.searchDrain : null
      search?.abort.abort()
      await search?.done.catch(() => {})
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
    retryMissingThumbnailJobs(vault.db)
    this.vaults.set(id, entry)
    this.offline.delete(vault.layout.root)
    // Finish anything a crash interrupted, then protect whatever is hidden or
    // deleted and isn't yet (an item hidden before protection was set up).
    // In the background: opening the vault doesn't wait on a disk walk.
    void sweepPrivate(vault)
      .then((swept) => {
        if (swept.missing.length) console.warn(`vault ${vault.manifest.name}: encrypted copies missing for ${swept.missing.join(', ')}`)
      }, (e) => console.warn('private sweep:', (e as Error).message))
    void this.applyPrivacy(entry).catch(e => console.warn('Vault protection:', (e as Error).message))
    this.backfillPlaces()
    return entry
  }

  private readonly privateForgotten = new WeakSet<PhoneSession>()
  /** Vaults whose thumbnail cache was checked for missing files this session. */
  private readonly thumbCacheChecked = new WeakSet<OpenVault>()

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
      if (device.state !== 'ready' || !device.session || device.session.indexing) continue
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
    if (req.deleteAfterSave && isAndroidId(req.source.replace(/^device:/, ''))) throw new Error('Delete after save is available only for iPhones. Nothing on Android phones is changed by Theia.')
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
    // Hidden and deleted items are encrypted in a vault, which needs its passcode set up.
    if (!target.keyFile && this.anyPrivate(req)) throw new Error(needsProtectionIn(target.id, target.vault.manifest.name))

    const name = target.vault.manifest.name
    this.savingVaults.add(target.id)
    if (this.vaults.has(req.source)) this.savingVaults.add(req.source)
    const abort = new AbortController()
    this.saveAbort = abort
    this.save = { status: 'running', target: name, itemsDone: 0, itemsTotal: req.keys.length, bytesDone: 0, current: null }
    this.publish(true)
    this.deps.setBusy(true)

    let device: DeviceSource | null = null
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
        device = s.platform === 'android' ? await this.android.attach(s.udid) : await AfcDevice.attach(s.udid)
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
      // Hidden or deleted at the source, or a replaced hidden item: encrypt the
      // new copies now. Before any iPhone cleanup, which keeps such items on the phone.
      if (result.replaced || items.some((i) => i.hidden || i.deletedAt != null)) {
        await this.applyPrivacy(target).catch((e) => console.warn('privacy after save:', (e as Error).message))
      }
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
        this.save = { status: 'error', target: name, error: await this.saveError(target, e) }
      }
      if (!this.vaults.has(target.id)) this.save = { status: 'error', target: name, error: await this.saveError(target, e) }
    } finally {
      try { target.vault.db.pragma(`synchronous = ${previousSync}`) } catch { /* its drive is gone */ }
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

  /** Whether any of the items to save is hidden or deleted at its source. */
  private anyPrivate(req: SaveRequest): boolean {
    const fromVault = this.vaults.get(req.source)
    if (fromVault) {
      const row = fromVault.vault.db.prepare(`SELECT 1 FROM asset WHERE id = ? AND (hidden = 1 OR deleted_at IS NOT NULL)`)
      return req.keys.some((k) => row.get(Number(k)) !== undefined)
    }
    const s = this.phone(req.source)
    return req.keys.some((k) => s.privacyOf(k) !== null)
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
    this.forgetSearchData(v, keys.map(Number))
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
      this.forgetSearchData(v, keys.map(Number))
      await this.applyPrivacy(v)
      return n
    }
    await this.release(v, keys.map(Number).filter((id) => !this.flag(v, id, 'deleted')))
    const n = this.setFlag(source, keys, 'hidden', false)
    // Back in the library: out of any folder in Hidden, so hiding it again starts in Hidden itself.
    const clear = this.vaults.get(source)!.vault.db.prepare('UPDATE asset SET hidden_folder_id = NULL WHERE id = ?')
    for (const k of keys) clear.run(Number(k))
    return n
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

  /* --------------------------------------------------- folders in Hidden */

  /** A vault whose Hidden is open, for changing its folders. */
  private unlockedForFolders(source: SourceId): VaultEntry {
    const v = this.editable(source)
    if (!v.keyFile) throw new Error(NEEDS_PROTECTION)
    if (!v.privateKey) throw new Error('Unlock Hidden first.')
    return v
  }

  async createHiddenFolder(source: SourceId, name: string): Promise<string> {
    const v = this.unlockedForFolders(source)
    const clean = folderName(name)
    const db = v.vault.db
    if (db.prepare('SELECT 1 FROM hidden_folder WHERE lower(name) = lower(?)').get(clean)) throw new Error(`There is already a folder called “${clean}” in Hidden.`)
    const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM hidden_folder').get() as { p: number }).p
    const id = Number(db.prepare('INSERT INTO hidden_folder (name, position, created_at) VALUES (?, ?, ?)').run(clean, position, Date.now()).lastInsertRowid)
    this.changed(v)
    return `hidden:${id}`
  }

  async renameHiddenFolder(source: SourceId, folder: string, name: string): Promise<void> {
    const v = this.unlockedForFolders(source)
    const id = folderId(folder)
    const clean = folderName(name)
    const db = v.vault.db
    if (db.prepare('SELECT 1 FROM hidden_folder WHERE lower(name) = lower(?) AND id <> ?').get(clean, id)) throw new Error(`There is already a folder called “${clean}” in Hidden.`)
    if (!db.prepare('UPDATE hidden_folder SET name = ? WHERE id = ?').run(clean, id).changes) throw new Error('That folder is gone.')
    this.changed(v)
  }

  /** The folder goes; what was in it stays in Hidden. */
  async deleteHiddenFolder(source: SourceId, folder: string): Promise<void> {
    const v = this.unlockedForFolders(source)
    const id = folderId(folder)
    v.vault.db.transaction(() => {
      v.vault.db.prepare('UPDATE asset SET hidden_folder_id = NULL WHERE hidden_folder_id = ?').run(id)
      v.vault.db.prepare('DELETE FROM hidden_folder WHERE id = ?').run(id)
    })()
    this.changed(v)
  }

  /** Hidden items into a folder in Hidden, or (folder null) out of any folder. */
  async moveToHiddenFolder(source: SourceId, keys: string[], folder: string | null): Promise<number> {
    const v = this.unlockedForFolders(source)
    const id = folder === null ? null : folderId(folder)
    const db = v.vault.db
    if (id !== null && !db.prepare('SELECT 1 FROM hidden_folder WHERE id = ?').get(id)) throw new Error('That folder is gone.')
    const move = db.prepare('UPDATE asset SET hidden_folder_id = ?, updated_at = ? WHERE id = ? AND hidden = 1 AND deleted_at IS NULL')
    let n = 0
    db.transaction(() => { for (const k of keys) n += move.run(id, Date.now(), Number(k)).changes })()
    this.changed(v)
    return n
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
      this.privacyRunning++
      try {
        await this.applyPrivacyNow(v)
      } finally {
        this.privacyRunning--
      }
    })
    return v.privacy
  }

  private async applyPrivacyNow(v: VaultEntry): Promise<void> {
    if (!v.keyFile) return
    {
      const work = privacyWork(v.vault.db)
      // Hide and Delete already do this; items made private any other way
      // (hidden before a passcode existed, say) must not keep their text,
      // vectors or face crops in the clear either.
      if (work.protect.length) this.forgetSearchData(v, work.protect)
      const pub = publicKeyOf(v.keyFile)
      let changed = false
      let released = false
      const errors: string[] = []
      v.privacyError = null
      for (const id of work.protect) {
        if (!this.vaults.has(v.id)) return // its drive was unplugged
        try {
          await protectAsset(v.vault, id, pub)
          changed = true
        } catch (e) {
          errors.push(`Could not encrypt item ${id}: ${(e as Error).message}`)
        }
      }
      if (v.privateKey) {
        for (const id of work.release) {
          if (!this.vaults.has(v.id) || !v.privateKey) return
          try {
            await releaseAsset(v.vault, id, v.privateKey)
            // Its thumbnails were removed when it was hidden: make them again,
            // for the grid and for search to read.
            v.queue.enqueue(THUMBNAIL, id)
            released = true
            changed = true
          } catch (e) {
            errors.push(`Could not restore item ${id}: ${(e as Error).message}`)
          }
        }
      }
      if (v.privateKey) {
        try { await finishPrivateCleanup(v.vault, v.privateKey) } catch (e) { errors.push((e as Error).message) }
      }
      if (released) void this.runThumbnails()
      v.privacyError = errors.length ? errors.join(' ') : null
      if (changed) this.changed(v)
      if (errors.length) { this.changed(v); throw new Error(v.privacyError!) }
    }
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

  /* ------------------------------------------------------ windows actions */
  // The right-click menu's Copy, Share, Print, Save as, Open with, Set as and
  // Resize. Each works on the item's real file, never on a cached thumbnail.
  // Protected (encrypted) vault items and the phone's own Hidden and Recently
  // Deleted are refused: they would have to be written out decrypted, or
  // copied off the phone, which Theia never does with them.

  /** The original of an item as a file on this computer. */
  private async originalFile(source: SourceId, key: string): Promise<{ file: string; name: string; mime: string; id: string }> {
    const v = this.vaults.get(source)
    if (v) {
      const files = vaultFiles(v.vault.db, key)
      const f = files.find((x) => x.primary) ?? files[0]
      if (!f) throw new Error('That item has no file.')
      if (f.encryptedPath) throw new Error('This item is protected (encrypted in the vault), so Theia won’t hand its file to Windows. Unhide or recover it first.')
      return { file: path.join(v.vault.layout.media, ...f.path.split('/')), name: path.posix.basename(f.path), mime: f.mime, id: f.sha256 }
    }
    const s = this.phone(source)
    if (s.isPrivate(key)) throw new Error('This is in the phone’s Hidden album or Recently Deleted. Theia never copies those to this computer; save it into a vault first.')
    const a = s.asset(key)
    if (!a || a.cloud) throw new Error('That item is only in iCloud, not on the phone.')
    const local = await s.original(key)
    if (!local) throw new Error('The phone didn’t send the file. Check it is still unlocked and plugged in.')
    return { file: local, name: a.filename, mime: mimeOf(a.filename), id: `${s.udid}-${safeName(a.filename)}-${key}` }
  }

  /** The item as a picture any app reads (JPEG, PNG or GIF): HEIC and the rest are converted, once, into the cache. */
  private async pictureFile(source: SourceId, key: string): Promise<{ path: string; name: string }> {
    const o = await this.originalFile(source, key)
    if (o.mime.startsWith('video/')) throw new Error('That’s a video. This works with photos.')
    const v = this.vaults.get(source)
    const cache = v ? path.join(v.vault.layout.cache, 'full') : path.join(this.deps.userData, 'phones', 'full')
    const shown = await this.displayable(o.file, o.mime, cache, o.id)
    return { path: shown.path, name: o.name }
  }

  /** Copy, as File Explorer does: paste into a folder for the files, or into a chat or document for the picture. */
  async copyItems(source: SourceId, keys: string[]): Promise<void> {
    if (!keys.length) return
    const files = []
    for (const key of keys) files.push(await this.originalFile(source, key))
    const picture = keys.length === 1 && !files[0]!.mime.startsWith('video/') ? (await this.pictureFile(source, keys[0]!)).path : undefined
    await copyFiles(files.map((f) => f.file), picture)
  }

  /** "Copy as path": each original's full path in quotes, one per line, as File Explorer copies them. */
  async itemPaths(source: SourceId, keys: string[]): Promise<string> {
    if (!this.vaults.has(source)) throw new Error('Photos on a phone have no path on this computer. Save them into a vault first.')
    const out: string[] = []
    for (const key of keys) out.push(`"${(await this.originalFile(source, key)).file}"`)
    return out.join('\r\n')
  }

  /** The Windows share sheet, over `at` (a point on screen: the middle of Theia's window). */
  async shareItems(source: SourceId, keys: string[], at: { x: number; y: number }): Promise<void> {
    if (!keys.length) return
    const files = []
    for (const key of keys) files.push((await this.originalFile(source, key)).file)
    await shareFiles(files, at)
  }

  async printItem(source: SourceId, key: string): Promise<void> {
    if (!this.deps.printImage) throw new Error('Printing isn’t available here.')
    await this.deps.printImage((await this.pictureFile(source, key)).path)
  }

  /**
   * A copy of the originals somewhere else: one file through a Save As
   * dialog, several into a chosen folder. Returns where, or null when cancelled.
   */
  async saveItemsAs(source: SourceId, keys: string[]): Promise<string | null> {
    if (!keys.length) return null
    const files = []
    for (const key of keys) files.push(await this.originalFile(source, key))
    if (files.length === 1) {
      const f = files[0]!
      const ext = path.extname(f.name).slice(1)
      const target = await this.deps.pickSavePath?.('Save a copy', path.join(os.homedir(), 'Pictures', f.name), ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined)
      if (!target) return null
      if (path.resolve(target).toLowerCase() === path.resolve(f.file).toLowerCase()) throw new Error('That’s the original itself. Choose another name or folder.')
      await fs.promises.copyFile(f.file, target)
      return target
    }
    const dir = await this.deps.pickFolder(`Choose a folder for ${files.length} copies`)
    if (!dir) return null
    for (const f of files) await fs.promises.copyFile(f.file, freeTarget(dir, f.name))
    return dir
  }

  /** The apps Windows offers to open this kind of file with, its default first. */
  async openWithChoices(source: SourceId, key: string): Promise<AppChoice[]> {
    const o = await this.originalFile(source, key)
    return openWithChoices(await shellCommands(o.file))
  }

  /**
   * Open the item in another app: `id` from openWithChoices, or 'choose' for
   * Windows' own app picker. A vault's original is opened as a copy, so an
   * editor saving over it can't change what the vault keeps and has checked.
   */
  async openItemWith(source: SourceId, key: string, id: string): Promise<void> {
    const o = await this.originalFile(source, key)
    let file = o.file
    if (this.vaults.has(source)) {
      const dir = path.join(os.tmpdir(), 'Theia', 'Open')
      fs.mkdirSync(dir, { recursive: true })
      file = path.join(dir, `${safeName(key)}-${o.name}`)
      const st = fs.statSync(file, { throwIfNoEntry: false })
      if (!st || st.size !== fs.statSync(o.file).size) await fs.promises.copyFile(o.file, file)
    }
    if (id === 'choose') chooseApp(file)
    else await runShellCommand(file, id)
  }

  /** Desktop background or lock screen, from a JPEG copy Theia keeps for it (the original can move or be deleted). */
  async setItemAs(source: SourceId, key: string, where: 'desktop' | 'lock'): Promise<void> {
    const picture = await this.pictureFile(source, key)
    const dir = path.join(this.deps.userData, 'backgrounds')
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, `${where}-${Date.now()}.jpg`)
    await sharp(picture.path).rotate().jpeg({ quality: 92 }).toFile(target)
    if (where === 'desktop') await setWallpaper(target)
    else await setLockScreen(target)
    // Earlier copies for the same place are no longer in use.
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(`${where}-`) && path.join(dir, name) !== target) fs.rmSync(path.join(dir, name), { force: true })
    }
  }

  /**
   * A resized copy, saved where the person chooses: fits inside width x
   * height, never enlarged, the right way up. Returns where, or null.
   */
  async resizeItem(source: SourceId, key: string, opts: { width: number; height: number; format: 'jpeg' | 'png' | 'webp'; quality: number }): Promise<string | null> {
    const width = Math.round(Number(opts.width)), height = Math.round(Number(opts.height))
    if (!(width >= 16 && height >= 16 && width <= 20000 && height <= 20000)) throw new Error('Choose a size between 16 and 20,000 pixels.')
    if (!['jpeg', 'png', 'webp'].includes(opts.format)) throw new Error('Choose JPEG, PNG or WebP.')
    const o = await this.originalFile(source, key)
    if (o.mime.startsWith('video/')) throw new Error('That’s a video. Resizing works with photos.')
    const ext = opts.format === 'jpeg' ? 'jpg' : opts.format
    const stem = path.parse(o.name).name
    // Beside the original for a vault item would put it inside the vault; Pictures instead.
    const target = await this.deps.pickSavePath?.('Save the resized copy', path.join(os.homedir(), 'Pictures', `${stem} (${width}x${height}).${ext}`),
      [{ name: opts.format.toUpperCase(), extensions: [ext] }])
    if (!target) return null
    const quality = Math.max(10, Math.min(100, Math.round(Number(opts.quality) || 90)))
    let img = (await openSource(o.file, o.mime, { heic: this.heic })).resize(width, height, { fit: 'inside', withoutEnlargement: true })
    img = opts.format === 'png' ? img.png() : opts.format === 'webp' ? img.webp({ quality }) : img.removeAlpha().jpeg({ quality, mozjpeg: true })
    await img.toFile(target)
    return target
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

  async openAppleDevices() {
    try {
      await this.deps.openExternal('ms-windows-store://pdp/?ProductId=9NP83LWLPZ9K')
    } catch {
      await this.deps.openExternal('https://apps.microsoft.com/detail/9np83lwlpz9k')
    }
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
    // Thumbnails first: the grid needs them, and search reads them. Indexing
    // for search steps aside and picks up again when they are done.
    this.searchDrain?.abort.abort()
    this.thumbnailRun = this.runThumbnailsImpl().finally(() => {
      this.thumbnailRun = null
      void this.runSearchIndex()
    })
    return this.thumbnailRun
  }

  /* ----------------------------------------------------------------- search */

  /** Results for a typed query: dates and kinds as a filter, the rest by meaning, by text in the photo, and by place or album name. */
  private async search(v: VaultEntry, query: string): Promise<GalleryItem[]> {
    if (!query.trim()) return []
    const parsed = parseQuery(query)
    let vec: Float32Array | null = null
    const s = this.settings.get()
    if (this.embedder && parsed.text && s.searchByMeaning) {
      try {
        vec = await this.embedder.query(parsed.text)
      } catch (e) {
        // Text, names and dates still match without the model.
        console.warn('search query:', (e as Error).message)
      }
    }
    const hits = searchVault(v.vault.db, vec, parsed, { text: s.searchText })
    const items = vaultItemsByIds(v.vault.db, hits.map((h) => h.assetId))
    // Where the words are written, for the grid and the viewer to highlight.
    if (parsed.text && s.searchText) {
      const lines = v.vault.db.prepare(`SELECT lines FROM ocr_text WHERE asset_id = ?`)
      for (const item of items) {
        const row = lines.get(Number(item.key)) as { lines: string | null } | undefined
        const marks = textMarks(row?.lines ?? null, parsed.text)
        if (marks) item.marks = marks
      }
    }
    return items
  }

  /**
   * Read every vault's photos for search, newest first, one vault at a time.
   * Runs after thumbnails, survives restarts (the job queue), and only ever
   * touches visible items.
   */
  private runSearchIndex(): Promise<void> {
    const stages = this.stages()
    if ((!stages.embed && !stages.ocr && !stages.faces) || this.stopping || this.thumbnailRun) return Promise.resolve()
    if (this.searchRun) return this.searchRun
    this.searchRun = this.runSearchIndexImpl().finally(() => {
      this.searchRun = null
      this.searchIndexing = null
      this.publish(true)
    })
    return this.searchRun
  }

  private async runSearchIndexImpl() {
    const stages = this.stages()
    try {
      for (;;) {
        if (this.stopping || this.thumbnailRun) return
        const v = [...this.vaults.values()].find((x) => {
          if (this.closingVaults.has(x.id) || this.savingVaults.has(x.id)) return false
          return queueSearchJobs(x.vault.db, x.queue, stages) > 0
        })
        if (!v) {
          // Everything read: the closer look, when it is on.
          if (await this.runDeepOnce()) continue
          return
        }
        const abort = new AbortController()
        let faced = 0
        const progress = (job?: { kind: string }) => {
          if (!this.vaults.has(v.id)) return
          this.searchIndexing = { vault: v.vault.manifest.name, step: 'reading', ...indexProgress(v.vault.db, stages) }
          this.publish()
          // People appear while the library is still being read, not only at the end.
          if (job?.kind === 'faces' && ++faced % 250 === 0) void this.settle(v)
        }
        progress()
        const done = runSearchJobs(v.vault.db, v.queue, v.vault.layout.cache, stages, { signal: abort.signal, onSettled: progress, rest: () => this.rest(), yieldTo: () => this.yieldTo() })
        this.searchDrain = { vault: v.id, abort, done }
        try {
          await done
        } finally {
          if (this.searchDrain?.done === done) this.searchDrain = null
        }
        if (stages.faces) await this.settle(v, true)
        if (abort.signal.aborted) return
      }
    } catch (e) {
      console.error('search indexing stopped:', (e as Error).message)
    }
  }

  /**
   * Look closely at one vault's photos, after the first pass is done
   * everywhere (deep.ts), then group again. False when there is nothing to do.
   */
  private async runDeepOnce(): Promise<boolean> {
    const stages = this.deepStages()
    if (!stages || this.stopping || this.thumbnailRun) return false
    const v = [...this.vaults.values()].find((x) => {
      if (this.closingVaults.has(x.id) || this.savingVaults.has(x.id)) return false
      return queueDeep(x.vault.db, x.queue, stages) > 0
    })
    if (!v) return false
    const abort = new AbortController()
    let faced = 0
    const progress = () => {
      if (!this.vaults.has(v.id)) return
      this.searchIndexing = { vault: v.vault.manifest.name, step: 'deep', ...deepProgress(v.vault.db, stages) }
      this.publish()
      // New faces become people as they are found, not only at the end.
      if (stages.faces && ++faced % 250 === 0) void this.settle(v)
    }
    progress()
    const done = runDeep(v.vault.db, v.queue, v.vault.layout.media, v.vault.layout.cache, { heic: this.heic, stages }, {
      signal: abort.signal,
      onSettled: progress,
      rest: () => this.rest(),
      yieldTo: () => this.yieldTo(),
    })
    this.searchDrain = { vault: v.id, abort, done }
    try {
      await done
    } finally {
      if (this.searchDrain?.done === done) this.searchDrain = null
    }
    if (stages.faces) await this.settle(v, true)
    return !abort.signal.aborted
  }

  private async runThumbnailsImpl() {
    if (this.thumbsRunning || this.stopping) return
    this.thumbsRunning = true
    try {
      for (; !this.stopping;) {
        const pending: VaultEntry[] = []
        for (const v of [...this.vaults.values()]) {
          if (this.closingVaults.has(v.id)) continue
          v.queue.recover(THUMBNAIL)
          v.queue.enqueueAll(THUMBNAIL)
          // Thumbnails deleted from the cache: checked once per vault per
          // session, in batches, not on every pass (see requeueMissingThumbnails).
          if (!this.thumbCacheChecked.has(v.vault)) {
            this.thumbCacheChecked.add(v.vault)
            await requeueMissingThumbnails(v.vault.db, v.queue, v.vault.layout.cache)
            if (!this.vaults.has(v.id)) continue
          }
          if (v.queue.counts(THUMBNAIL).queued > 0) pending.push(v)
        }
        if (!pending.length) break
        for (const v of pending) {
          if (!this.vaults.has(v.id) || this.closingVaults.has(v.id)) continue
          const c = v.queue.counts(THUMBNAIL)
          const base = c.done
          const total = c.done + c.queued
          this.thumbs = { done: base, total }
          this.publish()
          const abort = new AbortController()
          const host = this.renderHost
          const done = runThumbnails(v.vault.db, v.queue, v.vault.layout.media, v.vault.layout.cache,
            { heic: this.heic, render: host ? (r) => host.render(r) : undefined }, {
            concurrency: this.heic.size + 1,
            signal: abort.signal,
            rest: () => this.rest(),
            yieldTo: () => this.yieldTo(),
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

  /**
   * Every vault to open, including ones on drives that aren't plugged in
   * now. They used to be dropped here, and the next save of the list forgot
   * them: starting Theia without the drive lost the vault from the sidebar.
   */
  private loadVaultList(): { root: string; name?: string }[] {
    try {
      const s = JSON.parse(fs.readFileSync(this.settingsPath(), 'utf8')) as { vaults?: string[]; names?: Record<string, string> }
      if (Array.isArray(s.vaults)) return s.vaults.filter((p) => typeof p === 'string').map((root) => ({ root, name: s.names?.[root] }))
    } catch {
      /* first run */
    }
    // First run: open the library the import made, if there is one.
    return isVault(DEFAULT_LIBRARY) ? [{ root: DEFAULT_LIBRARY }] : []
  }

  private saveVaultList() {
    const names: Record<string, string> = {}
    for (const v of this.vaults.values()) names[v.vault.layout.root] = v.vault.manifest.name
    for (const o of this.offline.values()) names[o.root] ??= o.name
    fs.mkdirSync(this.deps.userData, { recursive: true })
    // Atomically: a crash or a full disk mid-write must not lose the list.
    const file = this.settingsPath()
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ vaults: Object.keys(names), names }, null, 2))
    fs.renameSync(tmp, file)
  }

  /* ---------------------------------------------------------------- drives */

  /**
   * Notice drives unplugged or plugged back in. Every few seconds, and at
   * once on any error that may mean one: a vault whose folder can no longer be
   * reached is closed cleanly (its background work stopped, its database
   * closed) instead of every timer and query failing on it with SQLite
   * errors, which is what brought the whole app down.
   */
  checkDrives(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (this.drivesChecking) return this.drivesChecking
    this.drivesChecking = (async () => {
      for (const v of [...this.vaults.values()]) {
        if ((await reachable(path.join(v.vault.layout.root, '.vault'))) === false) this.disconnectVault(v)
      }
      for (const o of [...this.offline.values()]) {
        if (this.stopping) return
        if ((await reachable(o.root)) === true && isVault(o.root)) this.reconnectVault(o)
      }
    })()
      .catch((e) => console.warn('drive check:', (e as Error).message))
      .finally(() => { this.drivesChecking = null })
    return this.drivesChecking
  }

  private disconnectVault(v: VaultEntry) {
    if (this.vaults.get(v.id) !== v) return
    const root = v.vault.layout.root
    const name = v.vault.manifest.name
    console.warn(`vault ${name}: ${root} can't be reached; closed until its drive is back`)
    // First, so nothing else starts on it.
    this.vaults.delete(v.id)
    this.offline.set(root, { root, name })
    this.thumbDrains.get(v.id)?.abort.abort()
    if (this.searchDrain?.vault === v.id) this.searchDrain.abort.abort()
    if (this.savingVaults.has(v.id)) this.saveAbort?.abort()
    v.privateKey = null
    v.generation++
    for (const k of [...this.privateCache.keys()]) if (k.startsWith(`${v.id}|`)) this.privateCache.delete(k)
    try { v.vault.db.close() } catch { /* the file is already gone */ }
    this.publish(true)
  }

  private reconnectVault(o: OfflineVaultInfo) {
    try {
      const entry = this.addVault(o.root)
      this.offline.delete(o.root)
      console.warn(`vault ${entry.vault.manifest.name}: its drive is back`)
      this.publish(true)
      void this.runThumbnails()
    } catch (e) {
      // Still mounting, or busy: the next check tries again.
      console.warn(`vault ${o.root} is back but can't be opened yet:`, (e as Error).message)
    }
  }

  /** Stop offering a vault whose drive is gone for good. Its files are not touched. */
  forgetVault(root: string) {
    if (!this.offline.delete(root)) return
    this.saveVaultList()
    this.publish(true)
  }

  /** What went wrong with a save, said plainly when the vault's drive was unplugged during it. */
  private async saveError(target: VaultEntry, e: unknown): Promise<string> {
    await this.checkDrives()
    if (this.vaults.has(target.id)) return (e as Error).message
    return `The drive with “${target.vault.manifest.name}” was disconnected during the save. What was saved before then is in the vault (the last few items may need saving again), and no originals were deleted. Plug the drive back in and save again to finish.`
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

const DRIVE_CHECK_MS = 3000

/** A folder name from the window: trimmed, not empty, not absurdly long. */
function folderName(name: unknown): string {
  const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
  if (!clean) throw new Error('Give the folder a name.')
  if (clean.length > 80) throw new Error('Use a shorter name (80 characters at most).')
  return clean
}

function folderId(folder: unknown): number {
  const m = typeof folder === 'string' ? /^hidden:(\d+)$/.exec(folder) : null
  if (!m) throw new Error('That is not a folder in Hidden.')
  return Number(m[1])
}

/** Whether the drive a folder is on is plugged in (its root exists), as against the folder being gone. */
function driveThere(folder: string): boolean {
  return fs.existsSync(path.parse(path.resolve(folder)).root)
}

/**
 * Whether a path can be reached. Null when it doesn't answer within a few
 * seconds: a sleeping hard drive spinning up is slow, not unplugged.
 */
function reachable(file: string, ms = 5000): Promise<boolean | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    fs.promises.access(file).then(
      () => { clearTimeout(timer); resolve(true) },
      () => { clearTimeout(timer); resolve(false) },
    )
  })
}

function fileExists(file: string): Promise<boolean> {
  return fs.promises.access(file).then(() => true, () => false)
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]/g, '_')
}

/** `name` in `dir`, or "name (2)" and so on when that is taken. */
function freeTarget(dir: string, name: string): string {
  const { name: stem, ext } = path.parse(name)
  let target = path.join(dir, name)
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${stem} (${n})${ext}`)
  return target
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
