import { MtpBridge, mtpHelperDirectory } from '../src/device/mtp-bridge.ts'
import { AndroidPhones } from '../src/device/mtp-device.ts'
import { readAndroidLibrary, scanMedia } from '../src/gallery/android-library.ts'

/**
 * Checks the Android helper on this computer, then opens each Android phone
 * plugged in and reads its photo folders. Read only.
 *
 *   npx tsx scripts/probe-android.ts
 */
console.log('helper:', mtpHelperDirectory())
const t0 = Date.now()
const bridge = MtpBridge.start()
console.log('helper started:', await bridge.call('ping'), `${Date.now() - t0} ms`)
console.log('portable devices:', await bridge.call('devices'))
await bridge.close()

const phones = new AndroidPhones()
try {
  const ids = await phones.list()
  console.log('android phones:', ids.map((id) => `${id} (${phones.nameOf(id)})`))
  for (const id of ids) {
    try {
      const device = await phones.attach(id)
      console.log(id, await device.identity(), device.info.storages)
      let t = Date.now()
      const scan = await scanMedia(device)
      const lib = readAndroidLibrary(scan.files)
      console.log(`scanned ${scan.files.length} files in ${scan.folders} photo folders in ${Date.now() - t} ms`)
      console.log('albums:', lib.albums.map((a) => `${a.name} (${a.keys.length})`))
      const newest = lib.assets.at(-1)
      if (newest) {
        console.log('newest:', newest.path, new Date(newest.t).toISOString())
        t = Date.now()
        const thumb = await device.thumbnail(newest.path)
        console.log('phone preview:', thumb ? `${thumb.length} bytes` : 'none', `${Date.now() - t} ms`)
        t = Date.now()
        const h = await device.open(newest.path)
        let bytes = 0
        for (;;) {
          const b = await h.read(4 * 1024 * 1024)
          if (!b.length) break
          bytes += b.length
        }
        await h.close()
        const st = await device.stat(newest.path)
        console.log(`read ${bytes} of ${st.size} bytes in ${Date.now() - t} ms`, bytes === st.size ? 'OK' : 'MISMATCH')
        const h2 = await device.open(newest.path)
        t = Date.now()
        await h2.seek(Math.floor(st.size / 2))
        console.log(`seek to the middle and read: ${(await h2.read(1024)).length} bytes in ${Date.now() - t} ms`)
        await h2.close()
      }
      await device.dispose()
    } catch (e) {
      console.log(id, 'could not be read:', (e as Error).message)
    }
  }
} finally {
  await phones.close()
}
