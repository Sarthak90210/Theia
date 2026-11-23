// Compares the ordinary look and the closer look (src/search/deep.ts) on the
// photos of a vault with the most faces: faces found, lines of text read, and
// time taken. Read only: the database is opened read-only, and the full-size
// copies go to a temporary folder.
//
//   npx tsx scripts/compare-deep.ts "F:/My vault" .release-tools/models [count]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { FaceReader } from '../src/search/faces.ts'
import { OcrReader } from '../src/search/ocr.ts'
import { HeicPool } from '../src/thumbs/heic-pool.ts'
import { thumbPath } from '../src/thumbs/render.ts'
import { writeDeepImage } from '../src/search/deep.ts'

const root = process.argv[2]!
const models = process.argv[3]!
const db = new Database(path.join(root, '.vault', 'library.db'), { readonly: true, fileMustExist: true })
const media = root
const cache = path.join(root, '.vault', 'cache')
const rows = db.prepare(`
  SELECT a.id, f.path, f.mime, f.sha256, COUNT(fc.id) AS faces FROM asset a
    JOIN file f ON f.asset_id = a.id AND f.is_primary = 1
    JOIN face fc ON fc.asset_id = a.id
   WHERE a.hidden = 0 AND a.deleted_at IS NULL AND f.encrypted_path IS NULL AND a.kind <> 'video'
   GROUP BY a.id ORDER BY faces DESC LIMIT ?`).all(Number(process.argv[4] ?? 8)) as { id: number; path: string; mime: string; sha256: string; faces: number }[]

const faces = new FaceReader(path.join(models, 'faces'), { threads: 4 })
const ocr = new OcrReader(path.join(models, 'ppocr'), { threads: 4, device: 'cpu' })
const heic = new HeicPool(2)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'theia-deep-real-'))
let tn = 0, td = 0, fn = 0, fd = 0, on = 0, od = 0
try {
  for (const r of rows) {
    const lg = thumbPath(cache, r.sha256, 'lg')
    const out = path.join(tmp, `${r.id}.jpg`)
    const original = path.join(media, ...r.path.split('/'))
    await writeDeepImage(original, r.mime, lg, { heic }, out)
    let t = Date.now()
    const normal = await faces.read(lg)
    const tNormal = Date.now() - t
    t = Date.now()
    const deep = await faces.read(out, { deep: true })
    const tDeep = Date.now() - t
    const textN = await ocr.read(lg)
    const textD = await ocr.read(out, { deep: true })
    tn += tNormal; td += tDeep; fn += normal.faces.length; fd += deep.faces.length
    on += textN.lines.length; od += textD.lines.length
    console.log(`#${r.id} ${r.mime} ${deep.width}x${deep.height}: faces ${normal.faces.length} -> ${deep.faces.length} (${tNormal} ms -> ${tDeep} ms), text lines ${textN.lines.length} -> ${textD.lines.length}, smallest deep face ${Math.min(...deep.faces.map((f) => Math.min(f.box[2], f.box[3])).concat([Infinity])).toFixed(0)} px`)
  }
  console.log(`total: faces ${fn} -> ${fd}, text lines ${on} -> ${od}, face time ${tn} ms -> ${td} ms`)
} finally {
  await faces.close()
  await ocr.close()
  await heic.close()
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}
