import type { TextMarks as Marks } from '../../src/gallery/types.ts'

/**
 * Highlights over the words a search found written in a photo. Drawn in the
 * photo's own pixels and scaled the way the photo is: `cover` for a grid tile
 * (cropped to a square), `contain` in the viewer (fitted whole).
 */
export function TextMarks({ marks, fit, className }: { marks: Marks; fit: 'cover' | 'contain'; className: string }) {
  return (
    <svg
      className={`text-marks ${className}`}
      viewBox={`0 0 ${marks.w} ${marks.h}`}
      preserveAspectRatio={fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet'}
      aria-hidden="true"
    >
      {marks.quads.map((q, i) => (
        <polygon key={i} points={`${q[0]},${q[1]} ${q[2]},${q[3]} ${q[4]},${q[5]} ${q[6]},${q[7]}`} />
      ))}
    </svg>
  )
}
