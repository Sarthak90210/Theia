import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { mediaUrl, type GalleryItem, type SourceId } from '../shared/api.ts'
import { clock } from './format.ts'
import * as I from './icons.tsx'
import { layoutGrid, rowOf, visibleRows, type View } from './layout.ts'

export interface GridProps {
  source: SourceId
  items: GalleryItem[]
  view: View
  zoom: number
  selected: Set<string>
  /** Item to bring into view when the list or view changes. Null: the newest. */
  scrollTo: string | null
  onSelect: (index: number, mode: 'only' | 'toggle' | 'range' | 'range-add') => void
  onSelectRange: (start: number, end: number) => void
  onSelectAll: () => void
  onClear: () => void
  onOpen: (index: number) => void
  /** Years and Months are overviews. A click goes to that item in Days. */
  onDrill: (index: number) => void
  /**
   * Selection mode, as on the phone: a click opens a photo unless the Select
   * button (or Ctrl, Shift or Ctrl+A) turned selection on.
   */
  selecting: boolean
  onStartSelecting: () => void
  /** The keyboard focus moved to this item, for the info panel. */
  onFocusKey?: (key: string | null) => void
}

const OVERSCAN = 800

/**
 * Square tiles in a virtual list. Only rows near the viewport exist in the
 * page, so 50,000 items cost the same as 500. Images load as their rows
 * appear and the browser drops them as they leave.
 */
export function Grid(props: GridProps) {
  const { items, view, zoom, selected, scrollTo } = props
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 800 })
  const focus = useRef<number | null>(null)
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const moveFocus = (index: number | null) => {
    focus.current = index
    setFocusIndex(index)
    props.onFocusKey?.(index === null ? null : (items[index]?.key ?? null))
  }

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth)
      setViewport({ top: el.scrollTop, height: el.clientHeight })
    })
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const layout = useMemo(() => layoutGrid(items, view, width, zoom), [items, view, width, zoom])

  // Keep the same item in view across zoom and resize, and start at the
  // newest photo (the bottom) like the phone does.
  const anchor = useRef<string | null>(null)
  const lastView = useRef(view)
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !width) return
    // A tab change starts at the newest photos. Zoom and resize keep the place.
    if (lastView.current !== view) anchor.current = null
    lastView.current = view
    const key = scrollTo ?? anchor.current
    const index = key ? items.findIndex((it) => it.key === key) : -1
    const row = index >= 0 ? rowOf(layout.rows, index) : null
    el.scrollTop = row ? Math.max(0, row.top - el.clientHeight / 3) : el.scrollHeight
    setViewport({ top: el.scrollTop, height: el.clientHeight })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, scrollTo])

  const frame = useRef(0)
  const onScroll = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const el = box.current
      if (!el) return
      setViewport({ top: el.scrollTop, height: el.clientHeight })
      // Remember the item at the top third, for the next relayout.
      const rows = visibleRows(layout.rows, el.scrollTop + el.clientHeight / 3, el.scrollTop + el.clientHeight / 3 + 1)
      const r = rows.find((x) => x.kind === 'tiles') ?? rows[0]
      anchor.current = r ? (items[r.start]?.key ?? null) : null
    })
  }, [layout, items])

  useEffect(() => {
    anchor.current = null
    focus.current = null
    setFocusIndex(null)
  }, [items])

  const rows = visibleRows(layout.rows, viewport.top - OVERSCAN, viewport.top + viewport.height + OVERSCAN)
  const overview = view === 'years' || view === 'months'
  const size = layout.tile > 220 ? 'lg' : 'sm'

  const ensureVisible = (index: number) => {
    const el = box.current
    const row = rowOf(layout.rows, index)
    if (!el || !row) return
    if (row.top < el.scrollTop) el.scrollTop = row.top - 8
    else if (row.top + row.height > el.scrollTop + el.clientHeight) el.scrollTop = row.top + row.height - el.clientHeight + 8
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = items.length
    if (!n) return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      props.onStartSelecting()
      props.onSelectAll()
      return
    }
    if (e.key === 'Escape') {
      props.onClear()
      return
    }
    const cur = focus.current ?? lastSelected(items, selected) ?? n - 1
    if (e.key === ' ' && props.selecting && !overview) {
      e.preventDefault()
      props.onSelect(cur, 'toggle')
      return
    }
    if ((e.key === 'Enter' || e.key === ' ') && !overview) {
      e.preventDefault()
      props.onOpen(cur)
      return
    }
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -layout.perRow, ArrowDown: layout.perRow }
    const d = step[e.key]
    if (d === undefined || overview) return
    e.preventDefault()
    const next = Math.max(0, Math.min(n - 1, cur + d))
    // Arrows move the focus ring. They only select with Shift, in selection mode.
    moveFocus(next)
    if (props.selecting && e.shiftKey) props.onSelect(next, 'range-add')
    ensureVisible(next)
  }

  const click = (index: number, e: React.MouseEvent) => {
    box.current?.focus()
    if (overview) return props.onDrill(index)
    moveFocus(index)
    const ctrl = e.ctrlKey || e.metaKey
    if (props.selecting || ctrl || e.shiftKey) {
      if (!props.selecting) props.onStartSelecting()
      props.onSelect(index, e.shiftKey ? 'range-add' : 'toggle')
      return
    }
    props.onOpen(index)
  }

  return (
    <div className="grid" ref={box} onScroll={onScroll} tabIndex={0} onKeyDown={onKeyDown} aria-label="Photos">
      <div className="grid-inner" style={{ height: layout.height }}>
        {rows.map((r) =>
          r.kind === 'header' ? (
            <div key={`h${r.start}`} className={`grid-header ${view}`} style={{ top: r.top, height: r.height }}>
              <span className="grid-title">{r.label}</span>
              <span className="grid-sub">{r.sub}</span>
              {view === 'days' && (
                <button
                  className="link"
                  onClick={() => {
                    if (!props.selecting) props.onStartSelecting()
                    props.onSelectRange(r.start, r.end)
                  }}
                >
                  Select
                </button>
              )}
            </div>
          ) : (
            <div key={`r${r.start}`} className="grid-row" style={{ top: r.top, height: r.height }}>
              {items.slice(r.start, r.end).map((it, j) => (
                <Tile
                  key={it.key}
                  source={props.source}
                  item={it}
                  index={r.start + j}
                  size={layout.tile}
                  left={16 + j * (layout.tile + layout.gap)}
                  thumb={size}
                  selected={selected.has(it.key)}
                  selecting={props.selecting && !overview}
                  focused={focusIndex === r.start + j}
                  badges={!overview}
                  onClick={click}
                />
              ))}
            </div>
          ),
        )}
      </div>
    </div>
  )
}

function lastSelected(items: GalleryItem[], selected: Set<string>): number | null {
  if (!selected.size) return null
  for (let i = items.length - 1; i >= 0; i--) if (selected.has(items[i]!.key)) return i
  return null
}

interface TileProps {
  source: SourceId
  item: GalleryItem
  index: number
  size: number
  left: number
  thumb: 'sm' | 'lg'
  selected: boolean
  selecting: boolean
  focused: boolean
  badges: boolean
  onClick: (index: number, e: React.MouseEvent) => void
}

/** Rest the pointer this long on a Live Photo before it plays, so sweeping across the grid doesn't start them all. */
const LIVE_HOVER_MS = 250
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

const Tile = memo(function Tile({ source, item, index, size, left, thumb, selected, selecting, focused, badges, onClick }: TileProps) {
  const [failed, setFailed] = useState(false)
  // A Live Photo plays its motion in place while the pointer rests on it,
  // muted, then settles back on the still.
  const [motion, setMotion] = useState<'off' | 'loading' | 'playing'>('off')
  const hoverTimer = useRef(0)
  const live = item.kind === 'live' && !item.cloud && badges && size >= 64
  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])
  const enter = () => {
    if (!live || reducedMotion()) return
    window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => setMotion('loading'), LIVE_HOVER_MS)
  }
  const leave = () => {
    window.clearTimeout(hoverTimer.current)
    setMotion('off')
  }
  return (
    <div
      className={`tile ${selected ? 'selected' : ''} ${selecting ? 'selecting' : ''} ${focused ? 'focused' : ''}`}
      style={{ left, width: size, height: size }}
      onClick={(e) => onClick(index, e)}
      onPointerEnter={enter}
      onPointerLeave={leave}
      role="gridcell"
      data-key={item.key}
      aria-selected={selected}
    >
      {failed ? (
        <div className="tile-missing">{item.kind === 'video' ? <I.Video /> : <I.Grid />}</div>
      ) : (
        <img
          src={`${mediaUrl(source, item.key, thumb)}&r=${item.revision ?? 0}`}
          loading="lazy"
          decoding="async"
          draggable={false}
          alt=""
          onError={() => setFailed(true)}
        />
      )}
      {motion !== 'off' && (
        <video
          className={`tile-motion ${motion === 'playing' ? 'shown' : ''}`}
          src={mediaUrl(source, item.key, 'motion')}
          muted
          autoPlay
          playsInline
          disablePictureInPicture
          onPlaying={() => setMotion('playing')}
          onEnded={() => setMotion('off')}
          onError={() => setMotion('off')}
        />
      )}
      {badges && size >= 64 && (
        <>
          {item.fav && (
            <span className="badge bl">
              <I.Heart size={14} filled />
            </span>
          )}
          {item.kind === 'video' && <span className="badge br text">{item.dur !== null ? clock(item.dur) : ''}</span>}
          {item.kind === 'live' && (
            <span className={`badge tl ${motion === 'playing' ? 'live-playing' : ''}`}>
              <I.Live size={14} />
            </span>
          )}
          {item.kind === 'burst' && (
            <span className="badge tl" aria-label={`Burst, ${item.frames ?? 1} frames`}>
              <I.Stack size={14} />
              {item.frames && <span>{item.frames}</span>}
            </span>
          )}
          {item.cloud && (
            <span className="badge tr">
              <I.Cloud size={14} />
            </span>
          )}
        </>
      )}
      {selected ? (
        <span className="tile-check">
          <I.Check size={12} />
        </span>
      ) : (
        selecting && <span className="tile-check unticked" aria-hidden="true" />
      )}
    </div>
  )
})
