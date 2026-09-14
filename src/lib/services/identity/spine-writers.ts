/**
 * Spine write primitives.
 *
 * The shared matcher and insert helpers the cascade is built out of:
 * `insertTouchpoint`, `insertFragment`, `insertCandidateMatch`,
 * `loadRecentCouples`, and the two record-shaping functions the matcher
 * scores against. Every one of them is called from inside the cascade —
 * `forwards-linker.ts` (linkSignal), `route-by-tier.ts`,
 * `agent-link.ts`, `fragment-sweep.ts`, `handle-convergence.ts`,
 * `knot-visitor-match.ts` — and by nothing outside it. That is why
 * `check-cascade-only-writer.mjs` lists this file as a chokepoint: it is
 * where the spine's INSERTs physically live.
 *
 * Naming (W68, wave 9): this file was called `tracer.ts` until now,
 * after the Phase B Backwards Tracer — a batch orchestrator that wave 3
 * (W26, HANDLE-IDENTITY-SPEC.md §5) retired. Its stages went to
 * `fragment-sweep.ts` (the cross-channel coalesce), to ingestion (W20's
 * agent-class detection), to the `heat_decay` cron (`decayStaleCouples`),
 * or nowhere (the run-lifecycle telemetry), and `tracer-runner.ts` was
 * deleted. W26 kept the filename only so the six importers did not need
 * touching in the same commit. A file named after a thing that no longer
 * exists teaches every reader the wrong shape of the system, so the name
 * now says what the file is.
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
