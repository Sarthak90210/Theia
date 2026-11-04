import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { mapTileUrl, mediaUrl, type ItemDetail, type SourceId } from '../shared/api.ts'
import {
  apertureLabel,
  clock,
  dateLine,
  evLabel,
  exposureLabel,
  formatChip,
  lensLabel,
  offsetLabel,
  plural,
  resolutionLabel,
  sizeLabel,
  wall,
} from './format.ts'
import * as I from './icons.tsx'

export interface InfoPanelProps {
  source: SourceId
  /** The item shown, or null when nothing or several are selected. */
  itemKey: string | null
  selectedCount: number
  mapsEnabled: boolean
  onClose: () => void
  saveButton: React.ReactNode
}

// Vault roles come from the schema, phone roles are already words.
const ROLE: Record<string, string> = {
  master: 'Original',
  original: 'Original',
  render: 'Edited version',
  sidecar: 'Edit recipe',
  motion: 'Live Photo video',
}

const TIME_SOURCE: Record<string, string> = {
  exif: 'from the photo',
  quicktime: 'from the video',
  filesystem: 'from the file date, not the camera',
  phone: "from the phone's library",
}

/**
 * Everything known about one item, laid out the way the iPhone's info screen
 * is: when, then the camera and exposure, then where on a map.
 */
export function InfoPanel({ source, itemKey, selectedCount, mapsEnabled, onClose, saveButton }: InfoPanelProps) {
  const [detail, setDetail] = useState<ItemDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDetail(null)
    setError(null)
    if (!itemKey) return
    let live = true
    window.photos
      .detail(source, itemKey)
      .then((d) => live && setDetail(d))
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [source, itemKey])

  return (
    <aside className="info" aria-label="Info">
      <div className="info-head">
        <h2>Info</h2>
        <button className="ghost icon" onClick={onClose} aria-label="Close info">
          <I.Close />
        </button>
      </div>
      <div className="info-body">
        {!itemKey && (
          <p className="muted">{selectedCount > 1 ? `${plural(selectedCount, 'item')} selected.` : 'Select a photo to see its details.'}</p>
        )}
        {itemKey && !detail && !error && <p className="muted">Reading…</p>}
        {error && <p className="bad">{error}</p>}
        {detail && <Detail d={detail} source={source} mapsEnabled={mapsEnabled} saveButton={saveButton} />}
      </div>
    </aside>
  )
}

function Detail({ d, source, mapsEnabled, saveButton }: { d: ItemDetail; source: SourceId; mapsEnabled: boolean; saveButton: React.ReactNode }) {
  const when = d.capturedUtc !== null ? wall(d.capturedUtc, d.offsetSeconds) : null
  const primary = d.files[0] ?? null
  const isVault = source.startsWith('vault:')
  const isVideo = d.kind === 'video'
  const cam = d.camera
  const ex = d.exposure

  const model = cam ? cameraName(cam.make, cam.model) : null
  const title = model ?? (d.subtype === 'screenshot' ? 'Screenshot' : d.subtype === 'screen recording' ? 'Screen Recording' : 'No camera information')
  const chip = primary ? formatChip(primary.name, primary.mime, d.video?.codec ?? null) : null
  const lens = cam ? lensLabel(cam.lens, cam.make, ex?.focal35 ?? null, ex?.zoom ?? null) : null

  const size = primary ? sizeLabel(primary.bytes) : null
  const mp = d.width && d.height ? Math.round((d.width * d.height) / 1e6) : null
  const specLine = isVideo
    ? [resolutionLabel(d.width, d.height), d.video?.fps ? `${Math.round(d.video.fps)} fps` : null, d.durationMs ? clock(d.durationMs) : null, size]
    : [mp ? `${mp} MP` : null, d.width && d.height ? `${d.width} × ${d.height}` : null, size]

  const strip = ex
    ? [
        ex.iso ? `ISO ${ex.iso}` : null,
        ex.focal35 ? `${Math.round(ex.focal35)} mm` : ex.focalMm ? `${Math.round(ex.focalMm)} mm` : null,
        evLabel(ex.ev),
        apertureLabel(ex.fNumber),
        exposureLabel(ex.exposureSeconds),
      ].filter((x): x is string => !!x)
    : []

  return (
    <>
      {d.caption && <div className="card caption">{d.caption}</div>}

      <div className="card">
        <div className="card-row">
          {when ? (
            <div>
              <div title={[offsetLabel(d.offsetSeconds), d.timeSource ? TIME_SOURCE[d.timeSource] : null].filter(Boolean).join(', ')}>
                {dateLine(when)}
              </div>
              <div className="muted">{stem(d.title)}</div>
            </div>
          ) : (
            <div>
              <div className="muted">No capture time</div>
              <div className="muted">{stem(d.title)}</div>
            </div>
          )}
        </div>

        <div className="card-line" />
        <div className="card-row split">
          <span>{title}</span>
          {chip && <span className="chip">{chip}</span>}
        </div>

        <div className="card-line" />
        <div className="card-row muted">
          {lens && <div>{lens}</div>}
          <div>{specLine.filter(Boolean).join(' • ')}</div>
        </div>

        {strip.length > 0 && (
          <>
            <div className="card-line" />
            <div className="strip">
              {strip.map((s) => (
                <span key={s}>{s}</span>
              ))}
            </div>
          </>
        )}
      </div>

      {d.location && (
        <div className="card map-card">
          {mapsEnabled && <MapView lat={d.location.lat} lon={d.location.lon} pin={mediaUrl(source, d.key, 'sm')} />}
          {!mapsEnabled && <div className="map-disabled"><span>Maps are off in Settings.</span><span className="muted">{d.location.lat.toFixed(5)}, {d.location.lon.toFixed(5)}</span></div>}
          <button className="map-foot" onClick={() => void window.photos.openMap(d.location!.lat, d.location!.lon)} title="Open in the browser">
            <span>{d.location.place ?? `${d.location.lat.toFixed(5)}, ${d.location.lon.toFixed(5)}`}</span>
            <I.Right size={14} />
          </button>
        </div>
      )}

      {(d.favourite || d.edited || d.kind === 'live' || d.cloud) && (
        <div className="info-flags">
          {d.favourite && (
            <span className="flag">
              <I.Heart size={13} filled /> Favourite
            </span>
          )}
          {d.edited && (
            <span className="flag">
              <I.Sliders size={13} /> Edited
            </span>
          )}
          {d.kind === 'live' && (
            <span className="flag">
              <I.Live size={13} /> Live Photo
            </span>
          )}
          {d.cloud && (
            <span className="flag">
              <I.Cloud size={13} /> Only in iCloud
            </span>
          )}
        </div>
      )}

      {d.albums.length > 0 && (
        <section>
          <h3>Albums</h3>
          <div>{d.albums.join(', ')}</div>
        </section>
      )}

      {!isVault && (
        <section>
          <h3>Saved</h3>
          <div className={d.savedIn.length ? '' : 'muted'}>{d.savedIn.length ? `In ${d.savedIn.join(', ')}` : 'Not in any open vault yet'}</div>
        </section>
      )}

      <section>
        <h3>Files</h3>
        <ul className="info-files">
          {d.files.map((f) => (
            <li key={f.location}>
              <div className="info-file-name">
                <span>{f.name}</span>
                <span className="muted small">{sizeLabel(f.bytes)}</span>
              </div>
              <div className="muted small">
                {ROLE[f.role] ?? f.role}
                {f.verified && ` · ${f.verified}`}
              </div>
              <div className="muted small mono path" title={f.location}>
                {f.location}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="info-actions">
        {saveButton}
        <button className="ghost" onClick={() => void window.photos.reveal(source, d.key)}>
          <I.Folder size={16} /> {isVault ? 'Show in File Explorer' : 'Copy out and show'}
        </button>
      </section>
    </>
  )
}

/** "Apple iPhone 16 Pro Max", without repeating a make the model already starts with. */
function cameraName(make: string | null, model: string | null): string | null {
  if (!make && !model) return null
  if (!make) return model
  if (!model) return make
  return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`
}

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

const TILE = 256
const MAP_ZOOM = 15
const MAP_HEIGHT = 170

/**
 * A small street map around the photo, with the photo itself as the pin.
 * Plain tiles placed by hand: no map library, nothing to load but images.
 */
function MapView({ lat, lon, pin }: { lat: number; lon: number; pin: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(268)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Web Mercator: the photo's position in pixels on the whole world at this zoom.
  const count = 2 ** MAP_ZOOM
  const world = TILE * count
  const px = ((lon + 180) / 360) * world
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180
  const py = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * world
  const left = px - width / 2
  const top = py - MAP_HEIGHT / 2

  const tiles: { x: number; y: number; key: string }[] = []
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + MAP_HEIGHT - 1) / TILE); ty++) {
    if (ty < 0 || ty >= count) continue
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + width - 1) / TILE); tx++) {
      tiles.push({ x: tx, y: ty, key: `${tx}/${ty}` })
    }
  }

  return (
    <div className="map" ref={box} style={{ height: MAP_HEIGHT }}>
      <div className="map-tiles">
        {tiles.map((t) => (
          <img
            key={t.key}
            src={mapTileUrl(MAP_ZOOM, ((t.x % count) + count) % count, t.y)}
            style={{ left: t.x * TILE - left, top: t.y * TILE - top }}
            alt=""
            draggable={false}
            onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
          />
        ))}
      </div>
      <div className="map-pin">
        <img src={pin} alt="" draggable={false} />
      </div>
      <span className="map-credit">© OpenStreetMap</span>
    </div>
  )
}
