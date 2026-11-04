import { describe, expect, it } from 'vitest'
import {
  deriveMetadata,
  offsetFromGps,
  parseDateTime,
  parseOffset,
  pick,
  resolveCaptureTime,
  type RawTags,
  type ResolveOptions,
} from '../src/metadata/tags.ts'
import { REAL_HEIC, REAL_MOV } from './fixtures/real-tags.ts'

/** A fixed host zone, so these assertions do not depend on the machine. */
const IST: ResolveOptions = { hostOffsetAt: () => 19800 }

describe('parsing', () => {
  it('reads a datetime carrying its own offset', () => {
    expect(parseDateTime('2026:06:08 18:26:19.698+09:00')).toEqual({
      wallMs: Date.UTC(2026, 5, 8, 18, 26, 19, 698),
      offsetSeconds: 32400,
    })
  })

  it('reads a datetime with no zone and says so', () => {
    expect(parseDateTime('2026:06:08 09:26:19')).toEqual({
      wallMs: Date.UTC(2026, 5, 8, 9, 26, 19, 0),
      offsetSeconds: null,
    })
  })

  it('handles Z and negative offsets', () => {
    expect(parseDateTime('2026:06:08 09:26:19Z')!.offsetSeconds).toBe(0)
    expect(parseOffset('-03:30')).toBe(-12600)
    expect(parseOffset('+05:30')).toBe(19800)
  })

  it('rejects junk rather than inventing a date', () => {
    expect(parseDateTime('not a date')).toBeNull()
    expect(parseOffset('midday')).toBeNull()
  })

  it('rejects the zero date QuickTime writes when it has none', () => {
    // Observed on a real MP4 that was not a camera capture. Date.UTC maps year
    // 0 onto 1900, so accepting this filed the video under 1899-11-30.
    expect(parseDateTime('0000:00:00 00:00:00')).toBeNull()
    expect(parseDateTime('0000:00:00 00:00:00Z')).toBeNull()
  })

  it('rejects components that cannot exist', () => {
    expect(parseDateTime('2026:13:01 00:00:00')).toBeNull()
    expect(parseDateTime('2026:00:01 00:00:00')).toBeNull()
    expect(parseDateTime('2026:06:00 00:00:00')).toBeNull()
    expect(parseDateTime('2026:06:08 25:00:00')).toBeNull()
    // A day that does not exist in its month must not roll into the next one.
    expect(parseDateTime('2026:02:31 00:00:00')).toBeNull()
  })

  it('still accepts a leap day that does exist', () => {
    expect(parseDateTime('2028:02:29 12:00:00')).not.toBeNull()
    expect(parseDateTime('2026:02:29 12:00:00')).toBeNull()
  })

  it('finds a tag regardless of its group', () => {
    expect(pick(REAL_HEIC, 'Make')).toBe('Apple')
    expect(pick(REAL_MOV, 'LensModel')).toMatch(/iPhone 16 Pro Max/)
    expect(pick(REAL_HEIC, 'NoSuchTag')).toBeUndefined()
  })
})

describe('capture time', () => {
  it('takes the still time from the subsecond composite, offset and all', () => {
    const t = resolveCaptureTime(REAL_HEIC)!
    expect(t.utcMs).toBe(Date.UTC(2026, 5, 8, 9, 26, 19, 698))
    expect(t.offsetSeconds).toBe(32400)
    expect(t.source).toBe('exif')
    expect(t.offsetInferred).toBe(false)
  })

  it('takes the video time from Keys:CreationDate, which keeps the offset', () => {
    const t = resolveCaptureTime(REAL_MOV)!
    expect(t.utcMs).toBe(Date.UTC(2026, 5, 8, 9, 26, 19))
    expect(t.offsetSeconds).toBe(32400)
    expect(t.source).toBe('quicktime')
    expect(t.offsetInferred).toBe(false)
  })

  it('agrees on the instant across both halves of a Live Photo', () => {
    // The still says 18:26:19 +09:00, the video says 09:26:19 UTC. Same moment,
    // which is a useful check that the offset arithmetic runs the right way.
    const still = resolveCaptureTime(REAL_HEIC)!
    const motion = resolveCaptureTime(REAL_MOV)!
    expect(Math.floor(still.utcMs / 1000)).toBe(Math.floor(motion.utcMs / 1000))
  })

  it('keeps a bare QuickTime instant exactly and only assumes the display offset', () => {
    const { 'Keys:CreationDate': _drop, ...noKeys } = REAL_MOV
    const t = resolveCaptureTime(noKeys, undefined, IST)!
    // The instant is recorded in UTC, so it must survive untouched.
    expect(t.utcMs).toBe(Date.UTC(2026, 5, 8, 9, 26, 19))
    expect(t.offsetSeconds).toBe(19800)
    expect(t.offsetSource).toBe('host')
    expect(t.offsetInferred).toBe(true)
  })

  it('falls back to the filesystem only when the file carries nothing', () => {
    const t = resolveCaptureTime({}, 1_700_000_000_000, IST)!
    expect(t.source).toBe('filesystem')
    // An mtime is already an instant; only the display offset is assumed.
    expect(t.utcMs).toBe(1_700_000_000_000)
    expect(t.offsetSource).toBe('host')
    expect(t.offsetInferred).toBe(true)
  })

  it('returns null when there is nothing at all to go on', () => {
    expect(resolveCaptureTime({})).toBeNull()
  })

  it('skips a zero QuickTime date and uses the filesystem instead', () => {
    const t = resolveCaptureTime(
      {
        'QuickTime:CreateDate': '0000:00:00 00:00:00',
        'QuickTime:ModifyDate': '0000:00:00 00:00:00',
        'Track1:TrackCreateDate': '0000:00:00 00:00:00',
      },
      1_700_000_000_000,
      IST,
    )!
    expect(t.source).toBe('filesystem')
    expect(t.utcMs).toBe(1_700_000_000_000)
  })
})

describe('offset inference', () => {
  const NO_OFFSET = (() => {
    const {
      'Composite:SubSecDateTimeOriginal': _a,
      'ExifIFD:OffsetTime': _b,
      'ExifIFD:OffsetTimeOriginal': _c,
      ...rest
    } = REAL_HEIC
    return rest
  })()

  it('recovers the offset from GPS, which is exact rather than a guess', () => {
    // GPSDateTime is UTC and DateTimeOriginal is local, so the difference is
    // the offset the camera declined to write down.
    const t = resolveCaptureTime(
      { ...NO_OFFSET, 'Composite:GPSDateTime': '2026:06:08 09:26:19Z' },
      undefined,
      IST,
    )!
    expect(t.offsetSeconds).toBe(32400)
    expect(t.offsetSource).toBe('gps')
    expect(t.offsetInferred).toBe(true)
    expect(t.utcMs).toBe(Date.UTC(2026, 5, 8, 9, 26, 19))
  })

  it('rounds a stale GPS fix to the nearest quarter hour', () => {
    const localWall = Date.UTC(2026, 5, 8, 18, 26, 19)
    // Fix taken four minutes before the shutter.
    expect(offsetFromGps({ 'Composite:GPSDateTime': '2026:06:08 09:22:19Z' }, localWall)).toBe(32400)
    // And a half-hour zone stays a half-hour zone.
    expect(offsetFromGps({ 'Composite:GPSDateTime': '2026:06:08 12:56:19Z' }, localWall)).toBe(19800)
  })

  it('ignores a GPS time too far off to be a real offset', () => {
    const localWall = Date.UTC(2026, 5, 8, 18, 26, 19)
    expect(offsetFromGps({ 'Composite:GPSDateTime': '2020:01:01 00:00:00Z' }, localWall)).toBeNull()
    expect(offsetFromGps({}, localWall)).toBeNull()
  })

  it('assumes the host zone for a screenshot, and records that it assumed', () => {
    // Screenshots carry DateTimeOriginal with no offset and no GPS at all.
    const t = resolveCaptureTime({ 'ExifIFD:DateTimeOriginal': '2026:09:09 21:31:03' }, undefined, IST)!
    expect(t.offsetSource).toBe('host')
    expect(t.offsetInferred).toBe(true)
    expect(t.offsetSeconds).toBe(19800)
    // The point of the change: this is a real instant now, not a wall clock
    // wearing a UTC label, so it sorts correctly against everything else.
    expect(t.utcMs).toBe(Date.UTC(2026, 8, 9, 21, 31, 3) - 19800 * 1000)
  })

  it('always reproduces the original wall reading from instant plus offset', () => {
    const readings: [RawTags, number][] = [
      [REAL_HEIC, Date.UTC(2026, 5, 8, 18, 26, 19, 698)],
      [REAL_MOV, Date.UTC(2026, 5, 8, 18, 26, 19)],
      [{ 'ExifIFD:DateTimeOriginal': '2026:09:09 21:31:03' }, Date.UTC(2026, 8, 9, 21, 31, 3)],
      [
        { ...NO_OFFSET, 'Composite:GPSDateTime': '2026:06:08 09:26:19Z' },
        Date.UTC(2026, 5, 8, 18, 26, 19),
      ],
    ]
    for (const [tags, expected] of readings) {
      const t = resolveCaptureTime(tags, undefined, IST)!
      expect(t.utcMs + (t.offsetSeconds ?? 0) * 1000).toBe(expected)
    }
  })

  it('prefers a recorded offset over any inference', () => {
    const t = resolveCaptureTime(
      { ...REAL_HEIC, 'Composite:GPSDateTime': '2026:06:08 00:00:00Z' },
      undefined,
      IST,
    )!
    expect(t.offsetSource).toBe('recorded')
    expect(t.offsetSeconds).toBe(32400)
  })
})

describe('derived metadata', () => {
  it('pulls the still apart correctly', () => {
    const m = deriveMetadata(REAL_HEIC)
    expect(m.contentId).toBe('4B23D938-CC54-4D95-B0F6-55FE602F2CDA')
    expect(m.burstId).toBeNull()
    expect(m.lat).toBeCloseTo(35.65654, 4)
    expect(m.lon).toBeCloseTo(139.70253, 4)
    expect(m.altitude).toBeCloseTo(17.59, 1)
    expect(m.width).toBe(5712)
    expect(m.height).toBe(4284)
    expect(m.make).toBe('Apple')
    expect(m.model).toBe('iPhone 16 Pro Max')
    expect(m.iso).toBe(80)
    expect(m.fNumber).toBe(1.78)
    expect(m.orientation).toBe(6)
    expect(m.durationMs).toBeNull()
  })

  it('pulls the video apart correctly', () => {
    const m = deriveMetadata(REAL_MOV)
    expect(m.contentId).toBe('4B23D938-CC54-4D95-B0F6-55FE602F2CDA')
    expect(m.width).toBe(1920)
    expect(m.height).toBe(1440)
    expect(m.durationMs).toBe(100)
  })

  it('matches the two halves on content id, which is what pairs them', () => {
    expect(deriveMetadata(REAL_HEIC).contentId).toBe(deriveMetadata(REAL_MOV).contentId)
  })

  it('keeps the hemisphere sign from the composite GPS tags', () => {
    const southWest = deriveMetadata({
      'Composite:GPSLatitude': -33.8688,
      'Composite:GPSLongitude': -70.6693,
    })
    expect(southWest.lat).toBeLessThan(0)
    expect(southWest.lon).toBeLessThan(0)
  })

  it('reads dimensions out of Composite:ImageSize when the track tags are absent', () => {
    const m = deriveMetadata({ 'Composite:ImageSize': '1920 1440' })
    expect(m.width).toBe(1920)
    expect(m.height).toBe(1440)
  })
})
