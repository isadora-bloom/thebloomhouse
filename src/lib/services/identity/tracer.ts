/**
 * Spine write primitives (Phase B Backwards Tracer retired 2026-09).
 *
 * HISTORY: this file used to be the "Phase B Backwards Tracer" — a
 * batch orchestrator with five stages (anchor_discovery,
 * cross_channel_coalesce, agent_infer, decay_sweep, validate) driven
 * by tracer-runner.ts and dispatched from the nightly cron. Wave 3
 * of NOVEMBER-PLAN.md (HANDLE-IDENTITY-SPEC.md §5) retired it:
 *
 *   - cross_channel_coalesce moved to `fragment-sweep.ts`, under the
 *     nightly fragment sweep (`sweepFragmentsForVenue`). Same audit
 *     rows, same score threshold. See that file's header.
 *   - agent_infer is dead: agent-class detection now happens at
 *     ingestion (Wave 2 W20 — HoneyBook parents/planners minted as
 *     Agent-class people directly, not inferred after the fact from
 *     shared emails across wedding dates).
 *   - decay_sweep is dead: it only ever called `decayStaleCouples`
 *     (decay.ts) and wrapped the call in tracer_run_events telemetry.
 *     The daily `heat_decay` cron already calls `decayStaleCouples`
 *     directly via `runDecaySweepAllVenues`, so nothing was lost.
 *   - anchor_discovery / validate were telemetry-only bookkeeping for
 *     the orchestrator's own run lifecycle (cold-start detection,
 *     end-of-run counts). No other consumer read them directly; they
 *     went with the orchestrator.
 *   - tracer-runner.ts (the cron entry, the auto-trigger queue on
 *     `venues.identity_tracer_requested_at`, and the operator "Run
 *     now" trigger) is deleted outright.
 *
 * WHAT REMAINS: the shared matcher/insert primitives below. These
 * were always doctrinally separate from the orchestrator — the code
 * comment used to say so explicitly ("these helpers were the
 * touchpoint_sweep's matcher/insert primitives... linkSignal and
 * applyTierRouting still import them"). The Forwards Linker
 * (`forwards-linker.ts`) and tier router (`route-by-tier.ts`) are
 * both live chokepoints per `check-cascade-only-writer.mjs` and both
 * import from this file, as do `agent-link.ts` and
 * `knot-visitor-match.ts`. Kept at this same path/filename
 * specifically so none of those four files needed an import-path
 * change as part of the Wave 3 retirement — they belong to other
 * workstreams / are out-of-scope call sites, not mine to edit for a
 * cosmetic rename. `fragment-sweep.ts` imports `insertCandidateMatch`
 * from here too.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { type MatchableRecord } from './matcher'
import { logEvent } from '@/lib/observability/logger'
import type { NormalizedSignal, HandlePlatform } from './sources'

// ---------------------------------------------------------------------------
// Shared matcher plumbing (consumed by route-by-tier + forwards-linker)
// ---------------------------------------------------------------------------

export interface CoupleForMatch {
  id: string
  primary_name: string | null
  primary_email: string | null
  primary_phone: string | null
  partner_name: string | null
  partner_email: string | null
  partner_phone: string | null
  wedding_date: string | null
  source_wedding_id: string | null
  /** Wave 3 (migration 398): the couple's platform handle map, and the
   *  merge tombstone. Both feed cascade stage 1d, which will only match a
   *  live couple. */
  handles: Partial<Record<HandlePlatform, string>> | null
  merged_into_id: string | null
}

export function signalToMatchableRecord(s: NormalizedSignal): MatchableRecord {
  return {
    id: s.external_id,
    primary_name: s.primary_name ?? s.identity_hint ?? null,
    partner_name: s.partner_name ?? null,
    primary_email: s.primary_email ?? null,
    partner_email: s.partner_email ?? null,
    primary_phone: s.primary_phone ?? null,
    partner_phone: s.partner_phone ?? null,
    wedding_date: s.wedding_date ?? null,
    observed_at: s.occurred_at,
    session_ip: s.session_ip ?? null,
    session_fingerprint: s.session_fingerprint ?? null,
    // Wave 3: carry the signal's handles into the matcher so cascade
    // stage 1d and the handle weight can see them.
    handles: s.handles ?? null,
  }
}

export function coupleToMatchableRecord(c: CoupleForMatch): MatchableRecord {
  return {
    id: c.id,
    primary_name: c.primary_name,
    partner_name: c.partner_name,
    primary_email: c.primary_email,
    partner_email: c.partner_email,
    primary_phone: c.primary_phone,
    partner_phone: c.partner_phone,
    wedding_date: c.wedding_date,
    handles: c.handles,
    merged_into_id: c.merged_into_id,
  }
}

export async function findCoupleForLegacyWedding(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('couples')
    .select('id')
    .eq('venue_id', venueId)
    .eq('source_wedding_id', weddingId)
    .maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

export async function insertTouchpoint(
  supabase: SupabaseClient,
  venueId: string,
  coupleId: string | null,
  signal: NormalizedSignal,
): Promise<{ inserted: boolean; touchpoint_id: string | null }> {
  // ON CONFLICT(venue_id, channel, external_id) DO NOTHING via insert
  // + 23505 backstop. supabase-js doesn't expose ON CONFLICT NOTHING
  // when there's no upsert payload, so we use the error-code path.
  const { data, error } = await supabase
    .from('touchpoints')
    .insert({
      venue_id: venueId,
      couple_id: coupleId,
      agent_id: null,
      channel: signal.channel,
      signal_tier: signal.signal_tier,
      action_type: signal.action_type,
      external_id: signal.external_id,
      occurred_at: signal.occurred_at,
      confidence_tier: null,
      raw_payload: signal.raw_payload,
    })
    .select('id')
    .maybeSingle()
  if (error) {
    if (error.code === '23505') return { inserted: false, touchpoint_id: null }
    throw new Error(`touchpoints.insert: ${error.message}`)
  }
  return { inserted: true, touchpoint_id: (data as { id: string } | null)?.id ?? null }
}

export async function insertFragment(
  supabase: SupabaseClient,
  venueId: string,
  signal: NormalizedSignal,
): Promise<{ inserted: boolean }> {
  const { error } = await supabase.from('fragments').insert({
    venue_id: venueId,
    channel: signal.channel,
    identity_hint: signal.identity_hint,
    external_id: signal.external_id,
    occurred_at: signal.occurred_at,
    raw_payload: signal.raw_payload,
    // Wave 3 (migration 398): a pre-identity fragment keeps the handles it
    // arrived with, so a later signal carrying the same (platform, handle)
    // can promote it deterministically. See fragment-sweep.ts.
    handles: signal.handles ?? {},
  })
  if (error) {
    if (error.code === '23505') return { inserted: false }
    throw new Error(`fragments.insert: ${error.message}`)
  }
  return { inserted: true }
}

export async function insertCandidateMatch(
  supabase: SupabaseClient,
  venueId: string,
  primaryId: string,
  primaryType: 'couple' | 'fragment' | 'channel_scoped' | 'touchpoint',
  secondaryId: string,
  secondaryType: 'couple' | 'fragment' | 'channel_scoped' | 'touchpoint',
  confidence_tier: 'high' | 'medium' | 'low',
  reason: string,
): Promise<void> {
  const { error } = await supabase.from('candidate_matches').insert({
    venue_id: venueId,
    primary_record_id: primaryId,
    primary_record_type: primaryType,
    secondary_record_id: secondaryId,
    secondary_record_type: secondaryType,
    confidence_tier,
    matcher_reason: reason,
  })
  if (error && error.code !== '23505') {
    logEvent({
      level: 'warn',
      msg: 'spine_write.candidate_match_insert_failed',
      venueId,
      data: { primary: primaryId, secondary: secondaryId, error: error.message },
    })
  }
}

export async function loadRecentCouples(
  supabase: SupabaseClient,
  venueId: string,
): Promise<CoupleForMatch[]> {
  // Bounded read: 2000 most recent couples for the venue. Doctrine
  // canonical columns (migration 346): primary_contact_name +
  // primary_contact_email + primary_contact_phone + partner_contact_*.
  const { data } = await supabase
    .from('couples')
    .select(
      'id, primary_contact_name, primary_contact_email, primary_contact_phone, partner_contact_name, partner_contact_email, partner_contact_phone, wedding_date, source_wedding_id, handles, merged_into_id',
    )
    .eq('venue_id', venueId)
    .order('updated_at', { ascending: false })
    .limit(2000)
  type Row = {
    id: string
    primary_contact_name: string | null
    primary_contact_email: string | null
    primary_contact_phone: string | null
    partner_contact_name: string | null
    partner_contact_email: string | null
    partner_contact_phone: string | null
    wedding_date: string | null
    source_wedding_id: string | null
    handles: Partial<Record<HandlePlatform, string>> | null
    merged_into_id: string | null
  }
  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    primary_name: r.primary_contact_name,
    primary_email: r.primary_contact_email,
    primary_phone: r.primary_contact_phone,
    partner_name: r.partner_contact_name,
    partner_email: r.partner_contact_email,
    partner_phone: r.partner_contact_phone,
    wedding_date: r.wedding_date,
    source_wedding_id: r.source_wedding_id,
    handles: r.handles ?? null,
    merged_into_id: r.merged_into_id ?? null,
  }))
}
