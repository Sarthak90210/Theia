import fs from 'node:fs'
import { Readable } from 'node:stream'

/**
 * HTTP byte ranges for the media scheme, so <video> can seek.
 *
 * Electron's protocol.handle does not answer Range requests by itself, and
 * without a 206 answer Chromium treats a video as unseekable: the scrub bar
 * does nothing. Measured: a 133 s video reported no seekable range and a seek
 * to 10 s stayed at 0.
 */

export type Range = { start: number; end: number }

/**
 * `bytes=500-999`, `bytes=500-`, `bytes=-500`. Null for no header or a form
 * we don't serve (several ranges): answer with the whole file. 'invalid' for
 * a range outside the file: answer 416.
 */
export function parseRange(header: string | null, size: number): Range | null | 'invalid' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, a, b] = m
  if (a === '' && b === '') return 'invalid'
  let start: number
  let end: number
  if (a === '') {
    // The last N bytes.
    start = Math.max(0, size - Number(b))
    end = size - 1
  } else {
    start = Number(a)
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  }
  if (start >= size || start > end) return 'invalid'
  return { start, end }
}

/** Bytes from somewhere other than a local file: the phone, over AFC. */
export interface ByteSource {
  size: number
  read(start: number, length: number): Promise<Buffer>
}

/**
 * How much is read from a slow source per pull. The answer to a range is a
 * stream that reads only as Chromium consumes it, so a phone video starts
 * after the first chunk, and a seek (which cancels the stream) stops reading.
 * A shorter 206 than asked for does not work: measured, Chromium's media
 * loader takes the first chunk and never asks for the rest.
 */
export const SOURCE_CHUNK = 1024 * 1024

export async function rangeResponse(
  body: { file: string } | { source: ByteSource },
  rangeHeader: string | null,
  headers: Record<string, string>,
): Promise<Response> {
  const size = 'file' in body ? fs.statSync(body.file).size : body.source.size
  const range = parseRange(rangeHeader, size)
  const base = { ...headers, 'Accept-Ranges': 'bytes' }
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
  }
  const { start, end } = range ?? { start: 0, end: size - 1 }
  const status = range ? 206 : 200
  const out: Record<string, string> = { ...base, 'Content-Length': String(size === 0 ? 0 : end - start + 1) }
  if (status === 206) out['Content-Range'] = `bytes ${start}-${end}/${size}`
  if (size === 0) return new Response(null, { status: 200, headers: out })
  const stream =
    'file' in body
      ? (Readable.toWeb(fs.createReadStream(body.file, { start, end, highWaterMark: 1024 * 1024 })) as ReadableStream)
      : pulled(body.source, start, end)
  return new Response(stream, { status, headers: out })
}

function pulled(source: ByteSource, start: number, end: number): ReadableStream<Uint8Array> {
  let pos = start
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pos > end) return controller.close()
      const chunk = await source.read(pos, Math.min(SOURCE_CHUNK, end - pos + 1))
      if (!chunk.length) return controller.close()
      pos += chunk.length
      controller.enqueue(new Uint8Array(chunk))
    },
  })
}
