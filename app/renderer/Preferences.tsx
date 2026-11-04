import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppSettings } from '../shared/settings.ts'
import * as I from './icons.tsx'

export type PreferencesPage = 'settings' | 'shortcuts'

const SHORTCUTS = [
  ['Across the app', [
    ['Ctrl+O', 'Open or create a vault'],
    ['Ctrl+,', 'Settings'],
    ['? or F1', 'Keyboard shortcuts'],
    ['Ctrl+B', 'Show or hide the sidebar'],
    ['Ctrl+I', 'Show or hide info'],
    ['Ctrl+R', 'Refresh the current source'],
  ]],
  ['Grid', [
    ['Arrow keys', 'Move between photos'],
    ['Enter or Space', 'Open the focused photo'],
    ['Ctrl+A', 'Select all photos in this collection'],
    ['Ctrl+click', 'Toggle a photo in the selection'],
    ['Shift+click', 'Select a range'],
    ['Esc', 'Leave selection mode'],
  ]],
  ['Viewer', [
    ['Left / Right', 'Previous or next photo'],
    ['Home / End', 'First or last photo'],
    ['Shift+Left / Right', 'Previous or next burst frame; previous or next video'],
    ['+ / - / 0', 'Zoom in, zoom out, fit photo'],
    ['I', 'Show or hide info'],
    ['Space', 'Play or pause video; close a photo'],
    ['Esc', 'Fit a zoomed photo, then return to the grid'],
  ]],
  ['Editor', [
    ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
    ['Ctrl+S', 'Save an edited copy'],
    ['Hold M', 'Compare with the original'],
    ['Space', 'Play or pause the trimmed video'],
    ['Esc', 'Close the editor'],
  ]],
  ['Video player', [
    ['Space or K', 'Play or pause'],
    ['Left / Right', 'Jump back or forward 5 seconds'],
    ['J / L', 'Jump back or forward 10 seconds'],
    ['Up / Down', 'Raise or lower the volume'],
    ['M / F', 'Mute / full screen'],
    [', / .', 'Previous / next frame while paused'],
    ['< / >', 'Slower / faster playback'],
    ['Home / End', 'Beginning / end of the video'],
    ['0 to 9', 'Jump to 0% through 90% of the video'],
  ]],
] as const

export function Preferences({ settings, page, onPage, onClose }: {
  settings: AppSettings
  page: PreferencesPage
  onPage: (page: PreferencesPage) => void
  onClose: () => void
}) {
  const title = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])

  const maps = async (enabled: boolean) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try { await window.photos.setSettings({ mapsEnabled: enabled }) }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  return createPortal(<div className="modal-scrim preferences-scrim" onPointerDown={e => { if (e.target === e.currentTarget) onClose() }} onKeyDown={e => {
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    if (e.key === 'Tab') {
      const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]')
      const first = controls?.[0], last = controls?.[controls.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }
  }}>
    <div className="preferences" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={title}>
      <div className="preferences-head">
        <h2 id={title}>{page === 'settings' ? 'Settings' : 'Keyboard shortcuts'}</h2>
        <button className="ghost icon" onClick={onClose} aria-label="Close settings"><I.Close /></button>
      </div>
      <div className="preferences-tabs" aria-label="Settings pages">
        <button className={`ghost ${page === 'settings' ? 'on' : ''}`} aria-pressed={page === 'settings'} onClick={() => onPage('settings')}>Privacy</button>
        <button className={`ghost ${page === 'shortcuts' ? 'on' : ''}`} aria-pressed={page === 'shortcuts'} onClick={() => onPage('shortcuts')}>Keyboard shortcuts</button>
      </div>
      <div className="preferences-body">
        {page === 'settings' ? <section className="privacy-setting">
          <label><input type="checkbox" checked={settings.mapsEnabled} aria-disabled={busy} onChange={e => void maps(e.target.checked)} /><span>Show maps in photo info</span></label>
          <p className="muted">Maps request tiles from OpenStreetMap. These requests reveal the photo's approximate area to its tile servers.</p>
          <p className="muted">Turn this off to stop map requests. Place names and coordinates remain available. Opening a location in your browser is a separate action.</p>
          {error && <p role="alert" className="bad">{error}</p>}
        </section> : SHORTCUTS.map(([name, rows]) => <section className="shortcut-section" key={name}>
          <h3>{name}</h3>
          <dl>{rows.map(([keys, description]) => <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{description}</dd></div>)}</dl>
        </section>)}
      </div>
    </div>
  </div>, document.body)
}
