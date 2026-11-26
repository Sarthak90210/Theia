import { createHash } from 'node:crypto'
import { MtpBridge, MtpError, type BridgeProcess } from './mtp-bridge.ts'
import {
  DeviceDetachedError,
  type DeviceFile,
  type DeviceHandle,
  type DeviceIdentity,
  type DeviceSource,
  type ScanRequest,
  type ScanResult,
} from './types.ts'

/**
 * Android phones (and cameras that speak MTP or PTP), through Windows
 * Portable Devices. The same seam as the iPhone's AFC transport, so the
 * gallery, viewer and save code do not know which they are talking to.
 *
 * Read only. Nothing here can write to or delete from a phone.
 */

export interface MtpOpenInfo {
  name: string
  model: string
  manufacturer: string
  serial: string
  firmware: string
  storages: string[]
}

class MtpHandle implements DeviceHandle {
  private closed = false
  constructor(
    private readonly bridge: MtpBridge,
    private readonly handle: number,
  ) {}

  async read(length: number): Promise<Buffer> {
    return (await this.bridge.request('read', { handle: this.handle, length })).data
  }

  async seek(offset: number): Promise<void> {
    await this.bridge.call('seek', { handle: this.handle, offset })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.bridge.call('close-file', { handle: this.handle }).catch(() => {})
  }
}

export class MtpDevice implements DeviceSource {
  private constructor(
    private readonly bridge: MtpBridge,
    readonly id: string,
    readonly info: MtpOpenInfo,
  ) {}

  /**
   * Connect to one phone on a bridge of its own. Throws while the phone shows
   * no storage, which is what a locked phone, or one not set to File
   * transfer, looks like.
   */
  static async connect(bridge: MtpBridge, id: string, wpdId: string): Promise<MtpDevice> {
    const info = await bridge.call<MtpOpenInfo>('open', { deviceId: wpdId })
    if (!info.storages.length) throw new Error(NO_STORAGE)
    return new MtpDevice(bridge, id, info)
  }

  async identity(): Promise<DeviceIdentity> {
    return {
      udid: this.id,
      name: this.info.name || this.info.model || 'Android phone',
      model: [this.info.manufacturer, this.info.model].filter(Boolean).join(' '),
      osVersion: this.info.firmware,
    }
  }

  async freeBytes(): Promise<number> {
    return Number(await this.call('free'))
  }

  async list(dir: string): Promise<string[]> {
    return this.call<string[]>('list', { path: dir })
  }

  async stat(path: string): Promise<DeviceFile> {
    const st = await this.call<{ size: number; mtimeMs: number; isDirectory: boolean }>('stat', { path })
    return { path, size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory }
  }

  async open(path: string): Promise<DeviceHandle> {
    const { handle } = await this.call<{ handle: number; size: number }>('open-file', { path })
    return new MtpHandle(this.bridge, handle)
  }

  async scan(request: ScanRequest, onProgress?: (checked: number) => void): Promise<ScanResult> {
    return this.bridge.call<ScanResult>('scan', { ...request }, onProgress)
  }

  async thumbnail(path: string): Promise<Buffer | null> {
    try {
      const { data } = await this.bridge.request('thumb', { path })
      return data.length ? data : null
    } catch (e) {
      if (e instanceof DeviceDetachedError) throw e
      return null
    }
  }

  async dispose(): Promise<void> {
    await this.bridge.close()
  }

  private call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.bridge.call<T>(op, args)
  }
}

const NO_STORAGE =
  "The phone isn't sharing its files. Unlock it, then tap the USB notification and choose File transfer."

/** One entry from Windows' device list. */
export interface WpdDeviceEntry {
  deviceId: string
  name: string
  description: string
  manufacturer: string
}

/**
 * A plugged-in USB device Windows reaches through WPD that isn't an Apple
 * device (those go through AFC) and isn't a drive (those have a drive letter).
 * Phones in File transfer or PTP mode, and cameras.
 */
export function isAndroidCandidate(d: WpdDeviceEntry): boolean {
  const id = d.deviceId.toLowerCase()
  if (!id.startsWith('\\\\?\\usb#')) return false
  if (/vid_05ac/.test(id) || /^apple/i.test(d.manufacturer)) return false
  return true
}

/** A stable name for a phone, derived from Windows' path to it. */
export function androidId(wpdId: string): string {
  return `android-${createHash('sha1').update(wpdId.toLowerCase()).digest('hex').slice(0, 12)}`
}

export function isAndroidId(id: string): boolean {
  return id.startsWith('android-')
}

export interface AndroidPhonesOptions {
  spawn?: () => BridgeProcess
  /** True when Windows Portable Devices can be used at all. */
  available?: () => boolean
}

/**
 * The Android phones plugged in now. One helper process answers "what's
 * plugged in" for all of them; each phone opened for browsing or saving gets
 * a helper of its own, so a save never queues behind the gallery.
 */
export class AndroidPhones {
  private lister: MtpBridge | null = null
  private readonly seen = new Map<string, WpdDeviceEntry>()
  /** Opened fine but hold no photo folders (a watch, a music player): not listed again while plugged in. */
  private readonly ignored = new Set<string>()
  /** A connection kept between attempts, so a locked phone isn't a new process every few seconds. */
  private readonly pending = new Map<string, MtpBridge>()
  private warned = false

  constructor(private readonly opts: AndroidPhonesOptions = {}) {}

  private spawn(): MtpBridge {
    return MtpBridge.start(this.opts.spawn)
  }

  private available(): boolean {
    return this.opts.available ? this.opts.available() : process.platform === 'win32'
  }

  async list(): Promise<string[]> {
    if (!this.available()) return []
    let entries: WpdDeviceEntry[]
    try {
      if (!this.lister?.alive) this.lister = this.spawn()
      entries = await this.lister.call<WpdDeviceEntry[]>('devices')
    } catch (e) {
      if (!this.warned) console.warn('android phones:', (e as Error).message)
      this.warned = true
      // The lister stopped, not the phones: keep what was there, so an open
      // phone isn't closed under the person. A new lister starts next time.
      return [...this.seen.keys()].filter((id) => !this.ignored.has(id))
    }
    const present = new Set<string>()
    for (const d of entries) {
      if (!isAndroidCandidate(d)) continue
      const id = androidId(d.deviceId)
      present.add(id)
      this.seen.set(id, d)
    }
    for (const id of [...this.seen.keys()]) {
      if (present.has(id)) continue
      this.seen.delete(id)
      this.ignored.delete(id)
      const b = this.pending.get(id)
      this.pending.delete(id)
      void b?.close()
    }
    return [...present].filter((id) => !this.ignored.has(id))
  }

  /** What Windows calls it, before it has been opened. */
  nameOf(id: string): string | null {
    const d = this.seen.get(id)
    return d ? d.name || d.description || null : null
  }

  /** Opens the phone on a connection of its own. */
  async attach(id: string): Promise<MtpDevice> {
    const entry = this.seen.get(id)
    if (!entry) throw new Error('That phone is not connected any more.')
    let bridge = this.pending.get(id)
    if (!bridge?.alive) bridge = this.spawn()
    this.pending.delete(id)
    try {
      return await MtpDevice.connect(bridge, id, entry.deviceId)
    } catch (e) {
      // Kept for the next try: unlocking the phone is all it takes.
      if (bridge.alive && this.seen.has(id)) this.pending.set(id, bridge)
      else await bridge.close()
      throw e instanceof MtpError ? new Error(e.message) : e
    }
  }

  /** Stop offering a device that has nothing to show. */
  ignore(id: string) {
    this.ignored.add(id)
  }

  async close(): Promise<void> {
    const all = [this.lister, ...this.pending.values()].filter((b): b is MtpBridge => !!b)
    this.lister = null
    this.pending.clear()
    await Promise.all(all.map((b) => b.close().catch(() => {})))
  }
}
