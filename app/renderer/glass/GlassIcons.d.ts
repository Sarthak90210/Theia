import type { CSSProperties, ReactNode } from 'react'

export interface GlassIconsItem {
  icon: ReactNode
  label: string
  color: string
  href?: string
  target?: string
  onClick?: () => void
  id?: string
  className?: string
}

/** React Bits GlassIcons: icons on tilted coloured plates behind refracting glass. */
export interface GlassIconsProps {
  items: GlassIconsItem[]
  size?: number
  gap?: number
  columns?: number
  roundness?: number
  refraction?: number
  bevel?: number
  dispersion?: number
  frost?: number
  shine?: number
  tint?: string
  tintOpacity?: number
  iconColor?: string
  plate?: 'tilt' | 'offset' | 'circle' | 'none'
  tilt?: number
  spread?: number
  hover?: 'lift' | 'float' | 'press' | 'none'
  parallax?: number
  labels?: 'hover' | 'always' | 'none'
  intro?: boolean
  theme?: 'dark' | 'light'
  className?: string
  style?: CSSProperties
}

declare const GlassIcons: (props: GlassIconsProps) => JSX.Element
export default GlassIcons
