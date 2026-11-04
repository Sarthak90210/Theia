import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { convert, planFor, probe, storyboard, type Probe } from '../src/media/playback.ts'

const p = (container: string, v: string | null, a: string | null, pixFmt = 'yuv420p'): Probe => ({
  container,
  video: v ? { codec: v, tag: null, pixFmt } : null,
  audio: a ? { codec: a } : null,
  durationSec: 10,
})

describe('what a video needs before the window can play it', () => {
  it('plays iPhone and web formats as they are', () => {
    expect(planFor(p('mov,mp4,m4a,3gp,3g2,mj2', 'hevc', 'aac'))).toBe('direct')
    expect(planFor(p('mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'aac'))).toBe('direct')
    expect(planFor(p('matroska,webm', 'vp9', 'opus'))).toBe('direct')
    expect(planFor(p('matroska,webm', 'av1', null))).toBe('direct')
  })
  it('copies good streams out of a container the window cannot read', () => {
    expect(planFor(p('avi', 'h264', 'mp3'))).toBe('remux')
    expect(planFor(p('mpegts', 'h264', 'aac'))).toBe('remux')
    expect(planFor(p('flv', 'h264', 'aac'))).toBe('remux')
  })
  it('re-encodes only the audio when only the audio is the problem', () => {
    expect(planFor(p('matroska,webm', 'h264', 'ac3'))).toBe('audio')
    expect(planFor(p('mov,mp4,m4a,3gp,3g2,mj2', 'hevc', 'pcm_s24le'))).toBe('audio')
  })
  it('transcodes what Chromium has no decoder for', () => {
    expect(planFor(p('mov,mp4,m4a,3gp,3g2,mj2', 'prores', 'pcm_s16le'))).toBe('transcode')
    expect(planFor(p('avi', 'mpeg4', 'mp3'))).toBe('transcode')
    expect(planFor(p('asf', 'wmv3', 'wmav2'))).toBe('transcode')
    expect(planFor(p('mpeg', 'mpeg2video', 'mp2'))).toBe('transcode')
    expect(planFor(p('mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'aac', 'yuv420p10le'))).toBe('transcode')
  })
})

// With ffmpeg on PATH: a real AVI with MPEG-4 Part 2 (DivX-style) video and
// MP3 audio, which Chromium cannot play, made playable.
let hasFfmpeg = true
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
} catch {
  hasFfmpeg = false
}

describe.skipIf(!hasFfmpeg)('converting with ffmpeg', () => {
  it('turns an AVI into an MP4 the window plays, and makes scrub previews', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-'))
    const avi = path.join(dir, 'clip.avi')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=duration=4', '-c:v', 'mpeg4', '-c:a', 'libmp3lame', avi])
    const before = await probe(avi)
    expect(planFor(before)).toBe('transcode')
    const progress: number[] = []
    const out = await convert('transcode', avi, path.join(dir, 'clip.mp4'), before.durationSec, (f) => progress.push(f))
    const after = await probe(out)
    expect(planFor(after)).toBe('direct')
    expect(after.video?.codec).toBe('h264')
    expect(progress.at(-1)).toBe(1)

    const sb = await storyboard(out, path.join(dir, 'sb.jpg'), after.durationSec!)
    expect(sb.count).toBe(2)
    expect(sb.width).toBe(160)
    expect(fs.existsSync(sb.file)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 60_000)
})
