import { describe, expect, it } from 'vitest'
import { customBase, luminance, themeTokens, THEME_IDS, THEMES } from '../app/shared/themes.ts'

describe('themes', () => {
  it('gives every theme every colour the styles read, with readable text', () => {
    for (const id of THEME_IDS) {
      if (id === 'custom') continue
      const t = THEMES[id]
      const tokens = themeTokens(t)
      for (const name of ['--bg', '--surface', '--surface-2', '--text', '--muted', '--line', '--accent', '--accent-ink', '--accent-soft', '--glass', '--glass-border', '--shadow', '--focus', '--bad']) {
        expect(tokens[name], `${id} ${name}`).toBeTruthy()
      }
      // Text stands out from the background: a contrast ratio of 4.5 or more.
      const [a, b] = [luminance(t.text), luminance(t.bg)].sort((x, y) => y - x)
      expect((a! + 0.05) / (b! + 0.05), id).toBeGreaterThanOrEqual(4.5)
      expect(t.dark, id).toBe(luminance(t.bg) < 0.4)
    }
  })

  it('makes a light or dark custom theme from its background', () => {
    expect(customBase({ background: '#ffffff', surface: '#f0f0f0', text: '#111111', accent: '#0055cc' }).dark).toBe(false)
    const dark = customBase({ background: '#101014', surface: '#1c1c22', text: '#eeeeee', accent: '#ffcc00' })
    expect(dark.dark).toBe(true)
    // A light accent gets dark text on it.
    expect(dark.accentInk).toBe('#111111')
  })
})
