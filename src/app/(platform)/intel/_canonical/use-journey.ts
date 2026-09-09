'use client'

/**
 * One couple's journey, from the canonical reader.
 *
 * /intel/couples/[id] and /intel/couples/[id]/journey each ran their own
 * three-query load of the same three tables and each shaped the result
 * slightly differently. Both now call this, which calls
 * /api/intel/canonical/journey, which calls getCoupleJourney.
 *
 * The hook also hands back the touchpoints in the shape JourneyRibbon
 * draws, assembled from the canonical ribbon plus the two presentation
 * columns the route selects alongside it. Ordering and membership come
 * from the reader; only signal_tier / confidence_tier / raw_payload come
 * from the supplementary select.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CoupleJourney } from '@/lib/intel/canonical'
import type { HeatWhy } from '@/lib/intel/adapters/heat-why'
import type {
  JourneyAnchor,
  JourneyTouchpoint,
} from '@/components/identity/JourneyRibbon'

export interface JourneyContact {
  venue_id: string
  primary_contact_name: string | null
  primary_contact_email: string | null
  primary_contact_phone: string | null
  partner_contact_name: string | null
  partner_contact_email: string | null
  partner_contact_phone: string | null
  wedding_date: string | null
  source_wedding_id: string | null
  last_progression_at: string | null
}

interface RibbonField {
  id: string
  signal_tier: string
  confidence_tier: string | null
  raw_payload: Record<string, unknown> | null
}

interface ApiResponse {
  ok: boolean
  journey?: CoupleJourney | null
  venueId?: string | null
  contact?: JourneyContact | null
  ribbonFields?: RibbonField[]
  heat?: HeatWhy | null
  error?: string
}

export function useCoupleJourney(coupleId: string | null, reloadKey = 0) {
  const [journey, setJourney] = useState<CoupleJourney | null>(null)
  const [contact, setContact] = useState<JourneyContact | null>(null)
  const [heat, setHeat] = useState<HeatWhy | null>(null)
  const [fields, setFields] = useState<RibbonField[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!coupleId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/intel/canonical/journey?coupleId=${encodeURIComponent(coupleId)}`,
        { cache: 'no-store' },
      )
      const body = (await res.json()) as ApiResponse
      if (!body.ok) {
        setError(body.error ?? `Journey failed (HTTP ${res.status})`)
        return
      }
      if (!body.journey || !body.journey.couple) {
        setError('Couple not found in the venues you have in scope.')
        setJourney(null)
        return
      }
      setJourney(body.journey)
      setContact(body.contact ?? null)
      setHeat(body.heat ?? null)
      setFields(body.ribbonFields ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [coupleId])

  useEffect(() => {
    void load()
    // reloadKey lets a host page force a refetch after a merge / unmerge
    // without owning the fetch itself.
  }, [load, reloadKey])

  /** Canonical ribbon, decorated with the columns the drawing needs. */
  const touchpoints: JourneyTouchpoint[] = useMemo(() => {
    if (!journey) return []
    const byId = new Map(fields.map((f) => [f.id, f]))
    return journey.ribbon.map((t) => {
      const f = byId.get(t.id)
      return {
        id: t.id,
        channel: t.channel,
        action_type: t.actionType,
        occurred_at: t.occurredAt,
        signal_tier: f?.signal_tier ?? 'low',
        confidence_tier: f?.confidence_tier ?? null,
        raw_payload: f?.raw_payload ?? null,
      }
    })
  }, [journey, fields])

  const anchors: JourneyAnchor[] = useMemo(() => {
    if (!journey) return []
    return journey.progression.map((p, i) => ({
      id: `${p.eventType}-${i}`,
      occurred_at: p.occurredAt,
      event_type: p.eventType,
    }))
  }, [journey])

  return { journey, contact, heat, touchpoints, anchors, loading, error, reload: load }
}
