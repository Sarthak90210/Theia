import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { phoneCollections, phoneItems, readPhoneLibrary, toAppleSeconds } from '../src/gallery/phone-library.ts'
import { scratch, type Scratch } from './helpers.ts'

/**
 * A Photos.sqlite shaped like the published iOS schema: ZASSET, the extra
 * attributes table, ZGENERICALBUM, and an album membership table whose name
 * carries Core Data entity numbers. Built by hand, because the real one is a
 * person's photo library.
 */

let s: Scratch
let dbPath: string

beforeEach(() => {
  s = scratch()
  dbPath = path.join(s.libraryRoot, '..', 'Photos.sqlite')
})
afterEach(() => s.cleanup())

const T = (iso: string) => toAppleSeconds(Date.parse(iso))

interface Fixture {
  table?: 'ZASSET' | 'ZGENERICASSET'
  join?: string
}

function build(f: Fixture = {}) {
  const table = f.table ?? 'ZASSET'
  const join = f.join ?? 'Z_33ASSETS'
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE ${table} (Z_PK INTEGER PRIMARY KEY, ZUUID TEXT, ZDIRECTORY TEXT, ZFILENAME TEXT,
      ZDATECREATED REAL, ZKIND INTEGER, ZKINDSUBTYPE INTEGER, ZFAVORITE INTEGER, ZHIDDEN INTEGER,
      ZTRASHEDSTATE INTEGER, ZVISIBILITYSTATE INTEGER, ZWIDTH INTEGER, ZHEIGHT INTEGER, ZDURATION REAL,
      ZLATITUDE REAL, ZLONGITUDE REAL, ZHASADJUSTMENTS INTEGER, ZAVALANCHEUUID TEXT);
    CREATE TABLE ZADDITIONALASSETATTRIBUTES (Z_PK INTEGER PRIMARY KEY, ZASSET INTEGER, ZTIMEZONEOFFSET INTEGER,
      ZORIGINALFILENAME TEXT, ZCAMERACAPTUREDEVICE INTEGER);
    CREATE TABLE ZGENERICALBUM (Z_PK INTEGER PRIMARY KEY, ZUUID TEXT, ZTITLE TEXT, ZKIND INTEGER,
      ZTRASHEDSTATE INTEGER, Z_FOK_PARENTFOLDER INTEGER);
    CREATE TABLE ${join} (Z_30ALBUMS INTEGER, ${join.replace('Z_33', 'Z_3')} INTEGER, Z_FOK_3ASSETS INTEGER);
  `)
  const asset = db.prepare(
    `INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  )
  // pk, uuid, dir, file, created, kind, subtype, fav, trashed, w, h, dur, lat, lon, adj, burst
  asset.run(1, 'U1', 'DCIM/100APPLE', 'IMG_0001.HEIC', T('2026-01-05T10:00:00Z'), 0, 2, 1, 0, 4032, 3024, 0, 15.5, 73.8, 0, null)
  asset.run(2, 'U2', 'DCIM/100APPLE', 'IMG_0002.MOV', T('2026-01-06T10:00:00Z'), 1, 0, 0, 0, 1920, 1080, 12.5, -180, -180, 0, null)
  asset.run(3, 'U3', 'DCIM/100APPLE', 'IMG_0003.PNG', T('2026-01-04T10:00:00Z'), 0, 10, 0, 0, 1179, 2556, 0, -180, -180, 0, null)
  asset.run(4, 'U4', 'DCIM/101APPLE', 'IMG_0004.HEIC', T('2026-01-07T10:00:00Z'), 0, 0, 0, 0, 3024, 4032, 0, -180, -180, 1, null)
  asset.run(5, 'U5', 'DCIM/101APPLE', 'IMG_0005.HEIC', T('2026-01-08T10:00:00Z'), 0, 0, 0, 1, 3024, 4032, 0, -180, -180, 0, null) // trashed

  const attr = db.prepare(`INSERT INTO ZADDITIONALASSETATTRIBUTES VALUES (?, ?, ?, ?, ?)`)
  attr.run(1, 1, 19800, 'IMG_0001.HEIC', 0)
  attr.run(4, 4, 32400, 'IMG_0004.HEIC', 1)

  db.prepare(`INSERT INTO ZGENERICALBUM VALUES (1, 'A-TRIP', 'Goa trip', 2, 0, 2)`).run()
  db.prepare(`INSERT INTO ZGENERICALBUM VALUES (2, 'A-CATS', 'Cats', 2, 0, 1)`).run()
  db.prepare(`INSERT INTO ZGENERICALBUM VALUES (3, 'A-SYS', NULL, 3, 0, 0)`).run() // not a user album
  const member = db.prepare(`INSERT INTO ${join} VALUES (?, ?, ?)`)
  member.run(1, 4, 1) // album order differs from date order on purpose
  member.run(1, 1, 2)
  member.run(2, 2, 1)
  db.close()
}

const onPhone = (missing: string[] = []) => (p: string) => !missing.includes(p)

describe('reading the phone gallery', () => {
  it('lists the Library oldest first, skipping trashed items', () => {
    build()
    const lib = readPhoneLibrary(dbPath, onPhone())
    expect(lib.assets.map((a) => a.key)).toEqual(['U3', 'U1', 'U2', 'U4'])
    expect(lib.schema.assetTable).toBe('ZASSET')
  })

  it('turns Core Data dates, kinds and offsets into gallery items', () => {
    build()
    const lib = readPhoneLibrary(dbPath, onPhone())
    const live = lib.byKey.get('U1')!
    expect(new Date(live.t).toISOString()).toBe('2026-01-05T10:00:00.000Z')
    expect(live).toMatchObject({ kind: 'live', fav: true, off: 19800, lat: 15.5, lon: 73.8, path: '/DCIM/100APPLE/IMG_0001.HEIC' })
    expect(lib.byKey.get('U2')).toMatchObject({ kind: 'video', dur: 12500, lat: null })
    expect(lib.byKey.get('U3')!.subtype).toBe('screenshot')
    expect(lib.byKey.get('U4')).toMatchObject({ subtype: 'selfie', edited: true })
  })

  it('keeps each album in the phone’s own order, and albums in the phone’s order', () => {
    build()
    const lib = readPhoneLibrary(dbPath, onPhone())
    expect(lib.albums.map((a) => a.name)).toEqual(['Cats', 'Goa trip'])
    expect(phoneItems(lib, 'album:A-TRIP').map((a) => a.key)).toEqual(['U4', 'U1'])
  })

  it('finds the membership table whatever its entity number', () => {
    build({ join: 'Z_33ASSETS' })
    expect(readPhoneLibrary(dbPath, onPhone()).schema.albumJoin).toBe('Z_33ASSETS')
  })

  it('reads the pre-iOS 14 table name too', () => {
    build({ table: 'ZGENERICASSET' })
    expect(readPhoneLibrary(dbPath, onPhone()).assets).toHaveLength(4)
  })

  it('shows a burst as one tile and keeps every frame for the viewer', () => {
    build()
    const db = new Database(dbPath)
    // pk, uuid, dir, file, created, kind, subtype, fav, trashed, visibility, w, h, dur, lat, lon, adj, burst
    const add = db.prepare(`INSERT INTO ZASSET VALUES (?, ?, 'DCIM/101APPLE', ?, ?, 0, 0, 0, 0, 0, ?, 4032, 3024, 0, -180, -180, 0, 'B1')`)
    add.run(10, 'F1', 'IMG_0010.HEIC', T('2026-01-09T10:00:00Z'), 0) // the pick, visible
    add.run(11, 'F2', 'IMG_0011.HEIC', T('2026-01-09T10:00:01Z'), 2) // hidden frame
    db.close()
    const lib = readPhoneLibrary(dbPath, onPhone())
    expect(lib.assets.filter((a) => a.kind === 'burst').map((a) => a.key)).toEqual(['F1'])
    expect(lib.bursts.get('B1')).toEqual(['F1', 'F2'])
    expect(lib.byKey.get('F2')?.path).toBe('/DCIM/101APPLE/IMG_0011.HEIC')
  })

  it('marks an item whose file is not on the phone as iCloud only', () => {
    build()
    const lib = readPhoneLibrary(dbPath, onPhone(['/DCIM/100APPLE/IMG_0002.MOV']))
    expect(lib.byKey.get('U2')!.cloud).toBe(true)
    expect(lib.byKey.get('U1')!.cloud).toBe(false)
  })

  it('builds the sidebar collections from what is there', () => {
    build()
    const c = phoneCollections(readPhoneLibrary(dbPath, onPhone()))
    expect(c.smart.map((x) => `${x.name}:${x.count}`)).toEqual([
      'Library:4',
      'Favourites:1',
      'Videos:1',
      'Live Photos:1',
      'Screenshots:1',
      'Selfies:1',
      'Edited:1',
      'Hidden:0',
      'Recently Deleted:1',
    ])
    expect(c.smart.find((x) => x.id === 'deleted')?.kind).toBe('utility')
    expect(c.albums.map((x) => `${x.name}:${x.count}`)).toEqual(['Cats:1', 'Goa trip:2'])
  })

  it("lists the phone's Hidden album and Recently Deleted apart from the Library", () => {
    build()
    const db = new Database(dbPath)
    db.prepare(`UPDATE ZASSET SET ZHIDDEN = 1 WHERE ZUUID = 'U3'`).run()
    db.close()
    const lib = readPhoneLibrary(dbPath, onPhone())
    expect(lib.assets.map((a) => a.key)).not.toContain('U3')
    expect(phoneItems(lib, 'hidden').map((a) => a.key)).toEqual(['U3'])
    expect(phoneItems(lib, 'deleted').map((a) => a.key)).toEqual(['U5'])
    expect(lib.byKey.get('U5')?.path).toBe('/DCIM/101APPLE/IMG_0005.HEIC')
  })
})
