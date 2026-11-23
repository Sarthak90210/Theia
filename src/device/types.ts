/**
 * The one deliberate seam in the system.
 *
 * Everything above this interface is transport-agnostic. AFC implements it, the
 * MTP fallback will implement it, and the test fake implements it with the
 * ability to misbehave on demand. Nothing above here knows which it is talking
 * to, which is what lets the entire import pipeline be tested without a phone.
 *
 * Keep it narrow. Every method added here is a method the fake has to fake
 * convincingly, and a narrow seam is what makes the fake credible.
 */

export interface DeviceIdentity {
  udid: string
  name: string
  model: string
  osVersion: string
}

export interface DeviceFile {
  /** Absolute path as the device sees it, e.g. /DCIM/105APPLE/IMG_5355.HEIC */
  path: string
  size: number
  mtimeMs: number
  isDirectory: boolean
}

/**
 * An open file on the device. Ranged reads are the whole point: they are what
 * makes a failed transfer resumable instead of restartable.
 */
export interface DeviceHandle {
  /**
   * Reads up to `length` bytes from the current offset. A short read is legal
   * and does not mean end of file; only a zero-length result does.
   */
  read(length: number): Promise<Buffer>
  seek(offset: number): Promise<void>
  close(): Promise<void>
}

export interface DeviceSource {
  identity(): Promise<DeviceIdentity>
  freeBytes(): Promise<number>
  /** Names within a directory, without "." and "..". */
  list(dir: string): Promise<string[]>
  stat(path: string): Promise<DeviceFile>
  open(path: string): Promise<DeviceHandle>
  dispose(): Promise<void>
  /**
   * Optional: every media file under some folders, in one request. Android
   * phones answer this, because over MTP a round trip per file takes minutes
   * for a big camera roll. Without it, scanMedia walks with list and stat.
   */
  scan?(request: ScanRequest): Promise<ScanResult>
  /** Optional: the device's own small preview of a file, or null when it has none. */
  thumbnail?(path: string): Promise<Buffer | null>
}

export interface ScanRequest {
  /** Folders to look in, relative to each storage, e.g. "DCIM" or "Android/media/com.whatsapp/WhatsApp/Media". */
  roots: string[]
  /** Folder names never to enter. */
  skip: string[]
  /** File extensions to report, with the dot. */
  extensions: string[]
}

export interface ScannedFile {
  /** e.g. /Internal shared storage/DCIM/Camera/PXL_20240501_101500123.jpg */
  path: string
  size: number
  mtimeMs: number
  /** When the device says the file was made, or 0 when it doesn't. */
  ctimeMs: number
}

export interface ScanResult {
  /** The storages the device exposed: none at all usually means it is locked. */
  storages: string[]
  /** How many of the requested folders exist: none means a device with no photos to show (a watch, a player). */
  folders: number
  files: ScannedFile[]
}

/** Thrown when the device goes away mid-operation, as opposed to refusing one. */
export class DeviceDetachedError extends Error {
  constructor(message = 'device detached') {
    super(message)
    this.name = 'DeviceDetachedError'
  }
}
