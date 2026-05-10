/**
 * Wave 6D — A/B test scaffold service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 6D scaffolds A/B tests for competing
 *     creatives — same forensic logic as the rollups, applied to the
 *     coordinator's hypothesis tests)
 *   - bloom-wave4-5-6-master-plan.md (Wave 6D spec)
 *
 * Why scaffold-not-engine
 * -----------------------
 * Bloom's A/B is for venue marketers who don't have a stats team. The
 * scaffold:
 *   1. Tracks which attribution_events count toward each variant arm.
 *   2. Computes booking lift between arms when both have ≥ 30 events.
 *   3. Refuses to auto-conclude when either arm is too thin — even
 *      under coordinator force, "inconclusive" is the honest verdict
 *      when the data isn't there.
 *
 * No multi-arm bandits, no Bayesian priors, no continuous monitoring —
 * the operator-decision moments stay obvious + auditable.
 *
 * AUTO-FLAG NEVER AUTO-EXECUTE
 * ----------------------------
 * concludeAbTest only computes the winner; it does NOT redirect spend,
 * pause the loser, or push a recommendation. The operator reads the
 * conclusion + decides what to do next (typically by acting on a
 * Wave 6C recommendation that references the test).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { logEvent } from '@/lib/observability/logger'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateAbTestInput {
  venueId: string
  testConfig: {
    test_name: string
    hypothesis: string
    variant_a_label: string
    variant_b_label: string
    channel: string
    target_persona?: string | null
    /** When supplied, the test starts in 'running' state. */
    auto_start?: boolean
    notes?: string | null
    /**
     * Pre-populated arm assignments. If the coordinator already knows
     * which attribution events go where (e.g. by date split), they can
     * pass them on creation.
     */
    initial_variant_a_attribution_event_ids?: string[]
    initial_variant_b_attribution_event_ids?: string[]
  }
}

export interface CreateAbTestResult {
  ok: true
  testId: string
  status: string
}

export interface AssignVariantInput {
  testId: string
  attributionEventId: string
  variant: 'variant_a' | 'variant_b'
}

export interface AssignVariantResult {
  ok: true
  testId: string
  variant: 'variant_a' | 'variant_b'
  alreadyAssigned: boolean
}

export interface ConcludeAbTestInput {
  testId: string
  /** When true, conclude even with thin arms (returns 'inconclusive'). */
  force?: boolean
  decidedBy?: string | null
}

export interface ConcludeAbTestResult {
  ok: true
  testId: string
  winner: 'variant_a' | 'variant_b' | 'inconclusive' | null
  liftPct: number | null
  /** True when the test reached the cohort threshold; false when forced. */
  thresholdMet: boolean
  variantAStats: {
    eventCount: number
    bookedCount: number
    bookedRate: number
  }
  variantBStats: {
    eventCount: number
    bookedCount: number
    bookedRate: number
  }
}

export interface StoredAbTestRow {
  id: string
  venue_id: string
  test_name: string
  hypothesis: string
  variant_a_label: string
  variant_b_label: string
  channel: string
  target_persona: string | null
  started_at: string
  ended_at: string | null
  variant_a_attribution_event_ids: string[]
  variant_b_attribution_event_ids: string[]
  winner: string | null
  winner_decision_lift_pct: number | string | null
  winner_decided_at: string | null
  winner_decided_by: string | null
  status: string
  notes: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const ARM_CAP_PER_TEST = 10_000
const COHORT_THRESHOLD = 30

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createAbTest(
  input: CreateAbTestInput,
  supabase: SupabaseClient = createServiceClient(),
): Promise<CreateAbTestResult> {
  const cfg = input.testConfig

  const variantA = (cfg.initial_variant_a_attribution_event_ids ?? []).slice(
    0,
    ARM_CAP_PER_TEST,
  )
  const variantB = (cfg.initial_variant_b_attribution_event_ids ?? []).slice(
    0,
    ARM_CAP_PER_TEST,
  )

  const status = cfg.auto_start === false ? 'planning' : 'running'

  const { data, error } = await supabase
    .from('marketing_ab_tests')
    .insert({
      venue_id: input.venueId,
      test_name: cfg.test_name,
      hypothesis: cfg.hypothesis,
      variant_a_label: cfg.variant_a_label,
      variant_b_label: cfg.variant_b_label,
      channel: cfg.channel,
      target_persona: cfg.target_persona ?? null,
      variant_a_attribution_event_ids: variantA,
      variant_b_attribution_event_ids: variantB,
      status,
      notes: cfg.notes ?? null,
    })
    .select('id, status')
    .single()

  if (error || !data) {
    throw new Error(`createAbTest: ${error?.message ?? 'insert returned null'}`)
  }

  logEvent({
    level: 'info',
    msg: 'ab_test.created',
    event_type: 'wave_6d.ab_test',
    outcome: 'ok',
    venueId: input.venueId,
    data: {
      testId: data.id,
      testName: cfg.test_name,
      channel: cfg.channel,
      status,
      variantASeedCount: variantA.length,
      variantBSeedCount: variantB.length,
    },
  })

  return { ok: true, testId: data.id as string, status: data.status as string }
}

// ---------------------------------------------------------------------------
// Assign variant (append id to the appropriate arm, idempotent)
// ---------------------------------------------------------------------------

export async function assignVariantToAttributionEvent(
  input: AssignVariantInput,
  supabase: SupabaseClient = createServiceClient(),
): Promise<AssignVariantResult> {
  // Read-modify-write — concurrency-safe enough for the volumes Bloom
  // hits (a few assignments/day per test). PostgREST has no array-append
  // primitive that handles dedup atomically; we read then write.
  const { data: row, error: readErr } = await supabase
    .from('marketing_ab_tests')
    .select(
      'id, status, variant_a_attribution_event_ids, variant_b_attribution_event_ids',
    )
    .eq('id', input.testId)
    .maybeSingle()
  if (readErr) throw new Error(`assignVariantToAttributionEvent: ${readErr.message}`)
  if (!row) throw new Error('assignVariantToAttributionEvent: test not found')
  if (row.status !== 'running' && row.status !== 'planning') {
    throw new Error(
      `assignVariantToAttributionEvent: cannot assign on status=${row.status}`,
    )
  }

  const a = (row.variant_a_attribution_event_ids ?? []) as string[]
  const b = (row.variant_b_attribution_event_ids ?? []) as string[]

  if (
    a.includes(input.attributionEventId) ||
    b.includes(input.attributionEventId)
  ) {
    return {
      ok: true,
      testId: input.testId,
      variant: input.variant,
      alreadyAssigned: true,
    }
  }

  const next: { [k: string]: string[] } =
    input.variant === 'variant_a'
      ? {
          variant_a_attribution_event_ids: [
            ...a,
            input.attributionEventId,
          ].slice(0, ARM_CAP_PER_TEST),
        }
      : {
          variant_b_attribution_event_ids: [
            ...b,
            input.attributionEventId,
          ].slice(0, ARM_CAP_PER_TEST),
        }

  const { error: writeErr } = await supabase
    .from('marketing_ab_tests')
    .update(next)
    .eq('id', input.testId)
  if (writeErr) {
    throw new Error(`assignVariantToAttributionEvent: ${writeErr.message}`)
  }

  return {
    ok: true,
    testId: input.testId,
    variant: input.variant,
    alreadyAssigned: false,
  }
}

// ---------------------------------------------------------------------------
// Conclude (compute lift, decide winner)
// ---------------------------------------------------------------------------

interface ArmStats {
  eventCount: number
  bookedCount: number
  bookedRate: number
}

async function loadArmStats(
  supabase: SupabaseClient,
  attributionEventIds: string[],
): Promise<ArmStats> {
  if (attributionEventIds.length === 0) {
    return { eventCount: 0, bookedCount: 0, bookedRate: 0 }
  }
  const out: ArmStats = {
    eventCount: attributionEventIds.length,
    bookedCount: 0,
    bookedRate: 0,
  }
  const BATCH = 100
  // Pull weddings for these attribution events.
  const weddingIds: Set<string> = new Set()
  for (let i = 0; i < attributionEventIds.length; i += BATCH) {
    const slice = attributionEventIds.slice(i, i + BATCH)
    const { data } = await supabase
      .from('attribution_events')
      .select('wedding_id')
      .in('id', slice)
    for (const r of (data ?? []) as Array<{ wedding_id: string | null }>) {
      if (r.wedding_id) weddingIds.add(r.wedding_id)
    }
  }
  if (weddingIds.size === 0) {
    return out
  }
  const wedIds = Array.from(weddingIds)
  for (let i = 0; i < wedIds.length; i += BATCH) {
    const slice = wedIds.slice(i, i + BATCH)
    const { data } = await supabase
      .from('weddings')
      .select('id, status')
      .in('id', slice)
    for (const w of (data ?? []) as Array<{ id: string; status: string }>) {
      if (w.status === 'booked' || w.status === 'completed') {
        out.bookedCount += 1
      }
    }
  }
  out.bookedRate = out.eventCount > 0 ? out.bookedCount / out.eventCount : 0
  return out
}

export async function concludeAbTest(
  input: ConcludeAbTestInput,
  supabase: SupabaseClient = createServiceClient(),
): Promise<ConcludeAbTestResult> {
  const { data: row, error: readErr } = await supabase
    .from('marketing_ab_tests')
    .select(
      'id, venue_id, status, variant_a_attribution_event_ids, variant_b_attribution_event_ids',
    )
    .eq('id', input.testId)
    .maybeSingle()
  if (readErr) throw new Error(`concludeAbTest: ${readErr.message}`)
  if (!row) throw new Error('concludeAbTest: test not found')

  const a = (row.variant_a_attribution_event_ids ?? []) as string[]
  const b = (row.variant_b_attribution_event_ids ?? []) as string[]

  const [aStats, bStats] = await Promise.all([
    loadArmStats(supabase, a),
    loadArmStats(supabase, b),
  ])

  const thresholdMet =
    aStats.eventCount >= COHORT_THRESHOLD &&
    bStats.eventCount >= COHORT_THRESHOLD

  // If thin and not forced, return early without writing — caller can
  // surface "still running, n_too_small".
  if (!thresholdMet && !input.force) {
    return {
      ok: true,
      testId: input.testId,
      winner: null,
      liftPct: null,
      thresholdMet: false,
      variantAStats: aStats,
      variantBStats: bStats,
    }
  }

  // Decide winner. inconclusive when:
  //   - both arms 0 booked
  //   - rates within 0.5pp absolute (noise-floor)
  let winner: 'variant_a' | 'variant_b' | 'inconclusive' = 'inconclusive'
  let liftPct: number | null = null

  if (aStats.bookedCount === 0 && bStats.bookedCount === 0) {
    winner = 'inconclusive'
  } else if (Math.abs(aStats.bookedRate - bStats.bookedRate) < 0.005) {
    winner = 'inconclusive'
  } else if (aStats.bookedRate > bStats.bookedRate) {
    winner = 'variant_a'
    if (bStats.bookedRate > 0) {
      liftPct =
        ((aStats.bookedRate - bStats.bookedRate) / bStats.bookedRate) * 100
    } else {
      liftPct = aStats.bookedRate * 100
    }
  } else {
    winner = 'variant_b'
    if (aStats.bookedRate > 0) {
      liftPct =
        ((bStats.bookedRate - aStats.bookedRate) / aStats.bookedRate) * 100
    } else {
      liftPct = bStats.bookedRate * 100
    }
  }

  // Write conclusion.
  const { error: writeErr } = await supabase
    .from('marketing_ab_tests')
    .update({
      status: 'concluded',
      ended_at: new Date().toISOString(),
      winner,
      winner_decision_lift_pct:
        liftPct === null ? null : Math.round(liftPct * 100) / 100,
      winner_decided_at: new Date().toISOString(),
      winner_decided_by: input.decidedBy ?? null,
    })
    .eq('id', input.testId)
  if (writeErr) {
    throw new Error(`concludeAbTest: ${writeErr.message}`)
  }

  logEvent({
    level: 'info',
    msg: 'ab_test.concluded',
    event_type: 'wave_6d.ab_test',
    outcome: 'ok',
    venueId: row.venue_id as string,
    data: {
      testId: input.testId,
      winner,
      liftPct,
      thresholdMet,
      forced: input.force === true,
      variantA: aStats,
      variantB: bStats,
    },
  })

  return {
    ok: true,
    testId: input.testId,
    winner,
    liftPct,
    thresholdMet,
    variantAStats: aStats,
    variantBStats: bStats,
  }
}

// ---------------------------------------------------------------------------
// List + read
// ---------------------------------------------------------------------------

export interface ListAbTestsOptions {
  status?: string
  limit?: number
}

export async function listAbTests(
  venueId: string,
  options: ListAbTestsOptions = {},
  supabase: SupabaseClient = createServiceClient(),
): Promise<StoredAbTestRow[]> {
  const limit = Math.min(options.limit ?? 200, 1000)
  let query = supabase
    .from('marketing_ab_tests')
    .select(
      'id, venue_id, test_name, hypothesis, variant_a_label, variant_b_label, channel, target_persona, started_at, ended_at, variant_a_attribution_event_ids, variant_b_attribution_event_ids, winner, winner_decision_lift_pct, winner_decided_at, winner_decided_by, status, notes, created_at',
    )
    .eq('venue_id', venueId)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (options.status) query = query.eq('status', options.status)
  const { data, error } = await query
  if (error) throw new Error(`listAbTests: ${error.message}`)
  return (data ?? []) as StoredAbTestRow[]
}

export async function getAbTest(
  testId: string,
  supabase: SupabaseClient = createServiceClient(),
): Promise<StoredAbTestRow | null> {
  const { data, error } = await supabase
    .from('marketing_ab_tests')
    .select(
      'id, venue_id, test_name, hypothesis, variant_a_label, variant_b_label, channel, target_persona, started_at, ended_at, variant_a_attribution_event_ids, variant_b_attribution_event_ids, winner, winner_decision_lift_pct, winner_decided_at, winner_decided_by, status, notes, created_at',
    )
    .eq('id', testId)
    .maybeSingle()
  if (error) throw new Error(`getAbTest: ${error.message}`)
  return (data as StoredAbTestRow | null) ?? null
}
