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

/** Someone found in a vault's photos. */
export interface PersonInfo {
  id: number
  /** Null until someone names them. */
  name: string | null
  hidden: boolean
  /** 'object': a statue, carving or drawing, hidden by itself. */
  kind: 'person' | 'object'
  /** Photos with them in. */
  photos: number
  /** A face id to show for them (mediaUrl(source, String(cover), 'face')). */
  cover: number | null
  /** Photos that might be them too, to answer yes or no (found by the closer look). */
  maybe: number
}

/** A face that might be someone named: its picture, the photo, and how alike. */
export interface MaybeFace {
  face: number
  assetId: number
  score: number
}

export const PERSON_PREFIX = 'person:'
export const personCollection = (id: number) => `${PERSON_PREFIX}${id}`
export function personOf(collection: string): number | null {
  return collection.startsWith(PERSON_PREFIX) ? Number(collection.slice(PERSON_PREFIX.length)) : null
}

/** `device:<udid>` or `vault:<id>`. */
export type SourceId = string

export interface DeviceInfo {
  id: SourceId
  udid: string
  /** iPhones are read over Apple's own connection; Android phones through Windows' portable devices. */
  platform: 'iphone' | 'android'
  name: string
  state: 'opening' | 'ready' | 'problem'
  error: string | null
  count: number | null
  scanChecked?: number
  indexing?: boolean
  indexError?: boolean
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

/** A vault whose drive isn't plugged in: it opens again by itself when the drive is back. */
export interface OfflineVaultInfo {
  root: string
  name: string
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
      phase?: 'copying' | 'verifying' | 'finishing' | 'checking-deletion' | 'deleting' | 'recycling-originals'
      current: string | null
    }
  | {
      status: 'done'
      target: string
      saved: number
      alreadyThere: number
      /** Saved again over the copy already there (also counted in saved). */
      replaced?: number
      skippedCloud: number
      failed: { item: string; file: string; reason: string }[]
      cancelled: boolean
      /** What was deleted at the source afterwards: from the iPhone, or originals from a folder (to the Recycle Bin). */
      cleanup?: { from?: 'iphone' | 'folder'; deleted: number; kept: number; reasons: { item: string; reason: string }[] }
    }
  | { status: 'error'; target: string; error: string }

export interface AppState {
  settings: AppSettings
  devices: DeviceInfo[]
  vaults: VaultInfo[]
  /** Vaults on drives that aren't connected now. */
  offlineVaults: OfflineVaultInfo[]
  /**
   * Why no phone can be opened, when Windows sees one but it is not usable,
   * or nothing is plugged in at all. Null while a phone is ready.
   */
  diagnosis: Diagnosis | null
  save: SaveState
  /** Thumbnails being made in the background, across vaults. */
  thumbnails: { done: number; total: number } | null
  /**
   * Search by meaning. `available` is false only when the bundled model is
   * missing (a development build without it). `indexing` is the vault whose
   * photos are being read for search right now, with how many are done.
   */
  search: {
    available: boolean
    /**
     * Search and people indexing of one vault, by step: reading every photo
     * (search by meaning, text, faces), then grouping faces into people.
     * 'deep': the optional closer look, after both (Settings). Null when there
     * is nothing left to do.
     */
    indexing: { vault: string; step: 'reading' | 'people' | 'deep'; done: number; total: number } | null
    /** Where search by meaning and text reading run: the graphics card, the processor, or not decided yet. */
    devices: { embed: 'gpu' | 'cpu' | null; ocr: 'gpu' | 'cpu' | null }
    /** Faces are being grouped into people (bundled models, and switched on in Settings). */
    people: boolean
    /** Changes when people are found, named, merged or changed. */
    peopleRevision: number
  }
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

/**
 * The name typed to confirm deleting a vault. Case and surrounding spaces
 * don't matter: it confirms intent, it isn't a password.
 */
export function sameVaultName(typed: string, name: string): boolean {
  const norm = (s: string) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
  return norm(typed) !== '' && norm(typed) === norm(name)
}

/** Search results are a collection like any other, so the grid, viewer and selection all work on them. */
export const SEARCH_PREFIX = 'search:'
export const searchCollection = (query: string) => SEARCH_PREFIX + query.trim()
export const searchQueryOf = (collection: string) => (collection.startsWith(SEARCH_PREFIX) ? collection.slice(SEARCH_PREFIX.length) : null)

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
  /** Items the vault already has: leave them (default), or save them again over the old copy. */
  duplicates?: 'skip' | 'replace'
}

/** What the window may ask for. */
export interface PhotosApi {
  setSettings(settings: Partial<AppSettings>): Promise<AppSettings>
  editPreview(source: SourceId, key: string, recipe: EditRecipe): Promise<string>
  saveEditedCopy(source: SourceId, key: string, recipe: EditRecipe): Promise<string>
  getState(): Promise<AppState>
  onState(listener: (state: AppState) => void): () => void
  /** The person is scrolling: background indexing holds off for a moment. */
  userActive(): Promise<void>
  /** Stop listing a vault whose drive isn't connected. Nothing on the drive is touched. */
  forgetVault(root: string): Promise<void>
  /** Folders inside Hidden, all opened with the vault's passcode. Hidden must be unlocked. Returns the new folder's collection id. */
  createHiddenFolder(source: SourceId, name: string): Promise<string>
  renameHiddenFolder(source: SourceId, folder: string, name: string): Promise<void>
  /** Removes the folder; its items stay in Hidden. */
  deleteHiddenFolder(source: SourceId, folder: string): Promise<void>
  /** Hidden items into a folder, or out of any folder (null). */
  moveToHiddenFolder(source: SourceId, keys: string[], folder: string | null): Promise<number>

  collections(source: SourceId): Promise<Collections>
  /** A collection's items, or a search's results, best first, for `searchCollection(query)`. */
  items(source: SourceId, collection: string, page?: { fromEnd: number; limit: number }): Promise<GalleryItem[]>
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
  /** How many of these items the target vault already has. 0 for a new vault. */
  countDuplicates(request: SaveRequest): Promise<number>
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
  openAppleDevices(): Promise<void>
  /** Open the place in the browser, on OpenStreetMap. */
  openMap(lat: number, lon: number): Promise<void>

  /** People in a vault: named first, then groups waiting for a name. Items: personCollection(id). */
  people(source: SourceId, includeHidden?: boolean): Promise<PersonInfo[]>
  person(source: SourceId, id: number): Promise<PersonInfo | null>
  /** Name or rename; '' clears. A name someone else has merges the two, into them. */
  namePerson(source: SourceId, id: number, name: string): Promise<{ person: number; merged: boolean }>
  /** "Not this person": these photos leave them and are never put back. */
  removeFromPerson(source: SourceId, id: number, keys: string[]): Promise<number>
  /**
   * Add photos and videos from a folder on this computer to a vault. Resolves
   * once the folder is read; the copying carries on in the status bar.
   */
  addFolderToVault(vaultId?: SourceId, folderPath?: string, opts?: { deleteSources?: boolean }): Promise<{ count: number; vaultName: string } | null>
  /** Add chosen or dropped files and folders to a vault, the same way. */
  addFilesToVault(vaultId?: SourceId, filePaths?: string[], opts?: { deleteSources?: boolean }): Promise<{ count: number; vaultName: string } | null>
  /** Where a file dropped on the window is on disk. Electron no longer puts it on File itself. */
  pathForFile(file: File): string
  /** Copy, as File Explorer does: the files, and the picture too for a single photo. */
  copyItems(source: SourceId, keys: string[]): Promise<void>
  /** "Copy as path": each original's path in quotes, one per line. Vaults only. */
  itemPaths(source: SourceId, keys: string[]): Promise<string>
  /** The Windows share sheet, over `at` (a point on screen). Resolves when it is up. */
  shareItems(source: SourceId, keys: string[], at: { x: number; y: number }): Promise<void>
  /** The Windows print dialog for one photo. */
  printItem(source: SourceId, key: string): Promise<void>
  /** A copy of the originals elsewhere: Save As for one, a folder for several. Where, or null if cancelled. */
  saveItemsAs(source: SourceId, keys: string[]): Promise<string | null>
  /** The apps Windows offers for the item's file, its default first. */
  openWithChoices(source: SourceId, key: string): Promise<{ id: string; label: string }[]>
  /** Open in another app: an id from openWithChoices, or 'choose' for Windows' own picker. */
  openItemWith(source: SourceId, key: string, id: string): Promise<void>
  /** Desktop background or lock screen picture. */
  setItemAs(source: SourceId, key: string, where: 'desktop' | 'lock'): Promise<void>
  /** A resized copy, saved where the person chooses. Where, or null if cancelled. */
  resizeItem(source: SourceId, key: string, opts: { width: number; height: number; format: 'jpeg' | 'png' | 'webp'; quality: number }): Promise<string | null>
  /** This person's faces in visible photos, clearest first: what their picture can be chosen from. */
  personFaces(source: SourceId, id: number): Promise<{ face: number; assetId: number }[]>
  /** Show this face as their picture (null: let Theia choose). */
  setPersonCover(source: SourceId, id: number, face: number | null): Promise<void>
  /** Show their face in this photo as their picture. */
  setPersonCoverFromPhoto(source: SourceId, id: number, key: string): Promise<void>
  /** Faces that might be this person, found by the closer look, most alike first. */
  personMaybes(source: SourceId, id: number): Promise<MaybeFace[]>
  /** Yes adds those faces to the person; no keeps them out for good. Resolves to how many were added. */
  answerMaybes(source: SourceId, id: number, yes: number[], no: number[]): Promise<number>
  /** Leave someone out of People (a stranger in the background). */
  hidePerson(source: SourceId, id: number, hidden: boolean): Promise<void>
  /** Groups that might be the same person as someone else, to ask about. */
  peopleSuggestions(source: SourceId): Promise<{ person: PersonInfo; other: PersonInfo; score: number }[]>
  /** Same merges them (into the named one); different is remembered. Returns who they are now. */
  answerSuggestion(source: SourceId, a: number, b: number, same: boolean): Promise<number>
}

export const STATE_CHANNEL = 'photos:state'
export const INVOKE_CHANNELS = [
  'setSettings',
  'userActive',
  'forgetVault',
  'createHiddenFolder',
  'renameHiddenFolder',
  'deleteHiddenFolder',
  'moveToHiddenFolder',
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
  'addFolderToVault',
  'addFilesToVault',
  'personFaces',
  'setPersonCover',
  'setPersonCoverFromPhoto',
  'personMaybes',
  'answerMaybes',
  'copyItems',
  'itemPaths',
  'shareItems',
  'printItem',
  'saveItemsAs',
  'openWithChoices',
  'openItemWith',
  'setItemAs',
  'resizeItem',
  'vaultDetails',
  'setUpProtection',
  'unlockVault',
  'lockVault',
  'changeVaultPasscode',
  'revealVault',
  'deleteVault',
  'save',
  'countDuplicates',
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
  'people',
  'person',
  'namePerson',
  'removeFromPerson',
  'hidePerson',
  'peopleSuggestions',
  'answerSuggestion',
  'retryDevice',
  'openAppleDevices',
  'openMap',
] as const satisfies readonly Exclude<keyof PhotosApi, 'onState'>[]

/** The custom scheme thumbnails, full images and videos are served on. */
export const MEDIA_SCHEME = 'photos-media'

export function mediaUrl(source: SourceId, key: string, what: 'sm' | 'lg' | 'ph' | 'full' | 'video' | 'motion' | 'storyboard' | 'face'): string {
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
