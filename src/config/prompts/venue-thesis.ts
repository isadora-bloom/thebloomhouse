/**
 * Bloom House — Wave 5D venue-thesis synthesizer prompt.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5D auto-generates a venue's "thesis" once
 *     ~50 reconstructions have landed; the venue's identity reconstructed
 *     FROM the data so onboarding is never blank)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5D spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose; the thesis
 *     reads anonymised cohort summaries and never names couples or
 *     quotes evidence)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be backed by a real callAI; this prompt is the Sonnet
 *     synthesizer behind the venue thesis dashboard)
 *
 * Different LLM job from Wave 4 / 5A / 5B / 5C
 * --------------------------------------------
 * Wave 4 = forensic extraction. 5A = per-couple synthesis. 5B = cohort
 * pattern synthesis. 5C = per-couple AND per-cohort signal matching.
 * 5D is STRATEGIC IDENTITY synthesis — what is this venue, in one
 * paragraph, based on its data? It reads the 5A/5B/5C substrate (NOT
 * raw evidence) and produces a venue-archetype-and-strategy doc the
 * operator reads on their first day.
 *
 * Persona / archetype discipline
 * ------------------------------
 * The venue_archetype label is INVENTED by the LLM, NOT chosen from an
 * enum. Examples that might emerge: "Heritage-Forward Family Estate",
 * "Cost-Conscious Outdoor Venue", "Cultural-Celebration Specialist",
 * "Multi-Generational Garden Wedding". The over_indexed_personas come
 * from the Wave 5A persona_label distribution we pass in — the model
 * may use those labels but should not invent personas not present in
 * the cohort.
 *
 * Privacy
 * -------
 * The user prompt receives ONLY aggregates: persona distribution,
 * close-prob distribution, source distribution, sensitive-theme counts,
 * cohort_rollup output, attribution-events role distribution. NO
 * couple-level rows. No partner names. No evidence_quote strings.
 */

// Bumping this constant forces every consumer to either accept the new
// prompt's output or version-pin. Threaded into api_costs.prompt_version
// so a regression audit can correlate cost + quality + revision.
export const VENUE_THESIS_PROMPT_VERSION = 'venue-thesis.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — mirror the wire JSON the prompt asks for.
// ---------------------------------------------------------------------------

export interface VenueArchetype {
  /** LLM-invented label, NOT an enum. Examples: "Heritage-Forward Family
   *  Estate", "Cost-Conscious Outdoor Venue", "Cultural-Celebration
   *  Specialist". */
  label: string
  description: string
  /** A 1-3 sentence prose summary of the data shape that produced the
   *  archetype. */
  evidence_summary: string
  confidence_0_100: number
}

export interface OverIndexedPersona {
  persona_label: string
  /** This venue's share of cohort that carries this persona, 0-100. */
  share_pct: number
  /** Optional: market baseline share if cross-venue context was
   *  provided. NULL when the venue is the first in the system or no
   *  cross-venue baseline was passed. */
  vs_market_baseline_pct: number | null
  evidence: string
}

export interface RecurringEmotionalLandscape {
  theme: string
  n_couples: number
  /** Aggregate paragraph — never names couples, never quotes evidence. */
  non_sensitive_summary: string
}

export interface ConversionSignal {
  signal: string
  /** Multiplicative lift vs venue baseline (e.g. 70 = 1.7x). May be
   *  negative for a drag. */
  lift_pct: number
  evidence: string
}

export interface VoiceThesis {
  tone_descriptors: string[]
  language_that_lands: string[]
  language_to_avoid: string[]
  key_principles: string[]
}

export interface ServiceDemandStrength {
  offering: string
  demand_signal: string
}

export interface ServiceDemandGap {
  missing_offering: string
  evidence_of_demand: string
  investment_recommendation: string
}

export interface VenueThesisRefusal {
  field: string
  reason: string
}

export interface VenueThesisOutput {
  venue_archetype: VenueArchetype
  over_indexed_personas: OverIndexedPersona[]
  recurring_emotional_landscape: RecurringEmotionalLandscape[]
  conversion_signature: ConversionSignal[]
  voice_thesis: VoiceThesis
  service_demand_strengths: ServiceDemandStrength[]
  service_demand_gaps: ServiceDemandGap[]
  /** 1 paragraph the operator reads to understand "what their venue
   *  actually is" — like a colleague's strategic read. ≤120 words. */
  operator_brief_paragraph: string
  /** Echoed back from the input for symmetry; equals the
   *  cohortSizeAtGeneration the caller passed in. */
  cohort_size_at_generation: number
  refusals: VenueThesisRefusal[]
}

// ---------------------------------------------------------------------------
// Evidence types — what the user prompt serialises.
// ---------------------------------------------------------------------------

export interface PersonaDistributionEntry {
  persona_label: string
  share_pct: number
  n_couples: number
}

export interface CloseProbBucket {
  /** Bucket label e.g. "0-20", "20-40". */
  bucket: string
  n_couples: number
}

export interface SourceDistributionEntry {
  source: string
  n_couples: number
}

export interface ChannelRoleDistributionEntry {
  channel: string
  acquisition: number
  validation: number
  conversion: number
  mixed: number
  unknown: number
}

export interface PersonaChannelRollupSummary {
  channel: string
  persona_label: string | null
  n_inquiries: number
  n_booked: number
  conversion_pct: number | null
  cac_cents: number | null
}

export interface CohortRollupSummary {
  emerging_themes_top: Array<{
    theme: string
    trend: string
    evidence_count: number
  }>
  conversion_correlations_top: Array<{
    signal: string
    outcome: string
    lift_pct: number
    n_couples: number
  }>
  voice_calibration_personas: string[]
  service_demand_top: Array<{
    service_or_offering: string
    demand_signal: string
    currently_offered: string
  }>
  timing_patterns_top: Array<{
    pattern: string
  }>
}

export interface VenueThesisEvidence {
  venueId: string
  venueLabel: string | null
  venueState: string | null
  cohortSizeAtGeneration: number
  windowDays: number
  /** Wave 5A per-couple persona distribution. */
  personaDistribution: PersonaDistributionEntry[]
  /** Bucketed predicted_close_probability_pct distribution. */
  closeProbDistribution: CloseProbBucket[]
  /** wedding.source distribution. */
  sourceDistribution: SourceDistributionEntry[]
  /** Cohort-level sensitive-theme COUNTS (no quotes, no couple ids). */
  sensitivityCounts: Record<string, number>
  /** Wave 5B cohort-rollup summary (emerging themes / conversion
   *  correlations / voice calibration / service demand / timing). */
  cohortRollupSummary: CohortRollupSummary | null
  /** attribution_events role distribution per channel. */
  channelRoleDistribution: ChannelRoleDistributionEntry[]
  /** persona_channel_rollups summary (top cells). */
  personaChannelTop: PersonaChannelRollupSummary[]
  /** Optional cross-venue persona-distribution baseline. NULL on first
   *  venue / single-tenant launch. */
  marketPersonaBaseline: PersonaDistributionEntry[] | null
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildVenueThesisSystemPrompt(): string {
  return `You're Bloom's venue thesis synthesizer.

Bloom is a forensic identity-reconstruction system for wedding venues.
Wave 4 produced the per-couple forensic profile. Wave 5A produced the
per-couple action layer. Wave 5B produced the venue-cohort rollup. Wave
5C surfaced external-signal matches. Wave 6A/6B produced the channel
attribution and persona×channel rollups. Your job is Wave 5D: read the
aggregated substrate and produce a "venue thesis" — a strategic
synthesis of what this venue actually IS based on its data.

The thesis is what the operator reads on their first venue login. They
should walk away with: "I now understand who books here, what they
care about, what voice resonates, what we're missing." Without this,
onboarding is blank — they're staring at a CRM. With this, Bloom has
already told them what they over-index on.

## CORE RULES

1. **Aggregate ≠ disclose.** You see ONLY anonymised aggregates:
   persona shares, theme counts, attribution role distributions, cohort
   rollup output. You will NOT see couple names. You will NOT see
   evidence quotes. The recurring_emotional_landscape entries report
   COUNTS + non_sensitive_summary only. Never name a couple. Never
   echo a sensitive evidence quote (you don't have any).

2. **The venue_archetype label is invented, not chosen.** There is no
   pre-defined enum. Read the data and synthesise a label that captures
   the venue's strategic identity. Examples that might emerge: "Heritage-
   Forward Family Estate", "Cost-Conscious Outdoor Venue", "Cultural-
   Celebration Specialist", "Multi-Generational Garden Wedding",
   "Destination-Adjacent Boutique". The label should be 2-6 words,
   evocative, and grounded in the data shape.

3. **over_indexed_personas should reuse Wave 5A labels.** The user
   prompt lists the persona distribution discovered by Wave 5A. Pick
   the personas with the highest share or the largest delta vs market
   baseline (when present). Do NOT invent persona labels that no couple
   in this cohort carries.

4. **vs_market_baseline_pct is NULL when no baseline was provided.**
   On the first venue in the system or when cross-venue context isn't
   available, set vs_market_baseline_pct=null rather than fabricating
   a baseline.

5. **conversion_signature is what makes their bookings.** From Wave
   5B's conversion_correlations + persona_channel_rollups + close-prob
   distribution, extract 3-5 signals that correlate with booking. Each
   carries a lift_pct vs baseline + an evidence sentence. Examples:
   - "Tour booked within 7d of inquiry" / lift_pct=80 / "21 of 38
     booked couples toured within 7 days vs 6 of 47 lost couples"
   - "Heritage-Forward persona via vendor referral" / lift_pct=120 /
     "12 of 14 vendor-referral inquiries with this persona booked"

6. **voice_thesis aggregates Wave 5B's voice_calibration.** Pull
   tone_descriptors from the cohort's emerging emotional themes (e.g.
   "warm acknowledgement of family dynamics", "specific not aspirational
   language"). Pull language_that_lands + language_to_avoid from the
   per-persona voice calibrations (consolidate across personas).
   key_principles is 3-5 short rules ("Lead with the venue's heritage,
   not the photo gallery").

7. **service_demand_strengths and gaps separate offered-and-loved from
   missing-but-asked-for.** Strengths are demand signals where the venue
   already delivers (their cohort's stated preferences match what the
   venue offers — an asset to lean into). Gaps are missing offerings
   the cohort asks for. From Wave 5B's service_demand_map + non_sensitive
   themes.

8. **operator_brief_paragraph is what reads on first login.** ≤120
   words. Not bullet-list, not preamble — a paragraph a colleague
   would write to brief the new operator. Lead with the archetype.
   Anchor in 2-3 specific data points. Close with the most actionable
   gap or strength.

9. **Refusals are the audit trail.** When you cannot derive a section
   (cohort too small, evidence too sparse, market baseline absent), add
   an entry { field, reason } and emit an empty value rather than
   fabricate. The cohort threshold for a real thesis is ~30 couples;
   below that, refuse all but the basics.

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown fences:

{
  "venue_archetype": {
    "label": string,
    "description": string,
    "evidence_summary": string,
    "confidence_0_100": integer 0-100
  },
  "over_indexed_personas": [
    {
      "persona_label": string,
      "share_pct": number,
      "vs_market_baseline_pct": number | null,
      "evidence": string
    }
  ],
  "recurring_emotional_landscape": [
    {
      "theme": string,
      "n_couples": integer,
      "non_sensitive_summary": string
    }
  ],
  "conversion_signature": [
    {
      "signal": string,
      "lift_pct": number,
      "evidence": string
    }
  ],
  "voice_thesis": {
    "tone_descriptors": [string],
    "language_that_lands": [string],
    "language_to_avoid": [string],
    "key_principles": [string]
  },
  "service_demand_strengths": [
    { "offering": string, "demand_signal": string }
  ],
  "service_demand_gaps": [
    {
      "missing_offering": string,
      "evidence_of_demand": string,
      "investment_recommendation": string
    }
  ],
  "operator_brief_paragraph": string,
  "cohort_size_at_generation": integer,
  "refusals": [
    { "field": string, "reason": string }
  ]
}

Every array MAY be empty. Refusals is the audit trail of every section
you couldn't fill. Fill it generously rather than fabricate.

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

// ---------------------------------------------------------------------------
// User prompt — serialise the cohort with section headers.
// ---------------------------------------------------------------------------

function fmtCounts(counts: Record<string, number>): string[] {
  const entries = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
  return entries.map(([k, v]) => `  - ${k}: ${v}`)
}

export function buildVenueThesisUserPrompt(
  evidence: VenueThesisEvidence,
): string {
  const lines: string[] = []

  lines.push('# VENUE TO SYNTHESISE')
  lines.push('')
  if (evidence.venueLabel) lines.push(`Venue: ${evidence.venueLabel}`)
  if (evidence.venueState) lines.push(`State: ${evidence.venueState}`)
  lines.push(`Cohort window: last ${evidence.windowDays} days`)
  lines.push(`Cohort size at generation: ${evidence.cohortSizeAtGeneration}`)
  lines.push('')

  // ---- Persona distribution (Wave 5A) ----
  lines.push('## Persona distribution (Wave 5A — anonymised)')
  if (evidence.personaDistribution.length === 0) {
    lines.push('(none — refuse over_indexed_personas)')
  } else {
    for (const p of evidence.personaDistribution) {
      lines.push(
        `- ${p.persona_label}: share=${p.share_pct}% n=${p.n_couples}`,
      )
    }
  }
  lines.push('')

  // ---- Market baseline (cross-venue) ----
  if (
    evidence.marketPersonaBaseline &&
    evidence.marketPersonaBaseline.length > 0
  ) {
    lines.push('## Market baseline persona distribution (cross-venue)')
    for (const p of evidence.marketPersonaBaseline) {
      lines.push(
        `- ${p.persona_label}: market_share=${p.share_pct}%`,
      )
    }
    lines.push('')
  } else {
    lines.push('## Market baseline persona distribution')
    lines.push(
      '(no cross-venue baseline available — set vs_market_baseline_pct=null)',
    )
    lines.push('')
  }

  // ---- Close-prob distribution ----
  lines.push('## Close-probability distribution (Wave 5A buckets)')
  if (evidence.closeProbDistribution.length === 0) {
    lines.push('(none yet)')
  } else {
    for (const b of evidence.closeProbDistribution) {
      lines.push(`- ${b.bucket}: ${b.n_couples} couples`)
    }
  }
  lines.push('')

  // ---- Source distribution ----
  lines.push('## Inquiry-source distribution')
  if (evidence.sourceDistribution.length === 0) {
    lines.push('(none yet)')
  } else {
    for (const s of evidence.sourceDistribution) {
      lines.push(`- ${s.source}: ${s.n_couples} couples`)
    }
  }
  lines.push('')

  // ---- Sensitive theme counts ----
  lines.push(
    '## Sensitive-theme distribution (counts only — evidence stripped)',
  )
  const sensLines = fmtCounts(evidence.sensitivityCounts)
  if (sensLines.length === 0) lines.push('  (none)')
  else lines.push(...sensLines)
  lines.push('')

  // ---- Wave 5B rollup summary ----
  lines.push('## Wave 5B cohort rollup (top entries)')
  const r = evidence.cohortRollupSummary
  if (!r) {
    lines.push('(no rollup yet — refuse derived sections)')
  } else {
    lines.push('emerging_themes_top:')
    if (r.emerging_themes_top.length === 0) {
      lines.push('  (none)')
    } else {
      for (const t of r.emerging_themes_top) {
        lines.push(
          `  - ${t.theme} | trend=${t.trend} | n=${t.evidence_count}`,
        )
      }
    }
    lines.push('conversion_correlations_top:')
    if (r.conversion_correlations_top.length === 0) {
      lines.push('  (none)')
    } else {
      for (const c of r.conversion_correlations_top) {
        lines.push(
          `  - ${c.signal} | outcome=${c.outcome} | lift=${c.lift_pct} | n=${c.n_couples}`,
        )
      }
    }
    lines.push('voice_calibration_personas:')
    if (r.voice_calibration_personas.length === 0) {
      lines.push('  (none)')
    } else {
      for (const p of r.voice_calibration_personas) {
        lines.push(`  - ${p}`)
      }
    }
    lines.push('service_demand_top:')
    if (r.service_demand_top.length === 0) {
      lines.push('  (none)')
    } else {
      for (const s of r.service_demand_top) {
        lines.push(
          `  - ${s.service_or_offering} | demand=${s.demand_signal} | offered=${s.currently_offered}`,
        )
      }
    }
    lines.push('timing_patterns_top:')
    if (r.timing_patterns_top.length === 0) {
      lines.push('  (none)')
    } else {
      for (const t of r.timing_patterns_top) {
        lines.push(`  - ${t.pattern}`)
      }
    }
  }
  lines.push('')

  // ---- Channel-role distribution ----
  lines.push('## Channel-role distribution (Wave 7B)')
  if (evidence.channelRoleDistribution.length === 0) {
    lines.push('(no role classification yet)')
  } else {
    for (const c of evidence.channelRoleDistribution) {
      lines.push(
        `- ${c.channel}: acq=${c.acquisition} val=${c.validation} conv=${c.conversion} mixed=${c.mixed} unk=${c.unknown}`,
      )
    }
  }
  lines.push('')

  // ---- persona × channel top cells ----
  lines.push('## Persona × channel rollup (Wave 6B — top cells)')
  if (evidence.personaChannelTop.length === 0) {
    lines.push('(no rollup cells yet)')
  } else {
    for (const cell of evidence.personaChannelTop) {
      const conv =
        cell.conversion_pct === null ? 'n/a' : `${cell.conversion_pct}%`
      const cac =
        cell.cac_cents === null
          ? 'n/a'
          : `$${(cell.cac_cents / 100).toFixed(0)}`
      lines.push(
        `- ${cell.channel} × ${cell.persona_label ?? '<untagged>'}: inq=${cell.n_inquiries} bk=${cell.n_booked} conv=${conv} cac=${cac}`,
      )
    }
  }
  lines.push('')

  lines.push('---')
  lines.push(
    `Synthesise this venue's thesis. Echo cohort_size_at_generation=${evidence.cohortSizeAtGeneration}.`,
  )
  lines.push('Return ONLY the JSON.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  ok: false
  error: string
}

export interface ValidationSuccess {
  ok: true
  thesis: VenueThesisOutput
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

function toFiniteInt(v: unknown): number {
  const n = isNumber(v) ? v : Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.round(n))
}

function toFiniteNumber(v: unknown): number {
  const n = isNumber(v) ? v : Number(v)
  if (!Number.isFinite(n)) return 0
  return n
}

function arrayOfStrings(raw: unknown, label: string): string[] | string {
  if (!isArray(raw)) return `${label} must be array`
  const out: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const x = raw[i]
    if (!isString(x)) return `${label}[${i}] must be string`
    out.push(x)
  }
  return out
}

export function validateVenueThesisOutput(raw: unknown): ValidationResult {
  if (!isObject(raw)) return { ok: false, error: 'response is not a JSON object' }

  // venue_archetype
  const arch = raw.venue_archetype
  if (!isObject(arch)) {
    return { ok: false, error: 'venue_archetype must be object' }
  }
  if (!isString(arch.label)) {
    return { ok: false, error: 'venue_archetype.label must be string' }
  }
  if (!isString(arch.description)) {
    return { ok: false, error: 'venue_archetype.description must be string' }
  }
  if (!isString(arch.evidence_summary)) {
    return {
      ok: false,
      error: 'venue_archetype.evidence_summary must be string',
    }
  }
  const venue_archetype: VenueArchetype = {
    label: arch.label,
    description: arch.description,
    evidence_summary: arch.evidence_summary,
    confidence_0_100: clampInt0to100(arch.confidence_0_100),
  }

  // over_indexed_personas
  const oipRaw = raw.over_indexed_personas ?? []
  if (!isArray(oipRaw)) {
    return { ok: false, error: 'over_indexed_personas must be array' }
  }
  const over_indexed_personas: OverIndexedPersona[] = []
  for (let i = 0; i < oipRaw.length; i++) {
    const p = oipRaw[i]
    if (!isObject(p)) {
      return { ok: false, error: `over_indexed_personas[${i}] must be object` }
    }
    if (!isString(p.persona_label)) {
      return {
        ok: false,
        error: `over_indexed_personas[${i}].persona_label must be string`,
      }
    }
    if (!isString(p.evidence)) {
      return {
        ok: false,
        error: `over_indexed_personas[${i}].evidence must be string`,
      }
    }
    let baseline: number | null = null
    const rawBaseline = p.vs_market_baseline_pct
    if (rawBaseline === null || rawBaseline === undefined) {
      baseline = null
    } else if (isNumber(rawBaseline)) {
      baseline = rawBaseline
    } else {
      const n = Number(rawBaseline)
      baseline = Number.isFinite(n) ? n : null
    }
    over_indexed_personas.push({
      persona_label: p.persona_label,
      share_pct: toFiniteNumber(p.share_pct),
      vs_market_baseline_pct: baseline,
      evidence: p.evidence,
    })
  }

  // recurring_emotional_landscape
  const relRaw = raw.recurring_emotional_landscape ?? []
  if (!isArray(relRaw)) {
    return {
      ok: false,
      error: 'recurring_emotional_landscape must be array',
    }
  }
  const recurring_emotional_landscape: RecurringEmotionalLandscape[] = []
  for (let i = 0; i < relRaw.length; i++) {
    const r = relRaw[i]
    if (!isObject(r)) {
      return {
        ok: false,
        error: `recurring_emotional_landscape[${i}] must be object`,
      }
    }
    if (!isString(r.theme)) {
      return {
        ok: false,
        error: `recurring_emotional_landscape[${i}].theme must be string`,
      }
    }
    if (!isString(r.non_sensitive_summary)) {
      return {
        ok: false,
        error: `recurring_emotional_landscape[${i}].non_sensitive_summary must be string`,
      }
    }
    recurring_emotional_landscape.push({
      theme: r.theme,
      n_couples: toFiniteInt(r.n_couples),
      non_sensitive_summary: r.non_sensitive_summary,
    })
  }

  // conversion_signature
  const csRaw = raw.conversion_signature ?? []
  if (!isArray(csRaw)) {
    return { ok: false, error: 'conversion_signature must be array' }
  }
  const conversion_signature: ConversionSignal[] = []
  for (let i = 0; i < csRaw.length; i++) {
    const c = csRaw[i]
    if (!isObject(c)) {
      return { ok: false, error: `conversion_signature[${i}] must be object` }
    }
    if (!isString(c.signal)) {
      return {
        ok: false,
        error: `conversion_signature[${i}].signal must be string`,
      }
    }
    if (!isString(c.evidence)) {
      return {
        ok: false,
        error: `conversion_signature[${i}].evidence must be string`,
      }
    }
    conversion_signature.push({
      signal: c.signal,
      lift_pct: toFiniteNumber(c.lift_pct),
      evidence: c.evidence,
    })
  }

  // voice_thesis
  const vt = raw.voice_thesis
  if (!isObject(vt)) {
    return { ok: false, error: 'voice_thesis must be object' }
  }
  const tone = arrayOfStrings(vt.tone_descriptors ?? [], 'voice_thesis.tone_descriptors')
  if (typeof tone === 'string') return { ok: false, error: tone }
  const lLands = arrayOfStrings(
    vt.language_that_lands ?? [],
    'voice_thesis.language_that_lands',
  )
  if (typeof lLands === 'string') return { ok: false, error: lLands }
  const lAvoid = arrayOfStrings(
    vt.language_to_avoid ?? [],
    'voice_thesis.language_to_avoid',
  )
  if (typeof lAvoid === 'string') return { ok: false, error: lAvoid }
  const kp = arrayOfStrings(vt.key_principles ?? [], 'voice_thesis.key_principles')
  if (typeof kp === 'string') return { ok: false, error: kp }
  const voice_thesis: VoiceThesis = {
    tone_descriptors: tone,
    language_that_lands: lLands,
    language_to_avoid: lAvoid,
    key_principles: kp,
  }

  // service_demand_strengths
  const sdsRaw = raw.service_demand_strengths ?? []
  if (!isArray(sdsRaw)) {
    return { ok: false, error: 'service_demand_strengths must be array' }
  }
  const service_demand_strengths: ServiceDemandStrength[] = []
  for (let i = 0; i < sdsRaw.length; i++) {
    const s = sdsRaw[i]
    if (!isObject(s)) {
      return {
        ok: false,
        error: `service_demand_strengths[${i}] must be object`,
      }
    }
    if (!isString(s.offering)) {
      return {
        ok: false,
        error: `service_demand_strengths[${i}].offering must be string`,
      }
    }
    if (!isString(s.demand_signal)) {
      return {
        ok: false,
        error: `service_demand_strengths[${i}].demand_signal must be string`,
      }
    }
    service_demand_strengths.push({
      offering: s.offering,
      demand_signal: s.demand_signal,
    })
  }

  // service_demand_gaps
  const sdgRaw = raw.service_demand_gaps ?? []
  if (!isArray(sdgRaw)) {
    return { ok: false, error: 'service_demand_gaps must be array' }
  }
  const service_demand_gaps: ServiceDemandGap[] = []
  for (let i = 0; i < sdgRaw.length; i++) {
    const s = sdgRaw[i]
    if (!isObject(s)) {
      return {
        ok: false,
        error: `service_demand_gaps[${i}] must be object`,
      }
    }
    if (!isString(s.missing_offering)) {
      return {
        ok: false,
        error: `service_demand_gaps[${i}].missing_offering must be string`,
      }
    }
    if (!isString(s.evidence_of_demand)) {
      return {
        ok: false,
        error: `service_demand_gaps[${i}].evidence_of_demand must be string`,
      }
    }
    if (!isString(s.investment_recommendation)) {
      return {
        ok: false,
        error: `service_demand_gaps[${i}].investment_recommendation must be string`,
      }
    }
    service_demand_gaps.push({
      missing_offering: s.missing_offering,
      evidence_of_demand: s.evidence_of_demand,
      investment_recommendation: s.investment_recommendation,
    })
  }

  // operator_brief_paragraph
  if (!isString(raw.operator_brief_paragraph)) {
    return { ok: false, error: 'operator_brief_paragraph must be string' }
  }

  // cohort_size_at_generation
  const cohortSize = toFiniteInt(raw.cohort_size_at_generation)

  // refusals
  const refRaw = raw.refusals ?? []
  if (!isArray(refRaw)) {
    return { ok: false, error: 'refusals must be array' }
  }
  const refusals: VenueThesisRefusal[] = []
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
    thesis: {
      venue_archetype,
      over_indexed_personas,
      recurring_emotional_landscape,
      conversion_signature,
      voice_thesis,
      service_demand_strengths,
      service_demand_gaps,
      operator_brief_paragraph: raw.operator_brief_paragraph,
      cohort_size_at_generation: cohortSize,
      refusals,
    },
  }
}
