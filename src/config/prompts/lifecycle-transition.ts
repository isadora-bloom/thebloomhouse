/**
 * Bloom House — Wave 11 lifecycle soft-transition judge prompt.
 *
 * Anchor docs (~/.claude memory/):
 *   - bloom-constitution.md (forensic identity reconstruction doctrine —
 *     the lifecycle backbone mirrors the same "evidence first, judgment
 *     second" frame; the judge gets evidence quotes, never raw bodies)
 *   - bloom-wave4-identity-reconstruction.md (mirror pattern: cheap
 *     Haiku for narrow judgments, Sonnet only for synthesis with
 *     full evidence)
 *   - feedback_deep_fix_vs_bandaid.md (LLM for soft/ambiguous; rules
 *     for clear — this prompt is the soft layer)
 *
 * WHAT THIS IS
 * ------------
 * Given a wedding's CURRENT lifecycle_stage + recent signals + couple
 * persona, decide whether to keep them in the current stage, advance
 * to a candidate stage, or refuse to judge (ambiguous evidence).
 *
 * Used by the sweep when a wedding is flagged as stage-stuck:
 *   - proposal_active, silent N days → judge "still alive in proposal
 *     OR moved to lost?"
 *   - booked, no planning activity 30d → judge "actually planning_active
 *     now OR still booked?"
 *   - post_event, no review 21d → judge "still post_event OR move to
 *     long_tail?"
 *
 * MODEL TIER: Haiku. The judgment is narrow + bounded — full Sonnet
 * is overkill. Cost target: ~$0.005 per judgment.
 *
 * NO BACK-TRACKING UNLESS STRONG EVIDENCE
 * ----------------------------------------
 * The judge is forbidden from moving a wedding backward through the
 * canonical ordering (e.g. proposal_active → nurture, booked →
 * proposal_active) unless evidence is overwhelming. Forward progression
 * is the safe direction; back-tracking confuses dashboards + dilutes
 * the intel feed. When evidence is back-tracking-shaped, the judge
 * must emit refusal_if_ambiguous and the sweep records auto_stuck.
 */

// Bumping this constant forces every consumer to either accept the new
// prompt's output or version-pin. Threaded into api_costs.prompt_version
// so a regression audit can correlate cost + quality + revision.
export const LIFECYCLE_TRANSITION_PROMPT_VERSION =
  'lifecycle-transition.prompt.v1'

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface LifecycleJudgeInput {
  current_stage: string
  candidate_stage: string
  days_in_current_stage: number
  stuck_threshold_days: number
  /** Short persona blurb from couple_intel.persona — voice-shape, never
   *  quotes sensitive evidence_quote verbatim. */
  persona_label?: string | null
  persona_description?: string | null
  /** Up to ~6 recent interactions, body excerpts truncated. */
  recent_interactions: Array<{
    direction: 'inbound' | 'outbound'
    days_ago: number
    subject: string | null
    body_excerpt: string | null
  }>
  /** Wedding-level signals the judge needs to weight (event date if any,
   *  most-recent inbound time, etc). */
  signals: Record<string, unknown>
}

export interface LifecycleJudgeOutput {
  recommended_stage: string
  confidence_0_100: number
  reasoning: string
  /** Non-null when the judge refused to decide. The sweep then records
   *  auto_stuck (current stage holds) rather than llm_judged. */
  refusal_if_ambiguous: string | null
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_LINES: string[] = [
  'You are the soft-transition judge for the Bloom House wedding venue',
  'lifecycle state machine. Your job: given a wedding currently in one',
  'stage who has been there longer than the stuck threshold, decide',
  'whether to KEEP them in the current stage or ADVANCE them to the',
  'candidate stage.',
  '',
  'The canonical 13 stages in forward order:',
  '  pre_touch, first_touch, nurture, tour_scheduled, tour_completed,',
  '  proposal_active, booked, planning_active, day_of, post_event,',
  '  long_tail, lost, cancelled.',
  '',
  '"lost" and "cancelled" are terminal off-ramps; "long_tail" is the',
  'long-after-event resting state.',
  '',
  'HARD RULES',
  '----------',
  '1. You may only emit a stage from the 13 listed above (or the',
  '   current_stage itself when keeping).',
  '2. You may NOT back-track (advance to a stage earlier in the forward',
  '   order than current_stage) unless evidence is overwhelming. If you',
  '   are tempted to back-track, fill refusal_if_ambiguous instead.',
  '3. When the evidence is ambiguous, set refusal_if_ambiguous and keep',
  '   the current stage. Holding is the safe action.',
  '4. Confidence floor for an ACTIVE advance is 70. Below 70, refuse.',
  '',
  'JUDGMENT GUIDE PER STUCK PATTERN',
  '--------------------------------',
  '- proposal_active stuck (silent N days):',
  '    Advance to "lost" only when recent inbound carries a polite-no',
  '    tone, a competing-venue mention, or platform-driven close',
  '    behavior. Keep "proposal_active" when the silence is consistent',
  '    with normal couple-planning cadence (busy weeks, holidays,',
  '    travel) and the persona suggests deliberation rather than',
  '    decline.',
  '- booked stuck (no planning activity for 30+ days):',
  '    Advance to "planning_active" when ANY signal points to active',
  '    planning (vendor outreach, deposit chasing, guest-list questions,',
  '    floor-plan asks). Keep "booked" when the silence is plausible',
  '    (event is far away, couple is in early-prep mode).',
  '- post_event stuck (no review for 21+ days):',
  '    Advance to "long_tail" when there is meaningful post-event',
  '    engagement (vendor thanks, gallery emails, referral mentions)',
  '    that suggests we are past the review-window. Keep "post_event"',
  '    when no signal exists yet — the venue still owes review',
  '    follow-up.',
  '',
  'OUTPUT FORMAT',
  '-------------',
  'Return a single JSON object with exactly these fields:',
  '  {',
  '    "recommended_stage": "<one of the 13 stages>",',
  '    "confidence_0_100": <integer 0-100>,',
  '    "reasoning": "<one paragraph, max 600 chars, voice-shape only,',
  '                 never quotes sensitive evidence verbatim>",',
  '    "refusal_if_ambiguous": "<null OR short explanation when you',
  '                            cannot decide>"',
  '  }',
  '',
  'No markdown, no code blocks, no extra fields. recommended_stage MUST',
  'be one of the 13 enumerated stages.',
]

export const LIFECYCLE_TRANSITION_SYSTEM_PROMPT =
  SYSTEM_PROMPT_LINES.join('\n')

// ---------------------------------------------------------------------------
// User-prompt builder
// ---------------------------------------------------------------------------

export function buildLifecycleJudgeUserPrompt(
  input: LifecycleJudgeInput,
): string {
  const lines: string[] = []
  lines.push('WEDDING UNDER JUDGMENT')
  lines.push('')
  lines.push('current_stage: ' + input.current_stage)
  lines.push('candidate_stage: ' + input.candidate_stage)
  lines.push(
    'days_in_current_stage: ' + Math.round(input.days_in_current_stage),
  )
  lines.push('stuck_threshold_days: ' + input.stuck_threshold_days)
  lines.push('')
  if (input.persona_label || input.persona_description) {
    lines.push('PERSONA')
    if (input.persona_label) lines.push('  label: ' + input.persona_label)
    if (input.persona_description)
      lines.push('  description: ' + truncate(input.persona_description, 400))
    lines.push('')
  }
  lines.push('SIGNALS')
  for (const [k, v] of Object.entries(input.signals)) {
    lines.push('  ' + k + ': ' + serialize(v))
  }
  lines.push('')
  lines.push('RECENT INTERACTIONS')
  if (input.recent_interactions.length === 0) {
    lines.push('  (none in window)')
  } else {
    for (let i = 0; i < input.recent_interactions.length; i++) {
      const ix = input.recent_interactions[i]
      lines.push(
        '  [' +
          i +
          '] ' +
          ix.direction +
          ' ' +
          Math.round(ix.days_ago) +
          ' days ago — ' +
          (ix.subject ? truncate(ix.subject, 120) : '(no subject)'),
      )
      if (ix.body_excerpt) {
        lines.push('      excerpt: ' + truncate(ix.body_excerpt, 280))
      }
    }
  }
  lines.push('')
  lines.push('Return JSON only.')
  return lines.join('\n')
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '...' : t
}

function serialize(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return v.length > 140 ? v.slice(0, 140) + '...' : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v).slice(0, 200)
  } catch {
    return String(v)
  }
}
