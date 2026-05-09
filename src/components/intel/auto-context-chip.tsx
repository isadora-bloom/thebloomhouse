'use client'

/**
 * AutoContextChip — coordinator-facing chip that surfaces the
 * highest-priority cached auto-context note on inbox / leads cards.
 *
 * Wave 1C (2026-05-09) — companion to RiskFlagChip but for the soft
 * layer. Mirrors the batch-fetch pattern (one POST per page with the
 * deduped wedding-id set, then a map keyed by wedding ID).
 *
 * Sensitive handling at the chip level:
 *   - `sensitive=true` chips render with muted styling and a "sensitive"
 *     label. The body is NEVER shown — the API returns "(sensitive
 *     note)" in place of the body.
 *   - Non-sensitive chips show a short body preview as title (hover).
 *   - Pinned chips show a tiny pin glyph.
 *
 * Doctrine — aggregate ≠ disclose: even at the per-row chip level, a
 * sensitive note's body never leaves the lead-profile surface. The
 * inbox / leads chip is a signal that "this couple has emotional
 * context", not a disclosure of what.
 */

import { useEffect, useState, useRef } from 'react'
import { Pin, Sparkles, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface AutoContextChip {
  weddingId: string
  label: string
  body: string
  sensitive: boolean
  pinned: boolean
}

// ---------------------------------------------------------------------------
// useBatchAutoContextChips — fetches the batch endpoint once, caches per page.
// ---------------------------------------------------------------------------

interface UseBatchOptions {
  /** When set, used instead of relying on auth. Demo mode passes this. */
  venueId?: string | null
}

export function useBatchAutoContextChips(
  weddingIds: Array<string | null | undefined>,
  options: UseBatchOptions = {},
): Record<string, AutoContextChip | null> {
  const cleanIds = Array.from(
    new Set(
      (weddingIds ?? []).filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      ),
    ),
  ).sort()
  const key = cleanIds.join(',')
  const [chips, setChips] = useState<Record<string, AutoContextChip | null>>({})
  const inFlight = useRef<string | null>(null)

  useEffect(() => {
    if (cleanIds.length === 0) {
      setChips({})
      return
    }
    if (inFlight.current === key) return
    inFlight.current = key

    let cancelled = false
    ;(async () => {
      try {
        const url = options.venueId
          ? `/api/intel/auto-context/batch-chips?venueId=${encodeURIComponent(options.venueId)}`
          : '/api/intel/auto-context/batch-chips'
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ weddingIds: cleanIds }),
        })
        if (!res.ok) {
          // Soft-fail: leave map empty so callers render rows without
          // chips rather than blocking on a 500. Auto-context is
          // enrichment.
          if (!cancelled) setChips({})
          return
        }
        const json = (await res.json()) as { chips?: Record<string, AutoContextChip | null> }
        if (!cancelled) setChips(json.chips ?? {})
      } catch {
        if (!cancelled) setChips({})
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, options.venueId])

  return chips
}

// ---------------------------------------------------------------------------
// AutoContextChip — tiny renderer for the per-row chip.
// ---------------------------------------------------------------------------

export interface AutoContextChipProps {
  chip: AutoContextChip | null | undefined
  className?: string
}

export function AutoContextChipRender({ chip, className }: AutoContextChipProps) {
  if (!chip) return null

  // Sensitive: muted slate styling + Lock glyph + body never echoed in
  // tooltip. The label still shows ("Health" / "Family" / etc.) so the
  // coordinator can pattern-recognise.
  if (chip.sensitive) {
    return (
      <span
        title={`${chip.label} (sensitive note, view on lead profile)`}
        className={cn(
          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
          'bg-slate-100 text-slate-600 border border-slate-200',
          className,
        )}
      >
        <Lock className="w-2.5 h-2.5" />
        <span>{chip.label}</span>
        {chip.pinned && <Pin className="w-2.5 h-2.5" />}
      </span>
    )
  }

  // Non-sensitive: warm sage chip. Body preview shown as native title
  // tooltip so the chip stays small but the coordinator can hover for
  // detail.
  return (
    <span
      title={chip.body}
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
        'bg-sage-50 text-sage-700 border border-sage-200',
        className,
      )}
    >
      <Sparkles className="w-2.5 h-2.5" />
      <span>{chip.label}</span>
      {chip.pinned && <Pin className="w-2.5 h-2.5" />}
    </span>
  )
}
