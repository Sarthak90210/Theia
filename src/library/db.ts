import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS } from './schema.ts'

export type Db = Database.Database

/**
 * Opens the library database. One writer, held by whoever calls this; workers
 * get job descriptors instead of a connection. Keeping writes in one place
 * removes a class of locking bugs and makes crash recovery a replay of one
 * transaction rather than a reconciliation.
 *
 * The file is real, never `:memory:`, including under test. WAL recovery is
 * behaviour we depend on, and an in-memory database would not exercise it.
 */
export function openLibrary(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]!
    db.transaction(() => {
      db.exec(sql)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}

export function now(): number {
  return Date.now()
}
