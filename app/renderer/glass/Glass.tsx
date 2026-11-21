import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import GlassSurface from './GlassSurface.jsx'

/**
 * Theia's Liquid Glass, after Apple's design language: the navigation layer
 * (toolbars, controls, bars over photos) is glass that bends what passes
 * beneath it at its edges, with a soft tint of the theme's panel colour in
 * the middle so labels stay readable over any photo.
 *
 * Built on React Bits' GlassSurface (an SVG displacement filter as a
 * backdrop filter, which Chromium, and so Electron, supports). With Liquid
 * Glass switched off, or Windows asking for less transparency, it becomes a
 * plain frosted panel.
 */

export type GlassMode = 'liquid' | 'frosted'
export const GlassMode = createContext<GlassMode>('liquid')

/** 'liquid' unless switched off in Settings or Windows asks for less transparency. */
export function useGlassMode(enabled: boolean): GlassMode {
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)
  useEffect(() => {
    const q = matchMedia('(prefers-reduced-transparency: reduce)')
    const on = () => setReduced(q.matches)
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [])
  return enabled && !reduced ? 'liquid' : 'frosted'
}

export interface GlassProps {
  children?: ReactNode
  className?: string
  style?: CSSProperties
  /** Corner radius in px; a big number makes a capsule. */
  radius?: number
  /** How far the edge bends the view: 'subtle' for big panels, 'strong' for small controls. */
  bend?: 'subtle' | 'regular' | 'strong'
}

const BEND = { subtle: -50, regular: -90, strong: -140 }

export function Glass({ children, className = '', style, radius = 999, bend = 'regular' }: GlassProps) {
  const mode = useContext(GlassMode)
  return (
    <GlassSurface
      width="auto"
      height="auto"
      borderRadius={radius}
      refraction={mode === 'liquid'}
      distortionScale={BEND[bend]}
      borderWidth={0.08}
      blur={8}
      brightness={50}
      opacity={0.92}
      displace={0.4}
      redOffset={0}
      greenOffset={5}
      blueOffset={10}
      saturation={1.6}
      className={`glass ${className}`}
      style={style}
    >
      {children}
    </GlassSurface>
  )
}
