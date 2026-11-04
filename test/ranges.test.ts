import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRange, rangeResponse, SOURCE_CHUNK } from '../src/media/ranges.ts'

describe('byte ranges for video seeking', () => {
  it('parses the forms Chromium sends', () => {
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 })
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=1000-', 1000)).toBe('invalid')
    expect(parseRange('bytes=0-1,5-9', 1000)).toBeNull()
  })

  it('answers a range from a file with 206 and the right bytes', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rng-')), 'v.bin')
    fs.writeFileSync(f, Buffer.from(Array.from({ length: 256 }, (_, i) => i)))
    const r = await rangeResponse({ file: f }, 'bytes=10-19', { 'Content-Type': 'video/mp4' })
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 10-19/256')
    expect(r.headers.get('accept-ranges')).toBe('bytes')
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    const whole = await rangeResponse({ file: f }, null, {})
    expect(whole.status).toBe(200)
    expect((await whole.arrayBuffer()).byteLength).toBe(256)
    expect((await rangeResponse({ file: f }, 'bytes=300-', {})).status).toBe(416)
  })

  it('streams a range from a slow source, reading only as it is consumed', async () => {
    const size = SOURCE_CHUNK * 3 + 10
    const reads: [number, number][] = []
    const source = {
      size,
      read: async (start: number, length: number) => {
        reads.push([start, length])
        return Buffer.alloc(length, 7)
      },
    }
    const r = await rangeResponse({ source }, 'bytes=5-', {})
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe(`bytes 5-${size - 1}/${size}`)
    const reader = r.body!.getReader()
    const first = await reader.read()
    expect(first.value?.length).toBe(SOURCE_CHUNK)
    // A seek cancels the stream: nothing more is read from the phone.
    await reader.cancel()
    expect(reads.length).toBeLessThanOrEqual(2)
    expect(reads[0]).toEqual([5, SOURCE_CHUNK])
  })
})
