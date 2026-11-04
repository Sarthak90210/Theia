import { spawn } from 'node:child_process'
import sharp from 'sharp'
import type { HeicPool } from '../thumbs/heic-pool.ts'
import { FfmpegMissing } from '../thumbs/video.ts'

/**
 * Level 3: does the file actually decode?
 *
 * Levels 0 to 2 check size, hash and container structure. None of them can
 * see a file whose boxes are all in the right place but whose compressed
 * payload is garbage. Only decoding it shows that.
 *
 * - Images decode fully, strict about truncation and corrupt data.
 * - Videos decode their first and last two seconds. A full decode of 913
 *   videos would take hours, and damage from a cut transfer sits at the end
 *   (the index) or shows up from the start (the codec setup).
 */

sharp.cache(false)

export type DecodeResult =
  | { status: 'ok' }
  | { status: 'damaged'; detail: string }
  /** No decoder for this format here. Not evidence of damage either way. */
  | { status: 'unchecked'; detail: string }

export interface DecodeDeps {
  heic: HeicPool
  ffmpeg?: string
}

export async function checkDecode(file: string, mime: string, deps: DecodeDeps): Promise<DecodeResult> {
  if (mime === 'image/heic' || mime === 'image/heif') return heic(file, deps.heic)
  if (mime.startsWith('video/')) return video(file, deps.ffmpeg ?? 'ffmpeg')
  if (mime === 'image/x-adobe-dng') {
    // sharp reads the embedded preview of a DNG, not the raw sensor data, so a
    // pass would prove nothing about the part that matters.
    return { status: 'unchecked', detail: 'no raw decoder for DNG' }
  }
  if (mime.startsWith('image/')) return image(file)
  return { status: 'unchecked', detail: `no decoder for ${mime}` }
}

async function heic(file: string, pool: HeicPool): Promise<DecodeResult> {
  try {
    await pool.decode(file)
    return { status: 'ok' }
  } catch (e) {
    return { status: 'damaged', detail: `HEIC: ${(e as Error).message}` }
  }
}

async function image(file: string): Promise<DecodeResult> {
  try {
    // failOn 'warning' turns libjpeg's "premature end of data" and libpng's
    // CRC complaints into errors. The thumbnail path tolerates them on purpose,
    // so a damaged photo still gets a thumbnail. This path must not.
    // Shrink-on-load keeps memory low and still walks every byte of the scan.
    await sharp(file, { failOn: 'warning', animated: true })
      .resize(256, 256, { fit: 'inside' })
      .raw()
      .toBuffer()
    return { status: 'ok' }
  } catch (e) {
    return { status: 'damaged', detail: (e as Error).message.split('\n')[0]! }
  }
}

async function video(file: string, ffmpeg: string): Promise<DecodeResult> {
  const head = await ffmpegErrors(ffmpeg, ['-t', '2', '-i', file])
  if (head) return { status: 'damaged', detail: `start: ${head}` }
  const tail = await ffmpegErrors(ffmpeg, ['-sseof', '-2', '-i', file])
  if (tail) return { status: 'damaged', detail: `end: ${tail}` }
  return { status: 'ok' }
}

/**
 * Lines ffmpeg prints at error level that are about writing the throwaway
 * output, not reading the file. Decoding to the null muxer still runs the
 * muxer's timestamp checks, and iPhone videos trip them at a seek point or the
 * last frame. Measured on the real library: 65 of 1,204 videos printed this
 * and nothing else, and every one plays.
 */
// "Last message repeated" is ffmpeg's log deduplication repeating the line
// above it, which is only ever the muxer warning here.
const MUXER_NOISE = /non monotonically increasing dts|non-monotonic DTS|Application provided invalid|Last message repeated \d+ times/i

export function decodeErrors(stderr: string): string | null {
  const real = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !MUXER_NOISE.test(l))
  return real[0] ?? null
}

/**
 * Decode to nowhere and return what ffmpeg complained about, or null if it
 * was silent. At `-v error` a clean decode prints nothing.
 */
function ffmpegErrors(ffmpeg: string, input: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostdin', '-v', 'error', ...input, '-map', '0:v:0?', '-map', '0:a:0?', '-f', 'null', '-']
    const child = spawn(ffmpeg, args, { windowsHide: true })
    const err: Buffer[] = []
    child.stderr.on('data', (b: Buffer) => err.push(b))
    child.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? new FfmpegMissing(ffmpeg) : e))
    child.on('close', (code) => {
      const text = Buffer.concat(err).toString()
      if (code !== 0) return resolve(decodeErrors(text) ?? `ffmpeg exited ${code}`)
      resolve(decodeErrors(text))
    })
  })
}
