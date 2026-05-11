/**
 * Bloom House — Wave 17 disagreement-surfacing shared types.
 *
 * Anchor docs:
 *   - bloom-constitution.md
 *   - feedback_self_reported_sources_not_truth.md (the doctrine —
 *     surfacing the gap > overwriting one side with the other)
 *
 * The types here are the wire-level shape every Wave 17 surface reads
 * and writes. The detector returns DisagreementCandidate (pre-write),
 * the upserter promotes those into DisagreementFindingRow (post-write).
 */

export type DisagreementAxis =
  | 'source'
  | 'wedding_date'
  | 'guest_count'
  | 'budget'
  | 'persona'
  | 'close_prediction'
  | 'name'
  | 'crm_source'
  | 'other'

export const ALL_AXES: readonly DisagreementAxis[] = [
  'source',
  'wedding_date',
  'guest_count',
  'budget',
  'persona',
  'close_prediction',
  'name',
  'crm_source',
  'other',
] as const

export type DisagreementStatus =
  | 'active'
  | 'resolved'
  | 'dismissed'
  | 'investigating'

/** What the detector returns BEFORE the upsert. */
export interface DisagreementCandidate {
  venueId: string
  weddingId: string
  axis: DisagreementAxis
  statedValue: unknown
  statedSourceKind: string | null
  forensicValue: unknown
  forensicSourceKind: string | null
  magnitudeScore: number | null
  confidence_0_100: number | null
}

/** Persisted row shape (selected for the dashboard + narrator). */
export interface DisagreementFindingRow {
  id: string
  venue_id: string
  wedding_id: string | null
  axis: DisagreementAxis
  stated_value: unknown
  stated_source_kind: string | null
  forensic_value: unknown
  forensic_source_kind: string | null
  magnitude_score: number | null
  confidence_0_100: number | null
  first_detected_at: string
  last_observed_at: string
  status: DisagreementStatus
  resolution_note: string | null
  resolved_at: string | null
  dismissed_at: string | null
  narrator_text: string | null
  narrator_generated_at: string | null
  narrator_prompt_version: string | null
  narrator_cost_cents: number | null
  created_at: string
  updated_at: string
}

/** Aggregate shape returned by /summary. */
export interface DisagreementSummary {
  venueId: string
  totals: Record<DisagreementStatus, number>
  byAxis: AxisBucket[]
  biggest: DisagreementFindingRow[]
}

export interface AxisBucket {
  axis: DisagreementAxis
  active: number
  resolved: number
  dismissed: number
  investigating: number
  total: number
}
