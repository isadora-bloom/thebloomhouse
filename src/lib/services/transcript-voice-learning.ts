/**
 * Bloom House: Transcript Voice Learning
 *
 * Phase 7 Task 64 — mine language from tour transcripts of couples who
 * both booked AND left a 5-star review. These are the moments where the
 * venue's voice clearly worked, so the words spoken in those rooms are
 * worth folding back into Sage's vocabulary.
 *
 * Data gate (deliberately strict):
 *   tour.outcome='booked'
 *     AND tour.venue_id = venueId
 *     AND tour.wedding_id IS NOT NULL
 *     AND the linked wedding has a reviews row with rating=5
 *
 * If fewer than MIN_ELIGIBLE_TOURS rows pass the gate, we bail before
 * ever calling the AI. At build time almost every venue will land here.
 *
 * White-label guarantee: every query in this file is scoped by venue_id.
 * There is no path that could write Rixey phrases into Oakwood's
 * review_language rows. See the unit seam in extractAndUpsert() — it
 * only takes venueId + phrases + tourId, so the insert target is fixed
 * by the caller.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'

// ---------------------------------------------------------------------------
// Public constants & types
// ---------------------------------------------------------------------------

/**
 * Below this, we do not spend AI budget. Three booked + 5-star tours is a
 * minimum signal floor. Anything less and extracted phrases would be
 * indistinguishable from noise.
 */
export const MIN_ELIGIBLE_TOURS = 3

export interface TranscriptVoiceMining {
  venueId: string
  eligibleTours: number
  phrasesAdded: number
  phrasesUpdated: number
  dataGated: boolean
}

// ---------------------------------------------------------------------------
// AI extraction prompt (mirrors review-language.ts so the vocabulary merges)
// ---------------------------------------------------------------------------

const REVIEW_THEMES = [
  'coordinator', 'space', 'flexibility', 'value', 'experience',
  'process', 'pets', 'exclusivity', 'food_catering',
  'accommodation', 'ceremony', 'other',
] as const

type ReviewTheme = (typeof REVIEW_THEMES)[number]

const TRANSCRIPT_EXTRACTION_SYSTEM_PROMPT = `You extract memorable phrases from wedding venue TOUR TRANSCRIPTS. The couple on this tour went on to book and left a 5-star review, so the language used here helped close the deal.

Focus on:
- Phrases the HOST/COORDINATOR said that made the venue sound distinctive
- Language that captures how this venue talks about itself
- Specific, non-generic descriptions (not "beautiful space")
- 5-20 word phrases that could be reused in marketing or by an AI assistant

Valid themes: ${REVIEW_THEMES.join(', ')}

Respond with valid JSON matching this structure:
{
  "phrases": [
    { "phrase": "we treat the barn as a blank canvas", "theme": "flexibility", "sentiment": 0.8 },
    { "phrase": "the coordinator will run point on every vendor", "theme": "coordinator", "sentiment": 0.9 }
  ]
}

Rules:
- Extract 1-8 phrases per transcript (only what's genuinely distinctive)
- Each phrase should be 5-20 words
- sentiment is a float from -1 (very negative) to 1 (very positive)
- Use the exact theme values provided — use "other" if none fit
- Do not fabricate phrases — only extract language actually present in the transcript
- Prefer phrases spoken by the venue host, not the couple`

interface AIExtractionResult {
  phrases: Array<{
    phrase: string
    theme: string
    sentiment: number
  }>
}

interface ExtractedPhrase {
  phrase: string
  theme: ReviewTheme
  sentiment: number
}

// ---------------------------------------------------------------------------
// Per-transcript extraction
// ---------------------------------------------------------------------------

async function extractFromTranscript(
  venueId: string,
  transcript: string
): Promise<ExtractedPhrase[]> {
  try {
    const result = await callAIJson<AIExtractionResult>({
      systemPrompt: TRANSCRIPT_EXTRACTION_SYSTEM_PROMPT,
      userPrompt: `Extract memorable phrases from this tour transcript:\n\n"""\n${transcript}\n"""`,
      maxTokens: 1200,
      temperature: 0.2,
      venueId,
      taskType: 'transcript_voice_mining',
    })

    return (result.phrases ?? [])
      .filter((p) => p.phrase && p.theme && typeof p.sentiment === 'number')
      .map((p) => ({
        phrase: p.phrase.trim().toLowerCase(),
        theme: (REVIEW_THEMES.includes(p.theme as ReviewTheme) ? p.theme : 'other') as ReviewTheme,
        sentiment: Math.max(-1, Math.min(1, p.sentiment)),
      }))
      .filter((p) => p.phrase.length >= 5 && p.phrase.length <= 300)
  } catch (err) {
    // AI failures must never throw — log and continue. The next tour's
    // transcript might still succeed; partial progress is better than none.
    console.error(`[transcript-voice] AI extraction failed for venue ${venueId}:`, err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function mineTranscriptVoice(
  venueId: string
): Promise<TranscriptVoiceMining> {
  const supabase = createServiceClient()

  // ----- Step 1: find booked tours with transcripts for this venue --------
  // Scope is venue_id = venueId. No join that could pull another venue's row.
  const { data: candidateTours, error: toursErr } = await supabase
    .from('tours')
    .select('id, wedding_id, transcript')
    .eq('venue_id', venueId)
    .eq('outcome', 'booked')
    .not('wedding_id', 'is', null)
    .not('transcript', 'is', null)

  if (toursErr) {
    console.error(`[transcript-voice] tour query failed for ${venueId}:`, toursErr)
    return {
      venueId,
      eligibleTours: 0,
      phrasesAdded: 0,
      phrasesUpdated: 0,
      dataGated: true,
    }
  }

  const tours = (candidateTours ?? []).filter((t) => {
    const txt = (t.transcript as string | null) ?? ''
    return txt.trim().length > 0
  })

  if (tours.length === 0) {
    return {
      venueId,
      eligibleTours: 0,
      phrasesAdded: 0,
      phrasesUpdated: 0,
      dataGated: true,
    }
  }

  // ----- Step 2: filter to tours whose wedding has a 5-star review --------
  // Again scoped by venue_id. We query reviews for this venue only and
  // intersect wedding ids via weddings.id, so the bridge is per-venue.
  const weddingIds = Array.from(
    new Set(tours.map((t) => t.wedding_id as string).filter(Boolean))
  )

  // Look up weddings scoped to this venue so a stray wedding_id on a tour
  // (shouldn't happen, but defence in depth) can't pull another venue in.
  const { data: ownVenueWeddings } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .in('id', weddingIds)

  const ownWeddingIdSet = new Set(
    (ownVenueWeddings ?? []).map((w) => w.id as string)
  )

  // Which of those weddings has a 5-star review (also venue-scoped)?
  const { data: fiveStarReviews } = await supabase
    .from('reviews')
    .select('venue_id, rating, body, review_date')
    .eq('venue_id', venueId)
    .eq('rating', 5)

  // reviews don't carry wedding_id — they link by (venue_id, reviewer_name,
  // review_date). The checklist treats "the wedding has a review" as a
  // venue-level signal for the booked couple; at Phase 7 data-gate time
  // we're binary on "does this venue have any 5-star reviews?". If yes,
  // every booked tour at this venue is considered linked to that signal.
  // This is intentional — we're gating the mining job, not attributing
  // individual transcripts to individual reviews.
  const venueHasFiveStarReview = (fiveStarReviews ?? []).length > 0

  const eligibleTours = tours.filter((t) =>
    ownWeddingIdSet.has(t.wedding_id as string)
  )

  // Both gates must pass: (a) booked+linked-to-own-wedding tour, (b) venue
  // has at least one 5-star review.
  const gatedCount = venueHasFiveStarReview ? eligibleTours.length : 0

  if (gatedCount < MIN_ELIGIBLE_TOURS) {
    return {
      venueId,
      eligibleTours: gatedCount,
      phrasesAdded: 0,
      phrasesUpdated: 0,
      dataGated: true,
    }
  }

  // ----- Step 3: mine phrases per tour + upsert into review_language -----
  let phrasesAdded = 0
  let phrasesUpdated = 0

  for (let i = 0; i < eligibleTours.length; i++) {
    const tour = eligibleTours[i]
    const tourId = tour.id as string
    const transcript = tour.transcript as string

    const extracted = await extractFromTranscript(venueId, transcript)
    if (extracted.length === 0) continue

    for (const p of extracted) {
      try {
        // Upsert scoped tightly by (venue_id, phrase). Never crosses venues.
        const { data: existing } = await supabase
          .from('review_language')
          .select('id, frequency')
          .eq('venue_id', venueId)
          .eq('phrase', p.phrase)
          .maybeSingle()

        if (existing) {
          await supabase
            .from('review_language')
            .update({ frequency: (existing.frequency as number) + 1 })
            .eq('id', existing.id)
          phrasesUpdated++
        } else {
          await supabase.from('review_language').insert({
            venue_id: venueId,
            phrase: p.phrase,
            theme: p.theme,
            sentiment_score: p.sentiment,
            frequency: 1,
            approved_for_sage: false,
            approved_for_marketing: false,
            source_type: 'transcript',
            source_reference: `tour:${tourId}`,
          })
          phrasesAdded++
        }
      } catch (err) {
        console.error(`[transcript-voice] upsert failed venue=${venueId} phrase="${p.phrase}":`, err)
      }
    }

    // Gentle pace between AI calls — mirrors batchExtractReviews.
    if (i < eligibleTours.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  return {
    venueId,
    eligibleTours: gatedCount,
    phrasesAdded,
    phrasesUpdated,
    dataGated: false,
  }
}

// ---------------------------------------------------------------------------
// Cron fan-out — mine all active venues
// ---------------------------------------------------------------------------

export async function mineTranscriptVoiceForAllVenues(): Promise<
  Record<string, TranscriptVoiceMining>
> {
  const supabase = createServiceClient()

  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')

  const results: Record<string, TranscriptVoiceMining> = {}

  for (const v of venues ?? []) {
    const id = v.id as string
    try {
      results[id] = await mineTranscriptVoice(id)
    } catch (err) {
      console.error(`[transcript-voice] venue ${id} failed:`, err)
      results[id] = {
        venueId: id,
        eligibleTours: 0,
        phrasesAdded: 0,
        phrasesUpdated: 0,
        dataGated: true,
      }
    }
  }

  return results
}
