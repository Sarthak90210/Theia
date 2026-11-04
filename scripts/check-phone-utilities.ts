import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AfcDevice } from '../src/device/afc-device.ts'
import { PhoneSession } from '../src/gallery/phone-session.ts'
import { HeicPool } from '../src/thumbs/heic-pool.ts'
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'photos-phone-utilities-'))
const heic = new HeicPool(1)
let session: PhoneSession | undefined
try {
 const device = await AfcDevice.attach('00008140-00127D5E0EE8801C')
 session = await PhoneSession.open({ device, udid: 'check', name: 'iPhone', cacheRoot: cache, heic })
 for (const id of ['hidden', 'deleted']) {
  const items = session.items(id)
  console.log(JSON.stringify({ collection: id, total: items.length, originalsAccessible: items.filter(a => !a.cloud).length }))
  const accessible = items.find(a => !a.cloud)
  if(accessible) {
   const h = await device.open(accessible.path)
   try { console.log(id, 'sample bytes read', (await h.read(64)).length) } finally { await h.close() }
  }
 }
} finally {
 await session?.close()
 await heic.close()
 fs.rmSync(cache,{recursive:true,force:true})
}
