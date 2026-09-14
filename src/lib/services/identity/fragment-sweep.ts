/**
 * Nightly fragment sweep.
 *
 * Anchor: HANDLE-IDENTITY-SPEC.md §5 ("the fragment coalesce in
 * tracer.ts moves to a named fragment-sweep.ts under the linker and
 * tracer.ts goes") and NOVEMBER-PLAN.md Wave 3 W26.
 *
 * Two independent promotion passes run per venue, in order:
 *
 *   1. sweepHandlePromotionForVenue — W22's handle-based promotion
 *      (`sweepFragmentsForCouple`, per HANDLE-IDENTITY-SPEC.md §2:
 *      "every unpromoted fragment in the venue with the same
 *      (platform, handle) is promoted onto that couple"). Runs once
 *      per couple that carries a handle.
 *
 *   2. sweepIdentityHintCoalesce — the identity-hint cross-channel
 *      coalesce this file inherits VERBATIM from the retired
 *      `tracer.ts` (`stageCoalesce` / `promoteFragmentInto`). Same
 *      bucket-by-hint pre-filter, same 14-day pair window, same
 *      structured-matcher scoring, same score > 90 auto-promote
 *      threshold, same `couple_merge_events` 'fragment_promoted'
 *      audit row, same candidate_matches queueing for the 30-90 band.
 *
 * Both passes are deterministic (no LLM judge) and idempotent —
 * `fragments.promoted_to_couple_id IS NULL` is the only fragment a
 * pass will touch, and the `is('promoted_to_couple_id', null)` guard
 * on the UPDATE makes a re-run of either pass a no-op on fragments
 * the other pass, or an earlier run, already claimed.
 *
 * The couple mint itself routes through `lockAndMintCouple` (the
 * advisory-locked chokepoint in mint-couple.ts) exactly as it did
 * inside tracer.ts — this file is a new CHOKEPOINT_FILES entry in
 * check-cascade-only-writer.mjs for the `couple_merge_events` audit
 * insert the coalesce pass makes on a fresh mint.
 *
 * Telemetry: one `tracer_run_events` row per venue per sweep
 * (stage='fragment_sweep'), reusing the same table the Backwards
 * Tracer and the live Forwards Linker both already write to — no new
 * table, no orphaned UI. See `/api/admin/tracer/status` (unchanged)
 * and `src/app/api/admin/identity-telemetry/route.ts`.
 */

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sweepFragmentsByHandle } from './fragment-sweep-handles'
export {
  promoteFragmentsByHandle,
  sweepFragmentsByHandle,
  sweepFragmentsForCouple,
  type FragmentPromotion,
} from './fragment-sweep-handles'
import { logEvent } from '@/lib/observability/logger'
import { writeOrLog } from '@/lib/db/write-or-log'
import { scoreCandidate, type MatchableRecord } from './matcher'
import { lockAndMintCouple } from './mint-couple'
import { insertCandidateMatch } from './spine-writers'
import type { NormalizedSignal } from './sources'

// ---------------------------------------------------------------------------
// Pass 2: identity-hint cross-channel coalesce (moved verbatim from
// tracer.ts's stageCoalesce / promoteFragmentInto — see file header).
// ---------------------------------------------------------------------------

// > matcher JUDGE_BAND_HIGH (90). Promotion fires only above the band
// where doctrine §2 says a human/LLM judge is required.
export const FRAGMENT_PROMOTE_MIN_SCORE = 91

interface CoalesceFragment {
  id: string
  channel: string
  identity_hint: string | null
  occurred_at: string
}

function fragmentToMatchable(f: CoalesceFragment): MatchableRecord {
  return {
    id: f.id,
    primary_name: f.identity_hint,
    observed_at: f.occurred_at,
  }
}

export interface FragmentSweepState {
  venueId: string
  supabase: SupabaseClient
  runId: string
  /** couples minted by this sweep run (across both passes). */
  couplesMinted: number
}

/**
 * Promote one fragment into a couple. Mints a channel-scoped couple
 * when `existingCoupleId` is null (the first fragment of a pair), else
 * links into the couple an earlier pair already minted. Returns the
 * couple id, or null on a mint failure.
 *
 * The mint goes through the `lockAndMintCouple` chokepoint rather than
 * a direct `INSERT INTO couples`. The `couple_merge_events`
 * 'fragment_promoted' audit row this function has always written
 * STAYS — it is the coalesce-specific audit. The chokepoint
 * additionally writes its own 'couple_minted' row, so a coalesce-
 * minted couple carries both: a generic mint-trail row and the
 * fragment-promotion row. That is intentional double coverage, not a
 * bug (unchanged behaviour from tracer.ts).
 *
 * Fragment → NormalizedSignal note: a CoalesceFragment carries only
 * id / channel / identity_hint / occurred_at — no email or phone. The
 * synthesised signal therefore has no contact identifiers, so
 * `computeLockKey` falls through to a `handle:<channel>:<hint>` key
 * (or `signal:<channel>:<id>` if the hint is empty — though the
 * caller filters out null hints before bucketing). The RPC's
 * email/phone re-check is a no-op for such a signal, so it always
 * mints rather than attaching. The RPC also inserts a `touchpoints`
 * row keyed on (venue_id, channel, external_id) = (venue,
 * fragment.channel, fragment.id) — a synthetic touchpoint
 * representing the fragment promotion.
 */
async function promoteFragmentInto(
  state: FragmentSweepState,
  fragment: CoalesceFragment,
  existingCoupleId: string | null,
  reason: string,
): Promise<string | null> {
  let coupleId = existingCoupleId

  if (!coupleId) {
    const fragmentSignal: NormalizedSignal = {
      external_id: fragment.id,
      channel: fragment.channel,
      action_type: 'fragment_promoted',
      occurred_at: fragment.occurred_at,
      signal_tier: 'medium',
      identity_hint: fragment.identity_hint,
      primary_name: fragment.identity_hint,
      raw_payload: {
        source: 'fragment-sweep.identity_hint_coalesce',
        fragment_id: fragment.id,
        reason,
      },
    }

    let mintResult
    try {
      mintResult = await lockAndMintCouple(
        state.supabase,
        state.venueId,
        fragmentSignal,
      )
    } catch (err) {
      logEvent({
        level: 'warn',
        msg: 'fragment_sweep.coalesce.mint_failed',
        venueId: state.venueId,
        correlationId: state.runId,
        data: {
          fragment: fragment.id,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return null
    }

    if (!mintResult.coupleId) {
      logEvent({
        level: 'warn',
        msg: 'fragment_sweep.coalesce.mint_failed',
        venueId: state.venueId,
        correlationId: state.runId,
        data: { fragment: fragment.id, error: 'rpc returned null couple_id' },
      })
      return null
    }

    coupleId = mintResult.coupleId
    if (mintResult.minted) state.couplesMinted += 1
    await writeOrLog(
      state.supabase.from('couple_merge_events').insert({
        venue_id: state.venueId,
        event_type: 'fragment_promoted',
        primary_couple_id: coupleId,
        rule_triggered: 'cross_channel_coalesce',
        confidence_tier: 'high',
        reason,
      }),
      { op: 'couple_merge_events.insert', venueId: state.venueId },
    )
  }

  // Link the fragment one-way (fragments do not resurrect). The
  // `is null` guard keeps a re-run idempotent.
  const { error: upErr } = await state.supabase
    .from('fragments')
    .update({
      promoted_to_couple_id: coupleId,
      promoted_at: new Date().toISOString(),
    })
    .eq('id', fragment.id)
    .is('promoted_to_couple_id', null)
  if (upErr) {
    logEvent({
      level: 'warn',
      msg: 'fragment_sweep.coalesce.fragment_link_failed',
      venueId: state.venueId,
      correlationId: state.runId,
      data: { fragment: fragment.id, couple: coupleId, error: upErr.message },
    })
  }
  return coupleId
}

export interface CoalesceResult {
  fragmentsScanned: number
  promoted: number
  candidatesQueued: number
}

/**
 * Identity-hint cross-channel coalesce. Doctrine (Temporal
 * Coalescence): two fragments on different channels that the
 * structured matcher scores as the same couple are promoted into one
 * channel-scoped couple — this is how anonymous cross-surface
 * activity ("Sarah Ross saved you on Knot AND messaged on Instagram")
 * becomes a single queryable entity instead of two dangling
 * fragments.
 *
 *   1. Bucket unpromoted fragments by lowercased identity_hint (a
 *      cheap pre-filter — only same-hint fragments are worth a
 *      pair-scan).
 *   2. Score every cross-channel pair within a 14-day window with the
 *      real structured matcher.
 *   3. score > 90  → auto-promote into a channel-scoped couple.
 *   4. 30-90       → queue a candidate_match at the matcher's tier for
 *      operator review.
 *   5. < 30        → nothing.
 *
 * Transitive promotion: a per-run map fragment_id → couple_id lets a
 * third fragment join a couple an earlier pair already minted instead
 * of minting a duplicate.
 */
export async function sweepIdentityHintCoalesce(
  state: FragmentSweepState,
): Promise<CoalesceResult> {
  const { data: frags } = await state.supabase
    .from('fragments')
    .select('id, channel, identity_hint, occurred_at')
    .eq('venue_id', state.venueId)
    .is('promoted_to_couple_id', null)
    .not('identity_hint', 'is', null)
    .order('identity_hint', { ascending: true })
    .limit(5000)
  const rows = (frags ?? []) as CoalesceFragment[]

  // fragment_id → couple_id for fragments promoted earlier in THIS run.
  const promoted = new Map<string, string>()
  let promotedCount = 0
  let candidatesQueued = 0

  let bucket: CoalesceFragment[] = []
  let bucketKey: string | null = null

  const tryFlush = async () => {
    if (bucket.length < 2) return
    // Within bucket: O(n^2) pair scan with 14d window. n is small.
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!
        const b = bucket[j]!
        if (a.channel === b.channel) continue
        const gap = Math.abs(
          Date.parse(a.occurred_at) - Date.parse(b.occurred_at),
        )
        if (gap > 14 * 86_400_000) continue

        const verdict = scoreCandidate(
          fragmentToMatchable(a),
          fragmentToMatchable(b),
        )

        if (verdict.score >= FRAGMENT_PROMOTE_MIN_SCORE) {
          const ca = promoted.get(a.id)
          const cb = promoted.get(b.id)
          if (ca && cb && ca !== cb) {
            // Pair bridges two already-coalesced couples → couple-merge
            // territory. Queue for the operator; auto couple-merge is
            // out of scope here.
            await insertCandidateMatch(
              state.supabase, state.venueId,
              ca, 'couple', cb, 'couple', 'medium',
              `coalesce: pair bridges two coalesced couples — ${verdict.reason}`,
            )
            candidatesQueued += 1
            continue
          }
          const seed = ca ?? cb ?? null
          const coupleId = await promoteFragmentInto(
            state, a, seed, `coalesce: ${verdict.reason}`,
          )
          if (!coupleId) continue
          promoted.set(a.id, coupleId)
          const linked = await promoteFragmentInto(
            state, b, coupleId, `coalesce: ${verdict.reason}`,
          )
          if (linked) {
            promoted.set(b.id, linked)
            promotedCount += 1
          }
        } else if (verdict.score >= 30) {
          await insertCandidateMatch(
            state.supabase, state.venueId,
            a.id, 'fragment', b.id, 'fragment',
            verdict.tier === 'medium' ? 'medium' : 'low',
            `coalesce: ${verdict.reason} gap=${(gap / 86_400_000).toFixed(1)}d`,
          )
          candidatesQueued += 1
        }
      }
    }
  }

  for (const r of rows) {
    const k = (r.identity_hint ?? '').toLowerCase()
    if (k !== bucketKey) {
      await tryFlush()
      bucket = []
      bucketKey = k
    }
    bucket.push(r)
  }
  await tryFlush()

  return {
    fragmentsScanned: rows.length,
    promoted: promotedCount,
    candidatesQueued,
  }
}

// ---------------------------------------------------------------------------
// Pass 1: handle-based promotion (W22, identity-cascade.ts /
// fragment-sweep contract per HANDLE-IDENTITY-SPEC.md §2).
// ---------------------------------------------------------------------------

export interface HandlePromotionResult {
  couplesWithHandles: number
  fragmentsPromoted: number
  skipped: boolean
  reason?: string
}

/**
 * Run W22's handle-based fragment promotion for every couple in the
 * venue that carries a handle (`couples.handles`, migration 398):
 * every unpromoted fragment in the venue with the same
 * (platform, handle) is promoted onto that couple.
 *
 * WAVE-3 SEAM: W22 owns `sweepFragmentsForCouple` / the batch form
 * (planned home: `fragment-sweep.ts`, same file this function lives
 * in once the two workstreams merge — W22's worktree currently has no
 * exported function under that name to call, since W26 and W22 run
 * in parallel worktrees off the same `consolidation` base). This is
 * the clearly-marked seam: swap the stub below for a real
 * `import { sweepFragmentsForCouple } from './identity-cascade'` (or
 * wherever W22 lands it) the moment that export exists. Until then
 * this pass is a documented no-op so the sweep as a whole is still
 * correct (pass 2 still runs) rather than throwing.
 */
/**
 * Pass 1 calls W22's batch promotion directly. The seam that waited for
 * W22 to land is gone: the two workstreams merged on 2026-09-11 and the
 * handle promotion lives in ./fragment-sweep-handles.ts.
 */
export async function sweepHandlePromotionForVenue(
  state: FragmentSweepState,
): Promise<HandlePromotionResult> {
  try {
    const r = await sweepFragmentsByHandle({ supabase: state.supabase, venueId: state.venueId })
    return {
      couplesWithHandles: r.couplesTouched,
      fragmentsPromoted: r.promoted.length,
      skipped: false,
    }
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'fragment_sweep.handle_promotion.failed',
      venueId: state.venueId,
      correlationId: state.runId,
      data: { error: err instanceof Error ? err.message : String(err) },
    })
    return { couplesWithHandles: 0, fragmentsPromoted: 0, skipped: true, reason: 'failed' }
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface FragmentSweepSummary {
  run_id: string
  venue_id: string
  status: 'succeeded' | 'failed'
  handle_promotion: HandlePromotionResult
  identity_hint_coalesce: CoalesceResult
  couples_minted: number
  error?: string
}

async function emitSweepEvent(
  state: FragmentSweepState,
  status: 'started' | 'succeeded' | 'failed',
  detail?: Record<string, unknown>,
): Promise<void> {
  await writeOrLog(
    state.supabase.from('tracer_run_events').insert({
      venue_id: state.venueId,
      run_id: state.runId,
      stage: 'fragment_sweep',
      status,
      detail: detail ?? null,
    }),
    { op: 'tracer_run_events.insert', venueId: state.venueId },
  )
}

/**
 * Nightly fragment sweep for one venue: handle-based promotion (W22),
 * then the identity-hint cross-channel coalesce inherited from the
 * retired Backwards Tracer. Never throws — errors land in the summary
 * and the structured log, mirroring the fail-soft contract the old
 * tracer stages had.
 */
export async function sweepFragmentsForVenue(
  supabase: SupabaseClient,
  venueId: string,
): Promise<FragmentSweepSummary> {
  const runId = `fragment_sweep:${venueId}:${randomUUID()}`
  const state: FragmentSweepState = { venueId, supabase, runId, couplesMinted: 0 }

  await emitSweepEvent(state, 'started')

  try {
    const handlePromotion = await sweepHandlePromotionForVenue(state)
    const identityHintCoalesce = await sweepIdentityHintCoalesce(state)

    const summary: FragmentSweepSummary = {
      run_id: runId,
      venue_id: venueId,
      status: 'succeeded',
      handle_promotion: handlePromotion,
      identity_hint_coalesce: identityHintCoalesce,
      couples_minted: state.couplesMinted,
    }

    await emitSweepEvent(state, 'succeeded', {
      handle_promotion: handlePromotion,
      identity_hint_coalesce: identityHintCoalesce,
      couples_minted: state.couplesMinted,
    })

    logEvent({
      level: 'info',
      msg: 'fragment_sweep.run_finished',
      venueId,
      correlationId: runId,
      data: { ...summary },
    })

    return summary
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await emitSweepEvent(state, 'failed', { error: message })
    logEvent({
      level: 'error',
      msg: 'fragment_sweep.run_failed',
      venueId,
      correlationId: runId,
      data: { error: message },
    })
    return {
      run_id: runId,
      venue_id: venueId,
      status: 'failed',
      handle_promotion: { couplesWithHandles: 0, fragmentsPromoted: 0, skipped: true, reason: 'error' },
      identity_hint_coalesce: { fragmentsScanned: 0, promoted: 0, candidatesQueued: 0 },
      couples_minted: state.couplesMinted,
      error: message,
    }
  }
}

/**
 * Cron entry — every venue, one after another. Per-venue failures are
 * isolated inside `sweepFragmentsForVenue` (it never throws), so one
 * bad venue never stops the fleet.
 */
export async function sweepFragmentsAllVenues(
  supabase: SupabaseClient,
): Promise<{ venues_swept: number; per_venue: FragmentSweepSummary[] }> {
  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .order('created_at', { ascending: true })
  if (error) throw new Error(`fragment-sweep: venue lookup ${error.message}`)

  const perVenue: FragmentSweepSummary[] = []
  for (const v of (venues ?? []) as Array<{ id: string }>) {
    perVenue.push(await sweepFragmentsForVenue(supabase, v.id))
  }

  return { venues_swept: perVenue.length, per_venue: perVenue }
}
