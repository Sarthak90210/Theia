import type { GalleryItem } from '../shared/api.ts'

/**
 * A reloaded list, keeping the objects (and the array) that did not change.
 *
 * During a save into the open vault the list reloads every few seconds. Every
 * item arriving as a new object meant the whole grid laid out again and every
 * tile on screen rendered again, for a list that had grown by a few items.
 * Unchanged items keep their identity, so memoized tiles skip; an unchanged
 * list returns `prev` itself, so nothing downstream runs at all.
 */
export function reuseItems(prev: GalleryItem[] | null, next: GalleryItem[]): GalleryItem[] {
  if (!prev || !prev.length) return next
  const old = new Map<string, GalleryItem>()
  for (const it of prev) old.set(it.key, it)
  let same = prev.length === next.length
  const out = new Array<GalleryItem>(next.length)
  for (let i = 0; i < next.length; i++) {
    const n = next[i]!
    const o = old.get(n.key)
    const kept = o && sameItem(o, n) ? o : n
    out[i] = kept
    if (same && kept !== prev[i]) same = false
  }
  return same ? prev : out
}

function sameItem(a: GalleryItem, b: GalleryItem): boolean {
  return (
    a.kind === b.kind && a.t === b.t && a.off === b.off && a.w === b.w && a.h === b.h && a.dur === b.dur &&
    a.fav === b.fav && a.edited === b.edited && a.cloud === b.cloud && a.subtype === b.subtype &&
    (a.deletedAt ?? null) === (b.deletedAt ?? null) && a.frames === b.frames && a.revision === b.revision &&
    // Search highlights are rare and small; compare them by value.
    (a.marks === b.marks || (!!a.marks && !!b.marks && JSON.stringify(a.marks) === JSON.stringify(b.marks)))
  )
}
