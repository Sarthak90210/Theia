// End-to-end UI/UX check of Theia, driven with real mouse and keyboard input
// (Electron's sendInputEvent, the same path a person's clicks take), against a
// generated test vault in its own profile. Run after `npx tsx
// scripts/prepare-ui-polish-qa.ts` and `npm run app:build`:
//
//   electron scripts/qa-full.cjs
//
// Writes screenshots and qa-full.json into the fixture folder.

const fs = require('node:fs')
const path = require('node:path')
const { app, nativeTheme } = require('electron')

const root = process.env.THEIA_QA_ROOT || fs.readFileSync(path.join(__dirname, '../transcripts/latest-ui-polish-qa.txt'), 'utf8').trim()
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'))
if (path.resolve(fixture.profile) !== path.resolve(root, 'profile')) throw new Error('QA profile must stay inside its fixture directory')
app.disableHardwareAcceleration()
app.setPath('userData', fixture.profile)
// The system asks for light; Theia must stay dark anyway.
nativeTheme.themeSource = 'light'

const out = path.join(root, 'qa-full')
fs.mkdirSync(out, { recursive: true })
const results = { ok: false, steps: [], captures: [], layout: [] }
let started = false

app.on('browser-window-created', (_, win) => {
  if (started) return
  started = true
  // The normal app can remain in front while this fixture runs. Animation-frame
  // waits must keep advancing when the test window is occluded.
  win.webContents.setBackgroundThrottling(false)
  win.show()
  win.setContentSize(1280, 820)
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(`(async()=>{${code}})()`)
    const frame = () => js('await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const wait = async (cond, what, timeout = 20000) => {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        if (await js(`return !!(${cond})`)) return
        await sleep(80)
      }
      throw new Error(`Timed out waiting for: ${what}`)
    }
    const expect = async (cond, what) => {
      if (!(await js(`return !!(${cond})`))) throw new Error(`Expected: ${what}`)
    }
    const rect = (sel) => js(`const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,left:r.left,top:r.top,width:r.width,height:r.height}`)

    // Real pointer input.
    const mouse = (type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
    const clickAt = async (x, y, modifiers = []) => {
      win.focus()
      mouse('mouseMove', x, y, { modifiers })
      mouse('mouseDown', x, y, { modifiers })
      mouse('mouseUp', x, y, { modifiers })
      await frame()
    }
    const click = async (sel, modifiers = []) => {
      // As a person would: scroll it into view first, clear of the toolbar.
      await js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:'center'})`)
      await frame()
      await sleep(60)
      const r = await rect(sel)
      if (!r) throw new Error(`Nothing to click: ${sel}`)
      await clickAt(r.x, r.y, modifiers)
    }
    const drag = async (x, y, dx, dy, steps = 12, during) => {
      win.focus()
      mouse('mouseMove', x, y)
      mouse('mouseDown', x, y)
      for (let i = 1; i <= steps; i++) {
        // The button is held throughout, as in a real drag.
        mouse('mouseMove', x + (dx * i) / steps, y + (dy * i) / steps, { modifiers: ['leftButtonDown'] })
        await sleep(12)
      }
      if (during) await during()
      mouse('mouseUp', x + dx, y + dy)
      await frame()
    }
    const key = async (keyCode, modifiers = []) => {
      win.focus()
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      if (keyCode.length === 1 && !modifiers.includes('control')) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      await frame()
    }
    const capture = async (name) => {
      await frame()
      await sleep(150)
      fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
      results.captures.push(name)
    }
    // Layout problems a person would see: overflow, controls off-screen or overlapping.
    const layout = async (label) => {
      const problems = await js(`
        const p=[]
        const vis=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&+s.opacity>0.05&&r.width>0&&r.height>0}
        if(getComputedStyle(document.documentElement).colorScheme!=='dark')p.push('not dark')
        if(document.documentElement.scrollWidth>innerWidth+1)p.push('page scrolls sideways')
        for(const bar of document.querySelectorAll('.toolbar,.selection-bar,.viewer-bar,.ed-bar,.player-row')){
          if(!vis(bar))continue
          const items=[...bar.querySelectorAll('button,input,.tabs,output')].filter(e=>vis(e)&&!e.closest('[role="menu"]')&&!e.closest('.tabs button'))
          for(const e of items){const r=e.getBoundingClientRect();if(r.left<-1||r.right>innerWidth+1)p.push(bar.className.split(' ')[0]+': off screen: '+(e.getAttribute('aria-label')||e.textContent.trim()).slice(0,30))}
          for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){
            if(items[i].contains(items[j])||items[j].contains(items[i]))continue
            const a=items[i].getBoundingClientRect(),b=items[j].getBoundingClientRect()
            const ox=Math.min(a.right,b.right)-Math.max(a.left,b.left),oy=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)
            if(ox>2&&oy>2)p.push(bar.className.split(' ')[0]+': overlap: '+(items[i].getAttribute('aria-label')||items[i].textContent.trim()).slice(0,20)+' / '+(items[j].getAttribute('aria-label')||items[j].textContent.trim()).slice(0,20))
          }
        }
        const panel=document.querySelector('.ed-panel');if(panel&&vis(panel)){const r=panel.getBoundingClientRect();if(r.width<220||r.right>innerWidth+1)p.push('editor panel squeezed or clipped')}
        const cv=document.querySelector('.ed-view');if(cv&&vis(cv)){const r=cv.getBoundingClientRect(),s=document.querySelector('.ed-canvas').getBoundingClientRect();if(r.width<120||r.height<80)p.push('editor picture too small');if(r.left<s.left-1||r.right>s.right+1||r.top<s.top-1||r.bottom>s.bottom+1)p.push('editor picture spills out of its area')}
        return [...new Set(p)]`)
      results.layout.push({ label, problems })
      if (problems.length) throw new Error(`Layout (${label}): ${problems.join('; ')}`)
    }
    let current = ''
    const step = async (name, fn) => {
      current = name
      console.log(name)
      fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify({ current, completed: results.steps.length }))
      const t = Date.now()
      await fn()
      results.steps.push({ name, ms: Date.now() - t })
    }

    const tiles = 'document.querySelectorAll(".tile")'
    const tileSel = (k) => `[data-key="${k}"]`
    const side = (label) => `[...document.querySelectorAll('.side-item')].find(b=>b.querySelector('.side-label')?.textContent.trim()===${JSON.stringify(label)})`
    const sideClick = async (label) => {
      const r = await js(`const b=${side(label)};if(!b)return null;const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}`)
      if (!r) throw new Error(`No sidebar entry ${label}`)
      await clickAt(r.x, r.y)
    }
    const button = (name, scope = 'body') =>
      `[...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')].find(b=>{const s=getComputedStyle(b),r=b.getBoundingClientRect();return s.visibility!=='hidden'&&r.width>0&&((b.getAttribute('aria-label')||b.textContent).trim()===${JSON.stringify(name)}||b.title===${JSON.stringify(name)})})`
    const pressButton = async (name, scope) => {
      let r = await js(`const b=${button(name, scope)};if(!b)return null;const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}`)
      if (!r) {
        // Compact layouts move some actions under a More menu.
        const more = await js(`const b=[...document.querySelectorAll('button')].find(b=>/more|actions/i.test(b.getAttribute('aria-label')||b.title||''));if(!b)return null;const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}`)
        if (more) {
          await clickAt(more.x, more.y)
          r = await js(`const b=${button(name, scope)};if(!b)return null;const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}`)
        }
      }
      if (!r) throw new Error(`No button "${name}"`)
      await clickAt(r.x, r.y)
    }
    const selectedCount = () => js(`return document.querySelectorAll('.tile[aria-selected="true"]').length`)
    const viewerIndex = () => js(`return document.querySelector('.viewer-title .small')?.textContent||''`)

    try {
      await step('opens the test vault', async () => {
        await wait(side(fixture.vaultName), 'vault in sidebar')
        await sideClick(fixture.vaultName)
        await wait(`${tiles}.length===${fixture.visibleCount}`, `${fixture.visibleCount} tiles`)
        await wait(`[...${tiles}].every(t=>{const i=t.querySelector('img');return !i||i.complete&&i.naturalWidth>0})`, 'thumbnails')
        await capture('01-library')
        await layout('library 1280x820')
      })

      await step('a Live Photo plays on hover and stops when the pointer leaves', async () => {
        const sel = tileSel(fixture.liveKey)
        await js(`document.querySelector('${sel}').scrollIntoView({block:'center'})`)
        await sleep(150)
        const r = await rect(sel)
        await expect(`document.querySelector('${sel} .badge.tl')`, 'Live badge on the tile')
        // Passing straight over it does not start it.
        mouse('mouseMove', r.x, r.y)
        await sleep(80)
        mouse('mouseMove', r.left - 30, r.y)
        await sleep(400)
        await expect(`!document.querySelector('${sel} video')`, 'a quick pass does not play it')
        // Resting on it does.
        mouse('mouseMove', r.x, r.y)
        await wait(`document.querySelector('${sel} video.tile-motion.shown')?.currentTime>0.2`, 'motion playing in the tile')
        await expect(`document.querySelector('${sel} .badge.live-playing')`, 'badge shows it is playing')
        await capture('01b-live-hover')
        mouse('mouseMove', r.left - 30, r.y)
        await wait(`!document.querySelector('${sel} video')`, 'stops when the pointer leaves')
      })

      await step('a click opens the photo and selects nothing', async () => {
        await click(tileSel(fixture.photoKey))
        await wait(`document.querySelector('.viewer')`, 'viewer')
        await expect(`!document.querySelector('.selection-bar')`, 'no selection bar after a plain click')
        if ((await selectedCount()) !== 0) throw new Error('a plain click selected a tile')
        await wait(`[...document.querySelectorAll('.viewer img')].some(i=>i.complete&&i.naturalWidth>0)`, 'photo shown')
        await capture('02-viewer')
        await layout('viewer')
      })

      await step('viewer arrows stay put while pressed, and step through photos', async () => {
        const stage = await rect('.viewer-stage')
        mouse('mouseMove', stage.x, stage.y)
        await sleep(250)
        for (const [cls, dir] of [['.nav.next', 1], ['.nav.prev', -1]]) {
          const before = await viewerIndex()
          const r = await rect(cls)
          if (!r) throw new Error(`no ${cls} button`)
          mouse('mouseMove', r.x, r.y)
          mouse('mouseDown', r.x, r.y)
          await frame()
          const pressed = await rect(cls)
          mouse('mouseUp', r.x, r.y)
          await frame()
          const moved = Math.hypot(pressed.x - r.x, pressed.y - r.y)
          if (moved > 0.5) throw new Error(`${cls} moved ${moved.toFixed(1)} px when pressed`)
          await wait(`document.querySelector('.viewer-title .small')?.textContent!==${JSON.stringify(before)}`, `${cls} changes photo`)
          void dir
        }
        // Keyboard too.
        const before = await viewerIndex()
        await key('Right')
        await wait(`document.querySelector('.viewer-title .small')?.textContent!==${JSON.stringify(before)}`, 'Right arrow changes photo')
        await key('Left')
      })

      await step('zoom in the viewer with the wheel, and reset', async () => {
        const r = await rect('.viewer-stage')
        for (let i = 0; i < 4; i++) win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(r.x), y: Math.round(r.y), deltaX: 0, deltaY: 120, wheelTicksY: 1, canScroll: true })
        await sleep(200)
        await wait(`document.querySelector('.viewer-photo.zoomed')`, 'zoomed after wheel')
        await capture('03-viewer-zoomed')
        await key('0')
        await wait(`!document.querySelector('.viewer-photo.zoomed')`, 'fit again after 0')
      })

      await step('info panel opens beside the viewer', async () => {
        await pressButton('Info (I)', '.viewer')
        await wait(`document.querySelector('.info .info-body')?.textContent.length>20`, 'info details')
        await capture('04-viewer-info')
        await layout('viewer with info')
        await pressButton('Info (I)', '.viewer')
      })

      await step('Esc closes the viewer and leaves a focus ring, not a selection', async () => {
        await key('Escape')
        await wait(`!document.querySelector('.viewer')`, 'viewer closed')
        if ((await selectedCount()) !== 0) throw new Error('closing the viewer selected something')
      })

      await step('arrow keys move focus in the grid; Enter opens', async () => {
        await click('.grid-header, .toolbar-title')
        await js(`document.querySelector('.grid').focus()`)
        await key('Right')
        await key('Right')
        await wait(`document.querySelector('.tile.focused')`, 'focus ring on a tile')
        if ((await selectedCount()) !== 0) throw new Error('arrow keys selected tiles')
        await capture('05-grid-focus')
        await key('Return')
        await wait(`document.querySelector('.viewer')`, 'Enter opened the viewer')
        await key('Escape')
        await wait(`!document.querySelector('.viewer')`, 'viewer closed')
      })

      const keys = await js(`return [...${tiles}].map(t=>t.dataset.key)`)

      await step('Select turns on selection mode; clicks tick and untick', async () => {
        await pressButton('Select', '.toolbar')
        await wait(`document.querySelector('.selection-bar')`, 'selection bar')
        await expect(`document.querySelector('.selection-count').textContent.includes('Click photos')`, 'hint before anything is ticked')
        await expect(`document.querySelectorAll('.tile-check.unticked').length>3`, 'empty circles on tiles')
        await capture('06-select-mode')
        await layout('selection mode, nothing ticked')
        for (const k of keys.slice(0, 3)) await click(tileSel(k))
        if ((await selectedCount()) !== 3) throw new Error(`expected 3 ticked, got ${await selectedCount()}`)
        await expect(`!document.querySelector('.viewer')`, 'clicks in selection mode do not open the viewer')
        await click(tileSel(keys[1]))
        if ((await selectedCount()) !== 2) throw new Error('second click did not untick')
        await click(tileSel(keys[6]), ['shift'])
        if ((await selectedCount()) < 6) throw new Error('Shift+click did not tick a range')
        await capture('07-select-ticked')
        await layout('selection mode with actions')
        await pressButton('Select All', '.toolbar')
        if ((await selectedCount()) !== keys.length) throw new Error('Select All missed tiles')
        await pressButton('Deselect All', '.toolbar')
        if ((await selectedCount()) !== 0) throw new Error('Deselect All left ticks')
        await pressButton('Cancel', '.toolbar')
        await wait(`!document.querySelector('.selection-bar')`, 'selection mode off')
        await click(tileSel(keys[2]))
        await wait(`document.querySelector('.viewer')`, 'a click opens again after Cancel')
        await key('Escape')
        await wait(`!document.querySelector('.viewer')`, 'viewer closed')
      })

      await step('Ctrl+click and Esc still work for keyboard users', async () => {
        await click(tileSel(keys[4]), ['control'])
        await wait(`document.querySelector('.selection-bar')`, 'Ctrl+click starts selection')
        if ((await selectedCount()) !== 1) throw new Error('Ctrl+click should tick exactly one')
        await js(`document.querySelector('.grid').focus()`)
        await key('Escape')
        await wait(`!document.querySelector('.selection-bar')`, 'Esc ends selection')
      })

      await step('Hide and Unhide from a selection', async () => {
        const k = keys[5]
        await pressButton('Select', '.toolbar')
        await click(tileSel(k))
        await pressButton('Hide', '.selection-bar')
        await wait(`!document.querySelector('${tileSel(k)}')`, 'hidden item leaves the library')
        await sideClick('Hidden')
        await wait(`document.querySelector('${tileSel(k)}')`, 'item in Hidden')
        await capture('08-hidden')
        await pressButton('Select', '.toolbar')
        await click(tileSel(k))
        await pressButton('Unhide', '.selection-bar')
        await wait(`!document.querySelector('${tileSel(k)}')`, 'unhidden')
        await sideClick('Library')
        await wait(`document.querySelector('${tileSel(k)}')`, 'back in the library')
      })

      await step('Delete to Recently Deleted, then Recover', async () => {
        const k = keys[7]
        await pressButton('Select', '.toolbar')
        await click(tileSel(k))
        await pressButton('Delete', '.selection-bar')
        await wait(`document.querySelector('[role="dialog"], [role="alertdialog"]')`, 'delete confirmation')
        await capture('09-delete-confirm')
        await pressButton('Move to Recently Deleted')
        await wait(`!document.querySelector('${tileSel(k)}')`, 'deleted item leaves the library')
        await sideClick('Recently Deleted')
        await wait(`document.querySelector('${tileSel(k)}')`, 'item in Recently Deleted')
        await capture('10-recently-deleted')
        await layout('recently deleted')
        await pressButton('Select', '.toolbar')
        await click(tileSel(k))
        await pressButton('Recover', '.selection-bar')
        await wait(`!document.querySelector('${tileSel(k)}')`, 'recovered')
        await sideClick('Library')
        await wait(`document.querySelector('${tileSel(k)}')`, 'back in the library')
      })

      await step('video plays and the scrub bar seeks', async () => {
        await click(tileSel(fixture.videoKey))
        await wait(`document.querySelector('.player-video')?.readyState>=1`, 'video loaded')
        const bar = await rect('.scrub')
        mouse('mouseMove', bar.x, bar.y)
        await clickAt(bar.left + bar.width * 0.5, bar.y)
        await wait(`Math.abs(document.querySelector('.player-video').currentTime-document.querySelector('.player-video').duration/2)<0.6`, 'seek to the middle')
        await capture('11-video')
        await layout('video player')
        // The big play button must not jump either.
        const first = await rect('.player-big')
        if (first) {
          // Measure after hovering (it grows a little on hover, by design), then press.
          mouse('mouseMove', first.x, first.y)
          await sleep(250)
          const big = await rect('.player-big')
          mouse('mouseDown', big.x, big.y)
          await frame()
          const pressed = await rect('.player-big')
          mouse('mouseUp', big.x, big.y)
          if (pressed && Math.hypot(pressed.x - big.x, pressed.y - big.y) > 0.5) throw new Error('big play button moved when pressed')
        }
        await key('Escape')
        await wait(`!document.querySelector('.viewer')`, 'viewer closed')
      })

      const cropBox = () => js(`const c=document.querySelector('.ed-crop').getBoundingClientRect(),f=document.querySelector('.ed-frame').getBoundingClientRect();return {w:c.width,h:c.height,fw:f.width,fh:f.height,left:c.left,top:c.top,right:c.right,bottom:c.bottom}`)

      await step('photo editor: drag the crop frame by its corner and edge', async () => {
        await click(tileSel(fixture.photoKey))
        await wait(`document.querySelector('.viewer')`, 'viewer')
        await pressButton('Edit', '.viewer')
        await wait(`document.querySelector('.ed .ed-crop')`, 'editor with crop frame')
        await wait(`document.querySelector('.ed-media')?.naturalWidth>0`, 'picture in editor')
        await capture('12-editor-crop')
        await layout('photo editor')
        const before = await cropBox()
        const se = await rect('.ed-handle-se')
        await drag(se.x, se.y, -180, -110, 14, () => capture('13-editor-dragging'))
        const after = await cropBox()
        if (!(after.w < before.w - 150 && after.h < before.h - 90)) throw new Error(`corner drag did not resize: ${JSON.stringify({ before, after })}`)
        if (Math.abs(after.left - before.left) > 1 || Math.abs(after.top - before.top) > 1) throw new Error('corner drag moved the opposite corner')
        const w = await rect('.ed-handle-w')
        await drag(w.x, w.y, 60, 0)
        const edge = await cropBox()
        if (!(edge.left > after.left + 50 && Math.abs(edge.right - after.right) < 1)) throw new Error('edge drag did not move only the left side')
        const mid = await rect('.ed-crop')
        await drag(mid.x, mid.y, -40, 30)
        const moved = await cropBox()
        if (Math.abs(moved.w - edge.w) > 1 || moved.left > edge.left - 30) throw new Error('dragging inside did not move the frame')
        await capture('14-editor-cropped')
      })

      await step('aspect presets, orientation, rotate and flip', async () => {
        await pressButton('Square', '.ed-panel')
        let b = await cropBox()
        if (Math.abs(b.w - b.h) > 2) throw new Error(`Square is not square: ${b.w}x${b.h}`)
        await pressButton('16:9', '.ed-panel')
        b = await cropBox()
        if (Math.abs(b.w / b.h - 16 / 9) > 0.03 && Math.abs(b.h / b.w - 16 / 9) > 0.03) throw new Error(`16:9 wrong: ${b.w}x${b.h}`)
        await pressButton('Portrait', '.ed-panel')
        b = await cropBox()
        if (Math.abs(b.h / b.w - 16 / 9) > 0.03) throw new Error(`portrait 16:9 wrong: ${b.w}x${b.h}`)
        // A locked corner drag keeps the shape.
        const se = await rect('.ed-handle-se')
        await drag(se.x, se.y, -50, -10)
        b = await cropBox()
        if (Math.abs(b.h / b.w - 16 / 9) > 0.04) throw new Error('locked aspect broke while dragging')
        const f0 = await cropBox()
        await pressButton('Rotate right', '.ed-panel')
        const f1 = await cropBox()
        if (Math.abs(f1.fw / f1.fh - f0.fh / f0.fw) > 0.02) throw new Error('rotate did not turn the frame')
        await pressButton('Flip horizontally', '.ed-panel')
        await capture('15-editor-rotated')
        await pressButton('Freeform', '.ed-panel')
      })

      await step('straighten with the ruler, with undo and redo', async () => {
        const ruler = await rect('.ed-straighten input')
        const thumbX = ruler.left + ruler.width / 2
        await drag(thumbX, ruler.y, 70, 0, 10, async () => {
          await expect(`document.querySelector('.ed-grid.shown')`, 'fine grid while straightening')
          await capture('16-editor-straightening')
        })
        const angle = await js(`return Number(document.querySelector('.ed-straighten input').value)`)
        if (!(angle > 2)) throw new Error(`straighten did not change: ${angle}`)
        await expect(`/rotate\\([^)]*deg\\)/.test(document.querySelector('.ed-media').style.transform)`, 'picture turned on screen')
        await key('z', ['control'])
        await wait(`Number(document.querySelector('.ed-straighten input').value)===0`, 'Ctrl+Z undoes the whole straighten drag')
        await key('y', ['control'])
        await wait(`Number(document.querySelector('.ed-straighten input').value)>2`, 'Ctrl+Y redoes it')
        const r2 = await rect('.ed-straighten')
        win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(r2.x), y: Math.round(r2.y - 18), button: 'left', clickCount: 2 })
        win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(r2.x), y: Math.round(r2.y - 18), button: 'left', clickCount: 2 })
        await wait(`Number(document.querySelector('.ed-straighten input').value)===0`, 'double-click resets straighten')
      })

      await step('adjust sliders change the picture live; double-click resets', async () => {
        await pressButton('Adjust', '.ed-bar')
        await wait(`document.querySelector('.ed-canvas.mode-result')`, 'cropped result shown while adjusting')
        const slider = await rect('.ed-slider input[aria-label="Exposure"]')
        const t0 = Date.now()
        await drag(slider.x, slider.y, slider.width * 0.25, 0, 6)
        await wait(`(document.querySelector('.ed-media').style.filter||'').includes('theia-edit-colour')`, 'filter applied')
        // The middle of the red tone table: above 0.5 means mid-tones brightened.
        const mid = await js(`return Number(document.querySelector('#theia-edit-colour feFuncR').getAttribute('tableValues').split(' ')[128])`)
        if (!(mid > 0.56)) throw new Error(`exposure did not brighten the preview: mid-tone ${mid}`)
        results.adjustLatencyMs = Date.now() - t0
        for (const name of ['Warmth', 'Saturation']) {
          const r = await rect(`.ed-slider input[aria-label="${name}"]`)
          await drag(r.x, r.y, r.width * 0.2, 0, 4)
        }
        await capture('17-editor-adjusted')
        await layout('adjust panel')
        const ex = await rect('.ed-slider input[aria-label="Exposure"]')
        win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(ex.x), y: Math.round(ex.y - 16), button: 'left', clickCount: 2 })
        win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(ex.x), y: Math.round(ex.y - 16), button: 'left', clickCount: 2 })
        await wait(`Number(document.querySelector('.ed-slider input[aria-label="Exposure"]').value)===0`, 'double-click resets Exposure')
        await key('z', ['control'])
        await wait(`Number(document.querySelector('.ed-slider input[aria-label="Exposure"]').value)!==0`, 'undo brings it back')
      })

      await step('hold Compare to see the original', async () => {
        const c = await rect('.ed-compare')
        mouse('mouseMove', c.x, c.y)
        mouse('mouseDown', c.x, c.y)
        await wait(`document.querySelector('.ed-canvas.mode-original')`, 'original while held')
        await expect(`!(document.querySelector('.ed-media').style.filter||'').includes('theia-edit')`, 'no adjustments on the original')
        await capture('18-editor-compare')
        mouse('mouseUp', c.x, c.y)
        await wait(`!document.querySelector('.ed-canvas.mode-original')`, 'edits back on release')
      })

      await step('save as copy adds a new photo with the crop applied', async () => {
        const count = await js(`return ${tiles}.length`)
        await pressButton('Save as copy', '.ed-bar')
        await wait(`!document.querySelector('.ed')`, 'editor closes after saving', 60000)
        await wait(`${tiles}.length===${count + 1}`, 'new copy in the grid', 30000)
        await expect(`document.querySelector('.toast')?.textContent.includes('copy')`, 'saved message')
        await capture('19-after-save')
      })

      await step('leaving with unsaved edits asks first', async () => {
        await click(tileSel(fixture.photoKey))
        await wait(`document.querySelector('.viewer')`, 'viewer')
        await pressButton('Edit', '.viewer')
        await wait(`document.querySelector('.ed .ed-crop')`, 'editor')
        await pressButton('Rotate right', '.ed-panel')
        await key('Escape')
        await wait(`document.querySelector('.ed-confirm')`, 'discard question')
        await capture('20-discard-confirm')
        await pressButton('Keep editing', '.ed-confirm')
        await wait(`!document.querySelector('.ed-confirm')&&document.querySelector('.ed')`, 'still editing')
        await key('Escape')
        await pressButton('Discard', '.ed-confirm')
        await wait(`!document.querySelector('.ed')`, 'editor closed')
        await key('Escape')
        await wait(`!document.querySelector('.viewer')`, 'viewer closed')
      })

      await step('video editor: drag the trim handles and save', async () => {
        await click(tileSel(fixture.videoKey))
        await wait(`document.querySelector('.viewer')`, 'viewer')
        await pressButton('Edit', '.viewer')
        await wait(`document.querySelector('.ed video.ed-media')?.readyState>=1`, 'video in editor')
        await wait(`document.querySelector('.video-trim-timeline:not(.is-disabled)')`, 'trim timeline ready')
        await capture('21-video-trim')
        await layout('video editor')
        const start = await rect('.trim-range-start')
        await drag(start.x, start.y, 90, 0)
        const end = await rect('.trim-range-end')
        await drag(end.x, end.y, -60, 0)
        const t = await js(`return [...document.querySelectorAll('.ed-times dd')].map(d=>d.textContent)`)
        if (t[0] === '0:00.0') throw new Error(`trim start did not move: ${t}`)
        await capture('22-video-trimmed')
        const count = await js(`return ${tiles}.length`)
        await pressButton('Save as copy', '.ed-bar')
        await wait(`!document.querySelector('.ed')`, 'video editor closes', 90000)
        await wait(`${tiles}.length===${count + 1}`, 'new video copy', 30000)
      })

      for (const [w, h, name] of [[1000, 700, 'compact'], [860, 560, 'minimum']]) {
        await step(`layout at ${w}x${h}`, async () => {
          win.setContentSize(w, h)
          await sleep(400)
          await layout(`${name} library`)
          await capture(`23-${name}-library`)
          await pressButton('Select', '.toolbar')
          await click(tileSel(keys[0]))
          await layout(`${name} selection`)
          await capture(`24-${name}-selection`)
          await pressButton('Cancel', '.toolbar')
          await click(tileSel(fixture.photoKey))
          await wait(`document.querySelector('.viewer')`, 'viewer')
          await layout(`${name} viewer`)
          await pressButton('Edit', '.viewer')
          await wait(`document.querySelector('.ed .ed-crop')`, 'editor')
          await wait(`document.querySelector('.ed-media')?.naturalWidth>0`, 'picture')
          await layout(`${name} editor`)
          await capture(`25-${name}-editor`)
          await pressButton('Cancel', '.ed-bar')
          await wait(`!document.querySelector('.ed')`, 'editor closed')
          await key('Escape')
          await wait(`!document.querySelector('.viewer')`, 'viewer closed')
        })
      }

      await step('burst cover changes and keeping its cover preserves the remaining burst', async () => {
        win.setContentSize(1280, 820)
        await sleep(300)
        await click(tileSel(fixture.burstKey))
        await wait(`document.querySelectorAll('.filmstrip .frame').length===3`, 'three burst frames')
        const before = await js(`return document.querySelector('${tileSel(fixture.burstKey)} img').src`)
        await click('.filmstrip .frame:nth-child(3)')
        await pressButton('Make cover', '.filmstrip')
        await wait(`document.querySelector('.filmstrip .frame:nth-child(3)').getAttribute('aria-label').includes('cover')`, 'third frame is the cover')
        await wait(`document.querySelector('${tileSel(fixture.burstKey)} img').src!==${JSON.stringify(before)}`, 'grid reloads its cover image')
        await layout('burst viewer')
        await capture('27-burst-cover')
        const count = await js(`return ${tiles}.length`)
        await pressButton('Keep as photo', '.filmstrip')
        await wait(`document.querySelectorAll('.filmstrip .frame').length===2`, 'two frames remain')
        await wait(`${tiles}.length===${count + 1}`, 'kept photo appears in the library')
        await expect(`document.querySelector('.viewer .viewer-photo')`, 'viewer remains on the burst')
        await expect(`[...document.querySelectorAll('.filmstrip .frame')].some(f=>f.getAttribute('aria-label').includes('cover'))`, 'remaining burst has a cover')
        await capture('28-burst-kept')
        await key('Escape')
        await wait(`!document.querySelector('.viewer')`, 'viewer closes')
      })

      await step('the last burst frame becomes a photo and leaves the Bursts collection', async () => {
        await sideClick('Bursts')
        await wait(`${tiles}.length===1`, 'one burst in Bursts')
        await click(tileSel(fixture.burstKey))
        await wait(`document.querySelectorAll('.filmstrip .frame').length===2`, 'two frames')
        await pressButton('Keep as photo', '.filmstrip')
        await wait(`!document.querySelector('.viewer')`, 'burst viewer closes when it leaves this collection')
        await expect(`!document.querySelector('.filmstrip')`, 'filmstrip removed')
        await sideClick('Library')
        await wait(`document.querySelector('${tileSel(fixture.burstKey)}')`, 'last frame remains in Library')
        await click(tileSel(fixture.burstKey))
        await wait(`document.querySelector('.viewer-photo')`, 'last frame opens as a photo')
        await expect(`!document.querySelector('.filmstrip')`, 'last frame is a single photo')
        await key('Escape')
      })

      await step('settings stop map tiles, preserve location text, and persist the choice', async () => {
        await click(tileSel(fixture.photoKey))
        await key('i', ['control'])
        await wait(`document.querySelector('.info .map')`, 'map shown from generated cached tiles')
        await key(',', ['control'])
        await wait(`document.querySelector('.preferences[role="dialog"]')`, 'settings opened by shortcut')
        await click('.preferences input[type="checkbox"]')
        await wait(`!document.querySelector('.info .map') && document.querySelector('.map-disabled')`, 'map hidden after switching off')
        await expect(`document.querySelector('.map-foot').textContent.includes('Bengaluru test location')`, 'place name remains')
        await expect(`document.querySelector('.map-disabled').textContent.includes('12.90000, 77.60000')`, 'coordinates remain')
        const settings = JSON.parse(fs.readFileSync(path.join(fixture.profile, 'settings.json'), 'utf8'))
        if (settings.mapsEnabled !== false) throw new Error('map setting not persisted')
        const blocked = await require('electron').net.fetch('photos-media://map/15/23447/15199')
        if (blocked.status !== 403) throw new Error(`disabled map request returned ${blocked.status}`)
        await capture('29-map-settings')
        await key('Escape')
        await wait(`!document.querySelector('.preferences')`, 'settings closed')
        await key('i', ['control'])
        await key('Escape')
      })

      await step('keyboard shortcut help opens, traps focus and returns to the gallery', async () => {
        await key('F1')
        await wait(`document.querySelector('.preferences h2')?.textContent==='Keyboard shortcuts'`, 'shortcut help')
        await expect(`document.querySelector('.preferences').textContent.includes('Ctrl+O')`, 'vault shortcut documented')
        await capture('30-shortcuts')
        await key('Tab')
        await expect(`document.activeElement.closest('.preferences')`, 'focus stays in help')
        await key('Escape')
        await wait(`!document.querySelector('.preferences')`, 'help closed')
        await key('r', ['control'])
        await wait(`document.querySelector('${tileSel(fixture.photoKey)}')`, 'refresh retains the library')
      })

      await step('sidebar hides and returns', async () => {
        win.setContentSize(1280, 820)
        await sleep(300)
        await key('b', ['control'])
        await wait(`!document.querySelector('.sidebar')`, 'sidebar hidden')
        await key('b', ['control'])
        await wait(`document.querySelector('.sidebar')`, 'sidebar back')
        await expect(`document.querySelector('.titlebar img')?.naturalWidth>0`, 'logo in the title bar')
        await expect(`!document.querySelector('.side-brand')`, 'no second Theia in the sidebar')
        const logo = await rect('.titlebar img')
        if (logo.height < 24) throw new Error(`title bar logo is only ${logo.height}px`)
        await capture('26-final')
      })

      results.ok = true
    } catch (e) {
      results.error = `${current}: ${e.message}`
      results.screenText = await js('return document.body.innerText.slice(0,1500)').catch(() => null)
      results.focused = await js('const a=document.activeElement;return a?a.outerHTML.slice(0,240):null').catch(() => null)
      await capture('failure').catch(() => {})
    } finally {
      results.windowTitle = win.getTitle()
      fs.writeFileSync(path.join(out, 'qa-full.json'), JSON.stringify(results, null, 2))
      app.quit()
    }
  })
})
require('../dist-app/main.cjs')
