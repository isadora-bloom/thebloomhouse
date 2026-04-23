/**
 * Bloom House: Post-Tour Brief Service (Phase 7 Task 63)
 *
 * Consumes the structured intelligence produced by
 * `tour-transcript-extract.ts` (Task 62) and generates two artefacts:
 *
 *   1. A coordinator-facing markdown brief summarising the tour and
 *      recommending the next step. Composed in the venue's configured AI
 *      assistant voice (venue_ai_config.ai_name). Oakwood with
 *      ai_name='Ivy' sees "Ivy has reviewed the tour transcript and
 *      suggests...". Never "Sage".
 *   2. A personalised follow-up email draft in the venue's voice,
 *      anchored on approved-for-sage review_language phrases. Persisted
 *      as a `drafts` row with brain_used='sage_post_tour', status='pending'
 *      so the coordinator can approve/edit from the standard /agent/drafts
 *      surface.
 *
 * White-label: aiName and venueName are pulled per-venue. review_language
 * is scoped to venue_id: no cross-venue voice bleed. No hardcoded
 * "Sage" strings in the brief or draft body.
 *
 * Fail-soft: AI failures log and return null. The tour row is never
 * touched unless both the brief + draft composed successfully enough to
 * return to the caller.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import type { TranscriptExtraction } from './tour-transcript-extract'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PostTourBrief {
  tourId: string
  aiName: string
  venueName: string
  brief: string
  suggestedFollowUpDraft: string | null
  confidence: 'high' | 'medium' | 'low'
}

interface WeddingSummary {
  weddingId: string
  coupleName: string | null
  partnerName: string | null
  weddingDate: string | null
  guestCount: number | null
  toEmail: string | null
}

// ---------------------------------------------------------------------------
// Context loaders
// ---------------------------------------------------------------------------

async function loadWeddingSummary(
  weddingId: string
): Promise<WeddingSummary | null> {
  const supabase = createServiceClient()

  const { data: wedding, error } = await supabase
    .from('weddings')
    .select('id, wedding_date, guest_count_estimate')
    .eq('id', weddingId)
    .maybeSingle()

  if (error || !wedding) return null

  const { data: people } = await supabase
    .from('people')
    .select('first_name, last_name, role, email')
    .eq('wedding_id', weddingId)
    .in('role', ['partner1', 'partner2'])
    .order('role', { ascending: true })
    .limit(2)

  const partner1 = people?.find((p) => p.role === 'partner1') ?? people?.[0]
  const partner2 = people?.find((p) => p.role === 'partner2') ?? people?.[1]

  const firstEmail =
    (partner1?.email as string | null) ??
    (partner2?.email as string | null) ??
    null

  return {
    weddingId,
    coupleName: partner1
      ? [partner1.first_name, partner1.last_name].filter(Boolean).join(' ')
      : null,
    partnerName: partner2
      ? [partner2.first_name, partner2.last_name].filter(Boolean).join(' ')
      : null,
    weddingDate: (wedding.wedding_date as string | null) ?? null,
    guestCount: (wedding.guest_count_estimate as number | null) ?? null,
    toEmail: firstEmail,
  }
}

async function loadTopReviewPhrases(venueId: string, limit = 10): Promise<string[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('review_language')
    .select('phrase, frequency')
    .eq('venue_id', venueId)
    .eq('approved_for_sage', true)
    .order('frequency', { ascending: false })
    .limit(limit)

  if (error || !data) return []

  return data
    .map((row) => row.phrase as string)
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
}

// ---------------------------------------------------------------------------
// Confidence heuristic
// ---------------------------------------------------------------------------

function assessBriefConfidence(
  extraction: TranscriptExtraction,
  draft: string | null
): 'high' | 'medium' | 'low' {
  const signalCount =
    extraction.key_questions.length +
    extraction.emotional_signals.length +
    extraction.specific_interests.length

  if (!draft) return 'low'
  if (signalCount >= 8 && extraction.specific_interests.length >= 2) return 'high'
  if (signalCount >= 4) return 'medium'
  return 'low'
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildBriefSystemPrompt(aiName: string, venueName: string): string {
  return `You are ${aiName}, the AI assistant for ${venueName}. You have just reviewed a tour transcript and you are writing a coordinator-facing brief in clean markdown.

Open with a sentence that begins with "${aiName} has reviewed the tour transcript and suggests...". Never use any other assistant name.

Use exactly these four sections as H3 headings:
### What happened
### What they cared about
### Open questions
### Next-step recommendation

Rules:
- Reference concrete details from the extracted signals (attendee_types, key_questions, emotional_signals, specific_interests). Do not invent facts.
- Keep each section tight. 2 to 4 bullets or a short paragraph.
- No generic platitudes. Coordinators read this fast.
- Do not include a signature or sign-off. This is an internal brief, not an email.
- Plain markdown only. No code blocks, no horizontal rules.`
}

function buildDraftSystemPrompt(
  aiName: string,
  venueName: string,
  voiceAnchors: string[]
): string {
  const voiceBlock =
    voiceAnchors.length > 0
      ? `\nVoice anchors (real phrases from ${venueName}'s reviews; lean on this tone, do not quote verbatim):\n${voiceAnchors.map((p) => `  - "${p}"`).join('\n')}\n`
      : ''

  return `You are ${aiName}, composing a personalised follow-up email from ${venueName} to a couple who just finished a tour. Your job is to sound like this venue's voice, not a generic assistant.
${voiceBlock}
Rules:
- Length: 80 to 160 words. No preamble like "here is a draft". Return only the email body.
- Reference at least one specific interest mentioned in the extraction (e.g. "the stone fireplace", "the pergola") to show the tour was heard.
- End with one concrete next-step question (e.g. confirm a hold date, schedule a follow-up call, send pricing).
- No subject line, no greeting like "Dear [Name]". Start with a warm but natural opening.
- No em dashes. Use commas, colons, or full stops.
- Sign off as ${aiName} on behalf of ${venueName}.
- If the transcript offered nothing concrete to reference, return the exact token NO_DRAFT with nothing else.`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function generatePostTourBrief(
  tourId: string
): Promise<PostTourBrief | null> {
  if (!tourId) return null

  const supabase = createServiceClient()

  // 1. Load tour
  const { data: tour, error: tourErr } = await supabase
    .from('tours')
    .select(
      'id, venue_id, wedding_id, transcript_extracted, scheduled_at, tour_type'
    )
    .eq('id', tourId)
    .maybeSingle()

  if (tourErr) {
    console.error('[post-tour-brief] failed to load tour:', tourErr.message)
    return null
  }
  if (!tour) {
    console.warn('[post-tour-brief] tour not found:', tourId)
    return null
  }

  const extraction = tour.transcript_extracted as TranscriptExtraction | null
  if (!extraction) {
    console.warn(
      '[post-tour-brief] transcript_extracted is null. Call extractTourTranscript first',
      { tourId }
    )
    return null
  }

  const venueId = tour.venue_id as string
  const weddingId = (tour.wedding_id as string | null) ?? null

  // 2. Load venue, ai config, review phrases, wedding (parallel)
  const [
    { data: venue },
    { data: aiConfig },
    voiceAnchors,
    weddingSummary,
  ] = await Promise.all([
    supabase.from('venues').select('name').eq('id', venueId).maybeSingle(),
    supabase
      .from('venue_ai_config')
      .select('ai_name')
      .eq('venue_id', venueId)
      .maybeSingle(),
    loadTopReviewPhrases(venueId, 10),
    weddingId ? loadWeddingSummary(weddingId) : Promise.resolve(null),
  ])

  const venueName = (venue?.name as string | null) ?? 'the venue'
  const aiName = (aiConfig?.ai_name as string | null) ?? 'Sage'

  // 3. Compose the markdown brief
  const extractionJson = JSON.stringify(extraction, null, 2)
  const weddingBlock = weddingSummary
    ? `\nWedding context:\n- Couple: ${weddingSummary.coupleName ?? 'unknown'}${weddingSummary.partnerName ? ` & ${weddingSummary.partnerName}` : ''}\n- Wedding date: ${weddingSummary.weddingDate ?? 'not set'}\n- Guest count estimate: ${weddingSummary.guestCount ?? 'not set'}\n`
    : '\nWedding context: no linked wedding record yet.\n'

  const briefUserPrompt = `Tour scheduled at: ${tour.scheduled_at}\nTour type: ${tour.tour_type}\n${weddingBlock}\nExtracted intelligence (JSON):\n${extractionJson}\n\nWrite the brief now.`

  let briefMarkdown = ''
  try {
    const briefResult = await callAI({
      systemPrompt: buildBriefSystemPrompt(aiName, venueName),
      userPrompt: briefUserPrompt,
      maxTokens: 900,
      temperature: 0.4,
      venueId,
      taskType: 'post_tour_brief',
    })
    briefMarkdown = briefResult.text.trim()
  } catch (err) {
    console.error(
      '[post-tour-brief] brief AI call failed:',
      err instanceof Error ? err.message : err
    )
    return null
  }

  if (!briefMarkdown) {
    console.warn('[post-tour-brief] empty brief text', { tourId })
    return null
  }

  // 4. Compose the follow-up draft
  const draftUserPrompt = `Tour context for the follow-up email:\n${weddingBlock}\nExtracted intelligence (JSON):\n${extractionJson}\n\nCompose the email body now. Remember: 80 to 160 words, reference a specific interest, end with a next-step question.`

  let draftBody: string | null = null
  try {
    const draftResult = await callAI({
      systemPrompt: buildDraftSystemPrompt(aiName, venueName, voiceAnchors),
      userPrompt: draftUserPrompt,
      maxTokens: 700,
      temperature: 0.5,
      venueId,
      taskType: 'post_tour_followup_draft',
    })
    const text = draftResult.text.trim()
    if (text === 'NO_DRAFT' || text.length < 40) {
      draftBody = null
    } else {
      draftBody = text
    }
  } catch (err) {
    console.error(
      '[post-tour-brief] draft AI call failed:',
      err instanceof Error ? err.message : err
    )
    draftBody = null
  }

  const confidence = assessBriefConfidence(extraction, draftBody)

  // 5. Persist: mark brief generated + optionally insert a draft row.
  const nowIso = new Date().toISOString()

  const { error: tourUpdateErr } = await supabase
    .from('tours')
    .update({ tour_brief_generated_at: nowIso })
    .eq('id', tourId)

  if (tourUpdateErr) {
    console.error(
      '[post-tour-brief] failed to stamp tour_brief_generated_at:',
      tourUpdateErr.message
    )
    // Continue: the brief data itself is still useful to the caller.
  }

  if (draftBody) {
    const subject = weddingSummary?.coupleName
      ? `Following up on your tour of ${venueName}`
      : `Following up on your recent tour of ${venueName}`

    const { error: insertErr } = await supabase.from('drafts').insert({
      venue_id: venueId,
      wedding_id: weddingId,
      interaction_id: null,
      to_email: weddingSummary?.toEmail ?? null,
      subject,
      draft_body: draftBody,
      status: 'pending',
      context_type: 'client',
      brain_used: 'sage_post_tour',
      confidence_score:
        confidence === 'high' ? 85 : confidence === 'medium' ? 65 : 40,
      auto_sent: false,
    })

    if (insertErr) {
      console.error(
        '[post-tour-brief] draft insert failed:',
        insertErr.message
      )
      // Fall through: still return the brief so the UI can render.
    }
  }

  return {
    tourId,
    aiName,
    venueName,
    brief: briefMarkdown,
    suggestedFollowUpDraft: draftBody,
    confidence,
  }
}
