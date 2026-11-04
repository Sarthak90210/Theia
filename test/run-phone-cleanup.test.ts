import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {FakeDevice} from '../src/device/fake-device.ts'
import {createVault,type OpenVault} from '../src/vault/vault.ts'
import {saveToVault,type SaveItem} from '../src/vault/save.ts'
import {cleanupSavedPhone,type CleanupDeps} from '../src/gallery/run-phone-cleanup.ts'
import {scratch,putOnDevice,type Scratch} from './helpers.ts'

let s:Scratch, v:OpenVault
beforeEach(()=>{s=scratch();v=createVault(path.join(s.dir,'V'))})
afterEach(()=>{v.db.close();s.cleanup()})

async function fixture() {
  const bytes=await sharp({create:{width:32,height:24,channels:3,background:'#345678'}}).jpeg().toBuffer()
  const p=putOnDevice(s,'IMG_0001.JPG',bytes)
  const device=new FakeDevice({root:s.deviceRoot})
  const st=await device.stat(p)
  const item:SaveItem={key:'U1',sourceUuid:'U1',kind:'photo',t:1,off:0,w:32,h:24,dur:null,fav:false,edited:false,subtype:null,lat:null,lon:null,cloud:false,
    files:[{name:'IMG_0001.JPG',role:'master',mime:'image/jpeg',size:bytes.length,sha256:null,sourcePath:p,sourceMtimeMs:st.mtimeMs,read:async function*(){yield bytes}}]}
  const saved=await saveToVault(v,[item],[])
  const row=v.db.prepare('SELECT sha256 FROM file').get() as {sha256:string}
  const object={objectId:'one',persistentId:'persistent-one',name:'IMG_0001.JPG',bytes:bytes.length,path:'\\Internal Storage\\IMG_0001.JPG',canDelete:true}
  const remove=vi.fn(async()=>({deleted:new Set(['one']),failed:new Map<string,string>()}))
  const deps:CleanupDeps={inventory:vi.fn(async()=>({deviceId:'device',serial:'serial',deleteSupported:true,objects:[object]})),
    hash:vi.fn(async()=>({object,bytes:bytes.length,sha256:row.sha256})),remove,decode:vi.fn(async()=>({status:'ok' as const})),
    paths:vi.fn(async()=>[p]),progress:vi.fn()}
  return {item,device,saved,object,deps,remove,p}
}

describe('verified iPhone cleanup orchestration',()=>{
  it('checks source, saved bytes and decode before one driver delete, and writes an audit',async()=>{
    const f=await fixture()
    const r=await cleanupSavedPhone(v,'phone',f.device,[f.item],f.saved.assets,f.deps)
    expect(r).toMatchObject({deleted:1,kept:0})
    expect(f.deps.decode).toHaveBeenCalledOnce()
    expect(f.deps.hash).toHaveBeenCalledOnce()
    expect(f.remove).toHaveBeenCalledOnce()
    const log=fs.readFileSync(path.join(path.dirname(v.layout.db),'iphone-cleanup.jsonl'),'utf8')
    expect(log).toContain('verified-before-delete')
    expect(log).toContain('U1:deleted')
  })
  it('never deletes an item excluded from the successful save receipt',async()=>{
    const f=await fixture()
    const r=await cleanupSavedPhone(v,'phone',f.device,[f.item],{},f.deps)
    expect(r.kept).toBe(1);expect(f.remove).not.toHaveBeenCalled()
  })
  it('keeps an original when its saved copy cannot be fully decoded',async()=>{
    const f=await fixture();f.deps.decode=async()=>({status:'unchecked',detail:'RAW decoder unavailable'})
    const r=await cleanupSavedPhone(v,'phone',f.device,[f.item],f.saved.assets,f.deps)
    expect(r.kept).toBe(1);expect(f.remove).not.toHaveBeenCalled()
  })
  it('refuses a Windows representation with different bytes',async()=>{
    const f=await fixture();f.deps.hash=async()=>({object:f.object,bytes:f.object.bytes,sha256:'0'.repeat(64)})
    const r=await cleanupSavedPhone(v,'phone',f.device,[f.item],f.saved.assets,f.deps)
    expect(r.kept).toBe(1);expect(f.remove).not.toHaveBeenCalled()
  })
  it('refuses ambiguous same-name, same-byte Windows objects',async()=>{
    const f=await fixture()
    const duplicate={...f.object,objectId:'two',persistentId:'persistent-two'}
    f.deps.inventory=async()=>({deviceId:'device',serial:'serial',deleteSupported:true,objects:[f.object,duplicate]})
    f.deps.hash=async(_udid,object)=>({object,bytes:object.bytes,sha256:(v.db.prepare('SELECT sha256 FROM file').get() as {sha256:string}).sha256})
    const r=await cleanupSavedPhone(v,'phone',f.device,[f.item],f.saved.assets,f.deps)
    expect(r.kept).toBe(1);expect(f.remove).not.toHaveBeenCalled()
  })
  it('does not delete when cancellation arrives during verification',async()=>{
    const f=await fixture(),abort=new AbortController();f.deps.signal=abort.signal
    f.deps.decode=async()=>{abort.abort();return {status:'ok'}}
    const r=await cleanupSavedPhone(v,'phone',f.device,[f.item],f.saved.assets,f.deps)
    expect(r.kept).toBe(1);expect(f.remove).not.toHaveBeenCalled()
  })
  it('checks for new companion files immediately before calling the driver',async()=>{
    const f=await fixture();let calls=0
    f.deps.paths=async()=>++calls===1?[f.p]:[f.p,'/DCIM/100APPLE/IMG_0001.AAE']
    const r=await cleanupSavedPhone(v,'phone',f.device,[f.item],f.saved.assets,f.deps)
    expect(r.kept).toBe(1);expect(f.remove).not.toHaveBeenCalled()
  })
  it('reports partial driver failure instead of claiming the item was deleted',async()=>{
    const f=await fixture();f.deps.remove=async()=>({deleted:new Set(),failed:new Map([['one','Driver refused']])})
    const r=await cleanupSavedPhone(v,'phone',f.device,[f.item],f.saved.assets,f.deps)
    expect(r).toMatchObject({deleted:0,kept:1});expect(r.reasons[0]?.reason).toContain('Driver refused')
  })
})
