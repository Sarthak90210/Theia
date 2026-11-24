import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { PermanentJobError } from '../src/jobs/queue.ts'
import { forkNodeChild, RenderHost } from '../src/thumbs/render-host.ts'
import { thumbPath } from '../src/thumbs/render.ts'
import { scratch } from './helpers.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const hosts: RenderHost[] = []
afterEach(() => { for (const h of hosts.splice(0)) h.close() })

function fake() {
  let spawned = 0
  const host = new RenderHost(() => { spawned++; return forkNodeChild(path.join(here, 'fixtures', 'fake-render-child.mjs')) })
  hosts.push(host)
  return { host, spawned: () => spawned }
}
const req = (file: string) => ({ file, mime: 'image/jpeg', sha256: 'x'.repeat(64), cacheRoot: '/nowhere' })

describe('thumbnails in their own process', () => {
  it('renders and reuses one process', async () => {
    const { host, spawned } = fake()
    expect(await host.render(req('a.jpg'))).toEqual({ width: 4, height: 3 })
    expect(await host.render(req('b.jpg'))).toEqual({ width: 4, height: 3 })
    expect(spawned()).toBe(1)
  })

  it('fails only the file that crashed it, for good, and carries on with a new process', async () => {
    const { host, spawned } = fake()
    const crash = host.render(req('crash.jpg'))
    await expect(crash).rejects.toBeInstanceOf(PermanentJobError)
    await expect(crash).rejects.toThrow(/crashed \(exit code 0xc0000409\)/)
    expect(await host.render(req('after.jpg'))).toEqual({ width: 4, height: 3 })
    expect(spawned()).toBe(2)
  })

  it('gives files caught in someone else’s crash another try, and blames a repeat offender', async () => {
    const { host } = fake()
    const bystander = host.render(req('slow.jpg'))
    const culprit = host.render(req('crash.jpg'))
    // Two in flight: no telling which did it, so neither fails for good yet.
    const [b, c] = await Promise.allSettled([bystander, culprit])
    expect(b.status === 'rejected' && !(b.reason instanceof PermanentJobError)).toBe(true)
    expect(c.status === 'rejected' && !(c.reason instanceof PermanentJobError)).toBe(true)
    // Retried: the bystander is fine; the culprit crashes again and is failed.
    expect(await host.render(req('slow.jpg'))).toEqual({ width: 4, height: 3 })
    await expect(host.render(req('crash.jpg'))).rejects.toBeInstanceOf(PermanentJobError)
  })

  it('renders real thumbnails through the real thumbnail process', async () => {
    const s = scratch()
    try {
      const file = path.join(s.dir, 'photo.jpg')
      fs.writeFileSync(file, await sharp({ create: { width: 64, height: 48, channels: 3, background: '#468' } }).jpeg().toBuffer())
      const host = new RenderHost(() => forkNodeChild(path.join(here, '..', 'src', 'thumbs', 'render-child.ts'), ['--import', 'tsx']))
      hosts.push(host)
      const sha = 'a'.repeat(64)
      expect(await host.render({ file, mime: 'image/jpeg', sha256: sha, cacheRoot: path.join(s.dir, 'cache') })).toEqual({ width: 64, height: 48 })
      for (const size of ['sm', 'lg', 'ph'] as const) expect(fs.existsSync(thumbPath(path.join(s.dir, 'cache'), sha, size))).toBe(true)
    } finally {
      s.cleanup()
    }
  }, 30_000)
})
