import { spawn } from 'node:child_process'
import type { HeicPool } from '../thumbs/heic-pool.ts'
import { checkDecode, decodeErrors, type DecodeResult } from './decode.ts'
import { parsePlist } from '../protocol/plist-io.ts'
import fs from 'node:fs'

/** Deletion requires a full video decode, rather than just checking its ends. */
export async function checkCleanupDecode(file: string, mime: string, heic: HeicPool, signal?: AbortSignal): Promise<DecodeResult> {
  if (signal?.aborted) throw new Error('Stopped before deleting from iPhone.')
  if (mime === 'application/xml' || file.toLowerCase().endsWith('.aae')) {
    try {
      const parsed = parsePlist(await fs.promises.readFile(file))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an Apple adjustment dictionary')
      return { status: 'ok' }
    } catch (e) { return { status: 'damaged', detail: `Edit recipe: ${(e as Error).message}` } }
  }
  if (!mime.startsWith('video/')) return checkDecode(file, mime, { heic })
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode',
      '-i', file, '-map', '0:v:0?', '-map', '0:a:0?', '-f', 'null', '-'], { windowsHide: true })
    let errors = ''
    child.stderr.on('data', b => { errors = (errors + b.toString()).slice(-65536) })
    const cancel = () => child.kill()
    signal?.addEventListener('abort', cancel, { once: true })
    child.on('error', reject)
    child.on('close', code => {
      signal?.removeEventListener('abort', cancel)
      if (signal?.aborted) return reject(new Error('Stopped before deleting from iPhone.'))
      const detail = decodeErrors(errors)
      resolve(code === 0 && !detail ? { status: 'ok' } : { status: 'damaged', detail: detail ?? `Video decode exited ${code}` })
    })
  })
}
