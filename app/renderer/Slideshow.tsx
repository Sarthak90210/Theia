import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { mediaUrl, type GalleryItem, type SourceId } from '../shared/api.ts'
import { dayLabel, wall } from './format.ts'
import * as I from './icons.tsx'

/**
 * Full screen, one photo after another, from the one it started on. Videos
 * are passed over. Space pauses, the arrows step, Esc ends it; the controls
 * show while the pointer moves. Each next photo is loaded before it is due,
 * so the change is a fade, never a blank.
 */

const SPEEDS = [3, 5, 10] as const

export function slideshowItems(items: GalleryItem[]): GalleryItem[] {
  return items.filter((i) => i.kind !== 'video')
}

export function Slideshow({ source, items, startKey, onClose }: {
  source: SourceId
  /** In order; videos are left out here. */
  items: GalleryItem[]
  startKey: string | null
  /** With the key of the photo it ended on. */
  onClose: (lastKey: string | null) => void
}) {
  const shown = slideshowItems(items)
  const first = Math.max(0, startKey ? shown.findIndex((i) => i.key === startKey) : 0)
  const [index, setIndex] = useState(first)
  const [paused, setPaused] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(5)
  const [controls, setControls] = useState(true)
  /** The two stacked pictures crossfade: `front` is the visible one. */
  const [layers, setLayers] = useState<[string | null, string | null]>([null, null])
  const [front, setFront] = useState(0)
  const frontRef = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  const hideTimer = useRef(0)
  const indexRef = useRef(index)
  indexRef.current = index

  const url = useCallback((i: GalleryItem) => `${mediaUrl(source, i.key, i.cloud ? 'lg' : 'full')}&r=${i.revision ?? 0}`, [source])
  const close = useCallback(() => onClose(shown[indexRef.current]?.key ?? null), [onClose, shown])
  // The newest close, for the full-screen listener, which is set up once.
  const closeRef = useRef(close)
  closeRef.current = close

  // Full screen while it runs. Leaving full screen (Esc, F11) ends the
  // slideshow. Set up once: redoing it on a render would leave full screen
  // and so end the slideshow as it starts.
  useEffect(() => {
    const el = root.current
    if (!el) return
    el.focus()
    let entered = false
    const changed = () => {
      if (document.fullscreenElement) entered = true
      else if (entered) closeRef.current()
    }
    document.addEventListener('fullscreenchange', changed)
    void el.requestFullscreen?.().catch(() => { /* not allowed here: the window it is */ })
    return () => {
      document.removeEventListener('fullscreenchange', changed)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
  }, [])

  // Load the photo, then fade it in over the last one.
  useEffect(() => {
    const item = shown[index]
    if (!item) return
    let live = true
    const img = new Image()
    img.src = url(item)
    const show = () => {
      if (!live) return
      const back = 1 - frontRef.current
      frontRef.current = back
      setLayers((l) => {
        const next: [string | null, string | null] = [...l]
        next[back] = img.src
        return next
      })
      setFront(back)
    }
    void img.decode().then(show, show)
    // And the one after, so it is ready when its turn comes.
    const after = shown[index + 1]
    if (after) new Image().src = url(after)
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, url])

  useEffect(() => {
    if (paused || shown.length < 2) return
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % shown.length), speed * 1000)
    return () => window.clearTimeout(t)
  }, [index, paused, speed, shown.length])

  const wake = () => {
    setControls(true)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setControls(false), 2500)
  }
  useEffect(() => { wake(); return () => window.clearTimeout(hideTimer.current) }, [])

  const step = (d: number) => { setIndex((i) => (i + d + shown.length) % shown.length); wake() }
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Escape' || e.key === 'F5') close()
    else if (e.key === ' ' || e.key === 'k') { setPaused((p) => !p); wake() }
    else if (e.key === 'ArrowRight' || e.key === 'PageDown') step(1)
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') step(-1)
    else return
    e.preventDefault()
  }

  const item = shown[index]
  if (!shown.length) {
    return createPortal(
      <div className="slideshow" ref={root} tabIndex={-1} onKeyDown={onKeyDown} onClick={close}>
        <p className="slideshow-empty">There are no photos here to show. Videos are left out of slideshows.</p>
      </div>,
      document.body,
    )
  }
  return createPortal(
    <div className={`slideshow ${controls ? 'awake' : ''}`} ref={root} tabIndex={-1} onKeyDown={onKeyDown} onMouseMove={wake} role="dialog" aria-label="Slideshow">
      {layers.map((src, i) => src && <img key={i} className={`slideshow-img ${i === front ? 'shown' : ''}`} src={src} alt="" draggable={false} />)}
      <div className="slideshow-bar" onMouseMove={(e) => e.stopPropagation()}>
        <span className="slideshow-when">{item ? dayLabel(wall(item.t, item.off)) : ''} · {index + 1} of {shown.length}</span>
        <button className="ghost icon" onClick={() => step(-1)} aria-label="Previous" title="Previous (←)"><I.Left /></button>
        <button className="ghost icon" onClick={() => { setPaused((p) => !p); wake() }} aria-label={paused ? 'Play' : 'Pause'} title={paused ? 'Play (Space)' : 'Pause (Space)'}>{paused ? <I.Play /> : <I.Pause />}</button>
        <button className="ghost icon" onClick={() => step(1)} aria-label="Next" title="Next (→)"><I.Right /></button>
        <label className="slideshow-speed" title="Seconds per photo">
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value) as (typeof SPEEDS)[number])} aria-label="Seconds per photo">
            {SPEEDS.map((s) => <option key={s} value={s}>{s} s</option>)}
          </select>
        </label>
        <button className="ghost icon" onClick={close} aria-label="End slideshow" title="End slideshow (Esc)"><I.Close /></button>
      </div>
    </div>,
    document.body,
  )
}
