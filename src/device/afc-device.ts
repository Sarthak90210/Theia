import { AfcClient, AfcError } from '../protocol/afc.ts'
import { LockdownClient, LOCKDOWN_PORT, TLS_STRATEGIES, type PairRecord } from '../protocol/lockdown.ts'
import { UsbmuxConnection } from '../protocol/usbmux.ts'
import { parsePlist } from '../protocol/plist-io.ts'
import {
  DeviceDetachedError,
  type DeviceFile,
  type DeviceHandle,
  type DeviceIdentity,
  type DeviceSource,
} from './types.ts'

/**
 * The real transport, behind the seam.
 *
 * Measured behaviour this relies on, see prototype/FINDINGS.md:
 *   - Node's default TLS options complete the lockdown handshake.
 *   - AFC needs no SSL of its own.
 *   - seek + read is byte-exact, so resume works.
 *   - One channel already saturates the link, so there is no channel pool here.
 */

export class AfcDeviceError extends Error {}

function isDetach(e: unknown): boolean {
  const m = (e as Error)?.message ?? ''
  return (
    e instanceof DeviceDetachedError ||
    /stream ended|ECONNRESET|EPIPE|lost framing|socket hang up/i.test(m) ||
    (e instanceof AfcError && /service not connected|io error/i.test(m))
  )
}

class AfcHandle implements DeviceHandle {
  constructor(
    private readonly client: AfcClient,
    private readonly handle: bigint,
  ) {}

  async read(length: number): Promise<Buffer> {
    try {
      return await this.client.read(this.handle, length)
    } catch (e) {
      throw isDetach(e) ? new DeviceDetachedError((e as Error).message) : e
    }
  }

  async seek(offset: number): Promise<void> {
    try {
      await this.client.seek(this.handle, BigInt(offset))
    } catch (e) {
      throw isDetach(e) ? new DeviceDetachedError((e as Error).message) : e
    }
  }

  async close(): Promise<void> {
    // A close that fails after the bytes are already read is not worth
    // failing the transfer over; the handle dies with the channel anyway.
    try {
      await this.client.close(this.handle)
    } catch {
      /* ignore */
    }
  }
}

export class AfcDevice implements DeviceSource {
  private constructor(
    private readonly afc: AfcClient,
    private readonly lockdown: LockdownClient,
    private readonly ident: DeviceIdentity,
  ) {}

  static async attach(udidFilter?: string): Promise<AfcDevice> {
    const mux = await UsbmuxConnection.open()
    let devices
    try {
      devices = await mux.listDevices()
    } finally {
      mux.close()
    }

    const entry = devices.find(
      (d) =>
        d.Properties.ConnectionType === 'USB' &&
        (!udidFilter || d.Properties.SerialNumber === udidFilter),
    )
    if (!entry) throw new AfcDeviceError('no USB device visible to usbmuxd')

    const deviceId = entry.Properties.DeviceID
    const udid = entry.Properties.SerialNumber

    const muxPair = await UsbmuxConnection.open()
    let pairData: Buffer | null
    try {
      pairData = await muxPair.readPairRecord(udid)
    } finally {
      muxPair.close()
    }
    if (!pairData) {
      throw new AfcDeviceError('device is not paired; unlock it and tap Trust')
    }
    const pair = parsePlist(pairData) as PairRecord

    const muxLock = await UsbmuxConnection.open()
    const lockdown = new LockdownClient(await muxLock.connectToPort(deviceId, LOCKDOWN_PORT))
    const type = await lockdown.queryType()
    if (type !== 'com.apple.mobile.lockdown') {
      throw new AfcDeviceError(`unexpected service type ${type}`)
    }

    const session = await lockdown.startSession(pair)
    if (session.ssl) {
      // Measured: the first strategy works on current iOS. The rest exist for
      // older pair records whose RSA keys OpenSSL 3 rejects by default.
      let upgraded = false
      let last: Error | null = null
      for (const strategy of TLS_STRATEGIES) {
        try {
          await lockdown.enableSSL(pair, strategy)
          upgraded = true
          break
        } catch (e) {
          last = e as Error
        }
      }
      if (!upgraded) {
        throw new AfcDeviceError(`TLS upgrade failed on every strategy: ${last?.message}`)
      }
    }

    const ident: DeviceIdentity = {
      udid,
      name: String(await lockdown.getValue('DeviceName')),
      model: String(await lockdown.getValue('ProductType')),
      osVersion: String(await lockdown.getValue('ProductVersion')),
    }

    const svc = await lockdown.startService('com.apple.afc')
    if (svc.ssl) throw new AfcDeviceError('AFC requested SSL, which is unsupported')
    const muxAfc = await UsbmuxConnection.open()
    const afc = new AfcClient(await muxAfc.connectToPort(deviceId, svc.port))

    return new AfcDevice(afc, lockdown, ident)
  }

  async identity(): Promise<DeviceIdentity> {
    return this.ident
  }

  async freeBytes(): Promise<number> {
    const info = await this.afc.deviceInfo()
    return Number(info.FSFreeBytes ?? 0)
  }

  async list(dir: string): Promise<string[]> {
    try {
      return await this.afc.readDir(dir)
    } catch (e) {
      if (e instanceof AfcError && /not found/i.test(e.message)) return []
      throw isDetach(e) ? new DeviceDetachedError((e as Error).message) : e
    }
  }

  async stat(path: string): Promise<DeviceFile> {
    try {
      const st = await this.afc.stat(path)
      return {
        path,
        size: st.size,
        mtimeMs: st.mtimeMs,
        isDirectory: st.isDirectory,
      }
    } catch (e) {
      throw isDetach(e) ? new DeviceDetachedError((e as Error).message) : e
    }
  }

  async open(path: string): Promise<DeviceHandle> {
    try {
      return new AfcHandle(this.afc, await this.afc.open(path))
    } catch (e) {
      throw isDetach(e) ? new DeviceDetachedError((e as Error).message) : e
    }
  }

  async dispose(): Promise<void> {
    this.afc.destroy()
    try {
      await this.lockdown.stopSession()
    } catch {
      /* the session dies with the socket regardless */
    }
    this.lockdown.destroy()
  }
}
