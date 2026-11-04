import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import { createVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'

// Everything in this fixture is generated here. No phone or user photos are
// copied, and the app's normal profile and vault registry are never changed.
const root = path.resolve('transcripts', `ui-polish-qa-${Date.now()}`)
fs.mkdirSync(root, { recursive: true })
const gallery = createVault(path.join(root, 'Gallery'))
const archive = createVault(path.join(root, 'Archive'))
archive.db.close()

const palette = [
  ['#9cb7bc', '#dae4dc', '#54767c', '#d5b888'],
  ['#b9b9ad', '#e6dfce', '#85886f', '#e7c2a2'],
  ['#9eaab9', '#d4dce6', '#687e91', '#a0b9af'],
  ['#b7a59b', '#e8dacf', '#8e7974', '#e6b784'],
  ['#a2b4a4', '#dae1ce', '#5b7c6d', '#d6cfac'],
  ['#a3a2ad', '#ded9df', '#77778b', '#dbbbae'],
]
const fixtures: { key: string; kind: SaveItem['kind']; state: 'visible' | 'hidden' | 'deleted' }[] = []

function landscape(index: number, width: number, height: number): Buffer {
  const p = palette[index % palette.length]!
  const sun = width * (0.22 + (index % 4) * 0.16)
  const ridge = height * (0.42 + (index % 3) * 0.05)
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${p[0]}"/><stop offset="1" stop-color="${p[1]}"/></linearGradient></defs>
    <rect width="${width}" height="${height}" fill="url(#sky)"/>
    <circle cx="${sun}" cy="${height * 0.27}" r="${height * (0.07 + index % 3 * 0.012)}" fill="${p[3]}"/>
    <path d="M0 ${height * 0.69} ${width * 0.29} ${ridge} ${width * 0.51} ${height * 0.65} ${width * 0.74} ${ridge - height * 0.08} ${width} ${height * 0.6}V${height}H0Z" fill="${p[2]}" opacity=".62"/>
    <path d="M0 ${height * 0.82}Q${width * 0.32} ${height * 0.59} ${width * 0.57} ${height * 0.81}T${width} ${height * 0.74}V${height}H0Z" fill="${p[2]}"/>
    <path d="M0 ${height * 0.93}Q${width * 0.5} ${height * 0.74} ${width} ${height * 0.91}V${height}H0Z" fill="${p[3]}" opacity=".68"/>
    <text x="${width * 0.055}" y="${height * 0.935}" font-family="sans-serif" font-size="${height * 0.026}" letter-spacing="3" fill="white" opacity=".74">STUDY ${String(index + 1).padStart(2, '0')}</text>
  </svg>`)
}

try {
  // 18 normal photos, one video, two hidden photos, one deleted photo.
  for (let index = 0; index < 22; index++) {
    const video = index === 18
    const state = index === 21 ? 'deleted' : index >= 19 ? 'hidden' : 'visible'
    const [width, height] = video ? [960, 540] : [[1200, 800], [800, 1200], [1000, 1000], [1440, 900]][index % 4]!
    const name = video ? 'motion-study.mp4' : `landscape-${String(index + 1).padStart(2, '0')}.jpg`
    const file = path.join(root, name)
    if (video) {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=25:duration=4',
        '-f', 'lavfi', '-i', 'sine=duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file], { windowsHide: true })
    } else {
      await sharp(landscape(index, width!, height!)).jpeg({ quality: 92 }).toFile(file)
    }
    const bytes = fs.readFileSync(file)
    const item: SaveItem = {
      key: `fixture-${index}`, kind: video ? 'video' : 'photo',
      t: Date.UTC(2026, 7 + Math.floor(index / 7), 1 + index % 7, 8 + index % 6), off: 19800,
      w: width!, h: height!, dur: video ? 4000 : null, fav: index % 5 === 0, edited: false,
      subtype: null, sourceUuid: `theia-ui-fixture-${index}`, lat: index === 0 ? 12.9 : null, lon: index === 0 ? 77.6 : null,
      place: index === 0 ? { label: 'Bengaluru test location', city: 'Bengaluru', region: 'Karnataka', country: 'India' } : null, cloud: false,
      files: [{ name, role: 'master', mime: video ? 'video/mp4' : 'image/jpeg', size: bytes.length, sha256: null,
        read: async function* () { yield bytes } }],
    }
    const album = index < 9 ? 'Coast and mountains' : 'Quiet studies'
    const saved = await saveToVault(gallery, [item], [{ uuid: `fixture-album-${index < 9 ? 0 : 1}`, name: album, keys: [item.key] }])
    const id = saved.newAssets[0]
    if (!id) throw new Error(`Fixture ${index} was not saved`)
    if (state === 'hidden') gallery.db.prepare('UPDATE asset SET hidden = 1 WHERE id = ?').run(id)
    if (state === 'deleted') gallery.db.prepare('UPDATE asset SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
    fixtures.push({ key: String(id), kind: video ? 'video' : 'photo', state })
  }
  // One Live Photo: a still and its motion clip, as a saved iPhone Live Photo is stored.
  {
    const still = path.join(root, 'live-still.jpg')
    const motion = path.join(root, 'live-motion.mp4')
    await sharp(landscape(3, 1200, 900)).jpeg({ quality: 92 }).toFile(still)
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=800x600:rate=30:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', motion], { windowsHide: true })
    const file = (name: string, role: 'master' | 'motion', mime: string, bytes: Buffer) =>
      ({ name, role, mime, size: bytes.length, sha256: null, read: async function* () { yield bytes } })
    const s1 = fs.readFileSync(still), m1 = fs.readFileSync(motion)
    const item: SaveItem = {
      key: 'fixture-live', kind: 'live', t: Date.UTC(2026, 9, 20, 9), off: 19800, w: 1200, h: 900, dur: null, fav: false,
      edited: false, subtype: null, sourceUuid: 'theia-ui-fixture-live', lat: null, lon: null, cloud: false,
      files: [file('IMG_LIVE.JPG', 'master', 'image/jpeg', s1), file('IMG_LIVE.MOV', 'motion', 'video/mp4', m1)],
    }
    const saved = await saveToVault(gallery, [item], [])
    if (!saved.newAssets[0]) throw new Error('Live Photo fixture was not saved')
    fixtures.push({ key: String(saved.newAssets[0]), kind: 'live', state: 'visible' })
  }
  // A three-frame burst with visibly different frames exercises cover and keep actions.
  {
    const files: SaveItem['files'] = []
    for (let i = 0; i < 3; i++) {
      const bytes = await sharp(landscape(i, 1000, 700)).jpeg({ quality: 92 }).toBuffer()
      files.push({ name: `IMG_BURST_${i + 1}.JPG`, role: 'master', mime: 'image/jpeg', size: bytes.length, sha256: null,
        read: async function* () { yield bytes } })
    }
    const item: SaveItem = { key: 'fixture-burst', kind: 'burst', t: Date.UTC(2026, 9, 21, 9), off: 19800,
      w: 1000, h: 700, dur: null, fav: false, edited: false, subtype: null, sourceUuid: 'theia-ui-fixture-burst',
      lat: null, lon: null, cloud: false, files }
    const saved = await saveToVault(gallery, [item], [{ uuid: 'fixture-bursts', name: 'Burst studies', keys: [item.key] }])
    if (!saved.newAssets[0]) throw new Error('Burst fixture was not saved')
    fixtures.push({ key: String(saved.newAssets[0]), kind: 'burst', state: 'visible' })
  }
} finally {
  gallery.db.close()
}

const profile = path.join(root, 'profile')
fs.mkdirSync(profile, { recursive: true })
// Generated tile cache keeps map UI checks offline and repeatable.
const x = Math.floor((77.6 + 180) / 360 * 2 ** 15)
const latRadians = 12.9 * Math.PI / 180
const y = Math.floor((1 - Math.log(Math.tan(latRadians) + 1 / Math.cos(latRadians)) / Math.PI) / 2 * 2 ** 15)
const tile = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#303735' } }).png().toBuffer()
for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
  const dir = path.join(profile, 'map-tiles', '15', String(x + dx))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${y + dy}.png`), tile)
}
fs.writeFileSync(path.join(profile, 'gallery.json'), JSON.stringify({ vaults: [gallery.layout.root, archive.layout.root] }, null, 2))
fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({
  root, profile, vaultName: 'Gallery', vaultId: `vault:${gallery.manifest.id}`,
  visibleCount: fixtures.filter(f => f.state === 'visible').length,
  photoKey: fixtures.find(f => f.kind === 'photo' && f.state === 'visible')!.key,
  videoKey: fixtures.find(f => f.kind === 'video')!.key,
  liveKey: fixtures.find(f => (f.kind as string) === 'live')!.key,
  burstKey: fixtures.find(f => f.kind === 'burst')!.key,
  hiddenKey: fixtures.find(f => f.state === 'hidden')!.key,
  deletedKey: fixtures.find(f => f.state === 'deleted')!.key,
  fixtures,
}, null, 2))
fs.writeFileSync(path.resolve('transcripts', 'latest-ui-polish-qa.txt'), root)
console.log(root)
