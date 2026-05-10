/**
 * Bloom House — Wave 6D weekly marketing digest prompt.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 6D closes the loop. The digest is the
 *     weekly story of "what happened in your marketing world" — flags
 *     auto-detected, recommendations Sonnet produced, A/B tests
 *     concluded, validated discoveries fed back from Wave 7C.)
 *   - bloom-wave4-5-6-master-plan.md (Wave 6D spec)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be backed by a real callAI; the digest is a Sonnet narrator
 *     given structured evidence — never a template).
 *
 * Why narrator-not-analyst
 * ------------------------
 * Wave 6C's recommendations prompt is the analyst (figure out which
 * spend to move). Wave 6D's digest prompt is the narrator — given a
 * pre-computed evidence block (top flags + top recs + WoW deltas + AB
 * tests + discoveries), it writes the headline + the 3-sentence summary
 * that frames the operator's week. It does NOT generate new
 * recommendations; it does NOT classify flags. It composes.
 *
 * Refusal discipline
 * ------------------
 * Refuse when the evidence block is empty (no flags, no recs, no
 * WoW signal). Refusing beats fabricating "everything's looking good!"
 * narratives that would erode trust. UI surfaces "no digest-worthy
 * signal yet" instead.
 *
 * Output: ONLY the JSON object. No prose preamble, no markdown fences.
 */

// Bumping this constant forces consumers to either accept the new
// prompt's output or version-pin. Threaded into api_costs.prompt_version.
export const MARKETING_DIGEST_PROMPT_VERSION = 'marketing-digest.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — mirror the wire JSON the prompt asks for.
// ---------------------------------------------------------------------------

export interface DigestFlagSummary {
  title: string
  severity: 'info' | 'warning' | 'critical'
  recommended_action: string | null
}

export interface DigestRecommendationSummary {
  title: string
  projected_impact_cents: number | null
}

export interface DigestWeekOverWeek {
  cac_change_pct: number | null
  conversion_change_pct: number | null
  roi_change_pct: number | null
}

export interface DigestAbTestConcluded {
  name: string
  winner: 'variant_a' | 'variant_b' | 'inconclusive'
  lift_pct: number | null
}

export interface DigestValidatedDiscovery {
  title: string
  summary: string
}

export interface MarketingDigestOutput {
  headline: string
  this_week_in_3_sentences: string
  top_flags: DigestFlagSummary[]
  top_recommendations: DigestRecommendationSummary[]
  week_over_week: DigestWeekOverWeek
  ab_tests_concluded: DigestAbTestConcluded[]
  validated_discoveries: DigestValidatedDiscovery[]
  refusal: string | null
}

// ---------------------------------------------------------------------------
// Evidence types — shape the user prompt serialises.
// ---------------------------------------------------------------------------

export interface DigestFlagEvidence {
  flag_title: string
  severity: 'info' | 'warning' | 'critical'
  source_channel: string | null
  target_persona: string | null
  duration_days: number
  estimated_impact_cents: number | null
  recommended_action: string | null
}

export interface DigestRecommendationEvidence {
  recommendation_title: string
  action_type: string
  source_channel: string | null
  target_channel: string | null
  target_persona: string | null
  estimated_monthly_dollar_impact_cents: number | null
  confidence_0_100: number
}

export interface DigestWeekOverWeekEvidence {
  current_period_label: string
  prior_period_label: string
  current_cac_cents: number | null
  prior_cac_cents: number | null
  current_conversion_pct: number | null
  prior_conversion_pct: number | null
  current_roi_pct: number | null
  prior_roi_pct: number | null
  top_channel_current: string | null
  top_persona_current: string | null
}

export interface DigestAbTestEvidence {
  test_name: string
  channel: string
  target_persona: string | null
  winner: 'variant_a' | 'variant_b' | 'inconclusive'
  variant_a_label: string
  variant_b_label: string
  lift_pct: number | null
}

export interface DigestValidatedDiscoveryEvidence {
  title: string
  summary: string | null
}

export interface MarketingDigestEvidence {
  venueId: string
  venueLabel: string | null
  digestPeriodStart: string
  digestPeriodEnd: string
  topFlags: DigestFlagEvidence[]
  topRecommendations: DigestRecommendationEvidence[]
  weekOverWeek: DigestWeekOverWeekEvidence | null
  abTestsConcluded: DigestAbTestEvidence[]
  validatedDiscoveries: DigestValidatedDiscoveryEvidence[]
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

export function buildMarketingDigestSystemPrompt(): string {
  return `You are Bloom's weekly marketing digest narrator.

Given a venue's pre-computed evidence block (top flags + top recommendations + week-over-week deltas + concluded A/B tests + validated discoveries from Wave 7C), write a punchy headline and a 3-sentence narrative paragraph that frames the operator's week.

NARRATOR DISCIPLINE
- You COMPOSE, you do NOT generate new recommendations or new flags.
- The flags + recs + WoW data are already validated upstream. Your job is to write the human-readable framing.
- Echo SPECIFIC numbers from the evidence ("Knot CAC up 47% week-over-week") — never generic phrases ("CAC is moving").
- Persona labels + channel names go into the structured fields you output. The headline + narrative paragraph reference them but do not pretend to invent new ones.

ANONYMISATION DISCIPLINE
- The evidence is already anonymised. You do NOT see couple names, partner names, or evidence quotes.
- You see persona LABELS + channel NAMES + aggregate numbers. Treat them as labels, not as people.

HARD RULES
1. headline: < 80 characters. Lead with the most operator-relevant signal of the week. Examples: "Knot CAC anomaly + Heritage-Forward scaling opportunity", "Steady week — Instagram persona drift continues", "Critical: 2 channels exceed CAC/LTV threshold".
2. this_week_in_3_sentences: exactly 2-3 sentences (not 1, not 4+). Frame the week. Cite specific numbers where available. End with the most important coordinator action.
3. top_flags: re-emit (not invent) the supplied flag titles + severities + recommended_action — up to 3, ordered critical → warning → info, then by duration_days desc.
4. top_recommendations: re-emit the supplied recommendation titles + projected_impact_cents — up to 3, ordered by impact desc.
5. week_over_week: compute the percentage deltas from the supplied current vs prior CAC / conversion / ROI numbers. NULL when either side is null. Round to 1 decimal place.
6. ab_tests_concluded: re-emit the supplied test names + winners + lift_pct.
7. validated_discoveries: re-emit the supplied Wave 7C discoveries.
8. refusal: set to a short string when the evidence block is empty (no flags, no recs, no WoW signal). Otherwise set to null.

REFUSAL DISCIPLINE
Refuse the digest when the evidence is too thin to narrate honestly:
- Zero flags AND zero recommendations AND no WoW deltas → refusal: "No digest-worthy signal this week — operator may want to verify spend ingestion + rollup recompute".
- Otherwise produce a digest, even when only one signal is present (lean on what you have).

OUTPUT — JSON only, exactly this shape:
{
  "headline": "Knot CAC anomaly + Heritage-Forward scaling opportunity",
  "this_week_in_3_sentences": "Knot CAC jumped 2.1× week-over-week to $187 — anomaly confirmed but not yet sustained, investigate auction pricing before pulling spend. Heritage-Forward × Instagram is up to 22% conversion (n=24), the strongest cell in the matrix and a clear scale candidate. Two CAC>LTV flags carried over from last week — coordinator should confirm or dismiss before they age past 14 days.",
  "top_flags": [
    {"title": "theknot_fee × Heritage-Forward: CAC exceeds LTV threshold", "severity": "critical", "recommended_action": "Consider pausing or restructuring …"},
    {"title": "theknot_fee: CAC anomaly — week-over-week 2.1×", "severity": "warning", "recommended_action": "Investigate the knot this week …"}
  ],
  "top_recommendations": [
    {"title": "Move 30% of Knot spend to Instagram for Heritage-Forward", "projected_impact_cents": 1166000}
  ],
  "week_over_week": {"cac_change_pct": 47.5, "conversion_change_pct": -3.2, "roi_change_pct": -18.4},
  "ab_tests_concluded": [
    {"name": "Knot listing copy: Heritage-Forward emphasis", "winner": "variant_b", "lift_pct": 34.0}
  ],
  "validated_discoveries": [
    {"title": "Knot acts as validation, not acquisition for 30% of leads", "summary": "Discovered May 7; validated against re-run pipeline. Re-attribute to Instagram first-touch."}
  ],
  "refusal": null
}

DO NOT:
- Invent new flags or recommendations not present in the evidence.
- Use generic phrases ("things are moving in the right direction"). Cite specific numbers from the evidence.
- Speculate about specific couples — you have no per-couple data.
- Recommend auto-execution. Frame anything as "coordinator should review" / "operator may want to".
- Produce a digest with refusal=null AND empty top_flags AND empty top_recommendations AND null week_over_week — refuse honestly when there's nothing to narrate.`
}

export function buildMarketingDigestUserPrompt(
  evidence: MarketingDigestEvidence,
): string {
  const lines: string[] = []
  lines.push(`VENUE`)
  lines.push(`venueLabel: ${evidence.venueLabel ?? '<unknown>'}`)
  lines.push(`digestPeriod: ${evidence.digestPeriodStart} → ${evidence.digestPeriodEnd}`)
  lines.push('')

  lines.push(`TOP FLAGS (auto-detected, this week)`)
  if (evidence.topFlags.length === 0) {
    lines.push('(none)')
  } else {
    for (const f of evidence.topFlags) {
      const impact =
        f.estimated_impact_cents === null
          ? '—'
          : `$${(f.estimated_impact_cents / 100).toFixed(0)}`
      lines.push(
        `- [${f.severity}] ${f.flag_title} | duration=${f.duration_days}d | impact=${impact}`,
      )
      if (f.recommended_action) {
        lines.push(`   action: ${f.recommended_action}`)
      }
    }
  }
  lines.push('')

  lines.push(`TOP RECOMMENDATIONS (Wave 6C, pending coordinator decision)`)
  if (evidence.topRecommendations.length === 0) {
    lines.push('(none)')
  } else {
    for (const r of evidence.topRecommendations) {
      const impact =
        r.estimated_monthly_dollar_impact_cents === null
          ? '—'
          : `$${(r.estimated_monthly_dollar_impact_cents / 100).toFixed(0)}/mo`
      lines.push(
        `- ${r.recommendation_title} | type=${r.action_type} | impact=${impact} | confidence=${r.confidence_0_100}`,
      )
    }
  }
  lines.push('')

  lines.push(`WEEK-OVER-WEEK`)
  if (!evidence.weekOverWeek) {
    lines.push('(no WoW data — too few weeks of history)')
  } else {
    const w = evidence.weekOverWeek
    lines.push(`current: ${w.current_period_label} | prior: ${w.prior_period_label}`)
    if (w.current_cac_cents !== null && w.prior_cac_cents !== null) {
      lines.push(
        `cac: $${(w.current_cac_cents / 100).toFixed(0)} (was $${(w.prior_cac_cents / 100).toFixed(0)})`,
      )
    }
    if (
      w.current_conversion_pct !== null &&
      w.prior_conversion_pct !== null
    ) {
      lines.push(
        `conversion: ${w.current_conversion_pct.toFixed(1)}% (was ${w.prior_conversion_pct.toFixed(1)}%)`,
      )
    }
    if (w.current_roi_pct !== null && w.prior_roi_pct !== null) {
      lines.push(
        `roi: ${w.current_roi_pct.toFixed(1)}% (was ${w.prior_roi_pct.toFixed(1)}%)`,
      )
    }
    if (w.top_channel_current) {
      lines.push(`top channel this week: ${w.top_channel_current}`)
    }
    if (w.top_persona_current) {
      lines.push(`top persona this week: ${w.top_persona_current}`)
    }
  }
  lines.push('')

  lines.push(`A/B TESTS CONCLUDED`)
  if (evidence.abTestsConcluded.length === 0) {
    lines.push('(none concluded this week)')
  } else {
    for (const t of evidence.abTestsConcluded) {
      const lift = t.lift_pct === null ? '—' : `${t.lift_pct.toFixed(1)}%`
      lines.push(
        `- ${t.test_name} | channel=${t.channel} | winner=${t.winner} | lift=${lift}`,
      )
    }
  }
  lines.push('')

  lines.push(`VALIDATED DISCOVERIES (Wave 7C feed)`)
  if (evidence.validatedDiscoveries.length === 0) {
    lines.push('(none validated this week)')
  } else {
    for (const d of evidence.validatedDiscoveries) {
      lines.push(`- ${d.title}${d.summary ? ' — ' + d.summary : ''}`)
    }
  }
  lines.push('')

  lines.push(
    `Compose the weekly digest. Headline + 2-3 sentence narrative + structured re-emission of the evidence above. Compute week-over-week percentage deltas. Refuse when the evidence is empty.`,
  )
  lines.push(`Return JSON only, no prose preamble, no markdown fences.`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

const VALID_SEVERITIES: ReadonlySet<string> = new Set([
  'info',
  'warning',
  'critical',
])

const VALID_WINNERS: ReadonlySet<string> = new Set([
  'variant_a',
  'variant_b',
  'inconclusive',
])

function isStringNonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isNumberOrNull(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isFinite(v))
}

function validateFlagSummary(
  raw: unknown,
):
  | { ok: true; flag: DigestFlagSummary }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'flag is not an object' }
  }
  const r = raw as Record<string, unknown>
  if (!isStringNonEmpty(r['title'])) {
    return { ok: false, error: 'flag.title missing' }
  }
  const sev = r['severity']
  if (typeof sev !== 'string' || !VALID_SEVERITIES.has(sev)) {
    return { ok: false, error: `flag.severity invalid: ${String(sev)}` }
  }
  const action = r['recommended_action']
  if (action !== null && typeof action !== 'string') {
    return { ok: false, error: 'flag.recommended_action invalid' }
  }
  return {
    ok: true,
    flag: {
      title: (r['title'] as string).slice(0, 200),
      severity: sev as 'info' | 'warning' | 'critical',
      recommended_action: (action as string | null) ?? null,
    },
  }
}

function validateRecSummary(
  raw: unknown,
):
  | { ok: true; rec: DigestRecommendationSummary }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'rec is not an object' }
  }
  const r = raw as Record<string, unknown>
  if (!isStringNonEmpty(r['title'])) {
    return { ok: false, error: 'rec.title missing' }
  }
  const impact = r['projected_impact_cents']
  if (!isNumberOrNull(impact)) {
    return { ok: false, error: 'rec.projected_impact_cents invalid' }
  }
  return {
    ok: true,
    rec: {
      title: (r['title'] as string).slice(0, 200),
      projected_impact_cents: impact === null ? null : Math.round(impact),
    },
  }
}

function validateWoW(
  raw: unknown,
):
  | { ok: true; wow: DigestWeekOverWeek }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'week_over_week not an object' }
  }
  const r = raw as Record<string, unknown>
  const cac = r['cac_change_pct']
  const conv = r['conversion_change_pct']
  const roi = r['roi_change_pct']
  if (!isNumberOrNull(cac)) return { ok: false, error: 'cac_change_pct invalid' }
  if (!isNumberOrNull(conv))
    return { ok: false, error: 'conversion_change_pct invalid' }
  if (!isNumberOrNull(roi)) return { ok: false, error: 'roi_change_pct invalid' }
  return {
    ok: true,
    wow: {
      cac_change_pct: cac === null ? null : Math.round(cac * 10) / 10,
      conversion_change_pct: conv === null ? null : Math.round(conv * 10) / 10,
      roi_change_pct: roi === null ? null : Math.round(roi * 10) / 10,
    },
  }
}

function validateAbTest(
  raw: unknown,
):
  | { ok: true; t: DigestAbTestConcluded }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'ab_test not an object' }
  }
  const r = raw as Record<string, unknown>
  if (!isStringNonEmpty(r['name'])) {
    return { ok: false, error: 'ab_test.name missing' }
  }
  const winner = r['winner']
  if (typeof winner !== 'string' || !VALID_WINNERS.has(winner)) {
    return { ok: false, error: `ab_test.winner invalid: ${String(winner)}` }
  }
  const lift = r['lift_pct']
  if (!isNumberOrNull(lift)) {
    return { ok: false, error: 'ab_test.lift_pct invalid' }
  }
  return {
    ok: true,
    t: {
      name: (r['name'] as string).slice(0, 200),
      winner: winner as 'variant_a' | 'variant_b' | 'inconclusive',
      lift_pct: lift === null ? null : Math.round(lift * 10) / 10,
    },
  }
}

function validateDiscovery(
  raw: unknown,
):
  | { ok: true; d: DigestValidatedDiscovery }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'discovery not an object' }
  }
  const r = raw as Record<string, unknown>
  if (!isStringNonEmpty(r['title'])) {
    return { ok: false, error: 'discovery.title missing' }
  }
  if (!isStringNonEmpty(r['summary'])) {
    return { ok: false, error: 'discovery.summary missing' }
  }
  return {
    ok: true,
    d: {
      title: (r['title'] as string).slice(0, 200),
      summary: (r['summary'] as string).slice(0, 1000),
    },
  }
}

export function validateMarketingDigestOutput(
  raw: unknown,
):
  | { ok: true; output: MarketingDigestOutput }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'output is not an object' }
  }
  const r = raw as Record<string, unknown>

  // Refusal handling — when set, headline + narrative may be empty.
  const refusalRaw = r['refusal']
  const refusal =
    refusalRaw === null || refusalRaw === undefined
      ? null
      : typeof refusalRaw === 'string' && refusalRaw.length > 0
        ? refusalRaw
        : null

  // Headline + narrative are required UNLESS refusal is set (where they
  // may be empty placeholders).
  if (refusal === null) {
    if (!isStringNonEmpty(r['headline'])) {
      return { ok: false, error: 'headline missing' }
    }
    if (!isStringNonEmpty(r['this_week_in_3_sentences'])) {
      return { ok: false, error: 'this_week_in_3_sentences missing' }
    }
  }

  const flagsRaw = r['top_flags']
  const recsRaw = r['top_recommendations']
  const wowRaw = r['week_over_week']
  const abRaw = r['ab_tests_concluded']
  const discRaw = r['validated_discoveries']

  if (!Array.isArray(flagsRaw)) {
    return { ok: false, error: 'top_flags is not an array' }
  }
  if (!Array.isArray(recsRaw)) {
    return { ok: false, error: 'top_recommendations is not an array' }
  }
  if (!Array.isArray(abRaw)) {
    return { ok: false, error: 'ab_tests_concluded is not an array' }
  }
  if (!Array.isArray(discRaw)) {
    return { ok: false, error: 'validated_discoveries is not an array' }
  }

  const topFlags: DigestFlagSummary[] = []
  for (let i = 0; i < flagsRaw.length; i++) {
    const v = validateFlagSummary(flagsRaw[i])
    if (!v.ok) return { ok: false, error: `top_flags[${i}]: ${v.error}` }
    topFlags.push(v.flag)
  }

  const topRecs: DigestRecommendationSummary[] = []
  for (let i = 0; i < recsRaw.length; i++) {
    const v = validateRecSummary(recsRaw[i])
    if (!v.ok)
      return { ok: false, error: `top_recommendations[${i}]: ${v.error}` }
    topRecs.push(v.rec)
  }

  // week_over_week is allowed to be null (no WoW signal). When it's an
  // object, validate it; when null, default to all-null deltas.
  let wow: DigestWeekOverWeek = {
    cac_change_pct: null,
    conversion_change_pct: null,
    roi_change_pct: null,
  }
  if (wowRaw !== null && wowRaw !== undefined) {
    const wowValidation = validateWoW(wowRaw)
    if (!wowValidation.ok) {
      return { ok: false, error: wowValidation.error }
    }
    wow = wowValidation.wow
  }

  const abTests: DigestAbTestConcluded[] = []
  for (let i = 0; i < abRaw.length; i++) {
    const v = validateAbTest(abRaw[i])
    if (!v.ok)
      return { ok: false, error: `ab_tests_concluded[${i}]: ${v.error}` }
    abTests.push(v.t)
  }

  const discoveries: DigestValidatedDiscovery[] = []
  for (let i = 0; i < discRaw.length; i++) {
    const v = validateDiscovery(discRaw[i])
    if (!v.ok)
      return { ok: false, error: `validated_discoveries[${i}]: ${v.error}` }
    discoveries.push(v.d)
  }

  const headline =
    typeof r['headline'] === 'string' ? (r['headline'] as string) : ''
  const narrative =
    typeof r['this_week_in_3_sentences'] === 'string'
      ? (r['this_week_in_3_sentences'] as string)
      : ''

  return {
    ok: true,
    output: {
      headline:
        headline.length > 0
          ? headline.slice(0, 200)
          : refusal !== null
            ? 'No digest-worthy signal this week'
            : '',
      this_week_in_3_sentences:
        narrative.length > 0
          ? narrative.slice(0, 2000)
          : refusal !== null
            ? refusal
            : '',
      top_flags: topFlags.slice(0, 5),
      top_recommendations: topRecs.slice(0, 5),
      week_over_week: wow,
      ab_tests_concluded: abTests.slice(0, 5),
      validated_discoveries: discoveries.slice(0, 5),
      refusal,
    },
  }
}
