'use client'

/**
 * EssentialsSlider — 4-position density control for any work surface
 * (T4-D / Playbook Part 20.4).
 *
 * Surface-keyed: pass the pathname, get a slider that controls THAT
 * surface's density independently from the rest. Per-coordinator
 * default applies until the slider is moved; the override persists
 * across visits.
 *
 * Compact pill UI — fits in a page header or a sticky toolbar.
 */

import { useEssentialsLevel, ESSENTIALS_LEVELS, type EssentialsLevel } from '@/lib/hooks/use-essentials-level'

const LEVEL_LABEL: Record<EssentialsLevel, string> = {
  essentials: 'Essentials',
  recommended: 'Recommended',
  expanded: 'Expanded',
  everything: 'Everything',
}

const LEVEL_DESCRIPTION: Record<EssentialsLevel, string> = {
  essentials: 'Highest-priority items only',
  recommended: 'Default density — high + medium signals',
  expanded: 'Adds low-priority + supporting context',
  everything: 'Show everything — debugging / audit',
}

export interface EssentialsSliderProps {
  /** Surface key — typically the pathname. */
  surface: string
  /** Optional className passed to the outer container. */
  className?: string
}

export function EssentialsSlider({ surface, className }: EssentialsSliderProps) {
  const { level, setLevel, loading } = useEssentialsLevel(surface)
  return (
    <div
      className={`inline-flex items-center gap-1 bg-sage-50 rounded-lg p-1 ${className ?? ''}`}
      role="radiogroup"
      aria-label="Information density"
    >
      {ESSENTIALS_LEVELS.map((lvl) => {
        const active = level === lvl
        return (
          <button
            key={lvl}
            role="radio"
            aria-checked={active}
            disabled={loading}
            onClick={() => setLevel(lvl)}
            title={LEVEL_DESCRIPTION[lvl]}
            className={`px-2 py-1 text-xs font-medium rounded-md transition-colors ${
              active
                ? 'bg-surface text-sage-900 shadow-sm'
                : 'text-sage-600 hover:text-sage-800'
            } disabled:opacity-50`}
          >
            {LEVEL_LABEL[lvl]}
          </button>
        )
      })}
    </div>
  )
}
