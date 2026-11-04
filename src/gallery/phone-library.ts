import Database from 'better-sqlite3'
import bplist from 'bplist-parser'
import type { CollectionInfo, Collections, GalleryItem, ItemKind } from './types.ts'

/**
 * The phone's own gallery, read from a local copy of its Photos database
 * (`/PhotoData/Photos.sqlite`, fetched over AFC with its -wal and -shm).
 *
 * This is what gives the app the phone's order, albums, favourites and media
 * types. The files in /DCIM carry none of that.
 *
 * Column names drift between iOS versions: the asset table was ZGENERICASSET
 * before iOS 14 and ZASSET after, and album membership lives in a join table
 * whose name embeds Core Data entity numbers (Z_28ASSETS and the like). So
 * nothing here is hard-coded beyond the stable core: every table and optional
 * column is looked up before it is used, and anything missing degrades to a
 * plainer answer instead of an error.
 *
 * Whether an item is only in iCloud is decided by the caller, from the /DCIM
 * listing: if its file is not on the phone, it cannot be copied over USB,
 * whatever the database says.
 */

/** Core Data stores dates as seconds since 2001-01-01 UTC. */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)

export interface PhoneAsset extends GalleryItem {
  /** Path on the phone through AFC, e.g. /DCIM/100APPLE/IMG_0001.HEIC */
  path: string
  directory: string
  filename: string
  originalName: string | null
  lat: number | null
  lon: number | null
  burstId: string | null
}

export interface PhoneAlbum {
  uuid: string
  name: string
  keys: string[]
}

export interface PhoneLibrary {
  assets: PhoneAsset[]
  /** Includes burst frames that are not in `assets`. */
  byKey: Map<string, PhoneAsset>
  /** Every frame of each burst, in capture order, by burst id. */
  bursts: Map<string, string[]>
  /** The phone's Hidden album, in capture order. */
  hidden: string[]
  /** The phone's Recently Deleted, in capture order. */
  deleted: string[]
  albums: PhoneAlbum[]
  /** Which schema shape was found, for the findings log. */
  schema: { assetTable: string; albumJoin: string | null; columns: number }
}

type Row = Record<string, unknown>

export function readPhoneLibrary(dbPath: string, onPhone: (path: string) => boolean): PhoneLibrary {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const tables = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name),
    )
    const assetTable = tables.has('ZASSET') ? 'ZASSET' : tables.has('ZGENERICASSET') ? 'ZGENERICASSET' : null
    if (!assetTable) throw new Error('no asset table in Photos.sqlite')
    const cols = columns(db, assetTable)
    const has = (c: string) => cols.has(c)

    const attrTable = tables.has('ZADDITIONALASSETATTRIBUTES') ? 'ZADDITIONALASSETATTRIBUTES' : null
    const attrCols = attrTable ? columns(db, attrTable) : new Set<string>()
    const attrJoin =
      attrTable && attrCols.has('ZASSET') ? `LEFT JOIN ${attrTable} attr ON attr.ZASSET = a.Z_PK` : ''
    const attr = (c: string, as: string) => (attrJoin && attrCols.has(c) ? `attr.${c} AS ${as}` : `NULL AS ${as}`)
    const col = (c: string, as = c) => (has(c) ? `a.${c} AS ${as}` : `NULL AS ${as}`)

    const where: string[] = []
    if (has('ZTRASHEDSTATE')) where.push('COALESCE(a.ZTRASHEDSTATE, 0) = 0')
    if (has('ZHIDDEN')) where.push('COALESCE(a.ZHIDDEN, 0) = 0')
    // Visibility 0 is the normal case. Burst frames that are not the pick and
    // other internal assets are hidden from the Library the same way.
    if (has('ZVISIBILITYSTATE')) where.push('COALESCE(a.ZVISIBILITYSTATE, 0) = 0')

    const select = (filter: string[]) =>
      db
        .prepare(
          `SELECT a.Z_PK AS pk, ${col('ZUUID', 'uuid')}, a.ZDIRECTORY AS dir, a.ZFILENAME AS file,
                ${col('ZDATECREATED', 'created')}, ${col('ZKIND', 'kind')}, ${col('ZKINDSUBTYPE', 'subtype')},
                ${col('ZFAVORITE', 'fav')}, ${col('ZWIDTH', 'w')}, ${col('ZHEIGHT', 'h')},
                ${col('ZDURATION', 'dur')}, ${col('ZLATITUDE', 'lat')}, ${col('ZLONGITUDE', 'lon')},
                ${col('ZHASADJUSTMENTS', 'adj')}, ${col('ZAVALANCHEUUID', 'burst')}, ${col('ZTRASHEDDATE', 'trashedAt')},
                ${attr('ZTIMEZONEOFFSET', 'tz')}, ${attr('ZORIGINALFILENAME', 'orig')},
                ${attr('ZCAMERACAPTUREDEVICE', 'capdev')}
           FROM ${assetTable} a ${attrJoin}
          ${filter.length ? `WHERE ${filter.join(' AND ')}` : ''}
          ORDER BY ${has('ZDATECREATED') ? 'a.ZDATECREATED,' : ''} a.Z_PK`,
        )
        .all() as Row[]

    const toAsset = (r: Row): PhoneAsset | null => {
      if (typeof r.dir !== 'string' || typeof r.file !== 'string') return null
      const path = `/${r.dir.replace(/^\/+/, '')}/${r.file}`
      const key = typeof r.uuid === 'string' && r.uuid ? r.uuid : `pk${r.pk}`
      const lat = num(r.lat)
      const lon = num(r.lon)
      return {
        key,
        kind: kindOf(num(r.kind), num(r.subtype), r.burst),
        t: num(r.created) !== null ? APPLE_EPOCH_MS + num(r.created)! * 1000 : 0,
        off: num(r.tz),
        w: num(r.w),
        h: num(r.h),
        dur: num(r.dur) !== null ? Math.round(num(r.dur)! * 1000) : null,
        fav: num(r.fav) === 1,
        edited: num(r.adj) === 1,
        cloud: !onPhone(path),
        subtype: subtypeOf(num(r.subtype), num(r.capdev)),
        path,
        directory: r.dir,
        filename: r.file,
        originalName: typeof r.orig === 'string' ? r.orig : null,
        // The phone writes -180 for "no location".
        lat: lat !== null && lat !== -180 && lat !== 0 ? lat : null,
        lon: lon !== null && lon !== -180 && lon !== 0 ? lon : null,
        burstId: typeof r.burst === 'string' ? r.burst : null,
        deletedAt: num(r.trashedAt) !== null ? APPLE_EPOCH_MS + num(r.trashedAt)! * 1000 : null,
      }
    }

    const assets: PhoneAsset[] = []
    const byKey = new Map<string, PhoneAsset>()
    const byPk = new Map<number, PhoneAsset>()
    for (const r of select(where)) {
      const asset = toAsset(r)
      if (!asset) continue
      assets.push(asset)
      byKey.set(asset.key, asset)
      byPk.set(num(r.pk)!, asset)
    }

    // Every frame of every burst, the hidden ones included. The Library shows
    // one tile per burst (the phone's pick); the viewer shows the rest. Frames
    // are looked up by key like any item, so thumbnails and originals work.
    const bursts = new Map<string, string[]>()
    if (has('ZAVALANCHEUUID')) {
      const filter = ['a.ZAVALANCHEUUID IS NOT NULL']
      if (has('ZTRASHEDSTATE')) filter.push('COALESCE(a.ZTRASHEDSTATE, 0) = 0')
      if (has('ZHIDDEN')) filter.push('COALESCE(a.ZHIDDEN, 0) = 0')
      for (const r of select(filter)) {
        const frame = byKey.get(typeof r.uuid === 'string' ? r.uuid : '') ?? toAsset(r)
        if (!frame?.burstId) continue
        byKey.set(frame.key, frame)
        const list = bursts.get(frame.burstId) ?? []
        list.push(frame.key)
        bursts.set(frame.burstId, list)
      }
    }

    // The phone's Hidden album and Recently Deleted. Kept apart from the
    // Library, and readable like any item, so they can be viewed and saved.
    const visible = has('ZVISIBILITYSTATE') ? ['COALESCE(a.ZVISIBILITYSTATE, 0) = 0'] : []
    const listOf = (filter: string[]) => {
      const keys: string[] = []
      for (const r of select([...filter, ...visible])) {
        const asset = toAsset(r)
        if (!asset) continue
        byKey.set(asset.key, asset)
        keys.push(asset.key)
      }
      return keys
    }
    const hidden =
      has('ZHIDDEN') ? listOf(['COALESCE(a.ZHIDDEN, 0) = 1', ...(has('ZTRASHEDSTATE') ? ['COALESCE(a.ZTRASHEDSTATE, 0) = 0'] : [])]) : []
    const deleted = has('ZTRASHEDSTATE') ? listOf(['COALESCE(a.ZTRASHEDSTATE, 0) = 1']) : []

    const { albums, join } = readAlbums(db, tables, byPk)
    return { assets, byKey, bursts, hidden, deleted, albums, schema: { assetTable, albumJoin: join, columns: cols.size } }
  } finally {
    db.close()
  }
}

function readAlbums(
  db: Database.Database,
  tables: Set<string>,
  byPk: Map<number, PhoneAsset>,
): { albums: PhoneAlbum[]; join: string | null } {
  if (!tables.has('ZGENERICALBUM')) return { albums: [], join: null }
  const albumCols = columns(db, 'ZGENERICALBUM')

  // The membership table is named after Core Data entity numbers, which change
  // between iOS versions. Find it by shape: a Z_*ASSETS table with an albums
  // column and an asset column.
  let join: { table: string; album: string; asset: string; order: string | null } | null = null
  for (const t of tables) {
    if (!/^Z_\d+ASSETS$/.test(t)) continue
    const c = [...columns(db, t)]
    const album = c.find((x) => /^Z_\d+ALBUMS$/.test(x))
    const asset = c.find((x) => /^Z_\d+ASSETS$/.test(x))
    if (album && asset) {
      join = { table: t, album, asset, order: c.find((x) => /^Z_FOK_\d+ASSETS$/.test(x)) ?? null }
      break
    }
  }

  const where = ['ZKIND = 2', 'ZTITLE IS NOT NULL']
  if (albumCols.has('ZTRASHEDSTATE')) where.push('COALESCE(ZTRASHEDSTATE, 0) = 0')
  const order = albumCols.has('Z_FOK_PARENTFOLDER') ? 'Z_FOK_PARENTFOLDER, Z_PK' : 'Z_PK'
  const rows = db
    .prepare(
      `SELECT Z_PK AS pk, ${albumCols.has('ZUUID') ? 'ZUUID' : 'NULL'} AS uuid, ZTITLE AS title
         FROM ZGENERICALBUM WHERE ${where.join(' AND ')} ORDER BY ${order}`,
    )
    .all() as { pk: number; uuid: string | null; title: string }[]

  const albums: PhoneAlbum[] = []
  for (const r of rows) {
    let keys: string[] = []
    if (join) {
      const members = db
        .prepare(
          `SELECT ${join.asset} AS asset FROM ${join.table} WHERE ${join.album} = ?
            ORDER BY ${join.order ?? join.asset}`,
        )
        .all(r.pk) as { asset: number }[]
      keys = members.map((m) => byPk.get(m.asset)?.key).filter((k): k is string => !!k)
    }
    albums.push({ uuid: r.uuid ?? `album${r.pk}`, name: r.title, keys })
  }
  return { albums, join: join?.table ?? null }
}

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))
}

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null
}

/**
 * ZKIND: 0 photo, 1 video. ZKINDSUBTYPE: 2 Live Photo, 1 panorama,
 * 10 screenshot, 101 slow motion, 102 time-lapse, 103 screen recording.
 */
function kindOf(kind: number | null, subtype: number | null, burst: unknown): ItemKind {
  if (kind === 1) return 'video'
  if (subtype === 2) return 'live'
  if (typeof burst === 'string' && burst) return 'burst'
  return 'photo'
}

function subtypeOf(subtype: number | null, captureDevice: number | null): string | null {
  switch (subtype) {
    case 1:
      return 'panorama'
    case 10:
      return 'screenshot'
    case 101:
      return 'slomo'
    case 102:
      return 'timelapse'
    case 103:
      return 'screen-recording'
  }
  // 1 is the front camera.
  if (captureDevice === 1) return 'selfie'
  return null
}

const SMART: { id: string; name: string; test: (a: PhoneAsset) => boolean; always?: boolean }[] = [
  { id: 'library', name: 'Library', test: () => true, always: true },
  { id: 'favourites', name: 'Favourites', test: (a) => a.fav },
  { id: 'videos', name: 'Videos', test: (a) => a.kind === 'video' },
  { id: 'live', name: 'Live Photos', test: (a) => a.kind === 'live' },
  { id: 'screenshots', name: 'Screenshots', test: (a) => a.subtype === 'screenshot' },
  { id: 'selfies', name: 'Selfies', test: (a) => a.subtype === 'selfie' },
  { id: 'panoramas', name: 'Panoramas', test: (a) => a.subtype === 'panorama' },
  { id: 'bursts', name: 'Bursts', test: (a) => a.kind === 'burst' },
  { id: 'edited', name: 'Edited', test: (a) => a.edited },
]

export function phoneCollections(lib: PhoneLibrary): Collections {
  const smart: CollectionInfo[] = []
  for (const s of SMART) {
    const members = lib.assets.filter(s.test)
    if (members.length || s.always) {
      smart.push({ id: s.id, name: s.name, kind: 'smart', count: members.length, cover: members.at(-1)?.key ?? null })
    }
  }
  for (const [id, name, keys] of [
    ['hidden', 'Hidden', lib.hidden],
    ['deleted', 'Recently Deleted', lib.deleted],
  ] as const) {
    smart.push({ id, name, kind: 'utility', count: keys.length, cover: keys.at(-1) ?? null })
  }
  const albums = lib.albums.map(
    (a): CollectionInfo => ({
      id: `album:${a.uuid}`,
      name: a.name,
      kind: 'album',
      count: a.keys.length,
      cover: a.keys.at(-1) ?? null,
    }),
  )
  return { smart, albums }
}

export function phoneItems(lib: PhoneLibrary, collectionId: string): PhoneAsset[] {
  const album = /^album:(.+)$/.exec(collectionId)
  if (album) {
    const a = lib.albums.find((x) => x.uuid === album[1])
    return a ? a.keys.map((k) => lib.byKey.get(k)!).filter(Boolean) : []
  }
  if (collectionId === 'hidden') return lib.hidden.map((k) => lib.byKey.get(k)!)
  if (collectionId === 'deleted') return lib.deleted.map((k) => lib.byKey.get(k)!)
  const smart = SMART.find((s) => s.id === collectionId)
  return smart ? lib.assets.filter(smart.test) : []
}

/** For tests: an Apple timestamp from a JS one. */
export function toAppleSeconds(ms: number): number {
  return (ms - APPLE_EPOCH_MS) / 1000
}

/* ---------------------------------------------------------------- extras */

export interface PlaceInfo {
  /** As the phone shows it under the map: "Bengaluru Urban - Dibburu". */
  label: string
  city: string | null
  region: string | null
  country: string | null
}

/** What the phone's info panel shows, all from the database: no file needed. */
export interface PhoneExtras {
  camera: { make: string | null; model: string | null; lens: string | null } | null
  exposure: {
    iso: number | null
    fNumber: number | null
    exposureSeconds: number | null
    focalMm: number | null
    focal35: number | null
    ev: number | null
    zoom: number | null
  } | null
  video: { codec: string | null; fps: number | null } | null
  place: PlaceInfo | null
  caption: string | null
}

const NO_EXTRAS: PhoneExtras = { camera: null, exposure: null, video: null, place: null, caption: null }

/**
 * Camera, exposure, place and caption for one item. ZEXTENDEDATTRIBUTES holds
 * the EXIF summary the phone shows, ZREVERSELOCATIONDATA the place name the
 * phone looked up, and ZASSETDESCRIPTION the caption. Any of them may be
 * missing on another iOS version; missing parts come back null.
 */
export function readPhoneExtras(db: Database.Database, uuid: string): PhoneExtras {
  const tables = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name),
  )
  const assetTable = tables.has('ZASSET') ? 'ZASSET' : tables.has('ZGENERICASSET') ? 'ZGENERICASSET' : null
  if (!assetTable) return NO_EXTRAS
  const asset = db.prepare(`SELECT Z_PK AS pk FROM ${assetTable} WHERE ZUUID = ?`).get(uuid) as { pk: number } | undefined
  if (!asset) return NO_EXTRAS
  const out: PhoneExtras = { ...NO_EXTRAS }

  if (tables.has('ZEXTENDEDATTRIBUTES')) {
    const cols = columns(db, 'ZEXTENDEDATTRIBUTES')
    const c = (name: string) => (cols.has(name) ? name : `NULL AS ${name}`)
    const e = db
      .prepare(
        `SELECT ${['ZCAMERAMAKE', 'ZCAMERAMODEL', 'ZLENSMODEL', 'ZISO', 'ZAPERTURE', 'ZSHUTTERSPEED', 'ZFOCALLENGTH', 'ZFOCALLENGTHIN35MM', 'ZEXPOSUREBIAS', 'ZDIGITALZOOMRATIO', 'ZCODEC', 'ZFPS'].map(c).join(', ')}
           FROM ZEXTENDEDATTRIBUTES WHERE ZASSET = ?`,
      )
      .get(asset.pk) as Row | undefined
    if (e) {
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
      if (s(e.ZCAMERAMAKE) || s(e.ZCAMERAMODEL)) {
        out.camera = { make: s(e.ZCAMERAMAKE), model: s(e.ZCAMERAMODEL), lens: s(e.ZLENSMODEL) }
      }
      const exposure = {
        iso: n(e.ZISO),
        fNumber: n(e.ZAPERTURE),
        exposureSeconds: n(e.ZSHUTTERSPEED),
        focalMm: n(e.ZFOCALLENGTH),
        focal35: n(e.ZFOCALLENGTHIN35MM),
        ev: n(e.ZEXPOSUREBIAS),
        zoom: n(e.ZDIGITALZOOMRATIO),
      }
      if (exposure.iso !== null || exposure.fNumber !== null || exposure.exposureSeconds !== null) out.exposure = exposure
      if (s(e.ZCODEC) || n(e.ZFPS)) out.video = { codec: s(e.ZCODEC), fps: n(e.ZFPS) }
    }
  }

  if (tables.has('ZADDITIONALASSETATTRIBUTES')) {
    const cols = columns(db, 'ZADDITIONALASSETATTRIBUTES')
    if (cols.has('ZASSET')) {
      const want = ['Z_PK', 'ZREVERSELOCATIONDATA', 'ZTITLE'].filter((x) => cols.has(x))
      const attr = db.prepare(`SELECT ${want.join(', ')} FROM ZADDITIONALASSETATTRIBUTES WHERE ZASSET = ?`).get(asset.pk) as
        | Row
        | undefined
      if (attr?.ZREVERSELOCATIONDATA instanceof Uint8Array) out.place = placeFromArchive(Buffer.from(attr.ZREVERSELOCATIONDATA))
      if (attr && tables.has('ZASSETDESCRIPTION') && columns(db, 'ZASSETDESCRIPTION').has('ZLONGDESCRIPTION')) {
        const d = db
          .prepare(`SELECT ZLONGDESCRIPTION AS text FROM ZASSETDESCRIPTION WHERE ZASSETATTRIBUTES = ?`)
          .get(attr.Z_PK) as { text: unknown } | undefined
        if (typeof d?.text === 'string' && d.text.trim()) out.caption = d.text.trim()
      }
      if (!out.caption && typeof attr?.ZTITLE === 'string' && attr.ZTITLE.trim()) out.caption = attr.ZTITLE.trim()
    }
  }
  return out
}

/**
 * The place the phone looked up for a photo, from the NSKeyedArchiver blob in
 * ZREVERSELOCATIONDATA. The phone's label under the map is the district, then
 * the neighbourhood: "Bengaluru Urban - Dibburu".
 */
export function placeFromArchive(buf: Buffer): PlaceInfo | null {
  let root: Record<string, unknown>
  let objects: unknown[]
  try {
    const top = bplist.parseBuffer(buf)[0] as { $objects: unknown[]; $top: { root: unknown } }
    objects = top.$objects
    root = deref(objects, top.$top.root) as Record<string, unknown>
  } catch {
    return null
  }
  const str = (v: unknown): string | null => {
    const x = deref(objects, v)
    return typeof x === 'string' && x !== '$null' && x.trim() ? x.trim() : null
  }
  const addr = deref(objects, root?.postalAddress) as Record<string, unknown> | null
  const get = (k: string) => (addr ? str(addr[`_${k}`]) : null)
  const area = get('subAdministrativeArea') ?? get('city')
  const local = get('subLocality') ?? get('street')
  const parts = [area, local].filter((x, i, all): x is string => !!x && all.indexOf(x) === i)
  const label = parts.length ? parts.join(' - ') : (str(root?.addressString)?.split(',')[0] ?? null)
  if (!label) return null
  return { label, city: get('city'), region: get('state'), country: get('country') }
}

function deref(objects: unknown[], v: unknown): unknown {
  for (let i = 0; i < 8 && v && typeof v === 'object' && 'UID' in (v as object); i++) v = objects[(v as { UID: number }).UID]
  return v
}
