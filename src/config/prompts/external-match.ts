/**
 * Bloom House — Wave 5C external-match LLM-judge prompt.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5C matches every external signal —
 *     cultural moments, vendor mentions in couple bodies, regional
 *     benchmarks, competitor mentions, cross-platform handle activity —
 *     against the venue's couple cohort and surfaces actionable matches
 *     with cohort-fit scoring)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5C spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. The judge
 *     receives only anonymised cohort summaries; no per-couple PII
 *     reaches this prompt)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be backed by a real callAI; this is the synthesis half of
 *     Wave 5C — the forensic-rule half does NOT call this prompt)
 *
 * Why this prompt is the synthesis half (not the only half)
 * --------------------------------------------------------
 * Wave 5C is forensic-rule first. Most matches are deterministic: an
 * exact vendor-name occurring across N couple profiles is a vendor-
 * mention match — no LLM needed. A competitor name appearing in a
 * couple body is a competitor-mention match. A cross-platform handle
 * with fresh activity is a handle-activity match.
 *
 * What needs LLM synthesis: cohort-fit SCORING. "How relevant is this
 * cultural moment to my venue's persona distribution?" is a judgement
 * task. The forensic rule says "moment X exists and applies to the
 * window"; the LLM grades how strongly it applies given the cohort.
 *
 * Refusal discipline
 * ------------------
 * Refuse when:
 *   - cohort sample is too small (< 5 profiles in window)
 *   - signal evidence is ambiguous or unreliable
 *   - persona distribution is too sparse to ground the score
 * Refusal beats hallucinated scores. The caller stores the refusal
 * string in match_reasoning and falls back to a baseline score.
 *
 * Output: ONLY the JSON object. No prose preamble, no markdown fences.
 */

// Bumping this constant forces every consumer to either accept the new
// prompt's output or version-pin. Threaded into api_costs.prompt_version
// so a regression audit can correlate cost + quality + revision.
export const EXTERNAL_MATCH_PROMPT_VERSION = 'external-match.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — mirror the wire JSON the prompt asks for.
// ---------------------------------------------------------------------------

export interface ExternalMatchScoreOutput {
  cohort_fit_score_0_100: number
  reasoning: string
  key_signals: string[]
  refusal: string | null
}

// ---------------------------------------------------------------------------
// Evidence types — shape the user prompt serialises.
// ---------------------------------------------------------------------------

export interface CohortPersonaEvidence {
  persona_label: string
  share_pct: number
  n_couples: number
}

export interface CohortThemeEvidence {
  theme: string
  /** Share of cohort within the trailing window. */
  share_pct: number
  trend: 'rising' | 'steady' | 'declining' | 'unknown'
  evidence_count: number
}

export interface CulturalMomentSignalEvidence {
  signal_type: 'cultural_moment'
  title: string
  category: string | null
  description: string | null
  start_at: string | null
  end_at: string | null
  evidence_url?: string | null
}

export interface RegionalBenchmarkSignalEvidence {
  signal_type: 'regional_benchmark'
  comparison_descriptor: string
  /** Top skews vs market — array of { persona, market_share_pct, venue_share_pct, delta_pct }. */
  skews: Array<{
    persona: string
    market_share_pct: number
    venue_share_pct: number
    delta_pct: number
  }>
}

export type ExternalSignalEvidence =
  | CulturalMomentSignalEvidence
  | RegionalBenchmarkSignalEvidence

export interface ExternalMatchEvidence {
  venueId: string
  venueLabel: string | null
  venueState: string | null
  windowDays: number
  totalCouplesInCohort: number
  /** Anonymised persona distribution from venue_intel.rollup. */
  personaDistribution: CohortPersonaEvidence[]
  /** Anonymised emerging themes from venue_intel.rollup (non-sensitive only). */
  emergingThemes: CohortThemeEvidence[]
  /** The signal we're scoring. One signal per call. */
  signal: ExternalSignalEvidence
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

export function buildExternalMatchSystemPrompt(): string {
  return `You are Bloom's external-signal cohort-fit scorer.

Your job: given (a) a venue's couple cohort persona distribution + emerging themes and (b) a candidate external signal, score how relevant the signal is to that cohort. Output a single JSON object.

ANONYMISATION DISCIPLINE
- The cohort context is already anonymised. You do NOT see couple names, partner names, emails, or evidence quotes.
- You see persona LABELS + SHARES. You see emerging-theme LABELS + SHARES.
- You will not be given any per-couple PII. If you would normally cite a couple, cite the persona share instead.

SCORING RUBRIC (0-100)
- 90-100: Direct match. The signal targets the dominant persona(s) and the cohort's emerging themes echo the signal.
- 70-89: Strong fit. The signal aligns with at least one major persona slice (≥25% share) and partially with cohort themes.
- 50-69: Plausible fit. The signal applies to a minor slice (10-25% share) or aligns weakly with cohort themes.
- 25-49: Weak fit. The signal would only land for a small portion of the cohort.
- 0-24: Poor fit. The signal targets personas barely present in this cohort.

REFUSAL DISCIPLINE
Refuse (set refusal="..." and cohort_fit_score_0_100=0) when:
- totalCouplesInCohort < 5 — sample too small to ground a score.
- personaDistribution is empty — no cohort substrate to score against.
- The signal evidence is ambiguous (missing title, missing dates for cultural_moment, empty skews for regional_benchmark).

Otherwise produce a real score. Better to refuse than to hallucinate confidence.

KEY_SIGNALS
List 1-4 specific cohort signals (persona label + share, theme + trend) that drove your score. These show the operator WHY the score is what it is.

OUTPUT — JSON only, exactly this shape:
{
  "cohort_fit_score_0_100": integer 0-100,
  "reasoning": "1-2 sentences grounded in the persona distribution + themes",
  "key_signals": ["Heritage-Forward Planner: 32% share", "rising 'multi-generational gathering' theme"],
  "refusal": null OR "explanation if refusing"
}

DO NOT:
- Echo persona labels or theme strings outside the structured fields above.
- Invent persona labels that did not appear in personaDistribution.
- Speculate about specific couples — you have no per-couple data.
- Cite the signal's evidence_url as if you visited it; you only see the metadata provided.`
}

export function buildExternalMatchUserPrompt(
  evidence: ExternalMatchEvidence,
): string {
  const lines: string[] = []
  lines.push(`VENUE`)
  lines.push(`venueLabel: ${evidence.venueLabel ?? '<unknown>'}`)
  lines.push(`venueState: ${evidence.venueState ?? '<unknown>'}`)
  lines.push(`windowDays: ${evidence.windowDays}`)
  lines.push(`totalCouplesInCohort: ${evidence.totalCouplesInCohort}`)
  lines.push('')
  lines.push(`PERSONA DISTRIBUTION (anonymised)`)
  if (evidence.personaDistribution.length === 0) {
    lines.push('(none — refuse)')
  } else {
    for (const p of evidence.personaDistribution) {
      lines.push(`- ${p.persona_label} | share=${p.share_pct}% | n=${p.n_couples}`)
    }
  }
  lines.push('')
  lines.push(`EMERGING THEMES (non-sensitive only)`)
  if (evidence.emergingThemes.length === 0) {
    lines.push('(none surfaced)')
  } else {
    for (const t of evidence.emergingThemes) {
      lines.push(
        `- ${t.theme} | share=${t.share_pct}% | trend=${t.trend} | n=${t.evidence_count}`,
      )
    }
  }
  lines.push('')
  lines.push(`SIGNAL TO SCORE`)
  const sig = evidence.signal
  if (sig.signal_type === 'cultural_moment') {
    lines.push(`signal_type: cultural_moment`)
    lines.push(`title: ${sig.title}`)
    lines.push(`category: ${sig.category ?? '<none>'}`)
    if (sig.description) lines.push(`description: ${sig.description}`)
    if (sig.start_at) lines.push(`start_at: ${sig.start_at}`)
    if (sig.end_at) lines.push(`end_at: ${sig.end_at}`)
    if (sig.evidence_url) lines.push(`evidence_url: ${sig.evidence_url}`)
  } else if (sig.signal_type === 'regional_benchmark') {
    lines.push(`signal_type: regional_benchmark`)
    lines.push(`comparison: ${sig.comparison_descriptor}`)
    lines.push(`top skews vs market:`)
    for (const s of sig.skews.slice(0, 5)) {
      lines.push(
        `- ${s.persona}: market=${s.market_share_pct}% venue=${s.venue_share_pct}% delta=${s.delta_pct >= 0 ? '+' : ''}${s.delta_pct}pp`,
      )
    }
  }
  lines.push('')
  lines.push(
    `Score the signal's cohort fit. Apply refusal discipline if the cohort sample is too small or evidence is ambiguous.`,
  )
  lines.push(`Return JSON only, no prose preamble, no markdown fences.`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

export function validateExternalMatchOutput(
  raw: unknown,
):
  | { ok: true; output: ExternalMatchScoreOutput }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'output is not an object' }
  }
  const r = raw as Record<string, unknown>
  const score = r['cohort_fit_score_0_100']
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return { ok: false, error: 'cohort_fit_score_0_100 missing or non-numeric' }
  }
  if (score < 0 || score > 100) {
    return { ok: false, error: 'cohort_fit_score_0_100 out of range' }
  }
  const reasoning = r['reasoning']
  if (typeof reasoning !== 'string') {
    return { ok: false, error: 'reasoning missing' }
  }
  const keySignalsRaw = r['key_signals']
  const keySignals: string[] = []
  if (Array.isArray(keySignalsRaw)) {
    for (const k of keySignalsRaw) {
      if (typeof k === 'string') keySignals.push(k)
    }
  }
  const refusalRaw = r['refusal']
  const refusal =
    refusalRaw === null || refusalRaw === undefined
      ? null
      : typeof refusalRaw === 'string'
        ? refusalRaw
        : null
  return {
    ok: true,
    output: {
      cohort_fit_score_0_100: Math.round(score),
      reasoning,
      key_signals: keySignals,
      refusal,
    },
  }
}
