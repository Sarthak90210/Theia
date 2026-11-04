import { describe, expect, it } from 'vitest'
import { SaveProgressTracker, type SaveProgress } from '../src/vault/save-progress.ts'

function tracker(plans: { files: { name: string; size: number | null }[]; skip: boolean }[]) {
  let t = 0
  const seen: SaveProgress[] = []
  const p = new SaveProgressTracker(plans, () => t, (x) => seen.push(x))
  return { p, seen, advance: (ms: number) => (t += ms), last: () => seen.at(-1)! }
}

describe('time remaining while saving', () => {
  it('estimates from the recent rate, counting the read-back check as work', () => {
    const { p, advance, last } = tracker([
      { files: [{ name: 'a.heic', size: 1000 }], skip: false },
      { files: [{ name: 'b.heic', size: 1000 }], skip: false },
    ])
    p.startItem(0, 'a')
    const f = p.file(0, 0)
    f.beginAttempt()
    advance(2000)
    f.copied(500)
    // 500 bytes in 2 s is 250 B/s; 3500 of the 4000 bytes of work (copy + check of both) remain.
    expect(last().etaMs).toBe(14000)
    expect(last().bytesTotal).toBe(2000)
    expect(last().bytesPerSecond).toBe(250)
    p.close()
  })

  it('stays quiet during warm-up instead of guessing', () => {
    const { p, advance, last } = tracker([{ files: [{ name: 'a', size: 1000 }], skip: false }])
    p.startItem(0, 'a')
    const f = p.file(0, 0)
    f.beginAttempt()
    advance(300)
    f.copied(100)
    expect(last().etaMs).toBeNull()
    p.close()
  })

  it('leaves out items that are skipped (already in the vault, or only in iCloud)', () => {
    const { p, advance, last } = tracker([
      { files: [{ name: 'a', size: 1000 }], skip: true },
      { files: [{ name: 'b', size: 1000 }], skip: false },
    ])
    p.startItem(1, 'b')
    const f = p.file(1, 0)
    f.beginAttempt()
    advance(1000)
    f.copied(1000)
    f.verifying()
    expect(last().phase).toBe('verifying')
    // Left: the read-back of b only.
    expect(last().etaMs).toBe(1000)
    p.close()
  })

  it('does not count a retried file twice', () => {
    const { p, advance, last } = tracker([{ files: [{ name: 'a', size: 1000 }], skip: false }])
    p.startItem(0, 'a')
    const f = p.file(0, 0)
    f.beginAttempt()
    advance(1000)
    f.copied(800)
    f.beginAttempt() // the link dropped; start the file again
    expect(last().bytesDone).toBe(0)
    advance(1000)
    f.copied(400)
    expect(last().bytesDone).toBe(400)
    p.close()
  })

  it('reads zero once everything is done', () => {
    const { p, last } = tracker([{ files: [{ name: 'a', size: 10 }], skip: false }])
    p.startItem(0, 'a')
    p.itemDone()
    p.complete()
    expect(last().etaMs).toBe(0)
    p.close()
  })
})
