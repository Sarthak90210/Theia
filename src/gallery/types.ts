/**
 * What the gallery shows, whatever it comes from. A phone and a vault both
 * answer these, so the window has one grid, one viewer and one info panel.
 */

export type SourceKind = 'device' | 'vault'

export interface CollectionInfo {
  /** Stable within a source: 'library', 'favourites', 'album:<id>' and so on. */
  id: string
  name: string
  /** utility: Hidden and Recently Deleted, listed apart as on the phone. */
  kind: 'smart' | 'album' | 'utility'
  count: number
  /** Item key of a cover thumbnail, if any. */
  cover: string | null
}

export interface Collections {
  smart: CollectionInfo[]
  albums: CollectionInfo[]
}

export type ItemKind = 'photo' | 'video' | 'live' | 'burst'

/**
 * One tile in the grid. Kept small, because a collection sends all of its
 * items at once and the window lays them out itself.
 */
export interface GalleryItem {
  /** Unique within the source. Vault: asset id. Phone: the phone's UUID. */
  key: string
  kind: ItemKind
  /** Capture time, UTC milliseconds. */
  t: number
  /** Offset from UTC at capture, in seconds, when known. */
  off: number | null
  w: number | null
  h: number | null
  /** Video length in milliseconds. */
  dur: number | null
  fav: boolean
  edited: boolean
  /** Only in iCloud. Shown with a badge, skipped when saving. */
  cloud: boolean
  subtype: string | null
  /** When it was deleted, for items in Recently Deleted. UTC ms. */
  deletedAt?: number | null
  /** Bursts: how many frames, for the badge. */
  frames?: number
  /** Changes when vault media changes, including a new burst cover. */
  revision?: number
}

export interface ItemFile {
  name: string
  role: string
  bytes: number
  mime: string
  /** Where it lives: a path in the vault, or the path on the phone. */
  location: string
  verified: string | null
}

export interface ItemDetail {
  key: string
  kind: ItemKind
  title: string
  capturedUtc: number | null
  offsetSeconds: number | null
  /** How the capture time was worked out: exif, quicktime, filesystem, phone. */
  timeSource: string | null
  width: number | null
  height: number | null
  durationMs: number | null
  camera: { make: string | null; model: string | null; lens: string | null } | null
  exposure: {
    iso: number | null
    fNumber: number | null
    exposureSeconds: number | null
    focalMm: number | null
    /** 35 mm equivalent, including any digital zoom. What the phone shows. */
    focal35: number | null
    /** Exposure compensation in stops. */
    ev: number | null
    /** Digital zoom ratio, to tell the lens's own focal length from a crop. */
    zoom: number | null
  } | null
  /** Video only. Codec as stored (hvc1, avc1) and frame rate. */
  video: { codec: string | null; fps: number | null } | null
  /** `place` is the phone's own name for it, e.g. "Bengaluru Urban - Dibburu". */
  location: { lat: number; lon: number; altitude: number | null; place: string | null } | null
  caption: string | null
  favourite: boolean
  edited: boolean
  cloud: boolean
  subtype: string | null
  albums: string[]
  files: ItemFile[]
  /** Vault this item is already in, when browsing a phone. */
  savedIn: string[]
}
