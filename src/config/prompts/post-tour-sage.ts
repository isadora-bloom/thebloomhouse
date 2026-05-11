/**
 * Bloom House — Wave 13 post-tour Sage follow-up prompt.
 *
 * Anchor docs:
 *   - bloom-constitution.md (voice-shape output never echoes sensitive
 *     evidence_quote verbatim; Sage drafts go to coordinator approval)
 *   - bloom-wave4-identity-reconstruction.md (forensic record drives
 *     personalised drafting; this prompt reads from the record + tour
 *     outcome + tour-prep brief if it exists)
 *
 * What this prompt produces
 * -------------------------
 * One personalised email draft from Sage (the venue's AI coordinator
 * voice) following up after a tour. Different tone for completed vs
 * no_show vs cancelled outcomes:
 *   - completed: thanks them, references something specific from the
 *     tour, invites the next step
 *   - no_show: warm rescheduling offer with no guilt-trip framing
 *   - cancelled: acknowledgement + light-touch keep-in-touch close
 *
 * The draft lands in the existing `drafts` table for coordinator review
 * (NOT auto-sent). Coordinator approves/edits/rejects via the normal
 * Sage approval flow.
 *
 * NEVER echo sensitive evidence_quote verbatim. The tour-prep brief
 * already softened sensitive themes into handle_with guidance; this
 * follow-up reads from THAT (not raw profile) so the sensitivity gate
 * is preserved end-to-end.
 */

import type { TourPrepBriefOutput } from './tour-prep-brief'
import type { CoupleIdentityProfile } from './identity-reconstruction'

export const POST_TOUR_SAGE_PROMPT_VERSION =
  'post-tour-sage.prompt.v1'

export type PostTourOutcome =
  | 'completed'
  | 'no_show'
  | 'cancelled'
  | 'pending'
  | 'unknown'

export interface PostTourSageOutput {
  subject: string
  body: string
  recommended_timing: string
  reasoning: string
  refusals: Array<{ field: string; reason: string }>
}

export interface PostTourInteractionEvidence {
  index: number
  direction: 'inbound' | 'outbound'
  from_name: string | null
  subject: string | null
  body_excerpt: string | null
  timestamp: string | null
}

export interface PostTourEvidence {
  weddingId: string
  tourId: string
  venueLabel: string | null
  tourScheduledAt: string | null
  tourOutcome: PostTourOutcome
  tourNotes: string | null
  /** Whether a Wave 13 tour-prep brief was generated. The brief carries
   *  pre-tour key facts + what_to_lead_with + sensitivity gate already
   *  applied — we read it INSTEAD of the raw profile to preserve the
   *  sensitivity contract across the pipeline. */
  brief: TourPrepBriefOutput | null
  /** Last-resort profile read when no brief existed. Voice-shape formatter
   *  filters sensitive evidence the same way. */
  profile: CoupleIdentityProfile | null
  recentInteractions: PostTourInteractionEvidence[]
  /** AI assistant name (resolved from venue_ai_config). */
  aiName: string
  /** Venue display name. */
  venueName: string
  /** Coordinator's display name when known (signature). */
  coordinatorName: string | null
  /** Couple display name (e.g. "Sarah & Maya"). */
  coupleDisplayName: string | null
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function outcomeTone(outcome: PostTourOutcome): string {
  switch (outcome) {
    case 'completed':
      return [
        'TOUR COMPLETED. The couple walked the venue. The draft should:',
        '- Thank them for coming.',
        '- Reference ONE specific moment, question, or detail that came up — drawn from the brief or recent interactions. A generic "thanks for visiting" is a failure.',
        '- Re-affirm the venue suits the couple, lightly, without overselling.',
        '- Suggest the next step (hold the date, send proposal, follow-up call) appropriate to where they are in the pipeline.',
        '- Tone: warm + competent. No exclamation marks. Plain prose. ~120-180 words.',
      ].join(' ')
    case 'no_show':
      return [
        'TOUR NO-SHOW. The couple was scheduled but did not arrive. The draft should:',
        '- Open without guilt-tripping. Acknowledge things come up.',
        '- Offer to reschedule with 2-3 concrete slot suggestions OR a link to the booking page.',
        '- Keep it short (~80-120 words).',
        '- Tone: warm, no pressure, no "we missed you" passive-aggression.',
      ].join(' ')
    case 'cancelled':
      return [
        'TOUR CANCELLED by the couple. The draft should:',
        '- Acknowledge cleanly. No drama.',
        '- Offer to keep the door open ("when the timing is right, we are here").',
        '- Optional: mention the next available date the venue has if the couple gave any date constraint we know about.',
        '- Tone: warm, brief (~80-100 words), no upselling.',
      ].join(' ')
    case 'pending':
    case 'unknown':
    default:
      return [
        'TOUR OUTCOME UNCLEAR. Default to the completed-tour shape, but err on warmth and avoid asserting something happened that we cannot confirm.',
        '~100-140 words. Plain prose. No exclamation marks.',
      ].join(' ')
  }
}

export function buildPostTourSageSystemPrompt(
  outcome: PostTourOutcome,
  aiName: string,
  venueName: string,
): string {
  return `You are ${aiName}, the AI coordinator for ${venueName}.

You write personalised follow-up emails after wedding-venue tours. Your
drafts go to the human coordinator for approval BEFORE being sent — you
are not auto-sending. Your job is to write the FIRST GOOD DRAFT so the
coordinator can ship in one click or refine in three.

## OUTCOME-SPECIFIC TONE

${outcomeTone(outcome)}

## HARD RULES

1. **One specific reference.** The draft must reference one specific
   moment, question, or fact about THIS couple — drawn from the brief
   (preferred) or recent interactions. A draft that could fit any
   couple is a failed draft.

2. **Sensitive themes are voice-shape only.** If the brief carries
   sensitivity_flags, ADAPT TONE to match handle_with. Do NOT name
   the sensitive theme in the draft. Do NOT quote any sensitive
   evidence_quote (the brief already filtered these out).

3. **No em dashes.** Use commas, periods, or hyphens.

4. **No marketing language.** No "premium", "exclusive", "unforgettable
   experience". Plain prose. The voice is a competent human colleague,
   not a brochure.

5. **No exclamation marks.** None. Warmth comes from word choice, not
   punctuation.

6. **No subject prefix.** Just a clean subject line. No "Re:" or "Fwd:".

7. **Sign off as the coordinator** when their name is known. Otherwise
   sign off as ${aiName} from ${venueName}.

8. **No preamble.** No "Here's the draft:". No surrounding quotes. No
   markdown fences. Output ONLY the JSON object.

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown fences:

{
  "subject": string,
  "body": string,
  "recommended_timing": string,    // e.g. "send tomorrow morning"
  "reasoning": string,             // ~1-2 sentences explaining tone choices
  "refusals": [
    { "field": string, "reason": string }
  ]
}

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

// ---------------------------------------------------------------------------
// User prompt — serialise the evidence
// ---------------------------------------------------------------------------

function truncate(text: string | null, max: number): string | null {
  if (!text) return null
  if (text.length <= max) return text
  return text.slice(0, max) + '\n[...truncated]'
}

export function buildPostTourSageUserPrompt(
  evidence: PostTourEvidence,
): string {
  const lines: string[] = []
  lines.push('# POST-TOUR FOLLOW-UP TO DRAFT')
  lines.push('')
  lines.push(`Tour ID: ${evidence.tourId}`)
  lines.push(`Wedding ID: ${evidence.weddingId}`)
  if (evidence.venueLabel) lines.push(`Venue: ${evidence.venueLabel}`)
  if (evidence.coupleDisplayName) {
    lines.push(`Couple: ${evidence.coupleDisplayName}`)
  }
  lines.push(`Tour outcome: ${evidence.tourOutcome}`)
  if (evidence.tourScheduledAt) {
    lines.push(`Tour scheduled_at: ${evidence.tourScheduledAt}`)
  }
  if (evidence.coordinatorName) {
    lines.push(`Coordinator (sign-off name): ${evidence.coordinatorName}`)
  }
  if (evidence.tourNotes) {
    lines.push('Coordinator notes from tour:')
    lines.push(truncate(evidence.tourNotes, 600) ?? '')
  }
  lines.push('')

  if (evidence.brief) {
    lines.push('## Tour-prep brief (Wave 13 — preferred source)')
    lines.push('')
    lines.push(`persona_summary: ${evidence.brief.persona_summary}`)
    lines.push(`what_to_lead_with: ${evidence.brief.what_to_lead_with}`)
    lines.push(`what_to_avoid: ${evidence.brief.what_to_avoid}`)
    lines.push(`recent_signals_summary: ${evidence.brief.recent_signals_summary}`)
    if (evidence.brief.key_facts.length > 0) {
      lines.push('key_facts:')
      for (const f of evidence.brief.key_facts) {
        lines.push(`  - ${f.fact} (${f.why_it_matters})`)
      }
    }
    if (evidence.brief.sensitivity_flags.length > 0) {
      lines.push('sensitivity_flags (adapt tone; do NOT name themes in draft):')
      for (const f of evidence.brief.sensitivity_flags) {
        lines.push(`  - ${f.category}: ${f.handle_with}`)
      }
    }
    if (evidence.brief.recommended_questions.length > 0) {
      lines.push('recommended_questions (already asked in tour, possibly):')
      for (const q of evidence.brief.recommended_questions) {
        lines.push(`  - ${q}`)
      }
    }
    if (evidence.brief.expected_concerns.length > 0) {
      lines.push('expected_concerns:')
      for (const c of evidence.brief.expected_concerns) {
        lines.push(`  - ${c}`)
      }
    }
    lines.push('')
  } else if (evidence.profile) {
    // Fallback when no brief existed. Voice-shape only — sensitive
    // truths surface as theme labels, never as evidence_quote.
    lines.push('## Forensic profile (fallback; brief did not exist)')
    const profile = evidence.profile
    if (profile.names.partner1) {
      const p1 = profile.names.partner1
      const name = [p1.first, p1.last].filter(Boolean).join(' ') || '(unknown)'
      lines.push(`- partner1: ${name}`)
    }
    if (profile.names.partner2 && !profile.names.is_phantom_partner_relationship) {
      const p2 = profile.names.partner2
      const name = [p2.first, p2.last].filter(Boolean).join(' ') || '(unknown)'
      lines.push(`- partner2: ${name}`)
    }
    const sensitive = profile.emotional_truths.filter((t) => t.sensitive)
    const nonSensitive = profile.emotional_truths.filter((t) => !t.sensitive)
    if (nonSensitive.length > 0) {
      lines.push('- emotional truths (non-sensitive):')
      for (const t of nonSensitive.slice(0, 5)) {
        lines.push(`  - ${t.theme}: "${t.evidence_quote.slice(0, 200)}"`)
      }
    }
    if (sensitive.length > 0) {
      const labels = sensitive.map((t) => t.theme).join(', ')
      lines.push(`- SENSITIVE THEMES (${sensitive.length}, voice-shape only): ${labels}`)
    }
    lines.push('')
  }

  if (evidence.recentInteractions.length > 0) {
    lines.push('## Recent interactions (most-recent-first)')
    for (const ix of evidence.recentInteractions.slice(0, 6)) {
      lines.push(`### #${ix.index} (${ix.direction}, ${ix.timestamp ?? 'unknown'})`)
      if (ix.from_name) lines.push(`- from: ${ix.from_name}`)
      if (ix.subject) lines.push(`- subject: ${ix.subject}`)
      if (ix.body_excerpt) {
        lines.push('- body:')
        lines.push(truncate(ix.body_excerpt, 800) ?? '')
      }
    }
    lines.push('')
  }

  lines.push('# YOUR TASK')
  lines.push('')
  lines.push('Write the follow-up draft now. Output ONLY the JSON.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

export function validatePostTourSageOutput(
  raw: unknown,
): { ok: true; output: PostTourSageOutput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'top-level value is not an object' }
  }
  const r = raw as Record<string, unknown>
  if (typeof r.subject !== 'string') {
    return { ok: false, error: 'subject not string' }
  }
  if (typeof r.body !== 'string') {
    return { ok: false, error: 'body not string' }
  }
  if (typeof r.recommended_timing !== 'string') {
    return { ok: false, error: 'recommended_timing not string' }
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
      recommended_timing: r.recommended_timing,
      reasoning: r.reasoning,
      refusals: r.refusals as Array<{ field: string; reason: string }>,
    },
  }
}
