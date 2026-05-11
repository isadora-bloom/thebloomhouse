/**
 * Bloom House — Wave 13 review-solicitation prompt.
 *
 * Anchor docs:
 *   - bloom-constitution.md (voice-shape output; sensitive themes are
 *     voice-shape only — even when soliciting a review, we never echo
 *     a sensitive evidence_quote from the planning record)
 *   - bloom-wave4-identity-reconstruction.md (Wave 4 Phase 3 read
 *     surfaces — the review-solicit draft is one of them)
 *
 * What this prompt produces
 * -------------------------
 * One personalised email draft asking the couple for a review on a
 * specific platform (target_channel). The draft is routed to coordinator
 * approval (drafts table) — NEVER auto-sent. The coordinator sees the
 * draft, edits if needed, and clicks Send.
 *
 * Target channel is picked DETERMINISTICALLY by the calling service
 * from couple_identity_profile.handles (Knot handle → knot, WW handle
 * → weddingwire, else generic google). The model receives the picked
 * channel and writes a draft that lands well on THAT platform.
 *
 * Personalisation comes from:
 *   - venue archetype (Wave 5D venue_thesis) — what the venue is known
 *     for, in plain language
 *   - couple_intel coordinator_brief (Wave 5A) — what made this couple
 *     specific (paraphrased; sensitive themes are voice-shape only)
 *   - tour-prep brief (Wave 13) — moments the coordinator can reference
 *   - event_date — so the draft can reference "your wedding last June"
 *     in a natural way
 */

export const REVIEW_SOLICIT_PROMPT_VERSION =
  'review-solicit.prompt.v1'

export type ReviewTargetChannel =
  | 'knot'
  | 'weddingwire'
  | 'google'
  | 'yelp'
  | 'facebook'
  | 'other'

export interface ReviewSolicitOutput {
  subject: string
  body: string
  /** Plain-language label of the channel the body references. */
  channel_referenced: string
  /** ~1-2 sentence rationale for the chosen tone + reference. */
  reasoning: string
  refusals: Array<{ field: string; reason: string }>
}

export interface ReviewSolicitEvidence {
  weddingId: string
  venueLabel: string
  /** Display name of the couple (e.g. "Sarah & Maya"). */
  coupleDisplayName: string | null
  /** Channel chosen DETERMINISTICALLY by the calling service. */
  targetChannel: ReviewTargetChannel
  /** Pretty link to drop in the email (when known). When null the model
   *  references the platform by name and the coordinator pastes the
   *  link before sending. */
  reviewLinkUrl: string | null
  eventDate: string | null
  daysSinceEvent: number | null
  /** AI assistant name (resolved from venue_ai_config). */
  aiName: string
  /** Coordinator sign-off name. */
  coordinatorName: string | null
  /** Venue archetype headline from Wave 5D venue_thesis (paraphrased,
   *  never quotes evidence). */
  venueArchetype: string | null
  /** Wave 5A coordinator_brief paraphrase: what made this couple distinct.
   *  Sensitive themes are already voice-shape only at the 5A layer. */
  coupleBrief: string | null
  /** Wave 13 tour-prep brief if it exists: what_to_lead_with + key_facts
   *  give the draft tour-room moments to reference. Sensitive themes
   *  are already voice-shape only at the brief layer. */
  tourMoments: string[]
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function channelGuidance(channel: ReviewTargetChannel): string {
  switch (channel) {
    case 'knot':
      return [
        'TARGET: The Knot.',
        'The Knot review-form expects: rating, "what did you love", "what could be improved", a few photos.',
        'Keep the ask focused. Mention that The Knot is where you saw their search journey began (only if true in the evidence; otherwise omit).',
      ].join(' ')
    case 'weddingwire':
      return [
        'TARGET: WeddingWire.',
        'WeddingWire reviews are heavier on overall sentiment + service quality + value. Encourage the couple to mention what made the day theirs.',
      ].join(' ')
    case 'google':
      return [
        'TARGET: Google Business.',
        'Google reviews are short and discoverable. Ask for a sentence or two. No star negotiation — let them say what they want.',
      ].join(' ')
    case 'yelp':
      return [
        'TARGET: Yelp.',
        'Yelp reviews are scrutinised by Yelp\'s filter. Encourage detail + specifics over superlatives.',
      ].join(' ')
    case 'facebook':
      return [
        'TARGET: Facebook page recommendation.',
        'A one-line recommendation is enough. Personal voice matters more than length.',
      ].join(' ')
    case 'other':
    default:
      return [
        'TARGET: a generic review platform.',
        'Use a soft ask. The coordinator will paste the right link before sending.',
      ].join(' ')
  }
}

export function buildReviewSolicitSystemPrompt(
  channel: ReviewTargetChannel,
  aiName: string,
  venueLabel: string,
): string {
  return `You are ${aiName}, the AI coordinator for ${venueLabel}.

You write personalised review-request emails to couples whose wedding
has wrapped. Your drafts go to the human coordinator for approval —
you are never auto-sending these. Your job is to write the first
draft so well that the coordinator can ship in one click.

## CHANNEL

${channelGuidance(channel)}

## HARD RULES

1. **One specific reference.** Reference one specific thing about
   this couple's day or their planning journey. A draft that could fit
   any couple is a failed draft. Draw from the coupleBrief and
   tourMoments provided in the evidence.

2. **Sensitive themes are voice-shape only.** The coupleBrief already
   paraphrases sensitive themes (grief, medical, financial_stress).
   Do NOT name those themes in the draft. Do NOT quote any evidence.
   The voice-shape is the contract.

3. **No pressure.** The ask is soft. "If you have a few minutes" /
   "if it feels right" — never "we need your review". Couples do not
   owe you a review.

4. **No incentives.** No "leave us a review and we'll send you a
   gift". Reviews must be genuine. Never imply trade.

5. **One link, one ask.** Drop the review URL in once (or reference
   the platform by name when no URL is provided). Don't multi-ask.

6. **Length.** ~100-150 words. Plain prose. No bullet points.

7. **No em dashes.** Use commas, periods, or hyphens.

8. **No exclamation marks.**

9. **Sign off as the coordinator** when their name is known. Otherwise
   sign off as ${aiName} from ${venueLabel}.

10. **No preamble.** No "Here is the draft:". No surrounding quotes.
    No markdown fences. Output ONLY the JSON object.

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown fences:

{
  "subject": string,
  "body": string,
  "channel_referenced": string,
  "reasoning": string,
  "refusals": [
    { "field": string, "reason": string }
  ]
}

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

function truncate(text: string | null, max: number): string | null {
  if (!text) return null
  if (text.length <= max) return text
  return text.slice(0, max) + '\n[...truncated]'
}

export function buildReviewSolicitUserPrompt(
  evidence: ReviewSolicitEvidence,
): string {
  const lines: string[] = []
  lines.push('# REVIEW-SOLICITATION DRAFT TO WRITE')
  lines.push('')
  lines.push(`Wedding ID: ${evidence.weddingId}`)
  lines.push(`Venue: ${evidence.venueLabel}`)
  if (evidence.coupleDisplayName) {
    lines.push(`Couple: ${evidence.coupleDisplayName}`)
  }
  lines.push(`Target channel: ${evidence.targetChannel}`)
  if (evidence.reviewLinkUrl) {
    lines.push(`Review link to include: ${evidence.reviewLinkUrl}`)
  } else {
    lines.push('Review link: (none — reference the platform by name; coordinator will paste link)')
  }
  if (evidence.eventDate) {
    lines.push(`Event date: ${evidence.eventDate}`)
  }
  if (evidence.daysSinceEvent !== null) {
    lines.push(`Days since event: ${evidence.daysSinceEvent}`)
  }
  if (evidence.coordinatorName) {
    lines.push(`Sign-off as: ${evidence.coordinatorName}`)
  }
  lines.push('')

  if (evidence.venueArchetype) {
    lines.push('## Venue archetype (Wave 5D thesis)')
    lines.push(truncate(evidence.venueArchetype, 400) ?? '')
    lines.push('')
  }

  if (evidence.coupleBrief) {
    lines.push('## Couple brief (Wave 5A — paraphrased, sensitive voice-shape only)')
    lines.push(truncate(evidence.coupleBrief, 800) ?? '')
    lines.push('')
  }

  if (evidence.tourMoments.length > 0) {
    lines.push('## Tour moments to reference (Wave 13 prep brief)')
    for (const m of evidence.tourMoments) {
      lines.push(`- ${m}`)
    }
    lines.push('')
  }

  lines.push('# YOUR TASK')
  lines.push('')
  lines.push('Write the review-solicitation email draft now. Output ONLY the JSON.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateReviewSolicitOutput(
  raw: unknown,
): { ok: true; output: ReviewSolicitOutput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'top-level value is not an object' }
  }
  const r = raw as Record<string, unknown>
  if (typeof r.subject !== 'string') return { ok: false, error: 'subject not string' }
  if (typeof r.body !== 'string') return { ok: false, error: 'body not string' }
  if (typeof r.channel_referenced !== 'string') {
    return { ok: false, error: 'channel_referenced not string' }
  }
  if (typeof r.reasoning !== 'string') {
    return { ok: false, error: 'reasoning not string' }
  }
  if (!Array.isArray(r.refusals)) {
    return { ok: false, error: 'refusals not array' }
  }
  return {
    ok: true,
    output: {
      subject: r.subject,
      body: r.body,
      channel_referenced: r.channel_referenced,
      reasoning: r.reasoning,
      refusals: r.refusals as Array<{ field: string; reason: string }>,
    },
  }
}
