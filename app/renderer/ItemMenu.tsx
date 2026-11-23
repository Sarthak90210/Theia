import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GalleryItem, SourceId } from '../shared/api.ts'
import { cleanError, count, plural } from './format.ts'
import * as I from './icons.tsx'

/**
 * The right-click menu on photos, as in Photos on Windows: Copy, Share,
 * Delete and Print along the top; Save as, Open with, Copy as path, Resize,
 * Set as, the filmstrip and the slideshow below. It works on what was
 * right-clicked, or on the whole selection when that was part of it.
 *
 * Copy, Share, Open with and Set as go through Windows itself
 * (src/shell/desktop.ts), so they behave as they do in File Explorer.
 */

export interface MenuTarget {
  items: GalleryItem[]
  /** Where the pointer was, in the window. */
  x: number
  y: number
}

export interface ItemMenuProps {
  source: SourceId
  target: MenuTarget
  /** A vault (things can be deleted, files have paths), not a phone. */
  vault: boolean
  /** Recently Deleted: Delete means delete permanently. */
  collection: string
  /** In the viewer the filmstrip can be shown; in the grid, not. */
  inViewer: boolean
  filmstrip: boolean
  onFilmstrip: () => void
  onSlideshow: () => void
  onDelete: (keys: string[], action: 'remove' | 'purge') => void
  onResize: (item: GalleryItem) => void
  /** Looking at someone's photos: offer "Use as their photo". */
  person?: { id: number; name: string | null } | null
  onNotice: (message: string) => void
  onError: (message: string) => void
  onClose: () => void
}

/* ------------------------------------------------------------- actions */
// Shared with the keyboard shortcuts (App.tsx), so Ctrl+S and the menu agree.

export async function saveCopies(source: SourceId, keys: string[], onNotice: (m: string) => void, onError: (m: string) => void) {
  try {
    const where = await window.photos.saveItemsAs(source, keys)
    if (where) onNotice(keys.length === 1 ? `Saved a copy to ${where}` : `Saved ${count(keys.length)} copies to ${where}`)
  } catch (e) {
    onError((e as Error).message)
  }
}

export async function copyPaths(source: SourceId, keys: string[], onNotice: (m: string) => void, onError: (m: string) => void) {
  try {
    await navigator.clipboard.writeText(await window.photos.itemPaths(source, keys))
    onNotice(keys.length === 1 ? 'Copied its path.' : `Copied ${count(keys.length)} paths.`)
  } catch (e) {
    onError((e as Error).message)
  }
}

/** The middle of Theia's window on screen: where Windows' share sheet goes. */
function windowMiddle() {
  return { x: window.screenX + window.outerWidth / 2, y: window.screenY + window.outerHeight / 2 }
}

/* ---------------------------------------------------------------- menu */

type Entry =
  | { kind: 'item'; id: string; label: string; icon: React.ReactNode; shortcut?: string; disabled?: string | false; run: () => void | Promise<void> }
  | { kind: 'sub'; id: string; label: string; icon: React.ReactNode; disabled?: string | false; open: () => void }
  | { kind: 'line' }

export function ItemMenu(props: ItemMenuProps) {
  const { source, target, vault, onNotice, onError, onClose } = props
  const items = target.items
  const keys = items.map((i) => i.key)
  const one = items.length === 1 ? items[0]! : null
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: target.x, top: target.y })
  const [sub, setSub] = useState<{ id: 'open' | 'set'; top: number } | null>(null)
  const [apps, setApps] = useState<{ id: string; label: string }[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const subBox = useRef<HTMLDivElement>(null)
  /** How far the submenu moved up to stay inside the window. */
  const [subShift, setSubShift] = useState(0)

  // Inside the window, whatever the size of the menu.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(target.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(target.y, window.innerHeight - r.height - 8)),
    })
    el.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [target.x, target.y])

  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose() }
    const blur = () => onClose()
    window.addEventListener('mousedown', away, true)
    window.addEventListener('blur', blur)
    window.addEventListener('resize', blur)
    return () => {
      window.removeEventListener('mousedown', away, true)
      window.removeEventListener('blur', blur)
      window.removeEventListener('resize', blur)
    }
  }, [onClose])

  // The apps for Open with, asked of Windows as soon as the menu opens: it takes a second.
  useEffect(() => {
    if (!one) return
    let live = true
    window.photos.openWithChoices(source, one.key).then((a) => live && setApps(a)).catch(() => live && setApps([]))
    return () => { live = false }
  }, [source, one?.key])

  const act = (id: string, fn: () => Promise<void>, keepOpen = false) => async () => {
    if (busy) return
    setBusy(id)
    if (!keepOpen) onClose()
    try {
      await fn()
    } catch (e) {
      onError(cleanError((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const deleted = props.collection === 'deleted'
  const why: Record<'one' | 'photo' | 'vault', string | false> = {
    one: items.length > 1 ? 'Works on one item at a time' : false,
    photo: one?.kind === 'video' ? 'Works with photos, not videos' : false,
    vault: vault ? false : 'Save it into a vault first',
  }
  const firstReason = (...reasons: (string | false)[]) => reasons.find((r) => r) ?? false

  const top: Entry[] = [
    { kind: 'item', id: 'copy', label: 'Copy', icon: <I.Copy />, run: act('copy', async () => { await window.photos.copyItems(source, keys); onNotice(items.length === 1 ? 'Copied. Paste it into a folder, a chat or a document.' : `Copied ${count(items.length)} items.`) }) },
    { kind: 'item', id: 'share', label: 'Share', icon: <I.Share />, run: act('share', () => window.photos.shareItems(source, keys, windowMiddle())) },
    { kind: 'item', id: 'delete', label: 'Delete', icon: <I.Trash />, disabled: firstReason(why.vault), run: () => { onClose(); props.onDelete(keys, deleted ? 'purge' : 'remove') } },
    { kind: 'item', id: 'print', label: 'Print', icon: <I.Print />, disabled: firstReason(why.one, why.photo), run: act('print', () => window.photos.printItem(source, one!.key)) },
  ]
  const list: Entry[] = [
    { kind: 'item', id: 'save', label: 'Save as', icon: <I.SaveAs />, shortcut: 'Ctrl+S', run: act('save', () => saveCopies(source, keys, onNotice, onError)) },
    { kind: 'sub', id: 'open', label: 'Open with', icon: <I.OpenWith />, disabled: firstReason(why.one), open: () => openSub('open') },
    { kind: 'item', id: 'path', label: 'Copy as path', icon: <I.Path />, shortcut: 'Ctrl+Shift+C', disabled: firstReason(why.vault), run: act('path', () => copyPaths(source, keys, onNotice, onError)) },
    { kind: 'line' },
    { kind: 'item', id: 'resize', label: 'Resize image', icon: <I.Resize />, disabled: firstReason(why.one, why.photo), run: () => { onClose(); props.onResize(one!) } },
    { kind: 'sub', id: 'set', label: 'Set as', icon: <I.SetAs />, disabled: firstReason(why.one, why.photo), open: () => openSub('set') },
    ...(props.person
      ? [{
          kind: 'item', id: 'cover', label: `Use as ${props.person.name ? `${props.person.name}’s` : 'their'} photo`, icon: <I.Person />,
          disabled: firstReason(why.one),
          run: act('cover', async () => {
            await window.photos.setPersonCoverFromPhoto(source, props.person!.id, one!.key)
            onNotice(`Now shown for ${props.person!.name ?? 'them'} in People.`)
          }),
        } as Entry]
      : []),
    { kind: 'line' },
    ...(props.inViewer
      ? [{ kind: 'item', id: 'film', label: props.filmstrip ? 'Hide filmstrip' : 'Show filmstrip', icon: <I.Filmstrip />, shortcut: 'F', run: () => { onClose(); props.onFilmstrip() } } as Entry]
      : []),
    { kind: 'item', id: 'slides', label: 'Start slideshow', icon: <I.Slideshow />, shortcut: 'F5', run: () => { onClose(); props.onSlideshow() } },
  ]

  // A submenu near the bottom of the window moves up to stay inside it: again
  // once Windows' list of apps arrives and makes it longer.
  useLayoutEffect(() => {
    const el = subBox.current
    if (!el || !sub) return setSubShift(0)
    const bottom = el.getBoundingClientRect().bottom + subShift
    setSubShift(Math.max(0, bottom - (window.innerHeight - 8)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, apps])

  function openSub(id: 'open' | 'set') {
    const button = box.current?.querySelector<HTMLElement>(`[data-entry="${id}"]`)
    const menu = box.current?.getBoundingClientRect()
    setSub({ id, top: button && menu ? button.getBoundingClientRect().top - menu.top - 6 : 0 })
    requestAnimationFrame(() => box.current?.querySelector<HTMLButtonElement>('.item-submenu [role="menuitem"]:not(:disabled)')?.focus())
  }

  const subEntries: Entry[] = sub?.id === 'set'
    ? [
        { kind: 'item', id: 'desktop', label: 'Desktop background', icon: <I.SetAs />, run: act('desktop', async () => { await window.photos.setItemAs(source, one!.key, 'desktop'); onNotice('Set as your desktop background.') }) },
        { kind: 'item', id: 'lock', label: 'Lock screen', icon: <I.Lock />, run: act('lock', async () => { await window.photos.setItemAs(source, one!.key, 'lock'); onNotice('Set as your lock screen picture.') }) },
      ]
    : sub?.id === 'open'
      ? [
          ...(apps === null
            ? [{ kind: 'item', id: 'loading', label: 'Asking Windows…', icon: <span className="spinner small" />, disabled: 'Asking Windows which apps can open it', run: () => {} } as Entry]
            : apps.map((a): Entry => ({ kind: 'item', id: `app:${a.id}`, label: a.label, icon: <I.OpenWith />, run: act(`app:${a.id}`, () => window.photos.openItemWith(source, one!.key, a.id)) }))),
          { kind: 'line' },
          { kind: 'item', id: 'choose', label: 'Choose another app', icon: <I.Search />, run: act('choose', () => window.photos.openItemWith(source, one!.key, 'choose')) },
        ]
      : []

  // Arrow keys move through the enabled entries of the menu that has focus.
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    const inSub = !!(e.target as HTMLElement).closest('.item-submenu')
    const scope = inSub ? box.current?.querySelector('.item-submenu') : box.current?.querySelector('.item-menu-main')
    const buttons = Array.from(scope?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      if (inSub) { setSub(null); box.current?.querySelector<HTMLButtonElement>(`[data-entry="${sub?.id}"]`)?.focus() }
      else onClose()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    } else if (e.key === 'ArrowRight' && !inSub) {
      const id = (document.activeElement as HTMLElement)?.dataset.entry
      if (id === 'open' || id === 'set') { e.preventDefault(); openSub(id) }
    } else if (e.key === 'ArrowLeft' && inSub) {
      e.preventDefault()
      setSub(null)
      box.current?.querySelector<HTMLButtonElement>(`[data-entry="${sub?.id}"]`)?.focus()
    } else if (e.key === 'Tab') {
      e.preventDefault()
    }
  }

  const row = (e: Entry, i: number, inSub = false) => {
    if (e.kind === 'line') return <div key={`line${i}`} className="item-menu-line" role="separator" />
    const reason = e.disabled || undefined
    return (
      <button
        key={e.id}
        role="menuitem"
        data-entry={e.id}
        className={`item-menu-row ${e.kind === 'sub' && sub?.id === e.id ? 'open' : ''}`}
        disabled={!!reason || busy === e.id}
        title={reason}
        aria-haspopup={e.kind === 'sub' ? 'menu' : undefined}
        aria-expanded={e.kind === 'sub' ? sub?.id === e.id : undefined}
        onMouseEnter={() => {
          if (inSub) return
          if (e.kind === 'sub') { if (!reason && sub?.id !== e.id) openSub(e.id as 'open' | 'set') }
          else setSub(null)
        }}
        onClick={() => (e.kind === 'sub' ? openSub(e.id as 'open' | 'set') : void e.run())}
      >
        <span className="item-menu-icon">{e.icon}</span>
        <span className="item-menu-label">{e.label}</span>
        {e.kind === 'item' && e.shortcut && <kbd className="item-menu-key">{e.shortcut}</kbd>}
        {e.kind === 'sub' && <I.Right size={14} className="item-menu-chevron" />}
      </button>
    )
  }

  const subLeft = pos.left + 300 + 260 > window.innerWidth
  return createPortal(
    <div className="item-menu" ref={box} style={{ left: pos.left, top: pos.top }} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
      <div className="item-menu-main" role="menu" aria-label={items.length === 1 ? 'Photo actions' : `Actions for ${plural(items.length, 'item')}`}>
        <div className="item-menu-top">
          {top.map((e) => e.kind === 'item' && (
            <button key={e.id} role="menuitem" data-entry={e.id} className="item-menu-tile" disabled={!!e.disabled || busy === e.id} title={e.disabled || e.label} onClick={() => void e.run()} onMouseEnter={() => setSub(null)}>
              {e.icon}
              <span>{e.label}</span>
            </button>
          ))}
        </div>
        <div className="item-menu-line" role="separator" />
        {list.map((e, i) => row(e, i))}
      </div>
      {sub && (
        <div ref={subBox} className={`item-submenu ${subLeft ? 'left' : ''}`} role="menu" aria-label={sub.id === 'open' ? 'Open with' : 'Set as'} style={{ top: sub.top - subShift }}>
          {sub.id === 'open' && <div className="item-menu-note">Vault photos open as a copy, so the original stays as it is.</div>}
          {subEntries.map((e, i) => row(e, i, true))}
        </div>
      )}
    </div>,
    document.body,
  )
}

/* -------------------------------------------------------------- resize */

const PRESETS = [
  { id: 's', name: 'Small', edge: 640, note: 'for messages' },
  { id: 'm', name: 'Medium', edge: 1280, note: 'for email' },
  { id: 'l', name: 'Large', edge: 1920, note: 'for screens' },
] as const

/** "Resize image": a size and a format, then where to save the copy. The original is never changed. */
export function ResizeDialog({ source, item, onClose, onNotice, onError }: {
  source: SourceId
  item: GalleryItem
  onClose: () => void
  onNotice: (m: string) => void
  onError: (m: string) => void
}) {
  const w0 = item.w ?? 0, h0 = item.h ?? 0
  const known = w0 > 0 && h0 > 0
  const [preset, setPreset] = useState<'s' | 'm' | 'l' | 'custom'>('m')
  const [width, setWidth] = useState(known ? Math.min(w0, 1280) : 1280)
  const [height, setHeight] = useState(known ? Math.round((Math.min(w0, 1280) * h0) / w0) : 1280)
  const [format, setFormat] = useState<'jpeg' | 'png' | 'webp'>('jpeg')
  const [quality, setQuality] = useState(88)
  const [busy, setBusy] = useState(false)
  const title = useId()
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => { card.current?.querySelector<HTMLInputElement>('input')?.focus() }, [])

  /** The box a preset fits the picture into, and the size that comes out. */
  const sizeFor = (edge: number) => {
    if (!known) return { box: [edge, edge] as const, out: null }
    const s = Math.min(1, edge / Math.max(w0, h0))
    return { box: [edge, edge] as const, out: [Math.round(w0 * s), Math.round(h0 * s)] as const }
  }
  const setW = (v: number) => { setWidth(v); if (known) setHeight(Math.max(1, Math.round((v * h0) / w0))) }
  const setH = (v: number) => { setHeight(v); if (known) setWidth(Math.max(1, Math.round((v * w0) / h0))) }

  const save = async () => {
    const box = preset === 'custom' ? [width, height] : sizeFor(PRESETS.find((p) => p.id === preset)!.edge).box
    setBusy(true)
    try {
      const where = await window.photos.resizeItem(source, item.key, { width: box[0], height: box[1], format, quality })
      if (where) { onNotice(`Saved a resized copy to ${where}`); onClose() }
      else setBusy(false)
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
    }
  }

  return createPortal(
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape' && !busy) onClose() }}>
      <div className="confirm-dialog resize-dialog" ref={card} role="dialog" aria-modal="true" aria-labelledby={title}>
        <h2 id={title}>Resize image</h2>
        <p className="muted small">{known ? `Now ${w0} × ${h0} pixels. ` : ''}A resized copy is saved where you choose; the original stays as it is.</p>
        <div className="resize-presets" role="radiogroup" aria-label="Size">
          {PRESETS.map((p) => {
            const out = sizeFor(p.edge).out
            return (
              <label key={p.id} className={`resize-preset ${preset === p.id ? 'on' : ''}`}>
                <input type="radio" name="size" checked={preset === p.id} onChange={() => setPreset(p.id)} />
                <b>{p.name}</b>
                <span className="muted small">{out ? `${out[0]} × ${out[1]}` : `up to ${p.edge} px`} · {p.note}</span>
              </label>
            )
          })}
          <label className={`resize-preset ${preset === 'custom' ? 'on' : ''}`}>
            <input type="radio" name="size" checked={preset === 'custom'} onChange={() => setPreset('custom')} />
            <b>Custom</b>
            <span className="resize-custom">
              <input type="number" min={16} max={20000} value={width} aria-label="Width in pixels" onFocus={() => setPreset('custom')} onChange={(e) => setW(Number(e.target.value))} />
              <span aria-hidden="true">×</span>
              <input type="number" min={16} max={20000} value={height} aria-label="Height in pixels" onFocus={() => setPreset('custom')} onChange={(e) => setH(Number(e.target.value))} />
              <span className="muted small">px{known ? ', same shape' : ', fitted inside'}</span>
            </span>
          </label>
        </div>
        <div className="resize-format">
          <label>Format{' '}
            <select value={format} onChange={(e) => setFormat(e.target.value as 'jpeg' | 'png' | 'webp')}>
              <option value="jpeg">JPEG</option>
              <option value="png">PNG</option>
              <option value="webp">WebP</option>
            </select>
          </label>
          {format !== 'png' && (
            <label className="resize-quality">Quality <input type="range" min={40} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} /> <span className="muted small">{quality}</span></label>
          )}
        </div>
        <div className="dialog-buttons">
          <button className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={() => void save()} disabled={busy || (preset === 'custom' && (width < 16 || height < 16))}>{busy ? 'Saving…' : 'Save copy…'}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
