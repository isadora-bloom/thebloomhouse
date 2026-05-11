/**
 * Bloom House — Wave 5A per-couple intel synthesis prompt.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5A is the action layer derived from
 *     the forensic identity record; voice-shape only, never quotes
 *     sensitive evidence_quote verbatim)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5A spec: per-couple
 *     persona + close-prob + recommended action + coordinator brief +
 *     sensitivity flags + stale-signal alerts)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be backed by a real callAI; this prompt is a Sonnet
 *     synthesizer, not a template)
 *
 * Different LLM job from Wave 4
 * -----------------------------
 * Wave 4 is forensic extraction with verbatim evidence_quote per claim.
 * Wave 5A is synthesis: it READS profile.evidence_quote values to
 * ground its reasoning but produces voice-shape output (paragraphs,
 * persona labels, action recommendations, coaching). The
 * coordinator_brief NEVER quotes a sensitive evidence_quote verbatim.
 *
 * Persona discipline
 * ------------------
 * The persona label is DISCOVERED from data, not picked from an enum.
 * If labels drift wildly across couples, Wave 5B will cluster them
 * post-hoc — this prompt just stores what the model produced.
 *
 * Wave 22 (2026-05-11) bias remediation
 * -------------------------------------
 * v1 of this prompt enumerated 8 persona-label examples in the system
 * prompt. Wave 21 audit (PROMPT-BIAS-AUDIT.md) found those examples
 * were anchoring the model — the same labels cascaded across Wave 5B
 * cohort-rollup, Wave 5D venue-thesis, and Wave 14 alumni-cohort
 * because each prompt independently primed the same names. v2 replaces
 * the example list with a shape-only PERSONA_STYLE_GUIDE constant
 * shared across all four persona-producing prompts. Output schema is
 * unchanged.
 */

import type { CoupleIdentityProfile } from '@/config/prompts/identity-reconstruction'
import { PERSONA_STYLE_GUIDE } from '@/config/prompts/persona-style-guide'

// Bumping this constant forces every consumer to either accept the new
// prompt's output or version-pin. Threaded into api_costs.prompt_version
// so a regression audit can correlate cost + quality + revision.
//
// v1 → v2 (Wave 22, 2026-05-11): strip example persona-label list; import
// shape-only PERSONA_STYLE_GUIDE. Bias remediation per PROMPT-BIAS-AUDIT.md.
export const COUPLE_INTEL_DERIVE_PROMPT_VERSION =
  'couple-intel-derive.prompt.v2'

// ---------------------------------------------------------------------------
// Public types — mirror the wire JSON the prompt asks for.
// ---------------------------------------------------------------------------

export interface PredictedCloseProbability {
  pct_0_100: number
  reasoning: string
  key_signals: string[]
  confidence_0_100: number
}

export interface PersonaBlock {
  label: string
  description: string
  confidence_0_100: number
}

export interface RecommendedNextAction {
  action: string
  timing: string
  reasoning: string
}

export interface SensitivityFlag {
  category: string
  handle_with: string
}

export interface StaleSignalAlert {
  signal: string
  since: string
  suggested_action: string
}

export interface IntelRefusalEntry {
  field: string
  reason: string
}

export interface CoupleIntelOutput {
  predicted_close_probability: PredictedCloseProbability
  persona: PersonaBlock
  recommended_next_action: RecommendedNextAction
  coordinator_brief: string
  sensitivity_flags: SensitivityFlag[]
  stale_signal_alerts: StaleSignalAlert[]
  refusals: IntelRefusalEntry[]
}

// ---------------------------------------------------------------------------
// Evidence types — what the user prompt serialises.
// ---------------------------------------------------------------------------

export interface IntelInteractionEvidence {
  index: number
  direction: 'inbound' | 'outbound'
  from_email: string | null
  from_name: string | null
  subject: string | null
  body_excerpt: string | null
  timestamp: string | null
}

export interface IntelWeddingShell {
  inquiry_date: string | null
  wedding_date: string | null
  status: string | null
  source: string | null
  guest_count_estimate: number | null
  booking_value_cents: number | null
  notes: string | null
  days_since_inquiry: number | null
  days_since_last_inbound: number | null
}

export interface IntelTourStatus {
  has_tour: boolean
  scheduled_at: string | null
  outcome: string | null
}

export interface IntelPaymentStatus {
  total_paid_cents: number
  contract_signed: boolean
  last_payment_at: string | null
}

export interface CoupleIntelEvidence {
  weddingId: string
  venueLabel: string | null
  weddingShell: IntelWeddingShell
  profile: CoupleIdentityProfile
  recentInteractions: IntelInteractionEvidence[]
  tour: IntelTourStatus
  payment: IntelPaymentStatus
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(): string {
  return `You are Bloom's per-couple intelligence synthesizer.

Bloom is a forensic identity-reconstruction system for wedding venues.
Wave 4 produced the forensic profile (WHO this couple is). Your job is
Wave 5A: derive WHAT TO DO for this specific couple right now. You read
the structured profile + wedding shell + recent interactions + tour /
payment status, and produce six concrete outputs that drive coordinator
action and inbox triage:

  1. Close-probability prediction (0-100) with reasoning + key signals
  2. Persona label DISCOVERED from this couple's signals
  3. Recommended next action with timing
  4. Coordinator brief (~80-150 words, voice-shape paragraph)
  5. Sensitivity flags (category + handle_with coaching)
  6. Stale-signal alerts (silent threads with pending concerns)

## CORE RULES

1. **Voice-shape, never raw evidence.** The coordinator_brief and
   handle_with fields read like a colleague briefing you before a
   call. NEVER quote a sensitive evidence_quote verbatim — paraphrase
   the GIST with appropriate softening. Sensitive themes are: medical,
   grief, financial_stress, family_conflict, mental_health. The raw
   evidence_quote stays in couple_identity_profile and is gated by
   venue_config.feature_flags.reveal_sensitive_themes; your output
   surfaces in coordinator UIs that may render to operators who do
   NOT have that flag enabled. Voice-shape only.

2. **Persona is discovered, not picked from an enum.** Invent a label
   that captures what makes THIS couple distinct. Follow the style
   guide below; no candidate labels are listed on purpose.

${PERSONA_STYLE_GUIDE}

   If two couples share the same archetype the labels should converge
   naturally from the data; if they diverge that's a Wave 5B clustering
   problem, not yours.

3. **Predicted close probability is an integer 0-100.** Ground it in
   specific signals from the evidence. key_signals is 2-5 specific,
   evidence-grounded phrases (not paraphrases of the rubric). Examples:
     - "tour scheduled within 2 weeks of inquiry"
     - "asked about payment plans (commitment signal)"
     - "9-day silence since their pricing question"
     - "decision-dynamics show single decision-maker (faster close)"
   Confidence is a separate 0-100 — how certain you are about the
   prediction itself, regardless of its value.

4. **Recommended action is imperative + specific.** Not "follow up"
   but "send follow-up with bar-package walkthrough". Timing is a
   plain-English window: "within 4 hours", "today", "tomorrow morning",
   "next week". Reasoning explains why this action right now.

5. **Coordinator brief is one paragraph (~80-150 words).** Includes:
     - who they are (paraphrased identity, not raw evidence_quote)
     - what they've shared (themes, not verbatim quotes for sensitive)
     - what concerns they have
     - how to handle them
     - what NOT to do
   Reads like a colleague's hallway briefing before a phone call.
   Plain prose, no bullet points, no markdown.

6. **Sensitivity flags pull from profile.emotional_truths where
   sensitive=true.** category is the theme (e.g. "grief", "medical",
   "family_conflict"). handle_with is the COACHING (e.g. "let them
   lead the pace; do not ask about the wedding date until they
   re-raise it", "this couple is grieving — keep tone gentle, no
   exclamation marks, do not push for a tour until they offer one").
   NEVER include the evidence_quote.

7. **Stale-signal alerts surface silent threads with pending
   concerns.** Format: { signal: "the concern they raised",
   since: "human-readable date", suggested_action: "what to do" }.
   Examples:
     - "asked about bar package, no response, 14d silent → re-engage
       with bar walkthrough offer"
     - "tour cancelled with no reschedule, 21d silent → check in,
       offer Tuesday slot"
   If no stale signals, return [].

8. **Refusals are the audit trail.** When a field cannot be derived
   from the evidence (e.g. profile is empty, no interactions, no
   sensitive themes), do NOT fabricate. Add a refusal entry instead
   ({ field, reason }) and use a defensible default for the field
   (close-prob 0 with reasoning="insufficient evidence", persona
   label="Insufficient Signal", brief explaining what's missing).

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown fences,
no comments:

{
  "predicted_close_probability": {
    "pct_0_100": integer 0-100,
    "reasoning": string,
    "key_signals": [string],
    "confidence_0_100": integer 0-100
  },
  "persona": {
    "label": string,
    "description": string,
    "confidence_0_100": integer 0-100
  },
  "recommended_next_action": {
    "action": string,
    "timing": string,
    "reasoning": string
  },
  "coordinator_brief": string,
  "sensitivity_flags": [
    { "category": string, "handle_with": string }
  ],
  "stale_signal_alerts": [
    { "signal": string, "since": string, "suggested_action": string }
  ],
  "refusals": [
    { "field": string, "reason": string }
  ]
}

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

// ---------------------------------------------------------------------------
// User prompt — serialise the evidence with section headers.
// ---------------------------------------------------------------------------

const MAX_INTERACTION_BODY_CHARS = 1200
const MAX_INTERACTIONS = 10

function truncate(text: string | null, max: number): string | null {
  if (!text) return null
  if (text.length <= max) return text
  return text.slice(0, max) + '\n[...truncated]'
}

export function buildUserPrompt(evidence: CoupleIntelEvidence): string {
  const lines: string[] = []
  const { weddingShell: shell, profile, recentInteractions, tour, payment } = evidence

  lines.push('# COUPLE TO DERIVE INTEL FOR')
  lines.push('')
  lines.push(`Wedding ID: ${evidence.weddingId}`)
  if (evidence.venueLabel) lines.push(`Venue: ${evidence.venueLabel}`)
  lines.push('')

  // ---- Wedding shell ----
  lines.push('## Wedding shell')
  lines.push(`- inquiry_date: ${shell.inquiry_date ?? '(none)'}`)
  lines.push(`- wedding_date: ${shell.wedding_date ?? '(none)'}`)
  lines.push(`- status: ${shell.status ?? '(none)'}`)
  lines.push(`- source: ${shell.source ?? '(none)'}`)
  lines.push(`- guest_count_estimate: ${shell.guest_count_estimate ?? '(none)'}`)
  if (shell.booking_value_cents !== null) {
    lines.push(`- booking_value: $${(shell.booking_value_cents / 100).toFixed(2)}`)
  } else {
    lines.push('- booking_value: (none)')
  }
  if (shell.days_since_inquiry !== null) {
    lines.push(`- days_since_inquiry: ${shell.days_since_inquiry}`)
  }
  if (shell.days_since_last_inbound !== null) {
    lines.push(`- days_since_last_inbound: ${shell.days_since_last_inbound}`)
  }
  if (shell.notes && shell.notes.trim()) {
    lines.push('- notes:')
    lines.push(truncate(shell.notes, 600) ?? '')
  }
  lines.push('')

  // ---- Tour + payment status ----
  lines.push('## Commitment status')
  lines.push(`- tour_scheduled: ${tour.has_tour}`)
  if (tour.scheduled_at) lines.push(`- tour_scheduled_at: ${tour.scheduled_at}`)
  if (tour.outcome) lines.push(`- tour_outcome: ${tour.outcome}`)
  lines.push(`- contract_signed: ${payment.contract_signed}`)
  lines.push(`- total_paid: $${(payment.total_paid_cents / 100).toFixed(2)}`)
  if (payment.last_payment_at) lines.push(`- last_payment_at: ${payment.last_payment_at}`)
  lines.push('')

  // ---- Forensic profile (Wave 4 output) ----
  lines.push('## Forensic identity profile (from couple_identity_profile)')
  lines.push('')
  lines.push('### Names')
  if (profile.names.partner1) {
    const p1 = profile.names.partner1
    const name = [p1.first, p1.last].filter(Boolean).join(' ') || '(no name)'
    lines.push(`- partner1: ${name} (confidence ${p1.confidence_0_100}%)`)
  } else {
    lines.push('- partner1: (no claim)')
  }
  if (profile.names.is_phantom_partner_relationship) {
    lines.push('- partner2: (phantom — single decision-maker)')
  } else if (profile.names.partner2) {
    const p2 = profile.names.partner2
    const name = [p2.first, p2.last].filter(Boolean).join(' ') || '(no name)'
    lines.push(`- partner2: ${name} (confidence ${p2.confidence_0_100}%)`)
  } else {
    lines.push('- partner2: (no claim)')
  }
  lines.push(`- name_quality: ${profile.names.name_quality}`)
  lines.push('')

  if (profile.emotional_truths.length > 0) {
    lines.push('### Emotional truths')
    for (const t of profile.emotional_truths) {
      const tag = t.sensitive ? ' [SENSITIVE]' : ''
      lines.push(`- ${t.theme}${tag} (${t.confidence_0_100}%): "${t.evidence_quote}"`)
    }
    lines.push('')
  }

  if (profile.occupations.length > 0) {
    lines.push('### Occupations')
    for (const o of profile.occupations) {
      lines.push(`- ${o.partner_role}: ${o.occupation} ("${o.evidence_quote}")`)
    }
    lines.push('')
  }

  if (profile.residence) {
    lines.push('### Residence')
    const place = [profile.residence.city, profile.residence.state]
      .filter(Boolean)
      .join(', ')
    lines.push(`- ${place || '(no city/state)'}`)
    if (profile.residence.evidence_quote) {
      lines.push(`  evidence: "${profile.residence.evidence_quote}"`)
    }
    lines.push('')
  }

  if (profile.family_dynamics.length > 0) {
    lines.push('### Family dynamics')
    for (const f of profile.family_dynamics) {
      lines.push(`- ${f.relationship}: ${f.signal} ("${f.evidence_quote}")`)
    }
    lines.push('')
  }

  if (profile.vendor_preferences.length > 0) {
    lines.push('### Vendor preferences')
    for (const v of profile.vendor_preferences) {
      lines.push(`- ${v.vendor_type}: ${v.preference} ("${v.evidence_quote}")`)
    }
    lines.push('')
  }

  if (profile.handles.length > 0) {
    lines.push('### Cross-platform handles')
    for (const h of profile.handles) {
      lines.push(`- ${h.platform}: ${h.handle}`)
    }
    lines.push('')
  }

  if (profile.accessibility_needs.length > 0) {
    lines.push('### Accessibility needs')
    for (const a of profile.accessibility_needs) {
      lines.push(`- ${a.need} ("${a.evidence_quote}")`)
    }
    lines.push('')
  }

  if (profile.cultural_signals.length > 0) {
    lines.push('### Cultural signals')
    for (const c of profile.cultural_signals) {
      lines.push(`- ${c.signal} ("${c.evidence_quote}")`)
    }
    lines.push('')
  }

  if (profile.relationship_history) {
    lines.push('### Relationship history')
    if (profile.relationship_history.length_signal) {
      lines.push(`- length: ${profile.relationship_history.length_signal}`)
    }
    if (profile.relationship_history.prior_engagement_signal) {
      lines.push(`- prior_engagement: ${profile.relationship_history.prior_engagement_signal}`)
    }
    lines.push('')
  }

  if (profile.decision_dynamics) {
    lines.push('### Decision dynamics')
    if (profile.decision_dynamics.who_decides) {
      lines.push(`- decides: ${profile.decision_dynamics.who_decides}`)
    }
    if (profile.decision_dynamics.who_questions) {
      lines.push(`- questions: ${profile.decision_dynamics.who_questions}`)
    }
    if (profile.decision_dynamics.who_negotiates) {
      lines.push(`- negotiates: ${profile.decision_dynamics.who_negotiates}`)
    }
    lines.push('')
  }

  // ---- Recent interactions (last 10) ----
  const picked = recentInteractions.slice(0, MAX_INTERACTIONS)
  lines.push(`## Recent interactions (last ${picked.length}, most-recent-first)`)
  if (picked.length === 0) {
    lines.push('(no interactions)')
  } else {
    for (const i of picked) {
      lines.push(`### Interaction ${i.index} | ${i.direction} | ${i.timestamp ?? '(no time)'}`)
      lines.push(`From: ${i.from_name ?? '(no name)'} <${i.from_email ?? '(no email)'}>`)
      lines.push(`Subject: ${i.subject ?? '(no subject)'}`)
      lines.push('Body:')
      lines.push(truncate(i.body_excerpt, MAX_INTERACTION_BODY_CHARS) ?? '(no body)')
      lines.push('')
    }
  }

  lines.push('---')
  lines.push('Derive the per-couple intel synthesis. Return ONLY the JSON.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Manual schema validator
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  ok: false
  error: string
}

export interface ValidationSuccess {
  ok: true
  intel: CoupleIntelOutput
}

export type ValidationResult = ValidationSuccess | ValidationFailure

function isString(v: unknown): v is string {
  return typeof v === 'string'
}
function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v)
}

function clampInt0to100(v: unknown): number {
  const n = isNumber(v) ? v : Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

export function validateCoupleIntelOutput(raw: unknown): ValidationResult {
  if (!isObject(raw)) return { ok: false, error: 'response is not a JSON object' }

  // predicted_close_probability
  const pcp = raw.predicted_close_probability
  if (!isObject(pcp)) {
    return { ok: false, error: 'predicted_close_probability must be an object' }
  }
  if (!isString(pcp.reasoning)) {
    return { ok: false, error: 'predicted_close_probability.reasoning must be string' }
  }
  const keySignalsRaw = pcp.key_signals ?? []
  if (!isArray(keySignalsRaw)) {
    return { ok: false, error: 'predicted_close_probability.key_signals must be array' }
  }
  const key_signals: string[] = []
  for (let i = 0; i < keySignalsRaw.length; i++) {
    const k = keySignalsRaw[i]
    if (!isString(k)) {
      return { ok: false, error: `predicted_close_probability.key_signals[${i}] must be string` }
    }
    key_signals.push(k)
  }
  const predicted: PredictedCloseProbability = {
    pct_0_100: clampInt0to100(pcp.pct_0_100),
    reasoning: pcp.reasoning,
    key_signals,
    confidence_0_100: clampInt0to100(pcp.confidence_0_100),
  }

  // persona
  const personaRaw = raw.persona
  if (!isObject(personaRaw)) {
    return { ok: false, error: 'persona must be an object' }
  }
  if (!isString(personaRaw.label) || !personaRaw.label.trim()) {
    return { ok: false, error: 'persona.label must be a non-empty string' }
  }
  if (!isString(personaRaw.description)) {
    return { ok: false, error: 'persona.description must be string' }
  }
  const persona: PersonaBlock = {
    label: personaRaw.label.trim(),
    description: personaRaw.description,
    confidence_0_100: clampInt0to100(personaRaw.confidence_0_100),
  }

  // recommended_next_action
  const rnaRaw = raw.recommended_next_action
  if (!isObject(rnaRaw)) {
    return { ok: false, error: 'recommended_next_action must be an object' }
  }
  if (!isString(rnaRaw.action)) {
    return { ok: false, error: 'recommended_next_action.action must be string' }
  }
  if (!isString(rnaRaw.timing)) {
    return { ok: false, error: 'recommended_next_action.timing must be string' }
  }
  if (!isString(rnaRaw.reasoning)) {
    return { ok: false, error: 'recommended_next_action.reasoning must be string' }
  }
  const recommended_next_action: RecommendedNextAction = {
    action: rnaRaw.action,
    timing: rnaRaw.timing,
    reasoning: rnaRaw.reasoning,
  }

  // coordinator_brief
  if (!isString(raw.coordinator_brief)) {
    return { ok: false, error: 'coordinator_brief must be string' }
  }
  const coordinator_brief = raw.coordinator_brief

  // sensitivity_flags
  const sfRaw = raw.sensitivity_flags ?? []
  if (!isArray(sfRaw)) {
    return { ok: false, error: 'sensitivity_flags must be array' }
  }
  const sensitivity_flags: SensitivityFlag[] = []
  for (let i = 0; i < sfRaw.length; i++) {
    const s = sfRaw[i]
    if (!isObject(s)) {
      return { ok: false, error: `sensitivity_flags[${i}] must be object` }
    }
    if (!isString(s.category)) {
      return { ok: false, error: `sensitivity_flags[${i}].category must be string` }
    }
    if (!isString(s.handle_with)) {
      return { ok: false, error: `sensitivity_flags[${i}].handle_with must be string` }
    }
    sensitivity_flags.push({ category: s.category, handle_with: s.handle_with })
  }

  // stale_signal_alerts
  const ssaRaw = raw.stale_signal_alerts ?? []
  if (!isArray(ssaRaw)) {
    return { ok: false, error: 'stale_signal_alerts must be array' }
  }
  const stale_signal_alerts: StaleSignalAlert[] = []
  for (let i = 0; i < ssaRaw.length; i++) {
    const s = ssaRaw[i]
    if (!isObject(s)) {
      return { ok: false, error: `stale_signal_alerts[${i}] must be object` }
    }
    if (!isString(s.signal)) {
      return { ok: false, error: `stale_signal_alerts[${i}].signal must be string` }
    }
    if (!isString(s.since)) {
      return { ok: false, error: `stale_signal_alerts[${i}].since must be string` }
    }
    if (!isString(s.suggested_action)) {
      return { ok: false, error: `stale_signal_alerts[${i}].suggested_action must be string` }
    }
    stale_signal_alerts.push({
      signal: s.signal,
      since: s.since,
      suggested_action: s.suggested_action,
    })
  }

  // refusals
  const refRaw = raw.refusals ?? []
  if (!isArray(refRaw)) {
    return { ok: false, error: 'refusals must be array' }
  }
  const refusals: IntelRefusalEntry[] = []
  for (let i = 0; i < refRaw.length; i++) {
    const r = refRaw[i]
    if (!isObject(r)) {
      return { ok: false, error: `refusals[${i}] must be object` }
    }
    if (!isString(r.field)) {
      return { ok: false, error: `refusals[${i}].field must be string` }
    }
    if (!isString(r.reason)) {
      return { ok: false, error: `refusals[${i}].reason must be string` }
    }
    refusals.push({ field: r.field, reason: r.reason })
  }

  return {
    ok: true,
    intel: {
      predicted_close_probability: predicted,
      persona,
      recommended_next_action,
      coordinator_brief,
      sensitivity_flags,
      stale_signal_alerts,
      refusals,
    },
  }
}
