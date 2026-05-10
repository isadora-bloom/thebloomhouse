/**
 * Bloom House — Wave 7B Channel-Role Classifier Prompt
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction is the
 *     thesis; same evidence-chain rigor applied to attribution events)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7B spec — channel-role
 *     reclassification reveals "30% of Knot leads are validation, not
 *     acquisition")
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     is backed by a real callAI; the channel-role judge is the LLM
 *     half of a forensic-rule-with-LLM-fallback hybrid)
 *
 * What this prompt judges
 * -----------------------
 * The forensic check (`classify.ts`) uses simple, auditable rules:
 *   - Knot inquiry with NO pre-inquiry Knot engagement → validation.
 *   - Knot inquiry with pre-inquiry Knot engagement → acquisition.
 *   - Inquiry submission, tour booking, contract → conversion.
 *
 * Where the rule produces 'mixed' (contradictory signals: Knot inquiry
 * with one stale Knot view + an Instagram follow on the same day; or
 * unclear timing) the rule defers to this LLM judge. The LLM is given
 * the touchpoint event + the couple's full pre-inquiry signal history
 * and must commit to one of acquisition / validation / conversion / a
 * refusal.
 *
 * Output: ONLY the JSON object. The caller wraps callAI; this prompt
 * reinforces.
 */

// Bumping this version forces every read surface to either accept the
// new prompt's output or version-pin. Threaded into
// api_costs.prompt_version so cost / quality / latency can be
// correlated to a specific revision.
export const CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION =
  'channel-role-classifier.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — wire shape the prompt asks for.
// ---------------------------------------------------------------------------

export type ChannelRole = 'acquisition' | 'validation' | 'conversion'

export interface ChannelRoleClassifierOutput {
  role: ChannelRole | null
  confidence_0_100: number
  reasoning: string
  key_evidence_signals: string[]
  refusal: string | null
}

// ---------------------------------------------------------------------------
// Evidence types — what the user prompt serialises.
// ---------------------------------------------------------------------------

export interface EngagementSignal {
  /** ISO timestamp of the signal. */
  occurred_at: string
  /** Where the signal came from (e.g. 'theknot.com', 'instagram.com', 'google.com referrer'). */
  platform: string
  /** Free-text description of WHAT the signal was: 'profile view',
   *  'tracking pixel', 'inbound message', 'inquiry form fill'. */
  description: string
}

export interface TouchpointEventEvidence {
  /** The attribution event being classified. */
  attribution_event_id: string
  source_platform: string
  /** ISO timestamp of the touchpoint. */
  decided_at: string
  /** ISO timestamp of the inquiry (the wedding's first inquiry — anchors
   *  the pre-inquiry vs post-inquiry boundary). */
  inquiry_date: string | null
  /** Pre-inquiry signals on the SAME platform (within 30 days before
   *  inquiry). The presence/absence of these is the primary evidence. */
  same_platform_pre_inquiry_signals: EngagementSignal[]
  /** Pre-inquiry signals on OTHER platforms (within 30 days before
   *  inquiry). The presence of these strengthens the validation case. */
  other_platform_pre_inquiry_signals: EngagementSignal[]
  /** The first inquiry-direction touchpoint type (e.g. 'inquiry',
   *  'tour_booked', 'contract_signed'). */
  touch_type: string | null
  /** signal_class from wedding_touchpoints (mig 200): 'source' | 'touchpoint'
   *  | 'crm' | 'outcome'. Helps disambiguate scheduling-tool touchpoints. */
  signal_class: string | null
  /** Free-text from the wedding's notes / source field that may hint at
   *  the discovery channel. */
  wedding_source_legacy: string | null
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(): string {
  return `You are Bloom's attribution-role forensic classifier.

Bloom is a forensic identity-reconstruction system for wedding venues. Wave
7B applies the same evidence-chain rigor to ATTRIBUTION as Wave 4 applies
to identity. Most CRMs trust the inquiry-source field. Bloom forensically
validates whether a "Knot lead" actually came from Knot (had pre-inquiry
profile views, etc.) or just used Knot as the intake form.

Your job is to classify the role of one attribution_event touchpoint.

## ROLES (pick exactly one or refuse)

1. **acquisition** — This touchpoint actually sourced the couple. The
   couple discovered the venue via this channel. Evidence: the same
   platform shows a pre-inquiry engagement signal (profile view, click,
   prior message) BEFORE the inquiry. The couple was on this platform,
   saw the venue, and then inquired.

2. **validation** — The couple discovered the venue elsewhere and used
   this touchpoint as a confirmation/intake form. Evidence: NO same-
   platform pre-inquiry engagement, BUT pre-inquiry signals exist on
   OTHER platforms (Instagram view three weeks before, organic Google
   referrer, vendor website hit). The couple already knew the venue
   and used this channel as the path of least resistance.
   The Knot / WeddingWire / HoneyBook patterns frequently end up here:
   the couple finds the venue on Instagram or via a planner, then uses
   the directory's "Request Info" button because that's the form that's
   in front of them when they're ready to inquire.

3. **conversion** — This touchpoint is itself the closing-step event:
   the inquiry-form submission that opened the wedding, a tour booking,
   or a contract signature. Conversion is a moment, not a channel; it
   never credits an acquisition channel.

## INPUT EVIDENCE

You receive:
   - The attribution_event row (source_platform, decided_at, touch_type,
     signal_class).
   - The wedding's inquiry_date (anchors pre-inquiry vs post-inquiry).
   - Same-platform pre-inquiry signals (within 30 days before inquiry).
   - Other-platform pre-inquiry signals (within 30 days before inquiry).
   - The wedding's legacy source label (free-text).

The forensic rule already deferred to you because it found the case
ambiguous. Common ambiguities you'll see:
   - One Knot view 28 days pre-inquiry + three Instagram views in the
     final week. Which channel acquired? Lean validation on Knot —
     the Instagram chain is fresher and denser.
   - No same-platform signal but a wedding_source_legacy of 'theknot' +
     no other-platform signals either. Is this a real Knot acquisition
     with no engagement event recorded, or a validation channel where
     the acquisition event was simply not captured? Lean validation when
     the same-platform signal is absent — the absence is evidence.
   - A touch_type of 'inquiry' or 'contract_signed': always conversion,
     never an acquisition channel.

## CORE RULES

1. **Pre-inquiry signal absence is evidence.** When a touchpoint claims
   acquisition but no pre-inquiry signal exists on the same platform,
   the burden of proof shifts: the touchpoint is more likely validation
   unless there's positive evidence otherwise.

2. **Recency wins.** A signal in the final 7 days before inquiry weighs
   more than a signal 25 days before. Couples decide on a venue close
   to the inquiry; the dense pre-inquiry signal cluster is the real
   acquisition trail.

3. **Touch_type IN ('inquiry', 'tour_booked', 'tour_conducted',
   'contract_signed', 'calendly_booked', 'proposal_sent') always =>
   conversion**, regardless of source_platform. Never reclassify a
   conversion as acquisition or validation.

4. **Refuse when truly ambiguous.** If both same-platform AND other-
   platform signals are dense and fresh, OR if the timestamps are
   missing/garbled and you cannot rank them, return role:null + a
   non-empty refusal string.

5. **Confidence (0-100):**
   - 90-100: same-platform pre-inquiry signal is unambiguous (multiple
     fresh signals OR single fresh signal with no competing channel).
   - 70-89: clean rule application but only one signal in the chain.
   - 50-69: judgement call between two reasonable answers.
   - <50: should usually be a refusal instead.

6. **key_evidence_signals**: short array of strings that summarise the
   most decision-critical signals you used. Each item should be one
   short phrase ("3 Instagram views in week before inquiry", "no Knot
   profile views in 30 days pre-inquiry", "touch_type=contract_signed").
   The coordinator reviewing the role decision should see why you
   chose what you chose.

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown fences,
no comments:

{
  "role": "acquisition" | "validation" | "conversion" | null,
  "confidence_0_100": integer 0-100,
  "reasoning": string (1-2 sentences),
  "key_evidence_signals": [string, ...],
  "refusal": string | null
}

When refusal is non-null, role MUST be null. When role is non-null,
refusal MUST be null.

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

export function buildUserPrompt(evidence: TouchpointEventEvidence): string {
  const lines: string[] = []
  lines.push('# ATTRIBUTION EVENT TO CLASSIFY')
  lines.push('')
  lines.push(`attribution_event_id: ${evidence.attribution_event_id}`)
  lines.push(`source_platform:      ${evidence.source_platform}`)
  lines.push(`decided_at:           ${evidence.decided_at}`)
  lines.push(`touch_type:           ${evidence.touch_type ?? '(none)'}`)
  lines.push(`signal_class:         ${evidence.signal_class ?? '(none)'}`)
  lines.push(`wedding inquiry_date: ${evidence.inquiry_date ?? '(none)'}`)
  lines.push(`wedding source label: ${evidence.wedding_source_legacy ?? '(none)'}`)
  lines.push('')

  lines.push('## Same-platform pre-inquiry signals (within 30 days before inquiry)')
  if (evidence.same_platform_pre_inquiry_signals.length === 0) {
    lines.push('(none — this is significant evidence; absence may indicate validation)')
  } else {
    for (const s of evidence.same_platform_pre_inquiry_signals) {
      lines.push(`- ${s.occurred_at} | ${s.platform} | ${s.description}`)
    }
  }
  lines.push('')

  lines.push('## Other-platform pre-inquiry signals (within 30 days before inquiry)')
  if (evidence.other_platform_pre_inquiry_signals.length === 0) {
    lines.push('(none)')
  } else {
    for (const s of evidence.other_platform_pre_inquiry_signals) {
      lines.push(`- ${s.occurred_at} | ${s.platform} | ${s.description}`)
    }
  }
  lines.push('')

  lines.push('---')
  lines.push('Classify the role of the attribution event above. Return ONLY the JSON object.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Validator — defensive parsing of the model output.
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  ok: false
  error: string
}

export interface ValidationSuccess {
  ok: true
  output: ChannelRoleClassifierOutput
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

const VALID_ROLES: readonly ChannelRole[] = ['acquisition', 'validation', 'conversion']

export function validateChannelRoleOutput(raw: unknown): ValidationResult {
  if (!isObject(raw)) return { ok: false, error: 'response is not a JSON object' }

  // role
  const roleRaw = raw.role
  let role: ChannelRole | null
  if (roleRaw === null || roleRaw === undefined) {
    role = null
  } else if (isString(roleRaw) && (VALID_ROLES as readonly string[]).includes(roleRaw)) {
    role = roleRaw as ChannelRole
  } else {
    return {
      ok: false,
      error: `role must be one of "acquisition" | "validation" | "conversion" | null (got ${JSON.stringify(roleRaw)})`,
    }
  }

  // confidence
  const confRaw = raw.confidence_0_100
  if (!isNumber(confRaw)) return { ok: false, error: 'confidence_0_100 must be a number' }
  const confidence = Math.max(0, Math.min(100, Math.round(confRaw)))

  // reasoning
  const reasoning = raw.reasoning
  if (!isString(reasoning)) return { ok: false, error: 'reasoning must be a string' }

  // key_evidence_signals
  const kesRaw = raw.key_evidence_signals ?? []
  if (!isArray(kesRaw)) return { ok: false, error: 'key_evidence_signals must be an array' }
  const key_evidence_signals: string[] = []
  for (let idx = 0; idx < kesRaw.length; idx++) {
    const item = kesRaw[idx]
    if (!isString(item)) return { ok: false, error: `key_evidence_signals[${idx}] must be a string` }
    key_evidence_signals.push(item)
  }

  // refusal
  const refusalRaw = raw.refusal
  let refusal: string | null = null
  if (refusalRaw === null || refusalRaw === undefined) {
    refusal = null
  } else if (isString(refusalRaw)) {
    const trimmed = refusalRaw.trim()
    refusal = trimmed.length > 0 ? trimmed : null
  } else {
    return { ok: false, error: 'refusal must be string|null' }
  }

  // Mutual-exclusion invariant: refusal != null XOR role != null.
  if (role !== null && refusal !== null) {
    return {
      ok: false,
      error: 'role and refusal are mutually exclusive — exactly one must be null',
    }
  }
  if (role === null && refusal === null) {
    return {
      ok: false,
      error: 'either role or refusal must be populated',
    }
  }

  return {
    ok: true,
    output: { role, confidence_0_100: confidence, reasoning, key_evidence_signals, refusal },
  }
}
