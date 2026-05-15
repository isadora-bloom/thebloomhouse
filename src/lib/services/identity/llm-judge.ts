/**
 * Phase B LLM judge — Sonnet adjudicator for ambiguous matcher results.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §2 + Appendix B stop #3
 * ("Phase B merged without LLM judge wired. Stop. Wire it.").
 *
 * The structured matcher (matcher.ts) scores a candidate pair and
 * returns `needs_judge: true` when the score is in the 40-90 band.
 * That's the ambiguous middle: not strong enough to auto-promote, not
 * weak enough to drop. The judge reads the structured signals + raw
 * record details + recent touchpoint history for both records and
 * returns one of {high, medium, low, reject} plus a one-sentence
 * rationale.
 *
 * Rate limiting (doctrine §2)
 * ---------------------------
 *   200 judge calls per Tracer RUN  (caller passes a budget object;
 *                                    we decrement on each call)
 *   50  judge calls per VENUE per DAY (we query couple_merge_events
 *                                       for today's judge events
 *                                       before each call)
 * When either limit is hit we return `judge_budget_exhausted` and the
 * tracer falls back to "queue as candidate_match without LLM tier".
 *
 * Cost: ~$0.003 per call (small JSON in/out, Sonnet). Budget caps so a
 * runaway Tracer run can't burn $X without an operator noticing.
 *
 * NOT a replacement for candidate-ai-adjudicator.ts. That file targets
 * the legacy candidate_identity table; this one targets the new
 * couples/fragments schema. The two coexist while Phase B reads land.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson } from '@/lib/ai/client'
import type { MatchableRecord, MatcherVerdict, MatchTier } from './matcher'

export const LLM_JUDGE_PROMPT_VERSION = 'identity.phase-b.llm-judge.v1'

// ---------------------------------------------------------------------------
// Rate-limit primitives
// ---------------------------------------------------------------------------

const DEFAULT_PER_RUN_BUDGET = 200
const DEFAULT_PER_DAY_BUDGET = 50

export interface JudgeRunBudget {
  /** Decremented on each successful judge invocation. */
  remaining: number
  /** Total at start, for telemetry. */
  initial: number
}

export function newJudgeBudget(initial = DEFAULT_PER_RUN_BUDGET): JudgeRunBudget {
  return { remaining: initial, initial }
}

async function judgeCallsToday(
  supabase: SupabaseClient,
  venueId: string,
): Promise<number> {
  // Each successful judge invocation writes a tracer_run_events row
  // with stage='llm_judge'. Counting those rows in the last 24h is
  // the per-day cap source of truth.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const { count } = await supabase
    .from('tracer_run_events')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('stage', 'llm_judge')
    .gte('occurred_at', since)
  return count ?? 0
}

async function recordJudgeInvocation(
  supabase: SupabaseClient,
  venueId: string,
  runId: string,
  status: 'succeeded' | 'failed',
  detail: Record<string, unknown>,
): Promise<void> {
  // Fire-and-forget. We surface judge load on the tracer-runs dashboard
  // and the per-day cap reads this. A telemetry write failure must not
  // bring down the actual judge call result.
  try {
    await supabase.from('tracer_run_events').insert({
      venue_id: venueId,
      run_id: runId,
      stage: 'llm_judge',
      status,
      rows_seen: 1,
      rows_written: status === 'succeeded' ? 1 : 0,
      detail,
    })
  } catch {
    // intentionally swallowed
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type JudgeOutcome = MatchTier | 'reject'

export interface JudgeVerdict {
  outcome: JudgeOutcome
  reasoning: string
  /** prompt_version + token usage echo. Persisted alongside the merge
   *  event for the calibration loop. */
  meta: {
    prompt_version: string
  }
}

export interface JudgeContext {
  /** Up to ~10 most recent touchpoints per record. The judge reads
   *  these to understand the channel-mix and timeline shape — a
   *  Knot-save-then-Calendly-tour is very different from
   *  two-cold-Gmail-replies. */
  primary_touchpoints: Array<{
    channel: string
    occurred_at: string
    action_type: string
    snippet: string | null
  }>
  secondary_touchpoints: Array<{
    channel: string
    occurred_at: string
    action_type: string
    snippet: string | null
  }>
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an identity adjudicator for a wedding venue intelligence platform.

You are given two records (couples / fragments / channel-scoped persons) that the structured matcher flagged as ambiguous. The structured matcher already scored them in the 40-90 band — strong enough to consider, not strong enough to auto-merge.

Your job: decide whether these two records represent the same human (or couple), and assign a tier.

Decision framework:

- high   — overwhelming evidence they are the same. Examples: full-name match + same wedding date + same email domain + cross-channel timing under 48h. Reserve for cases where a human reviewer would also say "obviously the same person".
- medium — looks like the same person but a human should still confirm. Examples: full-name match + temporal proximity but no email match; first+last-initial + same wedding date + same metro signal.
- low    — possible same person, but should NOT auto-link. Surface as a soft candidate to the operator. Example: first-name match + same week of inquiry, no other corroboration.
- reject — almost certainly different people. Example: same first name but very different wedding dates AND no email/phone overlap AND no temporal proximity.

Read the structured signals AND the touchpoint timelines. The timelines are the tiebreaker:
- A couple actively engaging on multiple channels in the same week is almost always one person.
- A name match between an inquiry-from-2023 and a Knot-save-from-2025 with zero in-between is almost always a different person.
- A clear "saw you on The Knot" or "we DMed on Instagram" in the email body lifts confidence one tier.

When uncertain, return medium with a clear rationale. Do not invent signals not present in the structured score or the touchpoint timeline.

Return ONLY this JSON:
{
  "outcome": "high" | "medium" | "low" | "reject",
  "reasoning": "<one or two sentences>"
}`

function buildUserPrompt(
  primary: MatchableRecord,
  secondary: MatchableRecord,
  matcher: MatcherVerdict,
  ctx: JudgeContext,
): string {
  const lines: string[] = []
  lines.push('STRUCTURED SIGNAL SCORE')
  lines.push(`  total: ${matcher.score}`)
  lines.push(`  tier: ${matcher.tier} (${matcher.needs_judge ? 'in judge band' : 'outside judge band'})`)
  lines.push('  signals:')
  if (matcher.signals.length === 0) {
    lines.push('    (none)')
  } else {
    for (const s of matcher.signals) {
      lines.push(`    - ${s.name} (+${s.weight}) :: ${s.evidence}`)
    }
  }

  lines.push('')
  lines.push('RECORD A (primary)')
  lines.push(`  id: ${primary.id}`)
  lines.push(`  primary_name: ${primary.primary_name ?? '?'}`)
  lines.push(`  partner_name: ${primary.partner_name ?? '?'}`)
  lines.push(`  primary_email: ${primary.primary_email ?? '?'}`)
  lines.push(`  partner_email: ${primary.partner_email ?? '?'}`)
  lines.push(`  primary_phone: ${primary.primary_phone ?? '?'}`)
  lines.push(`  partner_phone: ${primary.partner_phone ?? '?'}`)
  lines.push(`  wedding_date: ${primary.wedding_date ?? '?'}`)
  lines.push(`  observed_at: ${primary.observed_at ?? '?'}`)
  lines.push(`  touchpoints (most recent ${ctx.primary_touchpoints.length}):`)
  for (const tp of ctx.primary_touchpoints) {
    lines.push(`    - ${tp.occurred_at} :: ${tp.channel}/${tp.action_type}${tp.snippet ? ` :: "${tp.snippet.slice(0, 140)}"` : ''}`)
  }

  lines.push('')
  lines.push('RECORD B (secondary)')
  lines.push(`  id: ${secondary.id}`)
  lines.push(`  primary_name: ${secondary.primary_name ?? '?'}`)
  lines.push(`  partner_name: ${secondary.partner_name ?? '?'}`)
  lines.push(`  primary_email: ${secondary.primary_email ?? '?'}`)
  lines.push(`  partner_email: ${secondary.partner_email ?? '?'}`)
  lines.push(`  primary_phone: ${secondary.primary_phone ?? '?'}`)
  lines.push(`  partner_phone: ${secondary.partner_phone ?? '?'}`)
  lines.push(`  wedding_date: ${secondary.wedding_date ?? '?'}`)
  lines.push(`  observed_at: ${secondary.observed_at ?? '?'}`)
  lines.push(`  touchpoints (most recent ${ctx.secondary_touchpoints.length}):`)
  for (const tp of ctx.secondary_touchpoints) {
    lines.push(`    - ${tp.occurred_at} :: ${tp.channel}/${tp.action_type}${tp.snippet ? ` :: "${tp.snippet.slice(0, 140)}"` : ''}`)
  }

  return lines.join('\n')
}

interface AIResponse {
  outcome: JudgeOutcome
  reasoning: string
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface JudgeArgs {
  supabase: SupabaseClient
  venueId: string
  primary: MatchableRecord
  secondary: MatchableRecord
  matcher: MatcherVerdict
  context: JudgeContext
  budget: JudgeRunBudget
  /** Per-day cap. Defaults to 50 per doctrine. Pass 0 to disable. */
  perDayBudget?: number
  /** Correlation id threaded into the recorded telemetry row. Tracer
   *  passes its runId; Linker passes its daily live-run key. */
  runId?: string
}

export type JudgeResult =
  | { kind: 'verdict'; verdict: JudgeVerdict }
  | { kind: 'budget_exhausted'; scope: 'run' | 'day'; remaining_run: number; calls_today: number }
  | { kind: 'judge_skipped_not_in_band' }
  | { kind: 'error'; error: string }

export async function judgeCandidate(args: JudgeArgs): Promise<JudgeResult> {
  if (!args.matcher.needs_judge) {
    return { kind: 'judge_skipped_not_in_band' }
  }
  if (args.budget.remaining <= 0) {
    return {
      kind: 'budget_exhausted',
      scope: 'run',
      remaining_run: 0,
      calls_today: -1,
    }
  }
  const perDay = args.perDayBudget ?? DEFAULT_PER_DAY_BUDGET
  if (perDay > 0) {
    const today = await judgeCallsToday(args.supabase, args.venueId)
    if (today >= perDay) {
      return {
        kind: 'budget_exhausted',
        scope: 'day',
        remaining_run: args.budget.remaining,
        calls_today: today,
      }
    }
  }

  const runId = args.runId ?? 'judge'
  try {
    const userPrompt = buildUserPrompt(args.primary, args.secondary, args.matcher, args.context)
    const response = await callAIJson<AIResponse>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 300,
      temperature: 0.1,
      venueId: args.venueId,
      taskType: 'identity_phase_b_judge',
      tier: 'sonnet',
      promptVersion: LLM_JUDGE_PROMPT_VERSION,
    })
    args.budget.remaining -= 1
    const outcome: JudgeOutcome =
      response.outcome === 'high' ||
      response.outcome === 'medium' ||
      response.outcome === 'low' ||
      response.outcome === 'reject'
        ? response.outcome
        : 'medium'
    await recordJudgeInvocation(args.supabase, args.venueId, runId, 'succeeded', {
      prompt_version: LLM_JUDGE_PROMPT_VERSION,
      outcome,
      matcher_score: args.matcher.score,
      matcher_tier: args.matcher.tier,
      primary_id: args.primary.id,
      secondary_id: args.secondary.id,
      reasoning: response.reasoning ?? null,
    })
    return {
      kind: 'verdict',
      verdict: {
        outcome,
        reasoning: response.reasoning ?? '',
        meta: { prompt_version: LLM_JUDGE_PROMPT_VERSION },
      },
    }
  } catch (err) {
    await recordJudgeInvocation(args.supabase, args.venueId, runId, 'failed', {
      prompt_version: LLM_JUDGE_PROMPT_VERSION,
      error: err instanceof Error ? err.message : String(err),
      primary_id: args.primary.id,
      secondary_id: args.secondary.id,
    })
    return {
      kind: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export const __test = {
  buildUserPrompt,
  judgeCallsToday,
  DEFAULT_PER_RUN_BUDGET,
  DEFAULT_PER_DAY_BUDGET,
}
