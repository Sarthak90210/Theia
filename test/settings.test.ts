import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsStore } from '../app/main/settings.ts'
import { scratch, type Scratch } from './helpers.ts'

let s: Scratch
beforeEach(() => { s = scratch() })
afterEach(() => s.cleanup())

describe('app settings', () => {
  it('preserves a map privacy choice across restarts, independently of vault settings', () => {
    fs.writeFileSync(path.join(s.dir, 'gallery.json'), '{"vaults":["unchanged"]}')
    const store = new SettingsStore(s.dir)
    expect(store.get().mapsEnabled).toBe(true)
    store.set({ mapsEnabled: false })
    expect(new SettingsStore(s.dir).get().mapsEnabled).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(s.dir, 'gallery.json'), 'utf8'))).toEqual({ vaults: ['unchanged'] })
  })

  it('rejects invalid IPC settings without changing the saved choice', () => {
    const store = new SettingsStore(s.dir)
    store.set({ mapsEnabled: false })
    expect(() => store.set({ mapsEnabled: 'yes' } as never)).toThrow('Invalid settings')
    expect(() => store.set({ other: false } as never)).toThrow('Invalid settings')
    expect(() => store.set(null as never)).toThrow('Invalid settings')
    expect(new SettingsStore(s.dir).get().mapsEnabled).toBe(false)
  })

  it('keeps network maps off when an existing settings file is damaged', () => {
    fs.writeFileSync(path.join(s.dir, 'settings.json'), '{bad json')
    expect(new SettingsStore(s.dir).get().mapsEnabled).toBe(false)
    fs.writeFileSync(path.join(s.dir, 'settings.json'), '{"mapsEnabled":"yes"}')
    expect(new SettingsStore(s.dir).get().mapsEnabled).toBe(false)
  })
})
