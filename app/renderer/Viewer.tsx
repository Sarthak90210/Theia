import { useEffect, useRef, useState } from 'react'
import { mediaUrl, type AppState, type GalleryItem, type SourceId } from '../shared/api.ts'
import { VideoPlayer, type PlayerHandle } from './VideoPlayer.tsx'
import { usePageKeys } from './use-page-keys.ts'
import { dayLabel, timeLabel, wall } from './format.ts'
import * as I from './icons.tsx'

export interface ViewerProps {
  source: SourceId
  items: GalleryItem[]
  index: number
  infoOpen: boolean
  onIndex: (index: number) => void
  onClose: () => void
  onInfo: () => void
  onSidebar: () => void
  sidebarOpen: boolean
  onContextMenu?: (e: React.MouseEvent, index: number) => void
  saveButton: React.ReactNode
  converting: AppState['converting']
  /** Save button for one burst frame (phones: frames are items of their own). */
  frameSave?: (frameKey: string) => React.ReactNode
  /** A burst changed in a vault (cover picked, a frame kept). */
  onBurstChanged?: (keptKey?: string) => void
  onError?: (message: string) => void
}

const MAX_SCALE = 8

/**
 * One item, large. The 1600 px thumbnail shows at once and the full image
 * replaces it when ready, so stepping through photos never shows a blank.
 * Wheel or double-click zooms, dragging pans. Bursts get a filmstrip of
 * their frames.
 */
export function Viewer({ source, items, index, infoOpen, onIndex, onClose, onInfo, onSidebar, sidebarOpen, onContextMenu, saveButton, converting, frameSave, onBurstChanged, onError }: ViewerProps) {
  const item = items[index]
  const root = useRef<HTMLDivElement>(null)
  const [frames, setFrames] = useState<string[] | null>(null)
  const [frame, setFrame] = useState(0)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [coverKey, setCoverKey] = useState<string | null>(null)
  const [burstBusy, setBurstBusy] = useState(false)
  const burstLock = useRef(false)
  const currentItem = useRef('')
  currentItem.current = `${source}:${item?.key}`
  const player = useRef<PlayerHandle>(null)
  usePageKeys((e) => { if (item) onKeyDown(e) })

  useEffect(() => root.current?.focus(), [])
  // The arrows don't take focus when clicked (mouse down is cancelled), so
  // the keyboard keeps working. If focus still drops to the page, as when a
  // focused control disappears at the first or last photo (Chromium sends no
  // blur for that), bring it back after each step.
  useEffect(() => {
    if (document.activeElement === document.body) root.current?.focus()
  }, [index])

  // A new item starts fitted, and a burst loads its frames.
  useEffect(() => {
    setView({ scale: 1, x: 0, y: 0 })
    setFrames(null)
    setCoverKey(null)
    setFrame(0)
    if (!item || item.kind !== 'burst') return
    let live = true
    void window.photos.burstFrames(source, item.key).then(({ frames: f, cover }) => {
      if (!live) return
      setFrames(f)
      setCoverKey(cover)
      setFrame(Math.max(0, f.indexOf(cover)))
    }).catch((e: Error) => { if (live) onError?.(e.message) })
    return () => {
      live = false
    }
  }, [source, item?.key, item?.kind])

  if (!item) return null
  const d = wall(item.t, item.off)
  const shownKey = frames?.[frame] ?? item.key
  const vaultSource = source.startsWith('vault:')
  const burstAction = async (what: 'cover' | 'keep') => {
    const fk = frames?.[frame]
    if (!fk || burstLock.current) return
    const identity = currentItem.current
    burstLock.current = true
    setBurstBusy(true)
    try {
      if (what === 'cover') {
        await window.photos.setBurstCover(source, item.key, fk)
        if (currentItem.current === identity) setCoverKey(fk)
        onBurstChanged?.()
      } else {
        const kept = await window.photos.keepBurstFrame(source, item.key, fk)
        if (currentItem.current === identity) {
          const { frames: left, cover } = await window.photos.burstFrames(source, item.key)
          if (currentItem.current === identity) {
            setFrames(left)
            setCoverKey(cover)
            setFrame((i) => Math.max(0, Math.min(i, left.length - 1)))
          }
        }
        onBurstChanged?.(kept)
      }
    } catch (e) {
      onError?.((e as Error).message)
    } finally {
      burstLock.current = false
      setBurstBusy(false)
    }
  }
  const zoomable = item.kind !== 'video' || item.cloud

  const zoomBy = (factor: number, cx = 0, cy = 0) =>
    setView((v) => {
      const scale = Math.min(MAX_SCALE, Math.max(1, v.scale * factor))
      if (scale === 1) return { scale: 1, x: 0, y: 0 }
      // Keep the point under the cursor where it is.
      const k = scale / v.scale
      return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }
    })

  const isVideo = item.kind === 'video' && !item.cloud
  const onKeyDown = (e: React.KeyboardEvent | KeyboardEvent) => {
    // Menus and dialogs handle their own keys. A focused button keeps Space
    // and Enter (to press it); a text field or slider keeps its arrows. Esc
    // and the arrows otherwise work wherever focus is in the viewer.
    const t = e.target as HTMLElement
    if (t.closest('[role="menu"], [role="dialog"], [role="alertdialog"]')) return
    if (t.closest('button') && (e.key === ' ' || e.key === 'Enter')) return
    if (t.closest('input, textarea, select') && e.key !== 'Escape') return
    if (isVideo && player.current?.key(e)) {
      e.preventDefault()
      return
    }
    if (isVideo && e.shiftKey && e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
    else if (isVideo && e.shiftKey && e.key === 'ArrowRight' && index < items.length - 1) onIndex(index + 1)
    else if (e.shiftKey && frames && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) setFrame(i => Math.max(0, Math.min(frames.length - 1, i + (e.key === 'ArrowLeft' ? -1 : 1))))
    else if (e.key === 'Home' && !e.ctrlKey) onIndex(0)
    else if (e.key === 'End' && !e.ctrlKey) onIndex(items.length - 1)
    else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
    else if (e.key === 'ArrowRight' && index < items.length - 1) onIndex(index + 1)
    else if (e.key === 'Escape' && view.scale > 1) setView({ scale: 1, x: 0, y: 0 })
    else if (e.key === 'Escape' || (e.key === ' ' && item.kind !== 'video')) onClose()
    else if ((e.key === '+' || e.key === '=') && zoomable) zoomBy(1.5)
    else if (e.key === '-' && zoomable) zoomBy(1 / 1.5)
    else if (e.key === '0' && zoomable) setView({ scale: 1, x: 0, y: 0 })
    else if (e.key.toLowerCase() === 'i' && !e.ctrlKey) onInfo()
    else return
    e.preventDefault()
  }

  return (
    <div className="viewer" ref={root} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="viewer-bar">
        <button className="ghost icon" aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} onClick={onSidebar} title="Toggle sidebar"><I.Sidebar /></button>
        <button className="ghost icon" onClick={onClose} title="Back to the grid (Esc)">
          <I.Left />
          <span>Back</span>
        </button>
        <div className="viewer-title">
          <div>{dayLabel(d)}</div>
          <div className="muted small">
            {timeLabel(d)} · {index + 1} of {items.length}
          </div>
        </div>
        <div className="viewer-actions">
          {view.scale > 1 && (
            <button className="ghost small" onClick={() => setView({ scale: 1, x: 0, y: 0 })} title="Fit (0)">
              {Math.round(view.scale * 100)}%
            </button>
          )}
          {item.fav && <I.Heart filled className="fav" />}
          {saveButton}
          <button className={`ghost icon ${infoOpen ? 'on' : ''}`} onClick={onInfo} aria-label="Info" aria-pressed={infoOpen} title="Info (I)">
            <I.Info />
          </button>
        </div>
      </div>
      <div className="viewer-stage" onContextMenu={(e) => onContextMenu?.(e, index)}>
        {isVideo ? (
          <VideoPlayer key={item.key} ref={player} source={source} item={item} converting={converting} />
        ) : (
        <Media
          key={`${shownKey}:${item.revision ?? 0}`}
          source={source}
          item={item}
          shownKey={shownKey}
          view={view}
          onView={setView}
          zoomBy={zoomable ? zoomBy : null}
        />
        )}
        {index > 0 && (
          <button className="nav prev" onMouseDown={(e) => e.preventDefault()} onClick={() => onIndex(index - 1)} aria-label="Previous" title="Previous (←)">
            <I.Left size={22} />
          </button>
        )}
        {index < items.length - 1 && (
          <button className="nav next" onMouseDown={(e) => e.preventDefault()} onClick={() => onIndex(index + 1)} aria-label="Next" title="Next (→)">
            <I.Right size={22} />
          </button>
        )}
      </div>
      {frames && frames.length > 1 && (
        <div className="filmstrip" aria-label="Burst frames">
          <div className="filmstrip-head">
            <span className="filmstrip-label">
              Burst · {frame + 1} of {frames.length}
              {frames[frame] === coverKey && <span className="filmstrip-cover">Cover</span>}
            </span>
            <span className="filmstrip-actions">
              {vaultSource ? (
                <>
                  <button className="ghost small" disabled={frames[frame] === coverKey || burstBusy} onClick={() => void burstAction('cover')} title="Show this frame for the burst">
                    Make cover
                  </button>
                  <button className="ghost small" disabled={burstBusy} onClick={() => void burstAction('keep')} title="Keep this frame as a photo of its own">
                    Keep as photo
                  </button>
                </>
              ) : (
                frameSave?.(frames[frame]!)
              )}
            </span>
          </div>
          <div className="filmstrip-frames">
            {frames.map((k, i) => (
              <button key={k} className={`frame ${i === frame ? 'on' : ''}`} onClick={() => setFrame(i)} aria-label={`Frame ${i + 1}${k === coverKey ? ', cover' : ''}`} aria-pressed={i === frame} title={`Frame ${i + 1}${k === coverKey ? ' (cover)' : ''}`}>
                <img src={mediaUrl(source, k, 'sm')} alt="" loading="lazy" draggable={false} />
                {k === coverKey && <span className="frame-cover" aria-hidden="true">Cover</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface MediaProps {
  source: SourceId
  item: GalleryItem
  shownKey: string
  view: { scale: number; x: number; y: number }
  onView: (v: { scale: number; x: number; y: number }) => void
  zoomBy: ((factor: number, cx: number, cy: number) => void) | null
}

function Media({ source, item, shownKey, view, onView, zoomBy }: MediaProps) {
  const [full, setFull] = useState(false)
  const [playMotion, setPlayMotion] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const fullImg = useRef<HTMLImageElement>(null)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)

  // Cursor position relative to the stage centre, which is the zoom origin.
  const centred = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect()
    return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2] as const
  }

  const onWheel = (e: React.WheelEvent) => {
    if (!zoomBy) return
    const [cx, cy] = centred(e)
    zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, cx, cy)
  }

  // Double-click: fitted to actual pixels at that point, and back.
  const onDoubleClick = (e: React.MouseEvent) => {
    if (!zoomBy) return
    if (view.scale > 1) return onView({ scale: 1, x: 0, y: 0 })
    const img = fullImg.current
    const actual = img?.naturalWidth ? fittedScale(img, box.current!) : 2
    const [cx, cy] = centred(e)
    zoomBy(Math.max(2, actual), cx, cy)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (view.scale <= 1 || e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const g = drag.current
    if (!g) return
    onView({ scale: view.scale, x: g.vx + e.clientX - g.x, y: g.vy + e.clientY - g.y })
  }
  const onPointerUp = () => (drag.current = null)

  return (
    <div
      className={`viewer-photo ${view.scale > 1 ? 'zoomed' : ''}`}
      ref={box}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="viewer-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <img className="viewer-img" src={`${mediaUrl(source, shownKey, 'lg')}&r=${item.revision ?? 0}`} alt="" draggable={false} />
        {!item.cloud && (
          <img
            ref={fullImg}
            className={`viewer-img over ${full ? 'shown' : ''}`}
            src={`${mediaUrl(source, shownKey, 'full')}&r=${item.revision ?? 0}`}
            alt=""
            draggable={false}
            onLoad={() => setFull(true)}
          />
        )}
        {item.kind === 'live' && playMotion && (
          <video
            className="viewer-img over shown"
            src={mediaUrl(source, item.key, 'motion')}
            autoPlay
            muted
            onEnded={() => setPlayMotion(false)}
            onError={() => setPlayMotion(false)}
          />
        )}
      </div>
      {item.kind === 'live' && !item.cloud && (
        <button className="live-chip" onMouseEnter={() => setPlayMotion(true)} onClick={() => setPlayMotion(true)}>
          <I.Live size={14} /> LIVE
        </button>
      )}
      {item.cloud && (
        <div className="cloud-chip">
          <I.Cloud size={14} /> Only in iCloud. This is the phone's preview, and saving skips it.
        </div>
      )}
    </div>
  )
}

/** The zoom at which one image pixel is one screen pixel. */
function fittedScale(img: HTMLImageElement, box: HTMLElement): number {
  const fit = Math.min((box.clientWidth - 24) / img.naturalWidth, (box.clientHeight - 24) / img.naturalHeight)
  return Math.min(MAX_SCALE, 1 / Math.min(1, fit)) / window.devicePixelRatio
}
