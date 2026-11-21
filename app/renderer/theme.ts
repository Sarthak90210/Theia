import type { AppSettings } from '../shared/settings.ts'
import { customBase, themeTokens, THEMES } from '../shared/themes.ts'

/** Windows 11's acrylic is behind the window (the main process said so in the page's address). */
const ACRYLIC = new URLSearchParams(location.search).get('acrylic') === '1'

/** Put the chosen theme's colours on the page. The stylesheets read them as CSS custom properties. */

export function applyTheme(settings: Pick<AppSettings, 'theme' | 'customTheme' | 'liquidGlass'>): void {
  const base = settings.theme === 'custom' ? customBase(settings.customTheme) : (THEMES[settings.theme] ?? THEMES['theia-dark'])
  const root = document.documentElement
  for (const [name, value] of Object.entries(themeTokens(base))) root.style.setProperty(name, value)
  root.style.colorScheme = base.dark ? 'dark' : 'light'
  root.dataset.theme = base.dark ? 'dark' : 'light'
  root.dataset.acrylic = ACRYLIC && settings.liquidGlass ? 'on' : 'off'
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', base.dark ? 'dark' : 'light')
}
