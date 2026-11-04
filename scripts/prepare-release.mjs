// Build inputs are pinned and verified. The binaries stay out of git.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build Windows x64 releases on Windows x64.')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = '9.0.2'
const archiveName = `ffmpeg-${version}-essentials_build.zip`
const archiveHash = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
const download = `https://github.com/GyanD/codexffmpeg/releases/download/${version}/${archiveName}`
const cache = path.join(root, '.release-cache')
fs.mkdirSync(cache, { recursive: true })
const archive = path.join(cache, archiveName)
if (!fs.existsSync(archive)) {
  console.log(`Downloading FFmpeg ${version} and FFprobe`)
  const response = await fetch(download)
  if (!response.ok) throw new Error(`FFmpeg download failed: HTTP ${response.status}`)
  const tmp = `${archive}.partial`
  const { pipeline } = await import('node:stream/promises')
  await pipeline(response.body, fs.createWriteStream(tmp))
  fs.renameSync(tmp, archive)
}
const hash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
if (hash !== archiveHash) throw new Error(`FFmpeg archive hash mismatch: ${hash}`)
const extracted = path.join(cache, `ffmpeg-${version}-essentials_build`)
if (!fs.existsSync(path.join(extracted, 'bin', 'ffprobe.exe'))) {
  const literal = value => "'" + value.replaceAll("'", "''") + "'"
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath ${literal(archive)} -DestinationPath ${literal(cache)} -Force`], { windowsHide: true, stdio: 'inherit' })
}
const tools = path.join(root, '.release-tools', 'ffmpeg')
fs.mkdirSync(tools, { recursive: true })
for (const name of ['ffmpeg.exe', 'ffprobe.exe']) fs.copyFileSync(path.join(extracted, 'bin', name), path.join(tools, name))
for (const name of ['LICENSE', 'README.txt']) fs.copyFileSync(path.join(extracted, name), path.join(tools, name))
fs.writeFileSync(path.join(tools, 'provenance.json'), JSON.stringify({ version, download, sha256: archiveHash,
  source: 'https://github.com/FFmpeg/FFmpeg/commit/946fcce07b' }, null, 2))

// Windows ICO containing PNG frames at each shell icon size.
const sizes = [16, 24, 32, 48, 64, 128, 256]
const frames = await Promise.all(sizes.map(size => sharp(path.join(root, 'app/assets/theia-logo.png')).resize(size, size).png().toBuffer()))
const header = Buffer.alloc(6 + 16 * frames.length)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(frames.length, 4)
let offset = header.length
frames.forEach((frame, i) => {
  const at = 6 + i * 16
  header[at] = sizes[i] === 256 ? 0 : sizes[i]
  header[at + 1] = header[at]
  header.writeUInt16LE(1, at + 4)
  header.writeUInt16LE(32, at + 6)
  header.writeUInt32LE(frame.length, at + 8)
  header.writeUInt32LE(offset, at + 12)
  offset += frame.length
})
fs.mkdirSync(path.join(root, 'build'), { recursive: true })
fs.writeFileSync(path.join(root, 'build', 'theia.ico'), Buffer.concat([header, ...frames]))
console.log(`Prepared Windows icon and verified FFmpeg ${version} tools`)
