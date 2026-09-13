// @vitest-environment jsdom
/**
 * Wave 5 W36 (NOVEMBER-PLAN.md) — `useNow` replaces the once-per-mount
 * `nowMs()` read (W33) with a value that ticks on an interval, so an "ago"
 * or "days until" label doesn't freeze for as long as a tab stays open.
 *
 * No JSX here on purpose: `React.createElement` keeps this a plain
 * `.test.ts` file, which is what vitest.config.ts's `include` glob picks
 * up (it does not include `.tsx`), so no test-runner config changes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useNow } from '../use-now'

// React 19's `act` only runs its extra checks when this flag is set; without
// it, act() still works but warns "not configured to support act(...)".
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness({
  intervalMs,
  onValue,
}: {
  intervalMs?: number
  onValue: (v: number) => void
}) {
  const now = useNow(intervalMs)
  onValue(now)
  return null
}

describe('useNow', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    container.remove()
    vi.useRealTimers()
  })

  it('reads the clock once at mount, then again every intervalMs', () => {
    vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'))
    const values: number[] = []
    root = createRoot(container)
    act(() => {
      root.render(createElement(Harness, { intervalMs: 60_000, onValue: (v) => values.push(v) }))
    })
    expect(values.at(-1)).toBe(new Date('2026-09-12T00:00:00.000Z').getTime())

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(values.at(-1)).toBe(new Date('2026-09-12T00:01:00.000Z').getTime())

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(values.at(-1)).toBe(new Date('2026-09-12T00:02:00.000Z').getTime())
  })

  it('does not tick before intervalMs has elapsed', () => {
    vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'))
    const values: number[] = []
    root = createRoot(container)
    act(() => {
      root.render(createElement(Harness, { intervalMs: 60_000, onValue: (v) => values.push(v) }))
    })
    const afterMount = values.length

    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    // Still the mount-time value — no re-render 30s into a 60s interval.
    expect(values.length).toBe(afterMount)
    expect(values.at(-1)).toBe(new Date('2026-09-12T00:00:00.000Z').getTime())
  })

  it('clears the interval on unmount — no further ticks reach the component', () => {
    vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'))
    const values: number[] = []
    root = createRoot(container)
    act(() => {
      root.render(createElement(Harness, { intervalMs: 60_000, onValue: (v) => values.push(v) }))
    })
    const countAtMount = values.length

    act(() => {
      root.unmount()
    })

    act(() => {
      vi.advanceTimersByTime(5 * 60_000)
    })
    expect(values.length).toBe(countAtMount)
  })

  it('honours a custom intervalMs', () => {
    vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'))
    const values: number[] = []
    root = createRoot(container)
    act(() => {
      root.render(createElement(Harness, { intervalMs: 5_000, onValue: (v) => values.push(v) }))
    })

    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(values.at(-1)).toBe(new Date('2026-09-12T00:00:05.000Z').getTime())
  })
})
