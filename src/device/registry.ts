import { EventEmitter } from 'node:events'
import { UsbmuxConnection, type UsbmuxEvent } from '../protocol/usbmux.ts'

/**
 * Every phone plugged in right now, each with a browsing session once one can
 * be opened.
 *
 * Phones appear and disappear by themselves: usbmuxd's Listen stream says when
 * one attaches or detaches, and a periodic list catches anything missed. A
 * phone that is plugged in but cannot be opened yet (locked, not trusted)
 * stays in the list with the reason, and is retried every few seconds, so
 * unlocking it is all the person has to do.
 *
 * Generic over the session type so tests can supply a fake.
 */

export interface DeviceEntry<S> {
  udid: string
  state: 'opening' | 'ready' | 'problem'
  session: S | null
  name: string | null
  error: string | null
  since: number
}

export interface RegistryOptions<S> {
  /** Open a browsing session for one phone. Throws when it cannot yet. */
  open: (udid: string) => Promise<S>
  close: (session: S) => Promise<void>
  nameOf: (session: S) => string
  /** The USB-connected phones usbmuxd can see right now. */
  list?: () => Promise<string[]>
  listen?: (onEvent: (e: UsbmuxEvent) => void) => Promise<void>
  retryMs?: number
  pollMs?: number
}

export class DeviceRegistry<S> extends EventEmitter {
  private readonly entries = new Map<string, DeviceEntry<S>>()
  private readonly opening = new Set<string>()
  private stopped = true
  private timers: NodeJS.Timeout[] = []
  private reconnect: NodeJS.Timeout | null = null

  constructor(private readonly opts: RegistryOptions<S>) {
    super()
  }

  get devices(): DeviceEntry<S>[] {
    return [...this.entries.values()]
  }

  get(udid: string): DeviceEntry<S> | undefined {
    return this.entries.get(udid)
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.subscribe()
    void this.sync()
    this.timers.push(setInterval(() => void this.sync(), this.opts.pollMs ?? 4000))
  }

  async stop() {
    this.stopped = true
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    if (this.reconnect) clearTimeout(this.reconnect)
    for (const e of this.entries.values()) if (e.session) await this.opts.close(e.session).catch(() => {})
    this.entries.clear()
  }

  /** Re-open one phone now, for a "try again" button or after a session broke. */
  async reopen(udid: string) {
    const e = this.entries.get(udid)
    if (e?.session) await this.opts.close(e.session).catch(() => {})
    this.entries.delete(udid)
    await this.sync()
  }

  /** Bring the list in line with what usbmuxd sees. */
  async sync() {
    if (this.stopped) return
    let present: string[]
    try {
      present = await (this.opts.list ?? listUsb)()
    } catch {
      // The Apple service is down. Nothing can be open.
      present = []
    }
    const now = new Set(present)
    for (const [udid, e] of this.entries) {
      if (!now.has(udid)) {
        this.entries.delete(udid)
        if (e.session) void this.opts.close(e.session).catch(() => {})
        this.emit('change')
      }
    }
    for (const udid of present) {
      const e = this.entries.get(udid)
      const due = !e || (e.state === 'problem' && Date.now() - e.since >= (this.opts.retryMs ?? 4000))
      if (due) void this.openOne(udid)
    }
  }

  private async openOne(udid: string) {
    if (this.opening.has(udid)) return
    this.opening.add(udid)
    const prev = this.entries.get(udid)
    this.entries.set(udid, {
      udid,
      state: 'opening',
      session: null,
      name: prev?.name ?? null,
      error: prev?.error ?? null,
      since: Date.now(),
    })
    this.emit('change')
    try {
      const session = await this.opts.open(udid)
      if (this.stopped || !this.entries.has(udid)) {
        await this.opts.close(session).catch(() => {})
        return
      }
      this.entries.set(udid, { udid, state: 'ready', session, name: this.opts.nameOf(session), error: null, since: Date.now() })
    } catch (e) {
      if (this.entries.has(udid)) {
        this.entries.set(udid, {
          udid,
          state: 'problem',
          session: null,
          name: prev?.name ?? null,
          error: (e as Error).message,
          since: Date.now(),
        })
      }
    } finally {
      this.opening.delete(udid)
      this.emit('change')
    }
  }

  private subscribe() {
    if (this.stopped) return
    const listen = this.opts.listen ?? listenUsb
    listen(() => void this.sync())
      .catch(() => {})
      .finally(() => {
        if (this.stopped) return
        this.reconnect = setTimeout(() => this.subscribe(), 3000)
      })
  }
}

async function listUsb(): Promise<string[]> {
  const mux = await UsbmuxConnection.open()
  try {
    return (await mux.listDevices()).filter((d) => d.Properties.ConnectionType === 'USB').map((d) => d.Properties.SerialNumber)
  } finally {
    mux.close()
  }
}

async function listenUsb(onEvent: (e: UsbmuxEvent) => void): Promise<void> {
  const mux = await UsbmuxConnection.open()
  try {
    await mux.listen(onEvent)
  } finally {
    mux.close()
  }
}
