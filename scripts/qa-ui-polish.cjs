const fs = require('node:fs')
const path = require('node:path')
const { app, nativeTheme } = require('electron')

const root = process.env.THEIA_QA_ROOT || fs.readFileSync(path.join(__dirname, '../transcripts/latest-ui-polish-qa.txt'), 'utf8').trim()
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'))
if (path.resolve(fixture.profile) !== path.resolve(root, 'profile')) throw new Error('QA profile must stay inside its fixture directory')
app.disableHardwareAcceleration()
app.setPath('userData', fixture.profile)
nativeTheme.themeSource = 'light'

const results = { ok: false, fixture: root, captures: [], checks: [] }
let started = false
app.on('browser-window-created', (_, win) => {
  if (started) return
  started = true
  win.show()
  win.webContents.once('did-finish-load', async () => {
    const run = code => win.webContents.executeJavaScript(`(async()=>{${code}})()`)
    const input = async key => {
      win.focus()
      win.webContents.focus()
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
      if (key === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
      await run('await qaFrame()')
    }
    const capture = async name => {
      await run('await qaFrame(); await qaImages()')
      fs.writeFileSync(path.join(root, `${name}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
      results.captures.push(`${name}.png`)
    }
    const check = async label => {
      const problems = await run('return qaLayout()')
      results.checks.push({ label, problems })
      if (problems.length) throw new Error(`${label}: ${problems.join('; ')}`)
    }
    const collection = async label => run(`qaSide(${JSON.stringify(label)}).click(); await qaFrame(); await qaWait(()=>!document.querySelector('.viewer')&&!document.querySelector('.editor'));`)
    const select = async key => run(`await qaWait(()=>document.querySelector('[data-key="${key}"]')); document.querySelector('[data-key="${key}"]').click(); await qaFrame();`)
    const editReady = async () => run(`await qaWait(()=>document.querySelector('.editor img[alt="Edited preview"]') && !document.querySelector('.edit-updating'));`)
    const closeEditor = async () => run(`qaButton('Cancel', '.editor').click(); await qaWait(()=>!document.querySelector('.editor'));`)
    try {
      await run(`
        window.qaFixture=${JSON.stringify(fixture)};
        window.qaWait=async(fn,timeout=25000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error('UI wait timed out: '+fn.toString());};
        window.qaFrame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        window.qaVisible=el=>{if(!el)return false;const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;};
        window.qaName=el=>(el.getAttribute('aria-label')||el.querySelector('.side-label')?.textContent||el.textContent||el.title||'').trim();
        window.qaButton=(name,scope='body')=>[...document.querySelector(scope).querySelectorAll('button')].find(b=>qaVisible(b)&&(qaName(b)===name||b.title===name));
        window.qaSide=name=>[...document.querySelectorAll('.side-item')].find(b=>b.querySelector('.side-label')?.textContent.trim()===name);
        window.qaAction=async name=>{let b=qaButton(name);if(!b){const more=[...document.querySelectorAll('button')].find(b=>qaVisible(b)&&/actions|more/i.test(qaName(b)||b.title));if(more){more.click();await qaFrame();b=qaButton(name);}}if(!b)throw new Error('Missing action '+name);b.click();await qaFrame();};
        window.qaImages=async()=>{await qaWait(()=>[...document.querySelectorAll('.tile img,.editor img,.viewer img.viewer-img,.info img')].filter(el=>{const r=el.getBoundingClientRect();return qaVisible(el)&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;}).every(el=>el.complete&&el.naturalWidth>0),30000);};
        window.qaLayout=()=>{const p=[];if(getComputedStyle(document.documentElement).colorScheme!=='dark')p.push('Theia must remain dark regardless of system theme');if(document.documentElement.scrollWidth>innerWidth+1)p.push('document horizontal overflow');
          for(const el of document.querySelectorAll('.toolbar button,.toolbar input,.selection-bar button,.viewer-bar button,.editor-bar button')){if(!qaVisible(el)||el.closest('[role="menu"]'))continue;const r=el.getBoundingClientRect();if(r.left< -1||r.right>innerWidth+1)p.push('toolbar control outside viewport: '+qaName(el));}
          const editor=document.querySelector('.editor');if(editor){const c=editor.querySelector('.edit-controls'),r=c?.getBoundingClientRect();if(!r||r.width<230||r.right>innerWidth+1)p.push('editor controls clipped');}
          return p;};
        await qaWait(()=>qaSide(qaFixture.vaultName));qaSide(qaFixture.vaultName).click();await qaWait(()=>document.querySelectorAll('.tile').length===qaFixture.visibleCount);await qaFrame();
      `)

      // Standard desktop, both appearance modes.
      for (const theme of ['light', 'dark']) {
        nativeTheme.themeSource = theme
        win.setContentSize(1280, 820)
        await run('await qaFrame()')
        await check(`${theme}: library`)
        await capture(`${theme}-01-library`)
        await select(fixture.photoKey)
        await check(`${theme}: selected`)
        await capture(`${theme}-02-selected`)

        await run(`document.querySelector('[data-key="${fixture.photoKey}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await qaWait(()=>document.querySelector('.viewer'));`)
        await check(`${theme}: viewer`)
        await capture(`${theme}-03-viewer`)
        await run(`const b=[...document.querySelectorAll('.viewer button')].find(b=>/info/i.test(qaName(b)+' '+b.title));if(!b)throw new Error('Viewer info button missing');b.click();await qaWait(()=>document.querySelector('.info'));`)
        await check(`${theme}: viewer and info`)
        await capture(`${theme}-04-viewer-info`)
        await run(`const b=qaButton('Close info');if(!b)throw new Error('Close info missing');b.click();await qaFrame();qaButton('Back','.viewer')?.click();`)
        // Back may have an accessible title rather than the visible label.
        await run(`if(document.querySelector('.viewer')){const b=[...document.querySelectorAll('.viewer button')].find(b=>/back/i.test(qaName(b)+' '+b.title));b.click();}await qaWait(()=>!document.querySelector('.viewer'));`)

        // Open the save menu with the keyboard, then verify Tab can reach it.
        await run(`const trigger=document.querySelector('.toolbar .menu-anchor > button');if(!trigger)throw new Error('Save menu trigger missing');trigger.focus();`)
        await input('Enter')
        await run(`await qaWait(()=>document.querySelector('[role="menu"]'));`)
        await input('Tab')
        await run(`if(!document.activeElement?.closest('[role="menu"]'))throw new Error('Save menu is not keyboard reachable');`)
        await capture(`${theme}-05-save-menu`)
        await input('Escape')
        await run(`await qaWait(()=>!document.querySelector('[role="menu"]'));`)

        await run(`await qaAction('Edit');`)
        await editReady()
        await run(`const crop=qaButton('Crop','.editor');if(crop)crop.click();await qaFrame();qaButton('Square','.editor').click();qaButton('Rotate 90\u00b0','.editor').click();await new Promise(r=>setTimeout(r,500));`)
        await editReady()
        await check(`${theme}: photo editor`)
        await capture(`${theme}-06-photo-editor`)
        await closeEditor()

        await select(fixture.videoKey)
        await run(`await qaAction('Edit');`)
        await editReady()
        await check(`${theme}: video editor`)
        await capture(`${theme}-07-video-editor`)
        await closeEditor()

        await collection('Hidden')
        await run('await qaWait(()=>document.querySelectorAll(".tile").length===2)')
        await check(`${theme}: hidden`)
        await capture(`${theme}-08-hidden`)
        await collection('Recently Deleted')
        await run('await qaWait(()=>document.querySelectorAll(".tile").length===1)')
        await select(fixture.deletedKey)
        await check(`${theme}: recently deleted`)
        await capture(`${theme}-09-recently-deleted`)

        // Open the destructive confirmation, but never confirm deletion.
        await run(`await qaAction('Delete permanently');await qaWait(()=>document.querySelector('.confirm-dialog[role="dialog"]'));`)
        await capture(`${theme}-10-confirm-dialog`)
        for (let index = 0; index < 5; index++) await input('Tab')
        await run(`if(!document.activeElement?.closest('[role="dialog"]'))throw new Error('Confirmation focus escaped its dialog');`)
        await input('Escape')
        await run('await qaWait(()=>!document.querySelector(".confirm-dialog"))')
        await collection('Library')
        await run('await qaWait(()=>document.querySelectorAll(".tile").length===qaFixture.visibleCount)')
      }

      // Compact desktop, including the info inspector and both editor layouts.
      nativeTheme.themeSource = 'light'
      win.setContentSize(900, 700)
      await run('await qaFrame()')
      await select(fixture.photoKey)
      await run(`const b=[...document.querySelectorAll('.toolbar button')].find(b=>/info/i.test(qaName(b)+' '+b.title));if(!b)throw new Error('Grid info missing');b.click();await qaWait(()=>document.querySelector('.info'));`)
      await check('compact: library and info')
      await capture('compact-01-library-info')
      await run(`qaButton('Close info').click();await qaFrame();await qaAction('Edit');`)
      await editReady()
      await check('compact: photo editor')
      await capture('compact-02-photo-editor')
      await closeEditor()
      await select(fixture.videoKey)
      await run(`await qaAction('Edit');`)
      await editReady()
      await check('compact: video editor')
      await capture('compact-03-video-editor')
      await closeEditor()
      // The application minimum size, plus the new sidebar and grouping keys.
      win.setContentSize(860, 560)
      await select(fixture.photoKey)
      await run(`await qaAction('Edit');`)
      await editReady()
      await check('minimum: photo editor')
      await capture('minimum-01-photo-editor')
      await closeEditor()
      await run(`qaButton('Hide sidebar').click();await qaFrame();if(document.querySelector('.sidebar'))throw new Error('Sidebar did not collapse');qaButton('Show sidebar').click();await qaFrame();if(!document.querySelector('.sidebar'))throw new Error('Sidebar did not reopen');const tab=document.querySelector('.tabs [aria-selected="true"]');tab.focus();`)
      await input('Left')
      await run(`if(document.querySelector('.tabs [aria-selected="true"]').textContent.trim()!=='Days')throw new Error('Grouping keyboard navigation failed');`)
      await input('Right')
      await run(`if(document.querySelector('.tabs [aria-selected="true"]').textContent.trim()!=='All Photos')throw new Error('Grouping keyboard navigation did not return');`)
      results.sidebarToggle = true
      results.groupingKeyboard = true
      results.ok = true
      results.app = app.getName()
      results.windowTitle = win.getTitle()
    } catch (error) {
      results.error = error.stack || String(error)
      results.screenText = await run('return document.body.innerText').catch(() => null)
      await capture('failure').catch(() => {})
    } finally {
      fs.writeFileSync(path.join(root, 'ui-result.json'), JSON.stringify(results, null, 2))
      app.quit()
    }
  })
})
require('../dist-app/main.cjs')
