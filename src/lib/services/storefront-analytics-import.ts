/**
 * Storefront analytics import — persists the monthly visitor/lead/spend
 * data points the vision extractor pulls from platform screenshots (The
 * Knot, WeddingWire, Honeybook dashboards) into engagement_events.
 *
 * engagement_events was chosen over a new storefront_traffic table to
 * avoid a migration for what is essentially a low-cardinality metric
 * stream. Each row carries its own metadata jsonb so a coordinator can
 * upload a chart today and we can aggregate it however the UI needs.
 *
 * Dedupe: (venue_id, event_type, metadata.source, metadata.metric,
 * metadata.label) — if the same screenshot gets uploaded twice on the
 * same month, the second pass is a no-op rather than doubling counts.
 *
 * The imported rows carry points=0 because these are platform-facing
 * metrics, not behavioural heat signals (inquiry/booking-style engagement
 * events have non-zero points that feed heat scores). A coordinator
 * viewing /agent/leads or /intel/sources shouldn't see these rows mixed
 * into a couple's heat score.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ImportSummary } from '@/lib/services/brain-dump-imports'

export interface StorefrontAnalyticsRow {
  label: string            // "Oct", "Nov", "2025-10" — keep the source label verbatim
  value: number
}

export interface StorefrontAnalyticsInput {
  source: string           // the_knot, wedding_wire, honeybook, etc
  metric: string           // unique_visitors, leads, storefront_views, etc
  rows: StorefrontAnalyticsRow[]
  brainDumpEntryId?: string
}

export async function importStorefrontAnalytics(args: {
  supabase: SupabaseClient
  venueId: string
  input: StorefrontAnalyticsInput
}): Promise<ImportSummary> {
  const { supabase, venueId, input } = args
  const summary: ImportSummary = { inserted: 0, updated: 0, skipped: 0, errors: [] }

  const source = (input.source || 'other').toLowerCase().trim()
  const metric = (input.metric || 'other').toLowerCase().trim()
  // Canonical event_type for every platform-facing marketing metric
  // regardless of source. Keeps Instagram likes, Pinterest saves, Knot
  // visitors, Google Analytics sessions all in one addressable stream.
  // metadata.source + metadata.metric distinguish them.
  const eventType = 'marketing_metric'

  // Dedupe by (venue, event_type, metadata.source, metadata.metric,
  // metadata.label). Pull existing matching rows in one query rather than
  // round-tripping per-row — for 7-12 month charts this keeps it to one
  // SELECT.
  const { data: existing } = await supabase
    .from('engagement_events')
    .select('metadata')
    .eq('venue_id', venueId)
    .eq('event_type', eventType)
    .eq('metadata->>source', source)
    .eq('metadata->>metric', metric)
  const existingLabels = new Set(
    (existing ?? []).map((r) => {
      const m = r.metadata as Record<string, unknown> | null
      return m?.label ? String(m.label) : ''
    }).filter(Boolean)
  )

  for (const row of input.rows) {
    if (!row.label || !Number.isFinite(row.value)) {
      summary.errors.push(`skipped row: ${JSON.stringify(row)}`)
      continue
    }
    if (existingLabels.has(row.label)) {
      summary.skipped++
      continue
    }
    const { error } = await supabase.from('engagement_events').insert({
      venue_id: venueId,
      event_type: eventType,
      points: 0,
      metadata: {
        source,
        metric,
        label: row.label,
        value: row.value,
        imported_from: 'screenshot',
        brain_dump_entry_id: input.brainDumpEntryId ?? null,
      },
    })
    if (error) {
      summary.errors.push(`${row.label}: ${error.message}`)
      continue
    }
    existingLabels.add(row.label)
    summary.inserted++
  }

  return summary
}
