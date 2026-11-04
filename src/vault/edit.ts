import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { OpenVault } from './vault.ts'
import { displayFile, vaultFiles } from '../gallery/vault-gallery.ts'
import { editPhoto, editVideo, type EditDeps, type EditSource } from '../media/edit.ts'
import { validateEdit, type EditRecipe } from '../media/edit-recipe.ts'
import { probe } from '../media/playback.ts'

export function vaultEditSource(v: OpenVault, key: string): EditSource {
  const a = v.db.prepare('SELECT deleted_at FROM asset WHERE id = ?').get(Number(key)) as { deleted_at: number | null } | undefined
  if (!a || a.deleted_at !== null) throw new Error('Restore this item before editing it.')
  const file = displayFile(vaultFiles(v.db, key), null)
  if (!file || !/^(image|video)\//.test(file.mime)) throw new Error('This item cannot be edited.')
  return { file: path.join(v.layout.media, ...file.path.split('/')), mime: file.mime }
}

/** A new asset with a new file. The source and its album hard links are never rewritten. */
export async function saveEditedCopy(v: OpenVault, key: string, settings: EditRecipe, deps: EditDeps): Promise<string> {
  const r = validateEdit(settings)
  const source = vaultEditSource(v, key)
  const video = source.mime.startsWith('video/')
  const folder = 'Edited Copies'
  const dir = path.join(v.layout.media, folder)
  fs.mkdirSync(dir, { recursive: true })
  const name = `${path.basename(source.file, path.extname(source.file)).slice(0, 90)}-edit-${randomUUID()}.${video ? 'mp4' : 'jpg'}`
  const output = path.join(dir, name)
  const tmp = path.join(dir, `.partial-${name}`)
  let duration: number | null = null
  try {
    if (video) duration = await editVideo(source, tmp, r, deps)
    else fs.writeFileSync(tmp, await editPhoto(source, r, deps), { flag: 'wx' })
    const hash = createHash('sha256')
    for await (const bytes of fs.createReadStream(tmp)) hash.update(bytes)
    const sha = hash.digest('hex')
    const dimensions = video ? null : await sharp(tmp).metadata()
    // Video dimensions, including rotations/crops, come from the actual output.
    let width = dimensions?.width ?? null, height = dimensions?.height ?? null
    if (video) {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', tmp], { windowsHide: true })
      const stream = JSON.parse(stdout).streams[0]
      width = stream.width; height = stream.height
      duration = Math.round((await probe(tmp)).durationSec! * 1000)
    }
    // The item may have been moved to Recently Deleted while the video encoded.
    vaultEditSource(v, key)
    fs.renameSync(tmp, output)
    const now = Date.now()
    return v.db.transaction(() => {
      const id = Number(v.db.prepare(`INSERT INTO asset (kind, captured_utc, captured_offset, time_source, lat, lon, altitude, place_id,
        width, height, duration_ms, favourite, hidden, has_adjustments, created_at, updated_at)
        SELECT ?, captured_utc, captured_offset, time_source, lat, lon, altitude, place_id, ?, ?, ?, favourite, hidden, 1, ?, ? FROM asset WHERE id = ?`)
        .run(video ? 'video' : 'still', width, height, duration, now, now, Number(key)).lastInsertRowid)
      v.db.prepare(`INSERT INTO file (asset_id, role, is_primary, path, bytes, sha256, mime, verify_level, verified_at, created_at)
        VALUES (?, 'master', 1, ?, ?, ?, ?, 3, ?, ?)`)
        .run(id, `${folder}/${name}`, fs.statSync(output).size, sha, video ? 'video/mp4' : 'image/jpeg', now, now)
      v.db.prepare('INSERT INTO edit_copy (asset_id, parent_id, recipe, created_at) VALUES (?, ?, ?, ?)').run(id, Number(key), JSON.stringify(r), now)
      v.db.prepare('INSERT INTO album_asset (album_id, asset_id, position) SELECT album_id, ?, position + 1 FROM album_asset WHERE asset_id = ?').run(id, Number(key))
      return String(id)
    })()
  } catch (e) {
    for (const f of [tmp, output]) fs.rmSync(f, { force: true })
    throw e
  }
}
