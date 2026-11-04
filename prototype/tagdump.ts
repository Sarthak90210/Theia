import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exiftool } from 'exiftool-vendored'

const dir = path.join(os.tmpdir(), 'photos-win-probe')
const files = fs.readdirSync(dir).filter((f) => /\.(heic|mov|aae|jpg|png)$/i.test(f))

const WANT =
  /ContentIdentifier|BurstUUID|DateTimeOriginal|OffsetTime|CreateDate|CreationDate|MediaCreate|GPSLatitude|GPSLongitude|GPSAltitude|^Composite|ImageWidth|ImageHeight|Duration|Orientation|LensModel|Rotation/i

for (const f of files) {
  const p = path.join(dir, f)
  console.log(`\n=== ${f} ===`)
  const raw = (await exiftool.readRaw(p, ['-G1', '-n'])) as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(raw)) {
    if (WANT.test(k)) console.log(`  ${k} = ${JSON.stringify(v)}`)
  }
}
await exiftool.end()
