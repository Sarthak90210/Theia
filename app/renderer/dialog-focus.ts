/**
 * Keyboard focus for every modal dialog (anything with aria-modal="true"),
 * in one place rather than in each dialog:
 *
 * - Tab and Shift+Tab stay inside the top-most dialog. Several dialogs let
 *   Tab wander out to the photos and buttons behind them, which a person
 *   using the keyboard could then press without seeing.
 * - Opening one moves focus into it, if the dialog didn't do so itself.
 * - Closing one gives focus back to whatever had it before (the button that
 *   opened it), instead of dropping it to the page.
 *
 * Dialogs that already manage their own focus keep doing so: this only steps
 * in where they don't.
 */

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e.offsetParent !== null || e === document.activeElement)
}

/** The dialog in front: the last open one in the page (portals are appended in order). */
function topDialog(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('[aria-modal="true"]')
  return all.length ? all[all.length - 1]! : null
}

export function installDialogFocus(doc: Document = document): () => void {
  const openers = new Map<HTMLElement, HTMLElement | null>()

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || e.defaultPrevented) return
    const dialog = topDialog()
    if (!dialog) return
    const items = focusables(dialog)
    if (!items.length) {
      e.preventDefault()
      return
    }
    const first = items[0]!
    const last = items[items.length - 1]!
    const active = doc.activeElement as HTMLElement | null
    if (!active || !dialog.contains(active)) {
      e.preventDefault()
      ;(e.shiftKey ? last : first).focus()
    } else if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const opened = (dialog: HTMLElement) => {
    if (openers.has(dialog)) return
    const before = doc.activeElement as HTMLElement | null
    openers.set(dialog, before && !dialog.contains(before) ? before : null)
    // After the dialog's own effects have run: only if it left focus outside.
    requestAnimationFrame(() => {
      if (!dialog.isConnected || dialog.contains(doc.activeElement)) return
      const target = dialog.querySelector<HTMLElement>('[autofocus]') ?? focusables(dialog)[0]
      target?.focus()
    })
  }

  const closed = (dialog: HTMLElement) => {
    const opener = openers.get(dialog)
    openers.delete(dialog)
    // Only when nothing else took focus (another dialog, or the page itself).
    requestAnimationFrame(() => {
      const active = doc.activeElement
      if (opener?.isConnected && (!active || active === doc.body)) opener.focus()
    })
  }

  const scan = () => {
    const now = new Set(doc.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
    for (const d of now) opened(d)
    for (const d of [...openers.keys()]) if (!now.has(d)) closed(d)
  }
  const observer = new MutationObserver(scan)
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] })
  doc.addEventListener('keydown', onKeyDown, true)
  scan()
  return () => {
    observer.disconnect()
    doc.removeEventListener('keydown', onKeyDown, true)
  }
}
