// Real renderer controls with a fake save endpoint. This test never touches a phone.
const fs = require('node:fs')
const path = require('node:path')
const {pathToFileURL} = require('node:url')
const {app,BrowserWindow} = require('electron')
const {build} = require('esbuild')
const root=path.resolve(__dirname,'..')
const out=path.join(root,'transcripts',`save-ui-qa-${Date.now()}`)
fs.mkdirSync(out,{recursive:true})
app.disableHardwareAcceleration()
app.setPath('userData',path.join(out,'profile'))
app.whenReady().then(async()=>{
  const entry=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {SaveMenu,StatusBar} from './app/renderer/Save.tsx';
    window.__requests=[];window.photos={save:async r=>{window.__requests.push(r)},cancelSave:async()=>{},dismissSave:async()=>{}};
    function Demo(){const [save,setSave]=useState({status:'idle'});window.__setSave=setSave;const state={settings:{mapsEnabled:false},devices:[],vaults:[{id:'vault:archive',name:'Archive',count:0,root:'C:/Example',kind:'album',revision:0,protection:'off'}],diagnosis:null,thumbnails:null,converting:null,save};return <div style={{padding:40}}><h1>Save controls</h1><SaveMenu state={state} source="device:00008140-0011223344556677" keys={['U1']} label="Save to…" onError={e=>{window.__error=e}}/><StatusBar state={state}/></div>};createRoot(document.getElementById('root')).render(<Demo/>);`
  await build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},outfile:path.join(out,'app.js'),bundle:true,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}})
  const css=['styles.css','polish.css','editor-polish.css'].map(f=>`<link rel="stylesheet" href="${pathToFileURL(path.join(root,'app/renderer',f)).href}">`).join('')
  fs.writeFileSync(path.join(out,'index.html'),`<!doctype html><meta charset="utf-8">${css}<div id="root"></div><script src="app.js"></script>`)
  const win=new BrowserWindow({width:1100,height:740,show:false,webPreferences:{backgroundThrottling:false}})
  const js=code=>win.webContents.executeJavaScript(`(async()=>{${code}})()`)
  const wait=async condition=>{for(let i=0;i<200;i++){if(await js(`return !!(${condition})`))return;await new Promise(r=>setTimeout(r,40))}throw Error(`Timed out: ${condition}`)}
  const click=async selector=>{const r=await js(`const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}`);win.focus();for(const type of ['mouseMove','mouseDown','mouseUp'])win.webContents.sendInputEvent({type,x:Math.round(r.x),y:Math.round(r.y),button:'left',clickCount:1});await new Promise(r=>setTimeout(r,60))}
  const results={ok:false,checks:[],error:null}
  try{
    await win.loadFile(path.join(out,'index.html'));win.show();await wait(`document.querySelector('.menu-anchor button')`)
    await click('.menu-anchor > button');await wait(`document.querySelector('.save-cleanup-choice input')`)
    if(await js(`return document.querySelector('.save-cleanup-choice input').checked`))throw Error('Deletion enabled by default')
    results.checks.push('delete after save defaults off')
    await click('.save-cleanup-choice input');await click('[role=menuitem]');await wait(`document.querySelector('[role=alertdialog]')`)
    if(await js(`return window.__requests.length`))throw Error('Saved/deleted before confirmation')
    fs.writeFileSync(path.join(out,'delete-confirmation.png'),(await win.webContents.capturePage()).toPNG())
    await click('[role=alertdialog] .ghost');await wait(`!document.querySelector('[role=alertdialog]')`)
    if(await js(`return window.__requests.length`))throw Error('Cancel submitted a save')
    results.checks.push('cancel submits nothing')
    await click('.menu-anchor > button');await wait(`document.querySelector('.save-cleanup-choice input')`)
    if(await js(`return document.querySelector('.save-cleanup-choice input').checked`))throw Error('Deletion choice persisted')
    await click('.save-cleanup-choice input');await click('[role=menuitem]');await wait(`document.querySelector('[role=alertdialog]')`)
    await click('[role=alertdialog] .primary');await wait(`window.__requests.length===1`)
    if(!(await js(`return window.__requests[0].deleteAfterSave===true&&window.__requests[0].keys[0]==='U1'`)))throw Error('Wrong confirmed save request')
    results.checks.push('explicit confirmation sends snapshotted opt-in request')
    await js(`window.__setSave({status:'running',target:'Archive',itemsDone:1,itemsTotal:5,bytesDone:10485760,bytesTotal:52428800,bytesPerSecond:2097152,etaMs:12000,phase:'copying',current:'IMG_0001.HEIC'})`)
    await wait(`document.querySelector('.status-eta')?.textContent.includes('s left')`)
    fs.writeFileSync(path.join(out,'eta.png'),(await win.webContents.capturePage()).toPNG())
    results.checks.push('time remaining and transfer rate render during saving')
    await js(`window.__setSave({status:'running',target:'Archive',itemsDone:5,itemsTotal:5,bytesDone:52428800,etaMs:null,phase:'checking-deletion',current:'IMG_0001.HEIC'})`)
    await wait(`document.querySelector('.status-eta')?.textContent.includes('Triple-checking')`)
    results.checks.push('extra deletion checks show their own phase')
    results.ok=true
  }catch(e){results.error=e.stack}
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({out,...results},null,2));app.exit(results.ok?0:1)
}).catch(e=>{console.error(e);app.exit(1)})
