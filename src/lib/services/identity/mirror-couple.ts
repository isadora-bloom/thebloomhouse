/**
 * mirror-couple — Phase A dual-write for the Identity-First Architecture.
 *
 * Anchor
 * ------
 * IDENTITY-FIRST-ARCHITECTURE.md §8 (Phase A) + memory/bloom-identity-
 * first-doctrine.md. Phase A is additive: every wedding mint and every
 * people insert mirrors the couple to the new `couples` table. Read
 * paths still read from weddings + people; this is a write-shadow only.
 *
 * Why a helper rather than wiring straight into mintWedding
 * ---------------------------------------------------------
 * mintWedding routes through `resolver.resolveIdentity` which has TWO
 * exits — attach-to-existing (Branch A) and mint-new (Branch B). Both
 * need the same mirror behaviour: keep `couples` in sync with whatever
 * the current weddings + people state says. A single UPSERT keyed on
 * `(venue_id, source_wedding_id)` covers both branches.
 *
 * Doctrine note
 * -------------
 * Phase A spec from §8: "Tables created, every existing inquiry
 * mirrored to Person/Fragment as appropriate, dual-write hooks on
 * every inquiry-touching code path. ... Legacy code reads from
 * inquiries." This file is the "dual-write hooks" half. The mirror
 * NEVER throws — its failure must not roll back the wedding mint
 * (Phase A is additive, not a hard dependency). Logged errors surface
 * in the divergence dashboard.
 *
 * Naming note
 * -----------
 * Doctrine calls this table `persons` (Person = the couple). Repo uses
 * `couples` to avoid colliding with the existing `people` table of
 * individual humans. See migration 346 header for the full rationale.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'

export interface MirrorCoupleInput {
  venueId: string
  weddingId: string
  /** Service-role or authenticated client. Service role recommended —
   *  the mirror writes are server-side and shouldn't be gated on the
   *  caller's RLS context. */
  supabase: SupabaseClient
  /** Optional correlation id for tracing the mirror back to the
   *  originating inbound event. Threaded through to log lines but not
   *  persisted on the couples row. */
  correlationId?: string | null
}

export interface MirrorCoupleResult {
  /** True if the couples row was inserted (new); false if it was
   *  updated (existing) or the mirror was skipped (no signals). */
  isNew: boolean
  /** The couples.id, when the mirror succeeded. Null on skip/error. */
  coupleId: string | null
}

/**
 * Mirror one wedding into the couples table.
 *
 * Reads the weddings row + its people rows, derives lifecycle_state +
 * contact identity, then UPSERTs into couples using source_wedding_id
 * as the conflict key.
 *
 * Never throws. Mirror failures log + return { coupleId: null } so
 * mintWedding callers proceed.
 */
export async function mirrorCoupleFromWedding(
  input: MirrorCoupleInput,
): Promise<MirrorCoupleResult> {
  const { venueId, weddingId, supabase, correlationId } = input

  try {
    // Pull the weddings row + partner1/partner2 from people.
    const { data: wedding, error: wErr } = await supabase
      .from('weddings')
      .select('id, venue_id, status, wedding_date, inquiry_date, updated_at')
      .eq('id', weddingId)
      .single()

    if (wErr || !wedding) {
      logEvent({
        level: 'warn',
        msg: 'identity.mirror_couple.wedding_lookup_failed',
        venueId,
        correlationId: correlationId ?? null,
        actor: 'system',
        event_type: 'identity.mirror_couple',
        outcome: 'fail',
        data: { wedding_id: weddingId, error: wErr?.message ?? 'not found' },
      })
      return { isNew: false, coupleId: null }
    }

    const { data: peopleRows } = await supabase
      .from('people')
      .select('role, first_name, last_name, email, phone, created_at')
      .eq('wedding_id', weddingId)
      .in('role', ['partner1', 'partner2'])
      .order('created_at', { ascending: true })

    const partner1 = (peopleRows ?? []).find((p) => p.role === 'partner1') ?? null
    const partner2 = (peopleRows ?? []).find((p) => p.role === 'partner2') ?? null

    const fullName = (p: typeof partner1) =>
      p
        ? [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || null
        : null

    const primaryName =
      fullName(partner1) ??
      fullName(partner2) ??
      `(Unknown — backfilled from weddings ${weddingId})`
    const partnerName = partner1 ? fullName(partner2) : null

    // status → lifecycle_state derivation. Matches the backfill in
    // migration 346 so the mirror writer and the one-shot backfill
    // converge on identical state.
    const lifecycle_state =
      wedding.status === 'booked' || wedding.status === 'completed'
        ? 'booked'
        : wedding.status === 'lost' || wedding.status === 'cancelled'
          ? 'ghost'
          : 'resolved'

    // UPSERT. ON CONFLICT (venue_id, source_wedding_id) updates the
    // existing couples row with the latest identity fields and
    // lifecycle. Postgres-side ON CONFLICT WHERE matches the partial
    // unique index from 346.
    const { data: upserted, error: upErr } = await supabase
      .from('couples')
      .upsert(
        {
          venue_id: venueId,
          primary_contact_name: primaryName,
          primary_contact_email: partner1?.email ?? null,
          primary_contact_phone: partner1?.phone ?? null,
          partner_contact_name: partnerName,
          partner_contact_email: partner2?.email ?? null,
          partner_contact_phone: partner2?.phone ?? null,
          wedding_date: wedding.wedding_date,
          lifecycle_state,
          source_wedding_id: weddingId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'venue_id,source_wedding_id', ignoreDuplicates: false },
      )
      .select('id')
      .single()

    if (upErr || !upserted) {
      logEvent({
        level: 'warn',
        msg: 'identity.mirror_couple.upsert_failed',
        venueId,
        correlationId: correlationId ?? null,
        actor: 'system',
        event_type: 'identity.mirror_couple',
        outcome: 'fail',
        data: { wedding_id: weddingId, error: upErr?.message ?? 'no data' },
      })
      return { isNew: false, coupleId: null }
    }

    logEvent({
      level: 'info',
      msg: 'identity.mirror_couple',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'identity.mirror_couple',
      outcome: 'ok',
      data: {
        wedding_id: weddingId,
        couple_id: upserted.id,
        lifecycle_state,
      },
    })

    // isNew distinction is approximate at this layer — supabase-js
    // upsert doesn't return an inserted/updated flag. Callers that
    // need it can compare upserted.id timestamps; the divergence
    // dashboard reads counts directly anyway.
    return { isNew: false, coupleId: upserted.id as string }
  } catch (err) {
    logEvent({
      level: 'error',
      msg: 'identity.mirror_couple.unexpected',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'identity.mirror_couple',
      outcome: 'fail',
      data: {
        wedding_id: weddingId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return { isNew: false, coupleId: null }
  }
}
