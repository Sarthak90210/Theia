import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { UsbmuxConnection } from '../protocol/usbmux.ts'
import { LockdownClient, LOCKDOWN_PORT, TLS_STRATEGIES, type PairRecord } from '../protocol/lockdown.ts'
import { parsePlist } from '../protocol/plist-io.ts'

/**
 * Which of the four layers between Windows and the phone is broken, and what
 * the person can do about it.
 *
 * "Cannot find device" is four unrelated failures wearing one message, which
 * is the original complaint about the stock Photos app. Asking someone to tap
 * Trust when the cable is charge-only is worse than saying nothing. Each layer
 * is checked in order, and the first failure is the answer.
 *
 * Returned as data so the UI can draw it. prototype/diagnose.ts prints it.
 */

export type LayerId = 'service' | 'usb' | 'usbmux' | 'trust'

export interface Layer {
  id: LayerId
  name: string
  status: 'ok' | 'fail' | 'skipped'
  detail: string
  /** What to do, in order. Present when status is fail. */
  fix?: string[]
}

export interface Diagnosis {
  ready: boolean
  layers: Layer[]
  device: { udid: string; name: string; osVersion: string } | null
}

/** One check per layer, swappable so tests can fail each layer on demand. */
export interface Probes {
  serviceRunning(): Promise<boolean>
  usbPresent(): Promise<{ present: boolean; ghosts: number }>
  usbmuxDevices(): Promise<{ udid: string; deviceId: number }[]>
  pairRecord(udid: string): Promise<PairRecord | null>
  /** Opens a lockdown session. Throws with lockdownd's error text on failure. */
  session(deviceId: number, pair: PairRecord): Promise<{ name: string; osVersion: string }>
}

const NAMES: Record<LayerId, string> = {
  service: 'Apple Mobile Device Service',
  usb: 'USB connection',
  usbmux: 'Apple device driver',
  trust: 'Pairing and trust',
}

export async function diagnose(probes: Probes = realProbes): Promise<Diagnosis> {
  const layers: Layer[] = []
  const pending = (from: LayerId[]) => {
    for (const id of from) layers.push({ id, name: NAMES[id], status: 'skipped', detail: 'not checked' })
  }
  const fail = (id: LayerId, detail: string, fix: string[], rest: LayerId[]): Diagnosis => {
    layers.push({ id, name: NAMES[id], status: 'fail', detail, fix })
    pending(rest)
    return { ready: false, layers, device: null }
  }
  const ok = (id: LayerId, detail: string) => layers.push({ id, name: NAMES[id], status: 'ok', detail })

  // Layer 0. Without the service nothing else can even be asked.
  let running = false
  try {
    running = await probes.serviceRunning()
  } catch {
    running = false
  }
  if (!running) {
    return fail(
      'service',
      'not running',
      ['Install Apple Devices from the Microsoft Store.', 'If it is installed, start Apple Mobile Device Service.'],
      ['usb', 'usbmux', 'trust'],
    )
  }
  ok('service', 'running')

  // Layer 1. Is anything on the USB bus at all?
  const usb = await probes.usbPresent().catch(() => ({ present: true, ghosts: 0 }))
  if (!usb.present) {
    return fail(
      'usb',
      `Windows does not see an iPhone on USB${usb.ghosts ? ` (${usb.ghosts} records from past connections)` : ''}`,
      [
        'Check the cable. Charge-only USB-C cables carry no data.',
        'Try another port, preferably one directly on the computer.',
        'Unlocking the phone or tapping Trust cannot help until this is fixed.',
      ],
      ['usbmux', 'trust'],
    )
  }
  ok('usb', 'Windows sees an Apple device')

  // Layer 2. Windows sees it, but does Apple's driver?
  let devices: { udid: string; deviceId: number }[]
  try {
    devices = await probes.usbmuxDevices()
  } catch (e) {
    return fail(
      'usbmux',
      `cannot reach the driver: ${(e as Error).message}`,
      ['Restart Apple Mobile Device Service.'],
      ['trust'],
    )
  }
  const device = devices[0]
  if (!device) {
    return fail(
      'usbmux',
      'Windows sees the phone but Apple’s driver does not',
      [
        'Unlock the phone. An iPhone drops off Apple’s driver whenever it locks.',
        'If it is unlocked, unplug it and plug it back in.',
        'If that does not help, restart Apple Mobile Device Service.',
      ],
      ['trust'],
    )
  }
  ok('usbmux', `device ${device.udid}`)

  // Layer 3. Paired, trusted and unlocked enough to talk.
  const pair = await probes.pairRecord(device.udid).catch(() => null)
  if (!pair) {
    return fail('trust', 'this computer is not trusted yet', ['Unlock the phone and tap Trust when it asks.'], [])
  }
  try {
    const info = await probes.session(device.deviceId, pair)
    ok('trust', `connected to ${info.name}, iOS ${info.osVersion}`)
    return { ready: true, layers, device: { udid: device.udid, ...info } }
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('PasswordProtected')) {
      return fail('trust', 'the phone is locked', ['Unlock the phone.'], [])
    }
    if (msg.includes('InvalidHostID')) {
      return fail(
        'trust',
        'the pairing is out of date',
        ['Unlock the phone and tap Trust again. If it does not ask, unplug and replug.'],
        [],
      )
    }
    return fail('trust', `the phone refused the connection: ${msg}`, ['Unplug the phone, unlock it, and plug it back in.'], [])
  }
}

const run = promisify(execFile)

export const realProbes: Probes = {
  async serviceRunning() {
    const { stdout } = await run(
      'powershell',
      ['-NoProfile', '-Command', "(Get-Service 'Apple Mobile Device Service' -ErrorAction SilentlyContinue).Status"],
      { windowsHide: true },
    )
    return stdout.trim() === 'Running'
  },

  async usbPresent() {
    const script = `
      $all = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_05AC' -and $_.Class -eq 'USBDevice' })
      $now = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_05AC' })
      [pscustomobject]@{ present = $now.Count; ghosts = $all.Count } | ConvertTo-Json -Compress
    `
    const { stdout } = await run('powershell', ['-NoProfile', '-Command', script], { windowsHide: true })
    const parsed = JSON.parse(stdout.trim())
    return { present: parsed.present > 0, ghosts: parsed.ghosts }
  },

  async usbmuxDevices() {
    const mux = await UsbmuxConnection.open()
    try {
      return (await mux.listDevices())
        .filter((d) => d.Properties.ConnectionType === 'USB')
        .map((d) => ({ udid: d.Properties.SerialNumber, deviceId: d.Properties.DeviceID }))
    } finally {
      mux.close()
    }
  },

  async pairRecord(udid) {
    const mux = await UsbmuxConnection.open()
    try {
      const data = await mux.readPairRecord(udid)
      return data ? (parsePlist(data) as PairRecord) : null
    } finally {
      mux.close()
    }
  },

  async session(deviceId, pair) {
    const mux = await UsbmuxConnection.open()
    const lockdown = new LockdownClient(await mux.connectToPort(deviceId, LOCKDOWN_PORT))
    try {
      await lockdown.queryType()
      const s = await lockdown.startSession(pair)
      if (s.ssl) await lockdown.enableSSL(pair, TLS_STRATEGIES[0]!)
      const name = String(await lockdown.getValue('DeviceName'))
      const osVersion = String(await lockdown.getValue('ProductVersion'))
      await lockdown.stopSession()
      return { name, osVersion }
    } finally {
      lockdown.destroy()
    }
  },
}
