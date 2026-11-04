/**
 * Small line icons, drawn for this app. 20 px grid, current colour.
 */

type P = { size?: number; className?: string }

function Svg({ size = 18, className, children }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  )
}

export const Phone = (p: P) => (
  <Svg {...p}>
    <rect x="5.5" y="2" width="9" height="16" rx="2" />
    <path d="M9 15.5h2" />
  </Svg>
)
export const Vault = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="15" height="12.5" rx="2" />
    <path d="M2.5 8h15M8 11.5h4" />
  </Svg>
)
export const Grid = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="6" height="6" rx="1" />
    <rect x="11" y="3" width="6" height="6" rx="1" />
    <rect x="3" y="11" width="6" height="6" rx="1" />
    <rect x="11" y="11" width="6" height="6" rx="1" />
  </Svg>
)
export const Heart = (p: P & { filled?: boolean }) => (
  <Svg {...p}>
    <path
      d="M10 16.5s-6-3.6-6-8.2A3.3 3.3 0 0 1 10 6a3.3 3.3 0 0 1 6 2.3c0 4.6-6 8.2-6 8.2Z"
      fill={p.filled ? 'currentColor' : 'none'}
    />
  </Svg>
)
export const Video = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="5" width="11" height="10" rx="2" />
    <path d="m13.5 9 4-2.5v7l-4-2.5" />
  </Svg>
)
export const Live = (p: P) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="2" />
    <circle cx="10" cy="10" r="4.8" />
    <circle cx="10" cy="10" r="7.5" strokeDasharray="1.4 1.8" />
  </Svg>
)
export const Screenshot = (p: P) => (
  <Svg {...p}>
    <path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7M13 3h2.5A1.5 1.5 0 0 1 17 4.5V7M17 13v2.5a1.5 1.5 0 0 1-1.5 1.5H13M7 17H4.5A1.5 1.5 0 0 1 3 15.5V13" />
  </Svg>
)
export const Person = (p: P) => (
  <Svg {...p}>
    <circle cx="10" cy="7" r="3" />
    <path d="M4.5 17a5.5 5.5 0 0 1 11 0" />
  </Svg>
)
export const Panorama = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 6c5 1.3 10 1.3 15 0v8c-5-1.3-10-1.3-15 0Z" />
  </Svg>
)
export const Stack = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="6" width="11" height="11" rx="1.5" />
    <path d="M6 3.5h9.5A1.5 1.5 0 0 1 17 5v9.5" />
  </Svg>
)
export const Sliders = (p: P) => (
  <Svg {...p}>
    <path d="M4 5h12M4 10h12M4 15h12" />
    <circle cx="7" cy="5" r="1.6" fill="var(--surface)" />
    <circle cx="13" cy="10" r="1.6" fill="var(--surface)" />
    <circle cx="9" cy="15" r="1.6" fill="var(--surface)" />
  </Svg>
)
export const Album = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="14" height="11" rx="1.5" />
    <path d="m3 13 4-3.5 3 2.5 2.5-2 4.5 3.5" />
    <circle cx="13" cy="8" r="1" />
  </Svg>
)
export const Cloud = (p: P) => (
  <Svg {...p}>
    <path d="M6 15.5h8.5a3 3 0 0 0 .4-6 4.5 4.5 0 0 0-8.7-.7A3.4 3.4 0 0 0 6 15.5Z" />
  </Svg>
)
export const Info = (p: P) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="7.5" />
    <path d="M10 9v5M10 6.2v.1" />
  </Svg>
)
export const Sidebar = (p: P) => <Svg {...p}><rect x="2.5" y="3.5" width="15" height="13" rx="2.5" /><path d="M7.5 3.5v13M4.8 7h.2M4.8 10h.2M4.8 13h.2" /></Svg>
export const Clock = (p: P) => <Svg {...p}><circle cx="10" cy="10" r="7" /><path d="M10 5.5V10l3 2" /></Svg>
export const Refresh = (p: P) => <Svg {...p}><path d="M16.3 8a6.5 6.5 0 1 0 .1 3M13 3.5l3.7 4.7-5.3.6" /></Svg>
export const Plus = (p: P) => (
  <Svg {...p}>
    <path d="M10 4v12M4 10h12" />
  </Svg>
)
export const Close = (p: P) => (
  <Svg {...p}>
    <path d="m5 5 10 10M15 5 5 15" />
  </Svg>
)
export const Left = (p: P) => (
  <Svg {...p}>
    <path d="m12 4-6 6 6 6" />
  </Svg>
)
export const Right = (p: P) => (
  <Svg {...p}>
    <path d="m8 4 6 6-6 6" />
  </Svg>
)
export const Check = (p: P) => (
  <Svg {...p}>
    <path d="m4.5 10.5 3.5 3.5 7.5-8" />
  </Svg>
)
export const Download = (p: P) => (
  <Svg {...p}>
    <path d="M10 3v9.5M6 8.5l4 4 4-4M3.5 16.5h13" />
  </Svg>
)
export const Folder = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 6A1.5 1.5 0 0 1 4 4.5h3.5l1.5 2h7A1.5 1.5 0 0 1 17.5 8v6.5A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5Z" />
  </Svg>
)
export const Warning = (p: P) => (
  <Svg {...p}>
    <path d="M10 3 2.5 16.5h15Z" />
    <path d="M10 8.5v3.5M10 14.3v.1" />
  </Svg>
)

/* ---------------------------------------------------------- video player */

export const Play = (p: P) => (
  <Svg {...p}>
    <path d="M6 3.8v12.4a.6.6 0 0 0 .9.5l10-6.2a.6.6 0 0 0 0-1L6.9 3.3a.6.6 0 0 0-.9.5Z" fill="currentColor" stroke="none" />
  </Svg>
)
export const Pause = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="3.5" width="3.5" height="13" rx="1" fill="currentColor" stroke="none" />
    <rect x="11.5" y="3.5" width="3.5" height="13" rx="1" fill="currentColor" stroke="none" />
  </Svg>
)
export const Back10 = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 10a6 6 0 1 0 1.8-4.3M4 3v3.5h3.5" />
    <text x="10.3" y="12.6" fontSize="6.2" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="700">10</text>
  </Svg>
)
export const Forward10 = (p: P) => (
  <Svg {...p}>
    <path d="M15.5 10a6 6 0 1 1-1.8-4.3M16 3v3.5h-3.5" />
    <text x="9.7" y="12.6" fontSize="6.2" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="700">10</text>
  </Svg>
)
export const Volume = (p: P & { level?: number }) => (
  <Svg {...p}>
    <path d="M3 8v4h3l4 3.5v-11L6 8Z" fill="currentColor" />
    {(p.level ?? 1) > 0 && <path d="M13 7.5a3.5 3.5 0 0 1 0 5" />}
    {(p.level ?? 1) > 0.5 && <path d="M15 5.5a6.4 6.4 0 0 1 0 9" />}
  </Svg>
)
export const Muted = (p: P) => (
  <Svg {...p}>
    <path d="M3 8v4h3l4 3.5v-11L6 8Z" fill="currentColor" />
    <path d="m13 8 4 4m0-4-4 4" />
  </Svg>
)
export const Fullscreen = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" />
  </Svg>
)
export const ExitFullscreen = (p: P) => (
  <Svg {...p}>
    <path d="M7.5 3.5v4h-4M12.5 3.5v4h4M7.5 16.5v-4h-4M12.5 16.5v-4h4" />
  </Svg>
)
export const PictureInPicture = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="15" height="12" rx="1.5" />
    <rect x="10" y="10" width="5.5" height="4" rx=".8" fill="currentColor" />
  </Svg>
)
export const Loop = (p: P) => (
  <Svg {...p}>
    <path d="M4 9V8a3 3 0 0 1 3-3h8.5M13 2.5 15.5 5 13 7.5M16 11v1a3 3 0 0 1-3 3H4.5M7 17.5 4.5 15 7 12.5" />
  </Svg>
)

export const Hidden = (p: P) => <Svg {...p}><path d="m3 3 14 14M8 5a9 9 0 0 1 9 5 11 11 0 0 1-3 3M11 15a9 9 0 0 1-8-5 10 10 0 0 1 3-3" /><path d="M8 8a3 3 0 0 0 4 4" /></Svg>
export const Trash = (p: P) => <Svg {...p}><path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6M12 8v6" /></Svg>

/* --------------------------------------------------------------- editor */

export const Undo = (p: P) => (
  <Svg {...p}>
    <path d="M7.5 5 4 8.5 7.5 12M4.5 8.5h7a4.5 4.5 0 0 1 0 9H9" />
  </Svg>
)
export const Redo = (p: P) => (
  <Svg {...p}>
    <path d="M12.5 5 16 8.5 12.5 12M15.5 8.5h-7a4.5 4.5 0 0 0 0 9H11" />
  </Svg>
)
export const RotateLeft = (p: P) => (
  <Svg {...p}>
    <rect x="7" y="8" width="9.5" height="8.5" rx="1.2" />
    <path d="M3.5 10.5V6.8A3.3 3.3 0 0 1 6.8 3.5H10M8 1.8l2 1.7-2 1.7" />
  </Svg>
)
export const RotateRight = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="8" width="9.5" height="8.5" rx="1.2" />
    <path d="M16.5 10.5V6.8a3.3 3.3 0 0 0-3.3-3.3H10M12 1.8l-2 1.7 2 1.7" />
  </Svg>
)
export const FlipHorizontal = (p: P) => (
  <Svg {...p}>
    <path d="M10 2.5v15" strokeDasharray="1.6 2" />
    <path d="M7.5 5.5 3 15h4.5ZM12.5 5.5 17 15h-4.5Z" />
  </Svg>
)
export const Crop = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 2.5v12h12M2.5 5.5h12v12" />
  </Svg>
)
export const Scissors = (p: P) => (
  <Svg {...p}>
    <circle cx="5.5" cy="5.5" r="2.5" />
    <circle cx="5.5" cy="14.5" r="2.5" />
    <path d="M7.6 6.9 17 14M7.6 13.1 17 6" />
  </Svg>
)
export const Compare = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="15" height="12" rx="1.5" />
    <path d="M10 4v12" />
    <path d="M10 4h6a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 16 16h-6Z" fill="currentColor" stroke="none" opacity=".45" />
  </Svg>
)
export const AspectLock = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="5" width="14" height="10" rx="1.5" />
    <path d="M7 9.5h6M7 9.5l1.5-1.5M7 9.5 8.5 11M13 9.5 11.5 8M13 9.5 11.5 11" />
  </Svg>
)
