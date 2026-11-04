import { useEffect, useRef, useState } from 'react'
import type { SourceId } from '../shared/api.ts'
import { cleanError } from './format.ts'
import * as I from './icons.tsx'

/**
 * Hidden and Recently Deleted are encrypted in a vault. These are the two
 * ways in: setting a passcode the first time (which shows a recovery key,
 * once), and unlocking.
 */

const message = (e: unknown) => cleanError((e as Error).message)

export function SetUpProtection({ vault, vaultName, onDone, onCancel }: { vault: SourceId; vaultName: string; onDone: () => void; onCancel: () => void }) {
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])

  const ok = a.length >= 6 && a === b
  const submit = async () => {
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      setRecovery(await window.photos.setUpProtection(vault, a))
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-scrim" onKeyDown={(e) => e.key === 'Escape' && !busy && !recovery && onCancel()}>
      <div className="confirm-dialog protect-dialog" role="dialog" aria-modal="true" aria-labelledby="protect-title">
        {!recovery ? (
          <>
            <div className="protect-head">
              <I.Lock size={22} />
              <h2 id="protect-title">Lock Hidden and Recently Deleted</h2>
            </div>
            <p>
              Theia encrypts the photos and videos you hide or delete in <b>{vaultName}</b>, so nobody can open them from the folder.
              You'll need this passcode to see them in Theia, or to bring them back.
            </p>
            <label className="protect-field">
              <span>Passcode</span>
              <input ref={first} type="password" value={a} onChange={(e) => setA(e.target.value)} autoComplete="new-password" disabled={busy} />
            </label>
            <label className="protect-field">
              <span>Type it again</span>
              <input
                type="password"
                value={b}
                onChange={(e) => setB(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
                autoComplete="new-password"
                disabled={busy}
              />
            </label>
            <p className="muted small">
              {a.length > 0 && a.length < 6 ? 'At least 6 characters.' : b && a !== b ? "The two don't match yet." : 'At least 6 characters.'}
            </p>
            {error && (
              <p className="vault-warn" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-buttons">
              <button className="ghost" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button className="primary" onClick={() => void submit()} disabled={!ok || busy}>
                {busy ? 'Encrypting…' : 'Set passcode'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="protect-head">
              <I.Lock size={22} />
              <h2 id="protect-title">Save your recovery key</h2>
            </div>
            <p>
              If you forget the passcode, this key is the <b>only</b> other way to open Hidden and Recently Deleted in {vaultName}.
              Theia can't show it again. Write it down or keep it somewhere safe, away from this computer.
            </p>
            <div className="recovery-key" aria-label="Recovery key">
              {recovery}
            </div>
            <div className="dialog-buttons start">
              <button
                className="ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(recovery).then(() => setCopied(true))
                }}
              >
                {copied ? 'Copied' : 'Copy recovery key'}
              </button>
            </div>
            <label className="protect-check">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              <span>I've saved my recovery key somewhere safe</span>
            </label>
            <div className="dialog-buttons">
              <button className="primary" disabled={!saved} onClick={onDone}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** The passcode (or recovery key) form, used inline on the locked screen and as a dialog. */
export function UnlockForm({ vault, onUnlocked }: { vault: SourceId; onUnlocked: () => void }) {
  const [secret, setSecret] = useState('')
  const [recovery, setRecovery] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [recovery])

  const submit = async () => {
    if (!secret) return
    setBusy(true)
    setError(null)
    try {
      await window.photos.unlockVault(vault, secret)
      setSecret('')
      onUnlocked()
    } catch (e) {
      setError(message(e))
      input.current?.select()
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="unlock-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label className="protect-field">
        <span>{recovery ? 'Recovery key' : 'Passcode'}</span>
        <input
          ref={input}
          type={recovery ? 'text' : 'password'}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={recovery ? 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX' : ''}
          disabled={busy}
        />
      </label>
      {error && (
        <p className="vault-warn" role="alert">
          {error}
        </p>
      )}
      <div className="unlock-actions">
        <button type="button" className="link" onClick={() => setRecovery((r) => !r)}>
          {recovery ? 'Use the passcode' : 'Use the recovery key'}
        </button>
        <button type="submit" className="primary" disabled={!secret || busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </div>
    </form>
  )
}

/** What Hidden or Recently Deleted shows until it is open. */
export function LockedCollection({
  vault,
  vaultName,
  what,
  protection,
  count,
  onSetUp,
}: {
  vault: SourceId
  vaultName: string
  what: 'hidden' | 'deleted'
  protection: 'off' | 'locked'
  count: number | null
  onSetUp: () => void
}) {
  const name = what === 'hidden' ? 'Hidden' : 'Recently Deleted'
  return (
    <div className="empty locked-collection">
      <div className="empty-symbol">
        <I.Lock size={30} />
      </div>
      {protection === 'off' ? (
        <>
          <h2>Lock {name}</h2>
          <p className="muted">
            Set a passcode and Theia encrypts everything you hide or delete in {vaultName}. Nobody can open those photos from the
            folder, and Theia asks for the passcode before showing them.
          </p>
          <button className="primary" onClick={onSetUp}>
            Set a passcode
          </button>
        </>
      ) : (
        <>
          <h2>{name} is locked</h2>
          <p className="muted">
            {count ? `${count} ${count === 1 ? 'item is' : 'items are'} encrypted. ` : ''}Enter the passcode for {vaultName} to see them.
          </p>
          <UnlockForm vault={vault} onUnlocked={() => {}} />
        </>
      )}
    </div>
  )
}

export function UnlockDialog({ vault, vaultName, onDone, onCancel }: { vault: SourceId; vaultName: string; onDone: () => void; onCancel: () => void }) {
  return (
    <div className="modal-scrim" onKeyDown={(e) => e.key === 'Escape' && onCancel()} onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="confirm-dialog protect-dialog" role="dialog" aria-modal="true" aria-labelledby="unlock-title">
        <div className="protect-head">
          <I.Lock size={22} />
          <h2 id="unlock-title">Unlock {vaultName}</h2>
        </div>
        <p className="muted">Hidden and Recently Deleted are encrypted. Enter the passcode to continue.</p>
        <UnlockForm vault={vault} onUnlocked={onDone} />
        <div className="dialog-buttons">
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
