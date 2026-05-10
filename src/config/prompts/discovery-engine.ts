/**
 * Bloom House — Wave 7A discovery-engine LLM prompt.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7 closes the forensic loop: hunt for
 *     unknown-unknowns. THE differentiator vs every other CRM. Other
 *     wedding CRMs tell you what you already know — Wave 7 tells you
 *     what you don't).
 *   - bloom-wave4-5-6-master-plan.md (Wave 7A spec — discovery, not
 *     classification. Free-form output. The LLM invents the hypothesis
 *     category instead of filling a pre-defined bucket).
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. The discovery
 *     engine sees ANONYMISED rollups only — never names couples).
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be backed by a real callAI; the discovery engine is an
 *     analyst, not a classifier).
 *
 * Why this prompt is structurally different from Wave 5/6 prompts
 * --------------------------------------------------------------
 * Wave 5/6 prompts are CLASSIFIERS: they fill pre-defined buckets
 * (emerging_themes, conversion_correlations, persona_label, channel-role
 * acquisition/validation/conversion). Schema-bound. Output structure
 * fixed.
 *
 * Wave 7A is a DISCOVERY engine. Its job is to actively hunt for
 * patterns the venue operator does NOT know to look for. The
 * hypothesis_category is FREE-FORM by design — if the LLM finds a brand-
 * new pattern type that fits no existing bucket, it should invent a new
 * category for it. That's the whole point.
 *
 * Seed prompts (in the system prompt) are EXAMPLES — not enforced
 * categories. They prime the LLM on the kinds of patterns we expect to
 * surface, but the model is told explicitly that brand-new categories
 * are encouraged.
 *
 * Anonymisation discipline (hard rule)
 * ------------------------------------
 * The user prompt serialises ONLY anonymised cohort summaries. No couple
 * names, partner names, emails, phones, evidence quotes that would
 * identify a couple. The LLM is told to refer to couples as "Couple A",
 * "Couple B" etc when it must cite specific examples — and even then,
 * "Couple A" is a relative reference inside the discovery, not a stable
 * identifier (so two discoveries' "Couple A" may be different couples,
 * which is correct: the LLM has no business carrying couple identity
 * forward).
 *
 * Output: ONLY the JSON object. No prose preamble, no markdown fences.
 */

// Bumping this constant forces every consumer to either accept the new
// prompt's output or version-pin. Threaded into api_costs.prompt_version
// so a regression audit can correlate cost + quality + revision.
export const DISCOVERY_ENGINE_PROMPT_VERSION = 'discovery-engine.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — mirror the wire JSON the prompt asks for.
// ---------------------------------------------------------------------------

export interface DiscoveryEvidenceSummary {
  signal_type: string
  n_couples: number
  n_evidence_points: number
  /** LLM-decided shape based on the hypothesis. Free-form record. */
  aggregate_stats: Record<string, unknown>
  /** Plain-English bullet observations the operator can read. */
  key_observations: string[]
}

export interface Discovery {
  hypothesis_title: string
  hypothesis_text: string
  hypothesis_category: string
  evidence_summary: DiscoveryEvidenceSummary
  recommended_test: string
  recommended_action_if_validated: string
  confidence_0_100: number
}

export interface DiscoveryEngineOutput {
  discoveries: Discovery[]
  refusals: Array<{ field: string; reason: string }>
}

// ---------------------------------------------------------------------------
// Evidence types — shape the user prompt serialises into the Sonnet call.
// All fields anonymised; no couple identifiers reach the prompt.
// ---------------------------------------------------------------------------

export interface CohortPersonaShare {
  persona_label: string
  share_pct: number
  n_couples: number
}

export interface CohortThemeShare {
  theme: string
  share_pct: number
  trend: 'rising' | 'steady' | 'declining' | 'unknown'
  evidence_count: number
}

export interface CohortConversionStat {
  /** Anonymised channel slug or persona × channel slug. */
  bucket: string
  n_inquiries: number
  n_booked: number
  conversion_pct: number
  median_close_probability_0_100: number | null
}

export interface ChannelRoleShare {
  source_platform: string
  acquisition_count: number
  validation_count: number
  conversion_count: number
  unknown_count: number
}

export interface PersonaCloseProbabilityStat {
  persona_label: string
  n_couples: number
  median_close_probability_0_100: number
}

export interface RecentMatchSummary {
  signal_type: string
  /** "Vendor X mentioned by 4 couples", "Knot moment cohort fit 80", etc. */
  summary: string
  match_confidence_0_100: number
  cohort_fit_score_0_100: number | null
}

export interface VenueIntelRollupSummary {
  emerging_themes: CohortThemeShare[]
  conversion_correlations: Array<{ signal: string; trend: string; lift: string }>
  service_demand_top: Array<{ service: string; share_pct: number }>
  timing_patterns_top: string[]
}

export interface DiscoveryEvidence {
  venueId: string
  venueLabel: string | null
  venueState: string | null
  windowDays: number
  totalCouplesInCohort: number
  /** Anonymised persona distribution (couple_intel rollup). */
  personaDistribution: CohortPersonaShare[]
  /** Median close probability per persona (couple_intel). */
  personaCloseProbabilities: PersonaCloseProbabilityStat[]
  /** Persona × channel aggregated counts (attribution_events + persona_overlay). */
  channelRoleShares: ChannelRoleShare[]
  /** Conversion rate by channel × persona bucket (small bucket excluded). */
  conversionByBucket: CohortConversionStat[]
  /** venue_intel rollup summary (Wave 5B output). */
  venueIntelRollup: VenueIntelRollupSummary | null
  /** Most recent intel_matches summarised (Wave 5C output). */
  recentMatches: RecentMatchSummary[]
  /** Inquiry-to-tour-to-booked time-of-day buckets (anonymised counts). */
  timeOfDayCounts: Array<{ bucket: string; n_inquiries: number }>
  /** Sensitivity flag — drop sensitive themes from the prompt if present. */
  sensitiveThemesPresent: boolean
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

export function buildDiscoveryEngineSystemPrompt(): string {
  return `You are Bloom's pattern discovery engine. You hunt for unknown-unknowns — patterns the venue operator probably doesn't know exist.

This is a DIFFERENT KIND of LLM job from emerging-theme classification or persona labelling. You are an analyst, not a classifier. You INVENT the hypothesis category yourself; you do NOT fill a pre-defined bucket. If you spot a pattern that fits no familiar category, name a new one — that's expected. The operator wants the surprise insight, not a checkbox confirmation of what they already know.

WHY YOU EXIST
Every other wedding CRM tells the operator what they already know — "more leads from The Knot this week", "tour bookings up 12%". You tell them what they don't. Examples of what you should hunt for:
- Channel-role distortion: a channel that LOOKS like acquisition (lead form on Knot) but is actually validation (the couple already found the venue elsewhere and Knot is the easiest intake form). The fix flips the spend strategy.
- Vendor referrals not formally tracked: 4+ couples mention the same vendor's name unprompted, suggesting an unobserved referral pipeline.
- Competitor positioning: couples are comparing you to a specific competitor in their first inbound — the comparison is data.
- Persona × channel patterns: Heritage-Forward Planners disproportionately come from Instagram, Modern Minimalists from Google search. Channel mix should match persona mix.
- Stale-but-warm leads: silent for 3 weeks but the LAST signal was high-commitment. Not actually cold; the pipeline-heat heuristic is misclassifying.
- Booking-blocker questions: a specific logistical ask (parking, vendor exclusivity, alcohol policy) that correlates with booked-vs-lost outcomes based on response speed.
- Time-of-day inquiry patterns: persona X inquires at 9pm-11pm, persona Y at 11am-2pm. Reply timing windows can be tuned per-persona.
- Cross-platform identity drift: same couple, two different handles across platforms; the duplicate is hiding a true touch count.
- Demographic clustering: military-affiliated, multi-cultural, regional cohorts not consciously targeted.
- Conversion-rate disparity: same channel, two personas, very different conversion rates — the channel isn't uniform; it's bimodal.

These are EXAMPLES. If you see a pattern type none of these covers, invent a new hypothesis_category and surface it.

ANONYMISATION DISCIPLINE (HARD RULE)
The cohort context you receive is already anonymised. You see persona LABELS + SHARES, theme LABELS + SHARES, channel role aggregates, conversion rates by bucket, recent match summaries. You do NOT see couple names, partner names, emails, phones, or evidence quotes that identify a couple.
- NEVER name a couple in evidence_summary. Use "Couple A", "Couple B" relative references inside one discovery if you must cite specific anonymised examples — and these are NOT stable IDs across discoveries.
- Aggregate ≠ disclose. Persona shares, theme counts, conversion rates, channel-role distributions are safe. Per-couple PII is not — and you don't have it anyway, so don't fabricate it.
- If the cohort is too small (< 10 couples in window) for a hypothesis to be more than noise, refuse with "field": "discoveries", "reason": "cohort too small (n=X)" and emit zero discoveries.

DISCOVERY DISCIPLINE
- Cap at 5 discoveries per run. Quality over quantity. Don't dilute with low-confidence noise.
- Confidence 0-100 reflects the EVIDENCE STRENGTH, not your enthusiasm. A 70 means "the pattern is visible in the data, but a test is needed". A 90 means "this is unmistakably present and the operator should test it now".
- Each discovery MUST include a recommended_test. The test is what Wave 7C will execute. Make it specific: "compare conversion rate of <bucket A> vs <bucket B> over the next 60 days; lift > 1.3x = validated".
- Each discovery MUST include a recommended_action_if_validated. This is what the operator does after the test confirms. "Reduce Knot spend by 30%, redirect to Instagram targeting Heritage-Forward."
- Hypothesis category is your invention. Use snake_case. If a familiar category fits, use it (channel_role_distortion, vendor_referral_unobserved, persona_channel_pattern, stale_warm_lead, booking_blocker_question, time_of_day_pattern, cross_platform_drift, competitor_positioning, demographic_clustering, conversion_rate_disparity). If none fits, invent one — that's the design.

OUTPUT — JSON only, exactly this shape:
{
  "discoveries": [
    {
      "hypothesis_title": "<short headline, < 80 chars>",
      "hypothesis_text": "<full paragraph explaining the pattern, the evidence chain, and what makes it actionable>",
      "hypothesis_category": "<snake_case category, free-form — invent a new one if needed>",
      "evidence_summary": {
        "signal_type": "<what kind of signal grounded this — e.g. 'channel_role_inference' | 'vendor_co_mention' | 'time_of_day_distribution'>",
        "n_couples": <int>,
        "n_evidence_points": <int>,
        "aggregate_stats": { <free-form object — LLM decides shape> },
        "key_observations": ["<plain-English bullet>", "..."]
      },
      "recommended_test": "<specific test plan — what to compare, how to interpret>",
      "recommended_action_if_validated": "<concrete operator action>",
      "confidence_0_100": <int>
    }
  ],
  "refusals": [{ "field": "<field>", "reason": "<reason>" }]
}

DO NOT:
- Echo couple names. You don't have them; don't invent them.
- Pad to 5 discoveries when only 2 strong patterns exist. Empty slots are fine.
- Re-state what the operator already knows ("you got 12 inquiries this week"). That's reporting, not discovery.
- Repeat the same pattern under three different categories. Pick one.
- Suggest auto-executing the action. Wave 7A only generates hypotheses; the operator decides.`
}

export function buildDiscoveryEngineUserPrompt(
  evidence: DiscoveryEvidence,
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
    lines.push('(none — discovery may still surface non-persona patterns)')
  } else {
    for (const p of evidence.personaDistribution) {
      lines.push(
        `- ${p.persona_label} | share=${p.share_pct}% | n=${p.n_couples}`,
      )
    }
  }
  lines.push('')

  lines.push(`PERSONA CLOSE-PROBABILITY MEDIANS`)
  if (evidence.personaCloseProbabilities.length === 0) {
    lines.push('(none — couple_intel may not have populated yet)')
  } else {
    for (const c of evidence.personaCloseProbabilities) {
      lines.push(
        `- ${c.persona_label}: median close=${c.median_close_probability_0_100} (n=${c.n_couples})`,
      )
    }
  }
  lines.push('')

  lines.push(`CHANNEL × ROLE DISTRIBUTION (Wave 7B output)`)
  if (evidence.channelRoleShares.length === 0) {
    lines.push('(none — attribution_events.role may not have populated yet)')
  } else {
    for (const c of evidence.channelRoleShares) {
      lines.push(
        `- ${c.source_platform}: acq=${c.acquisition_count} val=${c.validation_count} conv=${c.conversion_count} unk=${c.unknown_count}`,
      )
    }
  }
  lines.push('')

  lines.push(`CONVERSION BY BUCKET (channel or persona × channel)`)
  if (evidence.conversionByBucket.length === 0) {
    lines.push('(none — buckets too small to compute)')
  } else {
    for (const c of evidence.conversionByBucket) {
      const heat = c.median_close_probability_0_100 !== null
        ? ` heat=${c.median_close_probability_0_100}`
        : ''
      lines.push(
        `- ${c.bucket}: inquiries=${c.n_inquiries} booked=${c.n_booked} conv=${c.conversion_pct}%${heat}`,
      )
    }
  }
  lines.push('')

  lines.push(`VENUE COHORT ROLLUP (Wave 5B summary)`)
  const r = evidence.venueIntelRollup
  if (!r) {
    lines.push('(none — venue_intel.rollup not yet populated)')
  } else {
    if (r.emerging_themes.length > 0) {
      lines.push(`emerging_themes:`)
      for (const t of r.emerging_themes) {
        lines.push(
          `- ${t.theme} | trend=${t.trend} | n=${t.evidence_count}`,
        )
      }
    }
    if (r.conversion_correlations.length > 0) {
      lines.push(`conversion_correlations:`)
      for (const c of r.conversion_correlations) {
        lines.push(`- ${c.signal} | trend=${c.trend} | lift=${c.lift}`)
      }
    }
    if (r.service_demand_top.length > 0) {
      lines.push(`service_demand_top:`)
      for (const s of r.service_demand_top) {
        lines.push(`- ${s.service}: ${s.share_pct}% share`)
      }
    }
    if (r.timing_patterns_top.length > 0) {
      lines.push(`timing_patterns_top:`)
      for (const p of r.timing_patterns_top) {
        lines.push(`- ${p}`)
      }
    }
  }
  lines.push('')

  lines.push(`RECENT EXTERNAL MATCHES (Wave 5C summaries)`)
  if (evidence.recentMatches.length === 0) {
    lines.push('(none in recent window)')
  } else {
    for (const m of evidence.recentMatches.slice(0, 30)) {
      const fit = m.cohort_fit_score_0_100 !== null
        ? ` fit=${m.cohort_fit_score_0_100}`
        : ''
      lines.push(
        `- [${m.signal_type}] ${m.summary} | conf=${m.match_confidence_0_100}${fit}`,
      )
    }
  }
  lines.push('')

  lines.push(`INQUIRY TIME-OF-DAY DISTRIBUTION`)
  if (evidence.timeOfDayCounts.length === 0) {
    lines.push('(none — timestamps unavailable)')
  } else {
    for (const t of evidence.timeOfDayCounts) {
      lines.push(`- ${t.bucket}: ${t.n_inquiries} inquiries`)
    }
  }
  lines.push('')

  if (evidence.sensitiveThemesPresent) {
    lines.push(
      `(NOTE: sensitive themes are present in the cohort. They have been STRIPPED from this prompt per aggregate ≠ disclose discipline.)`,
    )
    lines.push('')
  }

  lines.push(
    `Hunt for up to 5 unknown-unknown patterns. Invent a hypothesis_category for each — don't fill a pre-defined bucket. Refuse if the cohort is too small (< 10 couples) for a meaningful hypothesis.`,
  )
  lines.push(`Return JSON only, no prose preamble, no markdown fences.`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === 'string')
}

export function validateDiscoveryEngineOutput(
  raw: unknown,
):
  | { ok: true; output: DiscoveryEngineOutput }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'output is not an object' }
  }
  const r = raw as Record<string, unknown>

  // discoveries: array (possibly empty)
  const discoveriesRaw = r['discoveries']
  if (!Array.isArray(discoveriesRaw)) {
    return { ok: false, error: 'discoveries missing or not an array' }
  }

  const discoveries: Discovery[] = []
  for (let i = 0; i < discoveriesRaw.length; i++) {
    const d = discoveriesRaw[i]
    if (!d || typeof d !== 'object') {
      return { ok: false, error: `discoveries[${i}] not an object` }
    }
    const dd = d as Record<string, unknown>
    const title = dd['hypothesis_title']
    if (typeof title !== 'string' || title.length === 0) {
      return { ok: false, error: `discoveries[${i}].hypothesis_title missing` }
    }
    const text = dd['hypothesis_text']
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, error: `discoveries[${i}].hypothesis_text missing` }
    }
    const category = dd['hypothesis_category']
    if (typeof category !== 'string' || category.length === 0) {
      return {
        ok: false,
        error: `discoveries[${i}].hypothesis_category missing`,
      }
    }
    const ev = dd['evidence_summary']
    if (!ev || typeof ev !== 'object') {
      return { ok: false, error: `discoveries[${i}].evidence_summary missing` }
    }
    const evRec = ev as Record<string, unknown>
    const signalType = evRec['signal_type']
    if (typeof signalType !== 'string') {
      return {
        ok: false,
        error: `discoveries[${i}].evidence_summary.signal_type missing`,
      }
    }
    const nCouples = Number(evRec['n_couples'] ?? 0)
    const nEvidence = Number(evRec['n_evidence_points'] ?? 0)
    const aggregateStats =
      evRec['aggregate_stats'] && typeof evRec['aggregate_stats'] === 'object'
        ? (evRec['aggregate_stats'] as Record<string, unknown>)
        : {}
    const keyObservations = isStringArray(evRec['key_observations'])
      ? (evRec['key_observations'] as string[])
      : []
    const recommendedTest = dd['recommended_test']
    if (typeof recommendedTest !== 'string') {
      return {
        ok: false,
        error: `discoveries[${i}].recommended_test missing`,
      }
    }
    const recommendedAction = dd['recommended_action_if_validated']
    if (typeof recommendedAction !== 'string') {
      return {
        ok: false,
        error: `discoveries[${i}].recommended_action_if_validated missing`,
      }
    }
    const conf = Number(dd['confidence_0_100'])
    if (!Number.isFinite(conf) || conf < 0 || conf > 100) {
      return {
        ok: false,
        error: `discoveries[${i}].confidence_0_100 invalid`,
      }
    }
    discoveries.push({
      hypothesis_title: title.slice(0, 200),
      hypothesis_text: text,
      hypothesis_category: category.slice(0, 100),
      evidence_summary: {
        signal_type: signalType,
        n_couples: Number.isFinite(nCouples)
          ? Math.max(0, Math.round(nCouples))
          : 0,
        n_evidence_points: Number.isFinite(nEvidence)
          ? Math.max(0, Math.round(nEvidence))
          : 0,
        aggregate_stats: aggregateStats,
        key_observations: keyObservations,
      },
      recommended_test: recommendedTest,
      recommended_action_if_validated: recommendedAction,
      confidence_0_100: Math.round(conf),
    })
  }

  // refusals: array (possibly empty)
  const refusalsRaw = r['refusals']
  const refusals: Array<{ field: string; reason: string }> = []
  if (Array.isArray(refusalsRaw)) {
    for (const x of refusalsRaw) {
      if (!x || typeof x !== 'object') continue
      const xx = x as Record<string, unknown>
      const field = xx['field']
      const reason = xx['reason']
      if (typeof field === 'string' && typeof reason === 'string') {
        refusals.push({ field, reason })
      }
    }
  }

  // Cap at 5 discoveries — second line of defense behind the prompt rule.
  const capped = discoveries
    .slice()
    .sort((a, b) => b.confidence_0_100 - a.confidence_0_100)
    .slice(0, 5)

  return {
    ok: true,
    output: {
      discoveries: capped,
      refusals,
    },
  }
}
