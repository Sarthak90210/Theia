/** All coordinates are fractions of the complete image, not CSS pixels. */
export interface CropRect { x: number; y: number; width: number; height: number }
export type CropHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
type Rotation = 0 | 90 | 180 | 270

const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

function rect(value: CropRect): CropRect {
  const width = clamp(finite(value.width, 1), 0, 1)
  const height = clamp(finite(value.height, 1), 0, 1)
  return { x: clamp(finite(value.x, 0), 0, 1 - width), y: clamp(finite(value.y, 0), 0, 1 - height), width, height }
}

/** The same crop after the picture turns clockwise by `rotation`. */
export function rotateCrop(c: CropRect, rotation: Rotation): CropRect {
  switch (rotation) {
    case 90: return { x: 1 - c.y - c.height, y: c.x, width: c.height, height: c.width }
    case 180: return { x: 1 - c.x - c.width, y: 1 - c.y - c.height, width: c.width, height: c.height }
    case 270: return { x: c.y, y: 1 - c.x - c.width, width: c.height, height: c.width }
    default: return { ...c }
  }
}

/** Source is flipped horizontally first, then rotated clockwise for display. */
export function toDisplayCrop(crop: CropRect, rotation: Rotation, flip: boolean): CropRect {
  const c = rect(crop)
  if (flip) c.x = 1 - c.x - c.width
  return rect(rotateCrop(c, rotation))
}

/** Inverse of toDisplayCrop, suitable for the existing export recipe. */
export function toSourceCrop(displayCrop: CropRect, rotation: Rotation, flip: boolean): CropRect {
  const inverse = ((360 - rotation) % 360) as Rotation
  const c = rotateCrop(rect(displayCrop), inverse)
  if (flip) c.x = 1 - c.x - c.width
  return rect(c)
}

/** Largest rectangle of the requested normalized ratio, with a clamped center. */
export function fitAspectCrop(normalizedAspect: number, center = { x: 0.5, y: 0.5 }): CropRect {
  const aspect = normalizedAspect > 0 && Number.isFinite(normalizedAspect) ? normalizedAspect : 1
  const width = Math.min(1, aspect)
  const height = Math.min(1, 1 / aspect)
  return {
    x: clamp(finite(center.x, 0.5) - width / 2, 0, 1 - width),
    y: clamp(finite(center.y, 0.5) - height / 2, 0, 1 - height),
    width,
    height,
  }
}

/**
 * Drag from the rectangle captured on pointer-down. Deltas are relative to that
 * same pointer-down, so excursions outside the image do not make handles jump.
 * A locked aspect is a ratio of normalized width to normalized height; divide a
 * desired pixel ratio by the full displayed image's pixel ratio before calling.
 */
export function dragCrop(
  start: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  normalizedAspect: number | null = null,
  min = 0.05,
): CropRect {
  const s = rect(start)
  dx = finite(dx, 0); dy = finite(dy, 0)
  min = clamp(finite(min, 0.05), 0.000001, 1)
  if (handle === 'move') return { ...s, x: clamp(s.x + dx, 0, 1 - s.width), y: clamp(s.y + dy, 0, 1 - s.height) }

  const west = handle.includes('w'), east = handle.includes('e')
  const north = handle.includes('n'), south = handle.includes('s')
  const aspect = normalizedAspect !== null && normalizedAspect > 0 && Number.isFinite(normalizedAspect) ? normalizedAspect : null
  const right = s.x + s.width, bottom = s.y + s.height

  if (aspect === null) {
    const x = west ? clamp(s.x + dx, 0, Math.max(0, right - min)) : s.x
    const y = north ? clamp(s.y + dy, 0, Math.max(0, bottom - min)) : s.y
    const endX = east ? clamp(right + dx, Math.min(1, x + min), 1) : right
    const endY = south ? clamp(bottom + dy, Math.min(1, y + min), 1) : bottom
    return rect({ x, y, width: endX - x, height: endY - y })
  }

  const signX = west ? -1 : 1, signY = north ? -1 : 1
  const anchorX = west ? right : s.x, anchorY = north ? bottom : s.y
  if ((west || east) && (north || south)) {
    const maxWidth = Math.min(west ? anchorX : 1 - anchorX, (north ? anchorY : 1 - anchorY) * aspect)
    // If an extreme ratio cannot fit the minimum in both axes, the boundary
    // wins. This keeps the requested ratio and never produces an invalid box.
    const minWidth = Math.min(maxWidth, Math.max(min, min * aspect))
    const candidate = Math.abs(dx) >= Math.abs(dy * aspect) ? s.width + signX * dx : (s.height + signY * dy) * aspect
    const width = clamp(candidate, minWidth, maxWidth), height = width / aspect
    return rect({ x: west ? anchorX - width : anchorX, y: north ? anchorY - height : anchorY, width, height })
  }
  if (west || east) {
    const centerY = s.y + s.height / 2
    const maxWidth = Math.min(west ? anchorX : 1 - anchorX, 2 * Math.min(centerY, 1 - centerY) * aspect)
    const width = clamp(s.width + signX * dx, Math.min(maxWidth, Math.max(min, min * aspect)), maxWidth)
    const height = width / aspect
    return rect({ x: west ? anchorX - width : anchorX, y: centerY - height / 2, width, height })
  }
  const centerX = s.x + s.width / 2
  const maxHeight = Math.min(north ? anchorY : 1 - anchorY, 2 * Math.min(centerX, 1 - centerX) / aspect)
  const height = clamp(s.height + signY * dy, Math.min(maxHeight, Math.max(min, min / aspect)), maxHeight)
  const width = height * aspect
  return rect({ x: centerX - width / 2, y: north ? anchorY - height : anchorY, width, height })
}
