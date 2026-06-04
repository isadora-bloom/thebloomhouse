/**
 * Phase C Forwards Linker.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 + §5. The Tracer is the
 * historical sweep; the Forwards Linker is its live counterpart. Every
 * new signal that lands in the venue (inbound email, Calendly RSVP,
 * Knot inquiry, brain-dump artifact, etc.) flows through `linkSignal`
 * so the couples / touchpoints / fragments graph stays current without
 * waiting for the next nightly Tracer run.
 *
 * What this file is
 * -----------------
 * The single per-event entry point. Callers anywhere in the platform
 * normalise their input into a NormalizedSignal and call
 * `linkSignal({ supabase, venueId, signal })`. The function:
 *
 *   1. Fast-path attaches the signal to an existing couple when it
 *      carries a legacy_wedding_id (Phase A established the mirror).
 *   2. Else, scores the signal against recent couples using the same
 *      matcher / LLM judge as the Tracer (doctrine §2 weights).
 *   3. Routes by tier: high → attach as touchpoint to the matched
 *      couple. medium / low → write an orphan touchpoint + queue a
 *      candidate_match. below_threshold → write a fragment.
 *   4. Emits a tracer_run_events row tagged with a stable per-day
 *      run_id (`live:<venue>:<YYYY-MM-DD>`) so the same Phase B
 *      dashboard surfaces live activity alongside batch runs.
 *
 * What this file is NOT
 * ---------------------
 * - A replacement for the existing email / Calendly / Knot writers.
 *   Phase C runs in SHADOW MODE alongside them — the legacy pipeline
 *   keeps writing to weddings / people / interactions exactly as
 *   before. The linker writes to the new couples / touchpoints /
 *   fragments tables in parallel. Phase D will flip read paths over.
 * - The merge engine. When a candidate_match resolves, Phase E's
 *   merge service is what fuses the two records. The linker only
 *   proposes.
 * - The matcher itself. Scoring lives in ./matcher; the linker is
 *   pure routing and telemetry around it.
 *
 * Idempotency
 * -----------
 * Re-running linkSignal with the same (venue_id, channel, external_id)
 * is a no-op. UNIQUE constraints on touchpoints and fragments enforce
 * this at the DB level; the inserters return inserted=false on 23505
 * conflict. A signal that re-fires after a candidate_match resolves
 * will still no-op (the touchpoint already exists), which is correct.
 *
 * Cached-couples optimisation
 * ---------------------------
 * Phase C ships a per-process LRU keyed by (venueId, mtime-bucket).
 * Live ingestion typically processes 1-50 signals per second per
 * venue; loading 2000 couples on every signal would melt the DB.
 * The cache TTL is 60s — fresh enough that a newly-minted couple
 * becomes a match target within a minute, cheap enough to avoid a
 * thundering herd on Supabase. Pass `bypassCache: true` for tests
 * and replay.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { writeOrLog } from '@/lib/db/write-or-log'
import { logEvent } from '@/lib/observability/logger'
import {
  scoreCandidate,
  type MatcherVerdict,
  type MatchTier,
} from './matcher'
import { hardContradiction } from './identity-cascade'
import {
  judgeCandidate,
  newJudgeBudget,
  type JudgeOutcome,
  type JudgeRunBudget,
} from './llm-judge'
import {
  coupleToMatchableRecord,
  findCoupleForLegacyWedding,
  insertTouchpoint,
  loadRecentCouples,
  signalToMatchableRecord,
  type CoupleForMatch,
} from './tracer'
import { applyTierRouting } from './route-by-tier'
import { recordProgressionIfEligible } from './progression'
import { buildJudgeContext } from './judge-context'
import type { NormalizedSignal } from './sources/types'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LinkSignalArgs {
  supabase: SupabaseClient
  venueId: string
  signal: NormalizedSignal
  /** Skip the 60s couples cache. Tests / replay endpoint set true. */
  bypassCache?: boolean
  /** Per-call LLM judge budget. Defaults to 5 (live calls should be cheap). */
  judgeBudget?: JudgeRunBudget
  /** Tag the telemetry row with a non-default source label. Default 'live'. */
  source?: string
  /** Correlation id to thread through the logger. */
  correlationId?: string
}

export type LinkAction =
  | 'attached'           // tier=high → touchpoint attached to existing couple
  | 'candidate_medium'   // tier=medium → orphan tp + candidate_match
  | 'candidate_low'      // tier=low → orphan tp + candidate_match
  | 'minted'             // tier=below_threshold + sufficient identity → new channel-scoped couple
  | 'fragment'           // tier=below_threshold + identity-poor → fragment row
  | 'duplicate'          // re-fire of an already-known external_id
  | 'cold_start'         // venue has zero couples yet → mint/fragment, no match attempted

export interface LinkResult {
  action: LinkAction
  matched_couple_id: string | null
  tier: MatchTier | null
  matcher_score: number | null
  judge_invoked: boolean
  judge_outcome: JudgeOutcome | null
  touchpoint_id: string | null
  candidate_match_queued: boolean
  reason: string
  duplicate: boolean
}

// ---------------------------------------------------------------------------
// Per-venue couples cache (60s TTL)
// ---------------------------------------------------------------------------

interface CacheEntry {
  loadedAt: number
  couples: CoupleForMatch[]
}

const CACHE_TTL_MS = 60_000
const couplesCache = new Map<string, CacheEntry>()

async function getCouplesCached(
  supabase: SupabaseClient,
  venueId: string,
  bypassCache: boolean,
): Promise<CoupleForMatch[]> {
  if (!bypassCache) {
    const hit = couplesCache.get(venueId)
    if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) {
      return hit.couples
    }
  }
  const couples = await loadRecentCouples(supabase, venueId)
  couplesCache.set(venueId, { loadedAt: Date.now(), couples })
  return couples
}

/** Invalidate the per-process couples cache for a venue. Call after a
 * couple insert outside of the linker (e.g., manual operator merge). */
export function invalidateCouplesCache(venueId: string): void {
  couplesCache.delete(venueId)
}

// ---------------------------------------------------------------------------
// Telemetry — write to tracer_run_events with a sticky daily run_id so
// the Phase B dashboard surfaces live activity without a separate table.
// ---------------------------------------------------------------------------

function liveRunIdFor(venueId: string, source: string, now = new Date()): string {
  // tracer_run_events.run_id is text (migration 347). Structured key
  // groups live-linker activity by day in the dashboard.
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  return `${source}:${venueId.slice(0, 8)}:${yyyy}-${mm}-${dd}`
}

async function emitLinkEvent(
  supabase: SupabaseClient,
  venueId: string,
  runId: string,
  result: LinkResult,
  signal: NormalizedSignal,
): Promise<void> {
  await writeOrLog(supabase.from('tracer_run_events').insert({
    venue_id: venueId,
    run_id: runId,
    stage: 'forwards_link',
    status: result.action === 'duplicate' ? 'skipped' : 'succeeded',
    rows_seen: 1,
    rows_written: result.touchpoint_id ? 1 : 0,
    detail: {
      kind: 'live_linker',
      action: result.action,
      tier: result.tier,
      matcher_score: result.matcher_score,
      judge_invoked: result.judge_invoked,
      judge_outcome: result.judge_outcome,
      matched_couple_id: result.matched_couple_id,
      candidate_match_queued: result.candidate_match_queued,
      reason: result.reason,
      signal: {
        channel: signal.channel,
        action_type: signal.action_type,
        external_id: signal.external_id,
        identity_hint: signal.identity_hint,
        wedding_date: signal.wedding_date,
      },
    },
  }), { op: 'tracer_run_events.insert', venueId })
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function linkSignal(args: LinkSignalArgs): Promise<LinkResult> {
  const { supabase, venueId, signal } = args
  const source = args.source ?? 'live'
  const runId = liveRunIdFor(venueId, source)
  const judgeBudget = args.judgeBudget ?? newJudgeBudget(5)

  const result: LinkResult = {
    action: 'fragment',
    matched_couple_id: null,
    tier: null,
    matcher_score: null,
    judge_invoked: false,
    judge_outcome: null,
    touchpoint_id: null,
    candidate_match_queued: false,
    reason: '',
    duplicate: false,
  }

  try {
    // 1. Legacy-wedding fast path.
    if (signal.legacy_wedding_id) {
      const coupleId = await findCoupleForLegacyWedding(
        supabase,
        venueId,
        signal.legacy_wedding_id,
      )
      if (coupleId) {
        const r = await insertTouchpoint(supabase, venueId, coupleId, signal)
        result.action = r.inserted ? 'attached' : 'duplicate'
        result.matched_couple_id = coupleId
        result.tier = 'high'
        result.matcher_score = 999
        result.touchpoint_id = r.touchpoint_id
        result.duplicate = !r.inserted
        result.reason = `legacy_wedding_id=${signal.legacy_wedding_id}`
        if (r.inserted) {
          await recordProgressionIfEligible({
            supabase,
            coupleId,
            signal,
            touchpointId: r.touchpoint_id,
          })
        }
        await emitLinkEvent(supabase, venueId, runId, result, signal)
        return result
      }
    }

    // 2. Score against existing couples.
    const couples = await getCouplesCached(supabase, venueId, args.bypassCache ?? false)
    if (couples.length === 0) {
      // Cold-start: no couples yet. Route below-threshold — an identity-
      // sufficient signal mints the venue's first channel-scoped couple
      // (this is how a cold-start venue bootstraps from a live inbound);
      // an identity-poor one stays a fragment for a future re-run. The
      // action is still reported as 'cold_start' for telemetry.
      const routed = await applyTierRouting({
        supabase,
        venueId,
        signal,
        best: null,
        finalTier: 'below_threshold',
      })
      result.action = routed.action === 'duplicate' ? 'duplicate' : 'cold_start'
      result.duplicate = routed.action === 'duplicate'
      result.reason = 'no couples in venue yet'
      await emitLinkEvent(supabase, venueId, runId, result, signal)
      return result
    }

    const sigRecord = signalToMatchableRecord(signal)
    let best: { coupleId: string; verdict: MatcherVerdict } | null = null
    for (const c of couples) {
      const v = scoreCandidate(sigRecord, coupleToMatchableRecord(c))
      if (!best || v.score > best.verdict.score) {
        best = { coupleId: c.id, verdict: v }
      }
    }

    let finalTier: MatchTier = best?.verdict.tier ?? 'below_threshold'
    let reasonExtra = ''
    if (best) {
      result.matcher_score = best.verdict.score
      result.tier = best.verdict.tier
      result.reason = best.verdict.reason
    }

    if (best?.verdict.needs_judge) {
      result.judge_invoked = true
      const judgeRes = await judgeCandidate({
        supabase,
        venueId,
        primary: sigRecord,
        secondary: coupleToMatchableRecord(
          couples.find((c) => c.id === best!.coupleId)!,
        ),
        matcher: best.verdict,
        context: await buildJudgeContext(supabase, venueId, signal, best.coupleId),
        budget: judgeBudget,
        perDayBudget: 50,
        runId,
      })
      if (judgeRes.kind === 'verdict') {
        result.judge_outcome = judgeRes.verdict.outcome
        finalTier =
          judgeRes.verdict.outcome === 'reject'
            ? 'below_threshold'
            : judgeRes.verdict.outcome
        reasonExtra = ` | judge: ${judgeRes.verdict.outcome} — ${judgeRes.verdict.reasoning}`
      } else if (judgeRes.kind === 'budget_exhausted') {
        reasonExtra = ` | judge skipped (budget ${judgeRes.scope})`
      } else if (judgeRes.kind === 'error') {
        reasonExtra = ` | judge error: ${judgeRes.error}`
      }
    }

    // 2.5 Tier 1.5 safety guard (AMEND-01 / golden case GC-4). A
    // deterministic CONTRADICTION overrides an auto-attach: two distinct
    // couples that share a name but differ on a STRONG (non-relay) email or
    // a wedding date >90d apart must NOT fuse. Demote high→medium so the
    // pair routes to the candidate-review queue instead of attaching. Runs
    // AFTER the judge on purpose — a deterministic contradiction wins over
    // an LLM approval (under-merge-to-review beats a silent fuse of
    // strangers). Relay (Knot/Zola/WW) emails are medium-tier and never
    // count as a contradicting strong identifier.
    if (best && finalTier !== 'below_threshold') {
      const bestCouple = couples.find((c) => c.id === best!.coupleId)
      const contradiction = bestCouple
        ? hardContradiction(
            signal.primary_email,
            signal.wedding_date,
            [bestCouple.primary_email, bestCouple.partner_email],
            bestCouple.wedding_date,
            // Partner-corroboration veto (same as the cascade): if the
            // signal's partner names the candidate's primary/partner, the
            // differing strong emails are two partners of one couple, not
            // strangers — don't demote. Without this, linkSignal would split
            // a both-partners couple the cascade correctly keeps together.
            {
              signalPartnerName: signal.partner_name,
              candidateNames: [bestCouple.primary_name, bestCouple.partner_name],
            },
          )
        : null
      if (contradiction) {
        // A HARD contradiction means "definitively a different couple", not
        // "ambiguous" — so demote to below_threshold (→ mint a distinct
        // couple / leave-separate), NOT medium (→ review-orphan). This is
        // the doctrine default "merge only with a deterministic anchor;
        // otherwise leave separate and show both." Fires from any matched
        // tier (high attach OR medium/low review), since the contradiction
        // refutes the match regardless of the name score.
        reasonExtra += ` | tier1.5_guard:${contradiction} demoted ${finalTier}→below_threshold (keep separate)`
        finalTier = 'below_threshold'
      }
    }

    // 3. Route by final tier via the shared primitive.
    const routed = await applyTierRouting({
      supabase,
      venueId,
      signal,
      best,
      finalTier,
      reasonExtra,
    })
    result.action = routed.action
    result.matched_couple_id = routed.matched_couple_id
    result.touchpoint_id = routed.touchpoint_id
    result.candidate_match_queued = routed.candidate_match_queued
    result.duplicate = routed.action === 'duplicate'
    if (best) {
      result.reason = best.verdict.reason + reasonExtra
    } else {
      result.reason = (result.reason || 'no above-threshold match') + reasonExtra
    }

    // 3.5 Partner reconciliation (GC-5). When this signal landed on a couple
    // AND names a partner, a SEPARATE couple may already exist for that
    // partner (they booked their own tour before the contract named them).
    // Merge it in via the merge_couples primitive. Partners legitimately have
    // DIFFERENT emails, so only a far-apart wedding date blocks the merge
    // (date-only guard); requires an unambiguous single full-name match.
    if (result.matched_couple_id && signal.partner_name) {
      try {
        const normaliseFullName = (n: string | null | undefined): string | null => {
          const parts = (n ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
          return parts.length >= 2 ? parts.join(' ') : null // require first + last
        }
        const winnerId = result.matched_couple_id
        const partnerKey = normaliseFullName(signal.partner_name)
        if (partnerKey) {
          const losers = couples.filter(
            (c) => c.id !== winnerId && normaliseFullName(c.primary_name) === partnerKey,
          )
          if (losers.length === 1) {
            const loser = losers[0]
            const winner = couples.find((c) => c.id === winnerId)
            // The winner may have been minted in THIS call (not in the
            // pre-loaded `couples`), so fall back to the triggering signal's
            // wedding_date — otherwise the date guard is blind to a freshly
            // minted winner and would over-merge (GC-15).
            const winnerDate = winner?.wedding_date ?? signal.wedding_date ?? null
            const dateConflict = hardContradiction(null, loser.wedding_date, [], winnerDate)
            if (!dateConflict) {
              const { data: merged } = await supabase.rpc('merge_couples', {
                p_winner: winnerId,
                p_loser: loser.id,
                p_reason: `partner '${signal.partner_name}' matched couple primary`,
                p_rule: 'partner_reconciliation',
              })
              if (merged) {
                result.reason += ` | partner_reconciliation: merged ${loser.id.slice(0, 8)} → ${winnerId.slice(0, 8)}`
              }
            }
          }
        }
      } catch (e) {
        // Best-effort: a reconciliation failure must never throw out of the
        // pipeline (the legacy write + the attach already succeeded).
        logEvent({
          level: 'warn',
          msg: 'partner_reconciliation_failed',
          venue_id: venueId,
          error: e instanceof Error ? e.message : String(e),
        } as never)
      }
    }

    await emitLinkEvent(supabase, venueId, runId, result, signal)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logEvent({
      level: 'error',
      msg: 'forwards_linker.failed',
      venueId,
      correlationId: args.correlationId ?? runId,
      data: { external_id: signal.external_id, channel: signal.channel, error: message },
    })
    // Write a failed-status event so the dashboard surfaces breakage.
    await supabase
      .from('tracer_run_events')
      .insert({
        venue_id: venueId,
        run_id: runId,
        stage: 'forwards_link',
        status: 'failed',
        rows_seen: 1,
        rows_written: 0,
        detail: {
          kind: 'live_linker',
          error: message,
          signal: {
            channel: signal.channel,
            external_id: signal.external_id,
          },
        },
      })
      .then(() => undefined, () => undefined)
    throw err
  }
}

/**
 * Convenience wrapper: link an array of signals sequentially, sharing
 * the couples cache and judge budget across calls. Useful for batch
 * upload paths (CSV brain-dump, Calendly historical sync) where the
 * caller wants linker semantics without spinning up the full Tracer.
 */
export async function linkSignalBatch(args: {
  supabase: SupabaseClient
  venueId: string
  signals: NormalizedSignal[]
  source?: string
  bypassCache?: boolean
  judgeBudget?: number
}): Promise<{ results: LinkResult[]; summary: Record<LinkAction, number> }> {
  const budget = newJudgeBudget(args.judgeBudget ?? 25)
  const results: LinkResult[] = []
  const summary: Record<LinkAction, number> = {
    attached: 0,
    candidate_medium: 0,
    candidate_low: 0,
    minted: 0,
    fragment: 0,
    duplicate: 0,
    cold_start: 0,
  }
  for (const signal of args.signals) {
    try {
      const r = await linkSignal({
        supabase: args.supabase,
        venueId: args.venueId,
        signal,
        source: args.source,
        bypassCache: args.bypassCache,
        judgeBudget: budget,
      })
      results.push(r)
      summary[r.action] += 1
    } catch {
      // Single-signal failures don't poison the batch — already logged.
    }
  }
  return { results, summary }
}
