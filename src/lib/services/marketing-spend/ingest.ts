/**
 * Wave 6A — marketing-spend ingestion core.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 6 closes the forensic loop)
 *   - bloom-wave4-5-6-master-plan.md (Wave 6A: spend ingestion +
 *     persona overlay)
 *
 * What this module does
 * ---------------------
 * Insert ONE spend row into marketing_spend_records, scoped per venue.
 * Idempotent via the unique constraint (venue_id, channel,
 * COALESCE(campaign_id, ''), spend_date) — re-running a connector for
 * the same campaign + day is a no-op.
 *
 * Why a thin core service
 * -----------------------
 * Connectors (manual / google-ads / meta-ads / tiktok / theknot) all
 * land their rows through this single function so:
 *   - the unique-constraint contract is in one place,
 *   - cents conversion is in one place,
 *   - source_platform_metadata is stored verbatim from any caller,
 *   - cost / observability instrumentation lands in one place when
 *     6A2 wires it up.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecordSpendInput {
  venueId: string
  /** Free-text channel id. google_ads | meta_ads | tiktok_ads |
   *  theknot_fee | weddingwire_fee | organic_seo | vendor_referral |
   *  other. */
  channel: string
  /** Platform-specific id. NULL for manual / fee entries. */
  campaignId?: string | null
  campaignName?: string | null
  /** ISO date string (YYYY-MM-DD) of when the spend occurred. */
  spendDate: string
  /** Spend in cents. Float not allowed — caller converts. */
  amountCents: number
  currency?: string
  /** Raw connector payload. Stored verbatim. */
  sourcePayload?: Record<string, unknown>
  /** Free-text label for which writer landed this row. */
  ingestedBy: string
  /** Wave 6E. Optional FK to marketing_agencies. When set, tags this
   *  spend row to the agency for ROI rollups. NULL = unattributed
   *  (direct spend or in-house). */
  agencyId?: string | null
  /** Optional client override. Defaults to service-role. */
  supabase?: SupabaseClient
}

export type RecordSpendResult =
  | { ok: true; inserted: true; id: string }
  | { ok: true; inserted: false; reason: 'duplicate' }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const VALID_CHANNELS = new Set([
  'google_ads',
  'meta_ads',
  'tiktok_ads',
  'theknot_fee',
  'weddingwire_fee',
  'organic_seo',
  'vendor_referral',
  'other',
])

/**
 * Public: returns true if the channel string is one of the canonical
 * Wave 6A channels. Free-text-friendly — callers may still pass any
 * string (e.g. "hitched_uk") and recordSpend will accept it. The set
 * exists for UI dropdown population, not server-side gating.
 */
export function isCanonicalChannel(channel: string): boolean {
  return VALID_CHANNELS.has(channel)
}

export const CANONICAL_CHANNELS = Array.from(VALID_CHANNELS)

function validateInput(input: RecordSpendInput): string | null {
  if (!input.venueId || typeof input.venueId !== 'string') {
    return 'venueId required'
  }
  if (!input.channel || typeof input.channel !== 'string') {
    return 'channel required'
  }
  if (!input.spendDate || typeof input.spendDate !== 'string') {
    return 'spendDate required (YYYY-MM-DD)'
  }
  if (!ISO_DATE_RE.test(input.spendDate)) {
    return 'spendDate must be YYYY-MM-DD'
  }
  if (
    !Number.isFinite(input.amountCents) ||
    !Number.isInteger(input.amountCents) ||
    input.amountCents < 0
  ) {
    return 'amountCents must be non-negative integer'
  }
  if (!input.ingestedBy || typeof input.ingestedBy !== 'string') {
    return 'ingestedBy required'
  }
  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a spend row into marketing_spend_records. Idempotent —
 * duplicate (venue, channel, campaign, date) is a no-op via the
 * unique constraint.
 */
export async function recordSpend(
  input: RecordSpendInput,
): Promise<RecordSpendResult> {
  const err = validateInput(input)
  if (err) return { ok: false, error: err }

  const supabase = input.supabase ?? createServiceClient()
  const payload = {
    venue_id: input.venueId,
    channel: input.channel.trim().toLowerCase(),
    campaign_id: input.campaignId ?? null,
    campaign_name: input.campaignName ?? null,
    spend_date: input.spendDate,
    amount_cents: input.amountCents,
    currency: (input.currency ?? 'USD').toUpperCase(),
    source_platform_metadata: input.sourcePayload ?? {},
    ingested_by: input.ingestedBy,
    agency_id: input.agencyId ?? null,
  }

  // Insert with conflict detection on the unique constraint. PostgREST
  // returns the inserted row in a single round trip; on a duplicate we
  // hit the unique-violation error code and return inserted=false.
  const { data, error } = await supabase
    .from('marketing_spend_records')
    .insert(payload)
    .select('id')
    .single()

  if (error) {
    // 23505 = unique_violation (Postgres). The unique index on
    // (venue, channel, COALESCE(campaign_id, ''), spend_date) catches
    // duplicate ingestion. Treat as idempotent no-op.
    if ((error as { code?: string }).code === '23505') {
      return { ok: true, inserted: false, reason: 'duplicate' }
    }
    return { ok: false, error: error.message }
  }

  return {
    ok: true,
    inserted: true,
    id: (data as { id: string }).id,
  }
}

/**
 * Bulk variant: walk a batch and insert each row idempotently. Returns
 * counts so connectors can report progress.
 */
export async function recordSpendBatch(
  rows: RecordSpendInput[],
): Promise<{
  ok: true
  inserted: number
  duplicates: number
  errors: Array<{ row: number; error: string }>
}> {
  const result = {
    ok: true as const,
    inserted: 0,
    duplicates: 0,
    errors: [] as Array<{ row: number; error: string }>,
  }
  for (let i = 0; i < rows.length; i++) {
    const r = await recordSpend(rows[i])
    if (!r.ok) {
      result.errors.push({ row: i, error: r.error })
      continue
    }
    if (r.inserted) result.inserted += 1
    else result.duplicates += 1
  }
  return result
}
