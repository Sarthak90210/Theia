import { IMAGE_CACHE_VERSION } from '../../src/thumbs/version.ts'
import type { AppSettings } from './settings.ts'
export type { AppSettings } from './settings.ts'
import type { EditRecipe } from '../../src/media/edit-recipe.ts'
export type { EditRecipe }
/**
 * The contract between the main process and the window.
 *
 * The main process owns the phones, the vaults and their databases. The window
 * shows what it is given and sends commands. Every channel is listed here
 * once, so the preload bridge, the main handlers and the UI cannot drift apart
 * without the compiler noticing. Types only.
 */

import type { Collections, GalleryItem, ItemDetail } from '../../src/gallery/types.ts'
import type { Diagnosis } from '../../src/device/diagnose.ts'

export type { Collections, GalleryItem, ItemDetail, Diagnosis }

/** `device:<udid>` or `vault:<id>`. */
export type SourceId = string

export interface DeviceInfo {
  id: SourceId
  udid: string
  name: string
  state: 'opening' | 'ready' | 'problem'
  error: string | null
  count: number | null
}

export interface VaultInfo {
  id: SourceId
  name: string
  root: string
  count: number
  /** album: made by this app. library: an import library opened as a vault. */
  kind: 'album' | 'library'
  /** Goes up on any change to the vault's contents, so the window reloads. */
  revision: number
  /** Hidden and Recently Deleted: no passcode yet, locked, or open. */
  protection: 'off' | 'locked' | 'unlocked'
  protectionError?: string | null
}

export type SaveState =
  | { status: 'idle' }
  | {
      status: 'running'
      target: string
      itemsDone: number
      itemsTotal: number
      bytesDone: number
      /** Null until every remaining file's size is known. */
      bytesTotal?: number | null
      bytesPerSecond?: number
      /** Time left for the copy and its read-back check. Null while estimating. */
      etaMs?: number | null
      phase?: 'copying' | 'verifying' | 'finishing' | 'checking-deletion' | 'deleting'
      current: string | null
    }
  | {
      status: 'done'
      target: string
      saved: number
      alreadyThere: number
      skippedCloud: number
      failed: { item: string; file: string; reason: string }[]
      cancelled: boolean
      cleanup?: { deleted: number; kept: number; reasons: { item: string; reason: string }[] }
    }
  | { status: 'error'; target: string; error: string }

export interface AppState {
  settings: AppSettings
  devices: DeviceInfo[]
  vaults: VaultInfo[]
  /**
   * Why no phone can be opened, when Windows sees one but it is not usable,
   * or nothing is plugged in at all. Null while a phone is ready.
   */
  diagnosis: Diagnosis | null
  save: SaveState
  /** Thumbnails being made in the background, across vaults. */
  thumbnails: { done: number; total: number } | null
  /** A video being made playable: copied off the phone, then converted. */
  converting: { source: SourceId; key: string; stage: 'copying' | 'converting'; progress: number | null } | null
}

export interface StoryboardInfo {
  cols: number
  rows: number
  count: number
  interval: number
  width: number
  height: number
}

export interface VaultDetails {
  id: SourceId
  name: string
  /** The folder on disk. */
  root: string
  kind: 'album' | 'library'
  count: number
  /** Everything in the folder, the app's own cache included. */
  bytes: number
  /**
   * Whether the whole folder fits in this drive's Recycle Bin. Windows deletes
   * anything bigger for good, without asking, so Theia checks first. Null when
   * the limit couldn't be read.
   */
  fitsRecycleBin: boolean | null
  recycleBinMax: number | null
}

export type SaveTarget = { vault: SourceId } | { newVault: true }

export interface SaveRequest {
  source: SourceId
  /** Explicitly opted in for this save, after a deletion warning. iPhone only. */
  deleteAfterSave?: boolean
  /** Save the selected burst frames as individual photos. */
  framesOnly?: boolean
  /** Items to save, by key. */
  keys: string[]
  target: SaveTarget
}

/** What the window may ask for. */
export interface PhotosApi {
  setSettings(settings: Partial<AppSettings>): Promise<AppSettings>
  editPreview(source: SourceId, key: string, recipe: EditRecipe): Promise<string>
  saveEditedCopy(source: SourceId, key: string, recipe: EditRecipe): Promise<string>
  getState(): Promise<AppState>
  onState(listener: (state: AppState) => void): () => void

  collections(source: SourceId): Promise<Collections>
  items(source: SourceId, collection: string): Promise<GalleryItem[]>
  detail(source: SourceId, key: string): Promise<ItemDetail | null>
  /**
   * Make a video playable, converting it first if the window can't play it as
   * it is. `force` converts even a file that should play, for when it didn't.
   */
  playback(source: SourceId, key: string, force?: boolean): Promise<{ ok: true } | { ok: false; error: string }>
  /** Preview frames for the scrub bar, or null when there are none yet. */
  storyboard(source: SourceId, key: string): Promise<StoryboardInfo | null>
  /** Keys of every frame of a burst, in order, usable wherever an item key is. */
  burstFrames(source: SourceId, key: string): Promise<{ frames: string[]; cover: string }>

  /** Folder picker: an empty folder becomes a new vault, a vault folder opens. */
  openVault(): Promise<SourceId | null>
  closeVault(id: SourceId): Promise<void>
  vaultDetails(id: SourceId): Promise<VaultDetails>
  /**
   * Hidden and Recently Deleted are encrypted. Setting a passcode returns a
   * recovery key, shown once: the only other way in.
   */
  setUpProtection(id: SourceId, passcode: string): Promise<string>
  /** With the passcode or the recovery key. */
  unlockVault(id: SourceId, secret: string): Promise<void>
  lockVault(id: SourceId): Promise<void>
  changeVaultPasscode(id: SourceId, current: string, next: string): Promise<void>
  /** Open the vault's folder in File Explorer. */
  revealVault(id: SourceId): Promise<void>
  /**
   * Delete a vault and everything in it. `confirmName` must be the vault's
   * name, typed. 'recycle' refuses a vault too big for the Recycle Bin;
   * 'permanent' is for exactly that case, chosen knowingly.
   */
  deleteVault(id: SourceId, confirmName: string, mode: 'recycle' | 'permanent'): Promise<void>

  save(request: SaveRequest): Promise<void>
  cancelSave(): Promise<void>
  dismissSave(): Promise<void>

  /**
   * Changes to a vault. Phones are read-only and refuse these.
   * delete: to Recently Deleted. deleteForever: from there to the Windows
   * Recycle Bin. Each returns how many items changed.
   */
  remove(source: SourceId, keys: string[]): Promise<number>
  restore(source: SourceId, keys: string[]): Promise<number>
  deleteForever(source: SourceId, keys: string[]): Promise<{ removed: number; failed: number }>
  setHidden(source: SourceId, keys: string[], hidden: boolean): Promise<number>
  /** Bursts in a vault. Frames are named as burstFrames() returns them. */
  setBurstCover(source: SourceId, key: string, frameKey: string): Promise<void>
  keepBurstFrame(source: SourceId, key: string, frameKey: string): Promise<string>
  setFavourite(source: SourceId, keys: string[], favourite: boolean): Promise<number>

  /** Show the item's original in File Explorer (vaults) or open it (phones). */
  reveal(source: SourceId, key: string): Promise<void>
  /** Open a video the window cannot play in the system player. */
  openExternally(source: SourceId, key: string): Promise<void>
  retryDevice(id: SourceId): Promise<void>
  /** Open the place in the browser, on OpenStreetMap. */
  openMap(lat: number, lon: number): Promise<void>
}

export const STATE_CHANNEL = 'photos:state'
export const INVOKE_CHANNELS = [
  'setSettings',
  'editPreview',
  'saveEditedCopy',
  'getState',
  'collections',
  'items',
  'detail',
  'burstFrames',
  'playback',
  'storyboard',
  'openVault',
  'closeVault',
  'vaultDetails',
  'setUpProtection',
  'unlockVault',
  'lockVault',
  'changeVaultPasscode',
  'revealVault',
  'deleteVault',
  'save',
  'cancelSave',
  'dismissSave',
  'remove',
  'restore',
  'deleteForever',
  'setHidden',
  'setBurstCover',
  'keepBurstFrame',
  'setFavourite',
  'reveal',
  'openExternally',
  'retryDevice',
  'openMap',
] as const satisfies readonly Exclude<keyof PhotosApi, 'onState'>[]

/** The custom scheme thumbnails, full images and videos are served on. */
export const MEDIA_SCHEME = 'photos-media'

export function mediaUrl(source: SourceId, key: string, what: 'sm' | 'lg' | 'ph' | 'full' | 'video' | 'motion' | 'storyboard'): string {
  return `${MEDIA_SCHEME}://media/${encodeURIComponent(source)}/${what}/${encodeURIComponent(key)}?v=${IMAGE_CACHE_VERSION}`
}

/** A 256 px OpenStreetMap tile, fetched and cached by the main process. */
export function mapTileUrl(z: number, x: number, y: number): string {
  return `${MEDIA_SCHEME}://map/${z}/${x}/${y}`
}

declare global {
  interface Window {
    photos: PhotosApi
  }
}
