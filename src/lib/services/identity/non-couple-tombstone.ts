/**
 * Non-couple wedding tombstone sweep.
 *
 * Anchor: bloom-identity-resolution-doctrine.md (Step 5c, RM-1123).
 *
 * Purpose
 * -------
 * Soft-tombstone weddings that are not real couples. The canonical
 * RM-1123 case is a bus driver SMS that minted a ghost wedding before
 * Step 5b shipped the intent gate; the legacy cohort at Rixey is ~292
 * weddings, most of which look like vendor messages, autoreplies, or
 * coordinator-internal chatter.
 *
 * Design
 * ------
 * Each Unknown wedding has at least one interactions row. The Wave 28
 * intent classifier (mig 327) writes interactions.intent_class on every
 * inbound message. This sweep rolls up the intent_class distribution
 * per wedding and decides whether to tombstone:
 *
 *   - tombstone when ALL inbound intent_classes are in NON_COUPLE
 *     AND at least one is in HIGH_CONFIDENCE_NON_COUPLE
 *     (vendor_communication, vendor_outreach, spam_outreach,
 *     auto_reply, coordinator_internal)
 *
 *   - do NOT tombstone when ANY inbound is in COUPLE_INTENTS
 *     (new_inquiry, inquiry_followup, client_emotional,
 *     family_member_proxy)
 *
 *   - do NOT tombstone when the thread is all 'unknown' or
 *     'client_logistics' — uncertain signal; leave alone for now
 *
 *   - skip booked / completed weddings entirely (operator confirmed
 *     the couple even if the name extraction failed)
 *
 * This is DETERMINISTIC. No LLM call. The classifier already ran on
 * every inbound; we just aggregate.
 *
 * Idempotent: rows with non_couple_at already set are skipped.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

interface SweepResult {
  scanned: number
  tombstoned: number
  skipped_couple_signal: number
  skipped_uncertain: number
  skipped_no_intent: number
  errors: string[]
}

// Intent classes that constitute strong evidence this isn't a couple.
// Aligned with NON_COUPLE_INTENTS in inbound-intent-classifier.ts but
// trimmed to the high-confidence subset — client_logistics is excluded
// because post-booking logistics chatter is sometimes from a couple
// (Anja-class), and we don't want to false-positive tombstone real
// weddings whose only post-booking signal was logistics.
const HIGH_CONFIDENCE_NON_COUPLE = new Set([
  'vendor_communication',
  'vendor_outreach',
  'spam_outreach',
  'auto_reply',
  'coordinator_internal',
])

// Intents that indicate a real couple wedding. Presence of ANY of these
// short-circuits the tombstone decision.
const COUPLE_INTENTS = new Set([
  'new_inquiry',
  'inquiry_followup',
  'client_emotional',
  'family_member_proxy',
])

// Booked / completed weddings get the benefit of the doubt — the
// coordinator has confirmed the couple even if name extraction failed.
const PROTECTED_STATUSES = new Set([
  'booked',
  'completed',
])

interface UnknownWedding {
  id: string
  venue_id: string
  status: string | null
}

interface IntentRow {
  wedding_id: string
  intent_class: string | null
  direction: string | null
}

/**
 * Run the tombstone sweep over a single venue. Returns counts.
 *
 * The sweep is bounded — it scans up to `limit` Unknown weddings per
 * call. Wire-able into a cron with a small budget and an optional
 * pagination cursor; for now the daily prune_maintenance run handles
 * the typical venue-level volume in one tick.
 */
export async function tombstoneNonCouples(
  venueId: string,
  options: { supabase?: SupabaseClient; limit?: number } = {},
): Promise<SweepResult> {
  const supabase = options.supabase ?? createServiceClient()
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000)

  const result: SweepResult = {
    scanned: 0,
    tombstoned: 0,
    skipped_couple_signal: 0,
    skipped_uncertain: 0,
    skipped_no_intent: 0,
    errors: [],
  }

  // 1. Pull candidate weddings: Unknown (no partner1 name OR (Unknown)
  // marker) and not yet tombstoned and not booked/completed.
  // The two-step query (weddings → people for partner1 first_name) is
  // simpler than a Postgres function — venue volume is in the low
  // hundreds, so the per-row people lookup stays well under timeout.
  const { data: weddingsRaw, error: wedErr } = await supabase
    .from('weddings')
    .select('id, venue_id, status')
    .eq('venue_id', venueId)
    .is('non_couple_at', null)
    .is('merged_into_id', null)
    .not('status', 'in', `(${Array.from(PROTECTED_STATUSES).map((s) => `"${s}"`).join(',')})`)
    .limit(limit)
  if (wedErr) {
    result.errors.push(`weddings read: ${wedErr.message}`)
    return result
  }
  const weddings = (weddingsRaw ?? []) as UnknownWedding[]
  if (weddings.length === 0) return result

  // 2. For each, fetch partner1 first_name to decide "is this Unknown".
  // We could add this as a join but the people FK direction makes the
  // join awkward; per-wedding lookups are clearer.
  const candidateIds: string[] = []
  for (const w of weddings) {
    const { data: p1Rows } = await supabase
      .from('people')
      .select('first_name')
      .eq('wedding_id', w.id)
      .eq('role', 'partner1')
      .is('merged_into_id', null)
      .limit(1)
    const first = p1Rows?.[0]?.first_name as string | null | undefined
    const isUnknown = !first || first === '(Unknown)' || first === ''
    if (isUnknown) candidateIds.push(w.id)
  }
  if (candidateIds.length === 0) return result

  // 3. Pull all inbound interactions for the candidate weddings in one
  // shot. intent_class is on interactions (mig 327).
  const { data: intentRowsRaw, error: intentErr } = await supabase
    .from('interactions')
    .select('wedding_id, intent_class, direction')
    .in('wedding_id', candidateIds)
    .eq('direction', 'inbound')
    .limit(10000)
  if (intentErr) {
    result.errors.push(`interactions read: ${intentErr.message}`)
    return result
  }
  const intentRows = (intentRowsRaw ?? []) as IntentRow[]

  // 4. Group by wedding_id and decide.
  const intentsByWedding = new Map<string, string[]>()
  for (const row of intentRows) {
    if (!row.wedding_id) continue
    const list = intentsByWedding.get(row.wedding_id) ?? []
    if (row.intent_class) list.push(row.intent_class)
    intentsByWedding.set(row.wedding_id, list)
  }

  for (const weddingId of candidateIds) {
    result.scanned += 1
    const intents = intentsByWedding.get(weddingId) ?? []
    const classifiedIntents = intents.filter((i) => i && i !== 'unknown')

    if (classifiedIntents.length === 0) {
      // No classified inbound intent — too little signal to decide.
      // The classifier drain cron will catch up on these and a future
      // sweep can re-evaluate.
      result.skipped_no_intent += 1
      continue
    }

    const hasCoupleSignal = classifiedIntents.some((i) => COUPLE_INTENTS.has(i))
    if (hasCoupleSignal) {
      result.skipped_couple_signal += 1
      continue
    }

    const hasStrongNonCouple = classifiedIntents.some((i) =>
      HIGH_CONFIDENCE_NON_COUPLE.has(i),
    )
    if (!hasStrongNonCouple) {
      // Thread is all 'client_logistics' or similar — uncertain.
      // Leave alone; future signal may clarify.
      result.skipped_uncertain += 1
      continue
    }

    // Tombstone. The dominant intent class is the reason.
    const dominantClass =
      classifiedIntents.find((i) => HIGH_CONFIDENCE_NON_COUPLE.has(i)) ??
      classifiedIntents[0]

    const { error: updateErr } = await supabase
      .from('weddings')
      .update({
        non_couple_at: new Date().toISOString(),
        non_couple_reason: `intent:${dominantClass}`,
      })
      .eq('id', weddingId)
      .is('non_couple_at', null)
    if (updateErr) {
      result.errors.push(`tombstone ${weddingId}: ${updateErr.message}`)
      continue
    }
    result.tombstoned += 1
  }

  return result
}

/**
 * Multi-venue convenience wrapper for the prune_maintenance cron.
 */
export async function tombstoneNonCouplesAllVenues(options: {
  supabase?: SupabaseClient
  limitPerVenue?: number
} = {}): Promise<{
  total_scanned: number
  total_tombstoned: number
  per_venue: Array<{ venue_id: string; tombstoned: number; scanned: number }>
  errors: string[]
}> {
  const supabase = options.supabase ?? createServiceClient()
  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .limit(1000)
  if (error) {
    return {
      total_scanned: 0,
      total_tombstoned: 0,
      per_venue: [],
      errors: [`venues read: ${error.message}`],
    }
  }
  const result = {
    total_scanned: 0,
    total_tombstoned: 0,
    per_venue: [] as Array<{ venue_id: string; tombstoned: number; scanned: number }>,
    errors: [] as string[],
  }
  for (const v of venues ?? []) {
    const r = await tombstoneNonCouples(v.id as string, {
      supabase,
      limit: options.limitPerVenue ?? 500,
    })
    result.total_scanned += r.scanned
    result.total_tombstoned += r.tombstoned
    result.per_venue.push({
      venue_id: v.id as string,
      tombstoned: r.tombstoned,
      scanned: r.scanned,
    })
    result.errors.push(...r.errors)
  }
  return result
}
