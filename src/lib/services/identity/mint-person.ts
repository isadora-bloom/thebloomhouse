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
import { resolvePersonOnly, type IdentitySignals } from './resolver'
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

  // 1. Delegate to the resolver's people-side primitive. It runs the
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
