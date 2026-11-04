import { describe, expect, it } from 'vitest'
import { dragCrop, fitAspectCrop, toDisplayCrop, toSourceCrop, type CropHandle, type CropRect } from '../app/renderer/crop-geometry.ts'

const close = (actual: CropRect, expected: CropRect) => {
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(actual[key], key).toBeCloseTo(expected[key], 10)
}
const valid = (r: CropRect, min = 0.05) => {
  for (const n of Object.values(r)) expect(Number.isFinite(n)).toBe(true)
  expect(r.x).toBeGreaterThanOrEqual(-1e-12)
  expect(r.y).toBeGreaterThanOrEqual(-1e-12)
  expect(r.x + r.width).toBeLessThanOrEqual(1 + 1e-12)
  expect(r.y + r.height).toBeLessThanOrEqual(1 + 1e-12)
  expect(r.width).toBeGreaterThanOrEqual(min - 1e-12)
  expect(r.height).toBeGreaterThanOrEqual(min - 1e-12)
}
const handles: CropHandle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

describe('crop orientation', () => {
  it('maps a known source crop through quarter turns and a source-first flip', () => {
    const c = { x: 0.2, y: 0.3, width: 0.4, height: 0.3 }
    close(toDisplayCrop(c, 90, false), { x: 0.4, y: 0.2, width: 0.3, height: 0.4 })
    close(toDisplayCrop(c, 180, false), { x: 0.4, y: 0.4, width: 0.4, height: 0.3 })
    close(toDisplayCrop(c, 270, false), { x: 0.3, y: 0.4, width: 0.3, height: 0.4 })
    close(toDisplayCrop(c, 90, true), { x: 0.4, y: 0.4, width: 0.3, height: 0.4 })
  })

  it('round-trips rectangles through every rotation and flip without mutation', () => {
    for (const c of [{ x: 0.17, y: 0.29, width: 0.61, height: 0.43 }, { x: 0, y: 0, width: 1, height: 1 }, { x: 0.95, y: 0, width: 0.05, height: 0.05 }]) {
      Object.freeze(c)
      for (const angle of [0, 90, 180, 270] as const) for (const flip of [false, true]) {
        const displayed = toDisplayCrop(c, angle, flip)
        valid(displayed)
        close(toSourceCrop(displayed, angle, flip), c)
      }
    }
  })
})

describe('dragging a crop', () => {
  const start = { x: 0.2, y: 0.25, width: 0.5, height: 0.4 }

  it('moves the complete selection without changing its size or leaving the image', () => {
    close(dragCrop(start, 'move', 10, -10), { x: 0.5, y: 0, width: 0.5, height: 0.4 })
    close(dragCrop(start, 'move', -10, 10), { x: 0, y: 0.6, width: 0.5, height: 0.4 })
  })

  it('resizes freely while holding the opposite corner or edge still', () => {
    close(dragCrop(start, 'nw', 0.1, 0.1), { x: 0.3, y: 0.35, width: 0.4, height: 0.3 })
    close(dragCrop(start, 'se', 0.1, 0.1), { x: 0.2, y: 0.25, width: 0.6, height: 0.5 })
    close(dragCrop(start, 'e', 0.1, 0.4), { x: 0.2, y: 0.25, width: 0.6, height: 0.4 })
    close(dragCrop(start, 'n', 0.4, 0.1), { x: 0.2, y: 0.35, width: 0.5, height: 0.3 })
  })

  it('clamps every handle at the boundary and minimum instead of crossing', () => {
    for (const handle of handles) for (const dx of [-100, 0, 100]) for (const dy of [-100, 0, 100]) {
      valid(dragCrop(start, handle, dx, dy))
    }
    close(dragCrop(start, 'nw', 10, 10), { x: 0.65, y: 0.6, width: 0.05, height: 0.05 })
    close(dragCrop(start, 'se', -10, -10), { x: 0.2, y: 0.25, width: 0.05, height: 0.05 })
  })

  it('uses the pointer-down rectangle so leaving and re-entering the image is reversible', () => {
    close(dragCrop(start, 'w', -5, 0), { x: 0, y: 0.25, width: 0.7, height: 0.4 })
    close(dragCrop(start, 'w', -0.1, 0), { x: 0.1, y: 0.25, width: 0.6, height: 0.4 })
    close(dragCrop(start, 'w', 0, 0), start)
  })

  it('preserves a physical square in both landscape and portrait displayed images', () => {
    const landscape = dragCrop({ x: 0.2, y: 0.2, width: 0.4, height: 0.6 }, 'se', 0.1, 0.1, 1 / 1.5)
    expect(landscape.width * 1500).toBeCloseTo(landscape.height * 1000, 8)
    close(landscape, { x: 0.2, y: 0.2, width: 0.5, height: 0.75 })
    const portrait = dragCrop({ x: 0.2, y: 0.2, width: 0.6, height: 0.4 }, 'nw', 0.1, 0.1, 1.5)
    expect(portrait.width * 1000).toBeCloseTo(portrait.height * 1500, 8)
    expect(portrait.x + portrait.width).toBeCloseTo(0.8, 10)
    expect(portrait.y + portrait.height).toBeCloseTo(0.6, 10)
  })

  it('holds the opposite edge and perpendicular center when an aspect-locked edge moves', () => {
    const c = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
    const east = dragCrop(c, 'e', 0.1, 10, 1)
    close(east, { x: 0.25, y: 0.2, width: 0.6, height: 0.6 })
    const north = dragCrop(c, 'n', 10, 0.1, 1)
    close(north, { x: 0.3, y: 0.35, width: 0.4, height: 0.4 })
    const west = dragCrop(c, 'w', -10, 0, 1)
    expect(west.x + west.width).toBeCloseTo(0.75, 10)
    expect(west.y + west.height / 2).toBeCloseTo(0.5, 10)
    valid(west)
  })

  it('keeps ratios and valid bounds for every locked handle across large excursions', () => {
    for (const aspect of [0.3, 2 / 3, 1, 1.5, 3]) {
      const fitted = fitAspectCrop(aspect)
      const c = { x: fitted.x + fitted.width * 0.25, y: fitted.y + fitted.height * 0.25, width: fitted.width * 0.5, height: fitted.height * 0.5 }
      for (const handle of handles) for (const dx of [-10, -0.2, 0, 0.2, 10]) for (const dy of [-10, -0.2, 0, 0.2, 10]) {
        const r = dragCrop(c, handle, dx, dy, aspect)
        valid(r)
        expect(r.width / r.height).toBeCloseTo(aspect, 9)
      }
    }
  })

  it('does not let non-finite pointer or ratio values poison the recipe', () => {
    for (const handle of ['move', ...handles] as CropHandle[]) {
      valid(dragCrop(start, handle, NaN, Infinity, NaN, NaN))
      valid(dragCrop(start, handle, -Infinity, NaN, Infinity))
    }
    for (const aspect of [NaN, Infinity, -1, 0, 1e-9, 1e9]) {
      const fitted = fitAspectCrop(aspect, { x: NaN, y: Infinity })
      valid(fitted, 0)
      valid(dragCrop(fitted, 'se', 1, 1, aspect), 0)
    }
  })
})

describe('fitting aspect presets', () => {
  it('fits the largest landscape or portrait rectangle and clamps its requested center', () => {
    close(fitAspectCrop(2), { x: 0, y: 0.25, width: 1, height: 0.5 })
    close(fitAspectCrop(0.5), { x: 0.25, y: 0, width: 0.5, height: 1 })
    close(fitAspectCrop(2, { x: -5, y: 5 }), { x: 0, y: 0.5, width: 1, height: 0.5 })
  })
})
