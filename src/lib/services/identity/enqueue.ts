/**
 * Post-mint follow-up for a freshly created person.
 *
 * Wave 3, W24 (2026-09-09). This module used to do three jobs:
 *
 *   1. auto-merge a new `people` row into an older duplicate on a
 *      high-tier match,
 *   2. write medium and low tier pairs to `client_match_queue`,
 *   3. "new person, check the signal pool" — scan `tangential_signals`
 *      for rows whose extracted identity looked like the new person and
 *      stamp `matched_person_id` on them.
 *
 * Jobs 2 and 3 are retired.
 *
 * Job 2 duplicated the spine's own review queue. `linkSignal` already
 * writes a `candidate_matches` row for every medium and low tier
 * verdict, with the couple on one side and the touchpoint on the other,
 * and `/intel/identity-review` is the surface that adjudicates it.
 * `client_match_queue` was a second queue holding the same doubt in a
 * different shape, so the coordinator saw one question twice.
 *
 * Job 3 is now the fragment sweep. The pool is `fragments`, not
 * `tangential_signals`, and the match rule is an exact platform handle
 * rather than a first-name guess inside a 30 day window. See
 * `fragment-sweep.ts` and HANDLE-IDENTITY-SPEC.md §2.
 *
 * Job 1 stays, because `src/lib/services/email/pipeline.ts` reads the
 * survivor id back and re-points its follow-on writes at it. Nothing in
 * wave 3 replaces legacy people deduplication, so removing it here
 * would drop a live behaviour rather than move it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { findIdentityMatches, personToCandidate } from '@/lib/services/identity/resolution'
import { mergePeople } from '@/lib/services/identity/merge-people'
import { sweepFragmentsForCouple } from '@/lib/services/identity/fragment-sweep'

export interface EnqueueResult {
  autoMergedIntoPersonId: string | null
  /** Fragments promoted onto this person's couple by handle. */
  promotedFragments: number
}

export async function enqueueIdentityMatches(args: {
  supabase: SupabaseClient
  venueId: string
  newPersonId: string
  /**
   * Skip the high-tier auto-merge. Set by the caller when `mintPerson`
   * resolved to an EXISTING canonical person via its alias or pool
   * branch: there is no fresh row to merge, and re-running the matcher
   * against an already-canonical row only produces spurious candidates.
   * The fragment sweep still runs, because an alias hit IS new evidence
   * about who this person is reachable as.
   */
  skipAutoMerge?: boolean
}): Promise<EnqueueResult> {
  const { supabase, venueId, newPersonId, skipAutoMerge = false } = args

  const { data: newPerson } = await supabase
    .from('people')
    .select('id, venue_id, wedding_id, first_name, last_name, email, phone, external_ids, created_at, role, weddings(wedding_date)')
    .eq('id', newPersonId)
    .single()
  if (!newPerson) {
    return { autoMergedIntoPersonId: null, promotedFragments: 0 }
  }

  let autoMerged: string | null = null

  if (!skipAutoMerge) {
    const weddingRel = (newPerson as Record<string, unknown>).weddings as
      | { wedding_date?: string | null }
      | { wedding_date?: string | null }[]
      | null
      | undefined
    const weddingDate = Array.isArray(weddingRel)
      ? weddingRel[0]?.wedding_date ?? null
      : weddingRel?.wedding_date ?? null
    const candidate = personToCandidate({
      id: newPerson.id as string,
      venue_id: newPerson.venue_id as string,
      wedding_id: (newPerson.wedding_id as string | null) ?? null,
      first_name: (newPerson.first_name as string | null) ?? null,
      last_name: (newPerson.last_name as string | null) ?? null,
      email: (newPerson.email as string | null) ?? null,
      phone: (newPerson.phone as string | null) ?? null,
      external_ids: (newPerson.external_ids as Record<string, unknown> | null) ?? null,
      created_at: newPerson.created_at as string,
      role: (newPerson.role as string | null) ?? null,
      wedding_date: weddingDate,
    })

    const matches = await findIdentityMatches(supabase, candidate)

    // High tier only. Keep the OLDER row as the survivor: it carries
    // more history, so pointing the new writes at it loses nothing.
    // Medium and low tier verdicts are no longer queued here; the
    // spine's candidate_matches already holds that doubt.
    const high = matches.find((m) => m.tier === 'high')
    if (high) {
      const { data: existing } = await supabase
        .from('people')
        .select('created_at')
        .eq('id', high.personId)
        .single()
      const existingOlder =
        existing &&
        new Date(existing.created_at as string).getTime() <=
          new Date(newPerson.created_at as string).getTime()
      const res = await mergePeople({
        supabase,
        venueId,
        keepPersonId: existingOlder ? high.personId : newPersonId,
        mergePersonId: existingOlder ? newPersonId : high.personId,
        tier: 'high',
        signals: high.signals,
        confidence: high.confidence,
      })
      autoMerged = res.keepPersonId
    }
  }

  // The pool check. A person belongs to a wedding, a wedding mirrors a
  // couple, and the couple is what fragments promote onto.
  const promotedFragments = await sweepPoolForPerson(
    supabase,
    venueId,
    autoMerged ?? newPersonId,
  )

  return { autoMergedIntoPersonId: autoMerged, promotedFragments }
}

/**
 * Person → wedding → couple → fragment sweep. Returns 0 whenever the
 * person has no wedding yet or the couple mirror has not been written,
 * which is the normal case for a person minted seconds ago; the linker
 * runs the same sweep when the couple itself gains a handle.
 */
async function sweepPoolForPerson(
  supabase: SupabaseClient,
  venueId: string,
  personId: string,
): Promise<number> {
  const { data: person } = await supabase
    .from('people')
    .select('wedding_id')
    .eq('id', personId)
    .maybeSingle()
  const weddingId = (person?.wedding_id as string | null) ?? null
  if (!weddingId) return 0

  const { data: couple } = await supabase
    .from('couples')
    .select('id')
    .eq('venue_id', venueId)
    .eq('source_wedding_id', weddingId)
    .is('merged_into_id', null)
    .maybeSingle()
  const coupleId = (couple?.id as string | null) ?? null
  if (!coupleId) return 0

  const res = await sweepFragmentsForCouple(supabase, venueId, coupleId)
  return res.promoted
}
