import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, validSetting, type AppSettings } from '../shared/settings.ts'

/** Settings are separate from gallery.json so opening a vault cannot reset privacy choices. */
export class SettingsStore {
  private value: AppSettings
  private readonly file: string

  constructor(userData: string) {
    this.file = path.join(userData, 'settings.json')
    this.value = { ...DEFAULT_SETTINGS }
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const s = saved && typeof saved === 'object' ? (saved as Record<string, unknown>) : {}
      // Maps reach the network: only on when the file says so plainly.
      this.value.mapsEnabled = s.mapsEnabled === true
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
        if (key === 'mapsEnabled') continue
        if (key in s && validSetting(key, s[key])) (this.value as unknown as Record<string, unknown>)[key] = s[key]
      }
    } catch (e) {
      // A damaged existing file must not silently enable network access.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.value.mapsEnabled = false
    }
  }

  get(): AppSettings { return { ...this.value, customTheme: { ...this.value.customTheme } } }

  set(patch: Partial<AppSettings>): AppSettings {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.entries(patch).some(([key, value]) => !validSetting(key, value))) {
      throw new Error('Invalid settings.')
    }
    const next = { ...this.value, ...patch }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, this.file)
    this.value = next
    return this.get()
  }
}
