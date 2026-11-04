import { EventEmitter } from 'node:events'
import { UsbmuxConnection, type UsbmuxEvent } from '../protocol/usbmux.ts'
import { diagnose, realProbes, type Diagnosis, type Probes } from './diagnose.ts'

/**
 * Keeps an up-to-date answer to "can I import right now, and if not, why not".
 *
 * - Subscribes to usbmuxd's Listen stream, so plugging in, unplugging and
 *   tapping Trust are noticed straight away.
 * - Re-diagnoses after each event, debounced, because a plug-in produces a
 *   burst of them.
 * - While something is wrong, re-checks every few seconds. Unlocking the phone
 *   produces no event at all, and the service can come back on its own.
 * - Once the phone is ready, stops polling. A diagnosis opens a lockdown
 *   session, and that has no business competing with an import.
 * - If the Listen socket drops (the service stopped), reconnects on a timer.
 *
 * Emits 'change' with a DeviceState whenever the answer changes.
 */

export interface DeviceState {
  checking: boolean
  diagnosis: Diagnosis | null
  checkedAt: number | null
}

export interface WatcherOptions {
  probes?: Probes
  /** Subscribe to usbmux events. Resolves when the subscription ends. */
  listen?: (onEvent: (e: UsbmuxEvent) => void) => Promise<void>
  pollMs?: number
  debounceMs?: number
  reconnectMs?: number
}

async function realListen(onEvent: (e: UsbmuxEvent) => void): Promise<void> {
  const mux = await UsbmuxConnection.open()
  try {
    await mux.listen(onEvent)
  } finally {
    mux.close()
  }
}

export class DeviceWatcher extends EventEmitter {
  private state: DeviceState = { checking: false, diagnosis: null, checkedAt: null }
  private stopped = true
  private running: Promise<void> | null = null
  private again = false
  private debounce: NodeJS.Timeout | null = null
  private poll: NodeJS.Timeout | null = null
  private reconnect: NodeJS.Timeout | null = null
  private readonly probes: Probes
  private readonly listenFn: NonNullable<WatcherOptions['listen']>
  private readonly pollMs: number
  private readonly debounceMs: number
  private readonly reconnectMs: number

  constructor(opts: WatcherOptions = {}) {
    super()
    this.probes = opts.probes ?? realProbes
    this.listenFn = opts.listen ?? realListen
    this.pollMs = opts.pollMs ?? 3000
    this.debounceMs = opts.debounceMs ?? 400
    this.reconnectMs = opts.reconnectMs ?? 3000
  }

  get current(): DeviceState {
    return this.state
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.subscribe()
    void this.check()
  }

  stop() {
    this.stopped = true
    for (const t of [this.debounce, this.poll, this.reconnect]) if (t) clearTimeout(t)
    this.debounce = this.poll = this.reconnect = null
  }

  /** Check now, for a "try again" button. */
  refresh(): Promise<void> {
    return this.check()
  }

  private subscribe() {
    if (this.stopped) return
    this.listenFn((e) => {
      this.emit('usbmux', e)
      // A detach answers itself: there is nothing left to talk to. Say so
      // immediately rather than after a debounce and a PowerShell round trip.
      if (e.type === 'detached' && this.state.diagnosis?.ready) {
        this.set({ diagnosis: { ...this.state.diagnosis, ready: false, device: null } })
      }
      this.schedule()
    })
      .catch(() => {})
      .finally(() => {
        if (this.stopped) return
        // The stream ended. Usually the service went away. Say so, and retry.
        this.schedule()
        this.reconnect = setTimeout(() => this.subscribe(), this.reconnectMs)
      })
  }

  private schedule() {
    if (this.stopped) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.check()
    }, this.debounceMs)
  }

  private check(): Promise<void> {
    // One diagnosis at a time. A request during one runs once it finishes.
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        this.set({ checking: true })
        let diagnosis: Diagnosis
        try {
          diagnosis = await diagnose(this.probes)
        } catch (e) {
          diagnosis = {
            ready: false,
            device: null,
            layers: [{ id: 'service', name: 'Diagnosis', status: 'fail', detail: (e as Error).message }],
          }
        }
        this.set({ checking: false, diagnosis, checkedAt: Date.now() })
      } while (this.again && !this.stopped)
    })().finally(() => {
      this.running = null
      this.armPoll()
    })
    return this.running
  }

  private armPoll() {
    if (this.poll) clearTimeout(this.poll)
    this.poll = null
    if (this.stopped || this.state.diagnosis?.ready) return
    this.poll = setTimeout(() => void this.check(), this.pollMs)
  }

  private set(patch: Partial<DeviceState>) {
    this.state = { ...this.state, ...patch }
    this.emit('change', this.state)
  }
}
