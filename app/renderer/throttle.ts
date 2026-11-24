import { useEffect, useRef, useState } from 'react'

/**
 * `value`, changing at most once per `ms`. The first change shows at once
 * (leading edge), changes inside the window collapse into one at its end
 * (trailing edge), so the last value always lands. For a number that ticks
 * many times a second, where each tick would start expensive work.
 */
export function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value)
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(value)
  latest.current = value

  useEffect(() => {
    if (Object.is(value, shown)) return
    const wait = last.current + ms - Date.now()
    if (wait <= 0) {
      last.current = Date.now()
      setShown(value)
      return
    }
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      last.current = Date.now()
      setShown(latest.current)
    }, wait)
  }, [value, shown, ms])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return shown
}
