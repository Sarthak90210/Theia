import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import type { Db } from '../library/db.ts'
import type { Embed } from '../search/embedder.ts'
import { thumbPath } from '../thumbs/render.ts'
import { setKind, uncheckedGroups } from './people.ts'

/**
 * Statues, carvings, cartoons and painted figures have faces too, and the
 * face finder cannot tell. The search model can: each new group's clearest
 * faces, cut out with some room around them, are compared with a few
 * descriptions of real faces and of made ones. A group whose faces sit
 * clearly nearer the made ones is marked an object and hidden.
 *
 * Measured on a real library: statues, carvings and a cartoon scored +0.04
 * to +0.07 nearer "made"; real people -0.01 or less. Printed photographs of
 * people (posters, signboards) score like real people and are not caught:
 * "Not someone I know" handles those.
 */

const REAL = ['a photo of a real person', "a candid photo of a person's face", 'a selfie of a person', 'a photo of people smiling']
const MADE = [
  'a statue', 'a sculpture of a face', 'a cartoon drawing of a face', 'a painting of a person', 'a carved wooden figure',
  'a mascot or logo with a face', 'a face printed on a sign', 'a doll or mannequin',
]
/** Median margin above which a group is an object. Real people measured -0.009 at most; objects +0.044 at least. */
const MARGIN = 0.02

let prompts: Promise<{ real: Float32Array[]; made: Float32Array[] }> | null = null

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

/** Check every group not yet checked. Returns the ids found to be objects. */
export async function checkGroups(
  db: Db,
  cacheRoot: string,
  embed: Embed,
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<number[]> {
  const groups = uncheckedGroups(db)
  if (!groups.length) return []
  prompts ??= (async () => ({
    real: await Promise.all(REAL.map((t) => embed.query(t))),
    made: await Promise.all(MADE.map((t) => embed.query(t))),
  }))()
  const { real, made } = await prompts.catch((e) => { prompts = null; throw e })
  const face = db.prepare(
    `SELECT f.x, f.y, f.w, f.h, fl.sha256 FROM face f JOIN file fl ON fl.asset_id = f.asset_id AND fl.is_primary = 1 WHERE f.id = ?`,
  )
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theia-faces-'))
  const objects: number[] = []
  try {
    for (const [index, g] of groups.entries()) {
      opts.onProgress?.(index, groups.length)
      if (opts.signal?.aborted) break
      const margins: number[] = []
      for (const id of g.faces) {
        const f = face.get(id) as { x: number; y: number; w: number; h: number; sha256: string } | undefined
        if (!f) continue
        const file = thumbPath(cacheRoot, f.sha256, 'lg')
        if (!fs.existsSync(file)) continue
        const crop = path.join(dir, `${id}.png`)
        await cut(file, f, crop)
        const v = await embed.image(crop)
        fs.rmSync(crop, { force: true })
        margins.push(Math.max(...made.map((q) => dot(v, q))) - Math.max(...real.map((q) => dot(v, q))))
      }
      // Group gone or changed meanwhile: check it next time.
      if (!margins.length || !db.prepare(`SELECT 1 FROM person WHERE id = ? AND checked = 0 AND name IS NULL`).get(g.person)) continue
      const median = margins.sort((a, b) => a - b)[Math.floor(margins.length / 2)]!
      const kind = median >= MARGIN ? 'object' : 'person'
      setKind(db, g.person, kind)
      if (kind === 'object') objects.push(g.person)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return objects
}

/** The face with room around it (1.8 times its size), square, 384 px. */
async function cut(file: string, f: { x: number; y: number; w: number; h: number }, out: string): Promise<void> {
  const bytes = await fs.promises.readFile(file)
  const { width = 0, height = 0 } = await sharp(bytes).metadata()
  const side = Math.max(8, Math.min(width, height, Math.round(Math.max(f.w * width, f.h * height) * 1.8)))
  const left = Math.max(0, Math.min(width - side, Math.round((f.x + f.w / 2) * width - side / 2)))
  const top = Math.max(0, Math.min(height - side, Math.round((f.y + f.h / 2) * height - side / 2)))
  await sharp(bytes).extract({ left, top, width: side, height: side }).resize(384, 384).png().toFile(out)
}
