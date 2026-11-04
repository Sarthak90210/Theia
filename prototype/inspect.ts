import os from 'node:os'
import path from 'node:path'
import { openLibrary } from '../src/library/db.ts'
import { unpackTags } from '../src/metadata/reader.ts'

const db = openLibrary(path.join(os.tmpdir(), 'photos-win-smoke', 'library.db'))
const target = process.argv[2] ?? 'IMG_5532'

const row = db
  .prepare(`SELECT f.path, e.raw FROM file f JOIN exif e ON e.file_id = f.id WHERE f.path LIKE ?`)
  .get(`%${target}%`) as { path: string; raw: Uint8Array } | undefined

if (!row) {
  console.log(`no exif row matching ${target}`)
} else {
  console.log(row.path)
  const tags = unpackTags(row.raw)
  for (const [k, v] of Object.entries(tags)) {
    if (/Date|Time|Duration/i.test(k)) console.log(`  ${k} = ${JSON.stringify(v)}`)
  }
}
db.close()
