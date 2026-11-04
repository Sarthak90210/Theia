import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_EDIT, validateEdit } from '../../src/media/edit-recipe.ts'
import { mediaUrl, type EditRecipe, type GalleryItem, type SourceId } from '../shared/api.ts'
import { fitAspectCrop, rotateCrop, type CropRect } from './crop-geometry.ts'
import { EditCanvas, type CanvasMode } from './EditCanvas.tsx'
import * as H from './edit-history.ts'
import * as I from './icons.tsx'
import { VideoTrimTimeline } from './VideoTrimTimeline.tsx'
import { usePageKeys } from './use-page-keys.ts'

/**
 * Editing a photo or video, laid out the way Photos on Windows, Google Photos
 * and the iPhone do it: the picture in the middle, edited live; a crop frame
 * you drag on the picture itself; a straighten ruler under it; light and
 * colour sliders that reset on double-click; undo and redo; and a Compare
 * button to hold for the original. Saving makes a new copy and leaves the
 * original alone.
 */

interface Props {
  source: SourceId
  item: GalleryItem
  onClose: () => void
  onSaved: (key: string) => void
}

type Tool = 'crop' | 'adjust' | 'trim'

const ASPECTS: { id: string; label: string; ratio: number | 'original' | null }[] = [
  { id: 'free', label: 'Freeform', ratio: null },
  { id: 'original', label: 'Original', ratio: 'original' },
  { id: 'square', label: 'Square', ratio: 1 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '5:4', label: '5:4', ratio: 5 / 4 },
]

interface SliderSpec {
  key: 'exposure' | 'brightness' | 'contrast' | 'saturation' | 'warmth' | 'tint'
  label: string
  min: number
  max: number
  neutral: number
  /** Shown value from the stored one. */
  show: (v: number) => string
}

const LIGHT: SliderSpec[] = [
  { key: 'exposure', label: 'Exposure', min: -2, max: 2, neutral: 0, show: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} EV` },
  { key: 'brightness', label: 'Brightness', min: -1, max: 1, neutral: 0, show: (v) => signed(v * 100) },
  { key: 'contrast', label: 'Contrast', min: 0.5, max: 1.5, neutral: 1, show: (v) => signed((v - 1) * 200) },
]
const COLOUR: SliderSpec[] = [
  { key: 'saturation', label: 'Saturation', min: 0, max: 2, neutral: 1, show: (v) => signed((v - 1) * 100) },
  { key: 'warmth', label: 'Warmth', min: -1, max: 1, neutral: 0, show: (v) => signed(v * 100) },
  { key: 'tint', label: 'Tint', min: -1, max: 1, neutral: 0, show: (v) => signed(v * 100) },
]

function signed(n: number): string {
  const r = Math.round(n)
  return r > 0 ? `+${r}` : String(r)
}

export function Editor({ source, item, onClose, onSaved }: Props) {
  const isVideo = item.kind === 'video'
  const initial: EditRecipe = { ...structuredClone(DEFAULT_EDIT), end: isVideo && item.dur ? item.dur / 1000 : null }
  const [history, setHistory] = useState(() => H.start(initial))
  const recipe = history.present
  const [tool, setTool] = useState<Tool>(isVideo ? 'trim' : 'crop')
  const [aspectId, setAspectId] = useState('free')
  const [portrait, setPortrait] = useState(false)
  const [natural, setNatural] = useState({ width: item.w ?? 4, height: item.h ?? 3 })
  const [comparing, setComparing] = useState(false)
  const [straightening, setStraightening] = useState(false)
  const [videoSrc, setVideoSrc] = useState<string | null>(null)
  const [duration, setDuration] = useState(item.dur ? item.dur / 1000 : 0)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const root = useRef<HTMLDivElement>(null)

  const dirty = JSON.stringify(recipe) !== JSON.stringify(initial)
  const quarter = recipe.rotation === 90 || recipe.rotation === 270
  const displayW = quarter ? natural.height : natural.width
  const displayH = quarter ? natural.width : natural.height

  useEffect(() => root.current?.focus(), [])

  // Videos are made playable first (converted if the window can't decode them).
  useEffect(() => {
    if (!isVideo) return
    let live = true
    void window.photos.playback(source, item.key).then((r) => {
      if (!live) return
      if (r.ok) setVideoSrc(mediaUrl(source, item.key, 'video'))
      else setError(r.error)
    })
    return () => {
      live = false
    }
  }, [source, item.key, isVideo])

  const set = (next: EditRecipe) => setHistory((h) => H.commit(h, next))
  const live = (next: EditRecipe) => setHistory((h) => H.drag(h, next))
  const gesture = (active: boolean) => {
    if (!active) setHistory((h) => H.endDrag(h))
  }
  const undo = useCallback(() => setHistory((h) => H.undo(h)), [])
  const redo = useCallback(() => setHistory((h) => H.redo(h)), [])

  /* ------------------------------------------------------------- crop */

  const aspectRatio = (id = aspectId, tall = portrait): number | null => {
    const a = ASPECTS.find((x) => x.id === id)?.ratio ?? null
    if (a === null) return null
    const r = a === 'original' ? displayW / displayH : a
    // Portrait turns the shape upright; square has no orientation.
    return tall && r > 1 ? 1 / r : !tall && r < 1 ? 1 / r : r
  }
  const lockedRatio = aspectRatio()

  // A preset starts in the orientation of the crop you have now, so Original
  // on a portrait photo stays portrait.
  const currentlyTall = () => recipe.crop.height * displayH > recipe.crop.width * displayW
  const chooseAspect = (id: string, tall = aspectId === id ? portrait : currentlyTall()) => {
    setAspectId(id)
    setPortrait(tall)
    const r = aspectRatio(id, tall)
    if (r === null) return
    const c = recipe.crop
    const fitted = fitAspectCrop(r / (displayW / displayH), { x: c.x + c.width / 2, y: c.y + c.height / 2 })
    set({ ...recipe, crop: fitted })
  }

  // Turning or flipping the picture carries the crop frame with it, so the
  // same part of the picture stays selected.
  const rotate = (dir: 1 | -1) => {
    const turn = (dir === 1 ? 90 : 270) as 90 | 270
    set({
      ...recipe,
      rotation: ((recipe.rotation + turn) % 360) as EditRecipe['rotation'],
      crop: rotateCrop(recipe.crop, turn),
    })
    setPortrait((p) => !p)
  }
  const flip = () => {
    // A mirror on screen: with a quarter turn applied, that is a source flip
    // plus the opposite quarter turn.
    const c = recipe.crop
    set({
      ...recipe,
      flip: !recipe.flip,
      rotation: ((360 - recipe.rotation) % 360) as EditRecipe['rotation'],
      straighten: -recipe.straighten,
      crop: { ...c, x: 1 - c.x - c.width },
    })
  }
  const resetCrop = () => {
    setAspectId('free')
    set({ ...recipe, rotation: 0, flip: false, straighten: 0, crop: { ...DEFAULT_EDIT.crop } })
  }

  /* ---------------------------------------------------------- video */

  const seek = (t: number) => {
    const v = video.current
    if (v) v.currentTime = t
  }
  const togglePlay = () => {
    const v = video.current
    if (!v) return
    if (!v.paused) return v.pause()
    if (v.currentTime < recipe.start || (recipe.end !== null && v.currentTime >= recipe.end - 0.05)) v.currentTime = recipe.start
    void v.play()
  }
  useEffect(() => {
    const v = video.current
    if (!v) return
    v.muted = recipe.mute
    const tick = () => {
      if (recipe.end !== null && v.currentTime >= recipe.end) {
        v.pause()
        v.currentTime = recipe.start
      }
    }
    const on = () => setPlaying(true)
    const off = () => setPlaying(false)
    const meta = () => Number.isFinite(v.duration) && setDuration(v.duration)
    v.addEventListener('timeupdate', tick)
    v.addEventListener('play', on)
    v.addEventListener('pause', off)
    v.addEventListener('loadedmetadata', meta)
    return () => {
      v.removeEventListener('timeupdate', tick)
      v.removeEventListener('play', on)
      v.removeEventListener('pause', off)
      v.removeEventListener('loadedmetadata', meta)
    }
  }, [recipe.start, recipe.end, recipe.mute, videoSrc])

  /* ------------------------------------------------------------ save */

  const save = async () => {
    setBusy(true)
    setError(null)
    video.current?.pause()
    try {
      const key = await window.photos.saveEditedCopy(source, item.key, validateEdit(recipe))
      onSaved(key)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  const close = () => (dirty && !busy ? setConfirmClose(true) : onClose())

  /* -------------------------------------------------------- keyboard */

  const onKeyDown = (e: React.KeyboardEvent | KeyboardEvent) => {
    e.stopPropagation()
    if (confirmClose) {
      if (e.key === 'Escape') keepEditing()
      return
    }
    const target = e.target as HTMLElement
    const typing = target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range'
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    } else if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      redo()
    } else if (ctrl && e.key.toLowerCase() === 's') {
      e.preventDefault()
      if (!busy) void save()
    } else if (e.key === 'Escape' && !busy) {
      e.preventDefault()
      close()
    } else if (!typing && !ctrl && e.key.toLowerCase() === 'm' && !e.repeat) {
      setComparing(true)
    } else if (!typing && e.key === ' ' && isVideo && target.tagName !== 'BUTTON') {
      e.preventDefault()
      togglePlay()
    }
  }
  const onKeyUp = (e: React.KeyboardEvent | KeyboardEvent) => {
    if (e.key.toLowerCase() === 'm') setComparing(false)
  }
  usePageKeys((e) => onKeyDown(e), (e) => onKeyUp(e))
  const keepEditing = () => {
    setConfirmClose(false)
    root.current?.focus()
  }

  const mode: CanvasMode = comparing ? 'original' : tool === 'crop' ? 'crop' : 'result'
  const media = isVideo ? videoSrc : mediaUrl(source, item.key, 'full')
  const adjusted = [...LIGHT, ...COLOUR].some((s) => recipe[s.key] !== s.neutral)
  const cropped =
    recipe.rotation !== 0 || recipe.flip || recipe.straighten !== 0 || JSON.stringify(recipe.crop) !== JSON.stringify(DEFAULT_EDIT.crop)
  const trimmed = recipe.start > 0 || recipe.mute || (recipe.end !== null && duration > 0 && recipe.end < duration - 0.01)
  const tools: { id: Tool; label: string; icon: React.ReactNode; changed: boolean }[] = [
    ...(isVideo ? [{ id: 'trim' as const, label: 'Trim', icon: <I.Scissors size={16} />, changed: trimmed }] : []),
    { id: 'crop', label: 'Crop', icon: <I.Crop size={16} />, changed: cropped },
    { id: 'adjust', label: 'Adjust', icon: <I.Sliders size={16} />, changed: adjusted },
  ]

  return (
    <div
      className="ed"
      ref={root}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${isVideo ? 'video' : 'photo'}`}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <header className="ed-bar">
        <div className="ed-bar-side">
          <button className="ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <div className="ed-history">
            <button className="ghost icon" onClick={undo} disabled={busy || !history.past.length} aria-label="Undo" title="Undo (Ctrl+Z)">
              <I.Undo />
            </button>
            <button className="ghost icon" onClick={redo} disabled={busy || !history.future.length} aria-label="Redo" title="Redo (Ctrl+Y)">
              <I.Redo />
            </button>
          </div>
        </div>
        <nav className="ed-tools" aria-label="Editing tools">
          {tools.map((t) => (
            <button key={t.id} className={`ed-tool ${tool === t.id ? 'on' : ''}`} aria-pressed={tool === t.id} onClick={() => setTool(t.id)} disabled={busy}>
              {t.icon}
              <span>{t.label}</span>
              {t.changed && <span className="ed-dot" aria-label="changed" />}
            </button>
          ))}
        </nav>
        <div className="ed-bar-side end">
          <button
            className={`ghost ed-compare ${comparing ? 'on' : ''}`}
            onPointerDown={() => setComparing(true)}
            onPointerUp={() => setComparing(false)}
            onPointerLeave={() => setComparing(false)}
            disabled={busy || !dirty}
            title="Hold to see the original (or hold M)"
          >
            <I.Compare size={16} />
            <span>Compare</span>
          </button>
          <button className="primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save as copy'}
          </button>
        </div>
      </header>

      <div className="ed-body">
        <div className="ed-stage">
          {media ? (
            <EditCanvas
              ref={video}
              kind={isVideo ? 'video' : 'image'}
              src={media}
              recipe={recipe}
              mode={mode}
              aspect={lockedRatio}
              fineGrid={straightening}
              onCrop={(crop: CropRect) => live({ ...recipe, crop })}
              onGesture={gesture}
              onNaturalSize={(width, height) => setNatural({ width, height })}
            />
          ) : (
            <div className="ed-wait">
              <span className="spinner" />
              <span>Preparing the video…</span>
            </div>
          )}
          {comparing && <span className="ed-badge">Original</span>}

          {tool === 'crop' && (
            <div className="ed-under">
              <Straighten
                value={recipe.straighten}
                disabled={busy}
                onLive={(v) => live({ ...recipe, straighten: v })}
                onGesture={(on) => {
                  setStraightening(on)
                  gesture(on)
                }}
                onSet={(v) => set({ ...recipe, straighten: v })}
              />
            </div>
          )}
          {tool === 'trim' && isVideo && (
            <div className="ed-under trim">
              <button className="ghost icon ed-play" onClick={togglePlay} disabled={!videoSrc} aria-label={playing ? 'Pause' : 'Play the trimmed clip'}>
                {playing ? <I.Pause /> : <I.Play />}
              </button>
              <div className="ed-timeline">
                <VideoTrimTimeline
                  source={source}
                  itemKey={item.key}
                  duration={duration}
                  start={recipe.start}
                  end={recipe.end ?? duration}
                  disabled={busy || !duration}
                  onChange={(start, end) => live({ ...recipe, start, end })}
                  onGesture={gesture}
                  onSeek={seek}
                />
              </div>
            </div>
          )}
        </div>

        <aside className="ed-panel" aria-label={`${tools.find((t) => t.id === tool)?.label} settings`}>
          {tool === 'crop' && (
            <>
              <section>
                <h3>Rotate and flip</h3>
                <div className="ed-row">
                  <button className="ed-square" onClick={() => rotate(-1)} disabled={busy} title="Rotate left">
                    <I.RotateLeft />
                    <span>Left</span>
                  </button>
                  <button className="ed-square" onClick={() => rotate(1)} disabled={busy} title="Rotate right">
                    <I.RotateRight />
                    <span>Right</span>
                  </button>
                  <button className="ed-square" onClick={flip} disabled={busy} title="Flip horizontally">
                    <I.FlipHorizontal />
                    <span>Flip</span>
                  </button>
                </div>
              </section>
              <section>
                <div className="ed-heading">
                  <h3>Aspect ratio</h3>
                  {aspectId !== 'free' && aspectId !== 'square' && (
                    <div className="ed-segment" role="group" aria-label="Orientation">
                      <button className={!portrait ? 'on' : ''} aria-pressed={!portrait} onClick={() => chooseAspect(aspectId, false)}>
                        Landscape
                      </button>
                      <button className={portrait ? 'on' : ''} aria-pressed={portrait} onClick={() => chooseAspect(aspectId, true)}>
                        Portrait
                      </button>
                    </div>
                  )}
                </div>
                <div className="ed-aspects">
                  {ASPECTS.map((a) => (
                    <button key={a.id} className={aspectId === a.id ? 'on' : ''} aria-pressed={aspectId === a.id} onClick={() => chooseAspect(a.id)} disabled={busy}>
                      {a.label}
                    </button>
                  ))}
                </div>
              </section>
              <p className="ed-hint">
                Drag the corners or edges of the frame to crop, and drag inside it to move it. Use the ruler under the picture to
                straighten.
              </p>
              <button className="ghost ed-reset" onClick={resetCrop} disabled={busy || !cropped}>
                Reset crop
              </button>
            </>
          )}

          {tool === 'adjust' && (
            <>
              <section>
                <h3>Light</h3>
                {LIGHT.map((s) => (
                  <Slider key={s.key} spec={s} value={recipe[s.key]} disabled={busy} onLive={(v) => live({ ...recipe, [s.key]: v })} onGesture={gesture} onSet={(v) => set({ ...recipe, [s.key]: v })} />
                ))}
              </section>
              <section>
                <h3>Colour</h3>
                {COLOUR.map((s) => (
                  <Slider key={s.key} spec={s} value={recipe[s.key]} disabled={busy} onLive={(v) => live({ ...recipe, [s.key]: v })} onGesture={gesture} onSet={(v) => set({ ...recipe, [s.key]: v })} />
                ))}
              </section>
              <p className="ed-hint">Double-click a slider to reset it. Hold Compare, or the M key, to see the original.</p>
              <button
                className="ghost ed-reset"
                disabled={busy || !adjusted}
                onClick={() => set({ ...recipe, exposure: 0, brightness: 0, contrast: 1, saturation: 1, warmth: 0, tint: 0 })}
              >
                Reset adjustments
              </button>
            </>
          )}

          {tool === 'trim' && (
            <>
              <section>
                <h3>Clip</h3>
                <dl className="ed-times">
                  <div>
                    <dt>Start</dt>
                    <dd>{clockTenths(recipe.start)}</dd>
                  </div>
                  <div>
                    <dt>End</dt>
                    <dd>{clockTenths(recipe.end ?? duration)}</dd>
                  </div>
                  <div>
                    <dt>Length</dt>
                    <dd>{clockTenths((recipe.end ?? duration) - recipe.start)}</dd>
                  </div>
                </dl>
              </section>
              <section>
                <label className="ed-switch">
                  <span>
                    Mute
                    <small>Save the video without sound</small>
                  </span>
                  <input type="checkbox" checked={recipe.mute} disabled={busy} onChange={(e) => set({ ...recipe, mute: e.target.checked })} />
                </label>
              </section>
              <p className="ed-hint">Drag the handles at either end of the strip under the video to trim. Click a frame to see it, and press Space to play the clip.</p>
              <button className="ghost ed-reset" disabled={busy || !trimmed} onClick={() => set({ ...recipe, start: 0, end: duration || null, mute: false })}>
                Reset trim
              </button>
            </>
          )}

          <div className="ed-foot">
            <p className="muted small">
              Saves a new {isVideo ? 'MP4 video' : 'JPEG photo'} at full resolution. Your original stays as it is.
              {item.kind === 'live' && ' A Live Photo is saved as a still.'}
            </p>
            {error && (
              <p role="alert" className="ed-error">
                {error}
              </p>
            )}
          </div>
        </aside>
      </div>

      {confirmClose && (
        <div className="ed-confirm" role="alertdialog" aria-modal="true" aria-labelledby="ed-confirm-title">
          <div className="ed-confirm-card">
            <h2 id="ed-confirm-title">Discard your edits?</h2>
            <p className="muted">Your original is unchanged either way.</p>
            <div className="ed-row end">
              <button className="ghost" autoFocus onClick={keepEditing}>
                Keep editing
              </button>
              <button className="primary danger" onClick={onClose}>
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function clockTenths(s: number): string {
  const v = Math.max(0, s)
  const m = Math.floor(v / 60)
  return `${m}:${(v % 60).toFixed(1).padStart(4, '0')}`
}

interface SliderProps {
  spec: SliderSpec
  value: number
  disabled: boolean
  onLive: (v: number) => void
  onGesture: (active: boolean) => void
  onSet: (v: number) => void
}

/**
 * One adjustment. The fill grows from the neutral point, so you can see at a
 * glance how far from "no change" it is. Double-click resets it.
 */
function Slider({ spec, value, disabled, onLive, onGesture, onSet }: SliderProps) {
  const span = spec.max - spec.min
  const at = (v: number) => ((v - spec.min) / span) * 100
  const from = Math.min(at(value), at(spec.neutral))
  const to = Math.max(at(value), at(spec.neutral))
  const changed = Math.abs(value - spec.neutral) > 1e-6
  return (
    <label className={`ed-slider ${changed ? 'changed' : ''}`} onDoubleClick={() => onSet(spec.neutral)} title="Double-click to reset">
      <span className="ed-slider-head">
        <span>{spec.label}</span>
        <output>{spec.show(value)}</output>
      </span>
      <input
        type="range"
        min={spec.min}
        max={spec.max}
        step={span / 200}
        value={value}
        disabled={disabled}
        aria-label={spec.label}
        aria-valuetext={spec.show(value)}
        style={{ '--from': `${from}%`, '--to': `${to}%`, '--mid': `${at(spec.neutral)}%` } as React.CSSProperties}
        onPointerDown={() => onGesture(true)}
        onPointerUp={() => onGesture(false)}
        onKeyUp={() => onGesture(false)}
        onChange={(e) => onLive(Number(e.target.value))}
      />
    </label>
  )
}

interface StraightenProps {
  value: number
  disabled: boolean
  onLive: (v: number) => void
  onGesture: (active: boolean) => void
  onSet: (v: number) => void
}

/** A ruler under the picture, -45° to 45°, as on the phone. */
function Straighten({ value, disabled, onLive, onGesture, onSet }: StraightenProps) {
  return (
    <div className="ed-straighten" onDoubleClick={() => onSet(0)} title="Straighten. Double-click to reset.">
      <span className="ed-straighten-label">
        Straighten <output>{value > 0 ? '+' : ''}{value.toFixed(1)}°</output>
      </span>
      <input
        type="range"
        min={-45}
        max={45}
        step={0.1}
        value={value}
        disabled={disabled}
        aria-label="Straighten"
        aria-valuetext={`${value.toFixed(1)} degrees`}
        onPointerDown={() => onGesture(true)}
        onPointerUp={() => onGesture(false)}
        onKeyDown={() => onGesture(true)}
        onKeyUp={() => onGesture(false)}
        onChange={(e) => onLive(Number(e.target.value))}
      />
    </div>
  )
}
