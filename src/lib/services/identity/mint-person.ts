/**
 * mintPerson — single chokepoint for creating people rows.
 *
 * Anchor: bloom-identity-resolution-doctrine.md (Step 5 / G3 + G6, 2026-05-13).
 *
 * Why this exists
 * ---------------
 * Bloom has historically had 8+ direct `.from('people').insert(...)`
 * sites and a parallel match-and-create primitive (`findOrCreateContact`
 * in email/pipeline.ts) that each re-implement slightly different
 * matching, name-capture, and self-loop guards. The wedding side got
 * its chokepoint (`mintWedding`) on 2026-05-12; this is the people-side
 * equivalent. Every NEW caller that needs to create a person MUST
 * route through here so the four invariants hold:
 *
 *   1. **Match-first.** Every mint runs the full resolver chain (email
 *      exact → email canonical → phone) before INSERT, so duplicate
 *      person rows for the same identity are impossible by construction.
 *   2. **Self-loop blocked.** A venue's own gmail / outbound address can
 *      never become a lead row. The check happens here, not in 8
 *      different places.
 *   3. **Name-capture chokepoint.** Names go through `name-capture.ts`
 *      shape-classification (username → display_handle, etc.), not
 *      raw `first_name = email.split('@')[0]` heuristics.
 *   4. **Source label preserved.** Every mint records WHO triggered it
 *      (email_pipeline / sms_pipeline / brain_dump / crm_import / etc.),
 *      so audit + telemetry have provenance.
 *
 * Contract
 * --------
 * - Single public function: `mintPerson({venueId, signals, source, ...})`.
 * - Returns `{personId, isNew, matchedBy}`.
 * - `personId: null` is possible: self-loop blocked, or resolver INSERT
 *   failed. Callers must handle null.
 * - Never throws. Internal resolver errors surface as `personId: null`
 *   with a logged warning.
 *
 * Today's grandfathered call sites (migrating over the coming sessions):
 *   - email/pipeline.ts findOrCreateContact (the G6 second primitive)
 *   - brain-dump/imports.ts partner1 + partner2/email_3/email_4 INSERTs
 *   - agent/reprocess-orphans/route.ts orphan-promote mint
 *   - portal/mint-wedding/route.ts couple-side INSERT
 *   - data-integrity/remediation/wedding-has-people.ts (3 sites)
 *
 * CANONICAL writers (allowed to bypass mintPerson):
 *   - resolver.ts createPerson (mintPerson delegates HERE)
 *   - identity/merge-people.ts (internal to merge cascade)
 *
 * CI guard: scripts/check-no-direct-people-insert.mjs.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import {
  resolvePersonOnly,
  enrichExistingPartner2,
  type IdentitySignals,
} from './resolver'
// venueOwnEmails lives in email/pipeline.ts which transitively imports
// from this module's call sites. Lazy-import to avoid a circular
// dependency loop at load time.

export type PersonMintSource =
  | 'email_pipeline'
  | 'sms_pipeline'
  | 'brain_dump'
  | 'crm_import'
  | 'portal_mint'
  | 'remediation'
  | 'orphan_reprocess'
  | 'manual'

export interface MintPersonInput {
  venueId: string
  signals: IdentitySignals
  source: PersonMintSource
  /** Free-text disambiguator for telemetry (e.g. 'partner2', 'csv_row_42'). */
  reason?: string
  /** Pre-loaded venue own-emails set. Pass when the caller has already
   *  loaded it to skip a duplicate gmail_connections query. */
  ownEmailsHint?: Set<string>
  /**
   * Wedding context for the partner2 dedup invariant (P2, 2026-05-22).
   *
   * When a caller knows the wedding this person belongs to AND which
   * partner role they fill, pass both. They enable the enrich-or-skip
   * invariant below: a `role:'partner2'` mint on a wedding that already
   * has a partner2 is the Liam Hunt duplicate bug. With `weddingId` +
   * `role` set, mintPerson detects the existing partner2 by
   * (venue_id, wedding_id, role) — a wedding-scoped check the
   * identifier-based match chain cannot make when the two partners
   * share no email/phone — and enriches it instead of inserting a
   * duplicate row.
   *
   * Both are optional. Omitted → mintPerson behaves exactly as before
   * (resolver match-chain only). Only `role:'partner2'` + a non-null
   * `weddingId` triggers the invariant; `role:'partner1'` is accepted
   * for symmetry but does not change behaviour today (partner1 dedup is
   * already covered by the identifier match chain).
   */
  weddingId?: string
  role?: 'partner1' | 'partner2'
  supabase?: SupabaseClient
}

export interface MintPersonResult {
  personId: string | null
  isNew: boolean
  matchedBy:
    | 'email_exact'
    | 'email_canonical'
    | 'phone'
    | 'created_new'
    | 'self_loop_blocked'
    | 'resolver_error'
    /** The partner2 dedup invariant fired: an existing partner2 on the
     *  supplied wedding was found and enriched in place; no new row was
     *  inserted. `isNew` is false and `personId` is the existing row. */
    | 'partner2_enriched'
}

export async function mintPerson(input: MintPersonInput): Promise<MintPersonResult> {
  const supabase = input.supabase ?? createServiceClient()

  // 0. Self-loop guard. A venue's own outbound email must never become
  // a lead row — that's the "Sage at Rixey Manor" bug class. Pre-fix,
  // this guard lived in 4 different ingestion paths; centralising it
  // here closes the class.
  if (input.signals.email) {
    const ownEmails =
      input.ownEmailsHint ??
      (await (async () => {
        const { venueOwnEmails } = await import('@/lib/services/email/pipeline')
        return venueOwnEmails(input.venueId)
      })())
    const emailLower = input.signals.email.toLowerCase().trim()
    if (ownEmails.has(emailLower)) {
      return {
        personId: null,
        isNew: false,
        matchedBy: 'self_loop_blocked',
      }
    }
  }

  // 1. Partner2 dedup invariant (P2, 2026-05-22 — the Liam Hunt fix).
  //
  // When the caller has wedding context AND says this person is the
  // second partner, a *wedding-scoped* dedup check runs BEFORE the
  // resolver's identifier match chain. This is the structural fix for
  // the duplicate-partner2 bug class: pipeline.ts:2211 / :3062 mint a
  // fresh partner2 from a body-extracted / Calendly-extracted name with
  // no shared identifier — the email/phone match chain in
  // resolvePersonOnly cannot see the existing partner2 because the two
  // partners of one couple routinely share no email and no phone. The
  // ONLY signal that links them is "same wedding, both role=partner2",
  // which the resolver's IdentitySignals-only shape cannot express.
  //
  // enrich-or-skip: if a non-tombstoned partner2 already exists on this
  // wedding, do NOT insert a second one. Merge any new non-null identity
  // fields (email / phone / last_name, and first_name only when the
  // existing one is empty) into that row and return its id with
  // matchedBy:'partner2_enriched'. If none exists, fall through to the
  // normal resolver path which will INSERT the first partner2.
  if (input.role === 'partner2' && input.weddingId) {
    try {
      const existing = await enrichExistingPartner2(
        supabase,
        input.venueId,
        input.weddingId,
        input.signals,
      )
      if (existing) {
        return {
          personId: existing,
          isNew: false,
          matchedBy: 'partner2_enriched',
        }
      }
      // No existing partner2 — fall through to the resolver path. It
      // will run the identifier match chain (in case partner2 DOES
      // share an identifier with an existing person) and on miss
      // INSERT a fresh person. Note: the resolver's createPerson hard-
      // codes role:'partner1' on INSERT; the caller / a follow-up step
      // is responsible for stamping role:'partner2' + wedding_id on the
      // freshly-minted row. Re-pointing the buggy call sites (M4/M5) is
      // a later step — see PHASE-1-BATCH-1.md §3.2.
    } catch (err) {
      // A dedup-query failure must not block the mint — degrade to the
      // pre-P2 behaviour (resolver path) rather than dropping the person.
      console.warn(
        `[mintPerson] partner2 dedup check failed (wedding=${input.weddingId}); ` +
          `falling through to resolver path:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // 2. Delegate to the resolver's people-side primitive. It runs the
  // match chain (email_exact → email_canonical → phone), captures
  // identifiers into the historical pool (A2 / step 7b), and on miss
  // calls createPerson which INSERTs through the name-capture chokepoint.
  try {
    const result = await resolvePersonOnly(input.venueId, input.signals, {
      sourceLabel: input.source,
      supabase,
    })
    return {
      personId: result.personId,
      isNew: result.isNew,
      matchedBy: result.matchedBy,
    }
  } catch (err) {
    console.error(
      `[mintPerson] resolver failed (source=${input.source}, reason=${input.reason ?? '-'}):`,
      err instanceof Error ? err.message : err,
    )
    return {
      personId: null,
      isNew: false,
      matchedBy: 'resolver_error',
    }
  }
}
