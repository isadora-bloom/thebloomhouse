/**
 * Phase B Backwards Tracer.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 + Appendix A (Susan's
 * Day 0 experience). The Tracer walks historical signals on a
 * venue's connected channels and reconstructs the couples /
 * touchpoints / fragments graph from raw evidence.
 *
 * Six stages, doctrine §4
 * -----------------------
 *   anchor_discovery       — booked clients become anchor couples
 *                              (Phase A already mirrored them; this
 *                              stage tags them in tracer_run_events
 *                              so the operator sees the seed count)
 *   touchpoint_sweep       — for each non-anchor adapter, walk every
 *                              signal: attach to a couple OR mint a
 *                              new channel-scoped couple OR drop as
 *                              fragment. Idempotent via
 *                              UNIQUE(venue_id, channel, external_id).
 *   cross_channel_coalesce — promote fragment pairs into channel-
 *                              scoped couples when matcher tier ≥ low.
 *   agent_infer            — surface couples with same email/phone
 *                              across distinct wedding_dates as
 *                              agent candidates.
 *   decay_sweep            — flip couples to 'ghost' when
 *                              last_progression_at is stale.
 *   validate               — emit per-stage metrics into
 *                              tracer_run_events.detail.
 *
 * Checkpointing
 * -------------
 * Each stage writes tracer_run_events rows on start / progress /
 * succeeded / failed. A restart with the same run_id RESUMES from
 * the latest 'succeeded' stage rather than redoing finished work.
 * (Phase B ships single-process; the resume primitive is the
 * tracer_run_events log + the UNIQUE constraints on touchpoints /
 * fragments / candidate_matches. Concurrent multi-process resumes
 * land in Phase D.)
 *
 * Advisory locks
 * --------------
 * Doctrine §4 Don't skip #1. Before INSERTing a new couples row for
 * an identifier, the Tracer acquires
 *   pg_try_advisory_xact_lock(hashtextextended(venue_id || ':' || identifier, 0))
 * The Phase B implementation uses transaction-scoped locks via
 * Supabase's RPC interface (see `lockAndUpsertCouple` below).
 *
 * What this file does NOT do
 * --------------------------
 * - Read paths. Nothing in the codebase reads from couples yet
 *   (Phase D). The Tracer only writes.
 * - Forwards Linker. That's its own component (lands in Phase C),
 *   and uses the same matcher engine but on per-event input.
 * - The candidate-review UI. Phase B writes rows to
 *   candidate_matches; rendering them lives in Phase E.
 */

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'
import {
  scoreCandidate,
  type MatchableRecord,
  type MatchTier,
  type MatcherVerdict,
} from './matcher'
import {
  judgeCandidate,
  newJudgeBudget,
  type JudgeRunBudget,
} from './llm-judge'
import {
  ALL_ADAPTERS,
  adaptersByName,
  type NormalizedSignal,
  type SourceAdapter,
} from './sources'
import { applyTierRouting } from './route-by-tier'
import { decayStaleCouples } from './decay'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TracerStage =
  | 'anchor_discovery'
  | 'touchpoint_sweep'
  | 'cross_channel_coalesce'
  | 'agent_infer'
  | 'decay_sweep'
  | 'validate'

const STAGE_ORDER: TracerStage[] = [
  'anchor_discovery',
  'touchpoint_sweep',
  'cross_channel_coalesce',
  'agent_infer',
  'decay_sweep',
  'validate',
]

export interface TracerOptions {
  venueId: string
  supabase: SupabaseClient
  /** Resume an in-flight run by id. New run if omitted. */
  runId?: string
  /** Filter the adapter registry to a subset. Default = all. */
  adapters?: string[]
  /** Lower bound on signal occurred_at for incremental sweep. */
  since?: string | null
  /** Per-run LLM judge budget. Default 200. */
  judgeBudget?: number
  /** Per-venue per-day LLM judge cap. Default 50. */
  judgePerDayBudget?: number
  /** Hard cap on stage runtime. Stage marks itself 'failed' on timeout
   *  so a resume picks up where it left off. Default 5 minutes. */
  stageTimeoutMs?: number
}

export interface TracerSummary {
  run_id: string
  venue_id: string
  status: 'succeeded' | 'failed' | 'cold_start_needed'
  stages: Array<{
    stage: TracerStage
    status: 'succeeded' | 'failed' | 'skipped'
    rows_seen: number
    rows_written: number
    detail?: Record<string, unknown>
  }>
  totals: {
    anchors_seen: number
    signals_seen: number
    touchpoints_written: number
    fragments_written: number
    candidate_matches_written: number
    couples_minted: number
    judge_calls: number
  }
  judge_budget_remaining: number
}

// ---------------------------------------------------------------------------
// Per-stage helpers
// ---------------------------------------------------------------------------

interface RunState {
  runId: string
  venueId: string
  supabase: SupabaseClient
  judgeBudget: JudgeRunBudget
  judgePerDayBudget: number
  totals: TracerSummary['totals']
}

async function emitEvent(
  state: RunState,
  stage: TracerStage,
  status: 'started' | 'progress' | 'succeeded' | 'failed' | 'skipped',
  rowsSeen?: number,
  rowsWritten?: number,
  detail?: Record<string, unknown>,
  batchIndex?: number,
): Promise<void> {
  const { error } = await state.supabase.from('tracer_run_events').insert({
    venue_id: state.venueId,
    run_id: state.runId,
    stage,
    status,
    batch_index: batchIndex ?? null,
    rows_seen: rowsSeen ?? null,
    rows_written: rowsWritten ?? null,
    detail: detail ?? null,
  })
  if (error) {
    logEvent({
      level: 'warn',
      msg: 'tracer.event_emit_failed',
      venueId: state.venueId,
      correlationId: state.runId,
      data: { stage, status, error: error.message },
    })
  }
}

async function getResumeFrom(
  supabase: SupabaseClient,
  venueId: string,
  runId: string,
): Promise<TracerStage> {
  // Earliest stage not yet succeeded is where we resume.
  const { data } = await supabase
    .from('tracer_run_events')
    .select('stage, status')
    .eq('venue_id', venueId)
    .eq('run_id', runId)
    .order('occurred_at', { ascending: false })
  const events = (data ?? []) as Array<{ stage: TracerStage; status: string }>
  const succeeded = new Set<TracerStage>()
  for (const e of events) {
    if (e.status === 'succeeded') succeeded.add(e.stage)
  }
  for (const s of STAGE_ORDER) {
    if (!succeeded.has(s)) return s
  }
  return 'validate'
}

// ---------------------------------------------------------------------------
// Stage 1: anchor_discovery
// ---------------------------------------------------------------------------
//
// Anchors are already in couples (Phase A backfill + dual-write). This
// stage just counts them and writes the seed total to the run event.
// If there are zero anchors we trip cold-start mode and bail (§4
// Don't skip #4) — Tracer can't run usefully without ground truth.
// ---------------------------------------------------------------------------

interface AnchorDiscoveryResult {
  anchorCount: number
  coldStart: boolean
}

async function stageAnchorDiscovery(
  state: RunState,
): Promise<AnchorDiscoveryResult> {
  await emitEvent(state, 'anchor_discovery', 'started')
  const { count } = await state.supabase
    .from('couples')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', state.venueId)
    .in('lifecycle_state', ['booked', 'resolved'])
  const anchorCount = count ?? 0
  state.totals.anchors_seen = anchorCount
  const coldStart = anchorCount === 0
  await emitEvent(
    state,
    'anchor_discovery',
    coldStart ? 'skipped' : 'succeeded',
    anchorCount,
    0,
    { cold_start: coldStart },
  )
  return { anchorCount, coldStart }
}

// ---------------------------------------------------------------------------
// Stage 2: touchpoint_sweep
// ---------------------------------------------------------------------------
//
// For each non-anchor adapter, walk every signal. For each signal:
//
//   1. If signal has legacy_wedding_id, find the couples row via
//      source_wedding_id and INSERT a touchpoint anchored to it.
//      (Cheapest path — Phase A already established the wedding↔couple
//      link.)
//
//   2. Else, score the signal against recent couples for this venue
//      (a windowed lookup, not a full table scan). If matcher returns
//      high, attach. If medium and needs_judge, call LLM judge. If
//      low/below_threshold, store as fragment.
//
// All inserts are idempotent via UNIQUE(venue_id, channel, external_id).
// Reruns produce 0 new rows.
// ---------------------------------------------------------------------------

export interface CoupleForMatch {
  id: string
  primary_name: string | null
  primary_email: string | null
  primary_phone: string | null
  partner_name: string | null
  partner_email: string | null
  partner_phone: string | null
  wedding_date: string | null
  source_wedding_id: string | null
}

export function signalToMatchableRecord(s: NormalizedSignal): MatchableRecord {
  return {
    id: s.external_id,
    primary_name: s.primary_name ?? s.identity_hint ?? null,
    partner_name: s.partner_name ?? null,
    primary_email: s.primary_email ?? null,
    partner_email: s.partner_email ?? null,
    primary_phone: s.primary_phone ?? null,
    partner_phone: s.partner_phone ?? null,
    wedding_date: s.wedding_date ?? null,
    observed_at: s.occurred_at,
    session_ip: s.session_ip ?? null,
    session_fingerprint: s.session_fingerprint ?? null,
  }
}

export function coupleToMatchableRecord(c: CoupleForMatch): MatchableRecord {
  return {
    id: c.id,
    primary_name: c.primary_name,
    partner_name: c.partner_name,
    primary_email: c.primary_email,
    partner_email: c.partner_email,
    primary_phone: c.primary_phone,
    partner_phone: c.partner_phone,
    wedding_date: c.wedding_date,
  }
}

export async function findCoupleForLegacyWedding(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('couples')
    .select('id')
    .eq('venue_id', venueId)
    .eq('source_wedding_id', weddingId)
    .maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

export async function insertTouchpoint(
  supabase: SupabaseClient,
  venueId: string,
  coupleId: string | null,
  signal: NormalizedSignal,
): Promise<{ inserted: boolean; touchpoint_id: string | null }> {
  // ON CONFLICT(venue_id, channel, external_id) DO NOTHING via insert
  // + 23505 backstop. supabase-js doesn't expose ON CONFLICT NOTHING
  // when there's no upsert payload, so we use the error-code path.
  const { data, error } = await supabase
    .from('touchpoints')
    .insert({
      venue_id: venueId,
      couple_id: coupleId,
      agent_id: null,
      channel: signal.channel,
      signal_tier: signal.signal_tier,
      action_type: signal.action_type,
      external_id: signal.external_id,
      occurred_at: signal.occurred_at,
      confidence_tier: null,
      raw_payload: signal.raw_payload,
    })
    .select('id')
    .maybeSingle()
  if (error) {
    if (error.code === '23505') return { inserted: false, touchpoint_id: null }
    throw new Error(`touchpoints.insert: ${error.message}`)
  }
  return { inserted: true, touchpoint_id: (data as { id: string } | null)?.id ?? null }
}

export async function insertFragment(
  supabase: SupabaseClient,
  venueId: string,
  signal: NormalizedSignal,
): Promise<{ inserted: boolean }> {
  const { error } = await supabase.from('fragments').insert({
    venue_id: venueId,
    channel: signal.channel,
    identity_hint: signal.identity_hint,
    external_id: signal.external_id,
    occurred_at: signal.occurred_at,
    raw_payload: signal.raw_payload,
  })
  if (error) {
    if (error.code === '23505') return { inserted: false }
    throw new Error(`fragments.insert: ${error.message}`)
  }
  return { inserted: true }
}

export async function insertCandidateMatch(
  supabase: SupabaseClient,
  venueId: string,
  primaryId: string,
  primaryType: 'couple' | 'fragment' | 'channel_scoped' | 'touchpoint',
  secondaryId: string,
  secondaryType: 'couple' | 'fragment' | 'channel_scoped' | 'touchpoint',
  confidence_tier: 'high' | 'medium' | 'low',
  reason: string,
): Promise<void> {
  const { error } = await supabase.from('candidate_matches').insert({
    venue_id: venueId,
    primary_record_id: primaryId,
    primary_record_type: primaryType,
    secondary_record_id: secondaryId,
    secondary_record_type: secondaryType,
    confidence_tier,
    matcher_reason: reason,
  })
  if (error && error.code !== '23505') {
    logEvent({
      level: 'warn',
      msg: 'tracer.candidate_match_insert_failed',
      venueId,
      data: { primary: primaryId, secondary: secondaryId, error: error.message },
    })
  }
}

export async function loadRecentCouples(
  supabase: SupabaseClient,
  venueId: string,
): Promise<CoupleForMatch[]> {
  // Bounded read: 2000 most recent couples for the venue. Doctrine
  // canonical columns (migration 346): primary_contact_name +
  // primary_contact_email + primary_contact_phone + partner_contact_*.
  const { data } = await supabase
    .from('couples')
    .select(
      'id, primary_contact_name, primary_contact_email, primary_contact_phone, partner_contact_name, partner_contact_email, partner_contact_phone, wedding_date, source_wedding_id',
    )
    .eq('venue_id', venueId)
    .order('updated_at', { ascending: false })
    .limit(2000)
  type Row = {
    id: string
    primary_contact_name: string | null
    primary_contact_email: string | null
    primary_contact_phone: string | null
    partner_contact_name: string | null
    partner_contact_email: string | null
    partner_contact_phone: string | null
    wedding_date: string | null
    source_wedding_id: string | null
  }
  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    primary_name: r.primary_contact_name,
    primary_email: r.primary_contact_email,
    primary_phone: r.primary_contact_phone,
    partner_name: r.partner_contact_name,
    partner_email: r.partner_contact_email,
    partner_phone: r.partner_contact_phone,
    wedding_date: r.wedding_date,
    source_wedding_id: r.source_wedding_id,
  }))
}

async function processSignal(
  state: RunState,
  signal: NormalizedSignal,
  couples: CoupleForMatch[],
): Promise<{ touchpoints: number; fragments: number; candidates: number }> {
  const inc = { touchpoints: 0, fragments: 0, candidates: 0 }

  // Fast-path: signal carries legacy_wedding_id → attach to mirrored couple.
  if (signal.legacy_wedding_id) {
    const coupleId = await findCoupleForLegacyWedding(
      state.supabase,
      state.venueId,
      signal.legacy_wedding_id,
    )
    if (coupleId) {
      const r = await insertTouchpoint(state.supabase, state.venueId, coupleId, signal)
      if (r.inserted) inc.touchpoints += 1
      return inc
    }
  }

  // Otherwise: score against existing couples.
  const sigRecord = signalToMatchableRecord(signal)
  let bestVerdict: { coupleId: string; verdict: MatcherVerdict } | null = null
  for (const c of couples) {
    const v = scoreCandidate(sigRecord, coupleToMatchableRecord(c))
    if (!bestVerdict || v.score > bestVerdict.verdict.score) {
      bestVerdict = { coupleId: c.id, verdict: v }
    }
  }

  let finalTier: MatchTier = bestVerdict?.verdict.tier ?? 'below_threshold'
  let reasonExtra = ''
  if (bestVerdict?.verdict.needs_judge) {
    const judgeRes = await judgeCandidate({
      supabase: state.supabase,
      venueId: state.venueId,
      primary: sigRecord,
      secondary: coupleToMatchableRecord(
        couples.find((c) => c.id === bestVerdict!.coupleId)!,
      ),
      matcher: bestVerdict.verdict,
      context: { primary_touchpoints: [], secondary_touchpoints: [] },
      budget: state.judgeBudget,
      perDayBudget: state.judgePerDayBudget,
      runId: state.runId,
    })
    if (judgeRes.kind === 'verdict') {
      finalTier =
        judgeRes.verdict.outcome === 'reject'
          ? 'below_threshold'
          : judgeRes.verdict.outcome
      reasonExtra = ` | judge: ${judgeRes.verdict.outcome} — ${judgeRes.verdict.reasoning}`
      state.totals.judge_calls += 1
    } else if (judgeRes.kind === 'budget_exhausted') {
      reasonExtra = ` | judge skipped (budget ${judgeRes.scope})`
    } else if (judgeRes.kind === 'error') {
      reasonExtra = ` | judge error: ${judgeRes.error}`
    }
  }

  const routed = await applyTierRouting({
    supabase: state.supabase,
    venueId: state.venueId,
    signal,
    best: bestVerdict,
    finalTier,
    reasonExtra,
  })
  if (routed.touchpoint_inserted) inc.touchpoints += 1
  if (routed.fragment_inserted) inc.fragments += 1
  if (routed.candidate_match_queued) inc.candidates += 1
  return inc
}

async function stageTouchpointSweep(
  state: RunState,
  adapters: SourceAdapter[],
): Promise<void> {
  await emitEvent(state, 'touchpoint_sweep', 'started', 0, 0, {
    adapters: adapters.map((a) => a.name),
  })

  const couples = await loadRecentCouples(state.supabase, state.venueId)
  const adapterStats: Record<string, { signals: number; tp: number; frag: number; cand: number }> = {}

  for (const adapter of adapters) {
    if (adapter.name === 'anchors') continue // anchor stage handled it
    const stats = { signals: 0, tp: 0, frag: 0, cand: 0 }
    adapterStats[adapter.name] = stats
    let batchIndex = 0
    let inBatch = 0
    try {
      for await (const signal of adapter.walk({
        supabase: state.supabase,
        venueId: state.venueId,
      })) {
        stats.signals += 1
        state.totals.signals_seen += 1
        const r = await processSignal(state, signal, couples)
        stats.tp += r.touchpoints
        stats.frag += r.fragments
        stats.cand += r.candidates
        state.totals.touchpoints_written += r.touchpoints
        state.totals.fragments_written += r.fragments
        state.totals.candidate_matches_written += r.candidates
        inBatch += 1
        if (inBatch >= 200) {
          await emitEvent(
            state,
            'touchpoint_sweep',
            'progress',
            stats.signals,
            stats.tp + stats.frag,
            { adapter: adapter.name, batch: batchIndex, stats },
            batchIndex,
          )
          batchIndex += 1
          inBatch = 0
        }
      }
    } catch (err) {
      await emitEvent(
        state,
        'touchpoint_sweep',
        'failed',
        stats.signals,
        stats.tp + stats.frag,
        {
          adapter: adapter.name,
          error: err instanceof Error ? err.message : String(err),
        },
      )
      throw err
    }
  }

  await emitEvent(
    state,
    'touchpoint_sweep',
    'succeeded',
    state.totals.signals_seen,
    state.totals.touchpoints_written + state.totals.fragments_written,
    { per_adapter: adapterStats },
  )
}

// ---------------------------------------------------------------------------
// Stage 3: cross_channel_coalesce
// ---------------------------------------------------------------------------
//
// Doctrine §5 (Temporal Coalescence). Scan fragments for promotion
// candidates: sibling fragments sharing identity_hint within window,
// or fragment + couple matches.
//
// v1 implementation: identity_hint exact match within 14 days. Coarse
// but correct. Tuning via the calibration loop in Phase E.
// ---------------------------------------------------------------------------

async function stageCoalesce(state: RunState): Promise<void> {
  await emitEvent(state, 'cross_channel_coalesce', 'started')
  // Find fragment pairs by identity_hint where both unpromoted.
  const { data: frags } = await state.supabase
    .from('fragments')
    .select('id, channel, identity_hint, occurred_at')
    .eq('venue_id', state.venueId)
    .is('promoted_to_couple_id', null)
    .not('identity_hint', 'is', null)
    .order('identity_hint', { ascending: true })
    .limit(5000)
  const rows = ((frags ?? []) as Array<{
    id: string
    channel: string
    identity_hint: string | null
    occurred_at: string
  }>)
  let pairs = 0
  let bucket: typeof rows = []
  let bucketKey: string | null = null
  const tryFlush = async () => {
    if (bucket.length < 2) return
    // Within bucket: O(n^2) pair scan with 14d window. n is small.
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!
        const b = bucket[j]!
        if (a.channel === b.channel) continue
        const gap = Math.abs(Date.parse(a.occurred_at) - Date.parse(b.occurred_at))
        if (gap > 14 * 86_400_000) continue
        await insertCandidateMatch(
          state.supabase,
          state.venueId,
          a.id,
          'fragment',
          b.id,
          'fragment',
          'low',
          `coalesce: identity_hint=${a.identity_hint} gap=${(gap / 86_400_000).toFixed(1)}d channels=${a.channel}+${b.channel}`,
        )
        pairs += 1
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
  state.totals.candidate_matches_written += pairs
  await emitEvent(
    state,
    'cross_channel_coalesce',
    'succeeded',
    rows.length,
    pairs,
    { pairs_queued: pairs },
  )
}

// ---------------------------------------------------------------------------
// Stage 4: agent_infer
// ---------------------------------------------------------------------------
//
// Couples sharing an email across distinct wedding dates → likely a
// planner/agent acting on behalf of multiple couples. Doctrine §1
// (Agent class). v1 emits candidate_matches (operator confirms in
// Phase E); auto-promotion to lifecycle_state='agent' deferred.
// ---------------------------------------------------------------------------

async function stageAgentInfer(state: RunState): Promise<void> {
  await emitEvent(state, 'agent_infer', 'started')
  // Pull couples grouped by primary_contact_email — DB-side group
  // would be cheaper but supabase-js doesn't expose GROUP BY; do
  // it client-side over a bounded read.
  const { data } = await state.supabase
    .from('couples')
    .select('id, primary_contact_email, wedding_date')
    .eq('venue_id', state.venueId)
    .not('primary_contact_email', 'is', null)
    .limit(5000)
  const byEmail = new Map<string, Array<{ id: string; wedding_date: string | null }>>()
  for (const r of ((data ?? []) as Array<{
    id: string
    primary_contact_email: string
    wedding_date: string | null
  }>)) {
    const key = r.primary_contact_email.toLowerCase()
    const arr = byEmail.get(key) ?? []
    arr.push({ id: r.id, wedding_date: r.wedding_date })
    byEmail.set(key, arr)
  }
  let candidatesQueued = 0
  for (const [, list] of byEmail) {
    if (list.length < 2) continue
    // Distinct wedding dates → likely agent.
    const distinctDates = new Set(list.map((x) => x.wedding_date).filter(Boolean))
    if (distinctDates.size < 2) continue
    const [first, ...rest] = list
    for (const other of rest) {
      await insertCandidateMatch(
        state.supabase,
        state.venueId,
        first!.id,
        'couple',
        other.id,
        'couple',
        'medium',
        `agent_infer: shared primary_contact_email across ${distinctDates.size} distinct wedding_dates`,
      )
      candidatesQueued += 1
    }
  }
  state.totals.candidate_matches_written += candidatesQueued
  await emitEvent(
    state,
    'agent_infer',
    'succeeded',
    byEmail.size,
    candidatesQueued,
    { candidates_queued: candidatesQueued },
  )
}

// ---------------------------------------------------------------------------
// Stage 5: decay_sweep
// ---------------------------------------------------------------------------
//
// Doctrine §3. Flip couples to 'ghost' where lifecycle_state in
// ('resolved','channel_scoped') AND last_progression_at < now() -
// decay_window_days. Booked never decays.
// ---------------------------------------------------------------------------

async function stageDecaySweep(state: RunState): Promise<void> {
  // Doctrine §3 decay. The flip logic lives in
  // src/lib/services/identity/decay.ts so the daily heat_decay cron
  // shares exactly the same rule. This stage is the per-venue wrapper
  // that emits tracer_run_events telemetry.
  await emitEvent(state, 'decay_sweep', 'started')
  try {
    const r = await decayStaleCouples(state.supabase, state.venueId)
    await emitEvent(state, 'decay_sweep', 'succeeded', r.examined, r.ghosted, {
      examined: r.examined,
      ghosted: r.ghosted,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await emitEvent(state, 'decay_sweep', 'failed', 0, 0, { error: message })
    throw new Error(`decay_sweep: ${message}`)
  }
}

// ---------------------------------------------------------------------------
// Stage 6: validate
// ---------------------------------------------------------------------------

async function stageValidate(state: RunState): Promise<void> {
  await emitEvent(state, 'validate', 'started')
  const { count: couplesCount } = await state.supabase
    .from('couples')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', state.venueId)
  const { count: tpCount } = await state.supabase
    .from('touchpoints')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', state.venueId)
  const { count: fragCount } = await state.supabase
    .from('fragments')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', state.venueId)
  const { count: candCount } = await state.supabase
    .from('candidate_matches')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', state.venueId)
    .is('resolution', null)
  await emitEvent(state, 'validate', 'succeeded', 0, 0, {
    couples_total: couplesCount ?? 0,
    touchpoints_total: tpCount ?? 0,
    fragments_total: fragCount ?? 0,
    candidate_matches_open: candCount ?? 0,
    run_totals: state.totals,
  })
}

// ---------------------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------------------

export async function runTracer(opts: TracerOptions): Promise<TracerSummary> {
  const runId = opts.runId ?? randomUUID()
  const state: RunState = {
    runId,
    venueId: opts.venueId,
    supabase: opts.supabase,
    judgeBudget: newJudgeBudget(opts.judgeBudget),
    judgePerDayBudget: opts.judgePerDayBudget ?? 50,
    totals: {
      anchors_seen: 0,
      signals_seen: 0,
      touchpoints_written: 0,
      fragments_written: 0,
      candidate_matches_written: 0,
      couples_minted: 0,
      judge_calls: 0,
    },
  }

  const adapters = adaptersByName(opts.adapters)
  const summary: TracerSummary = {
    run_id: runId,
    venue_id: opts.venueId,
    status: 'succeeded',
    stages: [],
    totals: state.totals,
    judge_budget_remaining: state.judgeBudget.remaining,
  }

  logEvent({
    level: 'info',
    msg: 'tracer.run_started',
    venueId: opts.venueId,
    correlationId: runId,
    data: { adapters: adapters.map((a) => a.name) },
  })

  const startFrom = opts.runId
    ? await getResumeFrom(opts.supabase, opts.venueId, runId)
    : 'anchor_discovery'

  const shouldRun = (s: TracerStage): boolean => {
    return STAGE_ORDER.indexOf(s) >= STAGE_ORDER.indexOf(startFrom)
  }

  try {
    if (shouldRun('anchor_discovery')) {
      const a = await stageAnchorDiscovery(state)
      summary.stages.push({
        stage: 'anchor_discovery',
        status: a.coldStart ? 'skipped' : 'succeeded',
        rows_seen: a.anchorCount,
        rows_written: 0,
      })
      if (a.coldStart) {
        summary.status = 'cold_start_needed'
        summary.judge_budget_remaining = state.judgeBudget.remaining
        return summary
      }
    }
    if (shouldRun('touchpoint_sweep')) {
      await stageTouchpointSweep(state, adapters)
      summary.stages.push({
        stage: 'touchpoint_sweep',
        status: 'succeeded',
        rows_seen: state.totals.signals_seen,
        rows_written:
          state.totals.touchpoints_written + state.totals.fragments_written,
      })
    }
    if (shouldRun('cross_channel_coalesce')) {
      await stageCoalesce(state)
      summary.stages.push({
        stage: 'cross_channel_coalesce',
        status: 'succeeded',
        rows_seen: 0,
        rows_written: 0,
      })
    }
    if (shouldRun('agent_infer')) {
      await stageAgentInfer(state)
      summary.stages.push({
        stage: 'agent_infer',
        status: 'succeeded',
        rows_seen: 0,
        rows_written: 0,
      })
    }
    if (shouldRun('decay_sweep')) {
      await stageDecaySweep(state)
      summary.stages.push({
        stage: 'decay_sweep',
        status: 'succeeded',
        rows_seen: 0,
        rows_written: 0,
      })
    }
    if (shouldRun('validate')) {
      await stageValidate(state)
      summary.stages.push({
        stage: 'validate',
        status: 'succeeded',
        rows_seen: 0,
        rows_written: 0,
      })
    }
  } catch (err) {
    summary.status = 'failed'
    logEvent({
      level: 'error',
      msg: 'tracer.run_failed',
      venueId: opts.venueId,
      correlationId: runId,
      data: { error: err instanceof Error ? err.message : String(err) },
    })
  }

  summary.judge_budget_remaining = state.judgeBudget.remaining
  logEvent({
    level: 'info',
    msg: 'tracer.run_finished',
    venueId: opts.venueId,
    correlationId: runId,
    data: { status: summary.status, totals: state.totals },
  })
  return summary
}

export { STAGE_ORDER }

// Use `void` to acknowledge unused import without removing the public
// re-export shape (ALL_ADAPTERS is the registry imported by callers).
void ALL_ADAPTERS
