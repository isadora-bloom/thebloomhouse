/**
 * Bloom House: Tour Transcript Extraction Service (Phase 7 Task 62)
 *
 * Mines Omi-captured tour transcripts for structured intelligence:
 *   - Attendee types (classified from language patterns, not the attendees
 *     jsonb the coordinator manually tagged)
 *   - Key questions asked during the tour
 *   - Emotional signals with quoted evidence
 *   - Specific spaces/features the couple responded positively to
 *   - Target wedding dates mentioned
 *   - A 2-3 sentence coordinator-facing summary
 *
 * Writes the JSON result to tours.transcript_extracted and, per question,
 * upserts into knowledge_gaps scoped to the tour's venue_id. Per-venue
 * scoping means Rixey's gap backlog never mixes with Oakwood's.
 *
 * White-label: pulls ai_name from venue_ai_config and venue.name for
 * prompt context. No hardcoded values.
 *
 * Auto-trigger: the Omi webhook (src/app/api/omi/webhook/route.ts, built
 * by a parallel agent) fires this fire-and-forget once a tour is
 * "complete" (outcome in completed/booked OR scheduled_at > 1h ago with
 * transcript length > 500 chars).
 *
 * TODO: auto-trigger extraction. When src/app/api/omi/webhook/route.ts
 * lands, add a fire-and-forget call to extractTourTranscript(tour.id)
 * after the segment is appended if the tour is considered complete. Do
 * NOT await; the webhook must return quickly.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'
import { recordKnowledgeGaps } from '@/lib/services/knowledge-gaps'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptExtraction {
  attendee_types: string[]
  key_questions: Array<{ question: string; category: string }>
  emotional_signals: Array<{ signal: string; evidence: string }>
  specific_interests: string[]
  booked_date_mentions: string[]
  summary: string
}

const VALID_ATTENDEE_TYPES = [
  'couple',
  'parents',
  'friends',
  'family',
  'wedding_party',
] as const

const VALID_QUESTION_CATEGORIES = [
  'logistics',
  'pricing',
  'availability',
  'amenities',
  'policies',
  'timeline',
  'food',
  'lodging',
  'other',
] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampArrayOfStrings(input: unknown, max = 20): string[] {
  if (!Array.isArray(input)) return []
  return input
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim())
    .slice(0, max)
}

function sanitizeExtraction(raw: unknown): TranscriptExtraction {
  const obj = (raw ?? {}) as Record<string, unknown>

  const attendee_types = clampArrayOfStrings(obj.attendee_types, 5).filter(
    (t) => (VALID_ATTENDEE_TYPES as readonly string[]).includes(t)
  )

  const rawQuestions = Array.isArray(obj.key_questions) ? obj.key_questions : []
  const key_questions = rawQuestions
    .map((q) => {
      if (!q || typeof q !== 'object') return null
      const rec = q as Record<string, unknown>
      const question = typeof rec.question === 'string' ? rec.question.trim() : ''
      const rawCategory = typeof rec.category === 'string' ? rec.category.trim() : 'other'
      const category = (VALID_QUESTION_CATEGORIES as readonly string[]).includes(
        rawCategory
      )
        ? rawCategory
        : 'other'
      if (!question) return null
      return { question, category }
    })
    .filter((q): q is { question: string; category: string } => q !== null)
    .slice(0, 12)

  const rawSignals = Array.isArray(obj.emotional_signals) ? obj.emotional_signals : []
  const emotional_signals = rawSignals
    .map((s) => {
      if (!s || typeof s !== 'object') return null
      const rec = s as Record<string, unknown>
      const signal = typeof rec.signal === 'string' ? rec.signal.trim() : ''
      const evidence = typeof rec.evidence === 'string' ? rec.evidence.trim() : ''
      if (!signal) return null
      return { signal, evidence }
    })
    .filter((s): s is { signal: string; evidence: string } => s !== null)
    .slice(0, 10)

  const specific_interests = clampArrayOfStrings(obj.specific_interests, 15)
  const booked_date_mentions = clampArrayOfStrings(obj.booked_date_mentions, 10)
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''

  return {
    attendee_types,
    key_questions,
    emotional_signals,
    specific_interests,
    booked_date_mentions,
    summary,
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function extractTourTranscript(
  tourId: string
): Promise<TranscriptExtraction | null> {
  if (!tourId) return null

  const supabase = createServiceClient()

  // 1. Load tour
  const { data: tour, error: tourErr } = await supabase
    .from('tours')
    .select('id, venue_id, transcript, attendees')
    .eq('id', tourId)
    .maybeSingle()

  if (tourErr) {
    console.error('[tour-transcript-extract] failed to load tour:', tourErr.message)
    return null
  }
  if (!tour) {
    console.warn('[tour-transcript-extract] tour not found:', tourId)
    return null
  }

  const transcript =
    typeof tour.transcript === 'string' ? tour.transcript.trim() : ''
  if (!transcript) {
    // Nothing to extract; don't wipe any existing extraction.
    return null
  }

  const venueId = tour.venue_id as string

  // 2. Load venue name + ai_name for prompt context
  const [{ data: venue }, { data: aiConfig }] = await Promise.all([
    supabase.from('venues').select('name').eq('id', venueId).maybeSingle(),
    supabase
      .from('venue_ai_config')
      .select('ai_name')
      .eq('venue_id', venueId)
      .maybeSingle(),
  ])

  const venueName = (venue?.name as string | null) ?? 'the venue'
  const aiName = (aiConfig?.ai_name as string | null) ?? 'Sage'

  // 3. Run AI extraction
  const systemPrompt = `You are ${aiName}, assisting coordinators at ${venueName}. You analyse wedding venue tour transcripts and return a single JSON object with exactly these fields:
- attendee_types: array of strings drawn from ["couple","parents","friends","family","wedding_party"]. Include only what was clearly present based on language patterns (e.g. "my mum thinks", "my maid of honour said"). Do not guess.
- key_questions: array of objects {question, category} where category is one of ["logistics","pricing","availability","amenities","policies","timeline","food","lodging","other"]. Extract the 3 to 8 most important questions the couple asked.
- emotional_signals: array of {signal, evidence}. Signals are short snake_case labels like "excited_about_space", "concerned_about_budget", "unsure_about_date". Evidence is a one-sentence quote or paraphrase from the transcript.
- specific_interests: array of short strings, features or spaces they responded positively to (e.g. "the stone fireplace", "the pergola").
- booked_date_mentions: array of ISO-style dates or month-year phrases they mentioned as potential wedding dates (e.g. "2026-10-10", "October 2026", "next fall").
- summary: 2 to 3 sentences, coordinator-facing, neutral tone.

Return valid JSON with no prose, no markdown, no commentary.`

  const userPrompt = `Transcript:\n\n${transcript}`

  let parsed: TranscriptExtraction
  try {
    const raw = await callAIJson<unknown>({
      systemPrompt,
      userPrompt,
      maxTokens: 1500,
      temperature: 0.2,
      venueId,
      taskType: 'tour_transcript_extract',
    })
    parsed = sanitizeExtraction(raw)
  } catch (err) {
    console.error(
      '[tour-transcript-extract] AI call failed:',
      err instanceof Error ? err.message : err
    )
    return null
  }

  // 4. Persist extraction onto the tour row
  const { error: updateErr } = await supabase
    .from('tours')
    .update({ transcript_extracted: parsed })
    .eq('id', tourId)

  if (updateErr) {
    console.error(
      '[tour-transcript-extract] failed to persist extraction:',
      updateErr.message
    )
    // Don't return null; the extraction is still useful to callers even
    // if persistence fails. The caller can retry or surface the data.
  }

  // 5. Upsert key_questions into knowledge_gaps (venue-scoped)
  if (parsed.key_questions.length > 0) {
    try {
      await recordKnowledgeGaps({
        venueId,
        questions: parsed.key_questions.map((q) => q.question),
      })
    } catch (err) {
      console.error(
        '[tour-transcript-extract] knowledge_gaps upsert failed:',
        err instanceof Error ? err.message : err
      )
    }
  }

  return parsed
}
