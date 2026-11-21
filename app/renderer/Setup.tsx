import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppSettings, CustomTheme, IndexingPace } from '../shared/settings.ts'
import { customBase, THEME_IDS, THEMES, type ThemeBase, type ThemeId } from '../shared/themes.ts'

type Change = (patch: Partial<AppSettings>) => Promise<void>

/** Saves a settings change, asking first when it erases something. */
export function useSettingsChange(onError: (message: string) => void): [Change, boolean] {
  const [busy, setBusy] = useState(false)
  const change: Change = async (patch) => {
    if (patch.faceGrouping === false && !window.confirm('Turn off face grouping? This erases the people Theia found and the names you gave them, in every open vault. Your photos are not touched.')) return
    setBusy(true)
    try { await window.photos.setSettings(patch) }
    catch (e) { onError((e as Error).message) }
    finally { setBusy(false) }
  }
  return [change, busy]
}

const PACES: { id: IndexingPace; name: string; note: string }[] = [
  { id: 'gentle', name: 'Gentle', note: 'Works half the time and rests the other half. Quietest, slowest.' },
  { id: 'balanced', name: 'Balanced', note: 'Works two thirds of the time. Recommended.' },
  { id: 'full', name: 'Full speed', note: 'No rests. Fastest, and the fans may spin up.' },
]

/** What Theia reads in the background, and how hard it works at it. */
export function IndexingSettings({ settings, onChange, busy }: { settings: AppSettings; onChange: Change; busy: boolean }) {
  const off = !settings.indexing
  const option = (key: 'searchByMeaning' | 'searchText' | 'faceGrouping', title: string, note: string) => (
    <label className={`setting-row ${off ? 'disabled' : ''}`}>
      <input type="checkbox" checked={settings[key]} disabled={off} aria-disabled={busy} onChange={(e) => void onChange({ [key]: e.target.checked })} />
      <span><b>{title}</b><span className="muted small">{note}</span></span>
    </label>
  )
  return (
    <section className="setting-group" aria-label="Indexing">
      <h3>Indexing</h3>
      <label className="setting-row">
        <input type="checkbox" checked={settings.indexing} aria-disabled={busy} onChange={(e) => void onChange({ indexing: e.target.checked })} />
        <span><b>Read my photos in the background</b><span className="muted small">So you can search them and find people. Everything happens on this computer; nothing is uploaded.</span></span>
      </label>
      <div className="setting-children">
        {option('searchByMeaning', 'Search by what is in them', 'Find “beach”, “temple”, “birthday cake”. Uses the graphics card when there is one.')}
        {option('searchText', 'Search the words written in them', 'Find receipts, tickets, ID cards and signs by their text.')}
        {option('faceGrouping', 'Find faces and group people', 'Name the people in your photos and search for them. Faces in hidden photos are never kept.')}
      </div>
      <div className={`setting-pace ${off ? 'disabled' : ''}`} role="radiogroup" aria-label="Indexing pace">
        <span className="small"><b>Pace</b></span>
        <div className="pace-options">
          {PACES.map((p) => (
            <label key={p.id} className={`pace ${settings.indexingPace === p.id ? 'on' : ''}`} title={p.note}>
              <input type="radio" name="pace" checked={settings.indexingPace === p.id} disabled={off} onChange={() => void onChange({ indexingPace: p.id })} />
              {p.name}
            </label>
          ))}
        </div>
        <span className="muted small">{PACES.find((p) => p.id === settings.indexingPace)?.note}</span>
      </div>
    </section>
  )
}

/** Theme swatches, and four colours for a custom one. */
export function ThemeSettings({ settings, onChange }: { settings: AppSettings; onChange: Change }) {
  const [custom, setCustom] = useState<CustomTheme>(settings.customTheme)
  const timer = useRef(0)
  useEffect(() => setCustom(settings.customTheme), [settings.customTheme])
  const setColour = (key: keyof CustomTheme, value: string) => {
    const next = { ...custom, [key]: value }
    setCustom(next)
    // Dragging the colour picker fires constantly; save once it settles.
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void onChange({ theme: 'custom', customTheme: next }), 150)
  }
  return (
    <section className="setting-group" aria-label="Theme">
      <h3>Theme</h3>
      <div className="theme-grid" role="radiogroup" aria-label="Theme">
        {THEME_IDS.map((id) => {
          const base: ThemeBase = id === 'custom' ? customBase(custom) : THEMES[id]
          return (
            <button
              key={id}
              role="radio"
              aria-checked={settings.theme === id}
              className={`theme-swatch ${settings.theme === id ? 'on' : ''}`}
              onClick={() => void onChange({ theme: id as ThemeId })}
            >
              <span className="theme-preview" style={{ background: base.bg, color: base.text, borderColor: base.surface2 }}>
                <span className="theme-side" style={{ background: base.surface }} />
                <span className="theme-lines">
                  <span style={{ background: base.text }} />
                  <span style={{ background: base.muted }} />
                  <span className="theme-button" style={{ background: base.accent }} />
                </span>
              </span>
              <span className="small">{base.name}</span>
            </button>
          )
        })}
      </div>
      <label className="setting-row">
        <input type="checkbox" checked={settings.liquidGlass} onChange={(e) => void onChange({ liquidGlass: e.target.checked })} />
        <span><b>Liquid Glass</b><span className="muted small">Bars and buttons float over your photos as glass that bends what passes beneath them. Turn off for plain frosted panels, lighter on older graphics. Windows’ “Transparency effects” setting is respected either way.</span></span>
      </label>
      {settings.theme === 'custom' && (
        <div className="custom-theme">
          {([['background', 'Background'], ['surface', 'Panels'], ['text', 'Text'], ['accent', 'Accent']] as const).map(([key, label]) => (
            <label key={key} className="colour-pick">
              <input type="color" value={custom[key]} onChange={(e) => setColour(key, e.target.value)} />
              <span className="small">{label}</span>
            </label>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * The first time Theia opens: what to index, and how it should look. Changes
 * apply as they are made, so the theme previews itself.
 */
export function Welcome({ settings, onError }: { settings: AppSettings; onError: (message: string) => void }) {
  const title = useId()
  const [change, busy] = useSettingsChange(onError)
  const start = useRef<HTMLButtonElement>(null)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    start.current?.focus({ preventScroll: true })
    // Open at the top, on the first choice.
    requestAnimationFrame(() => body.current?.scrollTo({ top: 0 }))
  }, [])
  return createPortal(
    <div className="modal-scrim preferences-scrim welcome-scrim">
      <div className="preferences welcome-dialog" role="dialog" aria-modal="true" aria-labelledby={title}>
        <div className="preferences-head">
          <div>
            <h2 id={title}>Welcome to Theia</h2>
            <p className="muted small">Choose what Theia reads in your photos, and how it looks.</p>
          </div>
        </div>
        <div className="preferences-body" ref={body}>
          <IndexingSettings settings={settings} onChange={change} busy={busy} />
          <ThemeSettings settings={settings} onChange={change} />
          <p className="muted small setting-later">You can change any of these at any time in Settings (Ctrl+,).</p>
        </div>
        <div className="welcome-foot">
          <button ref={start} className="primary" onClick={() => void change({ setupDone: true })}>Start using Theia</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
