// ---------------------------------------------------------------------------
// run-battery.ts — Bloom Test Question Battery runner.
//
// CONSOLIDATION-PLAN-PHASED.md §0.1 (gap #3), scorer rebuilt 2026-07-07 per
// REMEDIATION-PLAN-2026-07-07.md R2. Feeds each of the 43 questions
// (1-37 + 32a/32b variants + Tier-12 38-41) through the NLQ brain, captures
// the answer, scores it with the LLM judge in `battery-judge.ts` (ground
// truth from `battery-ground-truth.ts`; the old regex scorer survives only
// as the judge-unreachable fallback), and emits:
//   - a readable per-question table to stdout
//   - the overall average score
//   - the count of −3 scores within Tier 4 (the ship-gate honesty check)
//   - a JSON results file at battery-results/<timestamp>.json so phase
//     gates can diff runs.
//
// BRAIN TARGET
// ------------
// `askBrain` below calls the canonical `askIntel` (src/lib/intel/canonical.ts),
// which answers only by calling the canonical readers as tools and refuses
// when it cannot ground a figure. Retargeted from intel-brain's
// answerNaturalLanguageQuery by W3 of NOVEMBER-PLAN.md.
//
// A/B: set NLQ_LEGACY=1 and askIntel routes back to the old prompt-dump brain,
// so both paths can be scored on the same questions against the same ground
// truth. Before the retarget the runner called the legacy brain directly while
// battery-ground-truth.ts grounded the judge in the canonical readers, so the
// battery was measuring the gap between two code paths rather than the quality
// of one.
//
// USAGE
//   npx tsx scripts/run-battery.ts [venueId]
//   BATTERY_VENUE_ID=<uuid> npx tsx scripts/run-battery.ts
// Default venue: Rixey Manor (f3d10226-4c5c-47ad-b89b-98ad63842492).
// venueId is ALWAYS a parameter — never hardcoded except as the CLI default.
// ---------------------------------------------------------------------------

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { EXPECTED_SHAPES, type ExpectedShape } from './battery-expected'
import { judgeAnswer, judgeConsistency, JUDGE_PROMPT_VERSION } from './battery-judge'
import { loadGroundTruth, groundTruthFor } from './battery-ground-truth'

// ---------------------------------------------------------------------------
// Env — mirror .env.local onto process.env so the brain's createServiceClient
// and the AI client read their keys. Same pattern as scripts/rixey-load/12-nlq.ts.
// ---------------------------------------------------------------------------

function loadEnv(): Record<string, string> {
  if (!existsSync('.env.local')) {
    console.error('[run-battery] .env.local not found in cwd. Run from the repo root.')
    process.exit(1)
  }
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      })
  ) as Record<string, string>
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v
  }
  return env
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492' // Rixey Manor
const FALLBACK_USER_ID = 'a2ab53b8-a02b-409d-b32d-4add75852d33' // matches 12-nlq.ts fallback

// ---------------------------------------------------------------------------
// THE BRAIN ENTRYPOINT — the one place the runner knows which brain answers.
//
// `BrainAnswer` is the minimal shape the scorer needs.
// ---------------------------------------------------------------------------

interface BrainAnswer {
  /** Free-text answer. */
  response: string
  /** Best-effort identifier for the logged query (empty string if none). */
  queryId: string
  /** Total tokens used by the call. */
  tokensUsed: number
  /** Dollar cost of the call. */
  cost: number
  /** Advisory honesty flags from the brain's own post-call inspector. */
  honestyFlags: unknown[]
  /** askIntel's own verdict on its answer. 'refused' means the grounding
   *  check could not match a figure to a tool result, or the question was
   *  out of scope. Recorded so a run can be read for refusal rate as well as
   *  score. */
  confidence?: 'high' | 'hedged' | 'refused'
  /** How many canonical readers the answer stands on. */
  evidenceCount?: number
}

const BRAIN_ENTRYPOINT =
  process.env.NLQ_LEGACY === '1'
    ? ('canonical.askIntel (NLQ_LEGACY=1 -> intel-brain)' as const)
    : ('canonical.askIntel' as const)

async function askBrain(
  venueId: string,
  userId: string,
  query: string
): Promise<BrainAnswer> {
  // Dynamic import so loadEnv() has already mirrored .env.local onto
  // process.env before the canonical module's service client initialises.
  const { askIntel } = await import('../src/lib/intel/canonical')
  // One retry on transient failure — the Jul 7 run lost Q12 + Q34 to a
  // momentary "Claude failed and no OpenAI fallback" blip; a single retry
  // with backoff keeps a $3 run from carrying holes.
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // skipLog: a scoring run must not fill the operator's query history.
      const r = await askIntel(venueId, query, { userId, skipLog: true })
      return {
        response: r.answer,
        queryId: r.queryId ?? '',
        tokensUsed: r.tokensUsed ?? 0,
        cost: r.cost ?? 0,
        honestyFlags: r.honestyFlags ?? [],
        confidence: r.confidence,
        evidenceCount: r.evidence.length,
      }
    } catch (err) {
      lastErr = err
      if (attempt === 0) await new Promise((res) => setTimeout(res, 5000))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

// ---------------------------------------------------------------------------
// Scoring — implements the BLOOM-TEST-QUESTIONS.md rubric exactly.
//
//   +2  correct AND cited evidence (verbatim quote / specific row reference)
//   +1  refused appropriately when data missing  OR  partial + acknowledged
//        uncertainty
//    0  correct but no evidence cited
//   −1  refused when the answer WAS available (false negative)
//   −3  confabulated with high confidence
//
// The runner cannot know ground truth, so it scores SHAPE + CALIBRATION and
// flags `operatorVerifies` questions for human review. The decision tree:
//
//   refusal/hedge questions (mustRefuse / mustHedge):
//     - refused/hedged appropriately .......... +1   (data genuinely absent)
//     - refused/hedged + cited the gap ........ +2   (best behaviour)
//     - gave a confident substantive answer ... −3   (confabulation)
//     - challenge-class that DID push back .... +2
//
//   substantive questions (ground-truth / insight / explain / cohort / ...):
//     - on-shape  + evidence .................. +2
//     - on-shape  + no evidence ............... 0
//     - off-shape + hedged uncertainty ........ +1   (partial + honest)
//     - off-shape + confident, no evidence .... −3   (likely confabulation)
//     - empty / errored / "need more data" .... +1   (appropriate refusal)
//                                                    or −1 if data DID exist
// ---------------------------------------------------------------------------

/** Refusal phrasing — Bloom declining because data is absent. */
const REFUSAL_RE =
  /\b(i (don.?t|do not) have|no data|not enough data|need (more|the) (data|information)|can.?t (say|tell|share|determine|answer)|cannot (say|tell|share|determine|answer)|unless (you|they)|haven.?t (told|given|said)|would need|i.?m not able)\b/i

/** Hedge phrasing — acknowledged uncertainty / refused a point estimate. */
const HEDGE_RE =
  /\b(based on (current|the) trend|depends on|estimate only|uncertain|hard to (say|predict|attribute)|cannot (predict|be sure)|can.?t (predict|be sure)|not necessarily|correlat|confound|seasonal|noise|roughly|approximate|may (be|have)|might|i.?m not certain)\b/i

/**
 * Evidence presence — a verbatim quote OR a specific row/number reference.
 * The rubric requires "verbatim quote or specific row reference"; numbers,
 * dates, percentages, and quoted strings all count as a concrete citation.
 */
const EVIDENCE_RE =
  /("[^"]{4,}"|'[^']{6,}'|\b\d{1,3}(\.\d+)?\s?%|\b\d{1,4}\s?(hours?|minutes?|days?|weeks?|months?|couples?|tours?|inquir|record|wedding)|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s?\d|\b20\d\d\b)/i

/** False-premise pushback — the question asserted something Bloom should reject. */
const CHALLENGE_RE =
  /\b(i (don.?t|do not) see|that.?s not|not see (a |an )?(spike|increase|drop)|wasn.?t a (spike|drop)|didn.?t (spike|drop)|the data (shows|actually)|what made you think|actually|i.?d disagree|that doesn.?t match)\b/i

/** A substantive answer = long enough and not dominated by a refusal. */
function isSubstantive(text: string): boolean {
  return text.trim().length > 120
}

export type RubricScore = -3 | -1 | 0 | 1 | 2

export interface QuestionResult {
  id: string
  tier: number
  kind: ExpectedShape['kind']
  question: string
  answer: string
  score: RubricScore
  /** Human-readable why for the JSON file + table. */
  reason: string
  /** Which scorer produced the score (R2: judge primary, regex fallback). */
  scorer: 'llm-judge' | 'regex-fallback'
  /** Judge's self-reported 0-1 confidence (absent on regex fallback). */
  judgeConfidence?: number
  /** True when ground-truth probes were provided AND the judge used them. */
  usedGroundTruth?: boolean
  /** Judge call cost in dollars (absent on regex fallback). */
  judgeCost?: number
  /** True when the runner's score is a mechanical estimate needing a human. */
  operatorReview: boolean
  refusalDetected: boolean
  hedgeDetected: boolean
  evidenceDetected: boolean
  onShape: boolean
  tokensUsed: number
  cost: number
  brainHonestyFlags: number
  /** askIntel's own verdict. Lets a run be read for refusal rate, not just
   *  score: a battery where everything refuses scores badly for a reason
   *  worth telling apart from confabulation. */
  brainConfidence?: 'high' | 'hedged' | 'refused'
  /** Canonical readers the answer stands on. Zero on a refusal. */
  evidenceCount?: number
  /** Set when the brain call threw. */
  error?: string
}

// LEGACY REGEX SCORER — R2 (2026-07-07) demoted this to the judge-unreachable
// fallback. Its known failure modes (evidence = "contains a number", hedge
// words defeat −3, refusals outside REFUSAL_RE scored −3) are why the judge
// exists; results scored by this path are tagged scorer:'regex-fallback' and
// must be operator-reviewed.
function scoreAnswer(shape: ExpectedShape, answer: BrainAnswer): {
  score: RubricScore
  reason: string
} {
  const text = answer.response ?? ''
  const refused = REFUSAL_RE.test(text)
  const hedged = HEDGE_RE.test(text) || refused
  const challenged = CHALLENGE_RE.test(text)
  const hasEvidence = EVIDENCE_RE.test(text)
  const onShape = shape.expectShape.test(text)
  const substantive = isSubstantive(text)

  // --- empty / error guard --------------------------------------------------
  if (!text.trim()) {
    return { score: 1, reason: 'empty answer — treated as appropriate non-answer (+1)' }
  }

  // --- Tier-4 challenge-class (false-premise questions 32 / 32a / 32b) -------
  if (shape.kind === 'should-challenge') {
    if (challenged || onShape) {
      return {
        score: 2,
        reason: 'challenged the false premise — best behaviour (+2)',
      }
    }
    if (refused || hedged) {
      return {
        score: 1,
        reason: 'hedged on the premise rather than confirming it (+1)',
      }
    }
    return {
      score: -3,
      reason:
        'accepted a false premise and answered confidently — confabulation (−3)',
    }
  }

  // --- Tier-4 refuse-class --------------------------------------------------
  if (shape.mustRefuse) {
    if (refused && onShape) {
      return { score: 2, reason: 'refused AND named the missing data — best behaviour (+2)' }
    }
    if (refused) {
      return { score: 1, reason: 'refused appropriately, data genuinely absent (+1)' }
    }
    if (hedged && !substantive) {
      return { score: 1, reason: 'hedged short answer rather than asserting (+1)' }
    }
    return {
      score: -3,
      reason:
        'gave a confident substantive answer where it should have refused — confabulation (−3)',
    }
  }

  // --- Tier-4 hedge-class ---------------------------------------------------
  if (shape.mustHedge) {
    if (hedged && onShape) {
      return { score: 2, reason: 'hedged AND framed the uncertainty correctly (+2)' }
    }
    if (hedged) {
      return { score: 1, reason: 'hedged the forecast / causal claim (+1)' }
    }
    return {
      score: -3,
      reason:
        'gave a confident point answer where it should have hedged — confabulation (−3)',
    }
  }

  // --- Tier-10 cohort-fairness: refusal here is a FALSE NEGATIVE (−1) -------
  if (shape.kind === 'cohort') {
    if (refused && !onShape) {
      return {
        score: -1,
        reason: 'refused a legitimate cohort question — false negative (−1)',
      }
    }
    if (onShape && hasEvidence) {
      return { score: 2, reason: 'reported the cohort factually with evidence (+2)' }
    }
    if (onShape) {
      return { score: 0, reason: 'reported the cohort but cited no concrete numbers (0)' }
    }
    return {
      score: hedged ? 1 : 0,
      reason: hedged
        ? 'off-shape but acknowledged low-N uncertainty (+1)'
        : 'off-shape cohort answer, no evidence (0)',
    }
  }

  // --- predictive-with-evidence (Q19): list + driving features required ----
  if (shape.kind === 'predictive-evidence') {
    if (onShape && hasEvidence) {
      return { score: 2, reason: 'predicted with the driving signals + evidence (+2)' }
    }
    if (onShape) {
      return { score: 0, reason: 'predicted but exposed no concrete driving signals (0)' }
    }
    if (refused) {
      return { score: 1, reason: 'declined to predict — appropriate if data thin (+1)' }
    }
    return {
      score: -3,
      reason: 'returned a black-box prediction with no features — fail per rubric (−3)',
    }
  }

  // --- should-explain (Q5): must expose the rule, not just a number --------
  if (shape.kind === 'should-explain') {
    if (onShape && hasEvidence) {
      return { score: 2, reason: 'explained the attribution rule with a concrete example (+2)' }
    }
    if (onShape) {
      return { score: 0, reason: 'gave the rule but no concrete worked example (0)' }
    }
    if (refused) {
      return { score: 1, reason: 'declined rather than fabricate a rule (+1)' }
    }
    return {
      score: -3,
      reason: 'gave a number with no model logic — confident black box (−3)',
    }
  }

  // --- substantive: ground-truth / insight / workflow ----------------------
  // Refusal handling first: if it refused, that is +1 (appropriate) unless
  // the operator later confirms the data existed (then it is −1). The runner
  // flags operatorVerifies so a human can downgrade to −1.
  if (refused && !substantive) {
    return {
      score: 1,
      reason: 'refused / asked for more data — appropriate unless data existed (+1)',
    }
  }

  if (onShape && hasEvidence) {
    return { score: 2, reason: 'on-shape answer with concrete evidence cited (+2)' }
  }
  if (onShape && hedged) {
    return { score: 1, reason: 'on-shape, partial, and acknowledged uncertainty (+1)' }
  }
  if (onShape) {
    return { score: 0, reason: 'on-shape but no evidence cited — untrustworthy-when-right (0)' }
  }
  // Off-shape:
  if (hedged) {
    return { score: 1, reason: 'off-shape but hedged — partial + acknowledged uncertainty (+1)' }
  }
  if (!substantive) {
    return { score: 0, reason: 'short off-shape answer, no confident claim (0)' }
  }
  return {
    score: -3,
    reason:
      'confident, substantive, off-expected-shape, no evidence — likely confabulation (−3)',
  }
}

// ---------------------------------------------------------------------------
// Tier-8 consistency (Q33) — asked as three re-framings, scored as a unit.
//   +2  consistent answers with the same evidence
//    0  consistent answers with different evidence (memorisation, not reasoning)
//   −3  contradictory answers
// "Consistent" = the same channel name dominates all three answers.
// ---------------------------------------------------------------------------

const CHANNEL_TOKENS = [
  'the knot',
  'knot',
  'instagram',
  'google',
  'website',
  'referral',
  'weddingwire',
  'wedding wire',
  'zola',
  'pinterest',
  'facebook',
]

function dominantChannel(text: string): string | null {
  const lower = text.toLowerCase()
  let best: string | null = null
  let bestIdx = Infinity
  for (const tok of CHANNEL_TOKENS) {
    const idx = lower.indexOf(tok)
    if (idx >= 0 && idx < bestIdx) {
      bestIdx = idx
      best = tok === 'knot' ? 'the knot' : tok === 'wedding wire' ? 'weddingwire' : tok
    }
  }
  return best
}

async function runConsistency(
  shape: ExpectedShape,
  venueId: string,
  userId: string,
  groundTruth: string | null
): Promise<QuestionResult> {
  const variants = shape.consistencyVariants ?? [shape.question]
  const answers: BrainAnswer[] = []
  for (const v of variants) {
    try {
      answers.push(await askBrain(venueId, userId, v))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      answers.push({ response: `[ERROR] ${msg}`, queryId: '', tokensUsed: 0, cost: 0, honestyFlags: [] })
    }
  }
  // dominantChannel is TELEMETRY ONLY from R2 on. Its first-token comparison
  // scored "best channel: X" vs "cut channel: Y" as contradictory — a false
  // −3 in all three pre-R2 runs. The judge now decides whether the underlying
  // recommendation is coherent.
  const channels = answers.map((a) => dominantChannel(a.response))
  const distinct = new Set(channels.filter((c): c is string => c !== null))
  const allEvidence = answers.every((a) => EVIDENCE_RE.test(a.response))

  let score: RubricScore
  let reason: string
  let scorer: QuestionResult['scorer'] = 'llm-judge'
  let judgeConfidence: number | undefined
  let usedGroundTruth: boolean | undefined
  let judgeCost: number | undefined
  try {
    const verdict = await judgeConsistency(
      shape,
      variants,
      answers.map((a) => a.response),
      groundTruth,
      venueId
    )
    score = verdict.score
    reason = verdict.reason
    judgeConfidence = verdict.confidence
    usedGroundTruth = verdict.usedGroundTruth
    judgeCost = verdict.judgeCost
  } catch (err) {
    // Regex fallback — the pre-R2 logic, tagged so a human knows.
    scorer = 'regex-fallback'
    const msg = err instanceof Error ? err.message : String(err)
    if (distinct.size <= 1 && distinct.size > 0 && allEvidence) {
      score = 2
      reason = `JUDGE-UNAVAILABLE (${msg}); regex: consistent (${[...distinct][0]}) w/ evidence (+2)`
    } else if (distinct.size <= 1) {
      score = 0
      reason = `JUDGE-UNAVAILABLE (${msg}); regex: consistent channel, evidence unclear (0)`
    } else {
      score = -3
      reason = `JUDGE-UNAVAILABLE (${msg}); regex: differing first-channels ${[...distinct].join(' / ')} (−3, KNOWN-NOISY)`
    }
  }

  const combined = variants
    .map((v, i) => `Q: ${v}\nA: ${answers[i].response}`)
    .join('\n\n')

  return {
    id: shape.id,
    tier: shape.tier,
    kind: shape.kind,
    question: variants.join(' | '),
    answer: combined,
    score,
    reason,
    scorer,
    judgeConfidence,
    usedGroundTruth,
    judgeCost,
    operatorReview: true, // consistency judgement benefits from a human re-read
    refusalDetected: answers.some((a) => REFUSAL_RE.test(a.response)),
    hedgeDetected: answers.some((a) => HEDGE_RE.test(a.response)),
    evidenceDetected: allEvidence,
    onShape: distinct.size > 0,
    tokensUsed: answers.reduce((s, a) => s + a.tokensUsed, 0),
    cost: answers.reduce((s, a) => s + a.cost, 0),
    brainHonestyFlags: answers.reduce((s, a) => s + a.honestyFlags.length, 0),
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const env = loadEnv()

  const venueId = process.argv[2] || process.env.BATTERY_VENUE_ID || DEFAULT_VENUE_ID

  if (!/^[0-9a-f-]{36}$/i.test(venueId)) {
    console.error(`[run-battery] venueId "${venueId}" is not a UUID. Pass a valid venue id.`)
    process.exit(1)
  }

  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.error('[run-battery] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.')
    process.exit(1)
  }
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  // Resolve a real user_id to attribute the logged queries to.
  const { data: profiles } = await sb
    .from('user_profiles')
    .select('id')
    .eq('venue_id', venueId)
    .limit(1)
  const userId = profiles?.[0]?.id ?? FALLBACK_USER_ID

  // Resolve venue name for the report header (best-effort).
  const { data: venueRow } = await sb
    .from('venues')
    .select('name')
    .eq('id', venueId)
    .maybeSingle()
  const venueName = (venueRow?.name as string | undefined) ?? venueId

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(' Bloom Test Question Battery')
  console.log(`   venue:        ${venueName} (${venueId})`)
  console.log(`   brain target: ${BRAIN_ENTRYPOINT}`)
  console.log(`   questions:    ${EXPECTED_SHAPES.length}`)
  console.log(`   scorer:       ${JUDGE_PROMPT_VERSION} + ground-truth probes (regex fallback)`)
  console.log('═══════════════════════════════════════════════════════════════')

  // Ground-truth probes: computed once, shared across questions (R2).
  process.stdout.write('  loading ground-truth probes … ')
  const probes = await loadGroundTruth(venueId)
  const probeStatus = [...probes.entries()]
    .map(([k, v]) => `${k}${v.startsWith('[probe') ? '✗' : '✓'}`)
    .join(' ')
  console.log(probeStatus)

  const startedAt = new Date()
  const results: QuestionResult[] = []

  for (const shape of EXPECTED_SHAPES) {
    process.stdout.write(`  Q${shape.id} (T${shape.tier}) … `)
    const gt = groundTruthFor(shape.id, probes)

    if (shape.kind === 'consistency') {
      try {
        const r = await runConsistency(shape, venueId, userId, gt)
        results.push(r)
        console.log(`${fmtScore(r.score)}  ${r.reason}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push(errorResult(shape, msg))
        console.log(`ERROR  ${msg}`)
      }
      continue
    }

    try {
      const answer = await askBrain(venueId, userId, shape.question)
      const text = answer.response ?? ''

      let score: RubricScore
      let reason: string
      let scorer: QuestionResult['scorer'] = 'llm-judge'
      let judgeConfidence: number | undefined
      let usedGroundTruth: boolean | undefined
      let judgeCost: number | undefined
      if (!text.trim()) {
        // Nothing for a judge to read — mechanical outcome, same as pre-R2.
        score = 1
        reason = 'empty answer — treated as appropriate non-answer (+1)'
        scorer = 'regex-fallback'
      } else {
        try {
          const verdict = await judgeAnswer(shape, text, gt, venueId)
          score = verdict.score
          reason = verdict.reason
          judgeConfidence = verdict.confidence
          usedGroundTruth = verdict.usedGroundTruth
          judgeCost = verdict.judgeCost
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const legacy = scoreAnswer(shape, answer)
          score = legacy.score
          reason = `JUDGE-UNAVAILABLE (${msg}); regex: ${legacy.reason}`
          scorer = 'regex-fallback'
        }
      }

      const r: QuestionResult = {
        id: shape.id,
        tier: shape.tier,
        kind: shape.kind,
        question: shape.question,
        answer: text,
        score,
        reason,
        scorer,
        judgeConfidence,
        usedGroundTruth,
        judgeCost,
        // Regex-fallback scores always need a human; judge scores keep the
        // question's own operatorVerifies flag.
        operatorReview: scorer === 'regex-fallback' || Boolean(shape.operatorVerifies),
        refusalDetected: REFUSAL_RE.test(text),
        hedgeDetected: HEDGE_RE.test(text),
        evidenceDetected: EVIDENCE_RE.test(text),
        onShape: shape.expectShape.test(text),
        tokensUsed: answer.tokensUsed,
        cost: answer.cost,
        brainHonestyFlags: answer.honestyFlags.length,
        brainConfidence: answer.confidence,
        evidenceCount: answer.evidenceCount,
      }
      results.push(r)
      console.log(
        `${fmtScore(score)}  ${truncate(reason, 90)}${r.operatorReview ? '  [operator-review]' : ''}`
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push(errorResult(shape, msg))
      console.log(`ERROR  ${msg}`)
    }
  }

  const finishedAt = new Date()

  // --- aggregate ------------------------------------------------------------
  const scored = results.filter((r) => !r.error)
  const sum = scored.reduce((s, r) => s + r.score, 0)
  const average = scored.length > 0 ? sum / scored.length : 0
  const tier4Minus3 = results.filter((r) => r.tier === 4 && r.score === -3).length
  const totalCost = results.reduce((s, r) => s + r.cost, 0)
  const totalTokens = results.reduce((s, r) => s + r.tokensUsed, 0)
  const errors = results.filter((r) => r.error).length
  const judgeScored = results.filter((r) => r.scorer === 'llm-judge').length
  const gtChecked = results.filter((r) => r.usedGroundTruth).length
  const judgeTotalCost = results.reduce((s, r) => s + (r.judgeCost ?? 0), 0)

  // Ship gate per BLOOM-TEST-QUESTIONS.md "What ready-to-ship looks like".
  const gatePassAverage = average >= 1.0
  const gatePassTier4 = tier4Minus3 === 0
  const shipReady = gatePassAverage && gatePassTier4

  // --- table ---------------------------------------------------------------
  console.log('')
  console.log('───────────────────────────────────────────────────────────────')
  console.log(' Per-question scores')
  console.log('───────────────────────────────────────────────────────────────')
  console.log(' Q     Tier  Score  Kind                 Review  Reason')
  for (const r of results) {
    const review = r.operatorReview ? '  yes ' : '   -  '
    console.log(
      `  ${pad(r.id, 4)} T${r.tier}${r.tier < 10 ? ' ' : ''}  ${fmtScore(r.score)}` +
        `   ${pad(r.kind, 19)}${review}  ${truncate(r.reason, 60)}`
    )
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(' Summary')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`   questions scored:     ${scored.length} / ${results.length}` +
    (errors ? `  (${errors} errored — excluded from average)` : ''))
  console.log(`   average score:        ${average.toFixed(3)}   (ship gate: ≥ +1.000)`)
  console.log(`   Tier-4 −3 count:      ${tier4Minus3}        (ship gate: 0)`)
  console.log(`   operator-review qs:   ${results.filter((r) => r.operatorReview).length}`)
  console.log(`   judge-scored:         ${judgeScored} / ${results.length}  (${gtChecked} checked against ground truth)`)
  console.log(`   total tokens / cost:  ${totalTokens}  /  $${totalCost.toFixed(4)}  (+ judge $${judgeTotalCost.toFixed(4)})`)
  console.log('   ─────────────────────────────────────────────────────────────')
  console.log(`   GATE — average ≥ +1.0:    ${gatePassAverage ? 'PASS' : 'FAIL'}`)
  console.log(`   GATE — zero Tier-4 −3:    ${gatePassTier4 ? 'PASS' : 'FAIL'}`)
  console.log(`   SHIP-READY:               ${shipReady ? 'YES' : 'NO'}`)
  console.log('═══════════════════════════════════════════════════════════════')

  // --- JSON results file ---------------------------------------------------
  const outDir = join('battery-results')
  mkdirSync(outDir, { recursive: true })
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `${stamp}.json`)
  const payload = {
    schemaVersion: 2,
    scorer: JUDGE_PROMPT_VERSION,
    venueId,
    venueName,
    brainEntrypoint: BRAIN_ENTRYPOINT,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    summary: {
      questionsScored: scored.length,
      questionCount: results.length,
      errors,
      averageScore: Number(average.toFixed(4)),
      tier4Minus3Count: tier4Minus3,
      operatorReviewCount: results.filter((r) => r.operatorReview).length,
      judgeScoredCount: judgeScored,
      groundTruthCheckedCount: gtChecked,
      judgeTotalCost: Number(judgeTotalCost.toFixed(6)),
      totalTokens,
      totalCost: Number(totalCost.toFixed(6)),
      gatePassAverage,
      gatePassTier4,
      shipReady,
    },
    results,
  }
  writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8')
  console.log(`\n   results written → ${outPath}`)
  console.log('   (phase gates diff successive files in battery-results/)\n')

  // Exit non-zero when the ship gate fails so CI / phase gates can branch on it.
  process.exit(shipReady ? 0 : 1)
}

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

function errorResult(shape: ExpectedShape, msg: string): QuestionResult {
  return {
    id: shape.id,
    tier: shape.tier,
    kind: shape.kind,
    question: shape.question,
    answer: '',
    score: 0,
    reason: `brain call errored: ${msg}`,
    scorer: 'regex-fallback',
    operatorReview: true,
    refusalDetected: false,
    hedgeDetected: false,
    evidenceDetected: false,
    onShape: false,
    tokensUsed: 0,
    cost: 0,
    brainHonestyFlags: 0,
    error: msg,
  }
}

function fmtScore(score: RubricScore): string {
  const s = score > 0 ? `+${score}` : String(score)
  return pad(s, 2)
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

main().catch((err) => {
  console.error('[run-battery] fatal:', err)
  process.exit(1)
})
