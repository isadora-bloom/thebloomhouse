/**
 * Wave 16 — inquiry-intent aggregate summary.
 *
 * Anchor docs:
 *   - bloom-constitution.md
 *   - bloom-may9-llm-vs-template.md
 *
 * Reads attribution_events for one venue and produces:
 *   - Per-channel intent counts (targeted / broadcast / validation /
 *     unknown)
 *   - Conversion rate by intent within each channel (booked weddings
 *     / total weddings reached by attribution events with that
 *     intent_class). The headline insight: "broadcast Knot inquiries
 *     convert at 3% while targeted Knot inquiries convert at 18%".
 *
 * Cheap PostgREST queries; no LLM calls.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

export type IntentClass = 'targeted' | 'broadcast' | 'validation' | 'unknown'

export interface PerChannelIntentCounts {
  channel: string
  total: number
  targeted: number
  broadcast: number
  validation: number
  unknown: number
  /** broadcast / (targeted + broadcast). null when both 0. */
  broadcast_share_0_1: number | null
  /** Conversion-rate-to-booked by intent. */
  conversion_by_intent: {
    targeted: number | null
    broadcast: number | null
    validation: number | null
    unknown: number | null
  }
}

export interface IntentSummary {
  venueId: string
  totalEvents: number
  byIntent: Record<IntentClass, number>
  byChannel: PerChannelIntentCounts[]
  unclassifiedCount: number
  latestClassifiedAt: string | null
}

interface AttributionEventRow {
  source_platform: string | null
  intent_class: IntentClass | null
  intent_classified_at: string | null
  wedding_id: string | null
}

interface WeddingRow {
  id: string
  status: string | null
  booked_at: string | null
}

const ALL_INTENTS: readonly IntentClass[] = [
  'targeted',
  'broadcast',
  'validation',
  'unknown',
]

export async function getIntentSummary(
  venueId: string,
  options: { supabase?: SupabaseClient } = {},
): Promise<IntentSummary> {
  const sb = options.supabase ?? createServiceClient()

  // Page attribution_events
  const PAGE_SIZE = 1000
  const rows: AttributionEventRow[] = []
  let from = 0
  while (rows.length < 50_000) {
    const { data, error } = await sb
      .from('attribution_events')
      .select('source_platform, intent_class, intent_classified_at, wedding_id')
      .eq('venue_id', venueId)
      .is('reverted_at', null)
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`getIntentSummary: ${error.message}`)
    const page = (data ?? []) as AttributionEventRow[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  // Load wedding booking status for every wedding_id referenced.
  const weddingIds = Array.from(
    new Set(rows.map((r) => r.wedding_id).filter((x): x is string => !!x)),
  )
  const weddingBooked = new Map<string, boolean>()
  if (weddingIds.length > 0) {
    // Batch in pages of 500 to be PostgREST-safe.
    for (let i = 0; i < weddingIds.length; i += 500) {
      const batch = weddingIds.slice(i, i + 500)
      const { data: wRows } = await sb
        .from('weddings')
        .select('id, status, booked_at')
        .in('id', batch)
      for (const w of (wRows ?? []) as WeddingRow[]) {
        weddingBooked.set(w.id, w.status === 'booked' || w.booked_at !== null)
      }
    }
  }

  const byIntent: Record<IntentClass, number> = {
    targeted: 0,
    broadcast: 0,
    validation: 0,
    unknown: 0,
  }
  // For per-channel counts AND conversion math: track booked weddings
  // bucketed by (channel, intent).
  interface ChannelBucket {
    total: number
    counts: Record<IntentClass, number>
    bookedByIntent: Record<IntentClass, number>
    weddingsByIntent: Record<IntentClass, Set<string>>
  }
  const channelMap = new Map<string, ChannelBucket>()
  let unclassifiedCount = 0
  let latestClassifiedAt: string | null = null

  for (const r of rows) {
    const intent: IntentClass =
      r.intent_class && (ALL_INTENTS as readonly string[]).includes(r.intent_class)
        ? (r.intent_class as IntentClass)
        : 'unknown'
    byIntent[intent] += 1
    if (intent === 'unknown') unclassifiedCount += 1

    const channel = r.source_platform ?? '(unknown)'
    let cell = channelMap.get(channel)
    if (!cell) {
      cell = {
        total: 0,
        counts: { targeted: 0, broadcast: 0, validation: 0, unknown: 0 },
        bookedByIntent: { targeted: 0, broadcast: 0, validation: 0, unknown: 0 },
        weddingsByIntent: {
          targeted: new Set(),
          broadcast: new Set(),
          validation: new Set(),
          unknown: new Set(),
        },
      }
      channelMap.set(channel, cell)
    }
    cell.total += 1
    cell.counts[intent] += 1

    if (r.wedding_id) {
      cell.weddingsByIntent[intent].add(r.wedding_id)
      if (weddingBooked.get(r.wedding_id) === true) {
        // Booked-by-intent: count the wedding once per intent class.
        // We rely on Set semantics — but bookedByIntent itself just
        // tracks counts. Dedup via the wedding set membership.
      }
    }

    if (r.intent_classified_at) {
      if (!latestClassifiedAt || r.intent_classified_at > latestClassifiedAt) {
        latestClassifiedAt = r.intent_classified_at
      }
    }
  }

  // Compute booked-per-intent using the dedup set.
  for (const cell of channelMap.values()) {
    for (const intent of ALL_INTENTS) {
      const weddings = cell.weddingsByIntent[intent]
      let booked = 0
      for (const wid of weddings) {
        if (weddingBooked.get(wid) === true) booked += 1
      }
      cell.bookedByIntent[intent] = booked
    }
  }

  const byChannel: PerChannelIntentCounts[] = [...channelMap.entries()]
    .map(([channel, cell]) => {
      const td = cell.counts.targeted + cell.counts.broadcast
      const broadcast_share = td > 0 ? cell.counts.broadcast / td : null
      const conv = (intent: IntentClass): number | null => {
        const weddings = cell.weddingsByIntent[intent].size
        if (weddings === 0) return null
        return cell.bookedByIntent[intent] / weddings
      }
      return {
        channel,
        total: cell.total,
        targeted: cell.counts.targeted,
        broadcast: cell.counts.broadcast,
        validation: cell.counts.validation,
        unknown: cell.counts.unknown,
        broadcast_share_0_1: broadcast_share,
        conversion_by_intent: {
          targeted: conv('targeted'),
          broadcast: conv('broadcast'),
          validation: conv('validation'),
          unknown: conv('unknown'),
        },
      }
    })
    .sort((a, b) => b.total - a.total)

  return {
    venueId,
    totalEvents: rows.length,
    byIntent,
    byChannel,
    unclassifiedCount,
    latestClassifiedAt,
  }
}
