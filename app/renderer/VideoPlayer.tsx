import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { mediaUrl, type AppState, type GalleryItem, type SourceId, type StoryboardInfo } from '../shared/api.ts'
import { clock } from './format.ts'
import * as I from './icons.tsx'

/**
 * The video player. Controls and keys follow YouTube's player, which most
 * people already know: Space or K plays, J and L jump 10 s, arrows jump 5 s
 * and change volume, M mutes, F goes full screen, comma and full stop step a
 * frame, < and > change speed, 0 to 9 jump to that tenth. The scrub bar shows
 * a frame from that moment under the pointer, like Vidstack's storyboard
 * previews.
 *
 * Before playing, the main process makes sure the window can: an iPhone
 * video streams straight off the phone, anything Chromium can't decode is
 * converted once and cached.
 */

export interface PlayerHandle {
  /** Keys the player uses. True when it handled the key. */
  key(e: React.KeyboardEvent | KeyboardEvent): boolean
}

interface Props {
  source: SourceId
  item: GalleryItem
  converting: AppState['converting']
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]
const HIDE_AFTER_MS = 2500
const FRAME = 1 / 30
const PREVIEW_MAX_H = 110

export const VideoPlayer = forwardRef<PlayerHandle, Props>(function VideoPlayer({ source, item, converting }, ref) {
  const box = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const forced = useRef(false)

  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(item.dur ? item.dur / 1000 : 0)
  const [buffered, setBuffered] = useState<[number, number][]>([])
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('photos.volume') ?? '1'))
  const [muted, setMuted] = useState(() => localStorage.getItem('photos.muted') === '1')
  const [speed, setSpeed] = useState(1)
  const [loop, setLoop] = useState(false)
  const [remaining, setRemaining] = useState(false)
  const [full, setFull] = useState(false)
  const [shown, setShown] = useState(true)
  const [menu, setMenu] = useState(false)
  const [flash, setFlash] = useState<{ text: string; n: number } | null>(null)
  const [board, setBoard] = useState<StoryboardInfo | null>(null)
  const hideTimer = useRef<number>(0)

  // Make it playable, then play.
  useEffect(() => {
    let live = true
    setSrc(null)
    setFailure(null)
    forced.current = false
    void window.photos.playback(source, item.key).then((r) => {
      if (!live) return
      if (r.ok) setSrc(mediaUrl(source, item.key, 'video'))
      else setFailure(r.error)
    })
    void window.photos.storyboard(source, item.key).then((b) => live && setBoard(b))
    return () => {
      live = false
    }
  }, [source, item.key])

  // A file that should have played didn't (HEVC on a machine without the
  // hardware decoder, say): convert it after all, once.
  const onError = () => {
    if (forced.current) {
      setFailure("This video couldn't be played or converted.")
      return
    }
    forced.current = true
    setSrc(null)
    void window.photos.playback(source, item.key, true).then((r) => {
      if (r.ok) setSrc(`${mediaUrl(source, item.key, 'video')}?converted=1`)
      else setFailure(r.error)
    })
  }

  useEffect(() => {
    const v = video.current
    if (!v) return
    v.volume = volume
    v.muted = muted
    localStorage.setItem('photos.volume', String(volume))
    localStorage.setItem('photos.muted', muted ? '1' : '0')
  }, [volume, muted, src])

  useEffect(() => {
    if (video.current) video.current.playbackRate = speed
  }, [speed, src])

  useEffect(() => {
    const onFs = () => setFull(document.fullscreenElement === box.current)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // Controls fade out while playing and the pointer is still.
  const wake = useCallback(() => {
    setShown(true)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      if (video.current && !video.current.paused) setShown(false)
    }, HIDE_AFTER_MS)
  }, [])
  useEffect(() => () => window.clearTimeout(hideTimer.current), [])

  const say = (text: string) => setFlash((f) => ({ text, n: (f?.n ?? 0) + 1 }))

  const toggle = () => {
    const v = video.current
    if (!v) return
    if (v.paused) void v.play()
    else v.pause()
    wake()
  }
  const seek = (t: number) => {
    const v = video.current
    if (!v || !Number.isFinite(v.duration)) return
    v.currentTime = Math.max(0, Math.min(v.duration, t))
    setTime(v.currentTime)
    wake()
  }
  const jump = (d: number) => {
    seek((video.current?.currentTime ?? 0) + d)
    say(`${d > 0 ? '+' : '−'}${Math.abs(d)} s`)
  }
  const changeVolume = (d: number) => {
    const v = Math.round(Math.max(0, Math.min(1, volume + d)) * 100) / 100
    setVolume(v)
    setMuted(false)
    say(`Volume ${Math.round(v * 100)}%`)
  }
  const changeSpeed = (dir: number) => {
    const i = SPEEDS.indexOf(speed)
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 3 : i) + dir))]!
    setSpeed(next)
    say(`${next}×`)
  }
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void box.current?.requestFullscreen()
  }
  const pip = () => {
    const v = video.current
    if (!v) return
    if (document.pictureInPictureElement) void document.exitPictureInPicture()
    else void v.requestPictureInPicture().catch(() => {})
  }

  useImperativeHandle(ref, () => ({
    key(e) {
      const v = video.current
      if (!v || e.ctrlKey || e.altKey || e.metaKey) return false
      const k = e.key
      if (e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight')) return false // the viewer's: previous, next
      if (k === ' ' || k.toLowerCase() === 'k') toggle()
      else if (k.toLowerCase() === 'j') jump(-10)
      else if (k.toLowerCase() === 'l') jump(10)
      else if (k === 'ArrowLeft') jump(-5)
      else if (k === 'ArrowRight') jump(5)
      else if (k === 'ArrowUp') changeVolume(0.05)
      else if (k === 'ArrowDown') changeVolume(-0.05)
      else if (k.toLowerCase() === 'm') {
        setMuted((m) => !m)
        say(muted ? 'Sound on' : 'Muted')
      } else if (k.toLowerCase() === 'f') fullscreen()
      else if (k === ',' && v.paused) seek(v.currentTime - FRAME)
      else if (k === '.' && v.paused) seek(v.currentTime + FRAME)
      else if (k === '<') changeSpeed(-1)
      else if (k === '>') changeSpeed(1)
      else if (k === 'Home') seek(0)
      else if (k === 'End') seek(v.duration - 0.1)
      else if (/^[0-9]$/.test(k)) seek((Number(k) / 10) * v.duration)
      else if (k === 'Escape' && document.fullscreenElement) void document.exitFullscreen()
      else return false
      return true
    },
  }))

  if (failure) {
    return (
      <div className="player">
        <img className="viewer-img" src={mediaUrl(source, item.key, 'lg')} alt="" />
        <div className="note-card">
          <p>{failure}</p>
          <button className="primary" onClick={() => void window.photos.openExternally(source, item.key)}>
            Open in the system player
          </button>
        </div>
      </div>
    )
  }

  const busy = converting && converting.key === item.key ? converting : null
  const progress = duration ? time / duration : 0

  return (
    <div
      ref={box}
      className={`player ${shown || !playing ? 'controls' : 'idle'}`}
      onPointerMove={wake}
      onPointerLeave={() => playing && setShown(false)}
    >
      {src ? (
        <video
          ref={video}
          className="player-video"
          src={src}
          poster={mediaUrl(source, item.key, 'lg')}
          autoPlay
          loop={loop}
          playsInline
          onClick={toggle}
          onDoubleClick={fullscreen}
          onPlay={() => {
            setPlaying(true)
            wake()
          }}
          onPause={() => {
            setPlaying(false)
            setShown(true)
          }}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
          onProgress={(e) => setBuffered(ranges(e.currentTarget.buffered))}
          onError={onError}
        />
      ) : (
        <div className="player-wait">
          <img className="viewer-img" src={mediaUrl(source, item.key, 'lg')} alt="" />
          <div className="player-status">
            <span className="spinner" />
            <span>
              {busy?.stage === 'copying'
                ? 'Copying the video off the phone…'
                : busy?.stage === 'converting'
                  ? `Converting for playback${busy.progress !== null ? ` · ${Math.round(busy.progress * 100)}%` : '…'}`
                  : 'Opening…'}
            </span>
          </div>
        </div>
      )}

      {src && !playing && (
        <button className="player-big" onClick={toggle} aria-label="Play">
          <I.Play size={34} />
        </button>
      )}
      {flash && (
        <div key={flash.n} className="player-flash">
          {flash.text}
        </div>
      )}

      {src && (
        <div className="player-bar" onPointerDown={(e) => e.stopPropagation()}>
          <Scrubber
            time={time}
            duration={duration}
            buffered={buffered}
            board={board}
            boardUrl={mediaUrl(source, item.key, 'storyboard')}
            onSeek={seek}
            onScrub={(on) => {
              const v = video.current
              if (!v) return
              // Pause while dragging, as the phone does, and carry on after.
              if (on) {
                ;(v as HTMLVideoElement & { _resume?: boolean })._resume = !v.paused
                v.pause()
              } else if ((v as HTMLVideoElement & { _resume?: boolean })._resume) void v.play()
            }}
          />
          <div className="player-row">
            <button className="pbtn" onClick={toggle} title={playing ? 'Pause (K)' : 'Play (K)'}>
              {playing ? <I.Pause /> : <I.Play />}
            </button>
            <button className="pbtn" onClick={() => jump(-10)} title="Back 10 seconds (J)">
              <I.Back10 />
            </button>
            <button className="pbtn" onClick={() => jump(10)} title="Forward 10 seconds (L)">
              <I.Forward10 />
            </button>
            <div className="pvol">
              <button className="pbtn" onClick={() => setMuted((m) => !m)} title={muted ? 'Unmute (M)' : 'Mute (M)'}>
                {muted || volume === 0 ? <I.Muted /> : <I.Volume level={volume} />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  setVolume(Number(e.target.value))
                  setMuted(false)
                }}
                aria-label="Volume"
                style={{ '--fill': `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
              />
            </div>
            <button className="ptime" onClick={() => setRemaining((r) => !r)} title="Show time left">
              {remaining ? `−${clock((duration - time) * 1000)}` : clock(time * 1000)} / {clock(duration * 1000)}
            </button>
            <span className="pspace" />
            <div className="menu-anchor">
              <button className={`pbtn ptext ${speed !== 1 ? 'on' : ''}`} onClick={() => setMenu((m) => !m)} title="Speed (< >)">
                {speed}×
              </button>
              {menu && (
                <div className="menu up" role="menu">
                  <div className="menu-heading">Speed</div>
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      className="menu-item"
                      role="menuitemradio"
                      aria-checked={s === speed}
                      onClick={() => {
                        setSpeed(s)
                        setMenu(false)
                      }}
                    >
                      <span className="menu-check">{s === speed && <I.Check size={14} />}</span>
                      <span>{s === 1 ? 'Normal' : `${s}×`}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className={`pbtn ${loop ? 'on' : ''}`} onClick={() => setLoop((l) => !l)} title="Loop">
              <I.Loop />
            </button>
            {'pictureInPictureEnabled' in document && (
              <button className="pbtn" onClick={pip} title="Picture in picture">
                <I.PictureInPicture />
              </button>
            )}
            <button className="pbtn" onClick={fullscreen} title={full ? 'Exit full screen (F)' : 'Full screen (F)'}>
              {full ? <I.ExitFullscreen /> : <I.Fullscreen />}
            </button>
          </div>
        </div>
      )}
    </div>
  )
})

function ranges(r: TimeRanges): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < r.length; i++) out.push([r.start(i), r.end(i)])
  return out
}

interface ScrubberProps {
  time: number
  duration: number
  buffered: [number, number][]
  board: StoryboardInfo | null
  boardUrl: string
  onSeek: (t: number) => void
  onScrub: (on: boolean) => void
}

/** The timeline: played, buffered, a knob, and a preview frame under the pointer. */
function Scrubber({ time, duration, buffered, board, boardUrl, onSeek, onScrub }: ScrubberProps) {
  const bar = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const at = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect()
    const x = Math.max(0, Math.min(r.width, clientX - r.left))
    return { x, t: r.width ? (x / r.width) * duration : 0 }
  }

  const pct = (t: number) => `${duration ? (t / duration) * 100 : 0}%`
  const frame = board && hover ? Math.min(board.count - 1, Math.floor(hover.t / board.interval)) : null
  // Portrait videos would make a tall preview: keep it under PREVIEW_MAX_H.
  const zoom = board ? Math.min(1, PREVIEW_MAX_H / board.height) : 1

  return (
    <div
      ref={bar}
      className={`scrub ${dragging ? 'dragging' : ''}`}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      onPointerMove={(e) => {
        const p = at(e.clientX)
        setHover(p)
        if (dragging) onSeek(p.t)
      }}
      onPointerLeave={() => !dragging && setHover(null)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setDragging(true)
        onScrub(true)
        onSeek(at(e.clientX).t)
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId)
        setDragging(false)
        onScrub(false)
      }}
    >
      <div className="scrub-track">
        {buffered.map(([a, b], i) => (
          <span key={i} className="scrub-buffered" style={{ left: pct(a), width: pct(b - a) }} />
        ))}
        <span className="scrub-played" style={{ width: pct(time) }} />
        {hover && <span className="scrub-hover" style={{ width: `${hover.x}px` }} />}
      </div>
      <span className="scrub-knob" style={{ left: pct(time) }} />
      {hover && (
        <div className="scrub-tip" style={{ left: hover.x }}>
          {board && frame !== null && (
            <span
              className="scrub-frame"
              style={{
                width: board.width * zoom,
                height: board.height * zoom,
                backgroundImage: `url("${boardUrl}")`,
                backgroundPosition: `-${(frame % board.cols) * board.width * zoom}px -${Math.floor(frame / board.cols) * board.height * zoom}px`,
                backgroundSize: `${board.cols * board.width * zoom}px ${board.rows * board.height * zoom}px`,
              }}
            />
          )}
          <span className="scrub-time">{clock(hover.t * 1000)}</span>
        </div>
      )}
    </div>
  )
}
