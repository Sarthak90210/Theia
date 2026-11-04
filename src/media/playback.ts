import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Making any video playable in the window.
 *
 * Chromium plays MP4/MOV, WebM, Ogg and Matroska containers holding H.264,
 * HEVC (with hardware decoding), VP8, VP9 or AV1 video and AAC, MP3, Opus,
 * Vorbis, FLAC or plain PCM audio (chromium.org/audio-video). Everything else
 * (ProRes, MPEG-2, DivX in AVI, WMV, AC-3 audio and so on) goes through
 * ffmpeg once, as cheaply as the file allows, into a cached MP4:
 *
 * - remux: the streams are fine, the container is not. Copy, seconds.
 * - audio: the video is fine, the audio is not. Copy video, encode AAC.
 * - transcode: encode H.264 and AAC. Slow for long files, so it reports progress.
 */

export interface Probe {
  container: string
  video: { codec: string; tag: string | null; pixFmt: string | null } | null
  audio: { codec: string } | null
  durationSec: number | null
}

export type Plan = 'direct' | 'remux' | 'audio' | 'transcode'

const CONTAINERS = ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'webm', 'matroska', 'ogg']
const VIDEO = ['h264', 'hevc', 'vp8', 'vp9', 'av1']
const AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_f32le', 'pcm_u8', 'pcm_mulaw']

export function planFor(p: Probe): Plan {
  // ffprobe names several at once: "mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm".
  const containerOk = p.container.split(',').some((c) => CONTAINERS.includes(c))
  // 10-bit H.264 is valid but Chromium won't decode it.
  const videoOk = !p.video || (VIDEO.includes(p.video.codec) && !(p.video.codec === 'h264' && /10|12/.test(p.video.pixFmt ?? '')))
  const audioOk = !p.audio || AUDIO.includes(p.audio.codec)
  if (videoOk && audioOk) return containerOk ? 'direct' : 'remux'
  if (videoOk) return 'audio'
  return 'transcode'
}

export async function probe(file: string, ffprobe = 'ffprobe'): Promise<Probe> {
  const { stdout } = await run(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,codec_tag_string,pix_fmt', '-of', 'json', file],
    { maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  )
  const j = JSON.parse(stdout) as {
    format?: { format_name?: string; duration?: string }
    streams?: { codec_type?: string; codec_name?: string; codec_tag_string?: string; pix_fmt?: string }[]
  }
  const v = j.streams?.find((s) => s.codec_type === 'video' && s.codec_name !== 'mjpeg' && s.codec_name !== 'png')
  const a = j.streams?.find((s) => s.codec_type === 'audio')
  const d = Number(j.format?.duration)
  return {
    container: j.format?.format_name ?? '',
    video: v ? { codec: v.codec_name ?? '', tag: v.codec_tag_string ?? null, pixFmt: v.pix_fmt ?? null } : null,
    audio: a ? { codec: a.codec_name ?? '' } : null,
    durationSec: Number.isFinite(d) ? d : null,
  }
}

export function ffmpegArgs(plan: Exclude<Plan, 'direct'>, input: string, output: string): string[] {
  const common = ['-hide_banner', '-y', '-i', input, '-map', '0:v:0?', '-map', '0:a:0?', '-map_metadata', '0']
  const tail = ['-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output]
  if (plan === 'remux') return [...common, '-c', 'copy', ...tail]
  if (plan === 'audio') return [...common, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', ...tail]
  return [
    ...common,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    ...tail,
  ]
}

/**
 * Run the plan into `output`, once, however many callers ask. Progress is
 * the fraction of the duration written so far.
 */
const running = new Map<string, Promise<string>>()

export function convert(
  plan: Exclude<Plan, 'direct'>,
  input: string,
  output: string,
  durationSec: number | null,
  onProgress: (fraction: number) => void,
  ffmpeg = 'ffmpeg',
): Promise<string> {
  if (fs.existsSync(output)) return Promise.resolve(output)
  let p = running.get(output)
  if (p) return p
  p = new Promise<string>((resolve, reject) => {
    fs.mkdirSync(path.dirname(output), { recursive: true })
    const tmp = `${output}.part.mp4`
    const child = spawn(ffmpeg, ffmpegArgs(plan, input, tmp), { windowsHide: true })
    let err = ''
    child.stderr.on('data', (b: Buffer) => (err = (err + b.toString()).slice(-2000)))
    child.stdout.on('data', (b: Buffer) => {
      const m = /out_time_us=(\d+)/.exec(b.toString())
      if (m && durationSec) onProgress(Math.min(1, Number(m[1]) / 1e6 / durationSec))
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        fs.renameSync(tmp, output)
        onProgress(1)
        resolve(output)
      } else {
        fs.rmSync(tmp, { force: true })
        reject(new Error(`ffmpeg could not convert this video: ${err.trim().split('\n').pop() ?? code}`))
      }
    })
  }).finally(() => running.delete(output))
  running.set(output, p)
  return p
}

export interface Storyboard {
  /** One image holding every frame in a grid, left to right, top to bottom. */
  file: string
  cols: number
  rows: number
  count: number
  /** Seconds between frames. */
  interval: number
  width: number
  height: number
}

const FRAME_W = 160

/**
 * Small frames along the whole video in one image, for the scrub bar's
 * preview. Keyframes only, so even a long video takes a second or two.
 */
export async function storyboard(input: string, output: string, durationSec: number, ffmpeg = 'ffmpeg'): Promise<Storyboard> {
  const count = Math.max(1, Math.min(100, Math.round(durationSec / 2)))
  const cols = Math.min(10, count)
  const rows = Math.ceil(count / cols)
  const interval = durationSec / count
  const meta = `${output}.json`
  if (fs.existsSync(output) && fs.existsSync(meta)) return JSON.parse(fs.readFileSync(meta, 'utf8')) as Storyboard
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation', '-of', 'json', input],
    { windowsHide: true },
  )
  const st = (JSON.parse(stdout) as { streams?: { width?: number; height?: number; side_data_list?: { rotation?: number }[] }[] }).streams?.[0]
  const turned = Math.abs(st?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0) === 90
  const [sw, sh] = turned ? [st?.height ?? 16, st?.width ?? 9] : [st?.width ?? 16, st?.height ?? 9]
  const height = Math.round((FRAME_W * sh) / sw / 2) * 2
  const tmp = `${output}.part.jpg`
  // Keyframes only makes a long video fast. A short one may have just one
  // keyframe, so decode it all.
  const skip = durationSec > 120 ? ['-skip_frame', 'nokey'] : []
  await run(
    ffmpeg,
    [
      '-hide_banner', '-y', ...skip, '-i', input,
      '-vf', `fps=1/${interval.toFixed(3)},scale=${FRAME_W}:${height},tile=${cols}x${rows},format=yuvj420p`,
      '-frames:v', '1', '-q:v', '5', tmp,
    ],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  )
  if (!fs.existsSync(tmp)) throw new Error('ffmpeg made no preview frames')
  fs.renameSync(tmp, output)
  const sb: Storyboard = { file: output, cols, rows, count, interval, width: FRAME_W, height }
  fs.writeFileSync(meta, JSON.stringify(sb))
  return sb
}
