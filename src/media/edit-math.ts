import type { EditRecipe } from './edit-recipe.ts'

/**
 * The numbers behind an edit, shared by the window's live preview (an SVG
 * filter), the photo export and the video export, so what you see while
 * dragging a slider is what gets saved.
 *
 * Colour is two steps on 0..1 values:
 *   1. a tone curve per channel (exposure, brightness, contrast, warmth, tint)
 *   2. a 3x3 saturation matrix (the W3C/SVG "saturate" matrix)
 *
 * Exposure works the way it does in photo apps: in linear light, with a soft
 * shoulder, so brightening approaches white instead of clipping to it. A
 * plain multiply blew a bright sky out to flat white at +1 EV.
 */

type Tones = Pick<EditRecipe, 'exposure' | 'brightness' | 'contrast' | 'saturation' | 'warmth' | 'tint'>

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)
const clip = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Channel gains for warmth (red against blue) and tint (magenta against green). */
function gains(r: Tones): [number, number, number] {
  return [1 + 0.12 * r.warmth + 0.05 * r.tint, 1 - 0.1 * r.tint, 1 - 0.12 * r.warmth + 0.05 * r.tint]
}

/** Step 1 for one channel value. */
export function tone(r: Tones, v: number, channel: 0 | 1 | 2): number {
  let x = v
  if (r.exposure) {
    const g = 2 ** r.exposure
    let lin = toLinear(x) * g
    // Brighter: a shoulder that keeps white at white. Darker: a plain gain.
    if (g > 1) lin = lin / (1 + (lin * (g - 1)) / g)
    x = toSrgb(clip(lin))
  }
  // Brightness bends the midtones, leaving black and white where they are.
  if (r.brightness) x = x ** 2 ** (-0.6 * r.brightness)
  if (r.contrast !== 1) x = clip(0.5 + (x - 0.5) * r.contrast)
  return clip(x * gains(r)[channel])
}

export function saturationMatrix(s: number): number[] {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ]
}

export interface ColourOps {
  /** Step 1 as 256-entry tables, one per channel, outputs 0..1. */
  tables: [number[], number[], number[]]
  /** Step 2, row-major 3x3. */
  matrix: number[]
  /** True when nothing changes and the step can be skipped. */
  identity: boolean
}

export function colourOps(r: Tones): ColourOps {
  const tables = ([0, 1, 2] as const).map((c) => Array.from({ length: 256 }, (_, i) => tone(r, i / 255, c))) as ColourOps['tables']
  const identity =
    r.exposure === 0 && r.brightness === 0 && r.contrast === 1 && r.saturation === 1 && r.warmth === 0 && r.tint === 0
  return { tables, matrix: saturationMatrix(r.saturation), identity }
}

/** Both steps on one colour, 0..1 in and out. */
export function applyColour(ops: ColourOps, rgb: [number, number, number]): [number, number, number] {
  const t = rgb.map((v, c) => {
    // Linear between table entries, as SVG's "table" transfer function does.
    const p = clip(v) * 255
    const i = Math.min(254, Math.floor(p))
    const f = p - i
    const tab = ops.tables[c as 0 | 1 | 2]
    return tab[i]! * (1 - f) + tab[i + 1]! * f
  })
  const m = ops.matrix
  return [0, 1, 2].map((row) => clip(m[row * 3]! * t[0]! + m[row * 3 + 1]! * t[1]! + m[row * 3 + 2]! * t[2]!)) as [number, number, number]
}

/**
 * Apply both steps to 8-bit RGB (or RGBA) pixels in place. A table per channel
 * then the matrix in fixed point: about 0.2 s for a 12 MP photo.
 */
export function applyColourToPixels(ops: ColourOps, data: Uint8Array | Buffer, channels: number): void {
  const lut = ops.tables.map((t) => Uint8ClampedArray.from(t, (v) => Math.round(v * 255)))
  const [r0, g0, b0] = lut as [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray]
  const m = ops.matrix.map((v) => Math.round(v * 4096))
  for (let i = 0; i + 2 < data.length; i += channels) {
    const r = r0[data[i]!]!
    const g = g0[data[i + 1]!]!
    const b = b0[data[i + 2]!]!
    const R = (m[0]! * r + m[1]! * g + m[2]! * b + 2048) >> 12
    const G = (m[3]! * r + m[4]! * g + m[5]! * b + 2048) >> 12
    const B = (m[6]! * r + m[7]! * g + m[8]! * b + 2048) >> 12
    data[i] = R < 0 ? 0 : R > 255 ? 255 : R
    data[i + 1] = G < 0 ? 0 : G > 255 ? 255 : G
    data[i + 2] = B < 0 ? 0 : B > 255 ? 255 : B
  }
}

/** Both steps as a 3D lookup table in the .cube format, for ffmpeg's lut3d. */
export function cubeLut(ops: ColourOps, size = 33): string {
  const lines = ['TITLE "Theia edit"', `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1']
  // .cube order: red changes fastest, then green, then blue.
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = applyColour(ops, [r / (size - 1), g / (size - 1), b / (size - 1)])
        lines.push(out.map((v) => v.toFixed(6)).join(' '))
      }
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * How much a frame of W x H must be zoomed so that, turned by `degrees`, the
 * picture still covers it with no empty corners. This is what the phone does
 * while you straighten.
 */
export function coverScale(width: number, height: number, degrees: number): number {
  const a = (Math.abs(degrees) * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return Math.max(c + (s * height) / width, c + (s * width) / height)
}
