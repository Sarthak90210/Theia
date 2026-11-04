import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MapTiles } from '../app/main/map-tiles.ts'
import { scratch, type Scratch } from './helpers.ts'

let s: Scratch
beforeEach(() => { s = scratch() })
afterEach(() => s.cleanup())

describe('map privacy', () => {
  it('blocks network and cached tiles while disabled, and permits them when enabled again', async () => {
    let enabled = false
    const fetch = vi.fn(async () => new Response('tile'))
    const tiles = new MapTiles({ cacheRoot: s.dir, enabled: () => enabled, fetch, userAgent: 'Theia/test' })
    expect((await tiles.get('/1/0/0')).status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
    enabled = true
    expect(await (await tiles.get('/1/0/0')).text()).toBe('tile')
    expect(fetch).toHaveBeenCalledOnce()
    enabled = false
    expect((await tiles.get('/1/0/0')).status).toBe(403)
    expect(fetch).toHaveBeenCalledOnce()
    enabled = true
    expect(await (await tiles.get('/1/0/0')).text()).toBe('tile')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('cancels an in-flight tile without persisting its bytes', async () => {
    let enabled = true
    let finish!: (response: Response) => void
    let signal: AbortSignal | undefined
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined
      return new Promise<Response>(resolve => { finish = resolve })
    })
    const tiles = new MapTiles({ cacheRoot: s.dir, enabled: () => enabled, fetch, userAgent: 'Theia/test' })
    const pending = tiles.get('/1/0/0')
    enabled = false
    tiles.cancel()
    expect(signal?.aborted).toBe(true)
    finish(new Response('tile'))
    expect((await pending).status).toBe(403)
    expect(fs.existsSync(path.join(s.dir, '1', '0', '0.png'))).toBe(false)
  })

  it('serves an expired cached tile offline and rejects malformed paths', async () => {
    const file = path.join(s.dir, '1', '0', '0.png')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'old tile')
    fs.utimesSync(file, new Date(0), new Date(0))
    const fetch = vi.fn(async () => { throw new Error('offline') })
    const tiles = new MapTiles({ cacheRoot: s.dir, enabled: () => true, fetch, userAgent: 'Theia/test' })
    expect(await (await tiles.get('/1/0/0')).text()).toBe('old tile')
    for (const bad of ['/1/0/0/4', '/20/0/0', '/1/2/0', '/-1/0/0', '/1/a/0', '/1/../0']) {
      expect((await tiles.get(bad)).status).toBe(400)
    }
    expect(fetch).toHaveBeenCalledOnce()
  })
})
