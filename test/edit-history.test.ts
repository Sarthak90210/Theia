import { describe, expect, it } from 'vitest'
import { commit, drag, endDrag, redo, start, undo } from '../app/renderer/edit-history.ts'

describe('editor undo and redo', () => {
  it('undoes and redoes single changes', () => {
    let h = start(0)
    h = commit(h, 1)
    h = commit(h, 2)
    h = undo(h)
    expect(h.present).toBe(1)
    h = undo(h)
    expect(h.present).toBe(0)
    h = undo(h)
    expect(h.present).toBe(0)
    h = redo(h)
    expect(h.present).toBe(1)
    h = commit(h, 5)
    expect(h.future).toEqual([])
    expect(redo(h).present).toBe(5)
  })

  it('makes a whole drag one step', () => {
    let h = start(10)
    for (const v of [11, 14, 19, 23]) h = drag(h, v)
    h = endDrag(h)
    expect(h.past).toEqual([10])
    expect(undo(h).present).toBe(10)
  })

  it('records nothing for a drag that ends where it began, or a no-op commit', () => {
    let h = start(3)
    h = endDrag(drag(drag(h, 8), 3))
    expect(h.past).toEqual([])
    expect(commit(h, 3)).toBe(h)
  })

  it('ends a drag in progress before undoing', () => {
    let h = commit(start(1), 2)
    h = drag(h, 7)
    expect(undo(h).present).toBe(2)
  })
})
