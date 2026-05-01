'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * Shared list-fetching hook for venue-scoped admin pages
 * (review pass 4 — DRY consolidation of the 5+ duplicate
 * `useEffect → supabase.from(...).select(...) → setState` patterns
 * across forbidden-topics, identity-windows, marketing-channels-config,
 * absences-config, property-state-config, cultural-moments).
 *
 * Generic over the row type. Hands the caller a:
 *   - rows                  current data
 *   - loading               first-load + reload state
 *   - error                 last-error string (or null)
 *   - reload()              manual re-fetch (form submit usually triggers)
 *   - mutate(updater)       optimistic local mutation without re-fetch
 *
 * The `fetcher` is passed as a callback so each page composes its own
 * Supabase query (filtering, joins, ordering). The hook handles:
 *   - dedupe of in-flight requests
 *   - initial fetch on mount
 *   - re-fetch when `deps` change
 *   - guard against state updates after unmount
 *
 * Usage:
 *
 *   const { rows, loading, error, reload } = useSupabaseList<MyRow>(
 *     async () => {
 *       const { data, error } = await supabase.from('foo').select('...')
 *       if (error) throw error
 *       return (data ?? []) as MyRow[]
 *     },
 *     [venueId],
 *   )
 */
export function useSupabaseList<T>(
  fetcher: () => Promise<T[]>,
  deps: ReadonlyArray<unknown> = [],
): {
  rows: T[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  mutate: (updater: (prev: T[]) => T[]) => void
} {
  const [rows, setRows] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Stable ref for the fetcher so callers can pass an inline lambda
  // without thrashing the effect.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  // Track unmount to suppress setState-after-unmount warnings.
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  // Ignore the result of an in-flight request when a fresher one
  // starts (StrictMode + dependency-change races).
  const requestIdRef = useRef(0)

  const reload = useCallback(async () => {
    const myRequest = ++requestIdRef.current
    setLoading(true)
    try {
      const next = await fetcherRef.current()
      if (!aliveRef.current || requestIdRef.current !== myRequest) return
      setRows(next)
      setError(null)
    } catch (err) {
      if (!aliveRef.current || requestIdRef.current !== myRequest) return
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      if (aliveRef.current && requestIdRef.current === myRequest) {
        setLoading(false)
      }
    }
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload() }, [reload, ...deps])

  const mutate = useCallback((updater: (prev: T[]) => T[]) => {
    setRows(updater)
  }, [])

  return { rows, loading, error, reload, mutate }
}
