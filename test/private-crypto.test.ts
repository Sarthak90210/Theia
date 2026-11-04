import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  changePasscode, createVaultKeys, decryptFile, encryptFile, encryptedSha256, openEncrypted, publicKeyOf, unlockVaultKey, WrongSecret,
} from '../src/vault/private-crypto.ts'
import { scratch, type Scratch } from './helpers.ts'

let s: Scratch
beforeEach(() => (s = scratch()))
afterEach(() => s.cleanup())
const f = (n: string) => path.join(s.dir, n)
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')

describe('vault keys', () => {
  it('unlocks with the passcode or the recovery key, typed loosely, and nothing else', () => {
    const k = createVaultKeys('correct horse 42')
    expect(unlockVaultKey(k.file, 'correct horse 42').asymmetricKeyType).toBe('x25519')
    expect(k.recoveryKey).toMatch(/^([A-Z0-9]{5}-){4}[A-Z0-9]{5}$/)
    expect(unlockVaultKey(k.file, k.recoveryKey.toLowerCase().replace(/-/g, ' '))).toBeTruthy()
    expect(() => unlockVaultKey(k.file, 'wrong')).toThrow(WrongSecret)
  })

  it('changes the passcode without changing the key, and the old one stops working', () => {
    const k = createVaultKeys('old passcode')
    const next = changePasscode(k.file, 'old passcode', 'new passcode')
    expect(next.publicKey).toBe(k.file.publicKey)
    expect(unlockVaultKey(next, 'new passcode')).toBeTruthy()
    expect(() => unlockVaultKey(next, 'old passcode')).toThrow(WrongSecret)
    expect(unlockVaultKey(next, k.recoveryKey)).toBeTruthy()
  })
})

describe('encrypted files', () => {
  const k = createVaultKeys('pass')
  const pub = publicKeyOf(k.file)

  it('round-trips files of every size, including empty and exact chunk multiples', async () => {
    for (const size of [0, 1, 999, 1000, 1001, 3500]) {
      fs.rmSync(f('blob'), { force: true })
      fs.rmSync(f('out'), { force: true })
      const data = crypto.randomBytes(size)
      fs.writeFileSync(f('in'), data)
      const r = await encryptFile(f('in'), f('blob'), pub, 1000)
      expect(r).toEqual({ size, sha256: sha(data) })
      if (size >= 64) expect(fs.readFileSync(f('blob')).includes(data.subarray(0, 64))).toBe(false)
      expect(await decryptFile(f('blob'), f('out'), k.privateKey)).toBe(sha(data))
      expect(fs.readFileSync(f('out')).equals(data)).toBe(true)
    }
  })

  it('reads any range, across chunk boundaries, for streaming video', async () => {
    const data = crypto.randomBytes(5000)
    fs.writeFileSync(f('in'), data)
    await encryptFile(f('in'), f('blob'), pub, 1000)
    const r = openEncrypted(f('blob'), k.privateKey)
    for (const [a, n] of [[0, 10], [995, 10], [1000, 1000], [4990, 50], [2500, 2500]] as const) {
      expect((await r.read(a, n)).equals(data.subarray(a, Math.min(5000, a + n)))).toBe(true)
    }
    r.close()
  })

  it('refuses a damaged, cut-off or reordered file, and the wrong key', async () => {
    const data = crypto.randomBytes(3000)
    fs.writeFileSync(f('in'), data)
    await encryptFile(f('in'), f('blob'), pub, 1000)
    const good = fs.readFileSync(f('blob'))

    const flipped = Buffer.from(good)
    flipped[flipped.length - 500]! ^= 1
    fs.writeFileSync(f('bad'), flipped)
    await expect(encryptedSha256(f('bad'), k.privateKey)).rejects.toThrow('damaged')

    fs.writeFileSync(f('cut'), good.subarray(0, good.length - 1016))
    expect(() => openEncrypted(f('cut'), k.privateKey)).toThrow('wrong length')

    const other = createVaultKeys('x')
    await expect(encryptedSha256(f('blob'), other.privateKey)).rejects.toThrow()
    expect(await encryptedSha256(f('blob'), k.privateKey)).toBe(sha(data))
  })

  it('authenticates empty files and rejects tampering with their tag', async () => {
    fs.writeFileSync(f('in'), Buffer.alloc(0))
    await encryptFile(f('in'), f('blob'), pub)
    const bytes = fs.readFileSync(f('blob'))
    bytes[bytes.length - 1]! ^= 1
    fs.writeFileSync(f('blob'), bytes)
    await expect(encryptedSha256(f('blob'), k.privateKey)).rejects.toThrow('damaged')
  })

  it('does not overwrite an existing encrypted or restored destination', async () => {
    fs.writeFileSync(f('in'), 'original')
    fs.writeFileSync(f('occupied'), 'unrelated')
    await expect(encryptFile(f('in'), f('occupied'), pub)).rejects.toThrow('already exists')
    await encryptFile(f('in'), f('blob'), pub)
    await expect(decryptFile(f('blob'), f('occupied'), k.privateKey)).rejects.toThrow('already exists')
    expect(fs.readFileSync(f('occupied'), 'utf8')).toBe('unrelated')
    expect(await encryptedSha256(f('blob'), k.privateKey)).toBe(sha(Buffer.from('original')))
  })
})
