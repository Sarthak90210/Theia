import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = '1.10.2'
const sha256 = '1ef523637d6c837dfcd768a00281c99c57bfd443cfce0cff11b872e7b966338f'
const url = `https://api.nuget.org/v3-flatcontainer/mediadevices/${version}/mediadevices.${version}.nupkg`

export async function prepareWpd(output = path.join(root, 'dist-app', 'wpd')) {
  if (process.platform !== 'win32') return
  const cache = path.join(root, '.release-cache')
  fs.mkdirSync(cache, { recursive: true })
  const archive = path.join(cache, `mediadevices-${version}.nupkg`)
  if (!fs.existsSync(archive)) {
    const existing = path.join(cache, 'mediadevices.zip')
    if (fs.existsSync(existing)) fs.copyFileSync(existing, archive)
    else {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`MediaDevices download failed: HTTP ${response.status}`)
      const partial = `${archive}.partial`
      await pipeline(response.body, fs.createWriteStream(partial))
      fs.renameSync(partial, archive)
    }
  }
  if (createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== sha256) throw new Error('MediaDevices package hash mismatch.')
  fs.mkdirSync(output, { recursive: true })
  const dll = path.join(output, 'MediaDevices.dll')
  const literal = value => "'" + value.replaceAll("'", "''") + "'"
  const extract = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [IO.Compression.ZipFile]::OpenRead(${literal(archive)}); try { $entry = $zip.GetEntry('lib/net45/MediaDevices.dll'); if (-not $entry) { throw 'MediaDevices DLL missing' }; [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, ${literal(dll)}, $true) } finally { $zip.Dispose() }`
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', extract], { windowsHide: true })
  fs.copyFileSync(path.join(root, 'src/device/wpd-helper.ps1'), path.join(output, 'wpd-helper.ps1'))
  fs.writeFileSync(path.join(output, 'provenance.json'), JSON.stringify({ name: 'MediaDevices', version, url, sha256,
    source: 'https://github.com/Bassman2/MediaDevices', license: 'MIT' }, null, 2))
  const licenseFile = path.join(cache, 'MediaDevices-LICENSE')
  if (!fs.existsSync(licenseFile)) {
    const response = await fetch('https://raw.githubusercontent.com/Bassman2/MediaDevices/master/LICENSE')
    if (!response.ok) throw new Error(`MediaDevices license download failed: HTTP ${response.status}`)
    fs.writeFileSync(licenseFile, await response.text())
  }
  fs.copyFileSync(licenseFile, path.join(output, 'LICENSE-MediaDevices.txt'))
  console.log(`Prepared verified MediaDevices ${version} Windows helper`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareWpd(process.argv[2] ? path.resolve(process.argv[2]) : undefined)
}
