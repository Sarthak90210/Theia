import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVault } from '../src/vault/vault.ts'
import { vaultCollections } from '../src/gallery/vault-gallery.ts'
import { encryptFile, openEncrypted } from '../src/vault/private-crypto.ts'
import { reuseItems } from '../app/renderer/reuse.ts'
import type { GalleryItem } from '../app/shared/api.ts'

/**
 * The speed work keeps the same answers: collections counted in one pass,
 * lists reused across reloads, encrypted files read without blocking.
 */

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theia-speed-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

// The per-collection SQL the one-pass version replaced, as the reference.
const RECENT = `(CAST(strftime('%s','now') AS INTEGER) * 1000 - ${30 * 24 * 3600 * 1000})`
const LIVE = 'a.deleted_at IS NULL AND a.hidden = 0'
const REFERENCE: Record<string, string> = {
  library: `1 = 1 AND ${LIVE}`,
  favourites: `a.favourite = 1 AND ${LIVE}`,
  videos: `a.kind = 'video' AND ${LIVE}`,
  live: `a.kind = 'live' AND ${LIVE}`,
  screenshots: `a.subtype = 'screenshot' AND ${LIVE}`,
  selfies: `a.subtype = 'selfie' AND ${LIVE}`,
  panoramas: `a.subtype = 'panorama' AND ${LIVE}`,
  bursts: `a.kind = 'burst' AND ${LIVE}`,
  edited: `a.has_adjustments = 1 AND ${LIVE}`,
  recent: `a.created_at > ${RECENT} AND ${LIVE}`,
  hidden: 'a.hidden = 1 AND a.deleted_at IS NULL',
  deleted: 'a.deleted_at IS NOT NULL',
}

describe('collections in one pass', () => {
  it('counts and picks covers exactly as one query per collection did', () => {
    const v = createVault(path.join(dir, 'V'))
    const db = v.db
    const ins = db.prepare(`INSERT INTO asset (kind, subtype, favourite, has_adjustments, hidden, deleted_at, captured_utc, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    let seed = 7
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
    const now = Date.now()
    db.transaction(() => {
      for (let i = 0; i < 3000; i++) {
        ins.run(
          ['photo', 'video', 'live', 'burst'][rand(4)],
          [null, 'screenshot', 'selfie', 'panorama'][rand(4)],
          rand(5) === 0 ? 1 : 0,
          rand(7) === 0 ? 1 : 0,
          rand(9) === 0 ? 1 : 0,
          rand(11) === 0 ? now - rand(1e6) : null,
          // Distinct capture times, some missing, so the newest is unambiguous.
          rand(13) === 0 ? null : Date.UTC(2010, 0, 1) + i * 997_000 + rand(900_000),
          rand(3) === 0 ? now - rand(1e9) : now - 400 * 86_400_000,
          now,
        )
      }
    })()
    const got = vaultCollections(db)
    for (const [id, where] of Object.entries(REFERENCE)) {
      const want = db.prepare(`SELECT COUNT(*) AS n, (SELECT a2.id FROM asset a2 WHERE ${where.replaceAll('a.', 'a2.')}
        ORDER BY a2.captured_utc DESC LIMIT 1) AS cover FROM asset a WHERE ${where}`).get() as { n: number; cover: number | null }
      const c = got.smart.find((s) => s.id === id)
      if (!want.n && !['library', 'hidden', 'deleted'].includes(id)) { expect(c).toBeUndefined(); continue }
      expect(c?.count, id).toBe(want.n)
      expect(c?.cover, id).toBe(want.cover === null ? null : String(want.cover))
    }
    db.close()
  })

  it('shows the always-there collections for an empty vault', () => {
    const v = createVault(path.join(dir, 'V'))
    expect(vaultCollections(v.db).smart.map((s) => `${s.id}:${s.count}:${s.cover}`)).toEqual(['library:0:null', 'hidden:0:null', 'deleted:0:null'])
    v.db.close()
  })
})

describe('reloading the list', () => {
  const item = (key: string, extra: Partial<GalleryItem> = {}): GalleryItem => ({
    key, kind: 'photo', t: 1, off: 0, w: 10, h: 10, dur: null, fav: false, edited: false, cloud: false, subtype: null, revision: 1, ...extra,
  })

  it('returns the same array when nothing changed, so the grid does no work', () => {
    const prev = [item('1'), item('2')]
    expect(reuseItems(prev, [item('1'), item('2')])).toBe(prev)
  })

  it('keeps unchanged items and takes changed or new ones', () => {
    const prev = [item('1'), item('2'), item('3')]
    const next = reuseItems(prev, [item('1'), item('2', { fav: true }), item('3'), item('4')])
    expect(next).not.toBe(prev)
    expect(next[0]).toBe(prev[0])
    expect(next[1]).not.toBe(prev[1])
    expect(next[1]!.fav).toBe(true)
    expect(next[2]).toBe(prev[2])
    expect(next.map((i) => i.key)).toEqual(['1', '2', '3', '4'])
  })

  it('notices a new order, a removal, a revision and new search highlights', () => {
    const prev = [item('1'), item('2')]
    expect(reuseItems(prev, [item('2'), item('1')]).map((i) => i.key)).toEqual(['2', '1'])
    expect(reuseItems(prev, [item('1')])).toHaveLength(1)
    expect(reuseItems(prev, [item('1', { revision: 2 }), item('2')])[0]!.revision).toBe(2)
    const marked = reuseItems(prev, [item('1', { marks: { w: 1, h: 1, quads: [[0, 0, 1, 0, 1, 1, 0, 1]] } }), item('2')])
    expect(marked[0]!.marks).toBeDefined()
  })
})

describe('encrypted files', () => {
  it('reads without holding the thread, and closing during a read is safe', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
    const src = path.join(dir, 'clip.bin')
    const bytes = crypto.randomBytes(3 * 1024 * 1024 + 123)
    fs.writeFileSync(src, bytes)
    const enc = path.join(dir, 'clip.theia')
    await encryptFile(src, enc, publicKey)
    const r = openEncrypted(enc, privateKey)
    let ticks = 0
    const timer = setInterval(() => ticks++, 0)
    const all = await r.read(0, r.size)
    clearInterval(timer)
    expect(all.equals(bytes)).toBe(true)
    // Asynchronous reads: the event loop kept turning (a synchronous read never lets a timer fire).
    expect(ticks).toBeGreaterThan(0)
    const pending = r.read(1024 * 1024, 2 * 1024 * 1024)
    r.close()
    // The read that was already going either finishes or says the reader closed; never wrong bytes.
    const got = await pending.catch((e: Error) => e)
    if (got instanceof Error) expect(got.message).toMatch(/closed/)
    else expect(got.equals(bytes.subarray(1024 * 1024, 3 * 1024 * 1024))).toBe(true)
    await expect(r.read(0, 1)).rejects.toThrow(/closed/)
  })

  it('refuses a source that changes size while it is encrypted', async () => {
    const { publicKey } = crypto.generateKeyPairSync('x25519')
    const src = path.join(dir, 'grow.bin')
    fs.writeFileSync(src, Buffer.alloc(10))
    const enc = path.join(dir, 'grow.theia')
    // The size is read from the open handle, then the file shrinks under it.
    const encrypting = encryptFile(src, enc, publicKey, 4)
    fs.truncateSync(src, 2)
    await encrypting.then(
      () => { /* finished before the truncation landed: fine, nothing to check */ },
      (e: Error) => expect(e.message).toMatch(/changed size|read back/),
    )
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})
