import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { normalizePhoneIdentity, validatePhoneObject, wpdDeleteVerified, wpdHashObject, wpdInventory, type PhoneObject } from '../src/device/wpd.ts'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
const udid = '00008140-0011223344556677'
const object: PhoneObject = { objectId: 'id-1', persistentId: 'persistent-1', name: 'IMG_0001.HEIC', bytes: 120,
  path: '\\Internal Storage\\202611_a\\IMG_0001.HEIC', canDelete: true }
const hash = 'a'.repeat(64)
afterEach(() => vi.restoreAllMocks())

function answer(value: unknown) {
  const exists = fs.existsSync.bind(fs)
  vi.spyOn(fs, 'existsSync').mockImplementation(file => /wpd[\\/](?:MediaDevices\.dll|wpd-helper\.ps1)$/.test(String(file)) || exists(file))
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (err: null, out: string, errOut: string) => void
    queueMicrotask(() => callback(null, JSON.stringify(value), ''))
    return {} as ReturnType<typeof execFile>
  }) as typeof execFile)
}

describe('strict Windows phone identity', () => {
  it('accepts the modern and legacy UDID formats, without treating a name or partial serial as an identity', () => {
    expect(normalizePhoneIdentity(udid)).toBe('000081400011223344556677')
    expect(normalizePhoneIdentity('A'.repeat(40))).toBe('a'.repeat(40))
    for (const value of ['iPhone', 'C02ABCDEF123', 'phone-' + udid, udid + '-other']) {
      expect(() => normalizePhoneIdentity(value)).toThrow('UDID')
    }
  })

  it('requires the persistent object identity and known nonempty bytes', () => {
    validatePhoneObject(object)
    for (const invalid of [{ ...object, persistentId: '' }, { ...object, objectId: '' }, { ...object, bytes: 0 }, { ...object, bytes: NaN }]) {
      expect(() => validatePhoneObject(invalid)).toThrow('unambiguous')
    }
  })
})

describe.skipIf(process.platform !== 'win32')('Windows delete wrapper', () => {
  it('rejects pre-cancelled verification without invoking a Windows helper', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(wpdInventory(udid, [object.name], controller.signal)).rejects.toThrow()
    expect(execFile).not.toHaveBeenCalled()
  })

  it('does not accept a changed resource identity or unexpected byte count', async () => {
    answer({ object: { ...object, persistentId: 'changed' }, bytes: 120, sha256: hash })
    await expect(wpdHashObject(udid, object)).rejects.toThrow('changed')
  })

  it('keeps unconfirmed per-file deletion results as failures', async () => {
    answer({ deleted: [], failed: [] })
    const result = await wpdDeleteVerified(udid, [{ object, bytes: 120, sha256: hash, destination: path.resolve('backup.heic') }])
    expect(result.deleted.size).toBe(0)
    expect(result.failed.get(object.objectId)).toContain('did not confirm')
    const args = vi.mocked(execFile).mock.calls[0]!
    expect(args[0]).toBe('powershell.exe')
    expect(args[1]).toContain('-NonInteractive')
  })

  it('rejects success for an object that was never authorized', async () => {
    answer({ deleted: ['other-photo'], failed: [] })
    await expect(wpdDeleteVerified(udid, [{ object, bytes: 120, sha256: hash, destination: path.resolve('backup.heic') }]))
      .rejects.toThrow('did not confirm')
  })

  it('refuses a nondeletable object, duplicate object or relative backup before invoking Windows', async () => {
    const valid = { object, bytes: 120, sha256: hash, destination: path.resolve('backup.heic') }
    await expect(wpdDeleteVerified(udid, [{ ...valid, object: { ...object, canDelete: false } }])).rejects.toThrow('incomplete')
    await expect(wpdDeleteVerified(udid, [valid, valid])).rejects.toThrow('incomplete')
    await expect(wpdDeleteVerified(udid, [{ ...valid, destination: 'relative.heic' }])).rejects.toThrow('incomplete')
    expect(execFile).not.toHaveBeenCalled()
  })
})
