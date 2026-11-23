// Reads text in photos off the main thread (see ocr-core.mjs). Loaded by
// path, like embed-worker.mjs.
//
// workerData: { modelDir, threads, scripts, device }
//   device 'gpu', 'cpu', or 'auto': try the GPU (WebGPU, any vendor), check
//   it reads a test line the same as the CPU, and keep it only then.
// in:  { id, file }
// out: { id, width, height, lines: [{ text, conf, box, at }] } | { id, error }
//      { event: 'device', device: 'gpu' | 'cpu', reason } when the choice is made or changes

import sharp from 'sharp'
import { parentPort, workerData } from 'node:worker_threads'
import { decode, loadOcr, readImage, readImageDeep } from './ocr-core.mjs'

const { modelDir, threads, scripts, device } = workerData

function tell(where, reason) {
  parentPort.postMessage({ event: 'device', device: where, reason })
}

async function testImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200"><rect width="100%" height="100%" fill="#fff"/>
    <text x="30" y="80" font-family="Arial" font-size="44" fill="#111">Theia reads 2026</text>
    <text x="30" y="150" font-family="Arial" font-size="36" fill="#333">INVOICE No. 4821</text></svg>`
  return decode(await sharp(Buffer.from(svg)).png().toBuffer())
}

const same = (a, b) => a.lines.map((l) => l.text).join('\n') === b.lines.map((l) => l.text).join('\n')

let current = null
function ready() {
  current ??= (async () => {
    const cpu = () => loadOcr(modelDir, { threads, scripts, device: 'cpu' })
    if (device === 'cpu') return { ocr: await cpu(), where: 'cpu' }
    try {
      const gpu = await loadOcr(modelDir, { threads, scripts, device: 'gpu' })
      const test = await testImage()
      const onGpu = await readImage(gpu, test)
      if (device === 'auto') {
        const check = await cpu()
        const onCpu = await readImage(check, test)
        if (!same(onGpu, onCpu)) {
          await gpu.release()
          tell('cpu', 'The graphics card read a test line differently from the processor.')
          return { ocr: check, where: 'cpu' }
        }
        await check.release()
      }
      tell('gpu', null)
      return { ocr: gpu, where: 'gpu' }
    } catch (e) {
      tell('cpu', `The graphics card could not run the text reader: ${e?.message ?? e}`)
      return { ocr: await cpu(), where: 'cpu' }
    }
  })()
  return current
}

async function fallBack(error) {
  const was = await current
  current = (async () => {
    await was.ocr.release().catch(() => {})
    tell('cpu', `The graphics card stopped working: ${error?.message ?? error}`)
    return { ocr: await loadOcr(modelDir, { threads, scripts, device: 'cpu' }), where: 'cpu' }
  })()
  return current
}

let queue = Promise.resolve()
parentPort.on('message', (msg) => {
  queue = queue.then(async () => {
    try {
      let { ocr, where } = await ready()
      const image = await decode(msg.file)
      let read
      try {
        read = await (msg.deep ? readImageDeep : readImage)(ocr, image)
      } catch (e) {
        if (where !== 'gpu') throw e
        ;({ ocr } = await fallBack(e))
        read = await (msg.deep ? readImageDeep : readImage)(ocr, image)
      }
      parentPort.postMessage({ id: msg.id, ...read })
    } catch (e) {
      parentPort.postMessage({ id: msg.id, error: e?.message ?? String(e) })
    }
  })
})
