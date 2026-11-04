import fs from 'node:fs'
import path from 'node:path'
import {
  DeviceDetachedError,
  type DeviceFile,
  type DeviceHandle,
  type DeviceIdentity,
  type DeviceSource,
} from './types.ts'

/**
 * A device backed by a directory on disk, with the ability to misbehave.
 *
 * The faults are the feature. Every corruption mode the real transport can
 * produce is reproducible here deterministically, which is the only way to test
 * that the import engine quarantines rather than silently accepts.
 */

export type Fault =
  /** Report a size that disagrees with the bytes actually served. The
   *  transcode-length-mismatch bug, which is the main real-world corruption. */
  | { kind: 'size-mismatch'; reportSize: number }
  /** Serve bytes up to `at`, then behave as though the file ended. */
  | { kind: 'truncate-at'; at: number }
  /** Throw DeviceDetachedError once the read passes `at`. Cable pulled. */
  | { kind: 'detach-at'; at: number }
  /** Never fill a read fully. Legal protocol behaviour that naive loops break on. */
  | { kind: 'short-reads'; max: number }
  /** Fail to open at all, while other files succeed. */
  | { kind: 'open-fails'; message?: string }
  /** Fail to open the first `times` attempts, then work. A flaky link that recovers. */
  | { kind: 'open-fails-times'; times: number; message?: string }
  /** Delay each read, for progress and cancellation tests. */
  | { kind: 'slow'; msPerRead: number }

export interface FakeDeviceOptions {
  root: string
  identity?: Partial<DeviceIdentity>
  freeBytes?: number
  /** Keyed by device path. */
  faults?: Record<string, Fault>
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

class FakeHandle implements DeviceHandle {
  private offset = 0
  private closed = false

  constructor(
    private readonly bytes: Buffer,
    private readonly fault: Fault | undefined,
    private readonly onDetach: () => void,
    private readonly log: { reads: ReadLog[]; seeks: SeekLog[] },
    private readonly devicePath: string,
  ) {}

  async read(length: number): Promise<Buffer> {
    if (this.closed) throw new Error('read on a closed handle')
    if (this.fault?.kind === 'slow') await sleep(this.fault.msPerRead)

    if (this.fault?.kind === 'detach-at' && this.offset + length > this.fault.at) {
      // Serve whatever precedes the cut, then the cable goes.
      const upTo = Math.max(0, this.fault.at - this.offset)
      this.offset += upTo
      this.onDetach()
      throw new DeviceDetachedError(`detached at byte ${this.fault.at}`)
    }

    let limit = this.bytes.length
    if (this.fault?.kind === 'truncate-at') limit = Math.min(limit, this.fault.at)

    let want = Math.min(length, Math.max(0, limit - this.offset))
    if (this.fault?.kind === 'short-reads') want = Math.min(want, this.fault.max)

    const out = this.bytes.subarray(this.offset, this.offset + want)
    this.log.reads.push({ path: this.devicePath, offset: this.offset, length: want })
    this.offset += want
    return Buffer.from(out)
  }

  async seek(offset: number): Promise<void> {
    if (this.closed) throw new Error('seek on a closed handle')
    this.log.seeks.push({ path: this.devicePath, offset })
    this.offset = offset
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

export interface ReadLog {
  path: string
  offset: number
  length: number
}
export interface SeekLog {
  path: string
  offset: number
}

export class FakeDevice implements DeviceSource {
  private detached = false
  /** Ranges actually requested, so tests can assert that a resume only refetched the tail. */
  readonly reads: ReadLog[] = []
  readonly seeks: SeekLog[] = []
  readonly opened: string[] = []
  private readonly openFailures = new Map<string, number>()

  constructor(private readonly opts: FakeDeviceOptions) {}

  private localPath(devicePath: string): string {
    const rel = devicePath.replace(/^\/+/, '')
    return path.join(this.opts.root, rel)
  }

  private guard() {
    if (this.detached) throw new DeviceDetachedError()
  }

  /** Simulate the cable being pulled, affecting every later operation. */
  detach() {
    this.detached = true
  }

  reattach() {
    this.detached = false
  }

  async identity(): Promise<DeviceIdentity> {
    this.guard()
    return {
      udid: '00000000-000000000000000A',
      name: 'Fake iPhone',
      model: 'iPhone17,2',
      osVersion: '27.0',
      ...this.opts.identity,
    }
  }

  async freeBytes(): Promise<number> {
    this.guard()
    return this.opts.freeBytes ?? 64 * 1024 ** 3
  }

  async list(dir: string): Promise<string[]> {
    this.guard()
    try {
      return fs.readdirSync(this.localPath(dir))
    } catch {
      return []
    }
  }

  async stat(devicePath: string): Promise<DeviceFile> {
    this.guard()
    const st = fs.statSync(this.localPath(devicePath))
    const fault = this.opts.faults?.[devicePath]
    return {
      path: devicePath,
      // A lying stat is how the real transcode bug presents.
      size: fault?.kind === 'size-mismatch' ? fault.reportSize : st.size,
      mtimeMs: Math.floor(st.mtimeMs),
      isDirectory: st.isDirectory(),
    }
  }

  async open(devicePath: string): Promise<DeviceHandle> {
    this.guard()
    const fault = this.opts.faults?.[devicePath]
    if (fault?.kind === 'open-fails') {
      throw new Error(fault.message ?? `cannot open ${devicePath}`)
    }
    if (fault?.kind === 'open-fails-times') {
      const seen = (this.openFailures.get(devicePath) ?? 0) + 1
      this.openFailures.set(devicePath, seen)
      if (seen <= fault.times) throw new Error(fault.message ?? `cannot open ${devicePath}`)
    }
    this.opened.push(devicePath)
    const bytes = fs.readFileSync(this.localPath(devicePath))
    return new FakeHandle(bytes, fault, () => this.detach(), this, devicePath)
  }

  /** Clear a fault so a retry succeeds, the way replacing a bad cable would. */
  clearFault(devicePath: string) {
    if (this.opts.faults) delete this.opts.faults[devicePath]
  }

  /** Total bytes requested for a path across every attempt. */
  bytesRequested(devicePath: string): number {
    return this.reads.filter((r) => r.path === devicePath).reduce((a, r) => a + r.length, 0)
  }

  async dispose(): Promise<void> {}
}
