// HEIC decode in a worker thread. Plain JavaScript so it loads under Node,
// tsx, vitest and Electron alike without a TypeScript loader.
//
// Why a worker at all: the prebuilt sharp has libheif but not its HEVC decoder
// (libde265), so it reads HEIC metadata and fails on the pixels. libheif-js is
// WebAssembly with the decoder built in. It is synchronous and CPU bound,
// about half a second for a 12 MP iPhone photo, so it needs threads to scale.
//
// Request:  { id, path }
// Reply:    { id, width, height, data: ArrayBuffer (RGBA, transferred) }
//      or:  { id, error }

import fs from 'node:fs'
import { parentPort } from 'node:worker_threads'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const libheif = require('libheif-js/wasm-bundle')

// One decoder per worker. Each decode frees the previous context, so memory
// stays flat across thousands of files instead of growing with each one.
const decoder = new libheif.HeifDecoder()

function display(image, width, height) {
  return new Promise((resolve, reject) => {
    image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (out) =>
      out ? resolve(out) : reject(new Error('libheif could not decode the image')),
    )
  })
}

parentPort.on('message', async ({ id, path, data: inputData }) => {
  let images = []
  try {
    images = decoder.decode(inputData ? new Uint8Array(inputData) : fs.readFileSync(path))
    if (!images.length) throw new Error('no image in HEIF container')
    // The primary image is what the phone shows. Bursts and depth maps add others.
    const image = images.find((i) => i.is_primary()) ?? images[0]
    const width = image.get_width()
    const height = image.get_height()
    const out = await display(image, width, height)
    const outBuffer = out.data.buffer
    parentPort.postMessage({ id, width, height, data: outBuffer }, [outBuffer])
  } catch (e) {
    parentPort.postMessage({ id, error: e?.message ?? String(e) })
  } finally {
    for (const i of images) i.free()
  }
})
