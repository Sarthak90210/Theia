/**
 * Undo and redo for the editor. A click is one step; a whole drag (a slider,
 * the crop frame, the straighten ruler) is one step too, however many values
 * it passed through on the way.
 */
export interface History<T> {
  past: T[]
  present: T
  future: T[]
  /** The value when the current drag began, or null when not dragging. */
  base: T | null
}

const same = <T>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b)

export const start = <T>(present: T): History<T> => ({ past: [], present, future: [], base: null })

/** A single change: one undo step. */
export function commit<T>(h: History<T>, next: T): History<T> {
  if (h.base !== null) return { ...h, present: next }
  if (same(h.present, next)) return h
  return { past: [...h.past, h.present], present: next, future: [], base: null }
}

/** A change in the middle of a drag. */
export function drag<T>(h: History<T>, next: T): History<T> {
  return { ...h, present: next, base: h.base ?? h.present }
}

/** The drag ended: record it as one step, if it changed anything. */
export function endDrag<T>(h: History<T>): History<T> {
  if (h.base === null) return h
  if (same(h.base, h.present)) return { ...h, base: null }
  return { past: [...h.past, h.base], present: h.present, future: [], base: null }
}

export function undo<T>(h: History<T>): History<T> {
  const h2 = endDrag(h)
  const prev = h2.past.at(-1)
  if (prev === undefined) return h2
  return { past: h2.past.slice(0, -1), present: prev, future: [h2.present, ...h2.future], base: null }
}

export function redo<T>(h: History<T>): History<T> {
  const next = h.future[0]
  if (next === undefined) return h
  return { past: [...h.past, h.present], present: next, future: h.future.slice(1), base: null }
}
