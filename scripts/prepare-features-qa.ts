import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import { createVault } from '../src/vault/vault.ts'
import { saveToVault, type SaveItem } from '../src/vault/save.ts'
const root = path.resolve('transcripts', `features-qa-${Date.now()}`)
fs.mkdirSync(root, { recursive: true })
const v = createVault(path.join(root, 'Test Vault'))
for (let n=0;n<4;n++) {
 const video = n===1
 const name = video ? 'clip.mp4' : `photo-${n}.jpg`
 const input = path.join(root,name)
 if (video) execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=640x360:rate=25:duration=3','-f','lavfi','-i','sine=duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',input],{windowsHide:true})
 else await sharp(Buffer.from(`<svg width="1200" height="800"><rect width="1200" height="800" fill="${['#164c87','','#733344','#277a5b'][n]}"/><circle cx="400" cy="400" r="240" fill="#f8be54"/><rect x="760" y="180" width="280" height="440" fill="#d8effa"/><text x="40" y="740" font-size="48" fill="white">Photo editor test ${n}</text></svg>`)).jpeg().toFile(input)
 const bytes=fs.readFileSync(input)
 const item: SaveItem={key:String(n),kind:video?'video':'photo',t:1700000000000+n*1000,off:19800,w:video?640:1200,h:video?360:800,dur:video?3000:null,fav:false,edited:false,subtype:null,sourceUuid:`qa${n}`,lat:null,lon:null,cloud:false,files:[{name,role:'master',mime:video?'video/mp4':'image/jpeg',size:bytes.length,sha256:null,read:async function*(){yield bytes}}]}
 const r = await saveToVault(v,[item],[])
 if(n===2) v.db.prepare('UPDATE asset SET hidden=1 WHERE id=?').run(r.newAssets[0])
 if(n===3) v.db.prepare('UPDATE asset SET deleted_at=? WHERE id=?').run(Date.now(),r.newAssets[0])
}
v.db.close()
fs.mkdirSync(path.join(root,'profile'),{recursive:true})
fs.writeFileSync(path.join(root,'profile','gallery.json'),JSON.stringify({vaults:[v.layout.root]}))
fs.writeFileSync('transcripts/latest-features-qa.txt',root)
console.log(root)
