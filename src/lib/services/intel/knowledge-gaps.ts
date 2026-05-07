import { createServiceClient } from '@/lib/supabase/service'

/**
 * Bloom House: Knowledge Gaps Runtime Writer
 *
 * Phase 2 Task 20. The knowledge_gaps table was read-only in the UI but had
 * zero runtime writers — so the Agent "Knowledge Gaps" page always showed
 * an empty list regardless of how many questions Sage couldn't answer.
 *
 * This service records questions extracted by the classifier so the gap
 * backlog reflects actual unanswered inquiry language. Frequency is
 * bumped on recurrence so the UI can surface "asked X times" ordering.
 *
 * Multi-venue: every insert/upsert is scoped by venue_id. An unresolved
 * question at Rixey never leaks into Oakwood's gap list.
 *
 * Heuristics:
 *   - Normalise on lowercase-trim so "what's your rain policy?" and
 *     "What's your rain policy?" dedupe.
 *   - Skip questions shorter than 8 chars (too generic to be useful —
 *     "why?", "how much?" without context).
 *   - Skip questions already marked resolved — coordinators don't want
 *     resolved gaps reopening from a single fresh inquiry mention.
 *   - Category left null by default; categorisation is a Phase 4 concern
 *     once we have embedding clustering.
 */

interface RecordGapsInput {
  venueId: string
  questions: string[]
  weddingId?: string | null
}

export async function recordKnowledgeGaps(input: RecordGapsInput): Promise<void> {
  const { venueId, questions } = input
  if (!venueId || !questions || questions.length === 0) return

  const supabase = createServiceClient()

  // Normalise + dedupe within this batch so the same question asked twice
  // in one email doesn't double-count.
  const normalised = Array.from(
    new Set(
      questions
        .map((q) => (typeof q === 'string' ? q.trim() : ''))
        .filter((q) => q.length >= 8)
        .map((q) => q.replace(/\s+/g, ' '))
    )
  )
  if (normalised.length === 0) return

  // Pull any matching rows in one round trip — cheaper than per-question
  // lookups when a long inquiry yields 5-10 questions at once. Match is
  // case-insensitive.
  const { data: existing, error: selErr } = await supabase
    .from('knowledge_gaps')
    .select('id, question, frequency, status')
    .eq('venue_id', venueId)
    .ilike('question', normalised[0].toLowerCase())
  // Note: Supabase ilike doesn't support IN. Do a second query per row
  // for the ones not matched above (simple approach; table is small).

  const matchedByQuestion = new Map<string, { id: string; frequency: number; status: string }>()
  for (const row of existing ?? []) {
    matchedByQuestion.set(
      (row.question as string).toLowerCase(),
      {
        id: row.id as string,
        frequency: (row.frequency as number) ?? 1,
        status: (row.status as string) ?? 'open',
      }
    )
  }

  if (selErr) {
    console.error('[knowledge-gaps] select failed:', selErr.message)
    return
  }

  for (const q of normalised) {
    const lowered = q.toLowerCase()

    // Second-pass lookup per unmatched question. This is O(n) DB calls but
    // n is typically 1-5 per email; acceptable.
    if (!matchedByQuestion.has(lowered)) {
      const { data: hits } = await supabase
        .from('knowledge_gaps')
        .select('id, frequency, status')
        .eq('venue_id', venueId)
        .ilike('question', lowered)
        .limit(1)
      if (hits && hits.length > 0) {
        matchedByQuestion.set(lowered, {
          id: hits[0].id as string,
          frequency: (hits[0].frequency as number) ?? 1,
          status: (hits[0].status as string) ?? 'open',
        })
      }
    }

    const match = matchedByQuestion.get(lowered)
    if (match) {
      // Skip resolved gaps — one new mention shouldn't reopen a
      // coordinator's decision to close it. Only bump frequency when
      // status is 'open' or null.
      if (match.status === 'resolved') continue
      const { error: upErr } = await supabase
        .from('knowledge_gaps')
        .update({ frequency: match.frequency + 1 })
        .eq('id', match.id)
      if (upErr) {
        console.error('[knowledge-gaps] bump frequency failed:', upErr.message)
      }
    } else {
      const { error: insErr } = await supabase.from('knowledge_gaps').insert({
        venue_id: venueId,
        question: q,
        frequency: 1,
        status: 'open',
      })
      if (insErr) {
        console.error('[knowledge-gaps] insert failed:', insErr.message)
      }
    }
  }
}
