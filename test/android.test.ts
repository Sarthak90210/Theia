import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDevice } from '../src/device/fake-device.ts'
import { MtpBridge, MtpError, type BridgeProcess } from '../src/device/mtp-bridge.ts'
import { AndroidPhones, androidId, isAndroidCandidate, type WpdDeviceEntry } from '../src/device/mtp-device.ts'
import { DeviceDetachedError, type DeviceSource, type ScanRequest } from '../src/device/types.ts'
import { androidKey, captureTime, readAndroidLibrary, scanMedia, ANDROID_SCAN } from '../src/gallery/android-library.ts'
import { phoneCollections, phoneItems } from '../src/gallery/phone-library.ts'
import { NoPhotoFoldersError, PhoneSession } from '../src/gallery/phone-session.ts'
import { phoneSaveItems } from '../src/gallery/save-sources.ts'
import { scratch, type Scratch } from './helpers.ts'

let s: Scratch
const sessions: PhoneSession[] = []
beforeEach(() => (s = scratch()))
afterEach(async () => {
  for (const x of sessions.splice(0)) await x.close()
  s.cleanup()
})

const local = (y: number, mo: number, d: number, h = 0, mi = 0, sec = 0) => new Date(y, mo - 1, d, h, mi, sec).getTime()

/* ------------------------------------------------------------ capture time */

describe('capture time from Android file names', () => {
  const file = { mtimeMs: Date.UTC(2025, 0, 1), ctimeMs: 0 }

  it('reads camera, screenshot and Samsung names as local time', () => {
    expect(captureTime('IMG_20240501_101500.jpg', file)).toBe(local(2024, 5, 1, 10, 15, 0))
    expect(captureTime('VID_20240501_101500.mp4', file)).toBe(local(2024, 5, 1, 10, 15, 0))
    expect(captureTime('20240501_101500.jpg', file)).toBe(local(2024, 5, 1, 10, 15, 0))
    expect(captureTime('Screenshot_20240501-101500_Chrome.jpg', file)).toBe(local(2024, 5, 1, 10, 15, 0))
    expect(captureTime('Screenshot_2024-05-01-10-15-00-123_com.app.jpg', file)).toBe(local(2024, 5, 1, 10, 15, 0))
  })

  it("reads Pixel's PXL_ names as UTC", () => {
    expect(captureTime('PXL_20240501_101500123.jpg', file)).toBe(Date.UTC(2024, 4, 1, 10, 15, 0))
  })

  it('reads millisecond timestamps', () => {
    expect(captureTime('FB_IMG_1714558500123.jpg', file)).toBe(1714558500123)
  })

  it("uses the file's time for a WhatsApp name when it falls on that day, else noon", () => {
    const sameDay = { mtimeMs: local(2024, 5, 1, 18, 30), ctimeMs: 0 }
    expect(captureTime('IMG-20240501-WA0003.jpg', sameDay)).toBe(local(2024, 5, 1, 18, 30))
    expect(captureTime('IMG-20240501-WA0003.jpg', file)).toBe(local(2024, 5, 1, 12, 0))
  })

  it('falls back to the phone date for names without one, or with an impossible one', () => {
    expect(captureTime('holiday.jpg', file)).toBe(file.mtimeMs)
    expect(captureTime('IMG_20241399_101500.jpg', file)).toBe(file.mtimeMs)
    expect(captureTime('IMG_20990101_000000.jpg', file, Date.UTC(2026, 0, 1))).toBe(file.mtimeMs)
    expect(captureTime('x.jpg', { mtimeMs: 0, ctimeMs: Date.UTC(2023, 1, 1) })).toBe(Date.UTC(2023, 1, 1))
  })
})

/* ----------------------------------------------------------------- library */

describe('an Android library from its folders', () => {
  const f = (p: string, size = 100, mtimeMs = Date.UTC(2024, 0, 1)) => ({ path: p, size, mtimeMs, ctimeMs: 0 })
  const files = [
    f('/Internal shared storage/DCIM/Camera/IMG_20240502_090000.jpg'),
    f('/Internal shared storage/DCIM/Camera/VID_20240501_090000.mp4', 5000),
    f('/Internal shared storage/Pictures/Screenshots/Screenshot_20240503-090000.png'),
    f('/Internal shared storage/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/Sent/IMG-20240504-WA0001.jpg'),
    f('/Internal shared storage/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Video/Sent/VID-20240504-WA0002.mp4'),
    f('/SD card/DCIM/Camera/IMG_20230101_120000.jpg'),
    f('/Internal shared storage/DCIM/Camera/notes.txt'),
  ]

  it('orders items by capture time and knows photos from videos', () => {
    const lib = readAndroidLibrary(files)
    expect(lib.assets.map((a) => a.filename)).toEqual([
      'IMG_20230101_120000.jpg',
      'VID_20240501_090000.mp4',
      'IMG_20240502_090000.jpg',
      'Screenshot_20240503-090000.png',
      'IMG-20240504-WA0001.jpg',
      'VID-20240504-WA0002.mp4',
    ])
    expect(lib.assets.find((a) => a.filename.startsWith('VID_'))!.kind).toBe('video')
    expect(lib.assets.find((a) => a.filename.startsWith('Screenshot'))!.subtype).toBe('screenshot')
  })

  it('makes an album per folder, camera first, with same-named folders told apart', () => {
    const names = readAndroidLibrary(files).albums.map((a) => a.name)
    expect(names.slice(0, 2).sort()).toEqual(['Internal shared storage › DCIM › Camera', 'SD card › DCIM › Camera'])
    expect(names).toContain('WhatsApp Images › Sent')
    expect(names).toContain('WhatsApp Video › Sent')
    expect(names).toContain('Screenshots')
  })

  it('keeps keys stable between connections, and new when a file changes', () => {
    const a = readAndroidLibrary(files).assets[0]!
    const b = readAndroidLibrary([...files].reverse()).assets[0]!
    expect(a.key).toBe(b.key)
    expect(androidKey({ path: a.path, size: 101 })).not.toBe(a.key)
  })

  it('uses the same collection and album contract as iPhone without inventing private albums', () => {
    const lib = readAndroidLibrary(files)
    const c = phoneCollections(lib)
    expect(c.smart.map(({ id, name, kind, count }) => ({ id, name, kind, count }))).toEqual([
      { id: 'library', name: 'Library', kind: 'smart', count: 6 },
      { id: 'videos', name: 'Videos', kind: 'smart', count: 2 },
      { id: 'screenshots', name: 'Screenshots', kind: 'smart', count: 1 },
    ])
    for (const collection of [...c.smart, ...c.albums]) {
      const members = phoneItems(lib, collection.id)
      expect(members).toHaveLength(collection.count)
      expect(members.at(-1)?.key).toBe(collection.cover)
    }
    expect(c.albums.map((a) => a.kind)).toEqual(lib.albums.map(() => 'album'))
    expect(c.albums.reduce((total, a) => total + a.count, 0)).toBe(lib.assets.length)
  })
})

/* --------------------------------------------------------------- the phone */

/** Files laid out like an Android phone's storage, under a fake device root. */
async function phoneOnDisk(root: string) {
  const put = (rel: string, data: Buffer | string, mtime?: Date) => {
    const p = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, data)
    if (mtime) fs.utimesSync(p, mtime, mtime)
  }
  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#2a7' } }).jpeg().toBuffer()
  put('Internal shared storage/DCIM/Camera/IMG_20240501_101500.jpg', jpeg)
  put('Internal shared storage/DCIM/Camera/IMG_20240502_101500.jpg', jpeg)
  put('Internal shared storage/DCIM/.thumbnails/1.jpg', jpeg)
  put('Internal shared storage/DCIM/Camera/.trashed-1716000000-IMG_1.jpg', jpeg)
  put('Internal shared storage/Pictures/Screenshots/Screenshot_20240503-090000.png', jpeg)
  put('Internal shared storage/Pictures/Cache/.nomedia', '')
  put('Internal shared storage/Pictures/Cache/junk.jpg', jpeg)
  put('Internal shared storage/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Stickers/s.webp', jpeg)
  put('Internal shared storage/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-20240504-WA0001.jpg', jpeg)
  put('Internal shared storage/Download/manual.pdf', 'pdf')
  put('Internal shared storage/Music/song.mp4', 'not a photo folder')
  return jpeg
}

describe('scanning a phone with list and stat', () => {
  it('finds media in the photo folders and leaves out what Android hides', async () => {
    const root = path.join(s.dir, 'phone')
    await phoneOnDisk(root)
    const scan = await scanMedia(new FakeDevice({ root }))
    expect(scan.storages).toEqual(['Internal shared storage'])
    expect(scan.folders).toBe(4)
    expect(scan.files.map((f) => f.path).sort()).toEqual([
      '/Internal shared storage/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-20240504-WA0001.jpg',
      '/Internal shared storage/DCIM/Camera/IMG_20240501_101500.jpg',
      '/Internal shared storage/DCIM/Camera/IMG_20240502_101500.jpg',
      '/Internal shared storage/Pictures/Screenshots/Screenshot_20240503-090000.png',
    ])
  })
})

describe('an Android phone session', () => {
  async function open(device: DeviceSource, extra: Partial<Parameters<typeof PhoneSession.open>[0]> = {}) {
    const x = await PhoneSession.open({
      device,
      udid: 'android-0123456789ab',
      name: 'Pixel',
      platform: 'android',
      cacheRoot: path.join(s.dir, 'cache'),
      heic: { decode: async () => { throw new Error('no HEIC here') } },
      ...extra,
    })
    sessions.push(x)
    return x
  }

  it('browses folders as albums, and saves one file per item', async () => {
    const root = path.join(s.dir, 'phone')
    const jpeg = await phoneOnDisk(root)
    const device = new FakeDevice({ root })
    const x = await open(device)
    expect(x.library.assets).toHaveLength(4)
    expect(x.collections().albums.map((a) => a.name)[0]).toBe('Camera')
    const first = x.library.assets[0]!
    expect(x.filesFor(first.key)).toEqual([first.path])
    expect(fs.readFileSync((await x.original(first.key))!)).toEqual(jpeg)
    expect(await x.thumb(first.key, 'sm')).toMatch(/\.webp$/)

    const items = await phoneSaveItems(x, device, [first.key])
    expect(items[0]!.files.map((f) => [f.name, f.role])).toEqual([['IMG_20240501_101500.jpg', 'master']])
    expect(items[0]!.sourceUuid).toBe(first.key)
  })

  it('opens the camera roll before scanning other folders, without blocking original reads', async () => {
    const root = path.join(s.dir, 'phone')
    const jpeg = await phoneOnDisk(root)
    let releaseScan!: () => void
    const blocked = new Promise<void>(resolve => { releaseScan = resolve })
    const background = new FakeDevice({ root })
    const indexDevice = Object.assign(background, {
      scan: async (request: ScanRequest) => {
        expect(request.roots).not.toContain('DCIM')
        await blocked
        return scanMedia(new FakeDevice({ root }), request)
      },
    })
    const session = await open(new FakeDevice({ root }), { progressive: true, openIndexDevice: async () => indexDevice })
    expect(session.indexing).toBe(true)
    expect(session.collections().albums.map(a => a.name)).toEqual(['Camera'])
    const changes: boolean[] = []
    const finish = session.finishIndexing(() => changes.push(session.indexing))
    const newest = session.itemPage('library', { fromEnd: 0, limit: 1 })[0]!
    expect(newest.filename).toBe('IMG_20240502_101500.jpg')
    expect(fs.readFileSync((await session.original(newest.key))!)).toEqual(jpeg)
    expect(session.itemPage('library', { fromEnd: 1, limit: 1 })[0]?.filename).toBe('IMG_20240501_101500.jpg')
    releaseScan()
    await finish
    expect(changes).toEqual([false])
    expect(session.library.assets).toHaveLength(4)
    expect(session.collections().albums.map(a => a.name)).toContain('Screenshots')
  })

  it("uses the phone's own preview for the placeholder", async () => {
    const root = path.join(s.dir, 'phone')
    await phoneOnDisk(root)
    const fake = new FakeDevice({ root })
    const asked: string[] = []
    const tiny = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#f00' } }).jpeg().toBuffer()
    const device = Object.assign(fake, { thumbnail: async (p: string) => (asked.push(p), tiny) })
    const x = await open(device)
    const key = x.library.assets[0]!.key
    expect(await x.thumb(key, 'ph')).toMatch(/-ph\.webp$/)
    expect(asked).toEqual([x.library.assets[0]!.path])
  })

  it('says what to do when the phone shares no storage, and gives up on devices with no photo folders', async () => {
    const empty = path.join(s.dir, 'locked')
    fs.mkdirSync(empty)
    await expect(open(new FakeDevice({ root: empty }))).rejects.toThrow(/File transfer/)
    const watch = path.join(s.dir, 'watch')
    fs.mkdirSync(path.join(watch, 'Primary', 'Music'), { recursive: true })
    await expect(open(new FakeDevice({ root: watch }))).rejects.toBeInstanceOf(NoPhotoFoldersError)
  })
})

/* ------------------------------------------------------------------ bridge */

/**
 * Plays mtp-helper.ps1's part over a folder: the same line-and-bytes framing,
 * the same operations and error codes. Replies can be split at any byte, the
 * way a pipe delivers them.
 */
class FakeHelper extends EventEmitter implements BridgeProcess {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  requests: Record<string, unknown>[] = []
  devices: WpdDeviceEntry[] = []
  /** False is how a locked phone, or one not set to File transfer, looks. */
  storages = () => true
  scanProgress: number[] = []
  /** Split every reply into pieces this big. */
  chunk = 7
  private readonly handles = new Map<number, { data: Buffer; pos: number }>()
  private next = 1

  constructor(private readonly root: string) {
    super()
    let pending = ''
    this.stdin.on('data', (b: Buffer) => {
      pending += b.toString('utf8')
      let nl
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        this.handle(JSON.parse(line))
      }
    })
  }

  kill() {
    if (this.killed) return
    this.killed = true
    this.emit('exit', 1)
  }

  private file(p: string) {
    return path.join(this.root, ...p.split('/').filter(Boolean))
  }

  private handle(req: Record<string, unknown>) {
    this.requests.push(req)
    const reply = (result: unknown, data?: Buffer) => this.send({ id: req.id, ok: true, result, bytes: data?.length ?? 0 }, data)
    const fail = (code: string, error: string) => this.send({ id: req.id, ok: false, code, error, bytes: 0 })
    try {
      switch (req.op) {
        case 'devices': return reply(this.devices)
        case 'open': return reply({ name: 'Pixel 9', model: 'Pixel 9', manufacturer: 'Google', serial: 'X', firmware: '15', storages: this.storages() ? ['Internal shared storage'] : [] })
        case 'scan':
          for (const progress of this.scanProgress) this.send({ id: req.id, progress, bytes: 0 })
          return void scanMedia(new FakeDevice({ root: this.root }), req as unknown as ScanRequest).then(reply)
        case 'stat': {
          const st = fs.statSync(this.file(String(req.path)))
          return reply({ size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() })
        }
        case 'list': return reply(fs.readdirSync(this.file(String(req.path))))
        case 'open-file': {
          const data = fs.readFileSync(this.file(String(req.path)))
          const handle = this.next++
          this.handles.set(handle, { data, pos: 0 })
          return reply({ handle, size: data.length })
        }
        case 'read': {
          const h = this.handles.get(Number(req.handle))!
          const out = h.data.subarray(h.pos, h.pos + Number(req.length))
          h.pos += out.length
          return reply(null, out)
        }
        case 'seek': this.handles.get(Number(req.handle))!.pos = Number(req.offset); return reply(null)
        case 'close-file': this.handles.delete(Number(req.handle)); return reply(null)
        case 'thumb': return reply(null, Buffer.alloc(0))
        case 'unplug': return fail('detached', 'The phone is no longer connected.')
        case 'exit': reply(null); return this.kill()
      }
      fail('bad-request', `Unknown phone operation: ${req.op}`)
    } catch (e) {
      fail((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'error', `object not found: ${req.path}`)
    }
  }

  private send(header: object, data?: Buffer) {
    const all = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), data ?? Buffer.alloc(0)])
    for (let i = 0; i < all.length; i += this.chunk) this.stdout.write(all.subarray(i, i + this.chunk))
  }
}

describe('the bridge to the Windows helper', () => {
  it('delivers scan progress without treating it as the final reply', async () => {
    const root = path.join(s.dir, 'phone')
    await phoneOnDisk(root)
    const helper = new FakeHelper(root)
    helper.scanProgress = [250, 500]
    const bridge = new MtpBridge(helper)
    const checkpoints: number[] = []
    try {
      const result = await bridge.call<{ files: unknown[] }>('scan', { ...ANDROID_SCAN }, n => checkpoints.push(n))
      expect(checkpoints).toEqual([250, 500])
      expect(result.files).toHaveLength(4)
    } finally {
      await bridge.close()
    }
  })

  it('reassembles headers and file bytes however the pipe splits them', async () => {
    const root = path.join(s.dir, 'phone')
    const jpeg = await phoneOnDisk(root)
    const helper = new FakeHelper(root)
    const bridge = new MtpBridge(helper)
    const { handle } = await bridge.call<{ handle: number }>('open-file', { path: '/Internal shared storage/DCIM/Camera/IMG_20240501_101500.jpg' })
    const [a, b] = await Promise.all([
      bridge.request('read', { handle, length: 100 }),
      bridge.request('read', { handle, length: 1_000_000 }),
    ])
    expect(Buffer.concat([a.data, b.data])).toEqual(jpeg)
    expect((await bridge.request('read', { handle, length: 10 })).data.length).toBe(0)
  })

  it('turns a detach into DeviceDetachedError and other refusals into MtpError', async () => {
    const bridge = new MtpBridge(new FakeHelper(s.dir))
    await expect(bridge.call('unplug')).rejects.toBeInstanceOf(DeviceDetachedError)
    const e = (await bridge.call('stat', { path: '/nope' }).catch((x: unknown) => x)) as MtpError
    expect(e).toBeInstanceOf(MtpError)
    expect(e.code).toBe('not-found')
    expect(e.message).toMatch(/object not found/)
  })

  it('fails everything still waiting when the helper stops, as a lost connection', async () => {
    const helper = new FakeHelper(s.dir)
    helper.stdin.removeAllListeners('data')
    const bridge = new MtpBridge(helper)
    const waiting = bridge.call('devices')
    helper.stderr.write('Add-Type: compilation failed\n')
    await new Promise((r) => setImmediate(r))
    helper.kill()
    await expect(waiting).rejects.toThrow(/compilation failed/)
    await expect(waiting).rejects.toBeInstanceOf(DeviceDetachedError)
    await expect(bridge.call('devices')).rejects.toBeInstanceOf(DeviceDetachedError)
    expect(bridge.alive).toBe(false)
  })

  it('stops the helper on close', async () => {
    const helper = new FakeHelper(s.dir)
    await new MtpBridge(helper).close()
    expect(helper.killed).toBe(true)
  })
})

/* ------------------------------------------------------------------ phones */

describe('finding Android phones', () => {
  const pixel = { deviceId: '\\\\?\\usb#vid_18d1&pid_4ee1#1a2b3c#{6ac27878-a6fa-4155-ba85-f98f491d4f33}', name: 'Pixel 9', description: 'Pixel 9', manufacturer: 'Google' }
  const iphone = { deviceId: '\\\\?\\usb#vid_05ac&pid_12a8&mi_00#6&2d787346&2&0000#{6ac27878-a6fa-4155-ba85-f98f491d4f33}', name: 'Apple iPhone', description: 'Apple iPhone', manufacturer: 'Apple Inc.' }
  const drive = { deviceId: '\\\\?\\swd#wpdbusenum#_??_usbstor#disk&ven_sandisk#{53f56307-b6bf-11d0-94f2-00a0c91efb8b}', name: 'E:\\', description: 'USB drive', manufacturer: '' }

  it('leaves out iPhones, which have their own connection, and drives', () => {
    expect(isAndroidCandidate(pixel)).toBe(true)
    expect(isAndroidCandidate(iphone)).toBe(false)
    expect(isAndroidCandidate(drive)).toBe(false)
    expect(androidId(pixel.deviceId)).toBe(androidId(pixel.deviceId.toUpperCase()))
    expect(androidId(pixel.deviceId)).toMatch(/^android-[0-9a-f]{12}$/)
  })

  it('keeps listing a phone it knows when the lister itself fails, so an open phone is not closed', async () => {
    let broken = false
    const phones = new AndroidPhones({
      available: () => true,
      spawn: () => {
        if (broken) throw new Error('powershell.exe is not available')
        const h = new FakeHelper(s.dir)
        h.devices = [pixel]
        return h
      },
    })
    try {
      const ids = await phones.list()
      ;(phones as unknown as { lister: MtpBridge }).lister.close()
      broken = true
      await new Promise((r) => setImmediate(r))
      expect(await phones.list()).toEqual(ids)
    } finally {
      await phones.close()
    }
  })

  it('lists, opens and reads a phone through the helper, and reuses one connection while it is locked', async () => {
    const root = path.join(s.dir, 'phone')
    const jpeg = await phoneOnDisk(root)
    const spawned: FakeHelper[] = []
    let unlocked = false
    const phones = new AndroidPhones({
      available: () => true,
      spawn: () => {
        const h = new FakeHelper(root)
        h.devices = [pixel, iphone, drive]
        h.storages = () => unlocked
        spawned.push(h)
        return h
      },
    })
    try {
      const ids = await phones.list()
      expect(ids).toEqual([androidId(pixel.deviceId)])
      expect(phones.nameOf(ids[0]!)).toBe('Pixel 9')
      expect(spawned).toHaveLength(1) // the lister

      // Locked: no storage, and a clear way out. The retry after unlocking
      // uses the same helper process instead of starting another.
      await expect(phones.attach(ids[0]!)).rejects.toThrow(/File transfer/)
      expect(spawned).toHaveLength(2)
      unlocked = true
      const device = await phones.attach(ids[0]!)
      expect(spawned).toHaveLength(2)

      const x = await PhoneSession.open({
        device,
        udid: ids[0]!,
        name: (await device.identity()).name,
        platform: 'android',
        cacheRoot: path.join(s.dir, 'cache'),
        heic: { decode: async () => { throw new Error('no HEIC') } },
      })
      sessions.push(x)
      expect(x.name).toBe('Pixel 9')
      expect(x.library.assets).toHaveLength(4)
      expect(fs.readFileSync((await x.original(x.library.assets[0]!.key))!)).toEqual(jpeg)
      const part = await x.readRange(x.library.assets[0]!.path, 10, 20)
      expect(part).toEqual(jpeg.subarray(10, 30))

      // Once ignored (no photo folders), it isn't listed again until unplugged.
      phones.ignore(ids[0]!)
      expect(await phones.list()).toEqual([])
    } finally {
      await phones.close()
    }
  })
})

it('asks the helper for the folders and file types the library shows', () => {
  expect(ANDROID_SCAN.roots).toContain('DCIM')
  expect(ANDROID_SCAN.extensions).toEqual(expect.arrayContaining(['.jpg', '.heic', '.mp4']))
})
