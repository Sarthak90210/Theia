import { describe, expect, it } from 'vitest'
import { displayFile } from '../src/gallery/vault-gallery.ts'

const f = (id: number, role: string, mime: string, primary = false) => ({ id, path: `p${id}`, role, mime, sha256: `s${id}`, bytes: 1, primary })

describe('which vault file is drawn', () => {
  it('shows the edited render by default, like the phone', () => {
    const files = [f(1, 'master', 'image/heic', true), f(2, 'render', 'image/jpeg'), f(3, 'sidecar', 'application/xml')]
    expect(displayFile(files, null)?.id).toBe(2)
  })
  it('does not let an edited Live Photo video stand in for the still', () => {
    const files = [f(1, 'master', 'image/heic', true), f(2, 'render', 'video/quicktime')]
    expect(displayFile(files, null)?.id).toBe(1)
  })
  it('gives a particular file when asked, for burst frames', () => {
    const files = [f(1, 'master', 'image/heic', true), f(2, 'master', 'image/heic'), f(3, 'master', 'image/heic')]
    expect(displayFile(files, 3)?.id).toBe(3)
    expect(displayFile(files, 9)).toBeNull()
  })
})
