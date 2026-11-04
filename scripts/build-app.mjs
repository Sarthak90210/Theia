// Bundle the Electron app into dist-app/.
//
//   main.cjs       main process: device, engine, database, jobs
//   preload.cjs    the window's only bridge to the main process
//   renderer/      the window: index.html, styles.css, app.js
//   heic-worker.mjs  copied as is; worker threads load it by path
//
// Native and heavy modules stay external and load from node_modules at run
// time. better-sqlite3 13 and sharp are N-API, so the same binaries serve
// Node (tests) and Electron (the app) without a rebuild.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'dist-app')
const watch = process.argv.includes('--watch')

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, 'renderer'), { recursive: true })

const external = ['electron', 'better-sqlite3', 'sharp', 'exiftool-vendored', 'libheif-js']

// The source is ESM and uses import.meta.url to find the HEIC worker. In a
// CommonJS bundle that does not exist, so point it at the bundle file itself,
// next to which the worker is copied.
const importMetaShim = {
  banner: { js: "const __import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__import_meta_url' },
}

await Promise.all([
  build({
    entryPoints: [path.join(root, 'app/main/main.ts')],
    outfile: path.join(out, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external,
    sourcemap: 'linked',
    logLevel: 'warning',
    ...importMetaShim,
  }),
  build({
    entryPoints: [path.join(root, 'app/preload/preload.ts')],
    outfile: path.join(out, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    logLevel: 'warning',
  }),
  build({
    entryPoints: [path.join(root, 'app/renderer/main.tsx')],
    outfile: path.join(out, 'renderer/app.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    jsx: 'automatic',
    minify: !watch,
    sourcemap: 'linked',
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
    logLevel: 'warning',
  }),
])

fs.copyFileSync(path.join(root, 'app/renderer/index.html'), path.join(out, 'renderer/index.html'))
// Every stylesheet the window links, and the logo: in the window (sidebar)
// and beside main.cjs (the window icon).
for (const f of fs.readdirSync(path.join(root, 'app/renderer'))) {
  if (f.endsWith('.css')) fs.copyFileSync(path.join(root, 'app/renderer', f), path.join(out, 'renderer', f))
}
fs.copyFileSync(path.join(root, 'app/assets/theia-logo.png'), path.join(out, 'renderer/theia-logo.png'))
fs.copyFileSync(path.join(root, 'app/assets/theia-logo.png'), path.join(out, 'theia-logo.png'))
fs.copyFileSync(path.join(root, 'src/thumbs/heic-worker.mjs'), path.join(out, 'heic-worker.mjs'))

console.log(`built ${path.relative(root, out)}`)
