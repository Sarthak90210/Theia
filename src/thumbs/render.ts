import fs from 'node:fs'
import path from 'node:path'
import sharp, { type Sharp } from 'sharp'
import type { HeicPool } from './heic-pool.ts'
import { heicProfile, tagWebp, IMAGE_CACHE_VERSION } from './colour.ts'
import { videoFrame } from './video.ts'
import { PermanentJobError } from '../jobs/queue.ts'

/**
 * Thumbnails, three per asset, keyed by the hash of the file they came from.
 *
 * - sm: the grid. 800 px on the long edge keeps cropped portrait tiles sharp.
 * - lg: the detail view before the full image has loaded. 1600 px.
 * - ph: a 32 px blurred placeholder, so a fast scroll shows shapes and colour
 *   instead of grey boxes. Immich makes the same three.
 *
 * Content-addressed, so the same bytes never get rendered twice, and a cache
 * entry can be checked with nothing but the file's hash. Each one is written
 * to a temp name and renamed, so a crash never leaves half a thumbnail at a
 * real path.
 */

// libvips caches open files by default. On Windows an open handle blocks
// moving or deleting the file, which would lock originals in the library for
// as long as the app runs. Each file is decoded once per job, so the cache
// buys nothing here.
sharp.cache(false)

export const SIZES = {
  sm: { edge: 800, quality: 88 },
  lg: { edge: 1600, quality: 88 },
  ph: { edge: 32, quality: 50 },
} as const

export type ThumbSize = keyof typeof SIZES

export function thumbPath(cacheRoot: string, sha256: string, size: ThumbSize): string {
  return path.join(cacheRoot, 'thumbs', IMAGE_CACHE_VERSION, sha256.slice(0, 2), `${sha256}-${size}.webp`)
}

export function hasThumbs(cacheRoot: string, sha256: string): boolean {
  return (Object.keys(SIZES) as ThumbSize[]).every((s) => fs.existsSync(thumbPath(cacheRoot, sha256, s)))
}

export interface RenderDeps {
  heic: Pick<HeicPool, 'decode'>
  ffmpeg?: string
}

export interface RenderResult {
  /** Of the source, after orientation is applied. */
  width: number
  height: number
}

/** Decode `file` and write all three sizes. */
export async function renderThumbnails(
  file: string,
  mime: string,
  sha256: string,
  cacheRoot: string,
  deps: RenderDeps,
): Promise<RenderResult> {
  const icc = mime === 'image/heic' || mime === 'image/heif' ? heicProfile(file) : null
  const base = await source(file, mime, deps)
  const meta = await base.clone().metadata()

  // Shrink the full image once, to the largest size, and derive the smaller
  // two from that. Resizing a 12 MP source three times was half the cost of a
  // thumbnail; measured at 4.1/s that way against 7.8/s for decoding alone.
  const lg = SIZES.lg
  const { data, info } = await base
    .resize(lg.edge, lg.edge, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const mid = () => sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })

  for (const [size, spec] of Object.entries(SIZES) as [ThumbSize, (typeof SIZES)[ThumbSize]][]) {
    let img = mid()
    if (size !== 'lg') img = img.resize(spec.edge, spec.edge, { fit: 'inside', withoutEnlargement: true })
    if (size === 'ph') img = img.blur(1.2)
    const bytes = await img.webp({ quality: spec.quality }).toBuffer()
    writeAtomic(thumbPath(cacheRoot, sha256, size), tagWebp(bytes, icc))
  }

  // autoOrient swaps width and height for rotated sources, so report what a
  // viewer sees.
  return { width: meta.autoOrient?.width ?? meta.width ?? 0, height: meta.autoOrient?.height ?? meta.height ?? 0 }
}

async function source(file: string, mime: string, deps: RenderDeps): Promise<Sharp> {
  if (mime === 'image/heic' || mime === 'image/heif') {
    const img = await deps.heic.decode(file)
    // libheif has already applied the container's rotation and mirroring.
    return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
  }
  if (mime.startsWith('video/')) {
    return sharp(await videoFrame(file, deps.ffmpeg))
  }
  if (mime.startsWith('image/')) {
    // .rotate() with no argument applies the EXIF orientation.
    const img = sharp(file, { failOn: 'none' }).rotate()
    try {
      await img.clone().metadata()
    } catch (e) {
      throw new PermanentJobError(`cannot read ${mime}: ${(e as Error).message}`)
    }
    return img
  }
  throw new PermanentJobError(`no thumbnail renderer for ${mime}`)
}

function writeAtomic(file: string, bytes: Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Two assets can share a source hash and render at the same moment.
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, bytes)
  fs.renameSync(tmp, file)
}
