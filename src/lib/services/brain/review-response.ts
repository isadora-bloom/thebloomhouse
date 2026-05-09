/**
 * Review-response brain.
 *
 * Drafts a public response to a venue review. Reuses the same
 * personality engine as the email-reply Sage so the voice is
 * identical: 4-layer prompt (universal rules + personality block +
 * task block + learning block) and the same banned/approved-phrase
 * list pulled from voice_preferences.
 *
 * The task block is what makes this distinct from email replies:
 *   - The model MUST quote or paraphrase a specific moment from
 *     the review so the response cannot be a generic template.
 *   - For ratings <= 3 we shift to a non-defensive acknowledgement.
 *   - Length is 2-4 sentences max, no signoff with the AI's name
 *     since this is posted publicly under the venue's profile.
 */

import { loadPersonalityDataCached } from './client'
import { buildPersonalityPrompt } from '@/lib/ai/personality-builder'
import { UNIVERSAL_RULES } from '@/config/prompts/universal-rules'
import { callAI } from '@/lib/ai/client'
import { createServiceClient } from '@/lib/supabase/service'
import { loadAutoContextForWedding } from '@/lib/services/identity/auto-context-loader'

/** Prompt revision identifier — see PROMPTS-CHANGELOG.md / OPS-21.5.1.
 *  v2 (2026-05-09, Wave 1A): when the caller resolves the underlying
 *  wedding, the brain now loads `wedding_auto_context` and folds the
 *  COUPLE'S NOTES block into the system prompt so the public review
 *  reply can soften / weight tone for couples whose planning carried
 *  emotional load. Universal-rules SOFT-CONTEXT NOTES POLICY governs
 *  the verbatim-quote rule (sensitive notes are voice-shaping only,
 *  never echoed in a public-facing reply). */
export const REVIEW_RESPONSE_PROMPT_VERSION = 'review-response.prompt.v2'

export interface ReviewForResponse {
  id: string
  reviewer_name: string | null
  rating: number | null
  title: string | null
  body: string
  source: string | null
  response_text?: string | null
}

export interface ReviewResponseResult {
  draft: string
  promptVersion: string
  tokensUsed: number
  cost: number
}

function tonePivotForRating(rating: number | null): string {
  const r = rating ?? 5
  if (r <= 2) {
    return [
      'CRITICAL REVIEW (1-2 stars). The reviewer had a bad time.',
      'Acknowledge the specific thing they were unhappy about — name it directly using their own words.',
      'Do NOT defend, explain, or contextualize. Do NOT use "we always" or "we never" framing.',
      'Invite them to reach out privately so the team can make it right. Use the coordinator email if available.',
      'No marketing language. No upsell. Short, sincere, owning the gap.',
    ].join(' ')
  }
  if (r === 3) {
    return [
      'MIXED REVIEW (3 stars). The reviewer liked some things and not others.',
      'Open by recognising what they enjoyed in their own words.',
      'Acknowledge the gap they flagged briefly without minimising it.',
      'Invite them privately if there is something concrete to follow up on.',
    ].join(' ')
  }
  return [
    'POSITIVE REVIEW (4-5 stars). The reviewer is celebrating their day.',
    'Mirror their warmth. Name a specific detail from THIS review (not a generic theme) so it cannot read as a copy-paste.',
    'No promotional language, no future-tense pitch.',
  ].join(' ')
}

function buildTaskPrompt(opts: {
  review: ReviewForResponse
  approvedReviewPhrases: string[]
  businessName: string
}): string {
  const { review, approvedReviewPhrases, businessName } = opts
  const phraseGuidance =
    approvedReviewPhrases.length > 0
      ? `\nApproved language from past reviews you may echo when natural (use sparingly, never force):\n${approvedReviewPhrases.map((p) => `- "${p}"`).join('\n')}\n`
      : ''
  const reviewerFirstName =
    (review.reviewer_name ?? '').trim().split(/\s+/)[0] || null

  return `## TASK: REVIEW RESPONSE

You are drafting a public reply from ${businessName} to a wedding venue review. The reply will be posted on ${review.source ?? 'the review platform'} under the venue's profile.

### What you are responding to
- Reviewer: ${review.reviewer_name ?? 'Anonymous reviewer'}
- Rating: ${review.rating ?? '?'} of 5
${review.title ? `- Title: ${review.title}` : ''}
- Review body:
"""
${review.body}
"""

### Tone for this review
${tonePivotForRating(review.rating)}

### Hard rules
- Length: 2 to 4 short sentences. Maximum 80 words.
- Open with a thank-you that ${reviewerFirstName ? `uses the reviewer's first name (${reviewerFirstName})` : 'does not include a name'}.
- You MUST reference one SPECIFIC moment, detail, or theme the reviewer wrote about. Quote a phrase from their review or paraphrase a particular thing they mentioned. A response that could fit any review is a failed response.
- Do NOT begin with "Thank you so much for the kind words" or any equally generic opener. Find a real opening hook from THIS review.
- Do NOT sign off with the AI assistant's name. If you sign off at all, sign off as the team or omit the closer entirely.
- Do NOT use em dashes. Use commas, periods, or hyphens.
- Output ONLY the response text. No "Here is your response:" preamble. No surrounding quotes. No markdown.
${phraseGuidance}
${review.response_text ? `\n### Existing draft to revise (keep the intent, improve the specificity)\n"""\n${review.response_text}\n"""\n` : ''}

Write the response now.`
}

export async function generateReviewResponse(
  venueId: string,
  review: ReviewForResponse,
  options: {
    /**
     * The wedding row this review belongs to, when the caller can
     * resolve it (typically via reviewer name match). Lets the brain
     * load `wedding_auto_context` and fold soft-context into the system
     * prompt so the public reply reflects what the venue learned during
     * planning. Optional — when null, the brain still drafts a competent
     * reply from review_language alone. Wave 1A (2026-05-09).
     */
    weddingId?: string | null
  } = {},
): Promise<ReviewResponseResult> {
  const personalityData = await loadPersonalityDataCached(venueId)
  const personalityPrompt = buildPersonalityPrompt(personalityData)

  const businessName =
    (personalityData.venue_config?.business_name as string | undefined) ??
    (personalityData.venue?.name as string | undefined) ??
    'our venue'

  const supabase = createServiceClient()
  const { data: phraseRows } = await supabase
    .from('review_language')
    .select('phrase')
    .eq('venue_id', venueId)
    .eq('approved_for_marketing', true)
    .order('frequency', { ascending: false })
    .limit(15)

  const approvedReviewPhrases = (phraseRows ?? [])
    .map((r) => r.phrase as string)
    .filter(Boolean)

  // Wave 1A (2026-05-09): when the caller resolved a wedding, fold
  // soft-context into the system prompt. Reviews land months after
  // planning so by definition the venue has accumulated context —
  // grief, vendor preferences, family logistics, what stressed the
  // couple, what landed. The reply must reflect that without echoing
  // sensitive content (universal-rules SOFT-CONTEXT NOTES POLICY).
  let coupleNotesBlock: string | null = null
  if (options.weddingId) {
    try {
      const { brainBlock } = await loadAutoContextForWedding(
        supabase,
        options.weddingId,
      )
      coupleNotesBlock = brainBlock
    } catch {
      // Soft-context failure must never block a public-reply draft.
    }
  }

  // Optional learning block — banned/approved phrases from voice
  // preferences. Mirrors generateClientDraft so the same voice
  // discipline applies.
  let learningBlock = ''
  const voicePrefs = personalityData.voice_preferences
  if (voicePrefs) {
    const sections: string[] = []
    if (voicePrefs.banned_phrases.length > 0) {
      sections.push(
        `### Banned Phrases\nNEVER use these phrases: ${voicePrefs.banned_phrases.join(', ')}`,
      )
    }
    if (voicePrefs.approved_phrases.length > 0) {
      sections.push(
        `### Approved Phrases\nFeel free to use these phrases naturally: ${voicePrefs.approved_phrases.join(', ')}`,
      )
    }
    if (sections.length > 0) {
      learningBlock = `\n\n## LEARNING FROM PAST FEEDBACK\n${sections.join('\n\n')}`
    }
  }

  const taskPrompt = buildTaskPrompt({
    review,
    approvedReviewPhrases,
    businessName,
  })

  // The COUPLE'S NOTES block sits between the task prompt and the
  // learning block so the model reads (1) what the task is, (2) what
  // it knows about THIS couple, (3) the venue's voice corrections.
  // Empty block is null — skip the section entirely so we don't pollute
  // the prompt with an empty header.
  const coupleNotesSection = coupleNotesBlock ? `\n\n${coupleNotesBlock}` : ''
  const systemPrompt = `${UNIVERSAL_RULES}\n\n${personalityPrompt}\n\n${taskPrompt}${coupleNotesSection}${learningBlock}`

  const result = await callAI({
    systemPrompt,
    userPrompt: `Draft the public response to ${review.reviewer_name ?? 'the reviewer'} now.`,
    maxTokens: 500,
    temperature: 0.7,
    venueId,
    taskType: 'reviews_draft_response',
    contentTier: 2,
    tier: 'sonnet',
    promptVersion: REVIEW_RESPONSE_PROMPT_VERSION,
  })

  const draft = (result.text ?? '').trim().replace(/^["']|["']$/g, '')

  return {
    draft,
    promptVersion: REVIEW_RESPONSE_PROMPT_VERSION,
    tokensUsed: result.inputTokens + result.outputTokens,
    cost: result.cost,
  }
}
