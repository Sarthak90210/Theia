import { fork } from 'node:child_process'
import { PermanentJobError } from '../jobs/queue.ts'
import type { RenderResult } from './render.ts'

/**
 * Thumbnails rendered in a separate process.
 *
 * sharp (libvips) and the decoders under it are native code. A bad file can
 * make them fail hard: Windows logged Theia dying inside sharp with
 * 0xc0000409, a fail-fast that no try/catch can stop. In the main process that
 * takes the window and every save in progress with it. Out here it takes only
 * this process, which is started again, and the job fails instead of the app.
 *
 * Which file did it? Several can be in flight when the process dies. A file
 * that was alone in flight, or in flight for two crashes, is the cause: its
 * job fails for good, so it isn't retried forever. The others go back in the
 * queue as an ordinary retry.
 */

export interface RenderRequest {
  file: string
  mime: string
  sha256: string
  cacheRoot: string
}

/** The other process, whatever started it: Electron's utilityProcess in the app, child_process.fork in tests. */
export interface ChildLike {
  post(message: unknown): void
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: (code: number | null) => void): void
  kill(): void
}

type Reply = { id: number; ok: true; result: RenderResult } | { id: number; ok: false; error: string; permanent: boolean }

interface InFlight {
  request: RenderRequest
  resolve: (r: RenderResult) => void
  reject: (e: Error) => void
}

export class RenderHost {
  private child: ChildLike | null = null
  private readonly inFlight = new Map<number, InFlight>()
  private readonly crashesWith = new Map<string, number>()
  private recentCrashes: number[] = []
  private nextId = 1
  private closed = false
  private restartAt = 0

  constructor(private readonly spawn: () => ChildLike, private readonly now: () => number = Date.now) {}

  async render(request: RenderRequest): Promise<RenderResult> {
    if (this.closed) throw new Error('The thumbnail process is closed.')
    // Crashing over and over: give the machine a moment before starting again.
    const wait = this.restartAt - this.now()
    if (!this.child && wait > 0) await new Promise((r) => setTimeout(r, wait))
    const child = this.ensure()
    const id = this.nextId++
    return new Promise<RenderResult>((resolve, reject) => {
      this.inFlight.set(id, { request, resolve, reject })
      child.post({ id, ...request })
    })
  }

  close(): void {
    this.closed = true
    const child = this.child
    this.child = null
    for (const [, job] of this.inFlight) job.reject(new Error('The thumbnail process is closed.'))
    this.inFlight.clear()
    child?.kill()
  }

  private ensure(): ChildLike {
    if (this.child) return this.child
    const child = this.spawn()
    this.child = child
    child.onMessage((m) => {
      const reply = m as Reply
      const job = this.inFlight.get(reply.id)
      if (!job) return
      this.inFlight.delete(reply.id)
      if (reply.ok) job.resolve(reply.result)
      else job.reject(reply.permanent ? new PermanentJobError(reply.error) : new Error(reply.error))
    })
    child.onExit((code) => {
      if (this.child !== child) return
      this.child = null
      if (this.closed) return
      this.crashed(code)
    })
    return child
  }

  private crashed(code: number | null) {
    const at = this.now()
    this.recentCrashes = [...this.recentCrashes.filter((t) => at - t < 60_000), at]
    // Three in a minute: wait a little longer before each new start.
    this.restartAt = this.recentCrashes.length >= 3 ? at + Math.min(30_000, 1000 * 2 ** (this.recentCrashes.length - 3)) : 0
    const jobs = [...this.inFlight.values()]
    this.inFlight.clear()
    // Windows reports a crash as an NTSTATUS such as 0xc0000409, signed or not.
    const how = code === null ? 'was stopped' : `crashed (exit code 0x${(code >>> 0).toString(16)})`
    for (const job of jobs) {
      const n = (this.crashesWith.get(job.request.file) ?? 0) + 1
      this.crashesWith.set(job.request.file, n)
      if (jobs.length === 1 || n >= 2) {
        job.reject(new PermanentJobError(`The image decoder ${how} on this file, so Theia stopped trying it. The file may be damaged.`))
      } else {
        job.reject(new Error(`The thumbnail process ${how} while this file was in progress; it will be tried again.`))
      }
    }
  }
}

/** A Node child process speaking the same protocol, for tests and command-line tools. */
export function forkNodeChild(script: string, execArgv: string[] = []): ChildLike {
  const child = fork(script, [], { execArgv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  return {
    post: (m) => child.send(m as object),
    onMessage: (l) => child.on('message', l),
    onExit: (l) => child.on('exit', (code) => l(code)),
    kill: () => child.kill(),
  }
}
