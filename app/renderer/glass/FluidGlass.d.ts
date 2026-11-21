import type { CSSProperties, ReactNode } from 'react'

/** React Bits FluidGlass: a WebGL lens of liquid glass over text or an image. */
export interface FluidGlassProps {
  text?: string
  src?: string
  fit?: 'cover' | 'contain'
  background?: string
  textColor?: string
  fontFamily?: string
  fontWeight?: number | string
  fontSize?: number
  shape?: 'torus' | 'lens' | 'blob' | 'pill' | 'cube' | 'prism' | 'diamond'
  shapes?: string[]
  morphOnClick?: boolean
  size?: number
  interaction?: 'follow' | 'drag' | 'static'
  position?: [number, number]
  refraction?: number
  dispersion?: number
  frost?: number
  color?: string
  tint?: number
  reflection?: number
  shadow?: number
  elevation?: number
  smoothness?: number
  wobble?: number
  spin?: number
  idle?: boolean
  intro?: boolean
  maxDevicePixelRatio?: number
  onShapeChange?: (shape: string) => void
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

declare const FluidGlass: (props: FluidGlassProps) => JSX.Element
export default FluidGlass
