import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppState, SaveRequest, SourceId } from '../shared/api.ts'
import { bytes, count, plural, remainingLabel } from './format.ts'
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
  const [deleteAfterSave, setDeleteAfterSave] = useState(false)
  const [pending, setPending] = useState<SaveRequest | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const title = useId()
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const busy = state.save.status === 'running'
  const targets = state.vaults.filter((v) => v.id !== source)
  const phone = source.startsWith('device:')

  useEffect(() => {
    if (pending) dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [pending])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const frame = requestAnimationFrame(() => box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus())
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(e.key)) return
      const buttons = Array.from(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"], input[type="checkbox"]') ?? [])
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
    const request = { source, keys: [...keys], target, framesOnly, deleteAfterSave: phone && !framesOnly && deleteAfterSave }
    setDeleteAfterSave(false)
    if (request.deleteAfterSave) setPending(request)
    else window.photos.save(request).catch((e: Error) => onError(e.message))
  }

  return (
    <><div className="menu-anchor" ref={box}>
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
          {phone && !framesOnly && <label className="save-cleanup-choice">
            <input type="checkbox" checked={deleteAfterSave} onChange={e => setDeleteAfterSave(e.target.checked)} />
            <span>Delete from iPhone after verified save</span>
          </label>}
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
    {pending && createPortal(<div className="modal-scrim" onKeyDown={e => {
      e.stopPropagation()
      if (e.key === 'Escape') { setPending(null); trigger.current?.focus() }
      if (e.key === 'Tab') {
        const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button')
        const first = buttons?.[0], last = buttons?.[buttons.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }}><div className="confirm-dialog protect-dialog" ref={dialog} role="alertdialog" aria-modal="true" aria-labelledby={title}>
      <h2 id={title}>Save and delete from iPhone?</h2>
      <p>Save {plural(pending.keys.length, 'item')}, then verify every original, edit and companion file. Items that fail a check stay on your iPhone.</p>
      <p>Verification rereads the saved copies and the iPhone originals, checks that the saved files open, and checks the Windows device copy again before deleting. This takes longer than saving alone.</p>
      <p className="vault-warn">Windows may delete permanently. Deleting can also affect iCloud Photos and other synced devices.</p>
      <div className="dialog-buttons"><button className="ghost" onClick={() => { setPending(null); trigger.current?.focus() }}>Cancel</button>
      <button className="primary" onClick={() => { const request = pending; setPending(null); trigger.current?.focus(); void window.photos.save(request).catch((e: Error) => onError(e.message)) }}>Save, verify, then delete</button></div>
    </div></div>, document.body)}</>
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
            Saving into <b>{s.target}</b> · {count(s.itemsDone)} of {count(s.itemsTotal)} ·{' '}
            {s.bytesTotal ? `${bytes(s.bytesDone)} of ${bytes(s.bytesTotal)}` : bytes(s.bytesDone)}
            {s.bytesPerSecond ? ` · ${bytes(s.bytesPerSecond)}/s` : ''}
          </span>
          <span className="bar">
            <span style={{ width: `${savePercent(s)}%` }} />
          </span>
          <span className="status-eta">{s.phase === 'checking-deletion' ? 'Triple-checking before iPhone deletion…' : s.phase === 'deleting' ? 'Deleting verified iPhone originals…' : <>{s.phase === 'verifying' ? 'Checking… · ' : ''}{remainingLabel(s.etaMs)}</>}</span>
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
          {(s.failed.length > 0 || !!s.cleanup?.reasons.length) && (
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
      {s.status === 'done' && showFailed && (s.failed.length > 0 || !!s.cleanup?.reasons.length) && (
        <ul className="failed-list">
          {s.failed.map((f, i) => (
            <li key={i}>
              <span className="mono">{f.file}</span> <span className="muted">{f.reason}</span>
            </li>
          ))}
          {s.cleanup?.reasons.map((r, i) => <li key={`cleanup-${i}`}><span>{r.item}</span> <span className="muted">iPhone cleanup: {r.reason}</span></li>)}
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

/** By bytes when the sizes are known, so one big video doesn't look stuck. */
function savePercent(s: Extract<AppState['save'], { status: 'running' }>): number {
  if (s.bytesTotal) return Math.min(100, (s.bytesDone / s.bytesTotal) * 100)
  return s.itemsTotal ? (s.itemsDone / s.itemsTotal) * 100 : 0
}

function doneText(s: Extract<AppState['save'], { status: 'done' }>): string {
  const parts = [`${s.cancelled ? 'Stopped. ' : ''}Saved ${count(s.saved)} into ${s.target}`]
  if (s.alreadyThere) parts.push(`${count(s.alreadyThere)} ${s.alreadyThere === 1 ? 'was' : 'were'} already there`)
  if (s.skippedCloud) parts.push(`${plural(s.skippedCloud, 'item')} only in iCloud ${s.skippedCloud === 1 ? 'was' : 'were'} skipped`)
  if (s.failed.length) parts.push(`${count(s.failed.length)} failed`)
  if (s.cleanup) parts.push(`${s.cleanup.deleted} deleted from iPhone, ${s.cleanup.kept} kept or not confirmed deleted`)
  return parts.join(', ') + '.'
}
