import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SourceId } from '../shared/api.ts'
import * as I from './icons.tsx'

interface Props {
  source: SourceId
  keys: string[]
  collection: string
  onEdit: () => void
  onChanged: () => void
  onError: (message: string) => void
}

type Action = 'hide' | 'remove' | 'restore' | 'purge' | 'favourite'

export function VaultActions({ source, keys, collection, onEdit, onChanged, onError }: Props) {
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<{ action: 'remove' | 'purge'; keys: string[] } | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const deleted = collection === 'deleted'

  useEffect(() => {
    if (!confirm) return
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [confirm])

  const run = async (action: Action, selected = keys) => {
    setBusy(true)
    setConfirm(null)
    try {
      if (action === 'hide') await window.photos.setHidden(source, selected, collection !== 'hidden')
      if (action === 'favourite') await window.photos.setFavourite(source, selected, collection !== 'favourites')
      if (action === 'remove') await window.photos.remove(source, selected)
      if (action === 'restore') await window.photos.restore(source, selected)
      if (action === 'purge') {
        const r = await window.photos.deleteForever(source, selected)
        if (r.failed) onError(`${r.failed} files could not be moved to the Recycle Bin. Their items remain in Recently Deleted.`)
      }
      onChanged()
    } catch (e) { onError((e as Error).message) }
    finally { setBusy(false) }
  }
  const itemCount = confirm ? `${confirm.keys.length} ${confirm.keys.length === 1 ? 'item' : 'items'}` : ''
  return <>
    <div className="vault-actions vault-actions-polished" role="toolbar" aria-label="Vault actions" aria-busy={busy}>
      {deleted ? <>
        <button className="ghost vault-action-recover" aria-label="Recover" disabled={!keys.length || busy} onClick={() => void run('restore')} title="Recover selected items"><span className="vault-action-symbol" aria-hidden="true">↶</span><span>Recover</span></button>
        <button className="ghost vault-action-delete" aria-label="Delete permanently" disabled={!keys.length || busy} onClick={() => setConfirm({ action: 'purge', keys: [...keys] })} title="Delete selected items permanently"><I.Trash size={16} /><span>Delete permanently</span></button>
      </> : <>
        <button className="ghost vault-action-edit" aria-label="Edit" disabled={keys.length !== 1 || busy} onClick={onEdit} title="Edit selected item"><I.Sliders size={16} /><span>Edit</span></button>
        <button className="ghost" aria-label={collection === 'hidden' ? 'Unhide' : 'Hide'} disabled={!keys.length || busy} onClick={() => void run('hide')} title={collection === 'hidden' ? 'Return selected items to the library' : 'Move selected items to Hidden'}><I.Hidden size={16} /><span>{collection === 'hidden' ? 'Unhide' : 'Hide'}</span></button>
        <button className="ghost" aria-label={collection === 'favourites' ? 'Unfavourite' : 'Favourite'} disabled={!keys.length || busy} onClick={() => void run('favourite')} title={collection === 'favourites' ? 'Remove from Favourites' : 'Add to Favourites'}><I.Heart size={16} /><span>{collection === 'favourites' ? 'Unfavourite' : 'Favourite'}</span></button>
        <button className="ghost vault-action-delete" aria-label="Delete" disabled={!keys.length || busy} onClick={() => setConfirm({ action: 'remove', keys: [...keys] })} title="Move selected items to Recently Deleted"><I.Trash size={16} /><span>Delete</span></button>
      </>}
    </div>
    {confirm && createPortal(<div className="modal-scrim vault-confirm-scrim" onPointerDown={e => { if (e.target === e.currentTarget) setConfirm(null) }} onKeyDown={e => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); setConfirm(null) }
      if (e.key === 'Tab') {
        const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        const first = buttons?.[0], last = buttons?.[buttons.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }}>
      <div className="confirm-dialog vault-confirm-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <div className="vault-confirm-icon"><I.Trash size={24} /></div>
        <h2 id={titleId}>{confirm.action === 'remove' ? `Delete ${itemCount}?` : `Permanently delete ${itemCount}?`}</h2>
        <p id={descriptionId}>{confirm.action === 'remove' ? 'These items will move to Recently Deleted in this vault. You can recover them there at any time.' : 'These items will be removed from this vault. Their files will move to the Windows Recycle Bin.'}</p>
        <div className="dialog-buttons">
          <button className="ghost" onClick={() => setConfirm(null)}>Cancel</button>
          <button className="primary destructive-action" onClick={() => void run(confirm.action, confirm.keys)}>{confirm.action === 'remove' ? 'Move to Recently Deleted' : 'Delete permanently'}</button>
        </div>
      </div>
    </div>, document.body)}
  </>
}
