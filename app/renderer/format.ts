const KB = 1024
const MB = KB * 1024
const GB = MB * 1024

export function bytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(n >= 100 * GB ? 0 : 1)} GB`
  if (n >= MB) return `${(n / MB).toFixed(n >= 100 * MB ? 0 : 1)} MB`
  if (n >= KB) return `${Math.round(n / KB)} KB`
  return `${n} B`
}

export function count(n: number): string {
  return n.toLocaleString()
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`
}

/** 0:07, 1:02:33 */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/**
 * The wall-clock time where the photo was taken, as a Date whose UTC fields
 * hold that local time. A photo shot at 18:26 in Tokyo reads 18:26, wherever
 * this computer is. Without an offset, the computer's own zone is the guess.
 */
export function wall(t: number, off: number | null): Date {
  if (off !== null) return new Date(t + off * 1000)
  return new Date(t - new Date(t).getTimezoneOffset() * 60_000)
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
}
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}`
}

export function dayLabel(d: Date): string {
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
export function monthLabel(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** "About 2 min left". Rounded the way people say it, never falsely precise. */
export function remainingLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'Estimating time left…'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 5) return 'Almost done'
  if (s < 60) return `About ${Math.max(5, Math.round(s / 5) * 5)} s left`
  const m = Math.round(s / 60)
  if (m < 60) return `About ${m} min left`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `About ${h} h ${rest} min left` : `About ${h} h left`
}

/** 3:29 PM, as the phone shows it. */
export function timeLabel(d: Date): string {
  const h = d.getUTCHours()
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Friday • 30 Oct 2026 • 3:29 PM */
export function dateLine(d: Date): string {
  return `${DAYS[d.getUTCDay()]} • ${d.getUTCDate()} ${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} • ${timeLabel(d)}`
}

/** Sizes the way the phone counts them, in thousands: 3.3 MB. */
export function sizeLabel(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`
  return `${n} B`
}

/** 0 ev, +0.7 ev, −1 ev */
export function evLabel(ev: number | null): string | null {
  if (ev === null) return null
  const r = Math.round(ev * 10) / 10
  if (r === 0) return '0 ev'
  return `${r > 0 ? '+' : '−'}${String(Math.abs(r))} ev`
}

/** ƒ2.2, ƒ1.78: the phone keeps up to two decimals and drops trailing zeros. */
export function apertureLabel(f: number | null): string | null {
  if (!f) return null
  return `ƒ${String(Math.round(f * 100) / 100)}`
}

/** The chip beside the camera name: HEIF, JPEG, RAW, HEVC. */
export function formatChip(name: string, mime: string, codec: string | null): string | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (mime.startsWith('video/')) {
    if (codec && /hvc1|hev1|hevc/i.test(codec)) return 'HEVC'
    if (codec && /avc1|h\.?264/i.test(codec)) return 'H.264'
    if (codec && /ap4|apcn|apch|prores/i.test(codec)) return 'ProRes'
    return ext ? ext.toUpperCase() : null
  }
  if (ext === 'heic' || ext === 'heif') return 'HEIF'
  if (ext === 'jpg' || ext === 'jpeg') return 'JPEG'
  if (ext === 'dng') return 'RAW'
  return ext ? ext.toUpperCase() : null
}

/** 4K, 1080p, 720p, from the short side. */
export function resolutionLabel(w: number | null, h: number | null): string | null {
  if (!w || !h) return null
  const short = Math.min(w, h)
  if (short >= 2000) return '4K'
  if (short >= 1400) return '1440p'
  if (short >= 1000) return '1080p'
  if (short >= 700) return '720p'
  return `${short}p`
}

const BACK_LENSES = [13, 24, 28, 35, 48, 52, 77, 120]

/**
 * "Ultra Wide Camera — 13 mm ƒ2.2", the way an iPhone names its lenses.
 *
 * The 35 mm figure in the file includes digital zoom (15 mm for a slightly
 * zoomed ultra wide), so divide that out, then snap to the focal lengths
 * Apple quotes. Not an iPhone: the lens model as written.
 */
export function lensLabel(lens: string | null, make: string | null, focal35: number | null, zoom: number | null): string | null {
  if (!lens) return null
  const ap = /f\/([\d.]+)/i.exec(lens)?.[1]
  const aperture = ap ? apertureLabel(Number(ap)) : null
  if (!/apple/i.test(make ?? '') && !/iphone/i.test(lens)) return lens
  const base = focal35 ? focal35 / (zoom && zoom > 1 ? zoom : 1) : null
  const front = /front/i.test(lens)
  let name: string
  let mm: number | null = null
  if (front) {
    name = 'Front Camera'
    mm = base ? Math.round(base) : null
  } else if (base === null) {
    // Videos carry no 35 mm figure. Apple's back lenses differ by aperture:
    // the main camera is the fastest (ƒ1.5 to ƒ1.9), the ultra wide is ƒ2.2
    // or ƒ2.4, the telephoto ƒ2.5 and slower.
    const f = ap ? Number(ap) : null
    if (f === null) name = 'Back Camera'
    else if (f < 2.1) [name, mm] = ['Main Camera', 24]
    else if (f < 2.5) [name, mm] = ['Ultra Wide Camera', 13]
    else name = 'Telephoto Camera'
  } else {
    mm = BACK_LENSES.reduce((best, x) => (Math.abs(x - base) < Math.abs(best - base) ? x : best))
    name = mm < 20 ? 'Ultra Wide Camera' : mm <= 52 ? 'Main Camera' : 'Telephoto Camera'
  }
  const spec = [mm ? `${mm} mm` : null, aperture].filter(Boolean).join(' ')
  return spec ? `${name} — ${spec}` : name
}

export function offsetLabel(off: number | null): string {
  if (off === null) return ''
  const sign = off >= 0 ? '+' : '−'
  const a = Math.abs(off)
  return `UTC${sign}${String(Math.floor(a / 3600)).padStart(2, '0')}:${String(Math.floor((a % 3600) / 60)).padStart(2, '0')}`
}

export function exposureLabel(seconds: number | null): string | null {
  if (!seconds) return null
  if (seconds >= 1) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`
  return `1/${Math.round(1 / seconds)} s`
}

/**
 * An error as a person should read it: without Electron's "Error invoking
 * remote method '...':" wrapper, the error's class name, or Theia's own
 * routing prefixes (LOCKED, PROTECTION_NEEDED).
 */
export function cleanError(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:[A-Z][A-Za-z]*(?:Error|Secret|Vault|Cancelled)|Error):\s*/, '')
    .replace(/^(?:LOCKED|PROTECTION_NEEDED):\s*/, '')
}
