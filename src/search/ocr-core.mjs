// Reads the text in a photo with PaddleOCR models on ONNX Runtime: find text
// lines, straighten each one, read it. Plain JavaScript, loaded by path from
// ocr-worker.mjs, like the other workers.
//
// Detection (PP-OCRv4 mobile) gives a probability map of "text here"; each
// connected blob above 0.3 is a line, boxed by its smallest rotated rectangle
// and grown a little, as PaddleOCR does. Each line is sampled straight out of
// the full image into a 48 px high strip and read by every recognition model
// (English and Devanagari); the most confident reading wins.

import fs from 'node:fs'
import path from 'node:path'
import ort from 'onnxruntime-node'
import sharp from 'sharp'

const DET_LIMIT = 960
const DET_THRESHOLD = 0.3
const BOX_THRESHOLD = 0.6
const UNCLIP = 1.6
const REC_HEIGHT = 48
const REC_MIN_WIDTH = 320
const REC_MAX_WIDTH = 1600
const MIN_CONFIDENCE = 0.6
const MAX_LINES = 120

// libvips keeps recently read files open for reuse. On Windows an open file
// cannot be deleted, and thumbnails are deleted when a photo is hidden.
sharp.cache(false)

/**
 * dir holds det.onnx and, per script, <name>.onnx with <name>.txt (one
 * character per line). Sessions are created once and reused.
 */
export async function loadOcr(dir, { threads = 2, scripts = ['en', 'devanagari'], device = 'cpu' } = {}) {
  const options = { executionProviders: device === 'gpu' ? ['webgpu', 'cpu'] : ['cpu'], intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all' }
  const det = await ort.InferenceSession.create(path.join(dir, 'det.onnx'), options)
  const recs = []
  for (const name of scripts) {
    const session = await ort.InferenceSession.create(path.join(dir, `${name}.onnx`), options)
    const chars = fs.readFileSync(path.join(dir, `${name}.txt`), 'utf8').split(/\r?\n/)
    if (chars.at(-1) === '') chars.pop()
    // Index 0 is the CTC blank, the last is a space.
    recs.push({ name, session, chars: ['', ...chars, ' '] })
  }
  return { det, recs, release: async () => { await det.release(); for (const r of recs) await r.session.release() } }
}

/**
 * Lines of text in an image file, top to bottom, with the size of the image
 * they were read from. Each line has its box (four corners, in reading order:
 * top left, top right, bottom right, bottom left of the text) and where along
 * the box each character sits (0 to 1), so a single word can be highlighted.
 */
export async function readText(ocr, file) {
  return readImage(ocr, await decode(file))
}

/** An image file (or its bytes) as RGB pixels. */
export async function decode(file) {
  // Read whole, so the file is closed before decoding starts (see sharp.cache above).
  const bytes = typeof file === 'string' ? await fs.promises.readFile(file) : file
  const { data, info } = await sharp(bytes).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels }
}

/** Like readText, for pixels already decoded. */
export async function readImage(ocr, image) {
  const boxes = await detect(ocr.det, image)
  const lines = []
  for (const box of boxes.slice(0, MAX_LINES)) {
    const strip = sampleStrip(image, box)
    if (!strip) continue
    let best = null
    for (const rec of ocr.recs) {
      const r = await recognise(rec, strip)
      if (r.text.trim() && (!best || r.conf > best.conf)) best = r
      // A clear reading by the first model needs no second opinion.
      if (best && best.conf >= 0.9) break
    }
    // Two letters or digits at least: a lone mark is more often noise than text.
    if (best && best.conf >= MIN_CONFIDENCE && (best.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2) {
      const start = best.text.length - best.text.trimStart().length
      const text = best.text.trim()
      const at = best.at.slice(start, start + text.length).map((x) => Math.round(x * 1000) / 1000)
      lines.push({ text, conf: best.conf, box: box.corners, at })
    }
  }
  return { width: image.width, height: image.height, lines }
}

/* --------------------------------------------------------------- detection */

async function detect(session, image) {
  const scale = Math.min(1, DET_LIMIT / Math.max(image.width, image.height))
  const w = Math.max(32, Math.round((image.width * scale) / 32) * 32)
  const h = Math.max(32, Math.round((image.height * scale) / 32) * 32)
  const small = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: image.channels } })
    .resize(w, h, { fit: 'fill' }).raw().toBuffer()
  // Paddle trains on BGR, normalised with ImageNet statistics.
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]
  const input = new Float32Array(3 * w * h)
  const plane = w * h
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) input[c * plane + i] = (small[i * 3 + (2 - c)] / 255 - mean[c]) / std[c]
  }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, h, w]) })
  const prob = out[session.outputNames[0]].data
  const sx = image.width / w
  const sy = image.height / h
  return components(prob, w, h)
    .map((points) => {
      const rect = minAreaRect(points)
      if (Math.min(rect.w, rect.h) < 3) return null
      if (boxScore(prob, w, h, rect) < BOX_THRESHOLD) return null
      // Grow the box by area * ratio / perimeter on every side, like Paddle's unclip.
      const d = (rect.w * rect.h * UNCLIP) / (2 * (rect.w + rect.h))
      return orient({ cx: rect.cx * sx, cy: rect.cy * sy, w: (rect.w + 2 * d) * sx, h: (rect.h + 2 * d) * sy, angle: rect.angle }, sx, sy)
    })
    .filter(Boolean)
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx)
}

/** Connected blobs above the threshold, each as its outline points (row ends). */
function components(prob, w, h) {
  const seen = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  const out = []
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start] <= DET_THRESHOLD) continue
    let top = 0
    stack[top++] = start
    seen[start] = 1
    const rows = new Map()
    let count = 0
    while (top) {
      const p = stack[--top]
      const x = p % w
      const y = (p - x) / w
      count++
      const r = rows.get(y)
      if (!r) rows.set(y, [x, x])
      else { if (x < r[0]) r[0] = x; if (x > r[1]) r[1] = x }
      const visit = (q) => { if (!seen[q] && prob[q] > DET_THRESHOLD) { seen[q] = 1; stack[top++] = q } }
      if (x > 0) visit(p - 1)
      if (x < w - 1) visit(p + 1)
      if (y > 0) visit(p - w)
      if (y < h - 1) visit(p + w)
    }
    if (count < 10) continue
    const points = []
    for (const [y, [a, b]] of rows) {
      points.push([a, y], [b + 1, y], [a, y + 1], [b + 1, y + 1])
    }
    out.push(points)
  }
  return out
}

/** Smallest rectangle around the points, at any angle (rotating calipers over the hull). */
function minAreaRect(points) {
  const hull = convexHull(points)
  if (hull.length < 3) {
    const xs = points.map((p) => p[0])
    const ys = points.map((p) => p[1])
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, angle: 0 }
  }
  let best = null
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i]
    const [bx, by] = hull[(i + 1) % hull.length]
    const len = Math.hypot(bx - ax, by - ay)
    if (!len) continue
    const ux = (bx - ax) / len, uy = (by - ay) / len
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
    for (const [px, py] of hull) {
      const u = px * ux + py * uy
      const v = -px * uy + py * ux
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
    const area = (maxU - minU) * (maxV - minV)
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2
      best = { area, cx: cu * ux - cv * uy, cy: cu * uy + cv * ux, w: maxU - minU, h: maxV - minV, angle: Math.atan2(uy, ux) }
    }
  }
  return best
}

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

/** Mean probability inside the rectangle: blobs that are only faintly text are dropped. */
function boxScore(prob, w, h, rect) {
  const ux = Math.cos(rect.angle), uy = Math.sin(rect.angle)
  const steps = 12
  let sum = 0, n = 0
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const u = (i / steps - 0.5) * rect.w
      const v = (j / steps - 0.5) * rect.h
      const x = Math.floor(rect.cx + u * ux - v * uy)
      const y = Math.floor(rect.cy + u * uy + v * ux)
      if (x < 0 || y < 0 || x >= w || y >= h) continue
      sum += prob[y * w + x]
      n++
    }
  }
  return n ? sum / n : 0
}

/**
 * Point the box along the line of text: its long side, running left to right
 * (or bottom to top for a vertical line). Corners are reported for debugging.
 */
function orient(r, sx, sy) {
  let ux = Math.cos(r.angle), uy = Math.sin(r.angle)
  let w = r.w, h = r.h
  if (h > w) {
    ;[w, h] = [h, w]
    ;[ux, uy] = [-uy, ux]
  }
  if (ux < -1e-6 || (Math.abs(ux) <= 1e-6 && uy > 0)) { ux = -ux; uy = -uy }
  const vx = -uy, vy = ux
  const corner = (a, b) => [r.cx + a * ux * w / 2 + b * vx * h / 2, r.cy + a * uy * w / 2 + b * vy * h / 2]
  return { cx: r.cx, cy: r.cy, w, h, ux, uy, vx, vy, corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].map((p) => p.map(Math.round)) }
}

/* ------------------------------------------------------------- recognition */

/** The line, straightened and scaled to 48 px high, as BGR in [-1, 1]. */
function sampleStrip(image, box) {
  if (box.h < 4 || box.w < 4) return null
  const width = Math.min(REC_MAX_WIDTH, Math.max(1, Math.round((REC_HEIGHT * box.w) / box.h)))
  const padded = Math.max(REC_MIN_WIDTH, width)
  const plane = REC_HEIGHT * padded
  const data = new Float32Array(3 * plane)
  const { width: W, height: H, channels: C } = image
  const px = image.data
  const x0 = box.cx - (box.ux * box.w) / 2 - (box.vx * box.h) / 2
  const y0 = box.cy - (box.uy * box.w) / 2 - (box.vy * box.h) / 2
  const su = box.w / width, sv = box.h / REC_HEIGHT
  for (let j = 0; j < REC_HEIGHT; j++) {
    for (let i = 0; i < width; i++) {
      const u = (i + 0.5) * su, v = (j + 0.5) * sv
      const x = x0 + u * box.ux + v * box.vx - 0.5
      const y = y0 + u * box.uy + v * box.vy - 0.5
      const xi = Math.floor(x), yi = Math.floor(y)
      const fx = x - xi, fy = y - yi
      for (let c = 0; c < 3; c++) {
        const at = (xx, yy) => px[(Math.min(H - 1, Math.max(0, yy)) * W + Math.min(W - 1, Math.max(0, xx))) * C + c]
        const value = (at(xi, yi) * (1 - fx) + at(xi + 1, yi) * fx) * (1 - fy) + (at(xi, yi + 1) * (1 - fx) + at(xi + 1, yi + 1) * fx) * fy
        data[(2 - c) * plane + j * padded + i] = value / 127.5 - 1
      }
    }
  }
  return { data, width: padded, content: width }
}

async function recognise(rec, strip) {
  const out = await rec.session.run({
    [rec.session.inputNames[0]]: new ort.Tensor('float32', strip.data, [1, 3, REC_HEIGHT, strip.width]),
  })
  const t = out[rec.session.outputNames[0]]
  const [, steps, classes] = t.dims
  const probs = t.data
  let text = ''
  const at = []
  let sum = 0, n = 0, last = 0
  for (let s = 0; s < steps; s++) {
    let k = 0, p = probs[s * classes]
    for (let c = 1; c < classes; c++) if (probs[s * classes + c] > p) { p = probs[s * classes + c]; k = c }
    if (k !== 0 && k !== last) {
      const ch = rec.chars[k] ?? ''
      text += ch
      // Where this character is, along the text rather than the padded strip.
      const x = Math.min(1, (((s + 0.5) / steps) * strip.width) / strip.content)
      for (let c = 0; c < ch.length; c++) at.push(x)
      sum += p
      n++
    }
    last = k
  }
  return { text, at, conf: n ? sum / n : 0, script: rec.name }
}
