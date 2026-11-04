import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDevice } from '../src/device/fake-device.ts'
import type { DeviceSource } from '../src/device/types.ts'
import { toAppleSeconds } from '../src/gallery/phone-library.ts'
import { PhoneSession } from '../src/gallery/phone-session.ts'
import { scratch, type Scratch } from './helpers.ts'

/**
 * The phone drops an idle AFC connection by itself ("ended by the other
 * party") while USB and trust stay up. Found on an iPhone 16 Pro Max running
 * iOS 27: every grid tile after the drop came back empty and the phone still
 * showed as ready.
 */

let s: Scratch
const sessions: PhoneSession[] = []
beforeEach(() => (s = scratch()))
afterEach(async () => {
  // The session holds the database open, and Windows will not delete an open file.
  for (const x of sessions.splice(0)) await x.close()
  s.cleanup()
})

async function open(opts: Parameters<typeof PhoneSession.open>[0]) {
  const x = await PhoneSession.open(opts)
  sessions.push(x)
  return x
}

/** A connection to the fake phone that can be cut, like a real socket. */
class Link implements DeviceSource {
  dead = false
  disposed = false
  openNow = 0
  openMax = 0
  constructor(private readonly inner: FakeDevice) {}
  private check() {
    if (this.dead) throw new Error('This socket has been ended by the other party')
  }
  identity() {
    this.check()
    return this.inner.identity()
  }
  freeBytes() {
    this.check()
    return this.inner.freeBytes()
  }
  list(dir: string) {
    this.check()
    return this.inner.list(dir)
  }
  stat(p: string) {
    this.check()
    return this.inner.stat(p)
  }
  async open(p: string) {
    this.check()
    const h = await this.inner.open(p)
    this.openMax = Math.max(this.openMax, ++this.openNow)
    return {
      read: (n: number) => h.read(n),
      seek: (o: number) => h.seek(o),
      close: async () => {
        this.openNow--
        await h.close()
      },
    }
  }
  async dispose() {
    this.disposed = true
  }
}

async function phone(count = 2) {
  const root = s.deviceRoot
  fs.mkdirSync(path.join(root, 'PhotoData'), { recursive: true })
  const db = new Database(path.join(root, 'PhotoData', 'Photos.sqlite'))
  db.exec(`
    CREATE TABLE ZASSET (Z_PK INTEGER PRIMARY KEY, ZUUID TEXT, ZDIRECTORY TEXT, ZFILENAME TEXT,
      ZDATECREATED REAL, ZKIND INTEGER, ZKINDSUBTYPE INTEGER, ZFAVORITE INTEGER, ZHIDDEN INTEGER,
      ZTRASHEDSTATE INTEGER, ZVISIBILITYSTATE INTEGER, ZWIDTH INTEGER, ZHEIGHT INTEGER, ZDURATION REAL,
      ZLATITUDE REAL, ZLONGITUDE REAL, ZHASADJUSTMENTS INTEGER, ZAVALANCHEUUID TEXT);
    CREATE TABLE ZGENERICALBUM (Z_PK INTEGER PRIMARY KEY, ZUUID TEXT, ZTITLE TEXT, ZKIND INTEGER,
      ZTRASHEDSTATE INTEGER, Z_FOK_PARENTFOLDER INTEGER);
  `)
  const t = toAppleSeconds(Date.parse('2026-01-05T10:00:00Z'))
  const add = db.prepare(`INSERT INTO ZASSET VALUES (?, ?, 'DCIM/100APPLE', ?, ?, 0, 0, 0, 0, 0, 0, 640, 480, 0, -180, -180, 0, NULL)`)
  const names: string[] = []
  for (let i = 1; i <= count; i++) {
    const name = `IMG_${String(i).padStart(4, '0')}.HEIC`
    add.run(i, `U${i}`, name, t + i * 60)
    names.push(name)
  }
  db.close()

  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c33' } }).jpeg().toBuffer()
  for (const name of names) {
    fs.writeFileSync(path.join(root, 'DCIM', '100APPLE', name), Buffer.alloc(100))
    const dir = path.join(root, 'PhotoData', 'Thumbnails', 'V2', 'DCIM', '100APPLE', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '5005.JPG'), jpeg)
  }
  return new FakeDevice({ root })
}

const noHeic = { decode: async () => ({ width: 640, height: 480, data: Buffer.alloc(640 * 480 * 4, 255) }) }

describe('phone session', () => {
  it('builds grid thumbnails from the original instead of the tiny phone preview', async () => {
    const fake = await phone(1)
    const session = await open({ device: fake, udid: 'U', name: 'Fake', cacheRoot: path.join(s.dir, 'cache'), heic: noHeic })
    const file = await session.thumb('U1', 'sm')
    const m = await sharp(file!).metadata()
    expect([m.width, m.height]).toEqual([640, 480])
    const stats = await sharp(file!).stats()
    expect(stats.channels[1]!.mean).toBeGreaterThan(240)
    expect(await session.thumb('U1', 'lg')).toBeTruthy()
  })

  it('reconnects when the phone drops the connection, and carries on', async () => {
    const fake = await phone()
    const first = new Link(fake)
    const links: Link[] = [first]
    const session = await open({
      device: first,
      udid: 'U',
      name: 'Fake',
      cacheRoot: path.join(s.dir, 'cache'),
      heic: noHeic,
      reconnect: async () => {
        const l = new Link(fake)
        links.push(l)
        return l
      },
    })

    expect(await session.thumb('U1', 'sm')).toBeTruthy()
    first.dead = true
    // The next tile is made on a fresh connection, and the dead one is let go.
    expect(await session.thumb('U2', 'sm')).toBeTruthy()
    expect(links).toHaveLength(2)
    expect(first.disposed).toBe(true)
  })

  it('reconnects once for many requests that fail together', async () => {
    const fake = await phone()
    const first = new Link(fake)
    let reconnects = 0
    const session = await open({
      device: first,
      udid: 'U',
      name: 'Fake',
      cacheRoot: path.join(s.dir, 'cache'),
      heic: noHeic,
      reconnect: async () => {
        reconnects++
        return new Link(fake)
      },
    })
    first.dead = true
    const got = await Promise.all([session.thumb('U1', 'sm'), session.thumb('U2', 'sm'), session.thumb('U1', 'ph')])
    expect(got.every(Boolean)).toBe(true)
    expect(reconnects).toBe(1)
  })

  it('keeps few files open at once, however many tiles are asked for', async () => {
    // iOS refuses a 241st open file on one connection, and the grid asks for
    // hundreds of tiles together.
    const fake = await phone(40)
    const link = new Link(fake)
    const session = await open({ device: link, udid: 'U', name: 'Fake', cacheRoot: path.join(s.dir, 'cache'), heic: noHeic })
    const asks = Array.from({ length: 40 }, (_, i) => session.thumb(`U${i + 1}`, 'sm'))
    expect((await Promise.all(asks)).every(Boolean)).toBe(true)
    expect(link.openMax).toBeLessThanOrEqual(8)
    expect(link.openNow).toBe(0)
  })

  it('shows the edited version when the phone has one', async () => {
    const fake = await phone(1)
    // Mark the photo edited and put the rendered edit beside it, as iOS does.
    const db = new Database(path.join(s.deviceRoot, 'PhotoData', 'Photos.sqlite'))
    db.prepare(`UPDATE ZASSET SET ZHASADJUSTMENTS = 1`).run()
    db.close()
    fs.writeFileSync(path.join(s.deviceRoot, 'DCIM', '100APPLE', 'IMG_E0001.JPG'), Buffer.from('edited'))
    const session = await open({ device: new Link(fake), udid: 'U', name: 'Fake', cacheRoot: path.join(s.dir, 'cache'), heic: noHeic })
    const shown = await session.display('U1')
    expect(shown?.name).toBe('IMG_E0001.JPG')
    expect(fs.readFileSync(shown!.path, 'utf8')).toBe('edited')
    expect(await session.original('U1')).not.toBe(shown!.path)
  })

  it('reports the phone lost when it cannot reconnect', async () => {
    const fake = await phone()
    const first = new Link(fake)
    let lost: string | null = null
    const session = await open({
      device: first,
      udid: 'U',
      name: 'Fake',
      cacheRoot: path.join(s.dir, 'cache'),
      heic: noHeic,
      reconnect: async () => {
        throw new Error('device is locked')
      },
      onLost: (e) => (lost = e.message),
    })
    first.dead = true
    await expect(session.thumb('U1', 'sm')).rejects.toThrow()
    expect(lost).toBe('device is locked')
  })
})
