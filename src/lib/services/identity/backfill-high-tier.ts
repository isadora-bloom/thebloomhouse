/**
 * Backfill — re-evaluate existing client_match_queue rows against the
 * current resolution rules and auto-merge any pair that NOW qualifies as
 * high-tier.
 *
 * Why this exists: when a new HIGH-tier rule lands in resolution.ts (for
 * example the 2026-05-14 full_name_plus_email_domain rule that catches
 * HoneyBook pm-inbound relay duplicates), already-queued medium / low
 * pairs stay where they are. The resolver only fires on freshly-created
 * people. This service is the catch-up sweep an operator triggers from
 * the matching page when noise has built up.
 *
 * Auto-merge follows the same olderest-wins-survivor rule as enqueue.ts:
 * whichever of the two people was created first stays; the younger one
 * is consolidated into it. The client_match_queue row is marked
 * status='merged' as a side-effect of mergePeople passing matchQueueId.
 *
 * Dry-run mode returns the same evaluation without writing anything.
 *
 * Caller is responsible for venue authorisation. Pass venueId.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadVenueConfig,
  personToCandidate,
  scorePair,
  type PersonRow,
} from '@/lib/services/identity/resolution'
import { mergePeople } from '@/lib/services/identity/merge-people'

export interface BackfillHighTierResult {
  evaluated: number
  promoted: number
  merged: number
  skipped_missing_people: number
  errors: Array<{ row_id: string; error: string }>
  dry_run: boolean
}

interface QueueRow {
  id: string
  person_a_id: string
  person_b_id: string
}

type RawPerson = Omit<PersonRow, 'wedding_date'> & {
  weddings?: { wedding_date?: string | null } | { wedding_date?: string | null }[] | null
}

function hydrate(p: RawPerson): PersonRow {
  const wd = Array.isArray(p.weddings)
    ? p.weddings[0]?.wedding_date ?? null
    : p.weddings?.wedding_date ?? null
  return {
    id: p.id,
    venue_id: p.venue_id,
    wedding_id: p.wedding_id,
    first_name: p.first_name,
    last_name: p.last_name,
    email: p.email,
    phone: p.phone,
    external_ids: p.external_ids,
    created_at: p.created_at,
    role: p.role,
    wedding_date: wd,
  }
}

export async function backfillHighTierMerges(
  supabase: SupabaseClient,
  venueId: string,
  opts: { dryRun?: boolean } = {},
): Promise<BackfillHighTierResult> {
  const dryRun = opts.dryRun === true

  const { data: rawRows } = await supabase
    .from('client_match_queue')
    .select('id, person_a_id, person_b_id')
    .eq('venue_id', venueId)
    .eq('status', 'pending')
    .not('person_a_id', 'is', null)
    .not('person_b_id', 'is', null)

  const rows = (rawRows ?? []) as QueueRow[]
  if (rows.length === 0) {
    return {
      evaluated: 0,
      promoted: 0,
      merged: 0,
      skipped_missing_people: 0,
      errors: [],
      dry_run: dryRun,
    }
  }

  const personIds = new Set<string>()
  for (const r of rows) {
    personIds.add(r.person_a_id)
    personIds.add(r.person_b_id)
  }

  const { data: peopleData } = await supabase
    .from('people')
    .select(
      'id, venue_id, wedding_id, first_name, last_name, email, phone, external_ids, created_at, role, weddings(wedding_date)',
    )
    .eq('venue_id', venueId)
    .in('id', Array.from(personIds))

  const byId = new Map<string, PersonRow>()
  for (const raw of ((peopleData ?? []) as unknown) as RawPerson[]) {
    byId.set(raw.id, hydrate(raw))
  }

  const config = await loadVenueConfig(supabase, venueId)

  let promoted = 0
  let merged = 0
  let skippedMissing = 0
  const errors: Array<{ row_id: string; error: string }> = []
  // Track ids that have been consumed by an earlier merge in this run so
  // we don't try to re-merge a row whose people no longer exist. mergePeople
  // deletes the merged person from `people` and updates downstream rows;
  // any queue row referencing it would now point at a tombstone.
  const consumed = new Set<string>()

  for (const row of rows) {
    if (consumed.has(row.person_a_id) || consumed.has(row.person_b_id)) {
      // One of the two people was already absorbed into another merge
      // earlier in this loop. Skip — the surviving id is paired
      // somewhere else, and the queue row will be re-evaluated next time.
      continue
    }

    const pA = byId.get(row.person_a_id)
    const pB = byId.get(row.person_b_id)
    if (!pA || !pB) {
      skippedMissing++
      continue
    }

    // Score A→B; the rule fires regardless of direction since first/last
    // and email-domain compare commutatively, but the candidateDate uses
    // pA.created_at which only affects the daysApart window check.
    const candidate = personToCandidate(pA)
    const match = scorePair(candidate, pB, config)
    if (!match || match.tier !== 'high') continue

    promoted++
    if (dryRun) continue

    // Older survives. enqueue.ts uses the same rule for fresh inserts.
    const aOlder =
      new Date(pA.created_at).getTime() <= new Date(pB.created_at).getTime()
    const keepId = aOlder ? pA.id : pB.id
    const mergeId = aOlder ? pB.id : pA.id

    try {
      await mergePeople({
        supabase,
        venueId,
        keepPersonId: keepId,
        mergePersonId: mergeId,
        tier: 'high',
        signals: match.signals,
        confidence: match.confidence,
        matchQueueId: row.id,
      })
      merged++
      consumed.add(mergeId)
    } catch (err) {
      errors.push({
        row_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    evaluated: rows.length,
    promoted,
    merged,
    skipped_missing_people: skippedMissing,
    errors,
    dry_run: dryRun,
  }
}
