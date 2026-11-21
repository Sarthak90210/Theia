// Runs EmbeddingGemma 2 off the main thread. Loaded by path (like
// heic-worker.mjs), so it is plain JavaScript and imports Transformers.js from
// node_modules at run time.
//
// workerData: { modelDir, visionTokens, dimensions, threads, device }
//   device 'gpu', 'cpu', or 'auto': try the GPU, check it against the CPU on
//   a test image, and keep it only when the two agree.
// in:  { id, kind: 'image', file } | { id, kind: 'text', text }
// out: { id, vec: Float32Array } | { id, error }
//      { event: 'device', device: 'gpu' | 'cpu', reason } when the choice is made or changes
//
// The GPU is reached through WebGPU, which ONNX Runtime runs on Direct3D 12:
// any recent Intel, AMD or NVIDIA graphics, built in or separate, and the
// high-performance one when a laptop has two. Nothing here names a vendor.
//
// Only bundled files are read: remote models are off, so nothing is ever
// downloaded, and a missing file is an error instead of a fetch.

import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { env, AutoConfig, AutoModel, AutoProcessor, RawImage } from '@huggingface/transformers'

const { modelDir, visionTokens, dimensions, threads, device } = workerData

env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = path.dirname(modelDir) + path.sep
env.useBrowserCache = false
env.useFSCache = false
const id = path.basename(modelDir)

/** GPU and CPU vectors of the test image must agree this well. Measured: 0.996 on a real library. */
const AGREE = 0.98

let config = null
let processor = null

async function loadOn(where) {
  config ??= await AutoConfig.from_pretrained(id)
  // Photos only: the audio encoder is not shipped and never loaded.
  config.audio_config = null
  processor ??= await AutoProcessor.from_pretrained(id)
  processor.image_processor.max_soft_tokens = visionTokens
  return AutoModel.from_pretrained(id, {
    config,
    device: where === 'gpu' ? 'webgpu' : 'cpu',
    dtype: { model: 'fp16', vision_encoder: 'fp16' },
    session_options: where === 'gpu' ? {} : { intraOpNumThreads: threads, interOpNumThreads: 1 },
  })
}

/** A fixed picture made here, not read from disk: colour gradients, stripes and a disc. */
function testImage() {
  const w = 384, h = 288
  const data = new Uint8ClampedArray(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const disc = (x - 250) ** 2 + (y - 140) ** 2 < 70 ** 2
      data[i] = disc ? 240 : (x * 255) / w
      data[i + 1] = disc ? 200 : ((y >> 4) & 1) * 180
      data[i + 2] = disc ? 40 : (y * 255) / h
    }
  }
  return new RawImage(data, w, h, 3)
}

/** Matryoshka: keep the leading dimensions, then make it unit length again. */
function truncate(data) {
  const v = Float32Array.from(data.subarray(0, dimensions))
  let s = 0
  for (const x of v) s += x * x
  s = Math.sqrt(s) || 1
  for (let i = 0; i < v.length; i++) v[i] /= s
  return v
}

/** Decoding and tokenising happen before the model, so a bad file is never blamed on the GPU. */
async function prepare(input) {
  return input.kind === 'image'
    ? processor(null, [[input.image ?? await RawImage.read(input.file)]])
    : processor([input.text])
}

async function run(model, inputs) {
  const out = await model(inputs)
  return truncate(out.sentence_embedding.data)
}

async function embed(model, input) {
  return run(model, await prepare(input))
}

function tell(where, reason) {
  parentPort.postMessage({ event: 'device', device: where, reason })
}

let current = null
async function ready() {
  current ??= (async () => {
    if (device === 'cpu') return { model: await loadOn('cpu'), where: 'cpu' }
    try {
      const gpu = await loadOn('gpu')
      const onGpu = await embed(gpu, { kind: 'image', image: testImage() })
      if (device === 'auto') {
        const cpu = await loadOn('cpu')
        const onCpu = await embed(cpu, { kind: 'image', image: testImage() })
        await cpu.dispose()
        const agree = onGpu.reduce((s, x, i) => s + x * onCpu[i], 0)
        if (!(agree >= AGREE)) {
          await gpu.dispose()
          tell('cpu', `The graphics card gave a different answer from the processor on a test picture (${agree.toFixed(3)}).`)
          return { model: await loadOn('cpu'), where: 'cpu' }
        }
      }
      tell('gpu', null)
      return { model: gpu, where: 'gpu' }
    } catch (e) {
      tell('cpu', `The graphics card could not run the model: ${e?.message ?? e}`)
      return { model: await loadOn('cpu'), where: 'cpu' }
    }
  })()
  return current
}

/** A GPU that fails mid-run (a driver reset, say) is dropped for the processor, and the request tried again. */
async function fallBack(error) {
  const was = await current
  current = (async () => {
    await was.model.dispose().catch(() => {})
    tell('cpu', `The graphics card stopped working: ${error?.message ?? error}`)
    return { model: await loadOn('cpu'), where: 'cpu' }
  })()
  return current
}

let queue = Promise.resolve()
parentPort.on('message', (msg) => {
  // One at a time: the session already uses the whole GPU or several threads.
  queue = queue.then(async () => {
    try {
      let { model, where } = await ready()
      const inputs = await prepare(msg)
      let vec
      try {
        vec = await run(model, inputs)
      } catch (e) {
        if (where !== 'gpu') throw e
        ;({ model } = await fallBack(e))
        vec = await run(model, inputs)
      }
      parentPort.postMessage({ id: msg.id, vec }, [vec.buffer])
    } catch (e) {
      parentPort.postMessage({ id: msg.id, error: e?.message ?? String(e) })
    }
  })
})
