import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVault, type OpenVault } from '../src/vault/vault.ts'
import { folderBytes, validateVaultDeletion } from '../src/vault/manage.ts'

let directory: string
const vaults: OpenVault[] = []
beforeEach(() => {
  const fixtures = path.resolve('transcripts')
  fs.mkdirSync(fixtures, { recursive: true })
  directory = fs.mkdtempSync(path.join(fixtures, 'theia-manage-'))
})
afterEach(() => {
  for (const vault of vaults.splice(0)) if (vault.db.open) vault.db.close()
  fs.rmSync(directory, { recursive: true, force: true })
})
function vault(relative = 'Vault'): OpenVault {
  const created = createVault(path.join(directory, relative))
  vaults.push(created)
  return created
}

describe('vault deletion filesystem boundaries', () => {
  it('accepts an owned vault and returns its absolute canonical location, also after DB close', () => {
    const v = vault()
    expect(validateVaultDeletion(v, [v.layout.root])).toBe(fs.realpathSync.native(v.layout.root))
    v.db.close()
    expect(validateVaultDeletion(v, [])).toBe(fs.realpathSync.native(v.layout.root))
  })

  it('refuses a drive/share root and any ancestor or exact protected folder', () => {
    const v = vault()
    const actual = v.layout.root
    v.layout.root = path.parse(actual).root
    expect(() => validateVaultDeletion(v, [])).toThrow(/drive or share root/)
    v.layout.root = actual
    expect(() => validateVaultDeletion(v, [], [actual])).toThrow(/protected folder/)
    expect(() => validateVaultDeletion(v, [], [path.join(actual, 'Documents')])).toThrow(/protected folder/)
  })

  it('allows a vault beneath a protected workspace, but never the workspace itself', () => {
    const v = vault()
    expect(validateVaultDeletion(v, [], [directory])).toBe(fs.realpathSync.native(v.layout.root))
    expect(() => validateVaultDeletion(v, [], [path.join(v.layout.root, 'app')])).toThrow(/protected folder/)
  })

  it('refuses overlapping open vaults in either direction, including separator-safe sibling handling', () => {
    const parent = vault('Photo')
    const child = vault('Photo/Child')
    const sibling = vault('Photos')
    expect(() => validateVaultDeletion(parent, [child.layout.root])).toThrow(/overlaps/)
    expect(() => validateVaultDeletion(child, [parent.layout.root])).toThrow(/overlaps/)
    expect(validateVaultDeletion(parent, [sibling.layout.root])).toBe(fs.realpathSync.native(parent.layout.root))
  })

  it('refuses a replaced, malformed or missing manifest', () => {
    const v = vault()
    const manifest = path.join(v.layout.root, 'vault.json')
    fs.writeFileSync(manifest, JSON.stringify({ ...v.manifest, id: 'different' }))
    expect(() => validateVaultDeletion(v, [])).toThrow(/identity changed/)
    fs.writeFileSync(manifest, 'not json')
    expect(() => validateVaultDeletion(v, [])).toThrow(/identity file is unreadable/)
    fs.rmSync(manifest)
    expect(() => validateVaultDeletion(v, [])).toThrow()
  })

  it('refuses a database outside the owned folder', () => {
    const a = vault('One')
    const b = vault('Two')
    a.layout.db = b.layout.db
    expect(() => validateVaultDeletion(a, [])).toThrow(/database does not belong/)
  })

  it('refuses cache/media locations outside the owned folder', () => {
    const v = vault()
    v.layout.cache = directory
    expect(() => validateVaultDeletion(v, [])).toThrow(/data directory is outside/)
  })

  it('refuses root and descendant junctions without following or altering them', async () => {
    const v = vault()
    const outside = path.join(directory, 'Other')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'untouched')
    const linkedRoot = path.join(directory, 'Linked')
    fs.symlinkSync(v.layout.root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const originalRoot = v.layout.root
    v.layout.root = linkedRoot
    expect(() => validateVaultDeletion(v, [])).toThrow(/symbolic link or junction/)
    v.layout.root = originalRoot
    const junction = path.join(v.layout.root, 'escape')
    fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => validateVaultDeletion(v, [])).toThrow(/contains a symbolic link or junction/)
    await expect(folderBytes(v.layout.root)).rejects.toThrow(/symbolic links or junctions/)
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('untouched')
  })

  it('measures normal files and nested directories without changing their bytes', async () => {
    const root = path.join(directory, 'Data')
    fs.mkdirSync(path.join(root, 'Nested'), { recursive: true })
    fs.writeFileSync(path.join(root, 'a'), Buffer.alloc(25))
    fs.writeFileSync(path.join(root, 'Nested', 'b'), Buffer.alloc(50))
    expect(await folderBytes(root)).toBe(75)
  })
})
