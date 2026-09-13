'use client'

import { useEffect, useState } from 'react'
import { nowMs } from '@/lib/utils/clock'

/**
 * A wall-clock reading that ticks while the component is mounted.
 *
 * W33 (wave 4) satisfied the React Compiler's purity rule by reading
 * `nowMs()` once per mount (`useMemo(() => nowMs(), [])`). That is honest
 * at the moment the page loads, but a coordinator who leaves a tab open —
 * `/intel/market-pulse`, the couple portal top bar — keeps seeing "2
 * minutes ago" and "14 days until the tour" for as long as the tab stays
 * open, because the read never happens again.
 *
 * `useNow` re-reads the clock on an interval instead: the initial value
 * still comes from `nowMs()` (so first render is compiler-pure and
 * matches server/client hydration), then a plain `Date.now()` inside a
 * `useEffect` — never in the render body — updates state every
 * `intervalMs`. The interval is cleared on unmount.
 *
 * Default 60s: fine-grained enough that "ago" labels don't visibly stick,
 * coarse enough not to re-render a busy page every second.
 */
export function useNow(intervalMs: number = 60_000): number {
  const [now, setNow] = useState<number>(() => nowMs())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])

  return now
}
