/**
 * Bloom House — Wave 24 Channel Truth narrator prompt (Sonnet tier).
 *
 * Anchor docs:
 *   - feedback_measure_dont_assume.md (narrator describes pre-computed
 *     numbers; never re-imposes a hypothesised direction)
 *   - feedback_self_reported_sources_not_truth.md (when narrating the
 *     channel-mix question, the gap IS the gold — surface both stated +
 *     forensic without overwriting either)
 *   - feedback_deep_fix_vs_bandaid.md (this is THE evidence-leading
 *     surface — every claim must be reproducible)
 *   - PROMPT-BIAS-AUDIT.md (the narrator must NOT cite a number not in
 *     the input data structure; refusal is a first-class output)
 *
 * What this prompt does
 * ---------------------
 * For each pre-built Channel Truth question, after the deterministic
 * compute step has produced a structured result, this narrator turns
 * the structured numbers into a plain-English 2-3 sentence answer plus
 * a short headline pull-quote.
 *
 * The narrator NEVER:
 *   - Computes a number (every number comes from the input data block).
 *   - Modifies, averages, estimates, or extrapolates beyond the input.
 *   - Cites a sample size smaller than the answer's `min_sample_size`
 *     threshold without flagging "insufficient sample".
 *   - Uses direction-loaded phrases ("the data clearly shows", "this
 *     confirms that", "leans toward"). Per Wave 21 doctrine.
 *
 * The narrator IS:
 *   - Honest about thin data (explicit "insufficient sample" verdict).
 *   - Honest about prompt contamination (mentions the v1 asterisk when
 *     the input flags it).
 *   - Compositional only: assembles the structured evidence into prose.
 *   - Allowed to refuse: if the input data is too thin or contains
 *     contamination at a level that makes the headline misleading, the
 *     narrator emits a `refusal_reason` instead of a number.
 *
 * Output: ONLY the JSON object.
 *
 * Cost: Sonnet, ~$0.01 per question. Cached on the audit-snapshot row.
 *
 * Multi-question note: One prompt; the user prompt carries the
 * question id + the question-specific evidence block. The shape of
 * evidence is generic (sample sizes + headline numbers + optional
 * comparison cells + v1-contam pct + freshness) so adding a new
 * question only requires a new deterministic compute function, not a
 * new prompt.
 */

export const CHANNEL_TRUTH_NARRATOR_PROMPT_VERSION =
  'channel-truth-narrator.prompt.v1'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Generic sample-size + cell structure each question's compute step
 * fills before calling the narrator. The narrator NEVER reads the
 * deterministic SQL — it ONLY reads this structure.
 */
export interface NarratorEvidenceCell {
  /** Label for the cell (e.g. "targeted_knot_conversion"). Free-text. */
  label: string
  /** Sample size that produced the headline_value. */
  n: number
  /** The headline value. Free-shape: number, string, percentage. */
  headline_value: unknown
  /** Optional 95% CI half-width when computable. */
  ci_95_half_width: number | null
  /** Whether this cell carries any v1-prompt-classified rows. */
  v1_contaminated_pct: number
}

export interface NarratorEvidence {
  /**
   * The question id (e.g. "knot_targeted_vs_broadcast_conversion") —
   * narrator uses to disambiguate when phrasing the answer. Free-text;
   * narrator does not enforce a registry.
   */
  question_id: string
  /** Plain-English question text (the prompt the narrator answers). */
  question_text: string
  /** Venue display label. */
  venue_label: string
  /**
   * The cells that compose the answer. Order matters for narration
   * (first cell is usually the headline; subsequent cells are
   * comparisons / sub-buckets).
   */
  cells: NarratorEvidenceCell[]
  /**
   * Minimum sample-size threshold per cell below which the narrator
   * MUST refuse with "insufficient sample". Default 10.
   */
  min_sample_size: number
  /**
   * Cross-cell v1 contamination percentage. When > 0, the narrator
   * MUST mention the asterisk in the narration_paragraph.
   */
  overall_v1_contamination_pct: number
  /**
   * Data freshness ISO timestamp. When > 24h old, narrator MUST
   * mention staleness.
   */
  data_freshness_iso: string
  /** Any other compute-derived context (e.g. "8 channels analysed"). */
  context_notes: string[]
}

export interface NarratorOutput {
  /**
   * 2-3 sentence plain-English answer. Composes ONLY the cells'
   * headline_value + sample size + (optionally) the v1 asterisk.
   */
  narration_paragraph: string
  /** 4-12 word headline pull-quote for the dashboard card. */
  headline_pull_quote: string
  /**
   * Optional concrete next-step recommendation. NULL when the data is
   * descriptive-only or when the operator would over-interpret a thin
   * cell. Per doctrine: narrator describes; operator decides.
   */
  recommendation_if_any: string | null
  /**
   * Mutual-exclusive with the other three fields. When ALL cells are
   * below min_sample_size, OR overall_v1_contamination_pct > 50, the
   * narrator emits a refusal here and the other fields are empty.
   */
  refusal_reason: string | null
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildChannelTruthNarratorSystemPrompt(): string {
  return `You are Bloom's Channel Truth narrator.

Bloom is a forensic identity-reconstruction system for wedding venues.
The Channel Truth Report answers questions a venue owner would actually
ask in plain English about their channel attribution — "Is Knot
actually working?" — using PRE-COMPUTED forensic numbers.

Your job: given one question and a structured block of evidence cells
(sample sizes + headline values + v1-contamination pct + freshness),
produce a 2-3 sentence honest plain-English answer plus a short
headline pull-quote.

You are a COMPOSITION engine, not a measurement engine.

## ABSOLUTE RULES (violations = refusal)

1. **NEVER cite a number that is not in the input evidence cells.** Not
   a rounded version, not an extrapolation, not a "roughly X". If a
   number is not in the input, it does not exist for this answer.

2. **NEVER modify, average, or estimate.** The deterministic compute
   step produced the numbers. Your job is to narrate them, not to
   recompute them.

3. **Sample-size honesty.** If ANY cell relied on for the narration has
   n < min_sample_size, you MUST either: (a) explicitly say "insufficient
   sample (n=X)" in the narration_paragraph, OR (b) emit a refusal.
   Pick refusal when the entire answer depends on a thin cell.

4. **v1-contamination disclosure.** If overall_v1_contamination_pct > 0,
   you MUST mention the asterisk in the narration_paragraph (e.g.
   "12% of cells in this calculation were classified under a
   bias-contaminated prompt; the operator can re-run reclassify-v1 for
   clean numbers"). When contamination > 50%, emit a refusal.

5. **Data freshness.** If the freshness timestamp is > 24 hours old,
   you MUST mention "data last refreshed [HH]h ago" in the narration.

## FORBIDDEN LANGUAGE

Per Wave 21 bias-audit doctrine, NEVER use:
  - "Lean toward" / "tip the scale toward"
  - "The data clearly shows" / "this confirms"
  - "It's likely" / "probably"
  - "Significantly" without a citation of the actual percentage gap
  - "Surprisingly" / "unexpectedly" — direction-loaded
  - "Should" or "must" outside the recommendation_if_any field

PREFER:
  - "Targeted Knot inquiries booked at X% (n=Y). Broadcast Knot
    inquiries booked at Z% (n=W). The gap is N percentage points."
  - "Based on the X weddings in the sample…"
  - "When excluding broadcast inquiries, your apparent Knot CAC of
    $X becomes $Y."

## REFUSAL CONDITIONS

Emit refusal_reason (and leave the other three fields as empty strings)
when:
  - Every cell is below min_sample_size.
  - overall_v1_contamination_pct > 50.
  - The cells contradict the question_text (e.g. compute produced a
    Knot conversion comparison but the question asks about WeddingWire).

## RECOMMENDATION DISCIPLINE

recommendation_if_any:
  - NULL when the data is descriptive-only (e.g. "show the channel mix
    breakdown" — no clear action).
  - NULL when any cell is thin (sample size between min and 30).
  - A 1-sentence concrete next step when the data is unambiguous AND
    the sample is solid (n >= 30 per cell).

NEVER recommend a spend reallocation in dollars unless the input
evidence contains an explicit dollar figure.

## OUTPUT SHAPE

Return ONLY this JSON (no markdown, no preamble):

{
  "narration_paragraph": "2-3 sentences. Composes ONLY the input cells.",
  "headline_pull_quote": "4-12 word headline for the dashboard card.",
  "recommendation_if_any": "1 sentence concrete next step OR null.",
  "refusal_reason": "string reason OR null. Mutually exclusive with the others."
}`
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

export function buildChannelTruthNarratorUserPrompt(
  evidence: NarratorEvidence,
): string {
  const freshnessAgeHours = computeAgeHours(evidence.data_freshness_iso)
  const cellsLines = evidence.cells
    .map((c) => {
      const ci = c.ci_95_half_width !== null
        ? ` (95% CI ±${c.ci_95_half_width.toFixed(2)})`
        : ''
      const v1 = c.v1_contaminated_pct > 0
        ? ` [v1-contaminated ${c.v1_contaminated_pct.toFixed(1)}%]`
        : ''
      return `  - ${c.label}: ${JSON.stringify(c.headline_value)} (n=${c.n})${ci}${v1}`
    })
    .join('\n')

  const ctxLines = evidence.context_notes.length > 0
    ? `\n## Additional context\n${evidence.context_notes.map((n) => `  - ${n}`).join('\n')}`
    : ''

  return `## Question
"${evidence.question_text}"

## Venue
${evidence.venue_label}

## Question ID (for your reference; do not narrate it)
${evidence.question_id}

## Evidence cells
${cellsLines}

## Calibration
  - min_sample_size threshold: ${evidence.min_sample_size}
  - overall v1-prompt contamination: ${evidence.overall_v1_contamination_pct.toFixed(1)}%
  - data freshness: ${freshnessAgeHours.toFixed(1)}h ago (${evidence.data_freshness_iso})
${ctxLines}

Narrate this answer. Compose ONLY the cells above. Refuse if every
cell is thin OR contamination > 50%.`
}

function computeAgeHours(iso: string): number {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 0
  return (Date.now() - t) / (1000 * 60 * 60)
}

// ---------------------------------------------------------------------------
// Output validator
// ---------------------------------------------------------------------------

export interface ValidateResult {
  ok: boolean
  output?: NarratorOutput
  error?: string
}

export function validateChannelTruthNarratorOutput(raw: unknown): ValidateResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'output is not an object' }
  }
  const o = raw as Record<string, unknown>
  const narration =
    typeof o.narration_paragraph === 'string' ? o.narration_paragraph : ''
  const headline =
    typeof o.headline_pull_quote === 'string' ? o.headline_pull_quote : ''
  const rec =
    typeof o.recommendation_if_any === 'string'
      ? o.recommendation_if_any
      : o.recommendation_if_any === null
        ? null
        : null
  const refusal =
    typeof o.refusal_reason === 'string'
      ? o.refusal_reason
      : o.refusal_reason === null
        ? null
        : null

  // Mutual exclusion check.
  if (refusal && refusal.trim().length > 0) {
    return {
      ok: true,
      output: {
        narration_paragraph: '',
        headline_pull_quote: '',
        recommendation_if_any: null,
        refusal_reason: refusal,
      },
    }
  }
  if (narration.trim().length === 0 || headline.trim().length === 0) {
    return {
      ok: false,
      error: 'narration_paragraph and headline_pull_quote are required when not refusing',
    }
  }
  return {
    ok: true,
    output: {
      narration_paragraph: narration,
      headline_pull_quote: headline,
      recommendation_if_any: rec,
      refusal_reason: null,
    },
  }
}
