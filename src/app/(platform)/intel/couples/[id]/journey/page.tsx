'use client'

/**
 * /intel/couples/[id]/journey - standalone full-width journey ribbon.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §6 + Tier 8 T8.3.
 *
 * The couple detail page already embeds JourneyRibbon as one section
 * among several. This route is the FOCUSED standalone view: just the
 * ribbon, the action chip, and the legend, full width. Useful for:
 *  - Printable / shareable per-couple briefings
 *  - Operator deep-review when investigating a specific couple
 *  - Embedding via iframe in coordinator daily briefings
 *
 * Reads the same data the embedded ribbon reads: couples row, all
 * touchpoints for the couple, all couple_progression_events as anchors.
 */

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Loader2, AlertCircle } from 'lucide-react'
import {
  JourneyRibbon,
  type JourneyTouchpoint,
  type JourneyAnchor,
} from '@/components/identity/JourneyRibbon'
import { JourneyActionChip } from '@/components/identity/JourneyActionChip'

interface CoupleRow {
  id: string
  primary_contact_name: string | null
  primary_contact_email: string | null
  lifecycle_state: string
  wedding_date: string | null
  heat_score: number | null
}

export default function JourneyStandalonePage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const coupleId = params?.id ?? null

  const supabase = useMemo(() => createClient(), [])
  const [couple, setCouple] = useState<CoupleRow | null>(null)
  const [touchpoints, setTouchpoints] = useState<JourneyTouchpoint[]>([])
  const [anchors, setAnchors] = useState<JourneyAnchor[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!coupleId) return
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [coupleResp, tpsResp, progsResp] = await Promise.all([
          supabase
            .from('couples')
            .select(
              'id, primary_contact_name, primary_contact_email, lifecycle_state, wedding_date, heat_score',
            )
            .eq('id', coupleId)
            .maybeSingle(),
          supabase
            .from('touchpoints')
            .select(
              'id, channel, signal_tier, action_type, occurred_at, confidence_tier, raw_payload',
            )
            .eq('couple_id', coupleId)
            .order('occurred_at', { ascending: true })
            .limit(1000),
          supabase
            .from('couple_progression_events')
            .select('event_type, occurred_at')
            .eq('couple_id', coupleId)
            .order('occurred_at', { ascending: true }),
        ])
        if (cancelled) return
        if (coupleResp.error || !coupleResp.data) {
          setError(coupleResp.error?.message ?? 'Couple not found')
          return
        }
        setCouple(coupleResp.data as CoupleRow)
        setTouchpoints((tpsResp.data ?? []) as JourneyTouchpoint[])
        setAnchors(
          ((progsResp.data ?? []) as Array<{
            event_type: string
            occurred_at: string
          }>).map((p, i) => ({
            id: `${p.event_type}-${i}`,
            occurred_at: p.occurred_at,
            event_type: p.event_type,
          })),
        )
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [coupleId, supabase])

  if (!coupleId) return null

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-4">
        <button
          type="button"
          onClick={() => router.push(`/intel/couples/${coupleId}`)}
          className="inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-800"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to couple
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 px-2 py-8 text-stone-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading journey…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">Could not load journey</div>
            <div className="mt-0.5 text-rose-700">{error}</div>
          </div>
        </div>
      )}

      {couple && !loading && !error && (
        <div className="space-y-6">
          <div>
            <h1 className="font-serif text-3xl text-stone-900">
              {couple.primary_contact_name ?? '(no name)'}
            </h1>
            <p className="mt-1 text-sm text-stone-600">
              {couple.lifecycle_state}
              {couple.wedding_date ? ` · ${couple.wedding_date}` : ''}
              {couple.heat_score !== null ? ` · heat ${couple.heat_score}` : ''}
              {touchpoints.length > 0 ? ` · ${touchpoints.length} touchpoints` : ''}
              {anchors.length > 0 ? ` · ${anchors.length} progression events` : ''}
            </p>
          </div>

          {touchpoints.length > 0 && (
            <JourneyActionChip
              input={{
                lifecycle_state: couple.lifecycle_state,
                last_progression_at:
                  anchors.length > 0
                    ? anchors[anchors.length - 1]!.occurred_at
                    : touchpoints[touchpoints.length - 1]!.occurred_at,
                wedding_date: couple.wedding_date,
              }}
            />
          )}

          <section className="rounded-xl border border-stone-200 bg-white shadow-sm">
            <div className="border-b border-stone-200 px-6 py-4">
              <h2 className="text-base font-semibold text-stone-900">Journey ribbon</h2>
              <p className="mt-1 text-xs text-stone-500">
                Every touchpoint by occurred_at on a linear time axis. Hover any
                dot for source detail; hover any gap for silence duration.
                Progression-event anchors mark state transitions (tour booked,
                attended, booked, lost).
              </p>
            </div>
            <div className="px-6 py-6">
              <JourneyRibbon
                touchpoints={touchpoints}
                anchors={anchors}
                showLegend
                height={96}
              />
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
