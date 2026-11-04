import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/settings.ts'

/** Settings are separate from gallery.json so opening a vault cannot reset privacy choices. */
export class SettingsStore {
  private value: AppSettings
  private readonly file: string

  constructor(userData: string) {
    this.file = path.join(userData, 'settings.json')
    this.value = { ...DEFAULT_SETTINGS }
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.value.mapsEnabled = !!(saved && typeof saved === 'object' && 'mapsEnabled' in saved && saved.mapsEnabled === true)
    } catch (e) {
      // A damaged existing file must not silently enable network access.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.value.mapsEnabled = false
    }
  }

  get(): AppSettings { return { ...this.value } }

  set(patch: Partial<AppSettings>): AppSettings {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.keys(patch).some(key => key !== 'mapsEnabled') ||
        ('mapsEnabled' in patch && typeof patch.mapsEnabled !== 'boolean')) {
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
