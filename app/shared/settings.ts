import { THEME_IDS, type ThemeId } from './themes.ts'

/** How hard indexing works: how long it rests after each photo, relative to the time the photo took. */
export type IndexingPace = 'gentle' | 'balanced' | 'full'

export interface CustomTheme {
  /** #rrggbb */
  background: string
  surface: string
  text: string
  accent: string
}

export interface AppSettings {
  /** Permit OpenStreetMap tiles in the info panel. Coordinates stay local when off. */
  mapsEnabled: boolean
  /** Reading photos in the background at all. Off: nothing below runs; thumbnails still do. */
  indexing: boolean
  /** Search by what photos show (EmbeddingGemma). */
  searchByMeaning: boolean
  /** Search by the words written in photos (OCR). */
  searchText: boolean
  /**
   * Find faces in photos and group them into people to name. On this computer
   * only; switching it off erases faces, groups and names from open vaults.
   */
  faceGrouping: boolean
  /**
   * Once everything has been read, read every photo again more closely, at
   * full resolution: smaller and turned faces, small print, things in a corner
   * of the picture. Several times slower; nothing is lost by switching it off.
   */
  deepIndexing: boolean
  indexingPace: IndexingPace
  theme: ThemeId
  customTheme: CustomTheme
  /**
   * Liquid Glass: bars and controls bend the photos behind them, and on
   * Windows 11 the window lets the desktop show through. Off: plain frosted
   * panels, lighter on older graphics.
   */
  liquidGlass: boolean
  /** The first-launch choices were made. Until then the window asks for them. */
  setupDone: boolean
}

export const DEFAULT_CUSTOM_THEME: Readonly<CustomTheme> = { background: '#1b1d23', surface: '#262a33', text: '#e8eaf0', accent: '#7aa2f7' }

export const DEFAULT_SETTINGS: Readonly<AppSettings> = {
  mapsEnabled: true,
  indexing: true,
  searchByMeaning: true,
  searchText: true,
  faceGrouping: true,
  deepIndexing: false,
  indexingPace: 'balanced',
  theme: 'theia-dark',
  customTheme: DEFAULT_CUSTOM_THEME,
  liquidGlass: true,
  setupDone: false,
}

/** Rest after each photo, as a share of the time it took: gentle works half the time, balanced two thirds, full all of it. */
export const PACE_REST: Record<IndexingPace, number> = { gentle: 1, balanced: 0.5, full: 0 }

const HEX = /^#[0-9a-fA-F]{6}$/

/** Whether `value` is a valid value for setting `key`. The main process checks every change with this. */
export function validSetting(key: string, value: unknown): boolean {
  switch (key) {
    case 'mapsEnabled':
    case 'indexing':
    case 'searchByMeaning':
    case 'searchText':
    case 'faceGrouping':
    case 'deepIndexing':
    case 'liquidGlass':
    case 'setupDone':
      return typeof value === 'boolean'
    case 'indexingPace':
      return value === 'gentle' || value === 'balanced' || value === 'full'
    case 'theme':
      return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
    case 'customTheme':
      return !!value && typeof value === 'object' && !Array.isArray(value)
        && ['background', 'surface', 'text', 'accent'].every((k) => HEX.test(String((value as Record<string, unknown>)[k])))
        && Object.keys(value).length === 4
    default:
      return false
  }
}
