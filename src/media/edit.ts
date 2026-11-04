import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import sharp, { type OutputInfo, type Sharp } from 'sharp'
import type { HeicPool } from '../thumbs/heic-pool.ts'
import { heicProfile, tagJpeg } from '../thumbs/colour.ts'
import { validateEdit, type EditRecipe } from './edit-recipe.ts'
import { applyColourToPixels, colourOps, coverScale, cubeLut } from './edit-math.ts'
import { probe } from './playback.ts'

sharp.cache(false)
export interface EditSource { file: string; mime: string }
export interface EditDeps { heic: Pick<HeicPool, 'decode'>; ffmpeg?: string }

type Raw = { data: Buffer; info: OutputInfo }
const raw = (img: Sharp): Promise<Raw> => img.raw().toBuffer({ resolveWithObject: true })
const from = (r: Raw): Sharp => sharp(r.data, { raw: { width: r.info.width, height: r.info.height, channels: r.info.channels } })

export async function editPhoto(source: EditSource, settings: EditRecipe, deps: EditDeps, preview = false): Promise<Buffer> {
  const r = validateEdit(settings)
  const heic = /image\/hei[cf]/.test(source.mime)
  let image: Sharp
  if (heic) {
    const d = await deps.heic.decode(source.file)
    image = sharp(d.data, { raw: { width: d.width, height: d.height, channels: 4 } })
  } else image = sharp(source.file).rotate() // EXIF orientation first
  // Each geometry step is written out before the next. libvips otherwise
  // reorders operations (a preview resize ahead of an extract, say), and the
  // fractions in the recipe would be read against the wrong size.
  let px = await raw(image.removeAlpha())
  if (r.flip) px = await raw(from(px).flop())
  if (r.rotation) px = await raw(from(px).rotate(r.rotation))
  if (r.straighten) {
    const { width: w, height: h } = px.info
    const k = coverScale(w, h, r.straighten)
    const turned = await raw(from(px).rotate(r.straighten, { background: '#000' }))
    // The middle of the turned picture, zoomed so no corner shows.
    const cw = Math.max(1, Math.min(turned.info.width, Math.round(w / k)))
    const ch = Math.max(1, Math.min(turned.info.height, Math.round(h / k)))
    px = await raw(from(turned).extract({
      left: Math.floor((turned.info.width - cw) / 2), top: Math.floor((turned.info.height - ch) / 2), width: cw, height: ch,
    }))
  }
  const { width, height } = px.info
  const left = Math.min(width - 1, Math.floor(r.crop.x * width))
  const top = Math.min(height - 1, Math.floor(r.crop.y * height))
  px = await raw(from(px).extract({
    left, top,
    width: Math.max(1, Math.min(width - left, Math.round(r.crop.width * width))),
    height: Math.max(1, Math.min(height - top, Math.round(r.crop.height * height))),
  }))
  const ops = colourOps(r)
  if (!ops.identity) applyColourToPixels(ops, px.data, px.info.channels)
  let out = from(px)
  if (preview) out = out.resize(1200, 900, { fit: 'inside', withoutEnlargement: true })
  const bytes = await out.jpeg({ quality: preview ? 88 : 95, chromaSubsampling: '4:4:4' }).toBuffer()
  return tagJpeg(bytes, heic ? heicProfile(source.file) : null)
}

/**
 * The ffmpeg filter chain. `lut` is a .cube file holding the colour step
 * (see cubeLut), or null when the edit changes no colour.
 */
export function videoEditFilters(r: EditRecipe, lut: string | null = null): string {
  const filters: string[] = []
  if (r.flip) filters.push('hflip')
  if (r.rotation === 90) filters.push('transpose=1')
  if (r.rotation === 180) filters.push('hflip', 'vflip')
  if (r.rotation === 270) filters.push('transpose=2')
  if (r.straighten) {
    // Turn about the centre and keep the middle, zoomed as coverScale() does.
    const a = (Math.abs(r.straighten) * Math.PI) / 180
    const k = `max(${Math.cos(a)}+${Math.sin(a)}*ih/iw\\,${Math.cos(a)}+${Math.sin(a)}*iw/ih)`
    filters.push(`rotate=${(r.straighten * Math.PI) / 180}:ow=trunc(iw/${k}/2)*2:oh=trunc(ih/${k}/2)*2:c=black`)
  }
  const c = r.crop
  filters.push(`crop=max(2\\,trunc(iw*${c.width}/2)*2):max(2\\,trunc(ih*${c.height}/2)*2):trunc(iw*${c.x}/2)*2:trunc(ih*${c.y}/2)*2`)
  // The filtergraph needs ':' and '\' escaped in a path, and the path quoted.
  if (lut) filters.push(`lut3d=file='${lut.replace(/\\/g, '/').replace(/:/g, '\\:')}':interp=tetrahedral`)
  filters.push('setsar=1')
  return filters.join(',')
}

function ffmpeg(args: string[], bin = 'ffmpeg'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { windowsHide: true })
    const output: Buffer[] = []
    let error = ''
    p.stdout.on('data', (b: Buffer) => output.push(b))
    p.stderr.on('data', (b: Buffer) => { error = (error + b.toString()).slice(-3000) })
    p.on('error', (e) => reject(new Error(`Video editor could not start ffmpeg: ${e.message}`)))
    p.on('close', (code) => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(`Video edit failed: ${error || code}`)))
  })
}

/** The colour step as a temporary .cube file for ffmpeg, removed after `use`. */
async function withLut<T>(r: EditRecipe, use: (lut: string | null) => Promise<T>): Promise<T> {
  const ops = colourOps(r)
  if (ops.identity) return use(null)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theia-lut-'))
  const file = path.join(dir, 'edit.cube')
  fs.writeFileSync(file, cubeLut(ops))
  try {
    return await use(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export async function editPreview(source: EditSource, settings: EditRecipe, deps: EditDeps): Promise<Buffer> {
  const r = validateEdit(settings)
  if (!source.mime.startsWith('video/')) return editPhoto(source, r, deps, true)
  return withLut(r, (lut) => ffmpeg(['-ss', String(r.start), '-i', source.file, '-map', '0:v:0', '-frames:v', '1', '-vf',
    `${videoEditFilters(r, lut)},scale=1200:900:force_original_aspect_ratio=decrease`, '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], deps.ffmpeg))
}

export async function editVideo(source: EditSource, output: string, settings: EditRecipe, deps: EditDeps): Promise<number> {
  const r = validateEdit(settings)
  const p = await probe(source.file)
  if (!p.video || !p.durationSec || r.start >= p.durationSec) throw new Error('Trim start must be before the end of the video.')
  const end = r.end ?? p.durationSec
  if (end > p.durationSec + 0.05) throw new Error('Trim end is outside the video.')
  try {
    await withLut(r, (lut) => ffmpeg(['-n', '-ss', String(r.start), '-i', source.file, '-t', String(end - r.start),
      '-map', '0:v:0', ...(r.mute ? ['-an'] : ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k']),
      '-vf', videoEditFilters(r, lut), '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-map_metadata', '0', '-metadata:s:v:0', 'rotate=0', '-movflags', '+faststart', output], deps.ffmpeg))
    return Math.round((end - r.start) * 1000)
  } catch (e) {
    fs.rmSync(output, { force: true })
    throw e
  }
}
