import { forwardRef, useEffect, useRef, useState } from 'react'
import type { EditRecipe } from '../../src/media/edit-recipe.ts'
import { colourOps, coverScale } from '../../src/media/edit-math.ts'
import { dragCrop, type CropHandle, type CropRect } from './crop-geometry.ts'

/**
 * The picture being edited, drawn live in the window.
 *
 * Rotation, flip and straighten are a CSS transform on the photo or video;
 * light and colour are an SVG filter built from the same numbers the export
 * uses (src/media/edit-math.ts). Nothing waits on the main process while you
 * drag, the way Photos on Windows, Google Photos and the iPhone behave.
 *
 * Three ways to show it:
 * - crop: the whole straightened picture, with the crop frame and handles on it
 * - result: just the cropped area, as it will be saved
 * - original: the file as it is, for Compare
 */

export type CanvasMode = 'crop' | 'result' | 'original'

interface Props {
  kind: 'image' | 'video'
  src: string
  recipe: EditRecipe
  mode: CanvasMode
  /** Locked crop shape as width / height in pixels, or null for freeform. */
  aspect: number | null
  /** Show a fine grid, as while straightening. */
  fineGrid: boolean
  onCrop: (crop: CropRect) => void
  onGesture: (active: boolean) => void
  onNaturalSize: (width: number, height: number) => void
}

export const FILTER_ID = 'theia-edit-colour'

const HANDLES: { id: Exclude<CropHandle, 'move'>; name: string }[] = [
  { id: 'nw', name: 'top left' }, { id: 'n', name: 'top edge' }, { id: 'ne', name: 'top right' },
  { id: 'e', name: 'right edge' }, { id: 'se', name: 'bottom right' }, { id: 's', name: 'bottom edge' },
  { id: 'sw', name: 'bottom left' }, { id: 'w', name: 'left edge' },
]

const PAD = 48

export const EditCanvas = forwardRef<HTMLVideoElement, Props>(function EditCanvas(
  { kind, src, recipe, mode, aspect, fineGrid, onCrop, onGesture, onNaturalSize },
  videoRef,
) {
  const box = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const [space, setSpace] = useState({ width: 800, height: 600 })
  const [natural, setNatural] = useState({ width: 0, height: 0 })
  const [dragging, setDragging] = useState(false)
  const gesture = useRef<{ handle: CropHandle; crop: CropRect; x: number; y: number; w: number; h: number; pointer: number } | null>(null)

  useEffect(() => {
    const el = box.current!
    const ro = new ResizeObserver(() => setSpace({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    setSpace({ width: el.clientWidth, height: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const loaded = (w: number, h: number) => {
    if (!w || !h) return
    setNatural({ width: w, height: h })
    onNaturalSize(w, h)
  }

  const nw = natural.width || 4
  const nh = natural.height || 3
  // Compare shows the file exactly as it is, unturned.
  const quarter = mode !== 'original' && (recipe.rotation === 90 || recipe.rotation === 270)
  // The picture as displayed after quarter turns: what the crop is a fraction of.
  const W = quarter ? nh : nw
  const H = quarter ? nw : nh
  const k = coverScale(W, H, recipe.straighten)
  const ops = colourOps(recipe)
  const filtered = mode !== 'original' && !ops.identity

  const availW = Math.max(40, space.width - PAD * 2)
  const availH = Math.max(40, space.height - PAD * 2)
  const c = recipe.crop

  // Size of the full displayed frame on screen, and of the visible window onto it.
  let frameW: number, frameH: number, viewW: number, viewH: number, offX: number, offY: number
  if (mode === 'result') {
    const s = Math.min(availW / (W * c.width), availH / (H * c.height))
    frameW = W * s
    frameH = H * s
    viewW = frameW * c.width
    viewH = frameH * c.height
    offX = -c.x * frameW
    offY = -c.y * frameH
  } else {
    const s = Math.min(availW / W, availH / H)
    frameW = W * s
    frameH = H * s
    viewW = frameW
    viewH = frameH
    offX = 0
    offY = 0
  }
  // The media element keeps its own (unrotated) shape and is turned in place.
  const elemScale = frameW / W
  const elemW = nw * elemScale
  const elemH = nh * elemScale
  const transform =
    mode === 'original'
      ? 'translate(-50%, -50%)'
      : `translate(-50%, -50%) rotate(${recipe.rotation + recipe.straighten}deg) scale(${k}) scaleX(${recipe.flip ? -1 : 1})`
  const mediaStyle: React.CSSProperties = {
    width: elemW,
    height: elemH,
    transform,
    filter: filtered ? `url(#${FILTER_ID})` : undefined,
  }

  const normalizedAspect = aspect === null ? null : aspect / (W / H)

  const start = (e: React.PointerEvent, handle: CropHandle) => {
    if (mode !== 'crop' || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const r = frameRef.current!.getBoundingClientRect()
    gesture.current = { handle, crop: c, x: e.clientX, y: e.clientY, w: r.width, h: r.height, pointer: e.pointerId }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    onGesture(true)
  }
  const move = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g || g.pointer !== e.pointerId) return
    e.preventDefault()
    onCrop(dragCrop(g.crop, g.handle, (e.clientX - g.x) / g.w, (e.clientY - g.y) / g.h, normalizedAspect))
  }
  const finish = (e: React.PointerEvent) => {
    if (!gesture.current || gesture.current.pointer !== e.pointerId) return
    gesture.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
    onGesture(false)
  }
  const nudge = (e: React.KeyboardEvent, handle: CropHandle) => {
    if (mode !== 'crop' || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    e.stopPropagation()
    const step = (e.shiftKey ? 10 : 1) / Math.max(frameW, frameH)
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
    onGesture(true)
    onCrop(dragCrop(c, handle, dx, dy, normalizedAspect))
    onGesture(false)
  }
  const events = { onPointerMove: move, onPointerUp: finish, onPointerCancel: finish }

  const media =
    kind === 'video' ? (
      <video
        ref={videoRef}
        className="ed-media"
        src={src}
        style={mediaStyle}
        playsInline
        preload="auto"
        onLoadedMetadata={(e) => loaded(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
      />
    ) : (
      <img
        className="ed-media"
        src={src}
        alt=""
        draggable={false}
        style={mediaStyle}
        onLoad={(e) => loaded(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
      />
    )

  return (
    <div className={`ed-canvas ${dragging ? 'is-dragging' : ''} mode-${mode}`} ref={box}>
      <ColourFilter recipe={recipe} />
      <div className="ed-view" style={{ width: viewW, height: viewH }}>
        <div className="ed-frame" ref={frameRef} style={{ width: frameW, height: frameH, left: offX, top: offY }}>
          {media}
          {mode === 'crop' && (
            <>
              <div className="ed-shade" style={{ left: 0, top: 0, right: 0, height: `${c.y * 100}%` }} />
              <div className="ed-shade" style={{ left: 0, top: `${(c.y + c.height) * 100}%`, right: 0, bottom: 0 }} />
              <div className="ed-shade" style={{ left: 0, top: `${c.y * 100}%`, width: `${c.x * 100}%`, height: `${c.height * 100}%` }} />
              <div className="ed-shade" style={{ left: `${(c.x + c.width) * 100}%`, right: 0, top: `${c.y * 100}%`, height: `${c.height * 100}%` }} />
              <div
                className="ed-crop"
                role="group"
                tabIndex={0}
                aria-label="Crop frame. Drag to move it, or use the arrow keys. Hold Shift for bigger steps."
                style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.width * 100}%`, height: `${c.height * 100}%` }}
                onPointerDown={(e) => start(e, 'move')}
                onKeyDown={(e) => nudge(e, 'move')}
                {...events}
              >
                <div className={`ed-grid ${dragging || fineGrid ? 'shown' : ''}`} aria-hidden="true">
                  {gridLines(fineGrid ? 9 : 3).map((g) => (
                    <i key={g.key} className={g.vertical ? 'v' : 'h'} style={g.vertical ? { left: g.at } : { top: g.at }} />
                  ))}
                </div>
                {HANDLES.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    className={`ed-handle ed-handle-${h.id}`}
                    aria-label={`Resize crop from the ${h.name}`}
                    onPointerDown={(e) => start(e, h.id)}
                    onKeyDown={(e) => nudge(e, h.id)}
                    {...events}
                  >
                    <span aria-hidden="true" />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
})

const table = (t: number[]) => t.map((v) => v.toFixed(4)).join(' ')

/**
 * The colour step as an SVG filter: the per-channel tone tables, then the
 * saturation matrix, in sRGB. The export runs the same numbers.
 */
function ColourFilter({ recipe }: { recipe: EditRecipe }) {
  const ops = colourOps(recipe)
  const m = ops.matrix
  return (
    <svg className="ed-filter-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <filter id={FILTER_ID} colorInterpolationFilters="sRGB" x="0" y="0" width="1" height="1">
        <feComponentTransfer>
          <feFuncR type="table" tableValues={table(ops.tables[0])} />
          <feFuncG type="table" tableValues={table(ops.tables[1])} />
          <feFuncB type="table" tableValues={table(ops.tables[2])} />
        </feComponentTransfer>
        <feColorMatrix
          type="matrix"
          values={`${m[0]} ${m[1]} ${m[2]} 0 0  ${m[3]} ${m[4]} ${m[5]} 0 0  ${m[6]} ${m[7]} ${m[8]} 0 0  0 0 0 1 0`}
        />
      </filter>
    </svg>
  )
}

/** Rule-of-thirds lines, or a fine grid for straightening. */
function gridLines(n: number): { key: string; vertical: boolean; at: string }[] {
  const out: { key: string; vertical: boolean; at: string }[] = []
  for (let i = 1; i < n; i++) {
    out.push({ key: `v${i}`, vertical: true, at: `${(i / n) * 100}%` })
    out.push({ key: `h${i}`, vertical: false, at: `${(i / n) * 100}%` })
  }
  return out
}
