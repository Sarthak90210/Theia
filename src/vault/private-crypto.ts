import crypto, { type KeyObject } from 'node:crypto'
import fs from 'node:fs'

/**
 * Encryption for a vault's Hidden and Recently Deleted items.
 *
 * Each vault has an X25519 key pair. Hiding or deleting needs only the public
 * key, so it never asks for the passcode; viewing, unhiding and recovering need
 * the private key, which is stored wrapped twice: once by the passcode and once
 * by a recovery key shown when protection is set up. Both are stretched with
 * scrypt.
 *
 * A file is encrypted with its own key: a one-time X25519 pair is made for it,
 * and HKDF turns the shared secret into an AES-256-GCM key. The content is cut
 * into 1 MiB chunks, each sealed with its index and an end-of-file flag, so a
 * video can be streamed and seeked without decrypting all of it, and a chunk
 * that is changed, moved, dropped or cut off fails to open.
 */

const MAGIC = Buffer.from('THEIA-ENC1', 'latin1')
export const CHUNK = 1024 * 1024
const TAG = 16
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }

export class WrongSecret extends Error {
  constructor() {
    super("That passcode or recovery key isn't right for this vault.")
    this.name = 'WrongSecret'
  }
}

/* ------------------------------------------------------------------ keys */

interface Wrapped {
  salt: string
  iv: string
  data: string
  tag: string
}

/** What a vault stores about its key pair. Safe to keep in plain sight. */
export interface VaultKeyFile {
  format: 'theia-vault-key'
  version: 1
  /** X25519 public key, SPKI DER, base64. */
  publicKey: string
  /** The private key, sealed by the passcode, and again by the recovery key. */
  byPasscode: Wrapped
  byRecoveryKey: Wrapped
  createdAt: string
}

const b64 = (b: Buffer) => b.toString('base64')
const unb64 = (s: string) => Buffer.from(s, 'base64')

function stretch(secret: string, salt: Buffer): Buffer {
  return crypto.scryptSync(secret.normalize('NFKC'), salt, 32, SCRYPT)
}

function wrap(secret: string, data: Buffer): Wrapped {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', stretch(secret, salt), iv)
  const out = Buffer.concat([c.update(data), c.final()])
  return { salt: b64(salt), iv: b64(iv), data: b64(out), tag: b64(c.getAuthTag()) }
}

function unwrap(secret: string, w: Wrapped): Buffer {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', stretch(secret, unb64(w.salt)), unb64(w.iv))
    d.setAuthTag(unb64(w.tag))
    return Buffer.concat([d.update(unb64(w.data)), d.final()])
  } catch {
    throw new WrongSecret()
  }
}

/** A recovery key people can write down: 25 characters in groups of five, no look-alikes. */
export function makeRecoveryKey(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const chars = Array.from({ length: 25 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('')
  return chars.match(/.{5}/g)!.join('-')
}

/** Recovery keys are typed back in by people: ignore spaces, dashes and case. */
const normalizeRecovery = (k: string) => k.toUpperCase().replace(/[^A-Z0-9]/g, '')

export function createVaultKeys(passcode: string): { file: VaultKeyFile; recoveryKey: string; privateKey: KeyObject; publicKey: KeyObject } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  const recoveryKey = makeRecoveryKey()
  const secret = privateKey.export({ format: 'der', type: 'pkcs8' })
  return {
    file: {
      format: 'theia-vault-key',
      version: 1,
      publicKey: b64(publicKey.export({ format: 'der', type: 'spki' })),
      byPasscode: wrap(passcode, secret),
      byRecoveryKey: wrap(normalizeRecovery(recoveryKey), secret),
      createdAt: new Date().toISOString(),
    },
    recoveryKey,
    privateKey,
    publicKey,
  }
}

export function publicKeyOf(file: VaultKeyFile): KeyObject {
  return crypto.createPublicKey({ key: unb64(file.publicKey), format: 'der', type: 'spki' })
}

/** The private key, from the passcode or the recovery key. Throws WrongSecret. */
export function unlockVaultKey(file: VaultKeyFile, secret: string): KeyObject {
  let der: Buffer
  try {
    der = unwrap(secret, file.byPasscode)
  } catch {
    der = unwrap(normalizeRecovery(secret), file.byRecoveryKey)
  }
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  // The pair must match, or files would encrypt to a key that can't open them.
  const pub = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' })
  if (!pub.equals(unb64(file.publicKey))) throw new WrongSecret()
  return key
}

/** A new passcode for the same key pair, given the current passcode or the recovery key. */
export function changePasscode(file: VaultKeyFile, secret: string, next: string): VaultKeyFile {
  const key = unlockVaultKey(file, secret)
  return { ...file, byPasscode: wrap(next, key.export({ format: 'der', type: 'pkcs8' })) }
}

/* ----------------------------------------------------------------- files */

function contentKey(shared: Buffer, ephemeralDer: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', shared, ephemeralDer, 'theia vault file v1', 32))
}

function nonce(index: number): Buffer {
  const n = Buffer.alloc(12)
  n.writeBigUInt64BE(BigInt(index), 4)
  return n
}

function aad(header: Buffer, index: number, last: boolean): Buffer {
  const tail = Buffer.alloc(9)
  tail.writeBigUInt64BE(BigInt(index), 0)
  tail[8] = last ? 1 : 0
  return Buffer.concat([header, tail])
}

function buildHeader(ephemeralDer: Buffer, chunk: number, size: number): Buffer {
  const h = Buffer.alloc(MAGIC.length + 2 + ephemeralDer.length + 4 + 8)
  let o = MAGIC.copy(h, 0)
  h.writeUInt16BE(ephemeralDer.length, o)
  o += 2
  o += ephemeralDer.copy(h, o)
  h.writeUInt32BE(chunk, o)
  o += 4
  h.writeBigUInt64BE(BigInt(size), o)
  return h
}

/**
 * Encrypt `src` to `dst` for the vault's public key. Written to a temporary
 * name and renamed, so a half-written blob never looks complete. Returns the
 * plaintext's size and SHA-256.
 */
export async function encryptFile(src: string, dst: string, vaultPublic: KeyObject, chunk = CHUNK): Promise<{ size: number; sha256: string }> {
  if (!Number.isSafeInteger(chunk) || chunk < 1 || chunk > 16 * CHUNK) throw new Error('Invalid encryption chunk size.')
  if (await exists(dst)) throw new Error('The encrypted destination already exists; nothing was overwritten.')
  // All file work here is asynchronous. This runs in Electron's main process,
  // and hiding a big video with synchronous reads, writes and fsync froze the
  // window for the whole of it (measured 0.7 s per 300 MB on an SSD, several
  // times that on a USB hard drive).
  const inFh = await fs.promises.open(src, 'r')
  let outFh: fs.promises.FileHandle | null = null
  const tmp = `${dst}.${crypto.randomUUID()}.tmp`
  let key: Buffer
  let size: number
  const hash = crypto.createHash('sha256')
  try {
    size = (await inFh.stat()).size
    const eph = crypto.generateKeyPairSync('x25519')
    const ephDer = eph.publicKey.export({ format: 'der', type: 'spki' })
    key = contentKey(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: vaultPublic }), ephDer)
    const header = buildHeader(ephDer, chunk, size)
    const chunks = Math.max(1, Math.ceil(size / chunk))
    outFh = await fs.promises.open(tmp, 'wx')
    try {
      await writeAll(outFh, header)
      const buf = Buffer.alloc(chunk)
      for (let i = 0; i < chunks; i++) {
        const want = Math.min(chunk, size - i * chunk)
        const n = await readFully(inFh, buf, want, i * chunk)
        if (n !== want) throw new Error('The file changed size while it was being encrypted; nothing was changed.')
        const plain = buf.subarray(0, n)
        hash.update(plain)
        const c = crypto.createCipheriv('aes-256-gcm', key, nonce(i))
        c.setAAD(aad(header, i, i === chunks - 1))
        await writeAll(outFh, Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]))
      }
      await outFh.sync()
    } catch (e) {
      await outFh.close().catch(() => {})
      outFh = null
      await fs.promises.rm(tmp, { force: true })
      throw e
    }
  } finally {
    await inFh.close().catch(() => {})
    await outFh?.close().catch(() => {})
  }
  const sha256 = hash.digest('hex')
  // Read it back before anyone relies on it. Only the public key is around
  // while hiding, so check with this file's own key instead of the vault's.
  // A failure to read it back (a USB drive unplugged, say) also removes it.
  const readBack = await shaWithKey(tmp, key).catch(async (e: unknown) => {
    await fs.promises.rm(tmp, { force: true })
    throw e
  })
  if (readBack !== sha256) {
    await fs.promises.rm(tmp, { force: true })
    throw new Error('the encrypted copy did not read back the same; nothing was changed')
  }
  await publishWithoutReplacing(tmp, dst)
  return { size, sha256 }
}

function exists(file: string): Promise<boolean> {
  return fs.promises.access(file).then(() => true, () => false)
}

/** `length` bytes at `position`, or fewer only at the end of the file. */
async function readFully(fh: fs.promises.FileHandle, buf: Buffer, length: number, position: number): Promise<number> {
  let done = 0
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done)
    if (!bytesRead) break
    done += bytesRead
  }
  return done
}

async function writeAll(fh: fs.promises.FileHandle, bytes: Buffer): Promise<void> {
  for (let off = 0; off < bytes.length; ) off += (await fh.write(bytes, off, bytes.length - off)).bytesWritten
}

/** fs.read on a plain descriptor, as a promise: the reader's chunk reads stay off the main thread. */
function readAt(fd: number, buf: Buffer, length: number, position: number): Promise<number> {
  return new Promise((resolve, reject) => fs.read(fd, buf, 0, length, position, (e, n) => (e ? reject(e) : resolve(n))))
}

/** An encrypted file opened for reading: any range, decrypting only the chunks it covers. */
export interface EncryptedReader {
  size: number
  read(start: number, length: number): Promise<Buffer>
  close(): void
}

export function openEncrypted(blob: string, vaultPrivate: KeyObject): EncryptedReader {
  return openWith(blob, (ephDer) => {
    const eph = crypto.createPublicKey({ key: ephDer, format: 'der', type: 'spki' })
    return contentKey(crypto.diffieHellman({ privateKey: vaultPrivate, publicKey: eph }), ephDer)
  })
}

async function shaWithKey(blob: string, key: Buffer): Promise<string> {
  const r = openWith(blob, () => key)
  const hash = crypto.createHash('sha256')
  try {
    for (let pos = 0; pos < r.size; pos += CHUNK) hash.update(await r.read(pos, CHUNK))
  } finally {
    r.close()
  }
  return hash.digest('hex')
}

function openWith(blob: string, keyFor: (ephemeralDer: Buffer) => Buffer): EncryptedReader {
  const fd = fs.openSync(blob, 'r')
  try {
    const fixed = Buffer.alloc(MAGIC.length + 2)
    if (fs.readSync(fd, fixed, 0, fixed.length, 0) !== fixed.length) throw new Error('Truncated encrypted header.')
    if (!fixed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a Theia encrypted file')
    const ephLen = fixed.readUInt16BE(MAGIC.length)
    if (ephLen !== 44) throw new Error('Invalid encrypted key header.')
    const header = Buffer.alloc(MAGIC.length + 2 + ephLen + 12)
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) throw new Error('Truncated encrypted header.')
    const ephDer = header.subarray(MAGIC.length + 2, MAGIC.length + 2 + ephLen)
    const chunk = header.readUInt32BE(MAGIC.length + 2 + ephLen)
    const size = Number(header.readBigUInt64BE(MAGIC.length + 2 + ephLen + 4))
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(chunk) || chunk < 1 || chunk > 16 * CHUNK) throw new Error('Invalid encrypted content dimensions.')
    const chunks = Math.max(1, Math.ceil(size / chunk))
    const expected = header.length + size + chunks * TAG
    if (fs.fstatSync(fd).size !== expected) throw new Error('encrypted file is the wrong length (cut off or padded)')
    const key = keyFor(Buffer.from(ephDer))

    const open = (i: number, sealed: Buffer): Buffer => {
      const plainLen = sealed.length - TAG
      const d = crypto.createDecipheriv('aes-256-gcm', key, nonce(i))
      d.setAAD(aad(header, i, i === chunks - 1))
      d.setAuthTag(sealed.subarray(plainLen))
      try {
        return Buffer.concat([d.update(sealed.subarray(0, plainLen)), d.final()])
      } catch {
        throw new Error('encrypted file is damaged or was opened with the wrong key')
      }
    }

    const sealedLength = (i: number) => (i === chunks - 1 ? size - i * chunk : chunk) + TAG
    // Empty files still carry an authentication tag. It must not be skipped.
    if (size === 0) {
      const sealed = Buffer.alloc(TAG)
      if (fs.readSync(fd, sealed, 0, TAG, header.length) !== TAG) throw new Error('Encrypted content was cut off while reading.')
      open(0, sealed)
    }
    // Chunks are read asynchronously, so playing a hidden video or checking a
    // big file doesn't hold the main thread. The descriptor closes only once
    // no read is using it: closing under a pending read could let the number
    // be reused by another file and read from that instead.
    let closed = false
    let pending = 0
    const release = () => {
      if (closed && pending === 0) {
        key.fill(0)
        fs.close(fd, () => {})
      }
    }
    const chunkPlain = async (i: number): Promise<Buffer> => {
      const sealed = Buffer.alloc(sealedLength(i))
      let n = 0
      while (n < sealed.length) {
        const got = await readAt(fd, sealed.subarray(n), sealed.length - n, header.length + i * (chunk + TAG) + n)
        if (!got) break
        n += got
      }
      if (n !== sealed.length) throw new Error('Encrypted content was cut off while reading.')
      return open(i, sealed)
    }
    return {
      size,
      async read(start, length) {
        if (closed) throw new Error('Encrypted reader is closed.')
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0) throw new Error('Invalid encrypted read range.')
        const end = Math.min(size, start + length)
        if (start >= end) return Buffer.alloc(0)
        pending++
        try {
          const parts: Buffer[] = []
          for (let i = Math.floor(start / chunk); i * chunk < end; i++) {
            if (closed) throw new Error('Encrypted reader is closed.')
            const p = await chunkPlain(i)
            const from = Math.max(0, start - i * chunk)
            const to = Math.min(p.length, end - i * chunk)
            parts.push(p.subarray(from, to))
          }
          return Buffer.concat(parts)
        } finally {
          pending--
          release()
        }
      },
      close: () => {
        if (closed) return
        closed = true
        release()
      },
    }
  } catch (e) {
    fs.closeSync(fd)
    throw e
  }
}

/** Decrypt a whole blob to `dst` (temporary name, then renamed). Returns the plaintext SHA-256. */
export async function decryptFile(blob: string, dst: string, vaultPrivate: KeyObject): Promise<string> {
  if (await exists(dst)) throw new Error('The restore destination already exists; nothing was overwritten.')
  const r = openEncrypted(blob, vaultPrivate)
  const tmp = `${dst}.${crypto.randomUUID()}.tmp`
  const hash = crypto.createHash('sha256')
  let fh: fs.promises.FileHandle
  try { fh = await fs.promises.open(tmp, 'wx') }
  catch (e) { r.close(); throw e }
  try {
    for (let pos = 0; pos < r.size; pos += CHUNK) {
      const b = await r.read(pos, CHUNK)
      hash.update(b)
      await writeAll(fh, b)
    }
    await fh.sync()
  } catch (e) {
    await fh.close().catch(() => {})
    await fs.promises.rm(tmp, { force: true })
    r.close()
    throw e
  }
  await fh.close()
  r.close()
  await publishWithoutReplacing(tmp, dst)
  return hash.digest('hex')
}

/** An exclusive publication prevents a late-created unrelated file being overwritten. */
async function publishWithoutReplacing(tmp: string, dst: string): Promise<void> {
  try {
    try { await fs.promises.link(tmp, dst) }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw e
      // Drives without hard links (exFAT, FAT): a whole copy, so not on the main thread.
      await fs.promises.copyFile(tmp, dst, fs.constants.COPYFILE_EXCL)
    }
    const fh = await fs.promises.open(dst, 'r+')
    try { await fh.sync() } finally { await fh.close() }
  } finally { await fs.promises.rm(tmp, { force: true }) }
}

/** Decrypt and hash without writing anything: proves a blob opens and holds those bytes. */
export async function encryptedSha256(blob: string, vaultPrivate: KeyObject): Promise<string> {
  const r = openEncrypted(blob, vaultPrivate)
  const hash = crypto.createHash('sha256')
  try {
    for (let pos = 0; pos < r.size; pos += CHUNK) hash.update(await r.read(pos, CHUNK))
  } finally {
    r.close()
  }
  return hash.digest('hex')
}
