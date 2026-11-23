// Finds faces in a photo and describes each one as a vector, so faces of the
// same person can be grouped. Plain JavaScript, loaded by path from
// face-worker.mjs, like the other model workers.
//
// YuNet (MIT, OpenCV Zoo) finds faces and five landmarks: eyes, nose tip,
// mouth corners. It takes a fixed 640x640 input and sees faces of about 10 to
// 300 pixels, so a photo is looked at three ways: whole at 640 (most faces),
// whole at 320 on the same canvas (close-ups and selfies), and in four
// overlapping 640 tiles of a 1152 copy (small faces in group photos).
//
// Each face is then turned upright and scaled by its landmarks onto the
// standard 112x112 face template, and SFace (Apache 2.0, OpenCV Zoo) turns it
// into 128 numbers. Faces of one person point the same way.
//
// The closer look (`deep`, on a full-resolution copy of the photo) looks
// harder with the same two models: finer tiles at 2304 px and at the photo's
// own size, for faces a few dozen pixels across in a crowd; the photo turned
// a quarter each way, for someone lying down or a photo saved sideways; a
// lower detection threshold (0.8 against 0.85); and each face described twice, as it is and
// mirrored, the two averaged, which describes it more steadily.

import fs from 'node:fs'
import path from 'node:path'
import ort from 'onnxruntime-node'
import sharp from 'sharp'

sharp.cache(false)

const INPUT = 640
const STRIDES = [8, 16, 32]
const MIN_SCORE = 0.85
const NMS_IOU = 0.3
/** Smaller than this (in the 1600 px thumbnail) is too blurry to recognise reliably. */
const MIN_FACE = 40
const MAX_FACES = 40
// 0.8, not lower: on a real library every face found below 0.8 was a hand or the back of a head.
const DEEP = { minScore: 0.8, maxFaces: 80, tileEdges: [1152, 2304, 3200] }
/** Tiles overlap by this much, so a face cut by one tile's edge is whole in the next. */
const TILE_OVERLAP = 128

/** Where the eyes, nose and mouth corners sit in a 112x112 face crop (the ArcFace template). */
const TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
]

export async function loadFaces(dir, { threads = 2, device = 'cpu' } = {}) {
  const options = { executionProviders: device === 'gpu' ? ['webgpu', 'cpu'] : ['cpu'], intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all', logSeverityLevel: 3 }
  return {
    det: await ort.InferenceSession.create(path.join(dir, 'yunet.onnx'), options),
    rec: await ort.InferenceSession.create(path.join(dir, 'sface.onnx'), options),
  }
}

/**
 * Faces in an image file, biggest first: box and landmarks in the image's
 * pixels, detection score, a sharpness measure, and a unit vector.
 */
export async function readFaces(models, file, { deep = false } = {}) {
  const { data, info } = await sharp(await fs.promises.readFile(file)).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  const image = { data, width: info.width, height: info.height, channels: info.channels }
  const minScore = deep ? DEEP.minScore : MIN_SCORE
  const found = []
  const long = Math.max(image.width, image.height)
  // Whole image at 640 and at 320 (for faces too big for the model at 640).
  for (const fit of [INPUT, INPUT / 2]) {
    const s = fit / long
    found.push(...(await detectAt(models.det, image, s, 0, 0, minScore)))
  }
  // Overlapping tiles of a larger copy, for small faces.
  for (const edge of deep ? DEEP.tileEdges : [1152]) {
    if (long <= INPUT) break
    const s = Math.min(edge / long, 1)
    const w = Math.round(image.width * s), h = Math.round(image.height * s)
    for (const ox of tileStarts(w)) for (const oy of tileStarts(h)) found.push(...(await detectAt(models.det, image, s, ox, oy, minScore)))
    if (s === 1) break
  }
  // Turned a quarter each way, whole: faces lying sideways.
  if (deep) {
    for (const angle of [90, 270]) {
      const turned = await rotateImage(image, angle)
      const s = INPUT / Math.max(turned.width, turned.height)
      for (const f of await detectAt(models.det, turned, s, 0, 0, minScore)) found.push(unturn(f, angle, image.width, image.height))
    }
  }
  const faces = nms(found).filter((f) => Math.min(f.w, f.h) >= MIN_FACE).slice(0, deep ? DEEP.maxFaces : MAX_FACES)
  const out = []
  for (const f of faces) {
    const crop = alignedCrop(image, f.landmarks)
    const vec = deep ? average(await describe(models.rec, crop), await describe(models.rec, mirror(crop))) : await describe(models.rec, crop)
    out.push({
      box: [f.x, f.y, f.w, f.h].map((v) => Math.round(v * 10) / 10),
      landmarks: f.landmarks.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
      score: Math.round(f.score * 1000) / 1000,
      sharpness: Math.round(sharpness(crop) * 10) / 10,
      vec,
    })
  }
  return { width: image.width, height: image.height, faces: out }
}

/**
 * Run the detector on the image scaled by `scale`, looking at the 640x640
 * window whose top left is (ox, oy) in the scaled image. Returns faces in the
 * original image's pixels.
 */
/** Left edges of 640 px windows across n pixels, overlapping by TILE_OVERLAP. */
export function tileStarts(n) {
  if (n <= INPUT) return [0]
  const count = Math.ceil((n - TILE_OVERLAP) / (INPUT - TILE_OVERLAP))
  const step = (n - INPUT) / (count - 1)
  return Array.from({ length: count }, (_, i) => Math.round(i * step))
}

async function rotateImage(image, angle) {
  const { data, info } = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: image.channels } })
    .rotate(angle).raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels }
}

/**
 * A point found in the image turned clockwise by `angle` (90 or 270), back in
 * the w x h original. Turned 90: (x, y) came from (y, h - x). Turned 270:
 * from (w - y, x).
 */
export function unturnPoint([x, y], angle, w, h) {
  return angle === 90 ? [y, h - x] : [w - y, x]
}

/** A face found in the turned image, in the original's pixels; its box bounds its turned corners. */
function unturn(f, angle, w, h) {
  const corners = [[f.x, f.y], [f.x + f.w, f.y], [f.x, f.y + f.h], [f.x + f.w, f.y + f.h]].map((p) => unturnPoint(p, angle, w, h))
  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1])
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, score: f.score, landmarks: f.landmarks.map((p) => unturnPoint(p, angle, w, h)) }
}

/** The 112x112 crop flipped left to right. */
function mirror(crop) {
  const out = new Float32Array(crop.length)
  const plane = 112 * 112
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < 112; y++) {
      for (let x = 0; x < 112; x++) out[c * plane + y * 112 + x] = crop[c * plane + y * 112 + (111 - x)]
    }
  }
  return out
}

/** The mean of two unit vectors, made unit again. */
function average(a, b) {
  const v = new Float32Array(a.length)
  let s = 0
  for (let i = 0; i < a.length; i++) { v[i] = a[i] + b[i]; s += v[i] * v[i] }
  s = Math.sqrt(s) || 1
  for (let i = 0; i < v.length; i++) v[i] /= s
  return v
}

async function detectAt(session, image, scale, ox, oy, minScore = MIN_SCORE) {
  const sw = Math.max(1, Math.round(image.width * scale))
  const sh = Math.max(1, Math.round(image.height * scale))
  const scaled = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: image.channels } })
    .resize(sw, sh, { fit: 'fill' }).raw().toBuffer()
  // BGR, 0 to 255, no normalisation; the rest of the canvas black.
  const plane = INPUT * INPUT
  const input = new Float32Array(3 * plane)
  const w = Math.min(INPUT, sw - ox), h = Math.min(INPUT, sh - oy)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = ((y + oy) * sw + (x + ox)) * 3
      const q = y * INPUT + x
      input[q] = scaled[p + 2]
      input[plane + q] = scaled[p + 1]
      input[2 * plane + q] = scaled[p]
    }
  }
  const out = await session.run({ input: new ort.Tensor('float32', input, [1, 3, INPUT, INPUT]) })
  const faces = []
  for (const stride of STRIDES) {
    const cls = out[`cls_${stride}`].data, obj = out[`obj_${stride}`].data
    const bbox = out[`bbox_${stride}`].data, kps = out[`kps_${stride}`].data
    const cols = INPUT / stride
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])))
      if (score < minScore) continue
      const r = Math.floor(i / cols), c = i % cols
      const cx = (c + bbox[4 * i]) * stride, cy = (r + bbox[4 * i + 1]) * stride
      const bw = Math.exp(bbox[4 * i + 2]) * stride, bh = Math.exp(bbox[4 * i + 3]) * stride
      // Back to the original image: undo the window, then the scale.
      const back = (x, y) => [(x + ox) / scale, (y + oy) / scale]
      const [x0, y0] = back(cx - bw / 2, cy - bh / 2)
      const landmarks = []
      for (let k = 0; k < 5; k++) landmarks.push(back((kps[10 * i + 2 * k] + c) * stride, (kps[10 * i + 2 * k + 1] + r) * stride))
      // A face cut by an edge shared with another tile is found whole in that tile.
      const edge = 2
      const cut = (ox > 0 && cx - bw / 2 < edge) || (oy > 0 && cy - bh / 2 < edge)
        || (ox + INPUT < sw && cx + bw / 2 > INPUT - edge) || (oy + INPUT < sh && cy + bh / 2 > INPUT - edge)
      if (cut) continue
      faces.push({ x: x0, y: y0, w: bw / scale, h: bh / scale, score, landmarks })
    }
  }
  return faces
}

function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h)
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  return inter / (a.w * a.h + b.w * b.h - inter)
}

/** Best of overlapping detections, biggest faces first. */
function nms(faces) {
  const kept = []
  for (const f of faces.sort((a, b) => b.score - a.score)) {
    if (kept.every((k) => iou(k, f) < NMS_IOU)) kept.push(f)
  }
  return kept.sort((a, b) => b.w * b.h - a.w * a.h)
}

/**
 * The 112x112 face, turned and scaled so its landmarks land on the template:
 * the least-squares similarity transform (rotation, uniform scale, shift)
 * from template to photo, sampled bilinearly. RGB, 0 to 255.
 */
function alignedCrop(image, landmarks) {
  // Fit photo = s*R*template + t, i.e. x = a*u - b*v + tx, y = b*u + a*v + ty.
  const n = TEMPLATE.length
  let mu = 0, mv = 0, mx = 0, my = 0
  for (let i = 0; i < n; i++) { mu += TEMPLATE[i][0]; mv += TEMPLATE[i][1]; mx += landmarks[i][0]; my += landmarks[i][1] }
  mu /= n; mv /= n; mx /= n; my /= n
  let suu = 0, sxa = 0, sxb = 0
  for (let i = 0; i < n; i++) {
    const u = TEMPLATE[i][0] - mu, v = TEMPLATE[i][1] - mv
    const x = landmarks[i][0] - mx, y = landmarks[i][1] - my
    suu += u * u + v * v
    sxa += u * x + v * y
    sxb += u * y - v * x
  }
  const a = sxa / suu, b = sxb / suu
  const tx = mx - (a * mu - b * mv), ty = my - (b * mu + a * mv)
  const { data, width: W, height: H, channels: C } = image
  const out = new Float32Array(3 * 112 * 112)
  const plane = 112 * 112
  for (let v = 0; v < 112; v++) {
    for (let u = 0; u < 112; u++) {
      const x = a * u - b * v + tx, y = b * u + a * v + ty
      const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi
      for (let c = 0; c < 3; c++) {
        const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= W || yy >= H ? 0 : data[(yy * W + xx) * C + c])
        out[c * plane + v * 112 + u] = (at(xi, yi) * (1 - fx) + at(xi + 1, yi) * fx) * (1 - fy) + (at(xi, yi + 1) * (1 - fx) + at(xi + 1, yi + 1) * fx) * fy
      }
    }
  }
  return out
}

async function describe(session, crop) {
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', crop, [1, 3, 112, 112]) })
  const raw = out[session.outputNames[0]].data
  const v = Float32Array.from(raw)
  let s = 0
  for (const x of v) s += x * x
  s = Math.sqrt(s) || 1
  for (let i = 0; i < v.length; i++) v[i] /= s
  return v
}

/** Variance of the Laplacian of the crop's grey: low for a blurred face, which describes poorly. */
function sharpness(crop) {
  const plane = 112 * 112
  const g = new Float32Array(plane)
  for (let i = 0; i < plane; i++) g[i] = 0.299 * crop[i] + 0.587 * crop[plane + i] + 0.114 * crop[2 * plane + i]
  let sum = 0, sq = 0, n = 0
  for (let y = 1; y < 111; y++) {
    for (let x = 1; x < 111; x++) {
      const i = y * 112 + x
      const l = g[i - 1] + g[i + 1] + g[i - 112] + g[i + 112] - 4 * g[i]
      sum += l; sq += l * l; n++
    }
  }
  const mean = sum / n
  return sq / n - mean * mean
}
