export interface AppSettings {
  /** Permit OpenStreetMap tiles in the info panel. Coordinates stay local when off. */
  mapsEnabled: boolean
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = { mapsEnabled: true }
