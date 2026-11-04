import { useEffect, useRef, useState } from 'react'
import type { AppState, SourceId } from '../shared/api.ts'
import { bytes, count, plural } from './format.ts'
import * as I from './icons.tsx'

export interface SaveMenuProps {
  state: AppState
  source: SourceId
  keys: string[]
  label: string
  primary?: boolean
  framesOnly?: boolean
  onError: (message: string) => void
}

/** "Save to…" with the open vaults and a new one. */
export function SaveMenu({ state, source, keys, label, primary, framesOnly, onError }: SaveMenuProps) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const busy = state.save.status === 'running'
  const targets = state.vaults.filter((v) => v.id !== source)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const frame = requestAnimationFrame(() => box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus())
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(e.key)) return
      const buttons = Array.from(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
      if (!buttons.length) return
      e.preventDefault()
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 :
        (index + ((e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) ? -1 : 1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
      cancelAnimationFrame(frame)
    }
  }, [open])

  const go = (target: { vault: SourceId } | { newVault: true }) => {
    setOpen(false)
    trigger.current?.focus()
    window.photos.save({ source, keys, target, framesOnly }).catch((e: Error) => onError(e.message))
  }

  return (
    <div className="menu-anchor" ref={box}>
      <button
        ref={trigger}
        className={primary ? 'primary' : 'ghost'}
        disabled={busy || keys.length === 0}
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={busy ? 'A save is already running' : label}
      >
        <I.Download size={16} /><span className="save-label">{label}</span>
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Save to a vault">
          <div className="menu-heading">Save {plural(keys.length, 'item')} into</div>
          {targets.map((v) => (
            <button key={v.id} role="menuitem" className="menu-item" onClick={() => go({ vault: v.id })}>
              <I.Vault size={16} />
              <span>{v.name}</span>
              <span className="muted small">{count(v.count)}</span>
            </button>
          ))}
          {targets.length > 0 && <div className="menu-line" />}
          <button role="menuitem" className="menu-item" onClick={() => go({ newVault: true })}>
            <I.Plus size={16} />
            <span>New vault…</span>
          </button>
        </div>
      )}
    </div>
  )
}

/** The strip along the bottom: a save in progress or its result, and thumbnails. */
export function StatusBar({ state }: { state: AppState }) {
  const s = state.save
  const [showFailed, setShowFailed] = useState(false)
  const t = state.thumbnails

  return (
    <footer className="status">
      {s.status === 'running' && (
        <div className="status-save">
          <span>
            Saving into <b>{s.target}</b> · {count(s.itemsDone)} of {count(s.itemsTotal)} · {bytes(s.bytesDone)}
          </span>
          <span className="bar">
            <span style={{ width: `${s.itemsTotal ? (s.itemsDone / s.itemsTotal) * 100 : 0}%` }} />
          </span>
          {s.current && (
            <span className="muted small current" title={s.current}>
              {s.current}
            </span>
          )}
          <button className="ghost small" onClick={() => void window.photos.cancelSave()}>
            Stop
          </button>
        </div>
      )}
      {s.status === 'done' && (
        <div className={`status-save ${s.failed.length ? 'attention' : ''}`}>
          <span>{doneText(s)}</span>
          {s.failed.length > 0 && (
            <button className="link" onClick={() => setShowFailed((v) => !v)}>
              {showFailed ? 'Hide' : 'Show'} what failed
            </button>
          )}
          <button className="ghost small" onClick={() => void window.photos.dismissSave()}>
            OK
          </button>
        </div>
      )}
      {s.status === 'error' && (
        <div className="status-save attention">
          <span>
            Could not save into <b>{s.target}</b>. {s.error}
          </span>
          <button className="ghost small" onClick={() => void window.photos.dismissSave()}>
            OK
          </button>
        </div>
      )}
      {s.status === 'done' && showFailed && s.failed.length > 0 && (
        <ul className="failed-list">
          {s.failed.map((f, i) => (
            <li key={i}>
              <span className="mono">{f.file}</span> <span className="muted">{f.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {s.status === 'idle' && <span className="muted small">{t ? '' : 'Ready'}</span>}
      {t && (
        <span className="status-thumbs muted small">
          Making thumbnails · {count(t.done)} of {count(t.total)}
          <span className="bar small">
            <span style={{ width: `${t.total ? (t.done / t.total) * 100 : 0}%` }} />
          </span>
        </span>
      )}
    </footer>
  )
}

function doneText(s: Extract<AppState['save'], { status: 'done' }>): string {
  const parts = [`${s.cancelled ? 'Stopped. ' : ''}Saved ${count(s.saved)} into ${s.target}`]
  if (s.alreadyThere) parts.push(`${count(s.alreadyThere)} ${s.alreadyThere === 1 ? 'was' : 'were'} already there`)
  if (s.skippedCloud) parts.push(`${plural(s.skippedCloud, 'item')} only in iCloud ${s.skippedCloud === 1 ? 'was' : 'were'} skipped`)
  if (s.failed.length) parts.push(`${count(s.failed.length)} failed`)
  return parts.join(', ') + '.'
}
