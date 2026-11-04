/**
 * An edit, applied in this order: flip, quarter turns, straighten (with the
 * zoom that keeps the frame filled), crop, then light and colour.
 */
export interface EditRecipe {
  rotation: 0 | 90 | 180 | 270
  flip: boolean
  /** Small rotation in degrees, -45 to 45, clockwise positive. */
  straighten: number
  /**
   * Crop fractions of the picture as displayed: after flip, quarter turns and
   * straighten. The same frame the crop handles are drawn on.
   */
  crop: { x: number; y: number; width: number; height: number }
  exposure: number
  /** -1 to 1. */
  brightness: number
  contrast: number
  saturation: number
  /** -1 (cooler) to 1 (warmer). */
  warmth: number
  /** -1 (greener) to 1 (more magenta). */
  tint: number
  start: number
  end: number | null
  mute: boolean
}

export const DEFAULT_EDIT: EditRecipe = {
  rotation: 0, flip: false, straighten: 0, crop: { x: 0, y: 0, width: 1, height: 1 },
  exposure: 0, brightness: 0, contrast: 1, saturation: 1, warmth: 0, tint: 0, start: 0, end: null, mute: false,
}

/** Validate at the IPC boundary as well as in the editor. */
export function validateEdit(input: EditRecipe): EditRecipe {
  // Fields added later default to "no change", so older callers still work.
  const value = input && { ...DEFAULT_EDIT, ...input }
  const number = (n: number, min: number, max: number) => Number.isFinite(n) && n >= min && n <= max
  if (!value || ![0, 90, 180, 270].includes(value.rotation) || typeof value.flip !== 'boolean' || typeof value.mute !== 'boolean' ||
      !number(value.exposure, -2, 2) || !number(value.straighten, -45, 45) || !number(value.brightness, -1, 1) ||
      !number(value.warmth, -1, 1) || !number(value.tint, -1, 1) || !number(value.contrast, 0.5, 1.5) || !number(value.saturation, 0, 2) ||
      !number(value.start, 0, 7 * 86400) || (value.end !== null && (!number(value.end, 0, 7 * 86400) || value.end <= value.start))) {
    throw new Error('Invalid edit settings.')
  }
  const c = value.crop
  if (!c || !number(c.x, 0, 1) || !number(c.y, 0, 1) || !number(c.width, 0.05, 1) || !number(c.height, 0.05, 1) ||
      c.x + c.width > 1.000001 || c.y + c.height > 1.000001) throw new Error('Crop must stay inside the image.')
  return structuredClone(value)
}
