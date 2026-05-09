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

export const REVIEW_RESPONSE_PROMPT_VERSION = 'review-response.prompt.v1'

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

  const systemPrompt = `${UNIVERSAL_RULES}\n\n${personalityPrompt}\n\n${taskPrompt}${learningBlock}`

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
