import { describe, expect, it } from 'vitest'
import { apertureLabel, dateLine, evLabel, exposureLabel, formatChip, lensLabel, resolutionLabel, sizeLabel, timeLabel, wall } from '../app/renderer/format.ts'

/** Values from IMG_6182 on the iPhone 16 Pro Max, checked against the phone's own info screen. */
describe('info panel formatting, as the phone shows it', () => {
  const t = Date.UTC(2026, 9, 30, 9, 59) // 15:29 in India
  const d = wall(t, 19800)

  it('dates and 12-hour times', () => {
    expect(dateLine(d)).toBe('Friday • 30 Oct 2026 • 3:29 PM')
    expect(timeLabel(wall(Date.UTC(2026, 0, 1, 0, 5), 0))).toBe('12:05 AM')
    expect(timeLabel(wall(Date.UTC(2026, 0, 1, 12, 0), 0))).toBe('12:00 PM')
  })

  it('names the lens the way the phone does', () => {
    const make = 'Apple'
    expect(lensLabel('iPhone 16 Pro Max back triple camera 2.22mm f/2.2', make, 15, 1.0685)).toBe('Ultra Wide Camera — 13 mm ƒ2.2')
    expect(lensLabel('iPhone 16 Pro Max back triple camera 6.765mm f/1.78', make, 24, 1)).toBe('Main Camera — 24 mm ƒ1.78')
    expect(lensLabel('iPhone 16 Pro Max back triple camera 6.765mm f/1.78', make, 48, 1)).toBe('Main Camera — 48 mm ƒ1.78')
    expect(lensLabel('iPhone 16 Pro Max back triple camera 15.66mm f/2.8', make, 120, 1)).toBe('Telephoto Camera — 120 mm ƒ2.8')
    expect(lensLabel('iPhone 16 Pro Max front camera 2.69mm f/1.9', make, 23, 1)).toBe('Front Camera — 23 mm ƒ1.9')
    // Videos have no 35 mm figure: the aperture tells the lenses apart.
    expect(lensLabel('iPhone 16 Pro Max back triple camera 6.765mm f/1.78', make, null, null)).toBe('Main Camera — 24 mm ƒ1.78')
    expect(lensLabel('iPhone 16 Pro Max back triple camera 2.22mm f/2.2', make, null, null)).toBe('Ultra Wide Camera — 13 mm ƒ2.2')
    expect(lensLabel('XF23mmF1.4 R', 'FUJIFILM', 35, 1)).toBe('XF23mmF1.4 R')
  })

  it('exposure strip values', () => {
    expect(exposureLabel(0.00074683)).toBe('1/1339 s')
    expect(evLabel(0)).toBe('0 ev')
    expect(evLabel(0.6667)).toBe('+0.7 ev')
    expect(evLabel(-1)).toBe('−1 ev')
    expect(apertureLabel(2.2)).toBe('ƒ2.2')
    expect(apertureLabel(1.78)).toBe('ƒ1.78')
  })

  it('format chips and the size line', () => {
    expect(formatChip('IMG_6182.HEIC', 'image/heic', null)).toBe('HEIF')
    expect(formatChip('IMG_1.DNG', 'image/x-adobe-dng', null)).toBe('RAW')
    expect(formatChip('IMG_2.MOV', 'video/quicktime', 'hvc1')).toBe('HEVC')
    expect(sizeLabel(3_300_000)).toBe('3.3 MB')
    expect(resolutionLabel(1080, 1920)).toBe('1080p')
    expect(resolutionLabel(3840, 2160)).toBe('4K')
  })
})

describe('time left while saving', () => {
  it('reads the way people say it', async () => {
    const { remainingLabel } = await import('../app/renderer/format.ts')
    expect(remainingLabel(null)).toBe('Estimating time left…')
    expect(remainingLabel(2000)).toBe('Almost done')
    expect(remainingLabel(37_000)).toBe('About 35 s left')
    expect(remainingLabel(125_000)).toBe('About 2 min left')
    expect(remainingLabel(3_900_000)).toBe('About 1 h 5 min left')
    expect(remainingLabel(7_200_000)).toBe('About 2 h left')
  })
})

describe('errors as people read them', () => {
  it('drops the IPC wrapper, class names and routing prefixes', async () => {
    const { cleanError } = await import('../app/renderer/format.ts')
    expect(cleanError("Error invoking remote method 'photos:unlockVault': WrongSecret: That passcode isn't right.")).toBe("That passcode isn't right.")
    expect(cleanError("Error invoking remote method 'photos:remove': Error: PROTECTION_NEEDED: Set a passcode first.")).toBe('Set a passcode first.')
    expect(cleanError('Disk is full.')).toBe('Disk is full.')
  })
})
