import type { Db } from '../library/db.ts'

/**
 * The only code allowed to change `import_item.stage`.
 *
 * Every move is checked against the table below, inside the same UPDATE that
 * makes it, so a check and a write cannot race. A move that is not in the table
 * is a bug in the engine, and it throws instead of quietly recording a state
 * nobody designed. Dropbox found a duplicate-upload bug this way that their unit
 * tests had missed: a flood of DONE to DONE transitions.
 */

export type Stage =
  | 'planned'
  | 'fetching'
  | 'verifying'
  | 'committed'
  | 'skipped'
  | 'quarantined'
  | 'gone'

/**
 * `gone` means the device no longer has this file, or has a newer version of it
 * under a different row. Nothing to fetch, and nothing failed.
 */
export const TERMINAL: readonly Stage[] = ['committed', 'skipped', 'quarantined', 'gone']

/** For each stage, the stages an item may arrive from. */
const ARRIVES_FROM: Record<Stage, readonly Stage[]> = {
  // Detach mid-read parks it for the next run. Requeue brings it back from quarantine.
  planned: ['fetching', 'quarantined'],
  // A retry re-enters fetching. A crashed run leaves items in fetching or
  // verifying, and the next run starts them over from here.
  fetching: ['planned', 'fetching', 'verifying'],
  verifying: ['fetching'],
  // Accepting a quarantined file commits it without passing verification.
  committed: ['verifying', 'quarantined'],
  quarantined: ['fetching', 'verifying'],
  // Skips are counted at plan time and never written as a stage.
  skipped: [],
  // Deleted from the phone before it was imported. A quarantined read failure
  // for a file that has since been deleted was never a real failure either.
  gone: ['planned', 'fetching', 'verifying', 'quarantined'],
}

export function canMove(from: Stage, to: Stage): boolean {
  return ARRIVES_FROM[to].includes(from)
}

export class IllegalTransition extends Error {
  constructor(
    readonly itemId: number,
    readonly from: Stage | null,
    readonly to: Stage,
  ) {
    super(
      from === null
        ? `import_item ${itemId} does not exist (wanted ${to})`
        : `import_item ${itemId} cannot move from ${from} to ${to}`,
    )
    this.name = 'IllegalTransition'
  }
}

/** Columns a transition may set alongside the stage. Names are fixed, never user input. */
export interface ItemFields {
  bytes_received?: number
  attempts?: number
  staging_path?: string | null
  sha256?: string | null
  file_id?: number | null
  fail_level?: number | null
  fail_detail?: string | null
  fail_class?: string | null
  run_id?: number
}

const COLUMNS: readonly (keyof ItemFields)[] = [
  'run_id',
  'bytes_received',
  'attempts',
  'staging_path',
  'sha256',
  'file_id',
  'fail_level',
  'fail_detail',
  'fail_class',
]

/**
 * Move one item to `to`, setting `fields` in the same statement.
 *
 * Throws IllegalTransition if the item's current stage may not move there.
 */
export function moveItem(db: Db, itemId: number, to: Stage, fields: ItemFields = {}, at = Date.now()) {
  const from = ARRIVES_FROM[to]
  const sets = ['stage = ?', 'updated_at = ?']
  const values: unknown[] = [to, at]
  for (const col of COLUMNS) {
    if (col in fields) {
      sets.push(`${col} = ?`)
      values.push(fields[col])
    }
  }

  const placeholders = from.map(() => '?').join(', ')
  const sql =
    from.length === 0
      ? null
      : `UPDATE import_item SET ${sets.join(', ')} WHERE id = ? AND stage IN (${placeholders})`

  const changed = sql ? db.prepare(sql).run(...values, itemId, ...from).changes : 0
  if (changed === 1) return

  const row = db.prepare(`SELECT stage FROM import_item WHERE id = ?`).get(itemId) as
    | { stage: Stage }
    | undefined
  throw new IllegalTransition(itemId, row?.stage ?? null, to)
}
