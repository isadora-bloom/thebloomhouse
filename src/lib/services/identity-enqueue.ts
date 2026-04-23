/**
 * Identity-match enqueuer.
 *
 * Called from email-pipeline (and any other person-creation path) right
 * after a new person lands. Runs the resolveIdentity engine, then:
 *   - high-tier matches: auto-merge the NEW person INTO the existing one
 *     and return the existing id so the caller re-points its follow-on
 *     writes (interactions, drafts, wedding link) to the consolidated
 *     row.
 *   - medium + low-tier matches: write rows to client_match_queue for the
 *     coordinator to triage. Queue rows carry tier + signals jsonb.
 *
 * Also promotes tangential_signals: if the new person matches any
 * unmatched signal in the pool, the signal's matched_person_id is set
 * and its match_status advances. This is what makes the multi-touch
 * journey real — a Sarah H Knot inquiry discovers the Sarah Highland
 * Instagram signal from 3 weeks ago.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveIdentity, personToCandidate } from '@/lib/services/identity-resolution'
import { mergePeople } from '@/lib/services/merge-people'

export interface EnqueueResult {
  autoMergedIntoPersonId: string | null
  queuedPairs: number
  promotedSignals: number
}

export async function enqueueIdentityMatches(args: {
  supabase: SupabaseClient
  venueId: string
  newPersonId: string
}): Promise<EnqueueResult> {
  const { supabase, venueId, newPersonId } = args

  // 1. Load the just-created person into a candidate shape.
  const { data: newPerson } = await supabase
    .from('people')
    .select('id, venue_id, wedding_id, first_name, last_name, email, phone, external_ids, created_at, role, weddings(wedding_date)')
    .eq('id', newPersonId)
    .single()
  if (!newPerson) {
    return { autoMergedIntoPersonId: null, queuedPairs: 0, promotedSignals: 0 }
  }
  const weddingRel = (newPerson as Record<string, unknown>).weddings as
    | { wedding_date?: string | null }
    | { wedding_date?: string | null }[]
    | null
    | undefined
  const weddingDate = Array.isArray(weddingRel) ? weddingRel[0]?.wedding_date ?? null : weddingRel?.wedding_date ?? null
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

  const matches = await resolveIdentity(supabase, candidate)

  // 2. High-tier: auto-merge new into existing. Keep the OLDER person as
  // the survivor (more history attached, safer defaults).
  let autoMerged: string | null = null
  const high = matches.find((m) => m.tier === 'high')
  if (high) {
    // Which row is older? Keep that one. If the existing person is older,
    // merge new → existing; otherwise merge existing → new. Almost always
    // the existing one wins, but we check to be safe.
    const { data: existing } = await supabase
      .from('people')
      .select('created_at')
      .eq('id', high.personId)
      .single()
    const existingOlder =
      existing && new Date(existing.created_at as string).getTime() <= new Date(newPerson.created_at as string).getTime()
    if (existingOlder) {
      const res = await mergePeople({
        supabase, venueId,
        keepPersonId: high.personId,
        mergePersonId: newPersonId,
        tier: 'high',
        signals: high.signals,
        confidence: high.confidence,
      })
      autoMerged = res.keepPersonId
    } else {
      const res = await mergePeople({
        supabase, venueId,
        keepPersonId: newPersonId,
        mergePersonId: high.personId,
        tier: 'high',
        signals: high.signals,
        confidence: high.confidence,
      })
      autoMerged = res.keepPersonId
    }
  }

  // 3. Medium + low tiers → client_match_queue. Skip if we already merged
  // into one of these matches (auto-merge already consolidated that pair).
  let queued = 0
  for (const m of matches) {
    if (m.tier === 'high') continue
    if (autoMerged && m.personId === autoMerged) continue
    // Dedupe: don't enqueue a pair that already exists in the queue.
    const { data: existing } = await supabase
      .from('client_match_queue')
      .select('id')
      .eq('venue_id', venueId)
      .or(
        `and(person_a_id.eq.${m.personId},person_b_id.eq.${newPersonId}),and(person_a_id.eq.${newPersonId},person_b_id.eq.${m.personId})`
      )
      .in('status', ['pending', 'snoozed'])
      .limit(1)
    if (existing && existing.length > 0) continue
    await supabase.from('client_match_queue').insert({
      venue_id: venueId,
      person_a_id: m.personId,
      person_b_id: newPersonId,
      match_type: m.signals[0]?.type ?? 'unknown',
      confidence: m.confidence,
      signals: m.signals,
      tier: m.tier,
      status: 'pending',
    })
    queued++
  }

  // 4. Promote matching tangential_signals. A signal "matches" when its
  // extracted_identity has either email == person.email OR instagram
  // handle == person.external_ids.instagram OR (first_name + last_name
  // match within signal_date window). We keep this lightweight — full
  // scoring lives in resolveIdentity; here we just link the low-hanging
  // fruit.
  const emailLower = (candidate.email ?? '').toLowerCase()
  const instagramLower = (candidate.instagramHandle ?? '').toLowerCase()
  const promoted = await promoteTangentialSignals(
    supabase,
    venueId,
    autoMerged ?? newPersonId,
    { emailLower, instagramLower, firstName: candidate.firstName ?? '', lastName: candidate.lastName ?? '' }
  )

  return {
    autoMergedIntoPersonId: autoMerged,
    queuedPairs: queued,
    promotedSignals: promoted,
  }
}

async function promoteTangentialSignals(
  supabase: SupabaseClient,
  venueId: string,
  personId: string,
  keys: { emailLower: string; instagramLower: string; firstName: string; lastName: string }
): Promise<number> {
  // Pull unmatched signals for the venue. Volumes are low (hundreds at
  // most per venue), so we filter in-memory.
  const { data: signals } = await supabase
    .from('tangential_signals')
    .select('id, extracted_identity, signal_date')
    .eq('venue_id', venueId)
    .eq('match_status', 'unmatched')
  if (!signals || signals.length === 0) return 0

  const firstNameLower = keys.firstName.toLowerCase().trim()
  const lastNameLower = keys.lastName.toLowerCase().trim()
  const toPromote: Array<{ id: string; confidence: number; status: 'confirmed_match' | 'suggested_match' | 'low_confidence_match' }> = []

  for (const s of signals) {
    const eid = (s.extracted_identity ?? {}) as Record<string, unknown>
    const sigEmail = String(eid.email_fragment ?? eid.email ?? '').toLowerCase().trim()
    const sigInsta = String(eid.username ?? eid.handle ?? '').replace(/^@/, '').toLowerCase().trim()
    const sigFirst = String(eid.first_name ?? '').toLowerCase().trim()
    const sigLast = String(eid.last_name ?? eid.last_initial ?? '').toLowerCase().trim()

    if (keys.emailLower && sigEmail && keys.emailLower === sigEmail) {
      toPromote.push({ id: s.id as string, confidence: 0.95, status: 'confirmed_match' })
      continue
    }
    if (keys.instagramLower && sigInsta && keys.instagramLower === sigInsta) {
      toPromote.push({ id: s.id as string, confidence: 0.9, status: 'confirmed_match' })
      continue
    }
    if (firstNameLower && lastNameLower && sigFirst && sigLast && sigFirst === firstNameLower && lastNameLower.startsWith(sigLast)) {
      toPromote.push({ id: s.id as string, confidence: 0.7, status: 'suggested_match' })
      continue
    }
    if (firstNameLower && sigFirst && sigFirst === firstNameLower) {
      toPromote.push({ id: s.id as string, confidence: 0.35, status: 'low_confidence_match' })
      continue
    }
  }

  for (const p of toPromote) {
    await supabase.from('tangential_signals').update({
      matched_person_id: personId,
      confidence_score: p.confidence,
      match_status: p.status,
    }).eq('id', p.id)
  }
  return toPromote.length
}
