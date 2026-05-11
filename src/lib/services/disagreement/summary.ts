/**
 * Bloom House — Wave 17 disagreement summary aggregator.
 *
 * Anchor docs:
 *   - feedback_self_reported_sources_not_truth.md (the dashboard's job
 *     is to surface every axis the gap shows up on)
 *
 * Reads disagreement_findings for one venue, returns:
 *   - counts by axis × status
 *   - biggest-magnitude active findings (top-N) per axis
 *
 * The dashboard hydrates from this single endpoint to avoid N round-
 * trips.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import {
  ALL_AXES,
  type AxisBucket,
  type DisagreementAxis,
  type DisagreementFindingRow,
  type DisagreementStatus,
  type DisagreementSummary,
} from './types'

const STATUSES: readonly DisagreementStatus[] = [
  'active',
  'resolved',
  'dismissed',
  'investigating',
]

export async function getDisagreementSummary(
  venueId: string,
  options: {
    supabase?: SupabaseClient
    biggestLimit?: number
  } = {},
): Promise<DisagreementSummary> {
  const supabase = options.supabase ?? createServiceClient()
  const biggestLimit = options.biggestLimit ?? 12

  // Load all rows for the venue. At venue scale (few hundred findings
  // max) a single page is cheap; if a venue ever blows past 10k we
  // can add server-side aggregation.
  const PAGE_SIZE = 1000
  const rows: DisagreementFindingRow[] = []
  let from = 0
  while (rows.length < 50_000) {
    const { data, error } = await supabase
      .from('disagreement_findings')
      .select(
        'id, venue_id, wedding_id, axis, stated_value, stated_source_kind, ' +
          'forensic_value, forensic_source_kind, magnitude_score, ' +
          'confidence_0_100, first_detected_at, last_observed_at, status, ' +
          'resolution_note, resolved_at, dismissed_at, narrator_text, ' +
          'narrator_generated_at, narrator_prompt_version, narrator_cost_cents, ' +
          'created_at, updated_at',
      )
      .eq('venue_id', venueId)
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`getDisagreementSummary: ${error.message}`)
    const page = (data ?? []) as unknown as DisagreementFindingRow[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  const totals: Record<DisagreementStatus, number> = {
    active: 0,
    resolved: 0,
    dismissed: 0,
    investigating: 0,
  }
  const axisMap = new Map<DisagreementAxis, AxisBucket>()
  for (const axis of ALL_AXES) {
    axisMap.set(axis, {
      axis,
      active: 0,
      resolved: 0,
      dismissed: 0,
      investigating: 0,
      total: 0,
    })
  }

  for (const r of rows) {
    if (STATUSES.includes(r.status)) {
      totals[r.status] = (totals[r.status] ?? 0) + 1
    }
    const bucket = axisMap.get(r.axis)
    if (bucket) {
      bucket.total += 1
      if (STATUSES.includes(r.status)) {
        bucket[r.status] = (bucket[r.status] ?? 0) + 1
      }
    }
  }

  // Top biggest-magnitude active findings.
  const biggest = rows
    .filter((r) => r.status === 'active')
    .sort((a, b) => {
      const ma = a.magnitude_score ?? -1
      const mb = b.magnitude_score ?? -1
      if (mb !== ma) return mb - ma
      return (b.last_observed_at ?? '').localeCompare(a.last_observed_at ?? '')
    })
    .slice(0, biggestLimit)

  return {
    venueId,
    totals,
    byAxis: [...axisMap.values()],
    biggest,
  }
}

/**
 * Paged list with filters. Used by the dashboard for the per-axis lists.
 */
export interface ListFilters {
  axis?: DisagreementAxis
  status?: DisagreementStatus
  minMagnitude?: number
  limit?: number
  offset?: number
}

export async function listDisagreements(
  venueId: string,
  filters: ListFilters = {},
  options: { supabase?: SupabaseClient } = {},
): Promise<{
  rows: DisagreementFindingRow[]
  hasMore: boolean
}> {
  const supabase = options.supabase ?? createServiceClient()
  const limit = filters.limit ?? 50
  const offset = filters.offset ?? 0
  let q = supabase
    .from('disagreement_findings')
    .select(
      'id, venue_id, wedding_id, axis, stated_value, stated_source_kind, ' +
        'forensic_value, forensic_source_kind, magnitude_score, ' +
        'confidence_0_100, first_detected_at, last_observed_at, status, ' +
        'resolution_note, resolved_at, dismissed_at, narrator_text, ' +
        'narrator_generated_at, narrator_prompt_version, narrator_cost_cents, ' +
        'created_at, updated_at',
    )
    .eq('venue_id', venueId)
  if (filters.axis) q = q.eq('axis', filters.axis)
  if (filters.status) q = q.eq('status', filters.status)
  if (filters.minMagnitude !== undefined && filters.minMagnitude > 0) {
    q = q.gte('magnitude_score', filters.minMagnitude)
  }
  q = q
    .order('magnitude_score', { ascending: false, nullsFirst: false })
    .order('last_observed_at', { ascending: false })
    .range(offset, offset + limit)
  const { data, error } = await q
  if (error) throw new Error(`listDisagreements: ${error.message}`)
  const all = (data ?? []) as unknown as DisagreementFindingRow[]
  const hasMore = all.length > limit
  const rows = hasMore ? all.slice(0, limit) : all
  return { rows, hasMore }
}
