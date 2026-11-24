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
    // Off until chosen: a map sends the photo's area to OpenStreetMap.
    expect(store.get().mapsEnabled).toBe(false)
    store.set({ mapsEnabled: true })
    expect(new SettingsStore(s.dir).get().mapsEnabled).toBe(true)
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

  it('keeps indexing, pace and theme choices, and rejects anything else', () => {
    const store = new SettingsStore(s.dir)
    expect(store.get()).toMatchObject({ indexing: true, searchByMeaning: true, searchText: true, faceGrouping: true, indexingPace: 'balanced', theme: 'theia-dark', setupDone: false })
    store.set({ indexing: false, searchText: false, indexingPace: 'gentle', theme: 'dracula', setupDone: true })
    store.set({ customTheme: { background: '#101010', surface: '#202020', text: '#f0f0f0', accent: '#ff8800' } })
    const again = new SettingsStore(s.dir).get()
    expect(again).toMatchObject({ indexing: false, searchText: false, searchByMeaning: true, indexingPace: 'gentle', theme: 'dracula', setupDone: true })
    expect(again.customTheme.accent).toBe('#ff8800')
    expect(() => store.set({ theme: 'nope' } as never)).toThrow('Invalid settings')
    expect(() => store.set({ indexingPace: 'turbo' } as never)).toThrow('Invalid settings')
    expect(() => store.set({ customTheme: { background: 'red', surface: '#202020', text: '#f0f0f0', accent: '#ff8800' } } as never)).toThrow('Invalid settings')
    expect(() => store.set({ customTheme: { background: '#000000', surface: '#202020', text: '#f0f0f0', accent: '#ff8800', extra: '#000000' } } as never)).toThrow('Invalid settings')
  })

  it('ignores damaged values in the file and keeps the rest', () => {
    fs.writeFileSync(path.join(s.dir, 'settings.json'), JSON.stringify({ theme: 'no-such-theme', indexingPace: 'full', searchText: 'yes', mapsEnabled: true }))
    expect(new SettingsStore(s.dir).get()).toMatchObject({ theme: 'theia-dark', indexingPace: 'full', searchText: true, mapsEnabled: true })
  })
})
