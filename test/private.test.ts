import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVault, type OpenVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveFile, type SaveItem } from '../src/vault/save.ts'
import { finishPrivateCleanup, openProtected, privacyWork, privateDir, protectAsset, readKeyFile, releaseAsset, setUpProtection, sweepPrivate } from '../src/vault/private.ts'
import { publicKeyOf, unlockVaultKey, WrongSecret } from '../src/vault/private-crypto.ts'
import { purgeAssets, trashAssets } from '../src/vault/delete.ts'
import { thumbPath } from '../src/thumbs/render.ts'
import { vaultFiles, vaultItems } from '../src/gallery/vault-gallery.ts'
import { scratch, type Scratch } from './helpers.ts'

let s: Scratch
let v: OpenVault
beforeEach(() => {
  s = scratch()
  v = createVault(path.join(s.dir, 'V'))
})
afterEach(() => {
  v.db.close()
  s.cleanup()
})

const file = (name: string, bytes: Buffer, role: SaveFile['role'] = 'master', mime = 'image/jpeg'): SaveFile => ({
  name,
  role,
  mime,
  size: bytes.length,
  sha256: null,
  read: async function* () {
    yield bytes
  },
})

async function livePhoto() {
  const still = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#d24' } }).jpeg().toBuffer()
  // A second file the save takes as it is: an edit recipe.
  const motion = Buffer.from('<?xml version="1.0"?><plist><dict><key>adjustmentFormatVersion</key><string>1.4</string></dict></plist>'.repeat(40))
  const item: SaveItem = {
    key: 'l', kind: 'live', t: Date.UTC(2026, 1, 2), off: 0, w: 60, h: 40, dur: null, fav: false, edited: false, subtype: null,
    sourceUuid: 'live-1', lat: null, lon: null, cloud: false,
    files: [file('IMG_0001.JPG', still), file('IMG_0001.AAE', motion, 'sidecar', 'application/xml')],
  }
  await saveToVault(v, [item], [
    { uuid: 'a1', name: 'Goa', keys: ['l'] },
    { uuid: 'a2', name: 'Family', keys: ['l'] },
  ])
  const id = Number(vaultItems(v.db, 'library')[0]!.key)
  return { id, still, motion }
}

const everyFile = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? everyFile(path.join(dir, e.name)) : [path.join(dir, e.name)]))

describe('Hidden and Recently Deleted are encrypted', () => {
  it('protects every file and copy of an item, and brings it all back byte for byte', async () => {
    const { id, still, motion } = await livePhoto()
    const { recoveryKey } = setUpProtection(v.layout, 'secret 123')
    const key = readKeyFile(v.layout)!
    // A thumbnail that would otherwise show the hidden picture.
    const sha = vaultFiles(v.db, String(id)).find((f) => f.role === 'master')!.sha256
    fs.mkdirSync(path.dirname(thumbPath(v.layout.cache, sha, 'sm')), { recursive: true })
    fs.writeFileSync(thumbPath(v.layout.cache, sha, 'sm'), 'thumb')

    v.db.prepare('UPDATE asset SET hidden = 1 WHERE id = ?').run(id)
    expect(privacyWork(v.db).protect).toEqual([id])
    await protectAsset(v, id, publicKeyOf(key))

    // No plain copy of either file is left anywhere in the vault folder.
    for (const p of everyFile(v.layout.root)) {
      const b = fs.readFileSync(p)
      expect(b.equals(still) || b.equals(motion)).toBe(false)
    }
    expect(fs.existsSync(path.join(v.layout.root, 'Goa', 'IMG_0001.JPG'))).toBe(false)
    expect(fs.existsSync(path.join(v.layout.root, 'Family', 'IMG_0001.AAE'))).toBe(false)
    expect(fs.existsSync(thumbPath(v.layout.cache, sha, 'sm'))).toBe(false)
    const blobs = fs.readdirSync(privateDir(v.layout)).filter((n) => n.endsWith('.theia'))
    expect(blobs).toHaveLength(2)
    for (const n of blobs) expect(fs.readFileSync(path.join(privateDir(v.layout), n)).includes(still.subarray(0, 64))).toBe(false)
    expect(privacyWork(v.db).protect).toEqual([])

    // Unhiding needs the key. The wrong passcode gets nothing.
    expect(() => unlockVaultKey(key, 'nope')).toThrow(WrongSecret)
    v.db.prepare('UPDATE asset SET hidden = 0 WHERE id = ?').run(id)
    expect(privacyWork(v.db).release).toEqual([id])
    await releaseAsset(v, id, unlockVaultKey(key, recoveryKey))
    expect(fs.readFileSync(path.join(v.layout.root, 'Goa', 'IMG_0001.JPG')).equals(still)).toBe(true)
    expect(fs.readFileSync(path.join(v.layout.root, 'Family', 'IMG_0001.AAE')).equals(motion)).toBe(true)
    expect(fs.readdirSync(privateDir(v.layout)).filter((n) => n.endsWith('.theia'))).toHaveLength(0)
  })

  it('deletes a protected item for good by recycling its encrypted copies', async () => {
    const { id } = await livePhoto()
    setUpProtection(v.layout, 'secret 123')
    trashAssets(v.db, [id])
    await protectAsset(v, id, publicKeyOf(readKeyFile(v.layout)!))
    const recycled: string[] = []
    const r = await purgeAssets(
      v.db,
      v.layout.media,
      [id],
      async (p) => {
        recycled.push(p)
        fs.rmSync(p)
      },
      privateDir(v.layout),
    )
    expect(r.removed).toBe(1)
    expect(recycled).toHaveLength(2)
    expect(recycled.every((p) => p.endsWith('.theia'))).toBe(true)
  })

  it('recovers from a crash at any step without losing a file', async () => {
    const { id, still } = await livePhoto()
    setUpProtection(v.layout, 'secret 123')
    const pub = publicKeyOf(readKeyFile(v.layout)!)
    // Unreferenced blobs may be the sole recovery copy after a database rollback.
    fs.writeFileSync(path.join(privateDir(v.layout), 'stray.theia'), 'x')
    fs.writeFileSync(path.join(privateDir(v.layout), 'half.theia.123.tmp'), 'x')
    expect(sweepPrivate(v).orphans).toBe(2)
    expect(fs.readdirSync(privateDir(v.layout)).some((n) => n.includes('stray'))).toBe(true)
    expect(fs.readFileSync(path.join(v.layout.root, 'Goa', 'IMG_0001.JPG')).equals(still)).toBe(true)

    // Startup inventories plaintext; only a successful unlock/authentication removes it.
    v.db.prepare('UPDATE asset SET hidden = 1 WHERE id = ?').run(id)
    await protectAsset(v, id, pub)
    fs.mkdirSync(path.join(v.layout.root, 'Goa'), { recursive: true })
    fs.writeFileSync(path.join(v.layout.root, 'Goa', 'IMG_0001.JPG'), still)
    expect(sweepPrivate(v).leftovers).toBe(1)
    expect(fs.existsSync(path.join(v.layout.root, 'Goa', 'IMG_0001.JPG'))).toBe(true)
    await finishPrivateCleanup(v, unlockVaultKey(readKeyFile(v.layout)!, 'secret 123'))
    expect(fs.existsSync(path.join(v.layout.root, 'Goa', 'IMG_0001.JPG'))).toBe(false)
  })

  it('keeps the last plaintext copy if its referenced encrypted backup is missing or damaged', async () => {
    const { id, still } = await livePhoto()
    const { privateKey } = setUpProtection(v.layout, 'secret 123')
    v.db.prepare('UPDATE asset SET hidden = 1 WHERE id = ?').run(id)
    await protectAsset(v, id, publicKeyOf(readKeyFile(v.layout)!))
    const row = v.db.prepare(`SELECT path, encrypted_path FROM file WHERE asset_id = ? AND role = 'master'`).get(id) as { path: string; encrypted_path: string }
    const original = path.join(v.layout.media, row.path)
    fs.writeFileSync(original, still)
    const blob = path.join(privateDir(v.layout), row.encrypted_path)
    fs.writeFileSync(blob, 'damaged backup')
    sweepPrivate(v)
    await expect(finishPrivateCleanup(v, privateKey)).rejects.toThrow()
    expect(fs.readFileSync(original)).toEqual(still)
    fs.rmSync(blob)
    expect(sweepPrivate(v).missing).toContain(row.path)
    await expect(finishPrivateCleanup(v, privateKey)).rejects.toThrow()
    expect(fs.readFileSync(original)).toEqual(still)
  })

  it('refuses to restore over an unrelated file, retaining the encrypted original', async () => {
    const { id } = await livePhoto()
    const { privateKey } = setUpProtection(v.layout, 'secret 123')
    v.db.prepare('UPDATE asset SET hidden = 1 WHERE id = ?').run(id)
    await protectAsset(v, id, publicKeyOf(readKeyFile(v.layout)!))
    const row = v.db.prepare(`SELECT path, encrypted_path FROM file WHERE asset_id = ? AND role = 'master'`).get(id) as { path: string; encrypted_path: string }
    const target = path.join(v.layout.media, row.path)
    fs.writeFileSync(target, 'unrelated replacement')
    await expect(releaseAsset(v, id, privateKey)).rejects.toThrow('nothing was overwritten')
    expect(fs.readFileSync(target, 'utf8')).toBe('unrelated replacement')
    expect(fs.existsSync(path.join(privateDir(v.layout), row.encrypted_path))).toBe(true)
  })

  it('removes hidden paths when equal bytes also belong to a visible item at another path', async () => {
    const { id, still } = await livePhoto()
    const { privateKey } = setUpProtection(v.layout, 'secret 123')
    const row = v.db.prepare(`SELECT sha256 FROM file WHERE asset_id = ? AND role = 'master'`).get(id) as { sha256: string }
    const other = Number(v.db.prepare(`INSERT INTO asset (kind, created_at, updated_at) VALUES ('still', 1, 1)`).run().lastInsertRowid)
    fs.mkdirSync(path.join(v.layout.media, 'Other'))
    fs.writeFileSync(path.join(v.layout.media, 'Other', 'duplicate.JPG'), still)
    v.db.prepare(`INSERT INTO file (asset_id, role, is_primary, path, bytes, sha256, mime, created_at) VALUES (?, 'master', 1, 'Other/duplicate.JPG', ?, ?, 'image/jpeg', 1)`).run(other, still.length, row.sha256)
    v.db.prepare('UPDATE asset SET hidden = 1 WHERE id = ?').run(id)
    await protectAsset(v, id, publicKeyOf(readKeyFile(v.layout)!))
    expect(fs.existsSync(path.join(v.layout.media, 'Goa', 'IMG_0001.JPG'))).toBe(false)
    expect(fs.existsSync(path.join(v.layout.media, 'Family', 'IMG_0001.JPG'))).toBe(false)
    expect(fs.readFileSync(path.join(v.layout.media, 'Other', 'duplicate.JPG'))).toEqual(still)
    await finishPrivateCleanup(v, privateKey)
  })

  it('does not claim a hidden path is protected when a visible item owns that same album path', async () => {
    const { id, still } = await livePhoto()
    setUpProtection(v.layout, 'secret 123')
    const row = v.db.prepare(`SELECT sha256 FROM file WHERE asset_id = ? AND role = 'master'`).get(id) as { sha256: string }
    const other = Number(v.db.prepare(`INSERT INTO asset (kind, created_at, updated_at) VALUES ('still', 1, 1)`).run().lastInsertRowid)
    v.db.prepare(`INSERT INTO file (asset_id, role, is_primary, path, bytes, sha256, mime, created_at) VALUES (?, 'master', 1, 'Family/IMG_0001.JPG', ?, ?, 'image/jpeg', 1)`).run(other, still.length, row.sha256)
    v.db.prepare('UPDATE asset SET hidden = 1 WHERE id = ?').run(id)
    await expect(protectAsset(v, id, publicKeyOf(readKeyFile(v.layout)!))).rejects.toThrow('shared with a visible item')
    expect(fs.readFileSync(path.join(v.layout.media, 'Family', 'IMG_0001.JPG'))).toEqual(still)
  })

  it('refuses path traversal and junctions instead of touching outside files', async () => {
    const { id, still } = await livePhoto()
    const { privateKey } = setUpProtection(v.layout, 'secret 123')
    const outside = path.join(s.dir, 'outside.JPG')
    fs.writeFileSync(outside, still)
    v.db.prepare(`UPDATE file SET path = '../outside.JPG' WHERE asset_id = ? AND role = 'master'`).run(id)
    await expect(protectAsset(v, id, publicKeyOf(readKeyFile(v.layout)!))).rejects.toThrow('Unsafe path')
    expect(fs.readFileSync(outside)).toEqual(still)
    expect(() => openProtected(v.layout, '../outside.JPG', privateKey)).toThrow('Unsafe encrypted-file')
    v.db.prepare(`UPDATE file SET path = 'Link/outside.JPG' WHERE asset_id = ? AND role = 'master'`).run(id)
    fs.symlinkSync(s.dir, path.join(v.layout.media, 'Link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(protectAsset(v, id, publicKeyOf(readKeyFile(v.layout)!))).rejects.toThrow('symbolic link or junction')
    expect(fs.readFileSync(outside)).toEqual(still)
  })

  it('does not overwrite a damaged existing key file during a new setup', () => {
    setUpProtection(v.layout, 'secret 123')
    const key = path.join(privateDir(v.layout), 'key.json')
    fs.writeFileSync(key, '{broken')
    expect(() => readKeyFile(v.layout)).toThrow()
    expect(() => setUpProtection(v.layout, 'new password')).toThrow()
    expect(fs.readFileSync(key, 'utf8')).toBe('{broken')
  })

  it('removes full-preview and video variants for the exact hash, including old versions', async () => {
    const { id } = await livePhoto()
    setUpProtection(v.layout, 'secret 123')
    const sha = vaultFiles(v.db, String(id)).find(f => f.role === 'master')!.sha256
    const cached = [
      `full/${sha}.jpg`, `full/${sha}-v1.jpg`, `full/${sha}-v2.jpg`, `full/${sha}-v2.jpg.123.tmp`,
      `video/${sha}.mp4`, `video/${sha}.mp4.part.mp4`, `video/${sha}-frames.jpg`, `video/${sha}-frames.jpg.json`,
      `thumbs/v1/${sha.slice(0, 2)}/${sha}-sm.webp`,
    ].map(relative => path.join(v.layout.cache, relative))
    const unrelated = path.join(v.layout.cache, 'full', `${sha}b-v2.jpg`)
    for (const file of [...cached, unrelated]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'cached preview') }
    v.db.prepare('UPDATE asset SET hidden = 1 WHERE id = ?').run(id)
    await protectAsset(v, id, publicKeyOf(readKeyFile(v.layout)!))
    for (const file of cached) expect(fs.existsSync(file)).toBe(false)
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('cached preview')
  })

  it('refuses a passcode that is too short, and a second setup', () => {
    expect(() => setUpProtection(v.layout, '123')).toThrow('at least 6')
    setUpProtection(v.layout, '123456')
    expect(() => setUpProtection(v.layout, 'another')).toThrow('already protected')
  })
})
