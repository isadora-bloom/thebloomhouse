/**
 * AI adjudicator for Tier 2 ambiguous candidate matches (Phase B / PB.4).
 *
 * The deterministic resolver handles the easy cases (exact email,
 * unique name+window). When there are 2+ weddings that could match a
 * candidate within the ±72h window, the resolver gives up and would
 * normally just flag the candidate for coordinator review. That's
 * slow — the coordinator might not see it for days, by which time
 * the inquiry is already in active triage and the attribution
 * window has shifted.
 *
 * The adjudicator picks up these ambiguous cases. It calls Claude
 * with: the candidate identity + signal timeline, plus 2-3 candidate
 * weddings with their people, recent email subjects, tour state.
 * Claude returns the best match (or "none") with a confidence score
 * and a reasoning string.
 *
 * Decision rules (locked 2026-04-28):
 *   - AI confidence ≥70 + decisive match → auto-link with tier=tier_2_ai,
 *     decided_by=ai, confidence=AI score, reasoning saved on the
 *     attribution_event row. Coordinator sees a "change" button on
 *     the lead detail.
 *   - AI confidence <70 OR returns "none" → candidate stays at
 *     review_status='needs_review' for coordinator confirm.
 *
 * Cost: ~$0.003 per call (small JSON in/out, Sonnet). Called only on
 * the ambiguous middle band — not every candidate. Approved budget.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson } from '@/lib/ai/client'

export interface CandidateContextForAI {
  id: string
  source_platform: string
  first_name: string
  last_initial: string
  last_name: string | null
  state: string | null
  city: string | null
  signal_count: number
  funnel_depth: number
  action_counts: Record<string, number>
  first_seen: string | null
  last_seen: string | null
}

export interface WeddingContextForAI {
  wedding_id: string
  inquiry_date: string | null
  tour_date: string | null
  legacy_source: string | null
  status: string | null
  people: Array<{
    first_name: string | null
    last_name: string | null
    has_email: boolean
    has_phone: boolean
  }>
  recent_email_subjects: string[]
  notes_excerpt: string | null
}

export interface AdjudicatorVerdict {
  match_wedding_id: string | null
  confidence: number
  reasoning: string
}

interface AIResponse {
  match_wedding_id: string | null
  confidence: number
  reasoning: string
}

const SYSTEM_PROMPT = `You are an attribution adjudicator for a wedding venue intelligence platform.

You are given:
- A candidate identity cluster from a third-party platform (The Knot, WeddingWire, Instagram, etc). The cluster represents one (probable) person who showed engagement signals on that platform — viewed, saved, messaged.
- 2 or more candidate weddings (leads) that could match this candidate based on first name + last initial.

Your job: decide which wedding (if any) is the same person.

Use these signals:
- Name consistency. If the candidate has a last_name and the wedding's people have full last_names, they should be compatible.
- Location consistency. If the candidate has a state and a wedding's email/phone suggests the same region, that's positive evidence.
- Timing. The candidate's signal_dates relative to the wedding's inquiry_date and tour_date matter — within 72h is strong, within 7 days is good, beyond 14 days is weak unless other evidence is overwhelming.
- Funnel depth. A candidate who viewed AND saved AND messaged on the platform is much more likely to convert into a real inquiry than a candidate who only viewed once.
- Inquiry channel hint. If the wedding's recent_email_subjects mention "saw you on The Knot" or similar, that's strong evidence the platform-side candidate is the same person.

Important constraints:
- Confidence 90+ only when evidence is overwhelming (full name match + location match + tight time window).
- Confidence 70-89 for "very likely this one specifically".
- Confidence below 70 means defer — return "none" so a coordinator can decide.
- If two weddings look equally likely, return "none" with confidence 0 and explain in reasoning.
- Never guess. Wrong attribution is worse than no attribution.

Return ONLY this JSON shape:
{
  "match_wedding_id": "<uuid or null>",
  "confidence": <integer 0-100>,
  "reasoning": "<one or two sentences explaining the decision>"
}`

function buildUserPrompt(
  candidate: CandidateContextForAI,
  weddings: WeddingContextForAI[],
): string {
  const parts: string[] = []
  parts.push('CANDIDATE')
  parts.push(`  platform: ${candidate.source_platform}`)
  const fullName = candidate.last_name
    ? `${candidate.first_name} ${candidate.last_name}`
    : `${candidate.first_name} ${candidate.last_initial}.`
  parts.push(`  name: ${fullName}`)
  if (candidate.state) parts.push(`  state: ${candidate.state}`)
  if (candidate.city) parts.push(`  city: ${candidate.city}`)
  parts.push(`  signal_count: ${candidate.signal_count}`)
  parts.push(`  funnel_depth: ${candidate.funnel_depth} (distinct action types)`)
  parts.push(`  action_counts: ${JSON.stringify(candidate.action_counts)}`)
  parts.push(`  first_seen: ${candidate.first_seen ?? 'unknown'}`)
  parts.push(`  last_seen: ${candidate.last_seen ?? 'unknown'}`)
  parts.push('')
  parts.push('CANDIDATE WEDDINGS')
  for (const w of weddings) {
    parts.push(`  - wedding_id: ${w.wedding_id}`)
    parts.push(`    inquiry_date: ${w.inquiry_date ?? 'unknown'}`)
    parts.push(`    tour_date: ${w.tour_date ?? 'none'}`)
    parts.push(`    status: ${w.status ?? 'unknown'}`)
    parts.push(`    legacy_source: ${w.legacy_source ?? 'unknown'}`)
    for (const p of w.people) {
      parts.push(
        `    person: ${p.first_name ?? '?'} ${p.last_name ?? '?'} (email: ${p.has_email}, phone: ${p.has_phone})`,
      )
    }
    if (w.recent_email_subjects.length > 0) {
      parts.push(`    recent_emails:`)
      for (const s of w.recent_email_subjects) parts.push(`      "${s}"`)
    }
    if (w.notes_excerpt) parts.push(`    notes: "${w.notes_excerpt.slice(0, 200)}"`)
  }
  return parts.join('\n')
}

export async function adjudicateAmbiguousMatch(args: {
  candidate: CandidateContextForAI
  candidates: WeddingContextForAI[]
  venueId?: string
}): Promise<AdjudicatorVerdict> {
  const { candidate, candidates, venueId } = args
  if (candidates.length === 0) {
    return { match_wedding_id: null, confidence: 0, reasoning: 'no candidate weddings' }
  }
  const userPrompt = buildUserPrompt(candidate, candidates)
  const response = await callAIJson<AIResponse>({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 400,
    temperature: 0.1,
    venueId,
    taskType: 'tier2_adjudicator',
  })
  return {
    match_wedding_id: response.match_wedding_id,
    confidence: Math.max(0, Math.min(100, Math.round(response.confidence ?? 0))),
    reasoning: response.reasoning ?? '',
  }
}

/**
 * Pull the context the adjudicator needs about a wedding. Cheap —
 * one round trip per wedding when called from the resolver path (the
 * resolver already filtered the candidate set down to 2-3 by name
 * + window).
 */
export async function fetchWeddingContext(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<WeddingContextForAI | null> {
  const { data: wed } = await supabase
    .from('weddings')
    .select('id, inquiry_date, tour_date, source, status, notes')
    .eq('id', weddingId)
    .single()
  if (!wed) return null
  const w = wed as {
    id: string
    inquiry_date: string | null
    tour_date: string | null
    source: string | null
    status: string | null
    notes: string | null
  }

  const { data: peopleRows } = await supabase
    .from('people')
    .select('first_name, last_name, email, phone')
    .eq('wedding_id', weddingId)
  const people = ((peopleRows ?? []) as Array<{
    first_name: string | null
    last_name: string | null
    email: string | null
    phone: string | null
  }>).map((p) => ({
    first_name: p.first_name,
    last_name: p.last_name,
    has_email: Boolean(p.email),
    has_phone: Boolean(p.phone),
  }))

  // Last 3 email subjects on this wedding's interactions, if any.
  const { data: interactions } = await supabase
    .from('interactions')
    .select('subject, created_at')
    .eq('wedding_id', weddingId)
    .order('created_at', { ascending: false })
    .limit(3)
  const recent_email_subjects = ((interactions ?? []) as Array<{ subject: string | null }>)
    .map((i) => i.subject)
    .filter((s): s is string => Boolean(s))

  return {
    wedding_id: w.id,
    inquiry_date: w.inquiry_date,
    tour_date: w.tour_date,
    legacy_source: w.source,
    status: w.status,
    people,
    recent_email_subjects,
    notes_excerpt: w.notes,
  }
}
