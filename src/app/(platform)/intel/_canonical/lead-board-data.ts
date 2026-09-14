'use client'

/**
 * The one client-side wiring for the lead board.
 *
 * /agent/leads and /agent/pipeline both call this, both get the same
 * rows, and both run the same pure adapter over them. Lives under
 * `intel/_canonical` beside the triage rail because it belongs to the
 * reader rather than to either route; `_canonical` is a private folder,
 * so nothing here is routable.
 *
 * It fetches and it reports. It does not decide anything: the stage, the
 * heat words and the column a card lands in are all the adapter's, so a
 * page cannot quietly reinterpret a field on its way to the screen.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LeadBoardRow } from '@/lib/intel/readers/lead-board'
import { toLeadCards, type LeadCard } from '@/lib/intel/adapters/lead-board-view'

interface LeadBoardResponse {
  ok: boolean
  rows?: LeadBoardRow[]
  venueCount?: number
  heatAvailable?: boolean
  unattachedFragments?: number | null
  truncated?: boolean
  warnings?: string[]
  generatedAt?: string
  error?: string
}

export interface UseLeadBoard {
  cards: LeadCard[]
  loading: boolean
  /** Set when the whole read failed. The surface shows the red banner and
   *  a retry, never an empty table dressed up as "no leads". */
  error: string | null
  /** False when the touchpoint read failed. Heat is unknown for every
   *  card in the batch, not zero. */
  heatAvailable: boolean
  /** Signals in this venue that never attached to anybody. The list is
   *  not everything that happened and this is how the page says so. */
  unattachedFragments: number | null
  truncated: boolean
  /** Non-fatal problems, already in operator English. */
  warnings: string[]
  /** Frozen at fetch time so every card in one render is derived against
   *  one clock. */
  generatedAt: string | null
  reload: () => void
}

export function useLeadBoard(): UseLeadBoard {
  const [rows, setRows] = useState<LeadBoardRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [heatAvailable, setHeatAvailable] = useState(true)
  const [unattachedFragments, setUnattached] = useState<number | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/intel/canonical/lead-board', { cache: 'no-store' })
      const body = (await res.json()) as LeadBoardResponse
      if (!body.ok) {
        setError(body.error ?? `Lead board failed (HTTP ${res.status})`)
        setRows([])
      } else {
        setRows(body.rows ?? [])
        setHeatAvailable(body.heatAvailable !== false)
        setUnattached(body.unattachedFragments ?? null)
        setTruncated(Boolean(body.truncated))
        setWarnings(body.warnings ?? [])
        setGeneratedAt(body.generatedAt ?? new Date().toISOString())
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // One clock for the whole board. Deriving per card against Date.now()
  // would let two cards in one render disagree about what "this week"
  // means, which is exactly the class of wrongness this wave is closing.
  const cards = useMemo(() => {
    const now = generatedAt ? Date.parse(generatedAt) : Date.now()
    return toLeadCards(rows, Number.isFinite(now) ? now : Date.now())
  }, [rows, generatedAt])

  return {
    cards,
    loading,
    error,
    heatAvailable,
    unattachedFragments,
    truncated,
    warnings,
    generatedAt,
    reload: load,
  }
}
