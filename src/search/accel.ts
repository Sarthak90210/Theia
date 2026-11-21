import fs from 'node:fs'
import path from 'node:path'
import type { Device, DeviceChoice } from './embedder.ts'

/**
 * Which models run on the graphics card on this computer, remembered between
 * launches in accel.json, so the GPU-against-CPU check (a few seconds, and the
 * model loaded twice) runs once, not every start.
 *
 * Checked again when a model changes, and every two weeks, so a new graphics
 * driver gets another chance after a failure.
 */

const RECHECK_MS = 14 * 24 * 3600 * 1000

interface Saved {
  key: string
  device: 'gpu' | 'cpu'
  reason: string | null
  at: number
}

export class AccelChoices {
  private readonly file: string
  private saved: Record<string, Saved> = {}

  constructor(userData: string) {
    this.file = path.join(userData, 'accel.json')
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (raw && typeof raw === 'object') this.saved = raw as Record<string, Saved>
    } catch {
      // None yet, or unreadable: every model checks again.
    }
  }

  /** 'gpu' or 'cpu' when known for this model, else 'auto' to check. */
  device(model: string, key: string): Device {
    const s = this.saved[model]
    if (!s || s.key !== key || Date.now() - s.at > RECHECK_MS) return 'auto'
    return s.device
  }

  remember(model: string, key: string, choice: DeviceChoice): void {
    this.saved[model] = { key, device: choice.device, reason: choice.reason, at: Date.now() }
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.saved, null, 2))
    } catch (e) {
      console.warn('could not save the graphics card choice:', (e as Error).message)
    }
  }
}
