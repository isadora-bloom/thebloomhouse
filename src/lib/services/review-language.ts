/**
 * Bloom House: Review Language Extraction Service
 *
 * Uses AI to extract notable, quotable phrases from wedding venue reviews.
 * Phrases are categorized by theme and scored for sentiment, then made
 * available for the venue's AI personality (Sage) and marketing use.
 *
 * Ported from bloom intelligence layer (lib/extraction)
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REVIEW_THEMES = [
  'coordinator', 'space', 'flexibility', 'value', 'experience',
  'process', 'pets', 'exclusivity', 'food_catering',
  'accommodation', 'ceremony', 'other',
] as const

export type ReviewTheme = (typeof REVIEW_THEMES)[number]

const EXTRACTION_SYSTEM_PROMPT = `You extract memorable phrases from wedding venue reviews. Focus on:
- Specific, quotable language (not generic praise)
- Phrases that capture what makes this venue unique
- Both positive and constructive feedback
- 5-20 word phrases that could be used in marketing or by an AI assistant

Valid themes: ${REVIEW_THEMES.join(', ')}

Respond with valid JSON matching this structure:
{
  "phrases": [
    { "phrase": "the coordinators made us feel so at ease", "theme": "coordinator", "sentiment": 0.9 },
    { "phrase": "flexible with our timeline changes", "theme": "flexibility", "sentiment": 0.7 }
  ]
}

Rules:
- Extract 1-8 phrases per review (only extract what's genuinely notable)
- Each phrase should be 5-20 words
- sentiment is a float from -1 (very negative) to 1 (very positive)
- Use the exact theme values provided — use "other" if none fit
- Do not fabricate phrases — only extract language actually present in the review`

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedPhrase {
  phrase: string
  theme: ReviewTheme
  sentiment: number
}

interface AIExtractionResult {
  phrases: Array<{
    phrase: string
    theme: string
    sentiment: number
  }>
}

export interface ReviewLanguageRow {
  id: string
  venue_id: string
  phrase: string
  theme: string
  sentiment_score: number
  frequency: number
  approved_for_sage: boolean
  approved_for_marketing: boolean
  created_at: string
}

export interface PhrasesByTheme {
  [theme: string]: ReviewLanguageRow[]
}

// ---------------------------------------------------------------------------
// Extract from a single review
// ---------------------------------------------------------------------------

/**
 * Extract notable phrases from a single review using AI.
 * Upserts to review_language — increments frequency if the phrase already exists.
 */
export async function extractReviewLanguage(
  venueId: string,
  reviewText: string,
  reviewRating?: number
): Promise<ExtractedPhrase[]> {
  const ratingContext = reviewRating != null ? `\nReview rating: ${reviewRating}/5` : ''

  const result = await callAIJson<AIExtractionResult>({
    systemPrompt: EXTRACTION_SYSTEM_PROMPT,
    userPrompt: `Extract notable phrases from this wedding venue review:${ratingContext}\n\n"${reviewText}"`,
    maxTokens: 1000,
    temperature: 0.2,
    venueId,
    taskType: 'review_language_extraction',
  })

  const phrases = (result.phrases ?? [])
    .filter((p) => p.phrase && p.theme && typeof p.sentiment === 'number')
    .map((p) => ({
      phrase: p.phrase.trim().toLowerCase(),
      theme: (REVIEW_THEMES.includes(p.theme as ReviewTheme) ? p.theme : 'other') as ReviewTheme,
      sentiment: Math.max(-1, Math.min(1, p.sentiment)),
    }))

  if (phrases.length === 0) return []

  const supabase = createServiceClient()

  for (const p of phrases) {
    // Check if this phrase already exists for this venue
    const { data: existing } = await supabase
      .from('review_language')
      .select('id, frequency')
      .eq('venue_id', venueId)
      .eq('phrase', p.phrase)
      .single()

    if (existing) {
      // Increment frequency
      await supabase
        .from('review_language')
        .update({ frequency: (existing.frequency as number) + 1 })
        .eq('id', existing.id)
    } else {
      // Insert new phrase
      await supabase
        .from('review_language')
        .insert({
          venue_id: venueId,
          phrase: p.phrase,
          theme: p.theme,
          sentiment_score: p.sentiment,
          frequency: 1,
          approved_for_sage: false,
          approved_for_marketing: false,
        })
    }
  }

  return phrases
}

// ---------------------------------------------------------------------------
// Batch extraction
// ---------------------------------------------------------------------------

/**
 * Process multiple reviews with a 500ms delay between AI calls to avoid
 * rate-limiting. Returns total number of phrases extracted across all reviews.
 */
export async function batchExtractReviews(
  venueId: string,
  reviews: Array<{ text: string; rating?: number }>
): Promise<number> {
  let totalPhrases = 0

  for (let i = 0; i < reviews.length; i++) {
    const review = reviews[i]
    const phrases = await extractReviewLanguage(venueId, review.text, review.rating)
    totalPhrases += phrases.length

    // Delay between calls (skip after last review)
    if (i < reviews.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  return totalPhrases
}

// ---------------------------------------------------------------------------
// Retrieve phrases
// ---------------------------------------------------------------------------

/**
 * Get phrases approved for a given context (sage or marketing), grouped by theme.
 */
export async function getApprovedPhrases(
  venueId: string,
  forContext: 'sage' | 'marketing'
): Promise<PhrasesByTheme> {
  const supabase = createServiceClient()
  const approvalColumn = forContext === 'sage' ? 'approved_for_sage' : 'approved_for_marketing'

  const { data, error } = await supabase
    .from('review_language')
    .select('*')
    .eq('venue_id', venueId)
    .eq(approvalColumn, true)
    .order('frequency', { ascending: false })

  if (error) throw error

  const grouped: PhrasesByTheme = {}

  for (const row of data ?? []) {
    const theme = row.theme as string
    if (!grouped[theme]) grouped[theme] = []
    grouped[theme].push(row as ReviewLanguageRow)
  }

  return grouped
}

/**
 * Get the highest-frequency phrases regardless of approval status.
 */
export async function getTopPhrases(
  venueId: string,
  limit = 20
): Promise<ReviewLanguageRow[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('review_language')
    .select('*')
    .eq('venue_id', venueId)
    .order('frequency', { ascending: false })
    .limit(limit)

  if (error) throw error
  return (data ?? []) as ReviewLanguageRow[]
}

// ---------------------------------------------------------------------------
// Approval actions
// ---------------------------------------------------------------------------

/**
 * Approve a phrase for use by the Sage AI assistant.
 */
export async function approvePhraseForSage(phraseId: string): Promise<void> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('review_language')
    .update({ approved_for_sage: true })
    .eq('id', phraseId)

  if (error) throw error
}

/**
 * Approve a phrase for use in marketing materials.
 */
export async function approvePhraseForMarketing(phraseId: string): Promise<void> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('review_language')
    .update({ approved_for_marketing: true })
    .eq('id', phraseId)

  if (error) throw error
}
