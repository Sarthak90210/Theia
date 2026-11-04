import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openLibrary, type Db } from '../src/library/db.ts'
import { backfillPlaceNames, type PlaceSource } from '../src/gallery/place-backfill.ts'
import { vaultDetail } from '../src/gallery/vault-gallery.ts'
import type { PhoneAsset, PlaceInfo } from '../src/gallery/phone-library.ts'
import { scratch, type Scratch } from './helpers.ts'

let s: Scratch
let db: Db
const at = Date.UTC(2026, 2, 1, 10)
const named: PlaceInfo = { label: 'Bengaluru Urban - Dibburu', city: 'Bengaluru', region: 'Karnataka', country: 'India' }

beforeEach(() => { s = scratch(); db = openLibrary(s.dbPath) })
afterEach(() => { db.close(); s.cleanup() })

function asset(uuid: string | null = null, t: number | null = at): number {
  return Number(db.prepare(`INSERT INTO asset (kind, source_uuid, captured_utc, lat, lon, created_at, updated_at)
    VALUES ('still', ?, ?, 12.9, 77.6, 1, 1)`).run(uuid, t).lastInsertRowid)
}

function imported(id: number, phonePath = '/DCIM/100APPLE/IMG_0001.JPG', udid = 'phone-1', role = 'master', stage = 'committed') {
  db.prepare(`INSERT OR IGNORE INTO device (udid) VALUES (?)`).run(udid)
  const run = db.prepare(`INSERT INTO import_run (device_udid, library_root, started_at, status) VALUES (?, ?, 1, 'done')`).run(udid, s.libraryRoot)
  const file = db.prepare(`INSERT INTO file (asset_id, role, is_primary, path, bytes, sha256, mime, created_at)
    VALUES (?, ?, 1, ?, 50, 'hash', 'image/jpeg', 1)`).run(id, role, `Library/${id}.jpg`)
  db.prepare(`INSERT INTO import_item (run_id, device_udid, device_path, device_size, device_mtime, stage, file_id, updated_at)
    VALUES (?, ?, ?, 50, ?, ?, ?, 1)`).run(run.lastInsertRowid, udid, phonePath, id, stage, file.lastInsertRowid)
}

function phoneAsset(key = 'UUID-1', path = '/DCIM/100APPLE/IMG_0001.JPG', t = at): PhoneAsset {
  return {
    key, path, t, kind: 'photo', directory: 'DCIM/100APPLE', filename: 'IMG_0001.JPG', originalName: null,
    off: null, w: 40, h: 30, dur: null, fav: false, edited: false, cloud: false, subtype: null,
    lat: 12.9, lon: 77.6, burstId: null,
  }
}

function phone(assets = [phoneAsset()], place: PlaceInfo | null = named, udid = 'phone-1'): PlaceSource {
  return { udid, library: { byKey: new Map(assets.map(a => [a.key, a])) }, extras: () => ({ place }) }
}

function label(id: number): string | null {
  return vaultDetail(db, s.libraryRoot, String(id))!.location!.place
}

describe('backfilling place names from a phone', () => {
  it('fills an exact UUID and persists the name for offline browsing', () => {
    const id = asset('UUID-1')
    expect(backfillPlaceNames(db, phone(), 100)).toBe(1)
    expect(label(id)).toBe(named.label)
    expect(db.prepare(`SELECT lat, lon, updated_at FROM asset WHERE id = ?`).get(id)).toEqual({ lat: 12.9, lon: 77.6, updated_at: 100 })
    db.close()
    db = openLibrary(s.dbPath)
    expect(label(id)).toBe(named.label)
    expect(backfillPlaceNames(db, phone())).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM place`).get()).toEqual({ n: 1 })
  })

  it('fills an old import through its committed file, phone id, full path and capture time', () => {
    const id = asset()
    imported(id)
    expect(backfillPlaceNames(db, phone())).toBe(1)
    expect(label(id)).toBe(named.label)
  })

  it('does not match the same filename on another phone or in another directory', () => {
    const wrongPhone = asset()
    const wrongDirectory = asset()
    imported(wrongPhone, '/DCIM/100APPLE/IMG_0001.JPG', 'other-phone')
    imported(wrongDirectory, '/DCIM/101APPLE/IMG_0001.JPG')
    expect(backfillPlaceNames(db, phone())).toBe(0)
    expect(label(wrongPhone)).toBeNull()
    expect(label(wrongDirectory)).toBeNull()
  })

  it('refuses a reused path, unknown capture time, and a conflicting source UUID', () => {
    for (const [uuid, t] of [[null, at - 86400000], [null, null], ['another-uuid', at]] as const) {
      const id = asset(uuid, t)
      imported(id)
    }
    expect(backfillPlaceNames(db, phone())).toBe(0)
  })

  it('preserves an existing label and does not invent one when the phone has none', () => {
    const id = asset('UUID-1')
    expect(backfillPlaceNames(db, phone([phoneAsset()], null))).toBe(0)
    expect(backfillPlaceNames(db, phone([phoneAsset()], { ...named, label: ' ' }))).toBe(0)
    expect(backfillPlaceNames(db, phone())).toBe(1)
    expect(backfillPlaceNames(db, phone([phoneAsset()], { ...named, label: 'Changed on phone' }))).toBe(0)
    expect(label(id)).toBe(named.label)
  })

  it('does not identify an old item through a motion file or an uncommitted import', () => {
    imported(asset(), '/DCIM/100APPLE/IMG_0001.JPG', 'phone-1', 'motion')
    imported(asset(), '/DCIM/100APPLE/IMG_0001.JPG', 'phone-1', 'master', 'failed')
    expect(backfillPlaceNames(db, phone())).toBe(0)
  })

  it('skips ambiguous phone paths and leaves unknown-coordinate items alone', () => {
    const id = asset()
    imported(id)
    expect(backfillPlaceNames(db, phone([phoneAsset(), phoneAsset('UUID-2')]))).toBe(0)
    const missingCoords = asset('UUID-1')
    db.prepare(`UPDATE asset SET lat = NULL WHERE id = ?`).run(missingCoords)
    expect(backfillPlaceNames(db, phone([phoneAsset('UUID-1', '/DCIM/102APPLE/OTHER.JPG')], named))).toBe(0)
  })
})
