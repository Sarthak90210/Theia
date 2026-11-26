import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeviceDetachedError } from './types.ts'
import { POWERSHELL } from '../shell/powershell.ts'

/**
 * A conversation with mtp-helper.ps1: one PowerShell process that holds one
 * Windows Portable Devices connection open.
 *
 * Each request is a JSON line. Each reply is a JSON header line, then exactly
 * `bytes` raw bytes of file data when it carries any. Replies come back in
 * order, but they are matched by id anyway.
 *
 * If the process ends, every waiting request fails with DeviceDetachedError,
 * which is what tells the phone session to reconnect.
 */

export interface BridgeProcess {
  stdin: NodeJS.WritableStream
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  kill(): void
  on(event: 'exit', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (e: Error) => void): unknown
}

/** An error the helper reported, with its code: not-found, detached, closed, bad-request, error. */
export class MtpError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'MtpError'
  }
}

interface Waiting {
  resolve: (r: { result: unknown; data: Buffer }) => void
  reject: (e: Error) => void
  onProgress?: (checked: number) => void
}

const HELPER = 'mtp-helper.ps1'

/** Where the helper and its pinned library are: beside the built app, or the release tools in development. */
export function mtpHelperDirectory(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.join(here, 'wpd'), path.resolve(here, '../../dist-app/wpd'), path.resolve(here, '../../.release-tools/wpd')]
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'MediaDevices.dll')) && fs.existsSync(path.join(dir, HELPER))) ?? null
}

export function spawnHelper(): BridgeProcess {
  if (process.platform !== 'win32') throw new Error('Android phones are read through Windows Portable Devices, which needs Windows.')
  const dir = mtpHelperDirectory()
  if (!dir) throw new Error('The Android phone helper is missing. Rebuild or reinstall Theia.')
  const child: ChildProcessWithoutNullStreams = spawn(
    POWERSHELL,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, HELPER)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  return child
}

export class MtpBridge {
  private nextId = 1
  private readonly waiting = new Map<number, Waiting>()
  private buffer: Buffer = Buffer.alloc(0)
  /** A header whose data has not all arrived yet. */
  private header: { id: number; ok: boolean; bytes: number; result?: unknown; error?: string; code?: string; progress?: number } | null = null
  private ended: Error | null = null
  private stderr = ''

  constructor(private readonly child: BridgeProcess) {
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000)
    })
    child.on('exit', () => this.end())
    child.on('error', (e) => this.end(e))
    // A write after the process died raises on the pipe; the exit handler reports it.
    child.stdin.on('error', () => {})
  }

  static start(spawnFn: () => BridgeProcess = spawnHelper): MtpBridge {
    return new MtpBridge(spawnFn())
  }

  get alive(): boolean {
    return !this.ended
  }

  request<T = unknown>(op: string, args: Record<string, unknown> = {}, onProgress?: (checked: number) => void): Promise<{ result: T; data: Buffer }> {
    if (this.ended) return Promise.reject(this.ended)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as Waiting['resolve'], reject, onProgress })
      this.child.stdin.write(`${JSON.stringify({ ...args, id, op })}\n`)
    })
  }

  async call<T = unknown>(op: string, args: Record<string, unknown> = {}, onProgress?: (checked: number) => void): Promise<T> {
    return (await this.request<T>(op, args, onProgress)).result
  }

  /** Ask the helper to let go of the phone and stop; kill it if it doesn't. */
  async close(): Promise<void> {
    if (this.ended) return
    const done = new Promise<void>((resolve) => this.child.on('exit', () => resolve()))
    this.request('exit').catch(() => {})
    const timer = setTimeout(() => this.child.kill(), 3000)
    await done
    clearTimeout(timer)
  }

  private receive(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      if (!this.header) {
        const nl = this.buffer.indexOf(0x0a)
        if (nl < 0) return
        const line = this.buffer.subarray(0, nl).toString('utf8').trim()
        this.buffer = this.buffer.subarray(nl + 1)
        if (!line) continue
        try {
          this.header = JSON.parse(line)
        } catch {
          // Something other than the helper wrote to stdout. Nothing after it can be trusted.
          this.child.kill()
          this.end(new DeviceDetachedError(`The phone helper sent something unreadable: ${line.slice(0, 200)}`))
          return
        }
      }
      const h = this.header!
      if (this.buffer.length < h.bytes) return
      const data = Buffer.from(this.buffer.subarray(0, h.bytes))
      this.buffer = this.buffer.subarray(h.bytes)
      this.header = null
      const w = this.waiting.get(h.id)
      if (!w) continue
      if (typeof h.progress === 'number') {
        w.onProgress?.(h.progress)
        continue
      }
      this.waiting.delete(h.id)
      if (h.ok) w.resolve({ result: h.result, data })
      else if (h.code === 'detached') w.reject(new DeviceDetachedError(h.error ?? 'The phone is no longer connected.'))
      else w.reject(new MtpError(h.error ?? 'The phone did not answer.', h.code ?? 'error'))
    }
  }

  private end(e?: Error) {
    if (this.ended) return
    const detail = this.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ')
    this.ended = e ?? new DeviceDetachedError(detail ? `The phone connection stopped: ${detail}` : 'The phone connection stopped.')
    for (const w of this.waiting.values()) w.reject(this.ended)
    this.waiting.clear()
  }
}
