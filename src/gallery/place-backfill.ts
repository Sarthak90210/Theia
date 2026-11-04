import type { Db } from '../library/db.ts'
import type { PhoneAsset, PhoneExtras, PhoneLibrary, PlaceInfo } from './phone-library.ts'

/** All information comes from the already-copied Photos database, without network requests. */
export interface PlaceSource {
  udid: string
  library: Pick<PhoneLibrary, 'byKey'>
  extras(key: string): Pick<PhoneExtras, 'place'> | null
}

interface MissingPlace {
  id: number
  source_uuid: string | null
  captured_utc: number | null
  lat: number
  lon: number
}

/**
 * Fill missing place names from the same photo on a connected phone. Newer
 * vaults retain its UUID. Older imports retain the phone id, original path and
 * file id; capture time must also agree so a reused DCIM path cannot identify
 * a newer photo as the old import. Existing labels and coordinates stay as-is.
 */
export function backfillPlaceNames(db: Db, phone: PlaceSource, now = Date.now()): number {
  const missing = db.prepare(
    `SELECT a.id, a.source_uuid, a.captured_utc, a.lat, a.lon
       FROM asset a LEFT JOIN place p ON p.id = a.place_id
      WHERE a.deleted_at IS NULL AND a.lat IS NOT NULL AND a.lon IS NOT NULL
        AND (p.label IS NULL OR TRIM(p.label) = '')`,
  ).all() as MissingPlace[]
  if (!missing.length) return 0

  const byPath = new Map<string, PhoneAsset | null>()
  for (const asset of phone.library.byKey.values()) {
    // An ambiguous phone path is not sufficient evidence for an old import.
    byPath.set(asset.path, byPath.has(asset.path) ? null : asset)
  }
  const imported = db.prepare(
    `SELECT DISTINCT f.asset_id AS id, i.device_path AS path
       FROM import_item i JOIN file f ON f.id = i.file_id JOIN asset a ON a.id = f.asset_id
      WHERE i.device_udid = ? AND i.stage = 'committed' AND f.is_primary = 1 AND f.role = 'master'
        AND a.source_uuid IS NULL`,
  ).all(phone.udid) as { id: number; path: string }[]
  const legacy = new Map<number, PhoneAsset | null>()
  for (const row of imported) {
    const asset = byPath.get(row.path)
    if (!asset) continue
    const previous = legacy.get(row.id)
    legacy.set(row.id, legacy.has(row.id) && previous?.key !== asset.key ? null : asset)
  }

  const places = new Map<string, PlaceInfo | null>()
  const updates: { asset: MissingPlace; place: PlaceInfo }[] = []
  for (const row of missing) {
    const match = row.source_uuid ? phone.library.byKey.get(row.source_uuid) : legacy.get(row.id)
    if (!match) continue
    if (!row.source_uuid && (row.captured_utc === null || !match.t || Math.abs(row.captured_utc - match.t) > 1000)) continue
    if (!places.has(match.key)) places.set(match.key, phone.extras(match.key)?.place ?? null)
    const place = places.get(match.key)
    if (place?.label.trim()) updates.push({ asset: row, place })
  }
  if (!updates.length) return 0

  const insert = db.prepare(`INSERT INTO place (country, region, city, label, lat, lon) VALUES (?, ?, ?, ?, ?, ?)`)
  const update = db.prepare(`UPDATE asset SET place_id = ?, updated_at = ? WHERE id = ?`)
  db.transaction(() => {
    for (const { asset, place } of updates) {
      const id = insert.run(place.country, place.region, place.city, place.label, asset.lat, asset.lon).lastInsertRowid
      update.run(id, now, asset.id)
    }
  })()
  return updates.length
}
