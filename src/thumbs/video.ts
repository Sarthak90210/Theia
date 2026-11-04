import { spawn } from 'node:child_process'

/**
 * One frame of a video as PNG bytes, by way of ffmpeg.
 *
 * Takes the frame half a second in, because the very first frame of a phone
 * video is often black or still mid-exposure. A clip shorter than that gets
 * its first frame instead. ffmpeg applies the rotation tag by default, so a
 * portrait video comes out portrait.
 *
 * ffmpeg is found on PATH for now. Packaging (phase 4) has to ship one.
 */

export class FfmpegMissing extends Error {
  constructor(bin: string) {
    super(`ffmpeg not found (looked for "${bin}"). Install it or set the path.`)
    this.name = 'FfmpegMissing'
  }
}

export async function videoFrame(file: string, ffmpeg = 'ffmpeg'): Promise<Buffer> {
  const at = await grab(file, ffmpeg, 0.5)
  if (at.length > 0) return at
  const first = await grab(file, ffmpeg, 0)
  if (first.length > 0) return first
  throw new Error('ffmpeg produced no frame')
}

function grab(file: string, ffmpeg: string, seconds: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      // Seeking before the input is fast and lands on the nearest keyframe,
      // which is plenty accurate for a thumbnail.
      '-ss', String(seconds),
      '-i', file,
      '-frames:v', '1',
      '-f', 'image2pipe',
      '-vcodec', 'png',
      '-',
    ]
    const child = spawn(ffmpeg, args, { windowsHide: true })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.stderr.on('data', (b: Buffer) => err.push(b))
    child.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? new FfmpegMissing(ffmpeg) : e))
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().trim().slice(0, 300)}`))
    })
  })
}
