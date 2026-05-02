'use client'

/**
 * RiskFlagChip — coordinator-facing chip that surfaces a cached
 * `risk_flag` insight on inbox / leads / pipeline cards.
 *
 * Rendering wraps the shared <RiskFlag> primitive in
 * components/intel/inline-primitives.tsx so the colour bands and copy
 * stay identical across surfaces. A hover tooltip carries the LLM
 * narration so the chip stays small visually but coordinators can
 * read the evidence without leaving the page.
 *
 * Data is fetched ONCE per page via useBatchRiskFlags (below) — the
 * hook accepts an array of wedding IDs, calls
 * /api/insights/risk-flags once with the deduped set, and returns a
 * map keyed by wedding ID. This avoids the N+1 anti-pattern that
 * /api/insights/lead/[weddingId] would have caused if surfaced
 * per-row.
 *
 * T5-ζ.2 / ARCH-20.2.1.
 */

import { useEffect, useState, useRef } from 'react'
import { RiskFlag } from './inline-primitives'

export interface RiskSummary {
  weddingId: string
  risk_score: number
  top_severity: 1 | 2 | 3
  label: string
  narration: string
  action: string | null
  flag_count: number
}

// ---------------------------------------------------------------------------
// useBatchRiskFlags — fetches the batch endpoint once, caches per page.
// ---------------------------------------------------------------------------

interface UseBatchRiskFlagsOptions {
  /** When set, used instead of relying on auth. Demo mode passes this. */
  venueId?: string | null
}

export function useBatchRiskFlags(
  weddingIds: Array<string | null | undefined>,
  options: UseBatchRiskFlagsOptions = {},
): Record<string, RiskSummary | null> {
  // Stable key so the effect doesn't refetch when the parent re-renders
  // with the same set of wedding IDs in a different array reference.
  const cleanIds = Array.from(
    new Set(
      (weddingIds ?? []).filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      ),
    ),
  ).sort()
  const key = cleanIds.join(',')
  const [flags, setFlags] = useState<Record<string, RiskSummary | null>>({})
  // Track in-flight ID set so we don't double-fetch in StrictMode.
  const inFlight = useRef<string | null>(null)

  useEffect(() => {
    if (cleanIds.length === 0) {
      setFlags({})
      return
    }
    if (inFlight.current === key) return
    inFlight.current = key

    let cancelled = false
    ;(async () => {
      try {
        const url = options.venueId
          ? `/api/insights/risk-flags?venueId=${encodeURIComponent(options.venueId)}`
          : '/api/insights/risk-flags'
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ weddingIds: cleanIds }),
        })
        if (!res.ok) {
          // Soft-fail: leave map empty so callers render their cards
          // without risk chips rather than blocking on a 500.
          console.warn('[useBatchRiskFlags] non-OK response:', res.status)
          if (!cancelled) setFlags({})
          return
        }
        const json = (await res.json()) as { flags?: Record<string, RiskSummary | null> }
        if (!cancelled) setFlags(json.flags ?? {})
      } catch (err) {
        console.warn('[useBatchRiskFlags] fetch failed:', err)
        if (!cancelled) setFlags({})
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, options.venueId])

  return flags
}

// ---------------------------------------------------------------------------
// RiskFlagChip — tiny renderer for the per-row chip.
// ---------------------------------------------------------------------------

export interface RiskFlagChipProps {
  summary: RiskSummary | null | undefined
  className?: string
}

export function RiskFlagChip({ summary, className }: RiskFlagChipProps) {
  if (!summary || summary.flag_count === 0) return null
  const tooltip = summary.action
    ? `${summary.narration}\n\nNext step: ${summary.action}`
    : summary.narration
  return (
    <RiskFlag
      severity={summary.top_severity}
      label={summary.label}
      title={tooltip}
      className={className}
    />
  )
}
