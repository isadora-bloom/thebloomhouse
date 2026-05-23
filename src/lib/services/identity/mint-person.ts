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
  createPartner2Person,
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
    /** C1 collision guard fired (PHASE-1-BATCH-1 remediation, 2026-05-23):
     *  the resolver's identifier match chain returned an existing person
     *  who is already partner1 (or partner2) of the SAME wedding as
     *  `input.weddingId`. The match was discarded and a fresh partner2
     *  row was minted via `createPartner2Person`. Surfaces in telemetry
     *  so the same-email-twice form-entry pattern is auditable. */
    | 'partner2_same_wedding_collision'
    /** C1 collision guard fired (cross-wedding case): the resolver
     *  returned a person who is partner1 / partner2 of a DIFFERENT
     *  wedding. Conservative call — false-negative (mint fresh, let
     *  audited merge cascade dedup if they really are the same human)
     *  beats false-positive (pollute the other couple). */
    | 'partner2_cross_wedding_collision'
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
      // INSERT a fresh person.
      //
      // P2 GAP A fix (2026-05-22): the `weddingId` + `role` below are
      // threaded into `resolvePersonOnly` → `createPerson`, so the
      // FIRST partner2 minted for this wedding lands correctly stamped
      // (`role:'partner2'`, `wedding_id:<id>`) — not as the historic
      // `role:'partner1'`, `wedding_id:NULL` row that was invisible to
      // this very dedup query, leaving the second partner2 signal free
      // to insert a duplicate. The DB-level partial unique index
      // (migration 367) is the belt to this suspenders. Re-pointing the
      // buggy call sites (M4/M5) to route through mintPerson is the
      // next step — see PHASE-1-BATCH-1.md §3.2.
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
      // P2 GAP A fix (2026-05-22): thread the wedding + role context so a
      // fresh INSERT in createPerson is stamped correctly. Only forwarded
      // when both are present; resolvePersonOnly + createPerson treat
      // them as optional and fall back to the pre-P2 default
      // (`role:'partner1'`, no `wedding_id`) when absent.
      ...(input.weddingId && input.role
        ? { weddingId: input.weddingId, personRole: input.role }
        : {}),
    })

    // 3. C1 collision guard (PHASE-1-BATCH-1 remediation, 2026-05-23).
    //
    // When role='partner2' + weddingId is set, the resolver's identifier
    // match chain (email_exact / canonical / phone) is blind to wedding
    // context. Two pathological cases:
    //
    //   (a) Same-wedding collision: the operator/couple typed the same
    //       email or phone for both partners on a Calendly form (or a
    //       couple shares one inbox). The resolver matches partner1 of
    //       THIS wedding and returns it with isNew=false. Without this
    //       guard, the M5 follow-up `captureNameEvidence({full: partner2,
    //       source:'form_relay'})` writes partner2's name onto partner1's
    //       row — pollution + no partner2 row ever exists.
    //
    //   (b) Cross-wedding collision: partner2's email/phone happens to
    //       match a person on a DIFFERENT wedding's partner1/partner2.
    //       Genuinely-same-human across two couples (vendor, planner) is
    //       so rare that the false-positive risk (silently attach to the
    //       other couple, pollute identity, lose this couple's partner2)
    //       outweighs the false-negative cost (mint fresh, let the audited
    //       merge cascade dedup if it really is the same human).
    //
    // Doctrine: partner1 and partner2 of the same wedding are distinct
    // humans by definition; partner2-of-X being-the-same-human-as-partner-
    // of-Y is rare and recoverable via merge.
    //
    // Guard only fires when (a) caller asked for partner2, (b) weddingId
    // is set, (c) the resolver returned a NON-NEW row (so we have someone
    // to check), AND (d) the row's wedding_id is a partner1/partner2 of
    // some wedding. enrichExistingPartner2 above already covered the
    // same-wedding partner2 case (which is the intended dedup target —
    // enrich and return); this guard catches the partner1-same-wedding
    // and cross-wedding-partner cases that enrich missed.
    if (
      input.role === 'partner2'
      && input.weddingId
      && result.personId
      && !result.isNew
    ) {
      try {
        const { data: matched } = await supabase
          .from('people')
          .select('wedding_id, role')
          .eq('id', result.personId)
          .maybeSingle()
        const matchedWeddingId = (matched?.wedding_id as string | null) ?? null
        const matchedRole = (matched?.role as string | null) ?? null
        const isPartner = matchedRole === 'partner1' || matchedRole === 'partner2'
        const sameWedding = matchedWeddingId === input.weddingId
        const crossWeddingPartner =
          isPartner
          && matchedWeddingId !== null
          && matchedWeddingId !== input.weddingId

        // (a) Same-wedding collision — almost always partner1 (the
        //     partner2-on-same-wedding case is caught by
        //     enrichExistingPartner2 step above, but we re-cover it here
        //     defensively for the race where enrich saw zero rows and the
        //     resolver path then matched a freshly-inserted partner2 from
        //     a concurrent tick).
        // (b) Cross-wedding partner collision — see doctrine comment.
        if (sameWedding || crossWeddingPartner) {
          const collisionKind = sameWedding
            ? 'partner2_same_wedding_collision'
            : 'partner2_cross_wedding_collision'
          console.warn(
            `[mintPerson] C1 collision guard fired (${collisionKind}): ` +
              `resolver returned person=${result.personId} ` +
              `(wedding=${matchedWeddingId}, role=${matchedRole}) on a ` +
              `role=partner2 mint for wedding=${input.weddingId}. ` +
              `Discarding match and minting fresh partner2.`,
          )
          const freshId = await createPartner2Person(
            supabase,
            input.venueId,
            input.weddingId,
            input.signals,
            input.source,
          )
          if (freshId) {
            return {
              personId: freshId,
              isNew: true,
              matchedBy: collisionKind,
            }
          }
          // createPartner2Person returned null — INSERT failed. The
          // post-migration-367 unique-violation case is itself a signal
          // that a partner2 already exists on this wedding (a concurrent
          // tick won the race). Re-run enrichExistingPartner2 once to
          // resolve to that row rather than degrading to the polluting
          // resolver match.
          try {
            const enriched = await enrichExistingPartner2(
              supabase,
              input.venueId,
              input.weddingId,
              input.signals,
            )
            if (enriched) {
              return {
                personId: enriched,
                isNew: false,
                matchedBy: 'partner2_enriched',
              }
            }
          } catch (err) {
            console.warn(
              `[mintPerson] post-collision enrich re-check failed:`,
              err instanceof Error ? err.message : err,
            )
          }
          // Both fresh-mint and re-enrich failed. Surface resolver_error
          // (personId:null) so the caller's re-query fallback fires — same
          // shape as the post-P2 null-result path. Better to drop the
          // partner2 signal entirely than pollute partner1.
          return {
            personId: null,
            isNew: false,
            matchedBy: 'resolver_error',
          }
        }
      } catch (err) {
        // Collision query failure must not block the mint — degrade to
        // the resolver's return (preserves pre-C1 behaviour). The bug
        // class C1 closes is rare; a query failure here is rarer still.
        console.warn(
          `[mintPerson] C1 collision check failed (wedding=${input.weddingId}); ` +
            `accepting resolver match:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

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
