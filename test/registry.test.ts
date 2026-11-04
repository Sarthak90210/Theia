import { describe, expect, it } from 'vitest'
import { DeviceRegistry } from '../src/device/registry.ts'

interface FakeSession {
  udid: string
  closed: boolean
}

function setup(opts: { present: string[]; failing?: Set<string> }) {
  const opened: string[] = []
  const reg = new DeviceRegistry<FakeSession>({
    open: async (udid) => {
      if (opts.failing?.has(udid)) throw new Error('PasswordProtected')
      opened.push(udid)
      return { udid, closed: false }
    },
    close: async (s) => {
      s.closed = true
    },
    nameOf: (s) => `Phone ${s.udid}`,
    list: async () => opts.present,
    listen: () => new Promise(() => {}),
    retryMs: 0,
    pollMs: 60_000,
  })
  return { reg, opened }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

describe('device registry', () => {
  it('opens every phone that is plugged in, each once', async () => {
    const { reg, opened } = setup({ present: ['A', 'B'] })
    reg.start()
    await settle()
    await reg.sync()
    await settle()
    expect(opened.sort()).toEqual(['A', 'B'])
    expect(reg.devices.map((d) => `${d.name}:${d.state}`).sort()).toEqual(['Phone A:ready', 'Phone B:ready'])
    await reg.stop()
  })

  it('drops a phone that was unplugged and closes its session', async () => {
    const env = { present: ['A', 'B'] }
    const { reg } = setup(env)
    reg.start()
    await settle()
    const b = reg.get('B')!.session!
    env.present = ['A']
    await reg.sync()
    expect(reg.devices.map((d) => d.udid)).toEqual(['A'])
    expect(b.closed).toBe(true)
    await reg.stop()
  })

  it('keeps a locked phone listed with the reason, and opens it once unlocked', async () => {
    const failing = new Set(['A'])
    const { reg } = setup({ present: ['A'], failing })
    reg.start()
    await settle()
    expect(reg.get('A')).toMatchObject({ state: 'problem', error: 'PasswordProtected' })

    failing.delete('A')
    await reg.sync()
    await settle()
    expect(reg.get('A')).toMatchObject({ state: 'ready', name: 'Phone A' })
    await reg.stop()
  })

  it('treats the Apple service being down as no phones', async () => {
    const reg = new DeviceRegistry<FakeSession>({
      open: async (udid) => ({ udid, closed: false }),
      close: async () => {},
      nameOf: () => 'x',
      list: async () => {
        throw new Error('ECONNREFUSED')
      },
      listen: () => new Promise(() => {}),
    })
    reg.start()
    await settle()
    expect(reg.devices).toEqual([])
    await reg.stop()
  })
})
