import fs from 'node:fs'
import path from 'node:path'
import { createHash, type Hash } from 'node:crypto'
import type { Db } from '../library/db.ts'
import {
  DeviceDetachedError,
  type DeviceFile,
  type DeviceIdentity,
  type DeviceSource,
} from '../device/types.ts'
import { checkStructure } from '../verify/containers.ts'
import { FileAccess } from '../verify/random-access.ts'
import { packTags, type MetadataReader } from '../metadata/reader.ts'
import type { FileMetadata, RawTags } from '../metadata/tags.ts'
import { moveItem, TERMINAL, type Stage } from './stages.ts'
import { backoffMs, classify, sleep, type Classified, type FailureClass } from './retry.ts'
import { writeRunReport } from './report.ts'

export type { Stage } from './stages.ts'

/**
 * The import pipeline.
 *
 * Governing rule: a file is either on disk, verified and recorded, or it is in
 * quarantine with a written reason. There is no third state and nothing fails
 * silently.
 *
 * Resume is not a special code path. Every item carries its stage and its
 * received byte count, so a crash, a cancel and an unplugged cable all recover
 * through the same mechanism: select the items that are not terminal, and seek
 * to where the last attempt stopped.
 */

export interface ImportOptions {
  libraryRoot: string
  /** Directories to walk on the device. */
  sourceDirs?: string[]
  chunkBytes?: number
  maxAttempts?: number
  /** 0 length, 1 hash, 2 structure, 3 decode. L3 is not implemented yet. */
  maxVerifyLevel?: 0 | 1 | 2 | 3
  signal?: AbortSignal
  onProgress?: (p: Progress) => void
  /** Injected so tests are not at the mercy of the wall clock. */
  now?: () => number
  /**
   * When supplied, capture time comes from the file itself rather than the
   * device filesystem, and the raw tags are kept for the grouping pass. Absent,
   * the importer still works and says so through `time_source`.
   */
  metadata?: MetadataReader
  /** Bytes to leave spare on the destination. Default 512 MB. */
  headroomBytes?: number
  /** Run anyway. The report is still produced and still reported. */
  skipPreflight?: boolean
  /** First backoff between transient retries, doubling after. Default 250 ms. 0 disables. */
  retryBaseMs?: number
  /**
   * Re-read the staged file and compare it with the hash taken while
   * streaming, so a disk that did not keep what it was given is caught.
   * Default on.
   */
  readBack?: boolean
  /**
   * A second root to copy every imported file to, verified by read-back. Off
   * when absent. Typically a folder on another drive.
   */
  secondCopyRoot?: string
  /** Fault injection for tests, in the same spirit as FakeDevice. */
  hooks?: { afterFetch?: (stagedPath: string) => void }
}

export interface Progress {
  devicePath: string
  /** Bytes held for the file in flight. */
  bytesReceived: number
  bytesExpected: number
  filesDone: number
  filesTotal: number
  /** Across the whole run, which is what the user is actually waiting on. */
  bytesDone: number
  bytesTotal: number
  /**
   * Measured over a trailing window rather than cumulatively. A cumulative
   * average keeps reporting the speed of a stall long after it has cleared.
   */
  bytesPerSecond: number
  /** Null until there is enough of a rate to divide by. */
  etaMs: number | null
}

/** Trailing-window rate, so a stall shows up and then clears. */
export class RateMeter {
  private samples: { at: number; bytes: number }[] = []

  constructor(private readonly windowMs = 5000) {}

  sample(totalBytes: number, at: number) {
    this.samples.push({ at, bytes: totalBytes })
    const cutoff = at - this.windowMs
    while (this.samples.length > 2 && this.samples[0]!.at < cutoff) this.samples.shift()
  }

  bytesPerSecond(): number {
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    if (!first || !last) return 0
    const seconds = (last.at - first.at) / 1000
    if (seconds <= 0) return 0
    return Math.max(0, (last.bytes - first.bytes) / seconds)
  }
}

export interface Failure {
  devicePath: string
  level: number
  detail: string
  cls: FailureClass | null
}

/**
 * What a run would do, answered before it does any of it.
 *
 * Returned as data rather than thrown, so a UI can render the numbers and let
 * the user decide. A run that cannot possibly fit should fail in the first
 * second, not forty minutes in.
 */
export interface Preflight {
  ok: boolean
  device: DeviceIdentity
  filesOnDevice: number
  filesToImport: number
  filesAlreadyImported: number
  /** Remaining bytes, so a resumed run does not count what it already holds. */
  bytesToTransfer: number
  destinationFreeBytes: number | null
  destinationWritable: boolean
  problems: string[]
}

export class PreflightFailed extends Error {
  constructor(readonly report: Preflight) {
    super(report.problems.join('; '))
    this.name = 'PreflightFailed'
  }
}

export interface ImportReport {
  runId: number
  preflight: Preflight
  imported: number
  skipped: number
  quarantined: number
  bytes: number
  durationMs: number
  failures: Failure[]
  /** The plain-text report on disk, or null if it could not be written. */
  reportPath: string | null
}

export class ImportCancelled extends Error {
  constructor() {
    super('import cancelled')
    this.name = 'ImportCancelled'
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.dng': 'image/x-adobe-dng',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.aae': 'application/xml',
}

function mimeFor(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
}

function two(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * The wall-clock reading to file a photo under.
 *
 * With a known offset this is the original local time, so a photo taken at
 * 18:26 in Tokyo files under 1826 rather than being rewritten into the
 * importer's own timezone. Without one, fall back to the host's local time.
 */
export function wallClock(utcMs: number, offsetSeconds: number | null): number {
  if (offsetSeconds !== null) return utcMs + offsetSeconds * 1000
  return utcMs - new Date(utcMs).getTimezoneOffset() * 60_000
}

/** `<root>/YYYY/YYYY-MM/YYYYMMDD_HHMMSS_<stem><ext>` */
export function destinationFor(libraryRoot: string, wallMs: number, originalName: string): string {
  const d = new Date(wallMs)
  const y = d.getUTCFullYear()
  const stamp =
    `${y}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}_` +
    `${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`
  const ext = path.extname(originalName)
  const stem = path.basename(originalName, ext)
  return path.join(libraryRoot, String(y), `${y}-${two(d.getUTCMonth() + 1)}`, `${stamp}_${stem}${ext}`)
}

interface ItemRow {
  id: number
  device_path: string
  device_size: number
  device_mtime: number
  stage: Stage
  bytes_received: number
  attempts: number
  staging_path: string | null
}

export class ImportEngine {
  constructor(
    private readonly db: Db,
    private readonly device: DeviceSource,
  ) {}

  async run(opts: ImportOptions): Promise<ImportReport> {
    const now = opts.now ?? Date.now
    const started = now()
    const chunkBytes = opts.chunkBytes ?? 4 * 1024 * 1024
    const maxAttempts = opts.maxAttempts ?? 3
    const maxLevel = opts.maxVerifyLevel ?? 2
    const sourceDirs = opts.sourceDirs ?? ['/DCIM']

    const identity = await this.device.identity()
    this.db
      .prepare(
        `INSERT INTO device (udid, name, product_type, os_version, last_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(udid) DO UPDATE SET
           name = excluded.name, product_type = excluded.product_type,
           os_version = excluded.os_version, last_seen = excluded.last_seen`,
      )
      .run(identity.udid, identity.name, identity.model, identity.osVersion, now())

    // Enumerate once and share the result, so the preflight does not cost a
    // second walk of a 4,600 file camera roll.
    const files = await this.enumerate(sourceDirs)
    const report = this.assess(identity, files, opts)
    if (!report.ok && !opts.skipPreflight) throw new PreflightFailed(report)

    const runId = this.openRun(identity.udid, opts.libraryRoot, now())
    const sessionStart = now()
    const staging = path.join(opts.libraryRoot, '.staging', String(runId))
    fs.mkdirSync(staging, { recursive: true })

    const failures: Failure[] = []
    let imported = 0
    let bytes = 0
    const meter = new RateMeter()
    const bytesTotal = report.bytesToTransfer
    let bytesBefore = 0
    let skippedAtPlan = 0

    let done = 0
    try {
      skippedAtPlan = this.plan(runId, identity.udid, files, now)
      await this.retireGone(runId, identity.udid, files, sourceDirs, opts.libraryRoot, now)

      const pending = this.db
        .prepare(
          `SELECT id, device_path, device_size, device_mtime, stage, bytes_received, attempts, staging_path
             FROM import_item
            WHERE run_id = ? AND stage NOT IN (${TERMINAL.map(() => '?').join(', ')})
            ORDER BY device_mtime ASC, id ASC`,
        )
        .all(runId, ...TERMINAL) as ItemRow[]
      const total = pending.length

      for (const item of pending) {
        this.throwIfCancelled(opts.signal)

        const stagedPath = item.staging_path ?? path.join(staging, stagingName(item.device_path))
        const outcome = await this.processItem(item, stagedPath, {
          runId,
          retryBaseMs: opts.retryBaseMs ?? 250,
          secondCopyRoot: opts.secondCopyRoot,
          readBack: opts.readBack ?? true,
          hooks: opts.hooks,
          chunkBytes,
          maxAttempts,
          maxLevel,
          libraryRoot: opts.libraryRoot,
          metadata: opts.metadata,
          signal: opts.signal,
          now,
          onProgress: (received) => {
            if (!opts.onProgress) return
            const bytesDone = bytesBefore + received
            const at = now()
            meter.sample(bytesDone, at)
            const rate = meter.bytesPerSecond()
            opts.onProgress({
              devicePath: item.device_path,
              bytesReceived: received,
              bytesExpected: item.device_size,
              filesDone: done,
              filesTotal: total,
              bytesDone,
              bytesTotal,
              bytesPerSecond: rate,
              etaMs: rate > 0 ? Math.max(0, ((bytesTotal - bytesDone) / rate) * 1000) : null,
            })
          },
        })

        bytesBefore += Math.max(0, item.device_size - item.bytes_received)
        done++
        if (outcome.stage === 'committed') {
          imported++
          bytes += outcome.bytes ?? 0
        } else if (outcome.stage === 'quarantined') {
          failures.push({
            devicePath: item.device_path,
            level: outcome.level ?? 0,
            detail: outcome.detail ?? 'unknown failure',
            cls: outcome.cls ?? null,
          })
        }
      }
      this.closeRun(runId, 'done', now(), sessionStart)
    } catch (e) {
      this.closeRun(runId, 'aborted', now(), sessionStart, stopReason(e))
      this.tryWriteReport(runId, opts.libraryRoot)
      throw e
    }
    const reportPath = this.tryWriteReport(runId, opts.libraryRoot)

    const quarantined = this.db
      .prepare(`SELECT COUNT(*) AS n FROM import_item WHERE run_id = ? AND stage = 'quarantined'`)
      .get(runId) as { n: number }

    return {
      runId,
      preflight: report,
      imported,
      skipped: skippedAtPlan,
      quarantined: quarantined.n,
      bytes,
      durationMs: now() - started,
      failures,
      reportPath,
    }
  }

  /* ------------------------------------------------------------- run rows */

  private openRun(udid: string, libraryRoot: string, at: number): number {
    const existing = this.db
      .prepare(
        `SELECT id FROM import_run
          WHERE device_udid = ? AND library_root = ? AND status = 'running'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(udid, libraryRoot) as { id: number } | undefined
    if (existing) return existing.id

    const res = this.db
      .prepare(
        `INSERT INTO import_run (device_udid, library_root, started_at, status)
         VALUES (?, ?, ?, 'running')`,
      )
      .run(udid, libraryRoot, at)
    return Number(res.lastInsertRowid)
  }

  private closeRun(
    runId: number,
    status: 'done' | 'aborted',
    at: number,
    sessionStart: number,
    reason: string | null = null,
  ) {
    // An aborted run stays resumable: its items keep their stages, and the next
    // run adopts them. Only "done" is final, and it clears any earlier reason
    // for stopping, since a resumed run that finishes did not stop.
    this.db
      .prepare(
        `UPDATE import_run
            SET status = ?, finished_at = ?, stop_reason = ?,
                active_ms = active_ms + ?, sessions = sessions + 1
          WHERE id = ?`,
      )
      .run(
        status === 'done' ? 'done' : 'running',
        at,
        status === 'done' ? null : reason,
        Math.max(0, at - sessionStart),
        runId,
      )
  }

  /**
   * Retire items the phone no longer has, so they are not fetched and do not
   * show up as failures.
   *
   * An unfinished run keeps its items, and a later run adopts them. If a file
   * was deleted from the phone in between, opening it fails with "object not
   * found" and it used to land in quarantine as a permanent failure. The first
   * real full-library run reported 167 of those.
   *
   * Missing from this listing is not proof, because a caller can list a
   * filtered view of the device (the smoke import does). So each candidate is
   * checked by asking the device about that one path. It is gone if the device
   * says it does not exist, or if it now has a different size or timestamp,
   * which means a newer version with its own row replaced it.
   *
   * Quarantined items are only retired when quarantine holds no bytes for them.
   * Bytes are something the user might still want to accept.
   */
  private async retireGone(
    runId: number,
    udid: string,
    files: DeviceFile[],
    sourceDirs: string[],
    libraryRoot: string,
    now: () => number,
  ): Promise<number> {
    const listed = new Set(files.map((f) => itemKey(f.path, f.mtimeMs, f.size)))
    const roots = sourceDirs.map((d) => `${d.replace(/\/+$/, '')}/`)
    const open = this.db
      .prepare(
        `SELECT id, device_path, device_mtime, device_size, stage, staging_path FROM import_item
          WHERE device_udid = ? AND stage NOT IN ('committed', 'skipped', 'gone')`,
      )
      .all(udid) as {
      id: number
      device_path: string
      device_mtime: number
      device_size: number
      stage: Stage
      staging_path: string | null
    }[]

    let retired = 0
    for (const row of open) {
      if (listed.has(itemKey(row.device_path, row.device_mtime, row.device_size))) continue
      if (!roots.some((r) => row.device_path.startsWith(r))) continue

      const quarantined = path.join(libraryRoot, '.quarantine', quarantineName(row.device_path))
      if (row.stage === 'quarantined' && fs.existsSync(quarantined)) continue

      let reason: string
      try {
        const st = await this.device.stat(row.device_path)
        if (st.size === row.device_size && st.mtimeMs === row.device_mtime) continue
        reason = 'replaced on the device by a newer version'
      } catch (e) {
        if (e instanceof DeviceDetachedError) throw e
        if (classify(e).cls !== 'permanent') throw e
        reason = 'deleted from the device before it was imported'
      }

      moveItem(
        this.db,
        row.id,
        'gone',
        { run_id: runId, fail_detail: reason, fail_level: null, fail_class: null, staging_path: null },
        now(),
      )
      fs.rmSync(`${quarantined}.json`, { force: true })
      if (row.staging_path) fs.rmSync(row.staging_path, { force: true })
      retired++
    }
    return retired
  }

  /**
   * A report that fails to write must not hide why the run ended, or turn a
   * finished import into a failed one. Warn and carry on.
   */
  private tryWriteReport(runId: number, libraryRoot: string): string | null {
    try {
      return writeRunReport(this.db, runId, libraryRoot).text
    } catch (e) {
      console.warn(`could not write the report for run ${runId}: ${(e as Error).message}`)
      return null
    }
  }

  /* ---------------------------------------------------------------- plan */

  /** Walk the device once. Listing is cheap; stat is what costs. */
  private async enumerate(sourceDirs: string[]): Promise<DeviceFile[]> {
    const files: DeviceFile[] = []
    for (const dir of sourceDirs) {
      await this.collect(dir, files)
    }
    return files
  }

  private plan(
    runId: number,
    udid: string,
    files: DeviceFile[],
    now: () => number,
  ): number {
    const find = this.db.prepare(
      `SELECT id, stage, run_id FROM import_item
        WHERE device_udid = ? AND device_path = ? AND device_mtime = ? AND device_size = ?`,
    )
    const insert = this.db.prepare(
      `INSERT INTO import_item
         (run_id, device_udid, device_path, device_size, device_mtime, stage, updated_at)
       VALUES (?, ?, ?, ?, ?, 'planned', ?)`,
    )
    const adopt = this.db.prepare(`UPDATE import_item SET run_id = ?, updated_at = ? WHERE id = ?`)

    let skipped = 0
    this.db.transaction(() => {
      for (const f of files) {
        const row = find.get(udid, f.path, f.mtimeMs, f.size) as
          | { id: number; stage: Stage; run_id: number }
          | undefined
        if (!row) {
          insert.run(runId, udid, f.path, f.size, f.mtimeMs, now())
        } else if (TERMINAL.includes(row.stage)) {
          // Already dealt with in an earlier run. This is what makes a second
          // import of the same phone take seconds. Items this same run finished
          // before it was interrupted are its own work, not skips.
          if (row.run_id !== runId) skipped++
        } else {
          adopt.run(runId, now(), row.id)
        }
      }
      this.db.prepare(`UPDATE import_run SET files_skipped = ? WHERE id = ?`).run(skipped, runId)
    })()

    return skipped
  }

  /* ----------------------------------------------------------- preflight */

  /** Enumerate and assess without importing anything. */
  async preflight(opts: ImportOptions): Promise<Preflight> {
    const identity = await this.device.identity()
    const files = await this.enumerate(opts.sourceDirs ?? ['/DCIM'])
    return this.assess(identity, files, opts)
  }

  private assess(identity: DeviceIdentity, files: DeviceFile[], opts: ImportOptions): Preflight {
    const find = this.db.prepare(
      `SELECT stage, bytes_received FROM import_item
        WHERE device_udid = ? AND device_path = ? AND device_mtime = ? AND device_size = ?`,
    )

    let toImport = 0
    let already = 0
    let bytes = 0
    for (const f of files) {
      const row = find.get(identity.udid, f.path, f.mtimeMs, f.size) as
        | { stage: Stage; bytes_received: number }
        | undefined
      if (row && TERMINAL.includes(row.stage)) {
        already++
        continue
      }
      toImport++
      // A resumed item only needs the bytes it does not already hold.
      bytes += Math.max(0, f.size - (row?.bytes_received ?? 0))
    }

    const writable = isWritable(opts.libraryRoot)
    const free = freeBytesOn(opts.libraryRoot)
    const headroom = opts.headroomBytes ?? 512 * 1024 * 1024

    const problems: string[] = []
    if (!writable) problems.push(`destination is not writable: ${opts.libraryRoot}`)
    if (free !== null && bytes + headroom > free) {
      problems.push(
        `needs ${gb(bytes)} plus ${gb(headroom)} headroom, but only ${gb(free)} is free`,
      )
    }

    // The second copy gets the same checks. Better to find out now than to
    // finish an import whose backup quietly stopped halfway.
    if (opts.secondCopyRoot) {
      if (!isWritable(opts.secondCopyRoot)) {
        problems.push(`second copy destination is not writable: ${opts.secondCopyRoot}`)
      } else {
        const free2 = freeBytesOn(opts.secondCopyRoot)
        if (free2 !== null && bytes + headroom > free2) {
          problems.push(`second copy needs ${gb(bytes)} plus ${gb(headroom)} headroom, but only ${gb(free2)} is free`)
        }
      }
    }

    return {
      ok: problems.length === 0,
      device: identity,
      filesOnDevice: files.length,
      filesToImport: toImport,
      filesAlreadyImported: already,
      bytesToTransfer: bytes,
      destinationFreeBytes: free,
      destinationWritable: writable,
      problems,
    }
  }

  private async collect(dir: string, into: DeviceFile[]): Promise<void> {
    for (const name of await this.device.list(dir)) {
      const full = `${dir.replace(/\/+$/, '')}/${name}`
      const st = await this.device.stat(full)
      if (st.isDirectory) await this.collect(full, into)
      else into.push(st)
    }
  }

  /* ------------------------------------------------------------- one item */

  private async processItem(
    item: ItemRow,
    stagedPath: string,
    ctx: ItemContext,
  ): Promise<ItemOutcome> {
    let attempts = item.attempts
    let received = item.bytes_received

    // A staging file that disagrees with the recorded count cannot be trusted
    // to resume from, so start it over rather than splicing onto garbage.
    if (received > 0) {
      const actual = fs.existsSync(stagedPath) ? fs.statSync(stagedPath).size : 0
      if (actual !== received) received = 0
    }
    if (received === 0 && fs.existsSync(stagedPath)) fs.rmSync(stagedPath)

    for (;;) {
      this.throwIfCancelled(ctx.signal)
      attempts++
      moveItem(
        this.db,
        item.id,
        'fetching',
        { bytes_received: received, attempts, staging_path: stagedPath },
        ctx.now(),
      )

      let hash: Hash
      try {
        hash = received > 0 ? seedHash(stagedPath) : createHash('sha256')
        received = await this.fetch(item, stagedPath, received, hash, ctx)
      } catch (e) {
        if (e instanceof ImportCancelled) throw e
        const parked = () =>
          moveItem(
            this.db,
            item.id,
            'planned',
            { bytes_received: sizeOf(stagedPath), attempts, staging_path: stagedPath },
            ctx.now(),
          )
        if (e instanceof DeviceDetachedError) {
          // Persist progress and stop. Retrying without a device is pointless,
          // and the next run resumes from exactly here.
          parked()
          throw e
        }

        const failure = classify(e)
        this.recordAttempt(item.id, ctx.runId, attempts, failure, ctx.now())
        if (failure.cls === 'fatal') {
          // Every later file would fail the same way. Stop and say why.
          parked()
          throw e
        }
        if (failure.cls === 'permanent') {
          return this.quarantine(item, stagedPath, ctx, 0, `read failed, not retried: ${failure.detail}`, attempts, failure.cls)
        }
        if (attempts >= ctx.maxAttempts) {
          return this.quarantine(item, stagedPath, ctx, 0, `read failed after ${attempts} attempts: ${failure.detail}`, attempts, failure.cls)
        }
        // Resume from whatever survived rather than starting over.
        received = sizeOf(stagedPath)
        await this.backoff(attempts, ctx)
        continue
      }

      ctx.hooks?.afterFetch?.(stagedPath)
      const digest = hash.digest('hex')
      moveItem(this.db, item.id, 'verifying', { bytes_received: received, sha256: digest }, ctx.now())

      // L0: the bytes we hold against the size the device claimed. This is the
      // check that catches a transcode-length mismatch immediately.
      if (received !== item.device_size) {
        const detail = `expected ${item.device_size} bytes, received ${received}`
        if (attempts < ctx.maxAttempts && received < item.device_size) {
          this.recordAttempt(item.id, ctx.runId, attempts, { cls: 'transient', detail }, ctx.now())
          await this.backoff(attempts, ctx)
          continue
        }
        return this.quarantine(item, stagedPath, ctx, 0, detail, attempts, null)
      }

      // L1: the hash. It was taken from the bytes as they arrived. Reading the
      // file back proves the disk kept them. A size check cannot tell the
      // difference, which is why ingest tools sell the read-back as a feature.
      // The read may come from the OS cache rather than the platter. It still
      // catches a write that went wrong between this process and the cache.
      if (ctx.readBack && ctx.maxLevel >= 1) {
        const onDisk = hashFile(stagedPath)
        if (onDisk !== digest) {
          return this.quarantine(
            item,
            stagedPath,
            ctx,
            1,
            `bytes on disk differ from bytes received (sha256 ${onDisk.slice(0, 12)} on disk, ${digest.slice(0, 12)} received)`,
            attempts,
            null,
          )
        }
      }

      // L2: structure.
      if (ctx.maxLevel >= 2) {
        const access = FileAccess.open(stagedPath)
        try {
          const result = checkStructure(access, path.extname(item.device_path))
          if (!result.ok) {
            return this.quarantine(item, stagedPath, ctx, 2, `${result.format}: ${result.detail}`, attempts, null)
          }
        } finally {
          access.close()
        }
      }

      // Metadata is read from the staged file, which is complete and verified
      // by this point, so the destination path uses the real capture time
      // rather than the device's filesystem timestamp.
      let extracted: { meta: FileMetadata; raw: RawTags } | null = null
      if (ctx.metadata && path.extname(item.device_path).toLowerCase() !== '.aae') {
        try {
          extracted = await ctx.metadata.read(stagedPath, item.device_mtime)
        } catch {
          // A file we cannot read tags from is still a file worth keeping.
          extracted = null
        }
      }

      const bytes = this.commit(item, stagedPath, digest, ctx, extracted)
      return { stage: 'committed', bytes }
    }
  }

  private async fetch(
    item: ItemRow,
    stagedPath: string,
    from: number,
    hash: Hash,
    ctx: { chunkBytes: number; signal?: AbortSignal; onProgress: (n: number) => void },
  ): Promise<number> {
    fs.mkdirSync(path.dirname(stagedPath), { recursive: true })
    const handle = await this.device.open(item.device_path)
    const fd = fs.openSync(stagedPath, from > 0 ? 'a' : 'w')
    let received = from

    // Guard against a device that keeps serving past its declared size, so a
    // misbehaving responder cannot fill the disk.
    const ceiling = item.device_size * 2 + 1024 * 1024

    try {
      if (from > 0) await handle.seek(from)
      for (;;) {
        this.throwIfCancelled(ctx.signal)
        const chunk = await handle.read(ctx.chunkBytes)
        if (chunk.length === 0) break
        fs.writeSync(fd, chunk)
        hash.update(chunk)
        received += chunk.length
        ctx.onProgress(received)
        if (received > ceiling) {
          throw new Error(`device served more than twice its declared size for ${item.device_path}`)
        }
      }
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
      await handle.close()
    }
    return received
  }

  private commit(
    item: ItemRow,
    stagedPath: string,
    digest: string,
    ctx: { libraryRoot: string; secondCopyRoot?: string; now: () => number },
    extracted: { meta: FileMetadata; raw: RawTags } | null,
  ): number {
    // Which clock was used is recorded on the asset later, so "the dates are
    // wrong" stays diagnosable instead of being a mystery.
    const capturedUtc = extracted?.meta.capturedUtcMs ?? item.device_mtime
    const offset = extracted?.meta.capturedOffsetSeconds ?? null
    let dest = destinationFor(
      ctx.libraryRoot,
      wallClock(capturedUtc, offset),
      path.basename(item.device_path),
    )

    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const place = this.place(dest, digest, ctx.libraryRoot)
    dest = place.dest

    if (place.kind === 'existing') {
      // These exact bytes are already in the library under this name, from
      // another device path or an earlier run. Point at them, keep one copy.
      fs.rmSync(stagedPath, { force: true })
      moveItem(this.db, item.id, 'committed', { file_id: place.fileId, staging_path: null }, ctx.now())
      this.mirror(place.fileId, dest, digest, ctx)
      return fs.statSync(dest).size
    }

    // Rename within the volume is atomic, so a crash leaves either the old
    // state or the new one, never a half-written file at a real path.
    fs.renameSync(stagedPath, dest)
    const bytes = fs.statSync(dest).size
    fs.utimesSync(dest, new Date(capturedUtc), new Date(capturedUtc))

    if (place.kind === 'restore') {
      // The record was right and the bytes on disk were missing or damaged.
      // They have just been replaced with verified ones.
      this.db.transaction(() => {
        this.db
          .prepare(`UPDATE file SET bytes = ?, verified_at = ?, verify_level = 2 WHERE id = ?`)
          .run(bytes, ctx.now(), place.fileId)
        moveItem(this.db, item.id, 'committed', { file_id: place.fileId, staging_path: null }, ctx.now())
      })()
      this.mirror(place.fileId, dest, digest, ctx)
      return bytes
    }

    const rel = relPath(ctx.libraryRoot, dest)
    let fileId = 0
    this.db.transaction(() => {
      const res = this.db
        .prepare(
          `INSERT INTO file (asset_id, role, is_primary, path, bytes, sha256, mime, verified_at, verify_level, created_at)
           VALUES (NULL, 'master', 1, ?, ?, ?, ?, ?, 2, ?)`,
        )
        .run(rel, bytes, digest, mimeFor(item.device_path), ctx.now(), ctx.now())
      fileId = Number(res.lastInsertRowid)

      if (extracted) {
        const m = extracted.meta
        this.db
          .prepare(
            `INSERT INTO exif (file_id, raw, make, model, lens, iso, f_number, exposure, focal_mm)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            fileId,
            packTags(extracted.raw),
            m.make,
            m.model,
            m.lens,
            m.iso,
            m.fNumber,
            m.exposure,
            m.focalMm,
          )
      }
      moveItem(this.db, item.id, 'committed', { file_id: fileId, staging_path: null }, ctx.now())
    })()

    this.mirror(fileId, dest, digest, ctx)
    return bytes
  }

  /**
   * The second copy, when one is configured. Same relative path under the
   * second root, written to a temp name, renamed, then read back and compared
   * with the import hash. Lightroom and Photo Mechanic both offer this, because
   * the moment of import is when you hold the only copy off the phone.
   *
   * Never throws. The original is already committed and verified, and a full
   * or unplugged backup drive must not turn a good import into a failed one.
   * The error is recorded on the file instead, so it can be redone.
   */
  private mirror(
    fileId: number,
    dest: string,
    digest: string,
    ctx: { libraryRoot: string; secondCopyRoot?: string; now: () => number },
  ) {
    if (!ctx.secondCopyRoot) return
    const done = this.db.prepare(`SELECT mirror_verified_at FROM file WHERE id = ?`).get(fileId) as
      | { mirror_verified_at: number | null }
      | undefined
    if (done?.mirror_verified_at) return

    const target = path.join(ctx.secondCopyRoot, path.relative(ctx.libraryRoot, dest))
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const tmp = `${target}.partial`
      fs.copyFileSync(dest, tmp)
      fs.renameSync(tmp, target)
      const back = hashFile(target)
      if (back !== digest) throw new Error(`second copy differs from the original (sha256 ${back.slice(0, 12)})`)
      this.db
        .prepare(`UPDATE file SET mirror_verified_at = ?, mirror_error = NULL WHERE id = ?`)
        .run(ctx.now(), fileId)
    } catch (e) {
      this.db.prepare(`UPDATE file SET mirror_error = ? WHERE id = ?`).run((e as Error).message, fileId)
    }
  }

  /**
   * Where these bytes go, given what is already at the destination.
   *
   * A path is only free if neither the disk nor the `file` table claims it.
   * Checking only the disk is how the same path got inserted twice. A path
   * that holds these exact bytes is reused instead of getting a `_1` twin.
   * Different content that wants the same name moves on to the next suffix.
   *
   * - new:      nothing there. Write and record it.
   * - existing: recorded and on disk with these bytes. Link to it.
   * - restore:  recorded with these bytes, but the disk copy is gone or damaged.
   * - adopt:    on disk with these bytes but never recorded, which is what a
   *             crash between the rename and the database write leaves behind.
   */
  private place(dest: string, digest: string, libraryRoot: string): Placement {
    const find = this.db.prepare(`SELECT id, sha256 FROM file WHERE path = ?`)
    const ext = path.extname(dest)
    const stem = dest.slice(0, dest.length - ext.length)

    for (let n = 0; ; n++) {
      const candidate = n === 0 ? dest : `${stem}_${n}${ext}`
      const row = find.get(relPath(libraryRoot, candidate)) as { id: number; sha256: string } | undefined
      const onDisk = fs.existsSync(candidate)

      if (row) {
        if (row.sha256 !== digest) continue
        if (onDisk && hashFile(candidate) === digest) return { kind: 'existing', dest: candidate, fileId: row.id }
        return { kind: 'restore', dest: candidate, fileId: row.id }
      }
      if (!onDisk) return { kind: 'new', dest: candidate }
      if (hashFile(candidate) === digest) return { kind: 'adopt', dest: candidate }
    }
  }

  private quarantine(
    item: ItemRow,
    stagedPath: string,
    ctx: { libraryRoot: string; now: () => number },
    level: number,
    detail: string,
    attempts: number,
    cls: FailureClass | null,
  ): ItemOutcome {
    const dir = path.join(ctx.libraryRoot, '.quarantine')
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, quarantineName(item.device_path))

    if (fs.existsSync(stagedPath)) {
      fs.renameSync(stagedPath, target)
    }

    // The report next to the file is what turns a dead end into something the
    // user can act on. This is the thing the stock app refuses to do.
    fs.writeFileSync(
      `${target}.json`,
      JSON.stringify(
        {
          devicePath: item.device_path,
          expectedBytes: item.device_size,
          receivedBytes: fs.existsSync(target) ? fs.statSync(target).size : 0,
          failedLevel: level,
          failureClass: cls,
          detail,
          attempts,
          at: new Date(ctx.now()).toISOString(),
        },
        null,
        2,
      ),
    )

    moveItem(
      this.db,
      item.id,
      'quarantined',
      { fail_level: level, fail_detail: detail, fail_class: cls, staging_path: null },
      ctx.now(),
    )

    return { stage: 'quarantined', level, detail, cls }
  }

  private recordAttempt(itemId: number, runId: number, attempt: number, f: Classified, at: number) {
    this.db
      .prepare(
        `INSERT INTO import_attempt (item_id, run_id, attempt, class, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(itemId, runId, attempt, f.cls, f.detail, at)
  }

  private async backoff(attempt: number, ctx: ItemContext) {
    await sleep(backoffMs(attempt, ctx.retryBaseMs), ctx.signal)
    this.throwIfCancelled(ctx.signal)
  }

  private throwIfCancelled(signal?: AbortSignal) {
    if (signal?.aborted) throw new ImportCancelled()
  }
}

/** In words a person reads in the report, not a stack trace. */
function stopReason(e: unknown): string {
  if (e instanceof DeviceDetachedError) return `device disconnected (${e.message})`
  if (e instanceof ImportCancelled) return 'cancelled'
  return (e as Error)?.message ?? String(e)
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/**
 * Actually write, rather than asking. `fs.access` with W_OK reports almost
 * everything as writable on Windows, including directories a write will fail on.
 */
function isWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-probe-${process.pid}`)
    fs.writeFileSync(probe, '')
    fs.rmSync(probe)
    return true
  } catch {
    return false
  }
}

function freeBytesOn(dir: string): number | null {
  try {
    const stat = fs.statfsSync(dir)
    return Number(stat.bavail) * Number(stat.bsize)
  } catch {
    // Unknown is not the same as zero, and refusing a run over a stat we could
    // not take would be worse than letting it proceed.
    return null
  }
}

function stagingName(devicePath: string): string {
  return `${flatten(devicePath)}.partial`
}

/**
 * Named by the whole device path, not the basename. iPhone file numbers wrap
 * at IMG_9999 and start again in the next 1xxAPPLE folder, so two failures can
 * share a basename and would otherwise overwrite each other's bytes and report.
 */
export function quarantineName(devicePath: string): string {
  return flatten(devicePath)
}

function flatten(devicePath: string): string {
  return devicePath.replace(/^\/+/, '').replace(/[\\/]/g, '_')
}

function itemKey(devicePath: string, mtimeMs: number, size: number): string {
  return `${devicePath}\0${mtimeMs}\0${size}`
}

type Placement =
  | { kind: 'new' | 'adopt'; dest: string }
  | { kind: 'existing' | 'restore'; dest: string; fileId: number }

/** The form stored in `file.path`: relative to the library, forward slashes. */
function relPath(libraryRoot: string, abs: string): string {
  return path.relative(libraryRoot, abs).split(path.sep).join('/')
}

function sizeOf(file: string): number {
  return fs.existsSync(file) ? fs.statSync(file).size : 0
}

function hashFile(file: string): string {
  return seedHash(file).digest('hex')
}

interface ItemContext {
  runId: number
  retryBaseMs: number
  readBack: boolean
  secondCopyRoot?: string
  hooks?: ImportOptions['hooks']
  chunkBytes: number
  maxAttempts: number
  maxLevel: number
  libraryRoot: string
  metadata?: MetadataReader
  signal?: AbortSignal
  now: () => number
  onProgress: (received: number) => void
}

interface ItemOutcome {
  stage: Stage
  bytes?: number
  level?: number
  detail?: string
  cls?: FailureClass | null
}

/** Rebuild the running hash from the bytes already staged. */
function seedHash(stagedPath: string): Hash {
  const hash = createHash('sha256')
  const fd = fs.openSync(stagedPath, 'r')
  try {
    const buf = Buffer.alloc(1024 * 1024)
    for (let pos = 0; ; ) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      if (n === 0) break
      hash.update(buf.subarray(0, n))
      pos += n
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash
}
