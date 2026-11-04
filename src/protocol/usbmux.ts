import net from 'node:net'
import type { Duplex } from 'node:stream'
import { ByteReader, writeAll } from './bytes.ts'
import { buildPlist, parsePlist, scrub } from './plist-io.ts'

/**
 * usbmuxd on Windows listens on TCP 127.0.0.1:27015, owned by
 * AppleMobileDeviceService. It is not a named pipe, despite what a lot of
 * documentation says. Verified against a live service.
 */
export const USBMUX_HOST = '127.0.0.1'
export const USBMUX_PORT = 27015

const HEADER_BYTES = 16
const PROTOCOL_PLIST = 1
const MESSAGE_PLIST = 8

const CLIENT = {
  ClientVersionString: 'photos-win-prototype',
  ProgName: 'photos-win',
  kLibUSBMuxVersion: 3,
}

export interface DeviceEntry {
  DeviceID: number
  MessageType: string
  Properties: {
    ConnectionType: string
    DeviceID: number
    ProductID?: number
    SerialNumber: string
    LocationID?: number
  }
}

export type UsbmuxEvent =
  | { type: 'attached'; deviceId: number; udid: string; connection: string }
  | { type: 'detached'; deviceId: number }
  /** Trust was just granted on the phone. */
  | { type: 'paired'; deviceId: number }

export type Recorder =(dir: 'tx' | 'rx', layer: string, msg: unknown) => void

export class UsbmuxConnection {
  private reader: ByteReader
  private tag = 1
  private consumed = false

  private constructor(private socket: net.Socket, private record?: Recorder) {
    this.reader = new ByteReader(socket)
  }

  static open(record?: Recorder): Promise<UsbmuxConnection> {
    return new Promise((res, rej) => {
      const socket = net.connect({ host: USBMUX_HOST, port: USBMUX_PORT })
      socket.once('error', rej)
      socket.once('connect', () => {
        socket.off('error', rej)
        res(new UsbmuxConnection(socket, record))
      })
    })
  }

  private async send(payload: Record<string, unknown>): Promise<number> {
    const body = buildPlist({ ...CLIENT, ...payload })
    const header = Buffer.alloc(HEADER_BYTES)
    const tag = this.tag++
    header.writeUInt32LE(HEADER_BYTES + body.length, 0)
    header.writeUInt32LE(PROTOCOL_PLIST, 4)
    header.writeUInt32LE(MESSAGE_PLIST, 8)
    header.writeUInt32LE(tag, 12)
    this.record?.('tx', 'usbmux', scrub({ ...CLIENT, ...payload }))
    await writeAll(this.socket, Buffer.concat([header, body]))
    return tag
  }

  private async receive(): Promise<any> {
    const header = await this.reader.read(HEADER_BYTES)
    const total = header.readUInt32LE(0)
    const body = await this.reader.read(total - HEADER_BYTES)
    const msg = parsePlist(body)
    this.record?.('rx', 'usbmux', scrub(msg))
    return msg
  }

  private async request(payload: Record<string, unknown>): Promise<any> {
    await this.send(payload)
    return this.receive()
  }

  async listDevices(): Promise<DeviceEntry[]> {
    const res = await this.request({ MessageType: 'ListDevices' })
    return (res.DeviceList ?? []) as DeviceEntry[]
  }

  /**
   * Subscribe to attach and detach events. usbmuxd answers with a result, then
   * keeps the socket open and pushes one message per event, starting with an
   * Attached for every device already connected. The connection is given over
   * to this for its lifetime. Resolves when the socket closes, which is also
   * what happens when the Apple service stops.
   */
  async listen(onEvent: (e: UsbmuxEvent) => void): Promise<void> {
    const ack = await this.request({ MessageType: 'Listen' })
    if (ack?.Number !== undefined && ack.Number !== 0) {
      throw new Error(`usbmux Listen failed with result ${ack.Number}`)
    }
    for (;;) {
      let msg: any
      try {
        msg = await this.receive()
      } catch {
        return
      }
      if (msg?.MessageType === 'Attached' && msg.Properties) {
        onEvent({
          type: 'attached',
          deviceId: msg.DeviceID,
          udid: msg.Properties.SerialNumber,
          connection: msg.Properties.ConnectionType,
        })
      } else if (msg?.MessageType === 'Detached') {
        onEvent({ type: 'detached', deviceId: msg.DeviceID })
      } else if (msg?.MessageType === 'Paired') {
        onEvent({ type: 'paired', deviceId: msg.DeviceID })
      }
    }
  }

  /**
   * Ask usbmuxd for the pairing record rather than reading
   * C:\ProgramData\Apple\Lockdown directly. The directory is ACL'd and reading
   * it normally needs elevation; usbmuxd hands the record over without it.
   */
  async readPairRecord(udid: string): Promise<Buffer | null> {
    const res = await this.request({ MessageType: 'ReadPairRecord', PairRecordID: udid })
    const data = res?.PairRecordData
    if (!data) return null
    return Buffer.isBuffer(data) ? data : Buffer.from(data)
  }

  /**
   * Open a channel to a TCP port on the device. On success this connection
   * stops being a usbmux client and becomes a raw tunnel to that port.
   */
  async connectToPort(deviceId: number, port: number): Promise<Duplex> {
    const swapped = ((port & 0xff) << 8) | ((port >> 8) & 0xff)
    const res = await this.request({
      MessageType: 'Connect',
      DeviceID: deviceId,
      PortNumber: swapped,
    })
    if (res.Number !== 0) {
      throw new Error(`usbmux Connect to port ${port} failed with result ${res.Number}`)
    }
    this.consumed = true
    const { stream } = this.reader.detach()
    return stream
  }

  close() {
    if (!this.consumed) this.socket.destroy()
  }
}
