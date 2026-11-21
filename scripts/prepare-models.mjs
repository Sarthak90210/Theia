// The search models ship inside Theia, so they are build inputs like FFmpeg:
// pinned to one revision, every file checked against its SHA-256, kept out of
// git. Downloaded once into .release-cache, then copied to
// .release-tools/models/<name>, which the app reads in development and
// electron-builder packs into resources/models for the installer.
//
//   embeddinggemma-2   search by meaning (src/search/model.ts)
//   ppocr              reading text in photos (src/search/ocr-model.ts)
//   faces              finding and grouping faces (src/search/face-model.ts)
//
//   node scripts/prepare-models.mjs      (also run by npm run release:prepare)

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The manifests live in the app's source, so the app and this script agree. */
async function bundles() {
  const gemma = await import(pathToFileURL(path.join(root, 'src/search/model.ts')).href)
  const ocr = await import(pathToFileURL(path.join(root, 'src/search/ocr-model.ts')).href)
  const faces = await import(pathToFileURL(path.join(root, 'src/search/face-model.ts')).href)
  const hf = (repo, revision, rel) => `https://huggingface.co/${repo}/resolve/${revision}/${rel}`
  return [
    {
      name: gemma.MODEL_NAME,
      cacheKey: `${gemma.MODEL_NAME}-${gemma.MODEL_REVISION.slice(0, 7)}`,
      files: Object.fromEntries(Object.entries(gemma.MODEL_FILES).map(([rel, sha256]) =>
        [rel, { sha256, url: hf(gemma.MODEL_REPO, gemma.MODEL_REVISION, rel), repo: gemma.MODEL_REPO, revision: gemma.MODEL_REVISION, path: rel }])),
    },
    {
      name: ocr.OCR_NAME,
      cacheKey: ocr.OCR_NAME,
      files: Object.fromEntries(Object.entries(ocr.OCR_FILES).map(([rel, f]) =>
        [rel, { ...f, url: hf(f.repo, f.revision, f.path) }])),
    },
    {
      name: faces.FACE_NAME,
      cacheKey: faces.FACE_NAME,
      license: 'MIT (YuNet), Apache-2.0 (SFace)',
      files: Object.fromEntries(Object.entries(faces.FACE_FILES).map(([rel, f]) =>
        [rel, { ...f, url: hf(f.repo, f.revision, f.path) }])),
    },
  ]
}

async function sha256(file) {
  const hash = createHash('sha256')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

async function prepare({ name, cacheKey, files, license = 'Apache-2.0' }) {
  const cache = path.join(root, '.release-cache', cacheKey)
  const target = path.join(root, '.release-tools', 'models', name)

  for (const [rel, f] of Object.entries(files)) {
    const cached = path.join(cache, ...rel.split('/'))
    if (!fs.existsSync(cached) || (await sha256(cached)) !== f.sha256) {
      console.log(`Downloading ${name}/${rel}`)
      fs.mkdirSync(path.dirname(cached), { recursive: true })
      const response = await fetch(f.url)
      if (!response.ok) throw new Error(`Model download failed for ${name}/${rel}: HTTP ${response.status}`)
      const tmp = `${cached}.partial`
      await pipeline(response.body, fs.createWriteStream(tmp))
      const got = await sha256(tmp)
      if (got !== f.sha256) {
        fs.rmSync(tmp, { force: true })
        throw new Error(`Model file hash mismatch for ${name}/${rel}: ${got}`)
      }
      fs.renameSync(tmp, cached)
    }
    const out = path.join(target, ...rel.split('/'))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const same = fs.existsSync(out) && fs.statSync(out).size === fs.statSync(cached).size && (await sha256(out)) === f.sha256
    if (!same) fs.copyFileSync(cached, out)
  }
  // Nothing else in the folder: it is shipped as is.
  const wanted = new Set(Object.keys(files).map((f) => path.join(target, ...f.split('/'))))
  const sweep = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) sweep(p)
      else if (!wanted.has(p)) fs.rmSync(p)
    }
  }
  sweep(target)
  const provenance = Object.fromEntries(Object.entries(files).map(([rel, f]) =>
    [rel, { sha256: f.sha256, source: `https://huggingface.co/${f.repo}/blob/${f.revision}/${f.path}` }]))
  fs.writeFileSync(path.join(target, 'provenance.json'), JSON.stringify({ license, files: provenance }, null, 2))
  console.log(`Prepared and verified ${name}`)
  return target
}

export async function prepareModels() {
  const out = []
  for (const b of await bundles()) out.push(await prepare(b))
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareModels()
