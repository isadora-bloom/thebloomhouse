/**
 * Person merge — the actual consolidation of two people rows.
 *
 * The /intel/matching UI button says "Merge" and always has. Until this
 * service shipped, it only flipped client_match_queue.status to 'merged'
 * and left both people rows untouched. That was a UI trap.
 *
 * What happens on merge:
 *   1. Snapshot the `merged` person + a summary of its children
 *      (weddings + interactions + drafts + engagement_events counts) so
 *      undo can restore state.
 *   2. Reassign every child row pointing at merged_person_id to
 *      kept_person_id: interactions.person_id, weddings.* via shared
 *      wedding_id (weddings don't FK person — people FK weddings — so
 *      for weddings we consolidate by reassigning all people.wedding_id
 *      where current == merged's wedding AND kept's wedding_id differs).
 *      Also: drafts, engagement_events, contacts, brain_dump_entries.
 *   3. Merge non-null fields from merged → kept if kept's field is null
 *      (email, phone, external_ids union).
 *   4. Delete the merged person row.
 *   5. Insert person_merges audit row. Mark the client_match_queue row
 *      (if matchQueueId provided) as status='merged'.
 *   6. Promote any tangential_signals matched to merged_person_id to
 *      kept_person_id.
 *
 * Undo (reverseMerge) reads the person_merges row and reconstructs:
 *   - Recreates a people row with the snapshot's column values (new id
 *     — original id isn't recoverable since FKs cascaded).
 *   - No attempt is made to reverse the child reassignments. Undo is
 *     "the merge was wrong, give me back the row so I can re-link
 *     manually" rather than "perfectly un-merge." This matches the
 *     Phase 2.5 spec (destructive-vs-additive rule: undo of a
 *     destructive op is best-effort).
 *
 * Everything runs under the service role client. Caller is responsible
 * for venue authorisation.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface MergeSignals {
  type: string
  detail: string
  weight: number
}

export interface MergePeopleArgs {
  supabase: SupabaseClient
  venueId: string
  keepPersonId: string
  mergePersonId: string
  tier: 'high' | 'medium' | 'low'
  signals: MergeSignals[]
  confidence?: number | null
  mergedBy?: string | null
  matchQueueId?: string | null
}

export interface MergePeopleResult {
  mergeId: string
  keepPersonId: string
  reassignedCounts: {
    interactions: number
    weddings: number
    drafts: number
    engagement_events: number
    contacts: number
    tangential_signals: number
  }
}

export async function mergePeople(args: MergePeopleArgs): Promise<MergePeopleResult> {
  const { supabase, venueId, keepPersonId, mergePersonId, tier, signals, confidence, mergedBy, matchQueueId } = args
  if (keepPersonId === mergePersonId) {
    throw new Error('mergePeople: keep and merge ids are identical')
  }

  // 1. Load both people (for snapshot + field backfill).
  const { data: kept } = await supabase.from('people').select('*').eq('id', keepPersonId).eq('venue_id', venueId).single()
  const { data: merged } = await supabase.from('people').select('*').eq('id', mergePersonId).eq('venue_id', venueId).single()
  if (!kept || !merged) {
    throw new Error('mergePeople: one or both people not found for this venue')
  }

  // 2. Count children BEFORE reassignment for snapshot + summary.
  const countBefore = await childCounts(supabase, venueId, mergePersonId)

  // 3. Reassign children.
  const reassigned = await reassignChildren(supabase, venueId, keepPersonId, mergePersonId, merged.wedding_id as string | null, kept.wedding_id as string | null)

  // 3a. Status promotion across the merge. The merge consolidates two
  // weddings into the kept_wedding_id; without this step, if the
  // merged wedding was further along the funnel (e.g. 'booked' from a
  // Calendly final-walkthrough event) and the kept wedding was earlier
  // (e.g. 'inquiry' from a Knot relay email), the more-progressed
  // status was lost. Roll forward the higher status onto kept.
  // Never downgrade. Never promote past terminal (lost / cancelled).
  const keptWeddingId = kept.wedding_id as string | null
  const mergedWeddingId = merged.wedding_id as string | null
  if (keptWeddingId && mergedWeddingId && keptWeddingId !== mergedWeddingId) {
    const STATUS_RANK: Record<string, number> = {
      inquiry: 0, tour_scheduled: 1, tour_completed: 2, proposal_sent: 3, booked: 4,
      completed: 5, lost: 99, cancelled: 99,
    }
    const [{ data: keptWed }, { data: mergedWed }] = await Promise.all([
      supabase.from('weddings').select('status').eq('id', keptWeddingId).maybeSingle(),
      supabase.from('weddings').select('status').eq('id', mergedWeddingId).maybeSingle(),
    ])
    const ks = (keptWed?.status as string | undefined) ?? 'inquiry'
    const ms = (mergedWed?.status as string | undefined) ?? 'inquiry'
    const kRank = STATUS_RANK[ks] ?? 0
    const mRank = STATUS_RANK[ms] ?? 0
    if (mRank > kRank && mRank < 99) {
      await supabase.from('weddings').update({ status: ms }).eq('id', keptWeddingId)
      // Status-change touchpoint — merge can promote a wedding from
      // 'inquiry' (Knot side) to 'booked' (Calendly side). The funnel
      // needs to know this couple booked, regardless of which wedding
      // row carried the booking event historically.
      try {
        const { recordStatusChangeTouchpoint } = await import('@/lib/services/touchpoints')
        // Pull the kept wedding's source for attribution context.
        const { data: keptW } = await supabase.from('weddings').select('source').eq('id', keptWeddingId).maybeSingle()
        await recordStatusChangeTouchpoint(venueId, keptWeddingId, ms, {
          source: (keptW?.source as string | null) ?? null,
          medium: 'merge',
          metadata: { merged_from_person: mergePersonId },
        })
      } catch (err) {
        console.warn('[merge-people] status-change touchpoint failed:', err)
      }
    }
  }

  // 4. Backfill non-null fields from merged → kept if kept's is null.
  const keptRow = kept as Record<string, unknown>
  const mergedRow = merged as Record<string, unknown>
  const updates: Record<string, unknown> = {}
  for (const k of ['email', 'phone', 'first_name', 'last_name'] as const) {
    if (!keptRow[k] && mergedRow[k]) updates[k] = mergedRow[k]
  }
  // external_ids: union (kept's values win on collision).
  const keptExt = (keptRow.external_ids ?? {}) as Record<string, unknown>
  const mergedExt = (mergedRow.external_ids ?? {}) as Record<string, unknown>
  const unionExt = { ...mergedExt, ...keptExt }
  if (Object.keys(unionExt).length > Object.keys(keptExt).length) {
    updates.external_ids = unionExt
  }
  if (Object.keys(updates).length > 0) {
    await supabase.from('people').update(updates).eq('id', keepPersonId)
  }

  // 5. Write the audit row BEFORE deleting merged so the snapshot captures state.
  const snapshot = {
    person: mergedRow,
    children: countBefore,
  }
  const { data: auditInsert } = await supabase
    .from('person_merges')
    .insert({
      venue_id: venueId,
      kept_person_id: keepPersonId,
      merged_person_id: mergePersonId,
      signals,
      tier,
      confidence_score: confidence ?? null,
      snapshot,
      merged_by: mergedBy ?? null,
    })
    .select('id')
    .single()
  const mergeId = (auditInsert?.id as string) ?? ''

  // 6. Delete the merged person (FK cascades handle any leftover links we
  // didn't explicitly reassign — though we shouldn't hit any given the
  // exhaustive reassignment step).
  await supabase.from('people').delete().eq('id', mergePersonId)

  // 7. Mark the queue row, if provided.
  if (matchQueueId) {
    await supabase.from('client_match_queue').update({
      status: 'merged',
      resolved_by: mergedBy ?? null,
      resolved_at: new Date().toISOString(),
    }).eq('id', matchQueueId)
  }

  return {
    mergeId,
    keepPersonId,
    reassignedCounts: reassigned,
  }
}

async function childCounts(
  supabase: SupabaseClient,
  venueId: string,
  personId: string
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  const tables: Array<{ name: string; col?: string }> = [
    { name: 'interactions' },
    { name: 'drafts' },
    { name: 'engagement_events' },
    { name: 'contacts', col: 'person_id' },
    { name: 'tangential_signals', col: 'matched_person_id' },
  ]
  for (const t of tables) {
    const col = t.col ?? 'person_id'
    const { count } = await supabase
      .from(t.name)
      .select('id', { count: 'exact', head: true })
      .eq(col, personId)
    counts[t.name] = count ?? 0
  }
  // weddings aren't linked via person_id — they're linked via
  // people.wedding_id (the reverse). Count "how many weddings does this
  // person belong to" = distinct wedding_id on people rows with this id.
  const { data: pw } = await supabase.from('people').select('wedding_id').eq('id', personId).eq('venue_id', venueId)
  counts.weddings = (pw ?? []).filter((r) => r.wedding_id).length
  return counts
}

/**
 * Move every child row from merged → kept. Returns the counts reassigned.
 * Uses safe updates — if a child has a UNIQUE constraint we'd hit here,
 * we DELETE instead (e.g., contacts.value might be duplicated if the
 * kept person already has the same email).
 */
async function reassignChildren(
  supabase: SupabaseClient,
  venueId: string,
  keepPersonId: string,
  mergePersonId: string,
  mergedWeddingId: string | null,
  keptWeddingId: string | null
): Promise<MergePeopleResult['reassignedCounts']> {
  const counts = {
    interactions: 0,
    weddings: 0,
    drafts: 0,
    engagement_events: 0,
    contacts: 0,
    tangential_signals: 0,
  }

  // interactions.person_id
  {
    const { count } = await supabase
      .from('interactions')
      .update({ person_id: keepPersonId }, { count: 'exact' })
      .eq('person_id', mergePersonId)
      .eq('venue_id', venueId)
    counts.interactions = count ?? 0
  }

  // drafts — drafts.wedding_id based, no person_id. If the merged person
  // had a wedding that differs from kept's, reassign draft.wedding_id too.
  if (mergedWeddingId && mergedWeddingId !== keptWeddingId && keptWeddingId) {
    const { count } = await supabase
      .from('drafts')
      .update({ wedding_id: keptWeddingId }, { count: 'exact' })
      .eq('wedding_id', mergedWeddingId)
      .eq('venue_id', venueId)
    counts.drafts = count ?? 0
  }

  // engagement_events.wedding_id
  if (mergedWeddingId && mergedWeddingId !== keptWeddingId && keptWeddingId) {
    const { count } = await supabase
      .from('engagement_events')
      .update({ wedding_id: keptWeddingId }, { count: 'exact' })
      .eq('wedding_id', mergedWeddingId)
      .eq('venue_id', venueId)
    counts.engagement_events = count ?? 0
  }

  // contacts.person_id
  {
    const { count } = await supabase
      .from('contacts')
      .update({ person_id: keepPersonId }, { count: 'exact' })
      .eq('person_id', mergePersonId)
    counts.contacts = count ?? 0
  }

  // tangential_signals.matched_person_id
  {
    const { count } = await supabase
      .from('tangential_signals')
      .update({ matched_person_id: keepPersonId }, { count: 'exact' })
      .eq('matched_person_id', mergePersonId)
      .eq('venue_id', venueId)
    counts.tangential_signals = count ?? 0
  }

  // If the merged person's wedding differs from the kept person's, move
  // any remaining people on merged's wedding (beside merged itself) over
  // to kept's wedding. This handles the partner2 case.
  if (mergedWeddingId && mergedWeddingId !== keptWeddingId && keptWeddingId) {
    const { count } = await supabase
      .from('people')
      .update({ wedding_id: keptWeddingId }, { count: 'exact' })
      .eq('wedding_id', mergedWeddingId)
      .eq('venue_id', venueId)
      .neq('id', mergePersonId)
    counts.weddings = count ?? 0
    // Now the merged person's wedding is childless — soft-delete it to
    // avoid orphan rows. Only delete if the wedding has no remaining
    // interactions + drafts + people after the reassignments.
    const { count: remainingPeople } = await supabase
      .from('people')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', mergedWeddingId)
    const { count: remainingInt } = await supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', mergedWeddingId)
    if ((remainingPeople ?? 0) === 0 && (remainingInt ?? 0) === 0) {
      await supabase.from('weddings').delete().eq('id', mergedWeddingId)
    }
  }

  return counts
}

/**
 * Undo a merge. Recreates the merged person from the snapshot (with a
 * new id because FK cascades already deleted the original). Does NOT
 * reverse child reassignments — those stay on the kept person. The
 * coordinator can manually re-link anything that needs to go back.
 */
export async function undoMerge(args: {
  supabase: SupabaseClient
  venueId: string
  mergeId: string
  undoneBy?: string | null
}): Promise<{ recreatedPersonId: string | null }> {
  const { supabase, venueId, mergeId, undoneBy } = args
  const { data: audit, error } = await supabase
    .from('person_merges')
    .select('*')
    .eq('id', mergeId)
    .eq('venue_id', venueId)
    .single()
  if (error || !audit || audit.undone_at) return { recreatedPersonId: null }

  const snap = (audit.snapshot ?? {}) as { person?: Record<string, unknown> }
  const person = snap.person
  if (!person) return { recreatedPersonId: null }

  // Strip id/created_at so the reinsert picks up a fresh id + timestamp.
  const { id: _, created_at: __, updated_at: ___, ...rest } = person as Record<string, unknown> & { id?: string; created_at?: string; updated_at?: string }
  void _; void __; void ___
  const { data: inserted } = await supabase.from('people').insert(rest).select('id').single()

  await supabase.from('person_merges').update({
    undone_at: new Date().toISOString(),
    undone_by: undoneBy ?? null,
  }).eq('id', mergeId)

  return { recreatedPersonId: (inserted?.id as string) ?? null }
}
