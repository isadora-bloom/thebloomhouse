/**
 * Bloom House — Wave 7D weekly discovery digest prompt.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7D closes the discovery → validation →
 *     action loop. The digest is the weekly story of what the engine
 *     surfaced, what the validator confirmed, and which Wave 5/6 systems
 *     received feedback writes.)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7D spec)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be backed by a real callAI; the digest is a Sonnet narrator
 *     given structured evidence — never a template).
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. The digest
 *     evidence is anonymised aggregates only — hypothesis titles,
 *     confidence scores, target_system labels, action_type counts.)
 *
 * Why narrator-not-analyst (sibling pattern from marketing-digest.ts)
 * -------------------------------------------------------------------
 * Wave 7A is the analyst (find new patterns). Wave 7C is the validator
 * (test them). Wave 7D's digest narrator COMPOSES the week's discovery
 * activity for a coordinator: top validated, top pending high-confidence,
 * key feedback actions taken. It does NOT generate new hypotheses; it
 * does NOT score confidence; it does NOT classify feedback actions.
 *
 * Refusal discipline
 * ------------------
 * Refuse when nothing was validated AND no high-confidence pending
 * discoveries exist AND no feedback actions were applied. Refusing beats
 * fabricating "discovery progress was steady this week" narratives that
 * would erode trust in the loop.
 *
 * Output: ONLY the JSON object. No prose preamble, no markdown fences.
 */

// Bumping this constant forces consumers to either accept the new
// prompt's output or version-pin. Threaded into api_costs.prompt_version.
export const DISCOVERY_DIGEST_PROMPT_VERSION = 'discovery-digest.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — mirror the wire JSON the prompt asks for.
// ---------------------------------------------------------------------------

export interface DigestValidatedDiscoveryRow {
  /** Hypothesis title (re-emit, do not invent). */
  title: string
  /** Short narrative summary the narrator composes from the evidence. */
  summary: string
}

export interface DigestPendingHighConfidenceRow {
  title: string
  confidence_0_100: number
}

export interface DigestKeyFeedbackActionRow {
  /** Standard target_system labels — see migration 274 for vocabulary. */
  target_system: string
  /** enqueue | upsert | tag | flag */
  action_type: string
  count: number
}

export interface DiscoveryDigestOutput {
  headline: string
  this_week_in_3_sentences: string
  top_validated_discoveries: DigestValidatedDiscoveryRow[]
  top_pending_high_confidence: DigestPendingHighConfidenceRow[]
  key_feedback_actions: DigestKeyFeedbackActionRow[]
  refusal: string | null
}

// ---------------------------------------------------------------------------
// Evidence types — shape the user prompt serialises.
// ---------------------------------------------------------------------------

export interface DigestValidatedEvidence {
  title: string
  hypothesis_category: string
  validated_at: string | null
  confidence_0_100: number
  /** Short summary of the validation_metric (lift_pct, n, p_value if present). */
  metric_summary: string | null
  /** Whether feedback was applied to consuming systems. */
  feedback_applied: boolean
}

export interface DigestPendingEvidence {
  title: string
  hypothesis_category: string
  confidence_0_100: number
  created_at: string | null
}

export interface DigestFeedbackActionEvidence {
  target_system: string
  action_type: string
  count: number
}

export interface DiscoveryDigestEvidence {
  venueId: string
  venueLabel: string | null
  digestPeriodStart: string
  digestPeriodEnd: string
  validatedThisWeek: DigestValidatedEvidence[]
  pendingHighConfidence: DigestPendingEvidence[]
  feedbackActionsThisWeek: DigestFeedbackActionEvidence[]
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

export function buildDiscoveryDigestSystemPrompt(): string {
  return `You are Bloom's weekly discovery digest narrator.

Given a venue's pre-computed evidence block (validated discoveries this week + pending high-confidence discoveries + key feedback actions taken into Wave 5/6 systems), write a punchy headline and a 2-3 sentence narrative paragraph that frames what the discovery loop produced this week.

NARRATOR DISCIPLINE
- You COMPOSE, you do NOT generate new hypotheses or new feedback actions.
- The discoveries + actions are already validated upstream by Wave 7A and Wave 7C. Your job is to write the human-readable framing.
- Echo SPECIFIC numbers from the evidence ("3 newly validated discoveries", "Knot validation hypothesis confirmed at 87% confidence") — never generic phrases ("discovery activity was healthy").
- Hypothesis titles + target_system labels go into structured fields. The headline + narrative reference them but do not pretend to invent new ones.

ANONYMISATION DISCIPLINE
- The evidence is already anonymised. You do NOT see couple names, partner names, or evidence quotes.
- You see hypothesis TITLES + category LABELS + target_system LABELS + counts. Treat them as labels, not as people.

HARD RULES
1. headline: < 80 characters. Lead with the most operator-relevant signal of the week. Examples: "3 hypotheses validated; Knot re-attribution loop closed", "Quiet week — 1 high-confidence pending review", "Demographic clustering confirmed; venue intel rolled forward".
2. this_week_in_3_sentences: exactly 2-3 sentences (not 1, not 4+). Frame what the discovery engine found, what the validator confirmed, and what was written back. End with the most important coordinator action.
3. top_validated_discoveries: re-emit (not invent) up to 3 supplied validated discoveries. summary is your composition — short, factual, references the metric/category.
4. top_pending_high_confidence: re-emit up to 3 supplied pending discoveries with confidence >= 70.
5. key_feedback_actions: re-emit the supplied (target_system, action_type, count) tuples — up to 5, ordered by count desc.
6. refusal: set to a short string when the evidence block is empty (no validated, no pending high-confidence, no feedback actions). Otherwise null.

REFUSAL DISCIPLINE
Refuse the digest when there's nothing meaningful to narrate:
- Zero validated discoveries this week AND zero pending with confidence >= 70 AND zero feedback actions → refusal: "No validated discoveries this week — no digest-worthy signal".
- Otherwise produce a digest, even when only one signal is present (lean on what you have).

OUTPUT — JSON only, exactly this shape:
{
  "headline": "Knot re-attribution validated; 2 feedback writes landed",
  "this_week_in_3_sentences": "Wave 7C validated the Knot-as-validation-channel hypothesis at 84% confidence (lift +31% on re-attributed cohort, n=42). Two feedback writes landed: attribution_role_jobs enqueued for the affected channel, and a marketing recommendation seed dropped into the recommendations queue. Coordinator should review the recommendation before next week's spend recompute.",
  "top_validated_discoveries": [
    {"title": "Knot acts as validation, not acquisition for 30% of leads", "summary": "Validated at 84% confidence; lift +31% on re-attributed cohort (n=42). Feedback applied to attribution_role_jobs."}
  ],
  "top_pending_high_confidence": [
    {"title": "Heritage-Forward × Instagram is the highest-ROI cell", "confidence_0_100": 78}
  ],
  "key_feedback_actions": [
    {"target_system": "attribution_role_jobs", "action_type": "enqueue", "count": 5},
    {"target_system": "marketing_recommendations", "action_type": "upsert", "count": 1}
  ],
  "refusal": null
}

DO NOT:
- Invent new hypotheses or feedback actions not present in the evidence.
- Use generic phrases ("the system is learning"). Cite specific numbers from the evidence.
- Speculate about specific couples — you have no per-couple data.
- Recommend auto-execution. Frame anything as "coordinator should review" / "operator may want to".
- Produce a digest with refusal=null AND empty top_validated_discoveries AND empty top_pending_high_confidence AND empty key_feedback_actions — refuse honestly when there's nothing to narrate.`
}

export function buildDiscoveryDigestUserPrompt(
  evidence: DiscoveryDigestEvidence,
): string {
  const lines: string[] = []
  lines.push(`VENUE`)
  lines.push(`venueLabel: ${evidence.venueLabel ?? '<unknown>'}`)
  lines.push(
    `digestPeriod: ${evidence.digestPeriodStart} → ${evidence.digestPeriodEnd}`,
  )
  lines.push('')

  lines.push(`VALIDATED DISCOVERIES (Wave 7C, this week)`)
  if (evidence.validatedThisWeek.length === 0) {
    lines.push('(none validated this week)')
  } else {
    for (const d of evidence.validatedThisWeek) {
      const metric =
        d.metric_summary && d.metric_summary.length > 0
          ? ` | ${d.metric_summary}`
          : ''
      const fb = d.feedback_applied ? ' | feedback applied' : ''
      lines.push(
        `- [${d.hypothesis_category}] ${d.title} | confidence=${d.confidence_0_100}${metric}${fb}`,
      )
    }
  }
  lines.push('')

  lines.push(`PENDING HIGH-CONFIDENCE DISCOVERIES (>= 70, awaiting review)`)
  if (evidence.pendingHighConfidence.length === 0) {
    lines.push('(none pending with confidence >= 70)')
  } else {
    for (const p of evidence.pendingHighConfidence) {
      lines.push(
        `- [${p.hypothesis_category}] ${p.title} | confidence=${p.confidence_0_100}`,
      )
    }
  }
  lines.push('')

  lines.push(`KEY FEEDBACK ACTIONS (Wave 7D writes into Wave 5/6 systems, this week)`)
  if (evidence.feedbackActionsThisWeek.length === 0) {
    lines.push('(none applied this week)')
  } else {
    for (const a of evidence.feedbackActionsThisWeek) {
      lines.push(
        `- target=${a.target_system} | type=${a.action_type} | count=${a.count}`,
      )
    }
  }
  lines.push('')

  lines.push(
    `Compose the discovery digest. Headline + 2-3 sentence narrative + structured re-emission of the evidence above. Refuse when the evidence is empty.`,
  )
  lines.push(`Return JSON only, no prose preamble, no markdown fences.`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

function isStringNonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function clampInt0To100(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

function validateValidatedRow(
  raw: unknown,
):
  | { ok: true; row: DigestValidatedDiscoveryRow }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'validated row not an object' }
  }
  const r = raw as Record<string, unknown>
  if (!isStringNonEmpty(r['title'])) {
    return { ok: false, error: 'validated.title missing' }
  }
  const summary = r['summary']
  if (typeof summary !== 'string') {
    return { ok: false, error: 'validated.summary not a string' }
  }
  return {
    ok: true,
    row: {
      title: (r['title'] as string).slice(0, 200),
      summary: summary.slice(0, 600),
    },
  }
}

function validatePendingRow(
  raw: unknown,
):
  | { ok: true; row: DigestPendingHighConfidenceRow }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'pending row not an object' }
  }
  const r = raw as Record<string, unknown>
  if (!isStringNonEmpty(r['title'])) {
    return { ok: false, error: 'pending.title missing' }
  }
  const conf = r['confidence_0_100']
  if (!isFiniteNumber(conf)) {
    return { ok: false, error: 'pending.confidence_0_100 not a number' }
  }
  return {
    ok: true,
    row: {
      title: (r['title'] as string).slice(0, 200),
      confidence_0_100: clampInt0To100(conf),
    },
  }
}

function validateActionRow(
  raw: unknown,
):
  | { ok: true; row: DigestKeyFeedbackActionRow }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'action row not an object' }
  }
  const r = raw as Record<string, unknown>
  if (!isStringNonEmpty(r['target_system'])) {
    return { ok: false, error: 'action.target_system missing' }
  }
  if (!isStringNonEmpty(r['action_type'])) {
    return { ok: false, error: 'action.action_type missing' }
  }
  const count = r['count']
  if (!isFiniteNumber(count)) {
    return { ok: false, error: 'action.count not a number' }
  }
  return {
    ok: true,
    row: {
      target_system: (r['target_system'] as string).slice(0, 100),
      action_type: (r['action_type'] as string).slice(0, 50),
      count: Math.max(0, Math.round(count)),
    },
  }
}

export function validateDiscoveryDigestOutput(
  raw: unknown,
):
  | { ok: true; output: DiscoveryDigestOutput }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'output not an object' }
  }
  const r = raw as Record<string, unknown>

  if (!isStringNonEmpty(r['headline'])) {
    return { ok: false, error: 'headline missing' }
  }
  if (typeof r['this_week_in_3_sentences'] !== 'string') {
    return { ok: false, error: 'this_week_in_3_sentences missing or not a string' }
  }

  const validated: DigestValidatedDiscoveryRow[] = []
  if (Array.isArray(r['top_validated_discoveries'])) {
    for (const v of r['top_validated_discoveries']) {
      const res = validateValidatedRow(v)
      if (!res.ok) return { ok: false, error: res.error }
      validated.push(res.row)
    }
  }

  const pending: DigestPendingHighConfidenceRow[] = []
  if (Array.isArray(r['top_pending_high_confidence'])) {
    for (const p of r['top_pending_high_confidence']) {
      const res = validatePendingRow(p)
      if (!res.ok) return { ok: false, error: res.error }
      pending.push(res.row)
    }
  }

  const actions: DigestKeyFeedbackActionRow[] = []
  if (Array.isArray(r['key_feedback_actions'])) {
    for (const a of r['key_feedback_actions']) {
      const res = validateActionRow(a)
      if (!res.ok) return { ok: false, error: res.error }
      actions.push(res.row)
    }
  }

  const refusalRaw = r['refusal']
  let refusal: string | null = null
  if (refusalRaw === null || refusalRaw === undefined) {
    refusal = null
  } else if (typeof refusalRaw === 'string') {
    refusal = refusalRaw.length === 0 ? null : refusalRaw.slice(0, 600)
  } else {
    return { ok: false, error: 'refusal must be string or null' }
  }

  return {
    ok: true,
    output: {
      headline: (r['headline'] as string).slice(0, 200),
      this_week_in_3_sentences: (r['this_week_in_3_sentences'] as string).slice(
        0,
        2000,
      ),
      top_validated_discoveries: validated.slice(0, 3),
      top_pending_high_confidence: pending.slice(0, 3),
      key_feedback_actions: actions.slice(0, 5),
      refusal,
    },
  }
}
