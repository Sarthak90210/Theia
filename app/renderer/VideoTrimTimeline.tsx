import { useEffect, useRef, useState } from 'react'
import { mediaUrl, type SourceId, type StoryboardInfo } from '../shared/api.ts'

export interface VideoTrimTimelineProps {
  source: SourceId
  itemKey: string
  duration: number
  start: number
  end: number
  disabled?: boolean
  onChange: (start: number, end: number) => void
  onSeek?: (time: number) => void
  /** A handle drag began (true) or ended (false), for undo. */
  onGesture?: (active: boolean) => void
}

type Selection = { start: number; end: number }
type Edge = 'start' | 'end'
type HandleDrag = { edge: Edge; pointer: number; x: number; width: number; selection: Selection }

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

function selectionFor(start: number, end: number, duration: number): Selection {
  if (duration <= 0) return { start: 0, end: 0 }
  const minimum = Math.min(0.1, duration)
  const from = clamp(Number.isFinite(start) ? start : 0, 0, duration - minimum)
  const to = clamp(Number.isFinite(end) ? end : duration, from + minimum, duration)
  return { start: from, end: to }
}

function timeLabel(seconds: number): string {
  const value = Math.max(0, seconds)
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const tail = (value % 60).toFixed(1).padStart(4, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`
}

function validBoard(board: StoryboardInfo | null): board is StoryboardInfo {
  return !!board && [board.cols, board.rows, board.count, board.interval, board.width, board.height]
    .every(value => Number.isFinite(value) && value > 0)
}

/** A visual trim range. Dragging changes the selection locally before IPC work. */
export function VideoTrimTimeline({ source, itemKey, duration, start, end, disabled = false, onChange, onSeek, onGesture }: VideoTrimTimelineProps) {
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0
  const minimum = Math.min(0.1, total)
  const unavailable = disabled || !total
  const [selection, setSelection] = useState(() => selectionFor(start, end, total))
  const selectionRef = useRef(selection)
  const track = useRef<HTMLDivElement>(null)
  const dragging = useRef<HandleDrag | null>(null)
  const seeking = useRef<number | null>(null)
  const [activeEdge, setActiveEdge] = useState<Edge | null>(null)
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [trackWidth, setTrackWidth] = useState(600)
  const [board, setBoard] = useState<StoryboardInfo | null>(null)
  const [spriteFailed, setSpriteFailed] = useState(false)
  const sprite = mediaUrl(source, itemKey, 'storyboard')
  const poster = mediaUrl(source, itemKey, 'sm')

  useEffect(() => {
    if (dragging.current) return
    const next = selectionFor(start, end, total)
    selectionRef.current = next
    setSelection(next)
  }, [start, end, total, activeEdge])

  useEffect(() => {
    const element = track.current
    if (!element) return
    const measure = () => setTrackWidth(Math.max(1, element.getBoundingClientRect().width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let live = true
    setBoard(null)
    setSpriteFailed(false)
    setPlayhead(null)
    if (total) window.photos.storyboard(source, itemKey).then(value => {
      if (live && validBoard(value)) setBoard(value)
    }).catch(() => { /* The poster still supplies a usable visual timeline. */ })
    return () => { live = false }
  }, [source, itemKey, total])

  // Probe the sprite once; CSS backgrounds otherwise silently hide load errors.
  useEffect(() => {
    if (!board) return
    let live = true
    const image = new Image()
    image.onerror = () => { if (live) setSpriteFailed(true) }
    image.src = sprite
    return () => { live = false; image.onerror = null }
  }, [board, sprite])

  const update = (next: Selection) => {
    selectionRef.current = next
    setSelection(next)
    onChange(next.start, next.end)
  }
  const seek = (time: number) => {
    const range = selectionRef.current
    // Keep the preview on an actual frame within the retained interval.
    const lastFrame = Math.max(range.start, range.end - Math.min(1 / 30, (range.end - range.start) / 2))
    const next = clamp(time, range.start, lastFrame)
    setPlayhead(next)
    onSeek?.(next)
  }
  const updateEdge = (edge: Edge, value: number, original = selectionRef.current) => {
    const next = edge === 'start'
      ? { start: clamp(value, 0, original.end - minimum), end: original.end }
      : { start: original.start, end: clamp(value, original.start + minimum, total) }
    update(next)
    seek(edge === 'start' ? next.start : next.end)
  }
  const pointerTime = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect()
    return rect.width ? clamp((clientX - rect.left) / rect.width, 0, 1) * total : 0
  }
  const finish = (event: React.PointerEvent<HTMLButtonElement>, cancel = false) => {
    const drag = dragging.current
    if (!drag || drag.pointer !== event.pointerId) return
    dragging.current = null
    setActiveEdge(null)
    onGesture?.(false)
    if (cancel) { update(drag.selection); seek(drag.selection.start) }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const keyboard = (event: React.KeyboardEvent<HTMLButtonElement>, edge: Edge) => {
    if (unavailable) return
    if (event.key === 'Escape' && dragging.current) {
      event.preventDefault(); event.stopPropagation()
      const original = dragging.current.selection
      dragging.current = null; setActiveEdge(null); update(original); seek(original.start)
      return
    }
    const amount = event.shiftKey ? 1 : 0.1
    const range = selectionRef.current
    const current = range[edge]
    const next = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? current - amount
      : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? current + amount
      : event.key === 'Home' ? edge === 'start' ? 0 : range.start + minimum
      : event.key === 'End' ? edge === 'start' ? range.end - minimum : total
      : null
    if (next === null) return
    event.preventDefault(); event.stopPropagation()
    updateEdge(edge, next)
  }
  const percent = (seconds: number) => total ? seconds / total * 100 : 0
  const cellCount = Math.max(5, Math.min(24, Math.ceil(trackWidth / 68)))
  const cellWidth = trackWidth / cellCount
  const stripHeight = 58
  const hasFrames = validBoard(board) && !spriteFailed
  const handle = (edge: Edge) => <button
    type="button"
    className={`trim-range-handle trim-range-${edge} ${activeEdge === edge ? 'is-dragging' : ''}`}
    role="slider"
    aria-label={edge === 'start' ? 'Trim start handle' : 'Trim end handle'}
    aria-orientation="horizontal"
    aria-valuemin={edge === 'start' ? 0 : selection.start + minimum}
    aria-valuemax={edge === 'start' ? Math.max(0, selection.end - minimum) : total}
    aria-valuenow={selection[edge]}
    aria-valuetext={`${timeLabel(selection[edge])}, ${edge === 'start' ? 'start' : 'end'} of selected video`}
    title={edge === 'start' ? 'Drag to set the start' : 'Drag to set the end'}
    disabled={unavailable}
    style={{ left: `${percent(selection[edge])}%` }}
    onKeyDown={event => keyboard(event, edge)}
    onPointerDown={event => {
      if (unavailable || event.button !== 0 || !track.current) return
      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus()
      const width = track.current.getBoundingClientRect().width
      onGesture?.(true)
    dragging.current = { edge, pointer: event.pointerId, x: event.clientX, width, selection: { ...selectionRef.current } }
      setActiveEdge(edge)
      event.currentTarget.setPointerCapture(event.pointerId)
      seek(selectionRef.current[edge])
    }}
    onPointerMove={event => {
      const drag = dragging.current
      if (unavailable || !drag || drag.pointer !== event.pointerId || !drag.width) return
      event.stopPropagation()
      updateEdge(edge, drag.selection[edge] + (event.clientX - drag.x) / drag.width * total, drag.selection)
    }}
    onPointerUp={event => { event.stopPropagation(); finish(event) }}
    onPointerCancel={event => { event.stopPropagation(); finish(event, true) }}
    onLostPointerCapture={() => { dragging.current = null; setActiveEdge(null) }}
  ><span aria-hidden="true" /></button>

  return <section className={`video-trim-timeline ${unavailable ? 'is-disabled' : ''} ${activeEdge ? 'is-trimming' : ''}`} aria-label="Video trim timeline">
    <div className="trim-timeline-heading"><span>Selected clip</span><output aria-live="off">{timeLabel(selection.end - selection.start)}</output></div>
    <div className="trim-timeline-track" ref={track}
      role="group" aria-label="Video frames, drag the handles to trim"
      onPointerDown={event => {
        if (unavailable || event.button !== 0) return
        event.preventDefault()
        seeking.current = event.pointerId
        event.currentTarget.setPointerCapture(event.pointerId)
        seek(pointerTime(event.clientX))
      }}
      onPointerMove={event => { if (!unavailable && seeking.current === event.pointerId) seek(pointerTime(event.clientX)) }}
      onPointerUp={event => {
        if (seeking.current !== event.pointerId) return
        seeking.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => { seeking.current = null }}
      onLostPointerCapture={event => { if (event.target === event.currentTarget) seeking.current = null }}>
      <div className="trim-filmstrip" aria-hidden="true">
        {Array.from({ length: cellCount }, (_, index) => {
          const frame = hasFrames ? Math.min(board.count - 1, Math.floor(((index + 0.5) / cellCount * total) / board.interval)) : 0
          const scale = hasFrames ? Math.max(cellWidth / board.width, stripHeight / board.height) : 1
          const backgroundPosition = hasFrames
            ? `${-((frame % board.cols) * board.width * scale + (board.width * scale - cellWidth) / 2)}px ${-(Math.floor(frame / board.cols) * board.height * scale + (board.height * scale - stripHeight) / 2)}px`
            : 'center'
          return <span className="trim-filmstrip-frame" key={index} style={{
            backgroundImage: `url("${hasFrames ? sprite : poster}")`,
            backgroundPosition,
            backgroundSize: hasFrames ? `${board.cols * board.width * scale}px ${board.rows * board.height * scale}px` : 'cover',
          }} />
        })}
        <span className="trim-excluded" style={{ left: 0, width: `${percent(selection.start)}%` }} />
        <span className="trim-excluded" style={{ left: `${percent(selection.end)}%`, right: 0 }} />
      </div>
      <span className="trim-selected-outline" style={{ left: `${percent(selection.start)}%`, width: `${percent(selection.end - selection.start)}%` }} aria-hidden="true" />
      {playhead !== null && <span className="trim-preview-playhead" style={{ left: `${percent(clamp(playhead, selection.start, selection.end))}%` }} aria-hidden="true" />}
      {handle('start')}
      {handle('end')}
    </div>
    <div className="trim-timeline-times"><span>{timeLabel(selection.start)}</span><span>{timeLabel(selection.end)}</span></div>
    <p className="trim-timeline-hint">Drag the handles to trim. Click a frame to preview.</p>
  </section>
}
