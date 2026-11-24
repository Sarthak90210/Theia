import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SourceId } from '../shared/api.ts'
import type { CollectionInfo } from '../../src/gallery/types.ts'
import { cleanError, count } from './format.ts'
import * as I from './icons.tsx'

/**
 * Folders inside Hidden: all opened by the vault's one passcode, listed only
 * while it is open (the service sends none while locked). Hidden itself still
 * shows everything hidden; a folder is a way to sort it.
 */

/** A menu that closes on Escape or a click outside, and moves with the arrow keys. */
function useMenu(open: boolean, close: () => void, box: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) close() }
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
      const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]
      if (!items.length) return
      e.preventDefault()
      const i = items.indexOf(document.activeElement as HTMLElement)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
      items[next]?.focus()
    }
    const frame = requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus())
    window.addEventListener('mousedown', outside)
    window.addEventListener('keydown', keys, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('mousedown', outside)
      window.removeEventListener('keydown', keys, true)
    }
  }, [open, close, box])
}

/** "Move to folder…" for items selected in Hidden or one of its folders. */
export function MoveToFolderMenu({ source, keys, folders, collection, disabled, onMoved, onError }: {
  source: SourceId
  keys: string[]
  folders: CollectionInfo[]
  collection: string
  disabled: boolean
  onMoved: (message: string) => void
  onError: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(() => setOpen(false)).current
  useMenu(open, close, box)

  const move = async (folder: string | null, name: string) => {
    setOpen(false)
    try {
      const n = await window.photos.moveToHiddenFolder(source, keys, folder)
      onMoved(folder === null ? `${count(n)} taken out of the folder.` : `${count(n)} moved to ${name}.`)
    } catch (e) { onError(cleanError((e as Error).message)) }
  }

  return (
    <div className="menu-anchor" ref={box}>
      <button className="ghost" disabled={disabled || !keys.length} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)} title="Sort the selected items into a folder in Hidden">
        <I.Folder size={16} /><span>Move to folder</span>
      </button>
      {open && (
        <div className="menu move-folder-menu" role="menu">
          <div className="menu-heading">Folders in Hidden</div>
          {folders.map((f) => (
            <button key={f.id} role="menuitem" className="menu-item" disabled={f.id === collection} onClick={() => void move(f.id, f.name)}>
              <I.Folder size={16} /><span>{f.name}</span><span className="muted small">{count(f.count)}</span>
            </button>
          ))}
          {collection.startsWith('hidden:') && (
            <button role="menuitem" className="menu-item" onClick={() => void move(null, 'Hidden')}>
              <I.Hidden size={16} /><span>Out of this folder</span>
            </button>
          )}
          <button role="menuitem" className="menu-item" onClick={() => { setOpen(false); setNaming(true) }}>
            <I.Plus size={16} /><span>New folder…</span>
          </button>
        </div>
      )}
      {naming && (
        <FolderNameDialog
          title="New folder in Hidden"
          action="Create and move"
          onCancel={() => setNaming(false)}
          onSubmit={async (name) => {
            const folder = await window.photos.createHiddenFolder(source, name)
            setNaming(false)
            await move(folder, name.trim())
          }}
        />
      )}
    </div>
  )
}

/** The folders under Hidden in the sidebar, each with Rename and Delete, and "New folder…". */
export function HiddenFolderRows({ source, folders, collection, onCollection, onError }: {
  source: SourceId
  folders: CollectionInfo[]
  collection: string
  onCollection: (id: string) => void
  onError: (message: string) => void
}) {
  const [naming, setNaming] = useState<{ folder: CollectionInfo | null } | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<CollectionInfo | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(() => setMenu(null)).current
  useMenu(menu !== null, close, box)

  return (
    <div className="hidden-folders" ref={box}>
      {folders.map((f) => (
        <div key={f.id} className="side-row side-sub">
          <button className={`side-item ${collection === f.id ? 'active' : ''}`} aria-current={collection === f.id ? 'page' : undefined} onClick={() => onCollection(f.id)}>
            <I.Folder />
            <span className="side-label">{f.name}</span>
            <span className="side-count">{count(f.count)}</span>
          </button>
          <button className="side-more" aria-label={`${f.name}: rename or delete`} aria-haspopup="menu" aria-expanded={menu === f.id} title="Rename or delete" onClick={() => setMenu((m) => (m === f.id ? null : f.id))}>
            <span aria-hidden="true">⋯</span>
          </button>
          {menu === f.id && (
            <div className="menu side-folder-menu" role="menu">
              <button role="menuitem" className="menu-item" onClick={() => { setMenu(null); setNaming({ folder: f }) }}><span>Rename…</span></button>
              <button role="menuitem" className="menu-item danger" onClick={() => { setMenu(null); setDeleting(f) }}><span>Delete folder…</span></button>
            </div>
          )}
        </div>
      ))}
      <button className="side-item subtle side-sub" onClick={() => setNaming({ folder: null })}>
        <I.Plus /><span className="side-label">New folder…</span>
      </button>
      {naming && (
        <FolderNameDialog
          title={naming.folder ? 'Rename folder' : 'New folder in Hidden'}
          action={naming.folder ? 'Rename' : 'Create'}
          initial={naming.folder?.name}
          onCancel={() => setNaming(null)}
          onSubmit={async (name) => {
            if (naming.folder) await window.photos.renameHiddenFolder(source, naming.folder.id, name)
            else onCollection(await window.photos.createHiddenFolder(source, name))
            setNaming(null)
          }}
        />
      )}
      {deleting && createPortal(
        <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && setDeleting(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setDeleting(null) } }}>
          <div className="confirm-dialog vault-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-delete-title">
            <h2 id="folder-delete-title">Delete “{deleting.name}”?</h2>
            <p>The folder goes. {deleting.count ? `Its ${count(deleting.count)} ${deleting.count === 1 ? 'item stays' : 'items stay'} in Hidden, encrypted as before.` : 'It is empty.'}</p>
            <div className="dialog-buttons">
              <button className="ghost" autoFocus onClick={() => setDeleting(null)}>Cancel</button>
              <button className="primary" onClick={() => {
                const f = deleting
                setDeleting(null)
                if (collection === f.id) onCollection('hidden')
                window.photos.deleteHiddenFolder(source, f.id).catch((e: Error) => onError(cleanError(e.message)))
              }}>Delete folder</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

/** Ask for a folder's name. Errors (a name already used, say) show in the dialog. */
export function FolderNameDialog({ title, action, initial = '', onSubmit, onCancel }: {
  title: string
  action: string
  initial?: string
  onSubmit: (name: string) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  return createPortal(
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); if (!busy) onCancel() } }}>
      <form className="confirm-dialog folder-name-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim() || busy) return
          setBusy(true)
          setError(null)
          onSubmit(name).catch((err: Error) => { setError(cleanError(err.message)); setBusy(false) })
        }}>
        <h2 id={titleId}>{title}</h2>
        <label className="protect-field">
          <span>Name</span>
          <input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Documents, Private, …" />
        </label>
        {error && <p className="vault-warn" role="alert">{error}</p>}
        <div className="dialog-buttons">
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={!name.trim() || busy}>{busy ? 'Saving…' : action}</button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
