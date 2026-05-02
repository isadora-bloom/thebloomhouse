'use client'

/**
 * useEssentialsLevel — per-surface density level + setter (T4-D).
 *
 * Reads the caller's essentials_preferences (default + per-surface
 * overrides), caches in-memory across render cycles, exposes a setter
 * that PATCHes the preferences AND optimistically updates local
 * state. Fire-and-forget action logging on level changes feeds the
 * suggestion engine.
 *
 * Surface key convention: pathname-derived (e.g., '/agent/leads').
 * Caller passes the surface key explicitly so server-rendered pages
 * with multiple slider-aware sections can scope independently.
 */

import { useEffect, useState, useCallback } from 'react'

export type EssentialsLevel = 'essentials' | 'recommended' | 'expanded' | 'everything'

export const ESSENTIALS_LEVELS: ReadonlyArray<EssentialsLevel> = [
  'essentials',
  'recommended',
  'expanded',
  'everything',
]

interface PreferencesResponse {
  default_level: EssentialsLevel
  surface_overrides: Record<string, EssentialsLevel>
}

// Cache to avoid re-fetching across mount/unmount cycles within a session.
let cachedPrefs: PreferencesResponse | null = null
let cachedAt = 0
const CACHE_TTL_MS = 30_000

export function useEssentialsLevel(surface: string): {
  level: EssentialsLevel
  setLevel: (next: EssentialsLevel) => Promise<void>
  loading: boolean
} {
  const [prefs, setPrefs] = useState<PreferencesResponse | null>(cachedPrefs)
  const [loading, setLoading] = useState(!cachedPrefs)

  useEffect(() => {
    if (cachedPrefs && Date.now() - cachedAt < CACHE_TTL_MS) {
      setPrefs(cachedPrefs)
      setLoading(false)
      return
    }
    setLoading(true)
    fetch('/api/settings/essentials-preferences')
      .then((r) => r.json())
      .then((d) => {
        if (d?.default_level) {
          cachedPrefs = d as PreferencesResponse
          cachedAt = Date.now()
          setPrefs(cachedPrefs)
        }
      })
      .catch(() => { /* silent — fall back to default */ })
      .finally(() => setLoading(false))
  }, [])

  const setLevel = useCallback(async (next: EssentialsLevel) => {
    if (!prefs) return
    const before = prefs.surface_overrides[surface] ?? prefs.default_level
    const updated: PreferencesResponse = {
      ...prefs,
      surface_overrides: { ...prefs.surface_overrides, [surface]: next },
    }
    setPrefs(updated)
    cachedPrefs = updated
    cachedAt = Date.now()
    try {
      await fetch('/api/settings/essentials-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface_overrides: updated.surface_overrides }),
      })
      // Fire-and-forget action log (telemetry).
      void fetch('/api/settings/essentials-preferences/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          surface,
          level_at_action: before,
          action: 'changed_level',
          metadata: { from: before, to: next },
        }),
      })
    } catch {
      // Revert on failure.
      setPrefs(prefs)
      cachedPrefs = prefs
    }
  }, [prefs, surface])

  const level = (prefs?.surface_overrides[surface] ?? prefs?.default_level ?? 'recommended') as EssentialsLevel

  return { level, setLevel, loading }
}

/** Pure helper exported for unit tests — given a level + an item's
 *  visibility class, returns whether the item should render. */
export function shouldShowAtLevel(itemClass: 'essential' | 'recommended' | 'expanded' | 'everything', currentLevel: EssentialsLevel): boolean {
  const itemRank = ESSENTIALS_LEVELS.indexOf(itemClass as EssentialsLevel)
  const currentRank = ESSENTIALS_LEVELS.indexOf(currentLevel)
  return itemRank <= currentRank
}
