/**
 * mint-wedding — the single canonical writer for creating (or attaching to)
 * a wedding from any entry path.
 *
 * Why this exists
 * ---------------
 * Audit IDENTITY-RESOLUTION-AUDIT-2026-05-12.md F5 catalogued 8 places that
 * `INSERT INTO weddings` directly: email/pipeline, crm-import, the resolver
 * itself, data-import, reprocess-form-relays, reprocess-orphans,
 * brain-dump/imports, and a portal admin page. Each one re-implemented
 * person + wedding shaping with a slightly different default set. Two of
 * them skipped the match chain entirely, which is the bug class that bit
 * Reem Ibrahim (3 weddings minted for the same couple on 2026-05-08).
 *
 * `mintWedding` is the chokepoint that everyone migrates to. It does NOT
 * re-implement identity matching — it routes through the existing
 * resolver writer at `identity/resolver.ts:resolveIdentity` (line 732),
 * which already owns the full match chain (email exact → canonical →
 * phone → name+date → create). All this helper does is:
 *
 *   1. Normalise the caller's free-form signals into the resolver's
 *      `IdentitySignals` shape.
 *   2. Delegate to `resolveIdentity` (the writer).
 *   3. Fire the P2 identity cascade (`triggerIdentityCascade`) fire-and-
 *      forget on the returned weddingId so pre-zero signals get bound the
 *      moment we know who the couple is.
 *   4. Emit a structured `identity.mint_wedding` event for telemetry.
 *
 * For THIS round, the 8 direct-INSERT call sites are NOT migrated. That's
 * the next sweep (see docs/IDENTITY-CHOKEPOINT-MIGRATION.md). New callers
 * MUST use this helper; existing inline writes get caught by the
 * `scripts/check-no-direct-wedding-insert.mjs` guard which fails CI on
 * any new `.from('weddings').insert(` outside the canonical paths.
 *
 * Constitution anchor: bloom-constitution.md — Point-Zero doctrine says
 * pre-zero signals are attribution credit. The cascade-fire at the end is
 * what makes them credit-able the instant identity binding becomes
 * possible.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveIdentity } from './resolver'
import { logEvent } from '@/lib/observability/logger'

/**
 * Free-text source label used for telemetry + the wedding's notes column.
 * String literal union (rather than a runtime enum) so callers don't have
 * to import a constant. Add new values here as new entry paths come
 * online; the resolver's `pickNameSourceForLabel` already normalises
 * substrings of these into its enum so adding a value is safe.
 */
export type WeddingSource =
  | 'email_pipeline'
  | 'sms_inbound'
  | 'csv_import'
  | 'brain_dump'
  | 'web_form'
  | 'portal_ui'
  | 'twilio_webhook'
  | 'calculator'
  | 'crm_import'
  | 'reprocess_orphans'
  | 'reprocess_form_relays'
  | 'manual_admin'

export interface MintWeddingSignals {
  email?: string | null
  phone?: string | null
  /** The single human's full name (display form). Resolver prefers this
   *  over partner1/partner2 when both are absent. */
  fullName?: string | null
  partner1Name?: string | null
  partner2Name?: string | null
  /** ISO yyyy-mm-dd preferred. */
  weddingDate?: string | null
  /** ISO timestamp of the inbound signal (email Date header, CSV row
   *  inquiry_date, brain-dump captured_at). Threaded through to the
   *  resolver so inquiry_date is pinned to the real signal time rather
   *  than wall-clock NOW(). Closes the inquiry_date_drift invariant. */
  inquiryDate?: string | null
  /** Optional headcount captured on the inquiry. Currently advisory;
   *  the resolver does not stamp this on the wedding row. Listed in the
   *  interface so call sites can stop dropping it on the floor. */
  guestCount?: number | null
}

export interface MintWeddingInput {
  venueId: string
  source: WeddingSource
  signals: MintWeddingSignals
  /** Free-text label for telemetry. Defaults to `source` when omitted. */
  reason?: string
  /** Optional pre-existing service client. Avoids an extra factory call
   *  when the caller already holds one. */
  supabase?: SupabaseClient
  /** Threads through resolver audit + cascade telemetry so this mint
   *  joins the originating inbound event's lineage. */
  correlationId?: string | null
}

export interface MintWeddingResult {
  weddingId: string
  personId: string
  isNew: boolean
  /** Which step in the match chain fired. Mirrors
   *  `ResolvedIdentity.matchedBy` from the resolver. */
  resolvedVia:
    | 'email_exact'
    | 'email_canonical'
    | 'phone'
    | 'name_plus_date'
    | 'created_new'
}

/**
 * Mint or attach a wedding for one inbound identity signal.
 *
 * Never throws — except when the resolver itself can't produce a row
 * (createPerson + createWedding both failed). Callers should treat
 * those as fatal: there's no useful fallback because every downstream
 * write needs a weddingId.
 */
export async function mintWedding(
  input: MintWeddingInput,
): Promise<MintWeddingResult> {
  const { venueId, source, signals, reason, supabase, correlationId } = input
  const started = Date.now()

  // Delegate to the existing resolver writer. It owns the full match
  // chain + the createPerson + createWedding paths + the cascade
  // recurrence logic for re-engagement-after-loss. We do NOT
  // re-implement any of that here.
  const resolved = await resolveIdentity(
    venueId,
    {
      email: signals.email ?? null,
      phone: signals.phone ?? null,
      fullName: signals.fullName ?? signals.partner1Name ?? null,
      weddingDate: signals.weddingDate ?? null,
      partner1Name: signals.partner1Name ?? null,
      partner2Name: signals.partner2Name ?? null,
    },
    {
      sourceLabel: source,
      correlationId: correlationId ?? undefined,
      supabase,
      inquirySignalAt: signals.inquiryDate ?? undefined,
    },
  )

  // Fire the P2 identity cascade on the resolved wedding. The cascade
  // scans candidate_identities + tangential_signals for pre-zero
  // anonymous signals that now bind to this couple (Knot relay
  // inquiry from 3 weeks ago, an IG handle that matches the same
  // email, etc). Always fire-and-forget — never block the caller on a
  // cascade tick (it can take seconds).
  //
  // Dynamic import keeps the cascade out of the cold-path bundle when
  // mintWedding is loaded by a route that never fires it (the guard
  // script + the migration doc don't need the cascade module).
  void (async () => {
    try {
      const { triggerIdentityCascade } = await import('./cascade-on-enrichment')
      // The cascade requires a SupabaseClient; reuse the caller's if
      // provided, otherwise mint a fresh service client. The cascade
      // is server-side only (cron-ish) so a service client is fine.
      const cascadeClient =
        supabase ??
        (await import('@/lib/supabase/service')).createServiceClient()
      await triggerIdentityCascade({
        venueId,
        weddingId: resolved.weddingId,
        supabase: cascadeClient,
        reason: `mint_wedding:${reason ?? source}`,
        correlationId: correlationId ?? null,
      })
    } catch (err) {
      // Best-effort — never block the mint on cascade failure. The
      // daily identity_cascade_sweep cron is the safety net.
      logEvent({
        level: 'warn',
        msg: 'identity.mint_wedding.cascade_failed',
        venueId,
        correlationId: correlationId ?? null,
        actor: 'system',
        event_type: 'identity.mint_wedding',
        outcome: 'fail',
        data: {
          wedding_id: resolved.weddingId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  })()

  logEvent({
    level: 'info',
    msg: 'identity.mint_wedding',
    venueId,
    correlationId: correlationId ?? null,
    actor: 'system',
    event_type: 'identity.mint_wedding',
    outcome: 'ok',
    latency_ms: Date.now() - started,
    data: {
      wedding_id: resolved.weddingId,
      person_id: resolved.personId,
      is_new_person: resolved.isNew.person,
      is_new_wedding: resolved.isNew.wedding,
      resolved_via: resolved.matchedBy,
      source,
      reason: reason ?? source,
    },
  })

  return {
    weddingId: resolved.weddingId,
    personId: resolved.personId,
    // isNew here means "a wedding was created during this call" — the
    // most useful boolean for callers deciding whether to fire
    // first-touch attribution / draft / autoreply.
    isNew: resolved.isNew.wedding,
    resolvedVia: resolved.matchedBy,
  }
}
