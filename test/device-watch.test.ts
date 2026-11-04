import { describe, expect, it } from 'vitest'
import { diagnose, type Probes } from '../src/device/diagnose.ts'
import { DeviceWatcher, type DeviceState } from '../src/device/watcher.ts'
import type { UsbmuxEvent } from '../src/protocol/usbmux.ts'
import type { PairRecord } from '../src/protocol/lockdown.ts'

const PAIR = {} as PairRecord

function probes(over: Partial<Probes> = {}): Probes {
  return {
    serviceRunning: async () => true,
    usbPresent: async () => ({ present: true, ghosts: 0 }),
    usbmuxDevices: async () => [{ udid: 'U1', deviceId: 7 }],
    pairRecord: async () => PAIR,
    session: async () => ({ name: 'Test iPhone', osVersion: '27.0' }),
    ...over,
  }
}

const statuses = (d: Awaited<ReturnType<typeof diagnose>>) => d.layers.map((l) => `${l.id}:${l.status}`)

describe('diagnose', () => {
  it('is ready when all four layers pass', async () => {
    const d = await diagnose(probes())
    expect(d.ready).toBe(true)
    expect(d.device).toEqual({ udid: 'U1', name: 'Test iPhone', osVersion: '27.0' })
    expect(statuses(d)).toEqual(['service:ok', 'usb:ok', 'usbmux:ok', 'trust:ok'])
  })

  it('stops at a missing service and does not ask about trust', async () => {
    const d = await diagnose(probes({ serviceRunning: async () => false }))
    expect(statuses(d)).toEqual(['service:fail', 'usb:skipped', 'usbmux:skipped', 'trust:skipped'])
    expect(d.layers[0]!.fix![0]).toMatch(/Apple Devices/)
  })

  it('blames the cable, not trust, when Windows sees nothing', async () => {
    const d = await diagnose(probes({ usbPresent: async () => ({ present: false, ghosts: 3 }) }))
    expect(statuses(d)).toEqual(['service:ok', 'usb:fail', 'usbmux:skipped', 'trust:skipped'])
    expect(d.layers[1]!.detail).toContain('3 records from past connections')
    expect(d.layers[1]!.fix!.join(' ')).toMatch(/Charge-only/)
  })

  it('separates Windows seeing the phone from the Apple driver seeing it', async () => {
    const d = await diagnose(probes({ usbmuxDevices: async () => [] }))
    expect(statuses(d)).toEqual(['service:ok', 'usb:ok', 'usbmux:fail', 'trust:skipped'])
  })

  it('asks for Trust when there is no pairing record', async () => {
    const d = await diagnose(probes({ pairRecord: async () => null }))
    expect(d.layers[3]).toMatchObject({ status: 'fail', detail: 'this computer is not trusted yet' })
  })

  it('tells a locked phone from a stale pairing', async () => {
    const locked = await diagnose(probes({ session: async () => Promise.reject(new Error('StartSession: PasswordProtected')) }))
    expect(locked.layers[3]!.detail).toBe('the phone is locked')
    const stale = await diagnose(probes({ session: async () => Promise.reject(new Error('InvalidHostID')) }))
    expect(stale.layers[3]!.detail).toBe('the pairing is out of date')
  })
})

/** A usbmux Listen stream the test can push events into and end. */
function fakeListen() {
  let push: ((e: UsbmuxEvent) => void) | null = null
  let end: (() => void) | null = null
  let subscriptions = 0
  return {
    listen: (onEvent: (e: UsbmuxEvent) => void) =>
      new Promise<void>((resolve) => {
        subscriptions++
        push = onEvent
        end = resolve
      }),
    push: (e: UsbmuxEvent) => push?.(e),
    end: () => end?.(),
    get subscriptions() {
      return subscriptions
    },
  }
}

function waitFor(w: DeviceWatcher, pred: (s: DeviceState) => boolean, ms = 2000): Promise<DeviceState> {
  return new Promise((resolve, reject) => {
    if (pred(w.current)) return resolve(w.current)
    const t = setTimeout(() => reject(new Error(`timed out; last state ${JSON.stringify(w.current)}`)), ms)
    w.on('change', (s: DeviceState) => {
      if (pred(s)) {
        clearTimeout(t)
        resolve(s)
      }
    })
  })
}

describe('DeviceWatcher', () => {
  it('becomes ready on start, and not ready the moment the phone is unplugged', async () => {
    const l = fakeListen()
    let present = true
    const w = new DeviceWatcher({
      listen: l.listen,
      probes: probes({ usbPresent: async () => ({ present, ghosts: 0 }) }),
      debounceMs: 5,
      pollMs: 20,
    })
    w.start()
    await waitFor(w, (s) => s.diagnosis?.ready === true)

    present = false
    l.push({ type: 'detached', deviceId: 7 })
    // Immediately, before any re-diagnosis.
    expect(w.current.diagnosis?.ready).toBe(false)
    const after = await waitFor(w, (s) => !s.checking && s.diagnosis?.layers[1]?.status === 'fail')
    expect(after.diagnosis?.layers[1]?.id).toBe('usb')
    w.stop()
  })

  it('notices the phone being unlocked by polling, since unlocking sends no event', async () => {
    const l = fakeListen()
    let locked = true
    const w = new DeviceWatcher({
      listen: l.listen,
      probes: probes({
        session: async () => (locked ? Promise.reject(new Error('PasswordProtected')) : { name: 'P', osVersion: '27.0' }),
      }),
      pollMs: 20,
    })
    w.start()
    await waitFor(w, (s) => s.diagnosis?.layers[3]?.detail === 'the phone is locked')
    locked = false
    await waitFor(w, (s) => s.diagnosis?.ready === true)
    w.stop()
  })

  it('stops polling once ready, so it never competes with an import', async () => {
    const l = fakeListen()
    let sessions = 0
    const w = new DeviceWatcher({
      listen: l.listen,
      probes: probes({ session: async () => (sessions++, { name: 'P', osVersion: '27.0' }) }),
      pollMs: 10,
    })
    w.start()
    await waitFor(w, (s) => s.diagnosis?.ready === true)
    const before = sessions
    await new Promise((r) => setTimeout(r, 80))
    expect(sessions).toBe(before)
    w.stop()
  })

  it('resubscribes when the usbmux stream ends', async () => {
    const l = fakeListen()
    const w = new DeviceWatcher({ listen: l.listen, probes: probes(), reconnectMs: 10, debounceMs: 5 })
    w.start()
    await waitFor(w, (s) => s.diagnosis?.ready === true)
    l.end()
    await new Promise((r) => setTimeout(r, 50))
    expect(l.subscriptions).toBe(2)
    w.stop()
  })
})
