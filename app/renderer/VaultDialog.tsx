import { useEffect, useRef, useState } from 'react'
import type { SourceId, VaultDetails } from '../shared/api.ts'
import { bytes, count } from './format.ts'
import * as I from './icons.tsx'

interface Props {
  id: SourceId
  onClose: () => void
  /** The vault was removed from Theia or deleted. */
  onGone: (message: string) => void
  onError: (message: string) => void
}

/**
 * Where a vault lives, how big it is, and the ways to let go of it: remove it
 * from Theia (files kept) or delete it. Deleting needs the vault's name typed,
 * and goes to the Recycle Bin unless the folder is too big for it, in which
 * case Windows would delete it for good, so that is asked for separately.
 */
export function VaultDialog({ id, onClose, onGone, onError }: Props) {
  const [d, setD] = useState<VaultDetails | null>(null)
  const [step, setStep] = useState<'info' | 'delete'>('info')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const card = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    window.photos.vaultDetails(id).then((x) => live && setD(x)).catch((e: Error) => onError(e.message))
    return () => {
      live = false
    }
  }, [id])

  useEffect(() => {
    card.current?.querySelector<HTMLElement>(step === 'delete' ? 'input' : 'button')?.focus()
  }, [step, d])

  const remove = async () => {
    setBusy(true)
    try {
      await window.photos.closeVault(id)
      onGone(`${d?.name ?? 'The vault'} was removed from Theia. Its files are still in ${d?.root}.`)
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
    }
  }
  const destroy = async (mode: 'recycle' | 'permanent') => {
    setBusy(true)
    try {
      await window.photos.deleteVault(id, typed, mode)
      onGone(mode === 'recycle' ? `${d!.name} is in the Recycle Bin.` : `${d!.name} was deleted.`)
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
    }
  }

  const nameOk = !!d && typed.trim() === d.name

  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && !busy && (step === 'delete' ? setStep('info') : onClose())}
    >
      <div className="confirm-dialog vault-dialog" ref={card} role="dialog" aria-modal="true" aria-labelledby="vault-dialog-title">
        {!d ? (
          <p className="muted">Reading the vault…</p>
        ) : step === 'info' ? (
          <>
            <div className="vault-dialog-head">
              <I.Vault size={22} />
              <div>
                <h2 id="vault-dialog-title">{d.name}</h2>
                <p className="muted small">{d.kind === 'library' ? 'Import library' : 'Vault made by Theia'}</p>
              </div>
            </div>
            <dl className="vault-facts">
              <div>
                <dt>Location</dt>
                <dd className="mono vault-path" title={d.root}>
                  {d.root}
                </dd>
              </div>
              <div>
                <dt>Items</dt>
                <dd>{count(d.count)}</dd>
              </div>
              <div>
                <dt>Size on disk</dt>
                <dd>{bytes(d.bytes)}</dd>
              </div>
            </dl>
            <div className="dialog-buttons start">
              <button className="ghost" onClick={() => void window.photos.revealVault(id)} disabled={busy}>
                <I.Folder size={16} /> Show in File Explorer
              </button>
              <button
                className="ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(d.root).then(() => setCopied(true))
                }}
              >
                {copied ? 'Copied' : 'Copy location'}
              </button>
            </div>
            <div className="vault-danger">
              <div>
                <b>Remove from Theia</b>
                <p className="muted small">Theia stops showing this vault. The folder and every photo in it stay where they are, and you can open it again later.</p>
              </div>
              <button className="ghost" onClick={() => void remove()} disabled={busy}>
                Remove
              </button>
            </div>
            <div className="vault-danger">
              <div>
                <b>Delete vault</b>
                <p className="muted small">Deletes the folder and every photo and video in it.</p>
              </div>
              <button className="ghost destructive-action" onClick={() => setStep('delete')} disabled={busy}>
                Delete…
              </button>
            </div>
            <div className="dialog-buttons">
              <button className="primary" onClick={onClose} disabled={busy}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="vault-dialog-title">Delete {d.name}?</h2>
            <p>
              This deletes <span className="mono">{d.root}</span>: {count(d.count)} items, {bytes(d.bytes)}.
            </p>
            {d.fitsRecycleBin === true ? (
              <p className="muted">It goes to the Recycle Bin, so you can still restore it from there.</p>
            ) : (
              <p className="vault-warn" role="alert">
                {d.fitsRecycleBin === false
                  ? `This vault is bigger than the Recycle Bin on this drive (${bytes(d.recycleBinMax ?? 0)}), so Windows can't keep it there. Deleting it is permanent.`
                  : "Theia couldn't check this drive's Recycle Bin limit, so it won't promise the vault can be restored. Deleting it is permanent."}
              </p>
            )}
            <label className="vault-type">
              <span>
                Type <b>{d.name}</b> to confirm
              </span>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoComplete="off" disabled={busy} />
            </label>
            <div className="dialog-buttons">
              <button className="ghost" onClick={() => setStep('info')} disabled={busy}>
                Back
              </button>
              {d.fitsRecycleBin === true ? (
                <button className="primary destructive-action" disabled={!nameOk || busy} onClick={() => void destroy('recycle')}>
                  {busy ? 'Deleting…' : 'Move to Recycle Bin'}
                </button>
              ) : (
                <button className="primary destructive-action" disabled={!nameOk || busy} onClick={() => void destroy('permanent')}>
                  {busy ? 'Deleting…' : 'Delete permanently'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
