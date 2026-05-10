'use client'

/**
 * Wave 5D — VenueThesisPanel embeddable summary.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5D — onboarding bootstrap)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5D spec)
 *
 * Compact summary of the venue thesis: archetype + operator brief.
 * Surfaces on the main onboarding flow + venue-creation success page.
 *
 * Reads /api/admin/onboarding/venue-thesis (GET). When no thesis is
 * stored, renders the "we'll have this once your cohort grows" empty
 * state instead of an error.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Compass, Sparkles, ArrowRight, Loader2 } from 'lucide-react'

interface VenueArchetype {
  label: string
  description: string
  evidence_summary: string
  confidence_0_100: number
}

interface ThesisSummary {
  ok: boolean
  venueId: string
  thesis: {
    venue_archetype: VenueArchetype
    operator_brief_paragraph: string
    cohort_size_at_generation: number
  }
  couplesAtGeneration: number
  lastGeneratedAt?: string
}

interface VenueThesisPanelProps {
  /** Optional explicit venueId. When omitted the endpoint reads it
   *  from getPlatformAuth (the standard coordinator path). */
  venueId?: string
  /** When true, hides the "View full thesis" link. Useful in places
   *  that already host the full dashboard. */
  hideLink?: boolean
  className?: string
}

export function VenueThesisPanel({
  venueId,
  hideLink,
  className,
}: VenueThesisPanelProps) {
  const [data, setData] = useState<ThesisSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      setNotFound(false)
      try {
        const url = venueId
          ? `/api/admin/onboarding/venue-thesis?venueId=${venueId}`
          : '/api/admin/onboarding/venue-thesis'
        const res = await fetch(url)
        if (cancelled) return
        if (res.status === 404) {
          setNotFound(true)
          return
        }
        const json = (await res.json()) as ThesisSummary & { error?: string }
        if (!res.ok || !json.ok) {
          setError(json.error ?? `HTTP ${res.status}`)
          return
        }
        setData(json)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [venueId])

  const wrapperClass = className ?? 'p-6 bg-white border border-stone-200 rounded-lg'

  if (loading) {
    return (
      <div className={wrapperClass}>
        <div className="flex items-center gap-2 text-stone-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading venue thesis…
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={wrapperClass}>
        <div className="text-sm text-red-700">
          Couldn&rsquo;t load venue thesis: {error}
        </div>
      </div>
    )
  }

  if (notFound || !data) {
    return (
      <div className={wrapperClass}>
        <div className="flex items-start gap-3">
          <Sparkles className="w-5 h-5 text-stone-400 flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-serif text-lg text-stone-900 mb-1">
              Venue thesis pending
            </div>
            <div className="text-sm text-stone-600">
              Once Wave 4 has reconstructed enough couples, Bloom will
              synthesise your venue&rsquo;s strategic identity — archetype,
              over-indexed personas, voice that resonates, and gaps to invest
              in. You&rsquo;ll never start blank.
            </div>
            {!hideLink && (
              <Link
                href="/admin/onboarding/thesis"
                className="inline-flex items-center gap-1 mt-3 text-sm text-sage-700 hover:text-sage-800"
              >
                Generate now <ArrowRight className="w-3 h-3" />
              </Link>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={wrapperClass}>
      <div className="flex items-center gap-2 mb-2 text-sage-700">
        <Compass className="w-4 h-4" />
        <span className="text-xs uppercase tracking-wide">
          Venue archetype
        </span>
      </div>
      <div className="text-2xl font-serif text-stone-900 mb-2">
        {data.thesis.venue_archetype.label}
      </div>
      <p className="text-sm text-stone-700 leading-relaxed mb-3">
        {data.thesis.operator_brief_paragraph}
      </p>
      <div className="flex items-center justify-between text-xs text-stone-500">
        <span>
          Synthesised from{' '}
          <span className="font-mono">
            {data.thesis.cohort_size_at_generation}
          </span>{' '}
          couples
        </span>
        {!hideLink && (
          <Link
            href="/admin/onboarding/thesis"
            className="inline-flex items-center gap-1 text-sage-700 hover:text-sage-800"
          >
            View full thesis <ArrowRight className="w-3 h-3" />
          </Link>
        )}
      </div>
    </div>
  )
}

export default VenueThesisPanel
