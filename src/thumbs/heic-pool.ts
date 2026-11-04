import { Worker } from 'node:worker_threads'

/**
 * A fixed pool of HEIC decode workers. See heic-worker.mjs for why.
 *
 * Each worker takes one file at a time. Requests queue here, never inside a
 * worker, so a slow file holds up one slot and nothing else.
 */

export interface DecodedImage {
  width: number
  height: number
  /** RGBA, 8 bits per channel. */
  data: Buffer
}

interface Pending {
  path?: string
  data?: Buffer
  resolve: (img: DecodedImage) => void
  reject: (e: Error) => void
}

interface Slot {
  worker: Worker
  busy: Pending | null
}

export class HeicPool {
  private readonly slots: Slot[] = []
  private readonly waiting: Pending[] = []
  private nextId = 0
  private closed = false

  constructor(size: number) {
    for (let i = 0; i < Math.max(1, size); i++) this.slots.push(this.spawn())
  }

  get size(): number {
    return this.slots.length
  }

  decode(path: string): Promise<DecodedImage> {
    if (this.closed) return Promise.reject(new Error('HEIC pool is closed'))
    return new Promise((resolve, reject) => {
      this.waiting.push({ path, resolve, reject })
      this.pump()
    })
  }

  /** Decode HEIC bytes already in memory: a protected photo, decrypted, never written out. */
  decodeBuffer(data: Buffer): Promise<DecodedImage> {
    if (this.closed) return Promise.reject(new Error('HEIC pool is closed'))
    return new Promise((resolve, reject) => {
      this.waiting.push({ data, resolve, reject })
      this.pump()
    })
  }

  async close(): Promise<void> {
    this.closed = true
    for (const p of this.waiting.splice(0)) p.reject(new Error('HEIC pool closed'))
    await Promise.all(this.slots.map((s) => s.worker.terminate()))
  }

  private spawn(): Slot {
    const worker = new Worker(new URL('./heic-worker.mjs', import.meta.url))
    const slot: Slot = { worker, busy: null }

    worker.on('message', (msg: { error?: string; width: number; height: number; data: ArrayBuffer }) => {
      const job = slot.busy
      slot.busy = null
      if (job) {
        if (msg.error) job.reject(new Error(msg.error))
        else job.resolve({ width: msg.width, height: msg.height, data: Buffer.from(msg.data) })
      }
      this.pump()
    })

    // A worker that dies (out of memory on a pathological file, say) takes its
    // job with it. Replace it so the pool keeps its size.
    worker.on('error', (e) => {
      const job = slot.busy
      slot.busy = null
      job?.reject(e instanceof Error ? e : new Error(String(e)))
      if (this.closed) return
      const i = this.slots.indexOf(slot)
      if (i >= 0) this.slots[i] = this.spawn()
      this.pump()
    })

    return slot
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.busy) continue
      const job = this.waiting.shift()
      if (!job) return
      slot.busy = job
      if (job.data) {
        // Copy into a transferable buffer; the caller keeps its own.
        const copy = new Uint8Array(job.data).buffer
        slot.worker.postMessage({ id: this.nextId++, data: copy }, [copy])
      } else slot.worker.postMessage({ id: this.nextId++, path: job.path })
    }
  }
}
