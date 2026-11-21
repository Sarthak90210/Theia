import { forwardRef } from 'react'
import * as I from './icons.tsx'

interface Props {
  value: string
  onChange: (text: string) => void
  /** Enter: search now instead of after the pause in typing. */
  onSubmit: () => void
  onClear: () => void
}

/** Search this vault by what the photos show, the words in them, when they were taken, or place and album name. */
export const SearchBox = forwardRef<HTMLInputElement, Props>(function SearchBox({ value, onChange, onSubmit, onClear }, ref) {
  return (
    <label className="search-box" title="Search this vault (Ctrl+F)">
      <I.Search size={15} />
      <input
        ref={ref}
        type="search"
        value={value}
        placeholder="Search: beach, aadhaar, goa last december…"
        aria-label="Search photos"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onSubmit() }
          if (e.key === 'Escape' && value) { e.preventDefault(); e.stopPropagation(); onClear() }
        }}
      />
      {value && (
        <button type="button" className="ghost icon search-clear" aria-label="Clear search" onClick={onClear}>
          <I.Close size={13} />
        </button>
      )}
    </label>
  )
})
