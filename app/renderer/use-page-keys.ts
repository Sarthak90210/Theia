import { useEffect, useRef } from 'react'

/**
 * Keys that land on the page itself, with nothing focused. That happens when
 * the focused control disappears (Chromium moves focus to the body and sends
 * no blur), and without this the viewer or editor would stop responding to
 * the keyboard until clicked. Keys inside the component still go through its
 * own onKeyDown, so nothing is handled twice.
 */
export function usePageKeys(onKeyDown: (e: KeyboardEvent) => void, onKeyUp?: (e: KeyboardEvent) => void) {
  const down = useRef(onKeyDown)
  const up = useRef(onKeyUp)
  down.current = onKeyDown
  up.current = onKeyUp
  useEffect(() => {
    const d = (e: KeyboardEvent) => {
      if (e.target === document.body || e.target === document.documentElement) down.current(e)
    }
    const u = (e: KeyboardEvent) => {
      if (e.target === document.body || e.target === document.documentElement) up.current?.(e)
    }
    window.addEventListener('keydown', d)
    window.addEventListener('keyup', u)
    return () => {
      window.removeEventListener('keydown', d)
      window.removeEventListener('keyup', u)
    }
  }, [])
}
