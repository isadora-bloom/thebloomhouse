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
 * W2 canonical wiring: this page used to repeat the couple-detail page's
 * three-query load by hand, so the two routes could and did drift about
 * which touchpoints belonged to a couple. Both now call
 * getCoupleJourney through the same hook, so the ribbon here and the
 * ribbon there are the same rows in the same order.
 */

import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Loader2, AlertCircle } from 'lucide-react'
import { JourneyRibbon } from '@/components/identity/JourneyRibbon'
import { JourneyActionChip } from '@/components/identity/JourneyActionChip'
import { WhyThisCard } from '@/components/ui/why-this-card'
import { useCoupleJourney } from '../../../_canonical/use-journey'

export default function JourneyStandalonePage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const coupleId = params?.id ?? null

  const { journey, contact, heat, touchpoints, anchors, loading, error } =
    useCoupleJourney(coupleId)

  if (!coupleId) return null

  const couple = journey?.couple ?? null

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
              {couple.names ?? '(no name)'}
            </h1>
            <p className="mt-1 text-sm text-stone-600">
              {couple.lifecycle ?? 'unknown'}
              {contact?.wedding_date ? ` · ${contact.wedding_date}` : ''}
              {heat ? ` · heat ${heat.displayScore} (${heat.label})` : ''}
              {touchpoints.length > 0 ? ` · ${touchpoints.length} touchpoints` : ''}
              {anchors.length > 0 ? ` · ${anchors.length} progression events` : ''}
            </p>
          </div>

          {touchpoints.length > 0 && (
            <JourneyActionChip
              input={{
                lifecycle_state: couple.lifecycle ?? 'channel_scoped',
                last_progression_at:
                  anchors.length > 0
                    ? anchors[anchors.length - 1]!.occurred_at
                    : touchpoints[touchpoints.length - 1]!.occurred_at,
                wedding_date: contact?.wedding_date ?? null,
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

          {heat && heat.contributingCount > 0 && (
            <section className="rounded-xl border border-stone-200 bg-white shadow-sm">
              <div className="px-6 py-4">
                <div className="flex flex-wrap items-baseline gap-3">
                  <h2 className="text-base font-semibold text-stone-900">Heat</h2>
                  <span className="text-2xl font-bold tabular-nums text-stone-900">
                    {heat.displayScore}
                  </span>
                  <span className="rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-xs text-stone-600">
                    {heat.label}
                  </span>
                </div>
                <WhyThisCard
                  title="Why this couple is at this temperature"
                  reasoning={heat.reasoning}
                  evidence={heat.evidence}
                  source="computeHeatBreakdown (src/lib/services/identity/heat-score.ts)"
                  defaultOpen
                />
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
