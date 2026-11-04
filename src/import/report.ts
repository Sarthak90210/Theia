import fs from 'node:fs'
import path from 'node:path'
import type { Db } from '../library/db.ts'
import type { FailureClass } from './retry.ts'

/**
 * A run report that outlives the terminal it was printed in.
 *
 * Built from the database rather than from the engine's memory, so the same
 * function works at the end of a run and for any past run later. Written to
 * disk as JSON for tools and as plain text for a person, because "which files
 * didn't make it, and why" has to be answerable months after the import.
 */

export interface RunReport {
  runId: number
  device: { udid: string; name: string | null; model: string | null; osVersion: string | null }
  libraryRoot: string
  startedAt: string
  finishedAt: string | null
  /** done, or stopped with a reason. A stopped run resumes on the next import. */
  status: 'done' | 'stopped' | 'running'
  stopReason: string | null
  durationMs: number | null
  imported: number
  skipped: number
  quarantined: number
  /** Planned items still waiting, which is non-zero only for a stopped run. */
  pending: number
  /** Deleted from the phone, or replaced by a newer version, before it was imported. */
  gone: number
  /** Separate sittings of this run. More than one means it was stopped and resumed. */
  sessions: number
  bytesImported: number
  /** Over the run's wall clock, so it includes enumeration and verification. */
  averageBytesPerSecond: number | null
  quarantine: { devicePath: string; level: number; cls: FailureClass | null; detail: string }[]
  /** Second copies of this run's files. All zero when none was configured. */
  secondCopy: { verified: number; failed: { path: string; error: string }[] }
  /**
   * Failed attempts by class. `recovered` counts files that failed at least
   * once this way and were still imported, which is what says whether
   * retrying that class is worth it.
   */
  attempts: Record<FailureClass, { failures: number; files: number; recovered: number }>
}

export function buildRunReport(db: Db, runId: number): RunReport {
  const run = db
    .prepare(
      `SELECT r.id, r.device_udid, r.library_root, r.started_at, r.finished_at, r.status,
              r.files_skipped, r.stop_reason, r.active_ms, r.sessions,
              d.name, d.product_type, d.os_version
         FROM import_run r LEFT JOIN device d ON d.udid = r.device_udid
        WHERE r.id = ?`,
    )
    .get(runId) as
    | {
        id: number
        device_udid: string
        library_root: string
        started_at: number
        finished_at: number | null
        status: string
        files_skipped: number
        active_ms: number
        sessions: number
        stop_reason: string | null
        name: string | null
        product_type: string | null
        os_version: string | null
      }
    | undefined
  if (!run) throw new Error(`no import run ${runId}`)

  const counts = db
    .prepare(
      `SELECT
         SUM(stage = 'committed')   AS imported,
         SUM(stage = 'quarantined') AS quarantined,
         SUM(stage = 'gone')        AS gone,
         SUM(stage NOT IN ('committed','quarantined','skipped','gone')) AS pending
       FROM import_item WHERE run_id = ?`,
    )
    .get(runId) as {
    imported: number | null
    quarantined: number | null
    gone: number | null
    pending: number | null
  }

  const bytes = db
    .prepare(
      `SELECT COALESCE(SUM(f.bytes), 0) AS n
         FROM import_item i JOIN file f ON f.id = i.file_id
        WHERE i.run_id = ? AND i.stage = 'committed'`,
    )
    .get(runId) as { n: number }

  const quarantine = (
    db
      .prepare(
        `SELECT device_path, fail_level, fail_class, fail_detail
           FROM import_item WHERE run_id = ? AND stage = 'quarantined'
          ORDER BY device_path`,
      )
      .all(runId) as {
      device_path: string
      fail_level: number | null
      fail_class: FailureClass | null
      fail_detail: string | null
    }[]
  ).map((r) => ({
    devicePath: r.device_path,
    level: r.fail_level ?? 0,
    cls: r.fail_class,
    detail: r.fail_detail ?? 'unknown failure',
  }))

  const mirrored = db
    .prepare(
      `SELECT COUNT(*) AS n FROM import_item i JOIN file f ON f.id = i.file_id
        WHERE i.run_id = ? AND i.stage = 'committed' AND f.mirror_verified_at IS NOT NULL`,
    )
    .get(runId) as { n: number }
  const mirrorFailed = (
    db
      .prepare(
        `SELECT f.path, f.mirror_error FROM import_item i JOIN file f ON f.id = i.file_id
          WHERE i.run_id = ? AND i.stage = 'committed' AND f.mirror_error IS NOT NULL
          ORDER BY f.path`,
      )
      .all(runId) as { path: string; mirror_error: string }[]
  ).map((r) => ({ path: r.path, error: r.mirror_error }))

  const attempts: RunReport['attempts'] = {
    transient: { failures: 0, files: 0, recovered: 0 },
    permanent: { failures: 0, files: 0, recovered: 0 },
    fatal: { failures: 0, files: 0, recovered: 0 },
  }
  const byClass = db
    .prepare(
      `SELECT a.class AS cls,
              COUNT(*) AS failures,
              COUNT(DISTINCT a.item_id) AS files,
              COUNT(DISTINCT CASE WHEN i.stage = 'committed' THEN a.item_id END) AS recovered
         FROM import_attempt a JOIN import_item i ON i.id = a.item_id
        WHERE a.run_id = ?
        GROUP BY a.class`,
    )
    .all(runId) as { cls: FailureClass; failures: number; files: number; recovered: number }[]
  for (const row of byClass) {
    if (row.cls in attempts) {
      attempts[row.cls] = { failures: row.failures, files: row.files, recovered: row.recovered }
    }
  }

  const finished = run.finished_at
  // Active time, not first start to last finish. Rows from before active time
  // was recorded have none, and for those the span is the only figure there is.
  const durationMs =
    run.active_ms > 0 ? run.active_ms : finished === null ? null : finished - run.started_at
  const status: RunReport['status'] =
    run.status === 'done' ? 'done' : run.stop_reason !== null ? 'stopped' : 'running'

  return {
    runId: run.id,
    device: {
      udid: run.device_udid,
      name: run.name,
      model: run.product_type,
      osVersion: run.os_version,
    },
    libraryRoot: run.library_root,
    startedAt: new Date(run.started_at).toISOString(),
    finishedAt: finished === null ? null : new Date(finished).toISOString(),
    status,
    stopReason: run.stop_reason,
    durationMs,
    imported: counts.imported ?? 0,
    skipped: run.files_skipped,
    quarantined: counts.quarantined ?? 0,
    pending: counts.pending ?? 0,
    gone: counts.gone ?? 0,
    sessions: run.sessions,
    bytesImported: bytes.n,
    averageBytesPerSecond: durationMs && durationMs > 0 && bytes.n > 0 ? (bytes.n / durationMs) * 1000 : null,
    quarantine,
    secondCopy: { verified: mirrored.n, failed: mirrorFailed },
    attempts,
  }
}

const MB = 1024 ** 2
const GB = 1024 ** 3

function size(n: number): string {
  return n >= GB ? `${(n / GB).toFixed(2)} GB` : `${(n / MB).toFixed(1)} MB`
}

function took(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

const LEVEL = ['size', 'hash', 'structure', 'decode']

/** The JSON keeps UTC. The text is for a person, in the machine's own zone. */
function localTime(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const zone = `${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${zone}`
  )
}

/** Plain text, for a person opening the file in Notepad. */
export function renderRunReport(r: RunReport): string {
  const lines: string[] = []
  const device = [r.device.name, r.device.model, r.device.osVersion && `iOS ${r.device.osVersion}`]
    .filter(Boolean)
    .join(', ')

  lines.push(`Import run ${r.runId}`)
  lines.push(`Device   ${device || r.device.udid}`)
  lines.push(`Library  ${r.libraryRoot}`)
  lines.push(`Started  ${localTime(r.startedAt)}`)
  if (r.finishedAt) lines.push(`Ended    ${localTime(r.finishedAt)}`)
  if (r.durationMs !== null) {
    const over = r.sessions > 1 ? `, over ${r.sessions} sessions` : ''
    lines.push(`Active   ${took(r.durationMs)}${over}`)
  }
  lines.push('')

  if (r.status === 'done') lines.push('Finished.')
  else if (r.status === 'stopped') {
    lines.push(`Stopped: ${r.stopReason}`)
    lines.push(`${r.pending} files are still waiting. Running the import again picks up where this stopped.`)
  } else lines.push('Still running, or ended without recording why.')
  lines.push('')

  const rate = r.averageBytesPerSecond === null ? '' : `, ${(r.averageBytesPerSecond / MB).toFixed(1)} MB/s average`
  lines.push(`Imported     ${r.imported} files, ${size(r.bytesImported)}${rate}`)
  lines.push(`Skipped      ${r.skipped} already in the library`)
  if (r.gone > 0) lines.push(`Gone         ${r.gone} deleted from the phone before they were imported`)
  lines.push(`Quarantined  ${r.quarantined}`)
  if (r.secondCopy.verified > 0 || r.secondCopy.failed.length > 0) {
    lines.push(`Second copy  ${r.secondCopy.verified} verified, ${r.secondCopy.failed.length} failed`)
    for (const f of r.secondCopy.failed) lines.push(`    ${f.path}: ${f.error}`)
  }

  if (r.quarantine.length > 0) {
    lines.push('')
    lines.push('Files that did not make it')
    for (const q of r.quarantine) {
      lines.push(`  ${q.devicePath}`)
      // A class means the read itself failed, before any check ran.
      if (q.cls) lines.push(`    ${q.detail} (${q.cls})`)
      else lines.push(`    failed ${LEVEL[q.level] ?? `level ${q.level}`} check: ${q.detail}`)
    }
    lines.push('')
    lines.push('Quarantined files and a report for each are in .quarantine next to the library.')
  }

  const anyRetries = Object.values(r.attempts).some((a) => a.failures > 0)
  if (anyRetries) {
    lines.push('')
    lines.push('Failed attempts')
    for (const [cls, a] of Object.entries(r.attempts)) {
      if (a.failures === 0) continue
      lines.push(`  ${cls.padEnd(10)} ${a.failures} failures across ${a.files} files, ${a.recovered} recovered`)
    }
  }

  return lines.join('\r\n') + '\r\n'
}

/**
 * Write both forms under `<libraryRoot>/.reports` and record where.
 * Named by run id and start time, so they sort in order in Explorer.
 */
export function writeRunReport(db: Db, runId: number, libraryRoot: string): { json: string; text: string } {
  const report = buildRunReport(db, runId)
  const dir = path.join(libraryRoot, '.reports')
  fs.mkdirSync(dir, { recursive: true })

  const when = report.startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, '')
  const base = path.join(dir, `run-${String(runId).padStart(4, '0')}-${when}`)
  const json = `${base}.json`
  const text = `${base}.txt`

  // Same stage-then-rename as the media, so a crash mid-write never leaves a
  // half report where a whole one is expected.
  writeAtomic(json, JSON.stringify(report, null, 2))
  writeAtomic(text, renderRunReport(report))

  db.prepare(`UPDATE import_run SET report_path = ? WHERE id = ?`).run(text, runId)
  return { json, text }
}

function writeAtomic(file: string, content: string) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}
