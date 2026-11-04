/**
 * Pure tag interpretation. No I/O, so it is testable with literal tag objects
 * copied straight from a real device dump.
 *
 * Everything here assumes exiftool was run with `-G1 -n`: family-1 group
 * names, numeric values. Group family matters. Apple MakerNote tags appear
 * under `Apple:` with -G1 and `MakerNotes:` with -G0, and mixing the two
 * returns nothing silently.
 */

export type RawTags = Record<string, unknown>

export type TimeSource = 'exif' | 'quicktime' | 'filesystem'

/**
 * Where the UTC offset came from, so "the dates are wrong" stays diagnosable.
 *
 *   recorded  the file stated it
 *   gps       derived from GPSDateTime, which is UTC, against the local reading
 *   host      assumed to be the importing machine's zone
 */
export type OffsetSource = 'recorded' | 'gps' | 'host'

export interface FileMetadata {
  contentId: string | null
  burstId: string | null
  capturedUtcMs: number | null
  /** Seconds east of UTC. */
  capturedOffsetSeconds: number | null
  offsetInferred: boolean
  offsetSource: OffsetSource | null
  timeSource: TimeSource | null
  lat: number | null
  lon: number | null
  altitude: number | null
  width: number | null
  height: number | null
  durationMs: number | null
  make: string | null
  model: string | null
  lens: string | null
  iso: number | null
  fNumber: number | null
  exposure: number | null
  focalMm: number | null
  orientation: number | null
}

/* --------------------------------------------------------------- lookups */

/** First value whose key is `name` or ends in `:name`. Group-agnostic. */
export function pick(tags: RawTags, ...names: string[]): unknown {
  for (const name of names) {
    if (tags[name] !== undefined) return tags[name]
    const suffix = `:${name}`
    for (const [k, v] of Object.entries(tags)) {
      if (k.endsWith(suffix) && v !== undefined && v !== null) return v
    }
  }
  return undefined
}

function pickByPattern(tags: RawTags, pattern: RegExp): string | null {
  for (const [k, v] of Object.entries(tags)) {
    if (pattern.test(k) && v != null && v !== '') return String(v)
  }
  return null
}

function num(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value))
  return Number.isFinite(n) ? n : null
}

function str(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const s = String(value).trim()
  return s === '' ? null : s
}

/* ------------------------------------------------------------------ time */

export interface ParsedDateTime {
  /** The wall-clock reading, interpreted as though it were UTC. */
  wallMs: number
  /** Seconds east of UTC, or null when the string carried no zone. */
  offsetSeconds: number | null
}

const DATETIME =
  /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?\s*(Z|[+-]\d{2}:?\d{2})?$/

export function parseDateTime(value: unknown): ParsedDateTime | null {
  const s = str(value)
  if (!s) return null
  const m = DATETIME.exec(s)
  if (!m) return null

  const [, y, mo, d, hh, mm, ss, frac, zone] = m
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(hh)
  const minute = Number(mm)
  const second = Number(ss)

  // QuickTime writes "0000:00:00 00:00:00" when it has no date, which is common
  // in video that did not come from the camera. Date.UTC maps years 0 to 99
  // onto 1900 to 1999, so accepting that reading files the video under
  // 1899-11-30. Observed on a real MP4.
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return null
  if (hour > 23 || minute > 59 || second > 60) return null

  const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  if (!Number.isFinite(wallMs)) return null

  // Reject a day that does not exist in its month rather than letting it roll
  // over, so 31 February does not silently become 3 March.
  const back = new Date(wallMs)
  if (back.getUTCFullYear() !== year || back.getUTCMonth() + 1 !== month || back.getUTCDate() !== day) {
    return null
  }

  let offsetSeconds: number | null = null
  if (zone === 'Z') {
    offsetSeconds = 0
  } else if (zone) {
    const sign = zone.startsWith('-') ? -1 : 1
    const body = zone.slice(1).replace(':', '')
    offsetSeconds = sign * (Number(body.slice(0, 2)) * 3600 + Number(body.slice(2, 4)) * 60)
  }
  return { wallMs, offsetSeconds }
}

/** Offsets look like "+09:00". Returns seconds east of UTC. */
export function parseOffset(value: unknown): number | null {
  const s = str(value)
  if (!s) return null
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(s)
  if (!m) return null
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60)
}

export interface CaptureTime {
  utcMs: number
  offsetSeconds: number | null
  source: TimeSource
  offsetInferred: boolean
  offsetSource: OffsetSource | null
}

export interface ResolveOptions {
  /** Injectable so tests do not depend on the machine running them. */
  hostOffsetAt?: (wallMs: number) => number
}

/**
 * The importing machine's offset at a given moment.
 *
 * `getTimezoneOffset` returns the minutes to add to local time to reach UTC,
 * so the offset east of UTC is its negation. Resolved twice because the first
 * pass reads a wall clock as though it were UTC, which can land on the wrong
 * side of a daylight-saving transition.
 */
export function hostOffsetAt(wallMs: number): number {
  const first = -new Date(wallMs).getTimezoneOffset() * 60
  return -new Date(wallMs - first * 1000).getTimezoneOffset() * 60
}

const QUARTER_HOUR = 15 * 60

/**
 * Recovers the offset a camera declined to record.
 *
 * GPSDateTime is UTC and DateTimeOriginal is local, so their difference is the
 * offset exactly. This is a derivation from the file rather than a guess, and
 * it is the reason a travel photo without OffsetTimeOriginal still gets the
 * right zone.
 */
export function offsetFromGps(tags: RawTags, localWallMs: number): number | null {
  const gps = parseDateTime(pick(tags, 'GPSDateTime'))
  if (!gps || gps.offsetSeconds === null) return null
  const diff = (localWallMs - gps.wallMs) / 1000
  if (!Number.isFinite(diff) || Math.abs(diff) > 14 * 3600 + QUARTER_HOUR) return null
  // Real offsets are whole quarter hours. Rounding absorbs the seconds between
  // the GPS fix and the shutter.
  return Math.round(diff / QUARTER_HOUR) * QUARTER_HOUR
}

/**
 * Resolution order, chosen from what real files actually carry:
 *
 *   1. Composite:SubSecDateTimeOriginal  stills, local time with the offset
 *   2. DateTimeOriginal + OffsetTimeOriginal  the same thing in two tags
 *   3. Keys:CreationDate  video, local time with the offset
 *   4. QuickTime:CreateDate  video, already UTC, offset discarded by the format
 *   5. the filesystem
 *
 * Both the instant and the offset are kept. A photo taken in Tokyo by someone
 * living in Delhi is 18:26 +09:00, and collapsing that to either local zone
 * loses a fact the user can see is wrong.
 *
 * When no offset is recorded, one is inferred rather than left null, because a
 * null offset forces the caller to store a local wall clock labelled UTC. That
 * is not an instant, and a library holding a mix of the two cannot be sorted.
 * The inference is from GPS where possible and the host zone otherwise, and
 * `offsetSource` says which, so the guess is never mistaken for a reading.
 *
 * The invariant that holds in every branch: utcMs + offsetSeconds reproduces
 * the wall-clock reading the camera recorded.
 */
export function resolveCaptureTime(
  tags: RawTags,
  fallbackMs?: number,
  opts?: ResolveOptions,
): CaptureTime | null {
  const host = opts?.hostOffsetAt ?? hostOffsetAt

  const subSec = parseDateTime(tags['Composite:SubSecDateTimeOriginal'])
  if (subSec && subSec.offsetSeconds !== null) {
    return {
      utcMs: subSec.wallMs - subSec.offsetSeconds * 1000,
      offsetSeconds: subSec.offsetSeconds,
      source: 'exif',
      offsetInferred: false,
      offsetSource: 'recorded',
    }
  }

  const original = parseDateTime(pick(tags, 'DateTimeOriginal'))
  if (original) {
    const recorded =
      original.offsetSeconds ?? parseOffset(pick(tags, 'OffsetTimeOriginal', 'OffsetTime'))
    if (recorded !== null) {
      return {
        utcMs: original.wallMs - recorded * 1000,
        offsetSeconds: recorded,
        source: 'exif',
        offsetInferred: false,
        offsetSource: 'recorded',
      }
    }

    // A local reading with no zone: screenshots and screen recordings are the
    // common case, since nothing on the device stamps them with an offset.
    const fromGps = offsetFromGps(tags, original.wallMs)
    const offset = fromGps ?? host(original.wallMs)
    return {
      utcMs: original.wallMs - offset * 1000,
      offsetSeconds: offset,
      source: 'exif',
      offsetInferred: true,
      offsetSource: fromGps !== null ? 'gps' : 'host',
    }
  }

  const creation = parseDateTime(tags['Keys:CreationDate'])
  if (creation && creation.offsetSeconds !== null) {
    return {
      utcMs: creation.wallMs - creation.offsetSeconds * 1000,
      offsetSeconds: creation.offsetSeconds,
      source: 'quicktime',
      offsetInferred: false,
      offsetSource: 'recorded',
    }
  }

  // QuickTime stores UTC and keeps no zone. The instant is correct and only the
  // original local offset is gone, so infer one for display without touching
  // the instant.
  const quickTime = parseDateTime(pick(tags, 'CreateDate', 'MediaCreateDate', 'TrackCreateDate'))
  if (quickTime) {
    const utcMs = quickTime.wallMs - (quickTime.offsetSeconds ?? 0) * 1000
    if (quickTime.offsetSeconds !== null) {
      return {
        utcMs,
        offsetSeconds: quickTime.offsetSeconds,
        source: 'quicktime',
        offsetInferred: false,
        offsetSource: 'recorded',
      }
    }
    return {
      utcMs,
      offsetSeconds: host(utcMs),
      source: 'quicktime',
      offsetInferred: true,
      offsetSource: 'host',
    }
  }

  if (fallbackMs !== undefined) {
    // An mtime is a real instant, so only the display offset is assumed.
    return {
      utcMs: fallbackMs,
      offsetSeconds: host(fallbackMs),
      source: 'filesystem',
      offsetInferred: true,
      offsetSource: 'host',
    }
  }
  return null
}

/* ---------------------------------------------------------------- derive */

function dimensions(tags: RawTags): { width: number | null; height: number | null } {
  const width = num(pick(tags, 'ImageWidth', 'ExifImageWidth', 'SourceImageWidth'))
  const height = num(pick(tags, 'ImageHeight', 'ExifImageHeight', 'SourceImageHeight'))
  if (width && height) return { width, height }

  // Composite:ImageSize reads "1920 1440".
  const size = str(tags['Composite:ImageSize'])
  if (size) {
    const parts = size.split(/[ x]+/)
    const w = num(parts[0])
    const h = num(parts[1])
    if (w && h) return { width: w, height: h }
  }
  return { width, height }
}

export function deriveMetadata(
  tags: RawTags,
  fallbackMs?: number,
  opts?: ResolveOptions,
): FileMetadata {
  const time = resolveCaptureTime(tags, fallbackMs, opts)
  const { width, height } = dimensions(tags)
  const durationSec = num(pick(tags, 'Duration', 'MediaDuration', 'TrackDuration'))

  return {
    // Apple: on stills, Keys: on video. Same UUID, which is what pairs them.
    contentId: pickByPattern(tags, /(^|:)ContentIdentifier$/),
    burstId: pickByPattern(tags, /(^|:)BurstUUID$/),

    capturedUtcMs: time?.utcMs ?? null,
    capturedOffsetSeconds: time?.offsetSeconds ?? null,
    offsetInferred: time?.offsetInferred ?? true,
    offsetSource: time?.offsetSource ?? null,
    timeSource: time?.source ?? null,

    // The Composite versions already have the hemisphere sign applied; the raw
    // GPS ones are unsigned magnitudes paired with a separate Ref tag.
    lat: num(tags['Composite:GPSLatitude']),
    lon: num(tags['Composite:GPSLongitude']),
    altitude: num(tags['Composite:GPSAltitude']),

    width,
    height,
    durationMs: durationSec === null ? null : Math.round(durationSec * 1000),

    make: str(pick(tags, 'Make')),
    model: str(pick(tags, 'Model')),
    lens: str(pick(tags, 'LensModel', 'LensID')),
    iso: num(pick(tags, 'ISO')),
    fNumber: num(pick(tags, 'FNumber')),
    exposure: num(pick(tags, 'ExposureTime')),
    focalMm: num(pick(tags, 'FocalLength')),
    orientation: num(pick(tags, 'Orientation')),
  }
}
