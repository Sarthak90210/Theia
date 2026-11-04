import fs from 'node:fs'
import path from 'node:path'
import type { DeviceFile, DeviceSource } from '../device/types.ts'
import type { Db } from '../library/db.ts'
import type { SaveAlbum, SaveFile, SaveItem } from '../vault/save.ts'
import { vaultFiles } from './vault-gallery.ts'
import type { PhoneSession } from './phone-session.ts'
import { mimeOf } from './phone-session.ts'

/**
 * Turn what the gallery shows into what the saver copies. One adapter per
 * kind of source.
 */

/* ----------------------------------------------------------------- vault */

/**
 * `openProtected` reads a protected (encrypted) file, or throws when the vault
 * is locked. Without it, a protected item can't be saved elsewhere.
 */
export function vaultSaveItems(
  db: Db,
  mediaRoot: string,
  keys: string[],
  openProtected?: (encryptedPath: string) => AsyncIterable<Buffer>,
): SaveItem[] {
  const get = db.prepare(
    `SELECT a.id, kind, captured_utc, captured_offset, width, height, duration_ms, favourite, has_adjustments,
            subtype, source_uuid, a.lat, a.lon, created_at,
            p.label AS place_label, p.city AS place_city, p.region AS place_region, p.country AS place_country
       FROM asset a LEFT JOIN place p ON p.id = a.place_id WHERE a.id = ?`,
  )
  const out: SaveItem[] = []
  for (const key of keys) {
    const a = get.get(Number(key)) as
      | {
          id: number
          kind: string
          captured_utc: number | null
          captured_offset: number | null
          width: number | null
          height: number | null
          duration_ms: number | null
          favourite: number
          has_adjustments: number
          subtype: string | null
          source_uuid: string | null
          lat: number | null
          lon: number | null
          created_at: number
          place_label: string | null
          place_city: string | null
          place_region: string | null
          place_country: string | null
        }
      | undefined
    if (!a) continue
    const files: SaveFile[] = vaultFiles(db, key).map((f) => {
      const abs = path.join(mediaRoot, ...f.path.split('/'))
      return {
        name: path.posix.basename(f.path),
        role: f.primary || f.role === 'master' ? 'master' : roleFor(f.role, f.mime),
        mime: f.mime,
        size: f.bytes,
        sha256: f.sha256,
        read: () => {
          if (!f.encryptedPath) return fs.createReadStream(abs, { highWaterMark: 4 * 1024 * 1024 })
          if (!openProtected) throw new Error('This item is encrypted. Unlock Hidden and Recently Deleted to save it.')
          return openProtected(f.encryptedPath)
        },
      }
    })
    out.push({
      key,
      kind: a.kind === 'still' ? 'photo' : (a.kind as SaveItem['kind']),
      t: a.captured_utc ?? a.created_at,
      off: a.captured_offset,
      w: a.width,
      h: a.height,
      dur: a.duration_ms,
      fav: a.favourite === 1,
      edited: a.has_adjustments === 1,
      subtype: a.subtype,
      sourceUuid: a.source_uuid,
      lat: a.lat,
      lon: a.lon,
      place: a.place_label
        ? { label: a.place_label, city: a.place_city, region: a.place_region, country: a.place_country }
        : null,
      cloud: false,
      files,
    })
  }
  return out
}

export function vaultSaveAlbums(db: Db): SaveAlbum[] {
  const albums = db.prepare(`SELECT id, name, source_uuid FROM album ORDER BY position, id`).all() as {
    id: number
    name: string
    source_uuid: string | null
  }[]
  return albums.map((a) => ({
    // A vault album without a phone identifier gets one derived from the vault
    // album, so saving it twice still lands in the same album.
    uuid: a.source_uuid ?? `vault-album-${a.id}-${a.name}`,
    name: a.name,
    keys: (
      db.prepare(`SELECT asset_id FROM album_asset WHERE album_id = ? ORDER BY position`).all(a.id) as { asset_id: number }[]
    ).map((r) => String(r.asset_id)),
  }))
}

function roleFor(role: string, mime: string): SaveFile['role'] {
  if (role === 'motion') return 'motion'
  if (role === 'sidecar' || mime === 'application/xml') return 'sidecar'
  if (role === 'render') return 'render'
  return mime.startsWith('video/') ? 'motion' : 'render'
}

/* ----------------------------------------------------------------- phone */

/**
 * Items from a phone. `device` is the saver's own AFC connection, separate
 * from the one the gallery browses with, so scrolling stays responsive while a
 * save runs.
 */
export async function phoneSaveItems(session: PhoneSession, device: DeviceSource, keys: string[], framesOnly = false): Promise<SaveItem[]> {
  const out: SaveItem[] = []
  for (const key of keys) {
    const a = session.asset(key)
    if (!a) continue
    const files: SaveFile[] = []
    // Keep the cover first for saving, but include every original in the burst.
    const frameKeys = !framesOnly && a.kind === 'burst' && a.burstId ? session.library.bursts.get(a.burstId) ?? [key] : [key]
    const frameAssets = [a, ...frameKeys.filter(k => k !== key).map(k => session.asset(k)).filter(x => x !== undefined)]
    const originals = new Set(frameAssets.map(f => f.path))
    const paths = [...new Set(frameAssets.flatMap(f => session.filesFor(f.key)))]
    if (!a.cloud && !framesOnly && a.kind === 'burst' && frameAssets.some(f => f.cloud || !paths.includes(f.path))) {
      throw new Error('Some burst frames are unavailable over USB. Save the available frames individually instead.')
    }
    for (const p of paths) {
      const name = path.posix.basename(p)
      const st = await device.stat(p)
      files.push({
        name,
        role: originals.has(p) ? 'master' : phoneRole(name, a.filename, a.kind),
        mime: mimeOf(name),
        size: st.size,
        sha256: null,
        sourcePath: p,
        sourceMtimeMs: st.mtimeMs,
        read: () => readDevice(device, p, st),
      })
    }
    out.push({
      key,
      kind: framesOnly && a.kind === 'burst' ? 'photo' : a.kind,
      t: a.t,
      off: a.off,
      w: a.w,
      h: a.h,
      dur: a.dur,
      fav: a.fav,
      edited: a.edited,
      subtype: a.subtype,
      sourceUuid: framesOnly && a.kind === 'burst' ? `${a.key}:frame` : a.key,
      lat: a.lat,
      lon: a.lon,
      place: session.extras(key)?.place ?? null,
      cloud: a.cloud,
      files,
    })
  }
  return out
}

export function phoneSaveAlbums(session: PhoneSession): SaveAlbum[] {
  return session.library.albums.map((a) => ({ uuid: a.uuid, name: a.name, keys: a.keys }))
}

function phoneRole(name: string, original: string, kind: SaveItem['kind']): SaveFile['role'] {
  if (name === original) return 'master'
  if (/\.aae$/i.test(name)) return 'sidecar'
  if (/^[A-Za-z]+_E\d+/.test(name)) return 'render'
  if (/\.(mov|mp4)$/i.test(name) && kind !== 'video') return 'motion'
  return 'render'
}

async function* readDevice(device: DeviceSource, devicePath: string, expected: DeviceFile): AsyncIterable<Buffer> {
  const unchanged = async () => {
    const current = await device.stat(devicePath)
    if (current.isDirectory || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs) {
      throw new Error(`The iPhone original changed during this save: ${devicePath}`)
    }
  }
  await unchanged()
  const h = await device.open(devicePath)
  try {
    for (;;) {
      const b = await h.read(4 * 1024 * 1024)
      if (!b.length) break
      yield b
    }
  } finally {
    await h.close()
  }
  await unchanged()
}
