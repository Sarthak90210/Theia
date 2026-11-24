import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import { createVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveAlbum, type SaveItem } from '../src/vault/save.ts'

/**
 * A vault with a bit of everything, for trying the app out and for the visual
 * audit: photos over several years in three shapes, videos, an album, a long
 * album name, favourites, a long file name, and a vault name that is long.
 *   npx tsx scripts/make-demo-vault.ts <empty folder> [photos=240]
 */
const root = path.resolve(process.argv[2]!)
const count = Number(process.argv[3] ?? 240)
if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`${root} is not empty`)
const v = createVault(root)

const palette = ['#2f6f8f', '#c0703a', '#5a8f4e', '#8f3f6f', '#3f4f8f', '#b59a3a', '#4f8f8a', '#8f5a3f']
async function photo(i: number, w: number, h: number): Promise<Buffer> {
  const a = palette[i % palette.length]!
  const b = palette[(i * 3 + 1) % palette.length]!
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${w * (0.2 + (i % 5) * 0.15)}" cy="${h * 0.4}" r="${Math.min(w, h) * 0.18}" fill="#ffffff" fill-opacity="0.25"/>
    <text x="50%" y="88%" font-family="Segoe UI, Arial" font-size="${Math.round(Math.min(w, h) / 9)}" fill="#fff" text-anchor="middle">#${i + 1}</text>
  </svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer()
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-video-'))
function video(i: number): Buffer {
  const out = path.join(tmp, `v${i}.mp4`)
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=24:duration=${3 + i}`, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-y', out])
  return fs.readFileSync(out)
}

const items: SaveItem[] = []
const start = Date.UTC(2021, 2, 3, 9, 0, 0)
for (let i = 0; i < count; i++) {
  const shape = i % 7 === 0 ? [900, 1600] : i % 11 === 0 ? [2400, 800] : [1600, 1200]
  const isVideo = i % 37 === 5
  const bytes = isVideo ? video(i % 3) : await photo(i, shape[0]!, shape[1]!)
  // Spread over four years, a few a day, with gaps, like a real library.
  const t = start + Math.floor(i / 3) * 86_400_000 * 5 + (i % 3) * 3_600_000
  const name = i === 3 ? 'A photo with a really very long file name from a camera that names things verbosely 2023-07-14.JPG'
    : isVideo ? `IMG_${4000 + i}.MP4` : `IMG_${4000 + i}.JPG`
  items.push({
    key: `k${i}`, kind: isVideo ? 'video' : 'photo', t, off: 19800, w: isVideo ? 640 : shape[0]!, h: isVideo ? 360 : shape[1]!,
    dur: isVideo ? (3 + (i % 3)) * 1000 : null, fav: i % 13 === 0, edited: false,
    subtype: shape[0] === 2400 ? 'panorama' : null, sourceUuid: `demo-${i}`, lat: i % 4 === 0 ? 15.49 : null, lon: i % 4 === 0 ? 73.82 : null,
    cloud: false, timeSource: 'phone',
    files: [{ name, role: 'master', mime: isVideo ? 'video/mp4' : 'image/jpeg', size: bytes.length, sha256: null, read: async function* () { yield bytes } }],
  })
}
const albums: SaveAlbum[] = [
  { uuid: 'goa', name: 'Goa trip', keys: items.filter((_, i) => i % 4 === 0).map((x) => x.key) },
  { uuid: 'long', name: 'A very long album name that will not fit in the sidebar at all', keys: items.slice(0, 12).map((x) => x.key) },
]
const r = await saveToVault(v, items, albums)
v.db.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`saved ${r.saved}, failed ${r.failed.length}`, r.failed.slice(0, 3))
