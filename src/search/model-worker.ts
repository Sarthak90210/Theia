import { Worker } from 'node:worker_threads'

/**
 * A model in a worker thread, started on first use and stopped after a quiet
 * spell, because a loaded model holds tens to hundreds of MB. Requests go in
 * with an id; the worker answers each one with the same id, and an error
 * field when it failed.
 */
export class ModelWorker<Reply extends object> {
  private worker: Worker | null = null
  private next = 0
  private readonly pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>()
  private idleTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly script: URL,
    private readonly workerData: () => unknown,
    private readonly what: string,
    private readonly idleMs = 120_000,
    /** Messages the worker sends by itself, such as which device it chose. */
    private readonly onEvent?: (event: Record<string, unknown>) => void,
  ) {}

  ask(msg: object): Promise<Reply> {
    const worker = this.start()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const id = ++this.next
    return new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ id, ...msg })
    })
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const w = this.worker
    this.worker = null
    for (const p of this.pending.values()) p.reject(new Error(`${this.what} closed`))
    this.pending.clear()
    await w?.terminate()
  }

  private start(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(this.script, { workerData: this.workerData() })
    worker.unref()
    worker.on('message', (m: { id: number; error?: string; event?: string }) => {
      if (m.event) return this.onEvent?.(m as unknown as Record<string, unknown>)
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error))
      else p.resolve(m as unknown as Reply)
      if (!this.pending.size) this.scheduleIdle()
    })
    const fail = (e: Error) => {
      if (this.worker !== worker) return
      this.worker = null
      for (const p of this.pending.values()) p.reject(e)
      this.pending.clear()
    }
    worker.on('error', fail)
    worker.on('exit', (code) => fail(new Error(`${this.what} stopped (exit ${code})`)))
    this.worker = worker
    return worker
  }

  private scheduleIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => void this.close(), this.idleMs)
    this.idleTimer.unref()
  }
}
