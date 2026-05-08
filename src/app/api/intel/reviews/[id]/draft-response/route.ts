import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'

export const maxDuration = 60

const PROMPT_VERSION = 'reviews.response.v1'

/**
 * POST /api/intel/reviews/[id]/draft-response
 *
 * Asks the venue's AI assistant to draft a public response to a
 * review. Used by the coordinator on /intel/reviews — they hit
 * "AI draft" on the row, edit the text in the textarea, then save.
 * The model is fed the venue's business name, AI name, tone words,
 * and approved sage phrases so the response sounds like the brand.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) {
    return NextResponse.json(
      { error: 'Response drafting is not available in demo mode' },
      { status: 403 },
    )
  }

  const { id } = await params
  if (!id) return badRequest('review id is required')

  const supabase = createServiceClient()
  const { data: review, error: fetchErr } = await supabase
    .from('reviews')
    .select('id, venue_id, reviewer_name, rating, title, body, source, response_text')
    .eq('id', id)
    .single()

  if (fetchErr || !review) return badRequest('review not found')
  if (review.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data: config } = await supabase
    .from('venue_config')
    .select('business_name, ai_name, tone_words, voice_signature_phrases')
    .eq('venue_id', review.venue_id)
    .single()

  const { data: approvedPhrases } = await supabase
    .from('review_language')
    .select('phrase, theme')
    .eq('venue_id', review.venue_id)
    .eq('approved_for_marketing', true)
    .order('frequency', { ascending: false })
    .limit(20)

  const businessName = (config?.business_name as string | undefined)?.trim() || 'our venue'
  const aiName = (config?.ai_name as string | undefined)?.trim() || null
  const toneWords = (config?.tone_words as string[] | null) ?? []
  const phraseLibrary = (approvedPhrases ?? [])
    .map((p) => p.phrase as string)
    .filter(Boolean)
    .slice(0, 12)

  const isLowRating = (review.rating ?? 5) <= 3

  const systemPrompt = [
    `You are drafting a public response from ${businessName} to a wedding venue review. The response will be posted on the platform where the review lives (${review.source ?? 'a review site'}).`,
    `Tone: warm, gracious, specific. ${toneWords.length > 0 ? `Lean into these tone words: ${toneWords.join(', ')}.` : ''}`,
    `Length: 2-4 short sentences. No more than 80 words.`,
    `Open with a thank-you that names the reviewer if their first name is given (use only the first name, not the full handle).`,
    `Reference one specific moment, detail, or theme from their review so it does not read as generic.`,
    `${isLowRating ? 'This is a critical review. Acknowledge their feedback directly without being defensive. Invite them to reach out privately to make it right. Do NOT make excuses or argue.' : 'Celebrate the win. Mirror the reviewer’s warmth.'}`,
    phraseLibrary.length > 0
      ? `When natural, weave in language that reflects the venue’s voice. Approved phrases include: ${phraseLibrary.map((p) => `"${p}"`).join(', ')}. Use sparingly, never force.`
      : '',
    `Do NOT sign off with the AI assistant’s name. Sign off as the venue team if you sign off at all.`,
    `Do NOT use em dashes. Use commas, periods, or hyphens.`,
    `Output ONLY the response text. No greeting framing like "Here is your response:". No quotes.`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const userPrompt = [
    `Review platform: ${review.source ?? 'unknown'}`,
    `Reviewer: ${review.reviewer_name ?? 'Anonymous reviewer'}`,
    `Rating: ${review.rating ?? '?'} of 5`,
    review.title ? `Review title: ${review.title}` : null,
    `Review body:\n"""\n${review.body}\n"""`,
    review.response_text
      ? `\nThere is an existing draft we are revising. Improve it but keep the same intent:\n"""\n${review.response_text}\n"""`
      : null,
    `\nDraft the venue’s response now.`,
  ]
    .filter(Boolean)
    .join('\n\n')

  try {
    const result = await callAI({
      systemPrompt,
      userPrompt,
      maxTokens: 400,
      temperature: 0.6,
      venueId: review.venue_id,
      taskType: 'reviews_draft_response',
      contentTier: 2,
      tier: 'sonnet',
      promptVersion: PROMPT_VERSION,
    })

    const draft = (result.text ?? '').trim().replace(/^["']|["']$/g, '')
    if (!draft) return NextResponse.json({ error: 'empty draft' }, { status: 502 })

    return NextResponse.json({
      ok: true,
      draft,
      ai_name: aiName,
      prompt_version: PROMPT_VERSION,
    })
  } catch (err) {
    return serverError(err)
  }
}
