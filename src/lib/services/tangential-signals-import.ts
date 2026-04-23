/**
 * Write vision-extracted identity candidates into tangential_signals
 * and run the promotion logic: if any candidate matches an existing
 * person by email/instagram/name, the signal gets matched_person_id
 * and match_status advanced. Unmatched candidates sit in the pool for
 * future inquiry cross-reference.
 *
 * This is the other half of the identity-match loop. identity-enqueue.ts
 * handles "new person → check signal pool". This file handles "new signal
 * → check person pool".
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveIdentity } from '@/lib/services/identity-resolution'

export interface IdentityCandidate {
  name?: string
  first_name?: string
  last_name?: string
  username?: string
  handle?: string
  platform?: string
  context?: string
  signal_type?: string
}

export interface TangentialImportResult {
  written: number
  matched: number
  unmatched: number
}

function normaliseHandle(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().trim().replace(/^@/, '').replace(/[^a-z0-9_.]/g, '')
}

function splitFullName(raw: string | null | undefined): { first_name: string; last_name: string } {
  const s = (raw ?? '').trim()
  if (!s) return { first_name: '', last_name: '' }
  const parts = s.split(/\s+/).filter(Boolean)
  return { first_name: parts[0] ?? '', last_name: parts.slice(1).join(' ') }
}

function allowedSignalType(s: string | undefined): string {
  const allowed = new Set([
    'instagram_engagement',
    'instagram_follow',
    'website_visit',
    'review',
    'mention',
    'analytics_entry',
    'referral',
    'other',
  ])
  const v = (s ?? '').trim()
  return allowed.has(v) ? v : 'other'
}

export async function importIdentityCandidates(args: {
  supabase: SupabaseClient
  venueId: string
  candidates: IdentityCandidate[]
  sourceEntryId?: string | null
  sourceContext?: string | null
  signalDate?: string | null
}): Promise<TangentialImportResult> {
  const { supabase, venueId, candidates, sourceEntryId, sourceContext, signalDate } = args
  const out: TangentialImportResult = { written: 0, matched: 0, unmatched: 0 }

  for (const cand of candidates) {
    const first = (cand.first_name ?? splitFullName(cand.name).first_name).trim()
    const last = (cand.last_name ?? splitFullName(cand.name).last_name).trim()
    const username = normaliseHandle(cand.username ?? cand.handle)
    if (!first && !username && !cand.handle) continue

    const extracted: Record<string, unknown> = {
      name: cand.name ?? (first || last ? `${first} ${last}`.trim() : null),
      first_name: first || null,
      last_name: last || null,
      username: username || null,
      handle: cand.handle ?? null,
      platform: cand.platform ?? null,
    }

    // Dedupe: if we've already written an identical signal (same venue,
    // same signal_type, same first + same username) within the last hour,
    // skip. Prevents a re-upload of the same screenshot from doubling
    // the pool.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { count: existing } = await supabase
      .from('tangential_signals')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('signal_type', allowedSignalType(cand.signal_type))
      .eq('extracted_identity->>first_name', first || null as unknown as string)
      .eq('extracted_identity->>username', username || null as unknown as string)
      .gte('created_at', oneHourAgo)
    if ((existing ?? 0) > 0) continue

    // Try to match against an existing person now (not later). If we hit
    // high, we still write the signal but link it as confirmed_match.
    const matches = await resolveIdentity(supabase, {
      venueId,
      firstName: first || null,
      lastName: last || null,
      instagramHandle: (cand.platform ?? '').toLowerCase() === 'instagram' ? username || null : null,
      signalDate: signalDate ?? new Date().toISOString(),
    })
    const top = matches[0]
    let match_status: string = 'unmatched'
    let matched_person_id: string | null = null
    let confidence_score: number | null = null
    if (top) {
      matched_person_id = top.personId
      confidence_score = top.confidence
      if (top.tier === 'high') match_status = 'confirmed_match'
      else if (top.tier === 'medium') match_status = 'suggested_match'
      else match_status = 'low_confidence_match'
    }

    const { data: inserted, error } = await supabase
      .from('tangential_signals')
      .insert({
        venue_id: venueId,
        signal_type: allowedSignalType(cand.signal_type),
        extracted_identity: extracted,
        source_context: cand.context ?? sourceContext ?? null,
        signal_date: signalDate ?? null,
        match_status,
        matched_person_id,
        confidence_score,
        source_entry_id: sourceEntryId ?? null,
      })
      .select('id')
      .single()
    if (error || !inserted) continue
    out.written++
    if (matched_person_id) out.matched++
    else {
      out.unmatched++
      // F1: signal↔signal queueing. If the new signal stayed unmatched,
      // compare it against other unmatched signals for this venue and
      // enqueue pairs that look like the same person. Lets coordinators
      // resolve two cross-channel signals (e.g. Knot view + Instagram
      // follow) before any inquiry email ever arrives.
      try {
        await enqueueSignalPairs(
          supabase,
          venueId,
          inserted.id as string,
          { first, last, username }
        )
      } catch (err) {
        console.warn('[tangential-signals-import] signal-pair enqueue failed:', err)
      }
    }
  }

  return out
}

/**
 * Compare a just-created tangential signal against other unmatched signals
 * for the venue. Any that look like the same person (exact username
 * match, full-name match, or first-name + shared signal_type within 30d)
 * are inserted into client_match_queue with the appropriate tier. Same
 * queue as person↔person matches — one resolver UI.
 */
async function enqueueSignalPairs(
  supabase: SupabaseClient,
  venueId: string,
  newSignalId: string,
  keys: { first: string; last: string; username: string }
): Promise<void> {
  if (!keys.first && !keys.username) return

  const firstLower = keys.first.toLowerCase().trim()
  const lastLower = keys.last.toLowerCase().trim()
  const usernameLower = keys.username.toLowerCase().trim()

  const { data: others } = await supabase
    .from('tangential_signals')
    .select('id, extracted_identity, signal_type, signal_date')
    .eq('venue_id', venueId)
    .eq('match_status', 'unmatched')
    .neq('id', newSignalId)
  if (!others || others.length === 0) return

  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
  const now = Date.now()

  type PairMatch = {
    signalId: string
    tier: 'high' | 'medium' | 'low'
    confidence: number
    signals: Array<{ type: string; detail: string; weight: number }>
  }
  const matches: PairMatch[] = []

  for (const other of others) {
    const eid = (other.extracted_identity ?? {}) as Record<string, unknown>
    const oFirst = String(eid.first_name ?? '').toLowerCase().trim()
    const oLast = String(eid.last_name ?? '').toLowerCase().trim()
    const oUsername = String(eid.username ?? eid.handle ?? '').replace(/^@/, '').toLowerCase().trim()
    const oDate = other.signal_date ? new Date(other.signal_date as string).getTime() : 0
    const withinWindow = oDate > 0 && Math.abs(now - oDate) <= thirtyDaysMs

    if (usernameLower && oUsername && usernameLower === oUsername) {
      matches.push({
        signalId: other.id as string,
        tier: 'high',
        confidence: 0.92,
        signals: [
          { type: 'username_exact', detail: `Both signals use @${usernameLower}`, weight: 0.92 },
        ],
      })
      continue
    }
    if (firstLower && lastLower && oFirst && oLast && firstLower === oFirst && oLast === lastLower) {
      matches.push({
        signalId: other.id as string,
        tier: 'medium',
        confidence: 0.7,
        signals: [
          { type: 'full_name_match', detail: `Both signals mention ${firstLower} ${lastLower}`, weight: 0.7 },
        ],
      })
      continue
    }
    if (
      firstLower &&
      oFirst &&
      firstLower === oFirst &&
      withinWindow &&
      (other.signal_type as string) !== ''
    ) {
      matches.push({
        signalId: other.id as string,
        tier: 'low',
        confidence: 0.35,
        signals: [
          {
            type: 'first_name_window',
            detail: `Same first name (${firstLower}) on two channels within 30d`,
            weight: 0.35,
          },
        ],
      })
    }
  }

  if (matches.length === 0) return

  // Dedupe existing rows so re-imports don't stack queue rows.
  for (const m of matches) {
    const { data: existing } = await supabase
      .from('client_match_queue')
      .select('id')
      .eq('venue_id', venueId)
      .or(
        `and(signal_a_id.eq.${newSignalId},signal_b_id.eq.${m.signalId}),and(signal_a_id.eq.${m.signalId},signal_b_id.eq.${newSignalId})`
      )
      .in('status', ['pending', 'snoozed'])
      .limit(1)
    if (existing && existing.length > 0) continue

    await supabase.from('client_match_queue').insert({
      venue_id: venueId,
      signal_a_id: newSignalId,
      signal_b_id: m.signalId,
      match_type: m.signals[0]?.type ?? 'signal_pair',
      confidence: m.confidence,
      signals: m.signals,
      tier: m.tier,
      status: 'pending',
    })
  }
}
