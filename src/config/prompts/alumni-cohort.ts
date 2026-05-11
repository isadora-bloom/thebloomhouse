/**
 * Bloom House — Wave 14 alumni-cohort prompt.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction is the
 *     thesis; aggregation NEVER discloses individual identity)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. Per-couple
 *     evidence stays gated; archetype rollups are operator-safe)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be backed by a real callAI; alumni archetypes are a Sonnet
 *     synthesis, not a template + enum lookup)
 *
 * What this prompt does
 * ---------------------
 * Reads ALL booked weddings at a venue + their couple_identity_profile +
 * couple_intel + outcomes (booked_at, booking_value, days_to_book), then
 * Sonnet aggregates them into ARCHETYPES. Each archetype is an LLM-
 * discovered label (NOT enum) that captures one distinct booked-couple
 * profile observed at THIS venue.
 *
 * Per-venue, not cross-venue: the archetype labels at Rixey will be
 * different from the labels at Hawthorne — they share a methodology
 * but the venue's data shapes its own cohort distinctions.
 *
 * AGGREGATE-ONLY CONTRACT
 * -----------------------
 * The output NEVER names a specific couple. The model gets the input as
 * aggregated stats (persona_label histogram, days-to-book distribution,
 * occupation distribution, etc.) plus a small sample of de-identified
 * voice principles per persona. The model's output is the archetype +
 * its conversion signature + voice principles + outcome summary — at
 * NO point does it list "Maya & Tom" or "the Williams wedding".
 *
 * Cost target: ~$0.10-$0.20 per venue refresh (one Sonnet call).
 *
 * Wave 22 (2026-05-11) bias remediation
 * -------------------------------------
 * v1 ship listed 6 archetype example labels in the system prompt.
 * Wave 21 audit (PROMPT-BIAS-AUDIT.md finding #14) found those examples
 * cascaded across Wave 5A/5B/5D and 14, anchoring the model on the same
 * names. v2 imports the shape-only PERSONA_STYLE_GUIDE constant. Output
 * schema is unchanged.
 */

import { PERSONA_STYLE_GUIDE } from '@/config/prompts/persona-style-guide'

// Bumping this constant forces every consumer to either accept the new
// prompt's output or version-pin. Threaded into api_costs.prompt_version
// so a regression audit can correlate cost + quality + revision.
//
// v1 → v2 (Wave 22, 2026-05-11): strip archetype example list; import
// PERSONA_STYLE_GUIDE. Per PROMPT-BIAS-AUDIT.md finding #14.
export const ALUMNI_COHORT_PROMPT_VERSION = 'alumni-cohort.prompt.v2'

// ---------------------------------------------------------------------------
// Public types — mirror the wire JSON the prompt asks for.
// ---------------------------------------------------------------------------

export interface AlumniConversionSignature {
  typical_first_touch_to_booked_days: number | null
  typical_inquiry_channel_distribution: Record<string, number>
  typical_decision_dynamics: string | null
}

export interface AlumniOutcomeSummary {
  typical_booking_value_cents: number | null
  typical_guest_count: number | null
  repeat_referral_likelihood: 'high' | 'medium' | 'low' | 'unknown'
  notes: string | null
}

export interface AlumniArchetype {
  label: string
  description: string
  booked_count: number
  representative_persona_labels: string[]
  conversion_signature: AlumniConversionSignature
  voice_principles: string[]
  outcome_summary: AlumniOutcomeSummary
}

export interface AlumniCohortOutput {
  archetypes: AlumniArchetype[]
  refusals: Array<{ field: string; reason: string }>
}

// ---------------------------------------------------------------------------
// Evidence types — what the user prompt serialises.
// ---------------------------------------------------------------------------

/**
 * Per-couple summary fed into the cohort prompt. The model sees this
 * shape per booked couple — NO names, NO emails, NO evidence_quotes
 * (those stay gated at the per-couple layer). The persona_label +
 * descriptive themes + booking shape are enough to discover archetypes.
 */
export interface AlumniCoupleSummary {
  /** Synthetic index, no PII (e.g. "couple_001"). */
  index: string
  persona_label: string | null
  /** Theme names only (no quotes). Sensitive themes appear as the
   *  literal theme string (e.g. "grief", "family_conflict"). */
  emotional_truth_themes: string[]
  /** Occupation strings, partner-anonymised. */
  occupations: string[]
  /** Residence as "city, state" or "state" or null. */
  residence: string | null
  /** Cultural signal labels (the LLM-extracted signal field, not quote). */
  cultural_signal_labels: string[]
  /** Decision dynamics descriptor (who_decides etc., merged to one
   *  short phrase). */
  decision_dynamics: string | null
  /** Inquiry source (channel label, e.g. "knot", "calendly", "referral"). */
  inquiry_source: string | null
  /** Days from inquiry_date → booked_at. NULL if either is missing. */
  days_to_book: number | null
  /** Estimated guest count. */
  guest_count: number | null
  /** Booking value in cents. */
  booking_value_cents: number | null
}

export interface AlumniCohortEvidence {
  venueId: string
  venueLabel: string | null
  totalBookedCouples: number
  couples: AlumniCoupleSummary[]
  /** Pre-aggregated stats for the model. */
  aggregates: {
    persona_distribution: Record<string, number>
    inquiry_source_distribution: Record<string, number>
    days_to_book_buckets: Record<string, number>
    booking_value_buckets: Record<string, number>
    guest_count_buckets: Record<string, number>
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(): string {
  return `You are Bloom's alumni-cohort archetype synthesizer.

Bloom is a forensic identity-reconstruction system for wedding venues.
Wave 4 produces the per-couple forensic profile. Wave 5A produces the
per-couple intel + persona. Your Wave 14 job is to aggregate ACROSS
all booked couples at this venue and discover ARCHETYPES — distinct
booked-couple profiles that share conversion signature, voice
principles, and outcome shape.

## CORE RULES

1. **Aggregate-only. NEVER name a specific couple.** The output is
   archetype labels + their signatures + voice principles. NO names,
   NO evidence_quotes, NO references to "couple_001 was a grief case".
   Voice principles describe HOW to handle the archetype, not WHO
   embodied it.

2. **Archetype labels are DISCOVERED, not picked from an enum.** Let
   the data shape the labels. Follow the style guide; no candidate
   labels are listed on purpose. (Archetype labels at THIS venue should
   reflect THIS venue's data — labels you produce here may differ from
   labels another venue's cohort would produce, and that's correct.)

${PERSONA_STYLE_GUIDE}

3. **Number of archetypes scales with the data.**
   - <5 booked couples → 1-2 archetypes max (insufficient signal for
     cohort discrimination; add a refusal explaining the limit).
   - 5-15 booked couples → 2-4 archetypes.
   - 15-50 booked couples → 3-6 archetypes.
   - 50+ → up to 8 archetypes.
   Each archetype must cover at least 2 booked couples (booked_count
   ≥ 2). Single-couple archetypes are not cohorts; they're outliers
   and belong in refusals.

4. **Each archetype carries:**
   - label (2-5 words, evocative)
   - description (1-2 sentences explaining what makes this archetype
     distinct at THIS venue)
   - booked_count (how many of the booked couples fit this archetype)
   - representative_persona_labels (the Wave-5A persona labels most
     associated with this archetype — copy from the input distribution)
   - conversion_signature: typical_first_touch_to_booked_days (median),
     typical_inquiry_channel_distribution (channel → count), and
     typical_decision_dynamics (e.g. "single decision-maker", "two-
     parents-involved", "couple-led")
   - voice_principles (3-7 imperative-shape strings — how Sage should
     speak to a fresh lead matching this archetype). Each principle
     is operator-actionable, not abstract. Examples:
       "lead with the multigenerational lawn package, not the modern
        loft"
       "do not push tour timing — they decide on their own clock"
       "reference the heritage tour offering early in the first
        response"
   - outcome_summary: typical_booking_value_cents (median),
     typical_guest_count (median), repeat_referral_likelihood
     ('high'/'medium'/'low'/'unknown' based on past referral signal),
     notes (one short string for anything notable)

5. **Conversion signature is grounded in the aggregates you receive.**
   The user prompt includes pre-computed distributions (persona,
   inquiry source, days-to-book buckets, booking value buckets, guest
   count buckets). Reference those numbers. Don't invent.

6. **Voice principles are LLM-derived, not generic.** "Be friendly"
   is too generic to ship. "Reference their dog by name in the second
   email, they always mention pets first" is specific (assuming the
   data supports it). Lean on the persona_label + emotional themes +
   decision dynamics from the cohort.

7. **Refusals are the audit trail.** When the booked-couple set is too
   small for cohort discrimination, when an archetype emerged but
   covers only 1 couple, or when a persona dominates so heavily that
   no second cohort can form, add a refusal entry: { field, reason }.
   Be specific.

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown fences,
no comments:

{
  "archetypes": [
    {
      "label": string,
      "description": string,
      "booked_count": integer,
      "representative_persona_labels": [string],
      "conversion_signature": {
        "typical_first_touch_to_booked_days": integer or null,
        "typical_inquiry_channel_distribution": { channel_name: count },
        "typical_decision_dynamics": string or null
      },
      "voice_principles": [string],
      "outcome_summary": {
        "typical_booking_value_cents": integer or null,
        "typical_guest_count": integer or null,
        "repeat_referral_likelihood": "high" | "medium" | "low" | "unknown",
        "notes": string or null
      }
    }
  ],
  "refusals": [
    { "field": string, "reason": string }
  ]
}

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

// ---------------------------------------------------------------------------
// User prompt — serialise the evidence aggregates + de-identified couples.
// ---------------------------------------------------------------------------

function recordToBullets(rec: Record<string, number>): string[] {
  const entries = Object.entries(rec).sort((a, b) => b[1] - a[1])
  return entries.map(([k, v]) => `  - ${k}: ${v}`)
}

export function buildUserPrompt(evidence: AlumniCohortEvidence): string {
  const lines: string[] = []
  const { venueLabel, totalBookedCouples, couples, aggregates } = evidence

  lines.push('# VENUE ALUMNI COHORT DERIVATION')
  lines.push('')
  if (venueLabel) lines.push(`Venue: ${venueLabel}`)
  lines.push(`Total booked couples in scope: ${totalBookedCouples}`)
  lines.push('')

  lines.push('## Aggregate distributions (use these to ground the cohort signatures)')
  lines.push('')
  lines.push('### Persona-label distribution (Wave-5A labels)')
  lines.push(...recordToBullets(aggregates.persona_distribution))
  lines.push('')
  lines.push('### Inquiry-source distribution')
  lines.push(...recordToBullets(aggregates.inquiry_source_distribution))
  lines.push('')
  lines.push('### Days-to-book buckets')
  lines.push(...recordToBullets(aggregates.days_to_book_buckets))
  lines.push('')
  lines.push('### Booking-value buckets')
  lines.push(...recordToBullets(aggregates.booking_value_buckets))
  lines.push('')
  lines.push('### Guest-count buckets')
  lines.push(...recordToBullets(aggregates.guest_count_buckets))
  lines.push('')

  lines.push('## De-identified per-couple summaries')
  lines.push('')
  lines.push('Each entry is one booked couple. NO names, NO quotes. Use these')
  lines.push('to discover archetypes; do NOT echo back any specific couple in')
  lines.push('your output.')
  lines.push('')
  for (const c of couples) {
    lines.push(`- ${c.index}:`)
    if (c.persona_label) lines.push(`    persona_label: ${c.persona_label}`)
    if (c.emotional_truth_themes.length > 0) {
      lines.push(`    emotional_themes: ${c.emotional_truth_themes.join(', ')}`)
    }
    if (c.occupations.length > 0) {
      lines.push(`    occupations: ${c.occupations.join(', ')}`)
    }
    if (c.residence) lines.push(`    residence: ${c.residence}`)
    if (c.cultural_signal_labels.length > 0) {
      lines.push(`    cultural_signals: ${c.cultural_signal_labels.join(', ')}`)
    }
    if (c.decision_dynamics) lines.push(`    decision_dynamics: ${c.decision_dynamics}`)
    if (c.inquiry_source) lines.push(`    inquiry_source: ${c.inquiry_source}`)
    if (c.days_to_book !== null) lines.push(`    days_to_book: ${c.days_to_book}`)
    if (c.guest_count !== null) lines.push(`    guest_count: ${c.guest_count}`)
    if (c.booking_value_cents !== null) {
      lines.push(`    booking_value: $${(c.booking_value_cents / 100).toFixed(0)}`)
    }
  }
  lines.push('')
  lines.push('---')
  lines.push('Return ONLY the JSON described in the system prompt.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const REFERRAL_LIKELIHOOD_VALUES = ['high', 'medium', 'low', 'unknown'] as const

export type AlumniValidationResult =
  | { ok: true; output: AlumniCohortOutput }
  | { ok: false; error: string }

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function isStringNumberRecord(v: unknown): v is Record<string, number> {
  if (!v || typeof v !== 'object') return false
  return Object.values(v as Record<string, unknown>).every(
    (x) => typeof x === 'number' && Number.isFinite(x),
  )
}

export function validateAlumniCohortOutput(value: unknown): AlumniValidationResult {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'not an object' }
  }
  const obj = value as Record<string, unknown>
  const archetypesRaw = obj.archetypes
  if (!Array.isArray(archetypesRaw)) {
    return { ok: false, error: 'archetypes must be an array' }
  }
  const refusalsRaw = obj.refusals
  if (!Array.isArray(refusalsRaw)) {
    return { ok: false, error: 'refusals must be an array' }
  }

  const archetypes: AlumniArchetype[] = []
  for (let i = 0; i < archetypesRaw.length; i++) {
    const a = archetypesRaw[i]
    if (!a || typeof a !== 'object') {
      return { ok: false, error: `archetypes[${i}] not an object` }
    }
    const rec = a as Record<string, unknown>
    if (typeof rec.label !== 'string' || rec.label.trim().length === 0) {
      return { ok: false, error: `archetypes[${i}].label missing` }
    }
    if (typeof rec.description !== 'string' || rec.description.trim().length === 0) {
      return { ok: false, error: `archetypes[${i}].description missing` }
    }
    if (typeof rec.booked_count !== 'number' || rec.booked_count < 0) {
      return { ok: false, error: `archetypes[${i}].booked_count invalid` }
    }
    if (!isStringArray(rec.representative_persona_labels)) {
      return {
        ok: false,
        error: `archetypes[${i}].representative_persona_labels must be string[]`,
      }
    }
    if (!isStringArray(rec.voice_principles)) {
      return { ok: false, error: `archetypes[${i}].voice_principles must be string[]` }
    }
    const cs = rec.conversion_signature as Record<string, unknown> | undefined
    if (!cs || typeof cs !== 'object') {
      return { ok: false, error: `archetypes[${i}].conversion_signature missing` }
    }
    const csDays = cs.typical_first_touch_to_booked_days
    if (csDays !== null && (typeof csDays !== 'number' || !Number.isFinite(csDays))) {
      return {
        ok: false,
        error: `archetypes[${i}].conversion_signature.typical_first_touch_to_booked_days invalid`,
      }
    }
    if (!isStringNumberRecord(cs.typical_inquiry_channel_distribution)) {
      return {
        ok: false,
        error: `archetypes[${i}].conversion_signature.typical_inquiry_channel_distribution invalid`,
      }
    }
    const csDynamics = cs.typical_decision_dynamics
    if (csDynamics !== null && typeof csDynamics !== 'string') {
      return {
        ok: false,
        error: `archetypes[${i}].conversion_signature.typical_decision_dynamics invalid`,
      }
    }
    const os = rec.outcome_summary as Record<string, unknown> | undefined
    if (!os || typeof os !== 'object') {
      return { ok: false, error: `archetypes[${i}].outcome_summary missing` }
    }
    const osVal = os.typical_booking_value_cents
    if (osVal !== null && (typeof osVal !== 'number' || !Number.isFinite(osVal))) {
      return { ok: false, error: `archetypes[${i}].outcome_summary.typical_booking_value_cents invalid` }
    }
    const osGuests = os.typical_guest_count
    if (osGuests !== null && (typeof osGuests !== 'number' || !Number.isFinite(osGuests))) {
      return { ok: false, error: `archetypes[${i}].outcome_summary.typical_guest_count invalid` }
    }
    const osLikelihood = os.repeat_referral_likelihood
    if (
      typeof osLikelihood !== 'string' ||
      !(REFERRAL_LIKELIHOOD_VALUES as ReadonlyArray<string>).includes(osLikelihood)
    ) {
      return { ok: false, error: `archetypes[${i}].outcome_summary.repeat_referral_likelihood invalid` }
    }
    const osNotes = os.notes
    if (osNotes !== null && typeof osNotes !== 'string') {
      return { ok: false, error: `archetypes[${i}].outcome_summary.notes invalid` }
    }

    archetypes.push({
      label: rec.label.trim(),
      description: rec.description.trim(),
      booked_count: Math.round(rec.booked_count),
      representative_persona_labels: rec.representative_persona_labels,
      conversion_signature: {
        typical_first_touch_to_booked_days: csDays === null ? null : Math.round(csDays as number),
        typical_inquiry_channel_distribution: cs.typical_inquiry_channel_distribution as Record<
          string,
          number
        >,
        typical_decision_dynamics: csDynamics === null ? null : (csDynamics as string),
      },
      voice_principles: rec.voice_principles,
      outcome_summary: {
        typical_booking_value_cents: osVal === null ? null : Math.round(osVal as number),
        typical_guest_count: osGuests === null ? null : Math.round(osGuests as number),
        repeat_referral_likelihood: osLikelihood as 'high' | 'medium' | 'low' | 'unknown',
        notes: osNotes === null ? null : (osNotes as string),
      },
    })
  }

  const refusals: Array<{ field: string; reason: string }> = []
  for (let i = 0; i < refusalsRaw.length; i++) {
    const r = refusalsRaw[i]
    if (!r || typeof r !== 'object') {
      return { ok: false, error: `refusals[${i}] not an object` }
    }
    const rec = r as Record<string, unknown>
    if (typeof rec.field !== 'string' || typeof rec.reason !== 'string') {
      return { ok: false, error: `refusals[${i}] missing field/reason` }
    }
    refusals.push({ field: rec.field, reason: rec.reason })
  }

  return { ok: true, output: { archetypes, refusals } }
}
