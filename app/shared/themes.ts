/**
 * Colour themes. Each is a handful of base colours; every other token the
 * window's styles use (lines, glass, soft highlights) is worked out from
 * them, so a theme, or a custom one, only has to choose these.
 *
 * Several follow the palettes of well-known editor themes, so the app can
 * match the editor someone already looks at all day.
 */

export const THEME_IDS = [
  'theia-dark', 'theia-light', 'dark-modern', 'light-modern', 'monokai', 'dracula', 'one-dark',
  'solarized-dark', 'solarized-light', 'github-dark', 'github-light', 'nord', 'high-contrast', 'custom',
] as const

export type ThemeId = (typeof THEME_IDS)[number]

export interface ThemeBase {
  name: string
  dark: boolean
  /** Window background. */
  bg: string
  /** Panels, cards, menus. */
  surface: string
  /** Inputs, tabs, tiles waiting for a picture. */
  surface2: string
  text: string
  muted: string
  /** Buttons that matter and the selection. */
  accent: string
  /** Text on the accent. */
  accentInk: string
  /** How strong lines and soft fills are, as a share of the text colour. */
  lineStrength?: number
  ok?: string
  warn?: string
  bad?: string
}

export const THEMES: Record<Exclude<ThemeId, 'custom'>, ThemeBase> = {
  'theia-dark': { name: 'Theia Dark', dark: true, bg: '#18181a', surface: '#28282c', surface2: '#303034', text: '#f1f1f3', muted: '#aaaab2', accent: '#ededf0', accentInk: '#242428' },
  'theia-light': { name: 'Theia Light', dark: false, bg: '#f5f5f7', surface: '#ffffff', surface2: '#e9e9ee', text: '#1d1d1f', muted: '#6e6e73', accent: '#1d1d1f', accentInk: '#ffffff' },
  'dark-modern': { name: 'Dark Modern', dark: true, bg: '#1f1f1f', surface: '#181818', surface2: '#2b2b2b', text: '#cccccc', muted: '#9d9d9d', accent: '#0078d4', accentInk: '#ffffff' },
  'light-modern': { name: 'Light Modern', dark: false, bg: '#f8f8f8', surface: '#ffffff', surface2: '#e5e5e5', text: '#3b3b3b', muted: '#767676', accent: '#005fb8', accentInk: '#ffffff' },
  monokai: { name: 'Monokai', dark: true, bg: '#272822', surface: '#1e1f1c', surface2: '#3e3d32', text: '#f8f8f2', muted: '#a59f85', accent: '#a6e22e', accentInk: '#272822', bad: '#f92672', warn: '#e6db74' },
  dracula: { name: 'Dracula', dark: true, bg: '#282a36', surface: '#21222c', surface2: '#343746', text: '#f8f8f2', muted: '#a3a8c3', accent: '#bd93f9', accentInk: '#282a36', bad: '#ff5555', ok: '#50fa7b', warn: '#f1fa8c' },
  'one-dark': { name: 'One Dark', dark: true, bg: '#282c34', surface: '#21252b', surface2: '#2c313a', text: '#abb2bf', muted: '#7f848e', accent: '#61afef', accentInk: '#1e2127', bad: '#e06c75', ok: '#98c379', warn: '#e5c07b' },
  'solarized-dark': { name: 'Solarized Dark', dark: true, bg: '#002b36', surface: '#073642', surface2: '#0b4a58', text: '#eee8d5', muted: '#93a1a1', accent: '#268bd2', accentInk: '#fdf6e3', bad: '#dc322f', ok: '#859900', warn: '#b58900' },
  'solarized-light': { name: 'Solarized Light', dark: false, bg: '#fdf6e3', surface: '#eee8d5', surface2: '#e4dcc4', text: '#586e75', muted: '#839496', accent: '#268bd2', accentInk: '#fdf6e3', bad: '#dc322f', ok: '#859900', warn: '#b58900' },
  'github-dark': { name: 'GitHub Dark', dark: true, bg: '#0d1117', surface: '#161b22', surface2: '#21262d', text: '#e6edf3', muted: '#8d96a0', accent: '#2f81f7', accentInk: '#ffffff', bad: '#f85149', ok: '#3fb950', warn: '#d29922' },
  'github-light': { name: 'GitHub Light', dark: false, bg: '#ffffff', surface: '#f6f8fa', surface2: '#eaeef2', text: '#1f2328', muted: '#656d76', accent: '#0969da', accentInk: '#ffffff', bad: '#cf222e', ok: '#1a7f37', warn: '#9a6700' },
  nord: { name: 'Nord', dark: true, bg: '#2e3440', surface: '#3b4252', surface2: '#434c5e', text: '#eceff4', muted: '#a7b1c2', accent: '#88c0d0', accentInk: '#2e3440', bad: '#bf616a', ok: '#a3be8c', warn: '#ebcb8b' },
  'high-contrast': { name: 'High Contrast', dark: true, bg: '#000000', surface: '#0a0a0a', surface2: '#1c1c1c', text: '#ffffff', muted: '#e6e6e6', accent: '#f38518', accentInk: '#000000', lineStrength: 0.45 },
}

/** A custom theme from its four chosen colours. */
export function customBase(c: { background: string; surface: string; text: string; accent: string }): ThemeBase {
  const dark = luminance(c.background) < 0.4
  return {
    name: 'Custom',
    dark,
    bg: c.background,
    surface: c.surface,
    surface2: mix(c.surface, c.text, 0.08),
    text: c.text,
    muted: mix(c.text, c.background, 0.38),
    accent: c.accent,
    accentInk: luminance(c.accent) > 0.5 ? '#111111' : '#ffffff',
  }
}

/** The window's own background and caption-button colour, for the main process. */
export function windowColours(theme: ThemeId, custom: { background: string; surface: string; text: string; accent: string }): { bg: string; text: string } {
  const base = theme === 'custom' ? customBase(custom) : (THEMES[theme] ?? THEMES['theia-dark'])
  return { bg: base.bg, text: base.text }
}

/** Every CSS custom property the window's styles read, for a theme. */
export function themeTokens(t: ThemeBase): Record<string, string> {
  const line = t.lineStrength ?? (t.dark ? 0.11 : 0.13)
  return {
    '--bg': t.bg,
    '--side': t.surface,
    '--surface': t.surface,
    '--surface-2': t.surface2,
    '--tile': t.surface2,
    '--text': t.text,
    '--muted': t.muted,
    '--line': alpha(t.text, line),
    '--accent': t.accent,
    '--accent-soft': alpha(t.accent === t.text ? t.text : t.accent, t.accent === t.text ? 0.1 : 0.18),
    '--accent-ink': t.accentInk,
    '--glass': alpha(t.surface, t.dark ? 0.82 : 0.86),
    '--glass-strong': alpha(t.surface, 0.97),
    '--glass-border': alpha(t.text, line),
    '--glass-edge': `inset 0 1px 0 ${alpha(t.dark ? '#ffffff' : '#ffffff', t.dark ? 0.06 : 0.6)}`,
    '--shadow': t.dark ? '0 16px 48px rgb(0 0 0 / 24%), 0 2px 8px rgb(0 0 0 / 12%)' : '0 16px 48px rgb(0 0 0 / 10%), 0 2px 8px rgb(0 0 0 / 6%)',
    '--focus': t.accent,
    '--ok': t.ok ?? (t.dark ? '#a5b9ac' : '#2f7a4a'),
    '--warn': t.warn ?? (t.dark ? '#d6b879' : '#8a6200'),
    '--bad': t.bad ?? (t.dark ? '#f08c86' : '#c0362c'),
    '--warn-soft': mix(t.surface, t.warn ?? (t.dark ? '#d6b879' : '#8a6200'), 0.14),
    '--hover': alpha(t.text, t.dark ? 0.08 : 0.06),
  }
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function hex([r, g, b]: number[]): string {
  return '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x!))).toString(16).padStart(2, '0')).join('')
}

function alpha(c: string, a: number): string {
  const [r, g, b] = rgb(c)
  return `rgb(${r} ${g} ${b} / ${Math.round(a * 1000) / 10}%)`
}

function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b)
  return hex(x.map((v, i) => v + (y[i]! - v) * t))
}

/** Relative luminance, 0 (black) to 1 (white). */
export function luminance(c: string): number {
  const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  const [r, g, b] = rgb(c)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
