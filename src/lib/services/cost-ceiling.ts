/**
 * Bloom House: Per-Venue Cost Ceiling Service
 *
 * Implements Playbook 21.4.3:
 *   "Every venue has a per-day cost ceiling. When 80% is reached, a
 *    notify-level alert fires. When 100% is reached, autonomous
 *    behavior pauses until next day or coordinator override."
 *
 * Default ceiling: $5/day per venue (500 cents). Decided 2026-05-01.
 * Realistic Sonnet-everywhere spend is ~$2/day; post-tier-mapping ~$1/day.
 * The ceiling exists for the catastrophic case (runaway loop, infinite
 * retry, brain summarising the entire forensic record per call) — not
 * for normal operation.
 *
 * Day boundary: UTC calendar day. Per-venue tz reset is a future
 * refinement (matches the existing daily_limit reset behaviour in
 * autonomous-sender.getTodayAutoSendCount).
 *
 * Pause semantics:
 *   - autonomous-sender refuses to flush auto-sends
 *   - cron-driven AI services skip (when wired — this PR wires
 *     autonomous-sender; remaining services follow)
 *   - coordinator-initiated calls (NLQ, manual approval, Sage chat in
 *     response to couple) still work
 *
 * Reset:
 *   - At next UTC midnight: clearStaleAutonomousPauses() flips the
 *     flag back to false for any venue whose paused_at is in a prior
 *     UTC day. Run from the existing cost_ceiling cron entry.
 *   - On coordinator override: POST /api/agent/cost-ceiling/resume
 *     clears immediately.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { createNotification } from './admin-notifications'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostCeilingStatus {
  venueId: string
  ceilingCents: number
  spendCents: number
  utilisation: number // 0.0 - 1.0+
  paused: boolean
  pausedAt: string | null
  pausedReason: string | null
}

interface CheckResult {
  status: CostCeilingStatus
  /** Set when this check transitioned to a new alert level on this venue. */
  transition?: 'crossed_80' | 'crossed_100' | 'reset'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * UTC start of the current calendar day in ISO8601. Matches the
 * autonomous-sender.getTodayAutoSendCount window so spend math and
 * send-count math line up to the same boundary.
 */
function utcDayStart(): string {
  const now = new Date()
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).toISOString()
}

function dollarsFromCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

// ---------------------------------------------------------------------------
// Read: current status (cheap; safe to call from request paths)
// ---------------------------------------------------------------------------

/**
 * Returns current spend vs ceiling for a venue WITHOUT triggering any
 * notifications or pause flips. Use from UI / admin tooling. Use
 * checkAndEnforce() from the cron path that should actually take
 * action.
 */
export async function getCostCeilingStatus(
  venueId: string
): Promise<CostCeilingStatus | null> {
  const supabase = createServiceClient()

  const { data: config } = await supabase
    .from('venue_config')
    .select('daily_cost_ceiling_cents, autonomous_paused, autonomous_paused_at, autonomous_paused_reason')
    .eq('venue_id', venueId)
    .maybeSingle()

  if (!config) return null

  const ceilingCents = (config.daily_cost_ceiling_cents as number) ?? 500

  const { data: spendRows } = await supabase
    .from('api_costs')
    .select('cost')
    .eq('venue_id', venueId)
    .gte('created_at', utcDayStart())

  const spendDollars = (spendRows ?? []).reduce(
    (sum, r) => sum + Number(r.cost ?? 0),
    0
  )
  const spendCents = Math.round(spendDollars * 100)

  return {
    venueId,
    ceilingCents,
    spendCents,
    utilisation: ceilingCents > 0 ? spendCents / ceilingCents : 0,
    paused: (config.autonomous_paused as boolean) ?? false,
    pausedAt: (config.autonomous_paused_at as string) ?? null,
    pausedReason: (config.autonomous_paused_reason as string) ?? null,
  }
}

/**
 * Quick boolean check used by hot paths (autonomous-sender eligibility,
 * follow-up cron, etc.). Reads only the flag, not the whole spend
 * aggregation. Returns false when row missing — fail-open on missing
 * config so a fresh venue isn't blocked.
 */
export async function isAutonomousPaused(venueId: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venue_config')
    .select('autonomous_paused')
    .eq('venue_id', venueId)
    .maybeSingle()
  if (error) {
    console.error('[cost-ceiling] isAutonomousPaused lookup failed:', error.message)
    return false
  }
  return (data?.autonomous_paused as boolean) ?? false
}

/**
 * Filter a list of venue IDs down to those whose autonomous behavior
 * is NOT paused. Used by cron-driven AI services (anomaly detection,
 * digests, intelligence engine, follow-ups, re-engagement) to skip
 * venues at 100% ceiling per Playbook OPS-21.4.3:
 *
 *   "When 100% is reached, autonomous behavior pauses (drafts queue
 *    for coordinator approval; no auto-sends; no proactive insights)
 *    until next day or coordinator override."
 *
 * The autonomous-sender chokepoint catches the highest-risk path
 * (auto-flushed sends to couples). This filter is the second line:
 * cron services that consume LLM cost (anomaly hypothesis, weekly
 * briefings, daily digests, intelligence engine, follow-up draft
 * generation, re-engagement composition) skip paused venues so the
 * ceiling isn't a softener.
 *
 * Returns the input list filtered, plus a count of skipped venues
 * (logged by the cron job for visibility). Single SQL round-trip
 * regardless of input size; uses .in() filter.
 */
export async function filterActiveVenues(
  venueIds: string[]
): Promise<{ active: string[]; skipped: string[] }> {
  if (venueIds.length === 0) return { active: [], skipped: [] }
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venue_config')
    .select('venue_id, autonomous_paused')
    .in('venue_id', venueIds)
  if (error) {
    console.error('[cost-ceiling] filterActiveVenues lookup failed:', error.message)
    // Fail-open on lookup failure — better to over-run a paused
    // venue than to over-block a healthy one when our DB is misbehaving.
    return { active: venueIds, skipped: [] }
  }
  const pausedSet = new Set<string>()
  for (const row of (data ?? []) as Array<{ venue_id: string; autonomous_paused: boolean }>) {
    if (row.autonomous_paused) pausedSet.add(row.venue_id)
  }
  // Venues without a venue_config row are treated as active (fresh
  // venues, demo-mode, etc.). The cron services do their own per-venue
  // sanity checks downstream.
  const active = venueIds.filter((id) => !pausedSet.has(id))
  const skipped = venueIds.filter((id) => pausedSet.has(id))
  return { active, skipped }
}

// ---------------------------------------------------------------------------
// Enforce: cron-side check that may flip the pause flag and notify
// ---------------------------------------------------------------------------

/**
 * Check spend vs ceiling for one venue. If a transition crossed 80% or
 * 100% since last check, fire the appropriate notification and (for
 * 100%) flip autonomous_paused. Idempotent on a stable spend value —
 * the createNotification dedup window prevents repeat alerts within
 * 5 minutes; cost_ceiling_warned_at protects against double-warning
 * on the same day.
 */
export async function checkAndEnforceCeiling(
  venueId: string
): Promise<CheckResult> {
  const supabase = createServiceClient()
  const status = await getCostCeilingStatus(venueId)
  if (!status) {
    return {
      status: {
        venueId,
        ceilingCents: 0,
        spendCents: 0,
        utilisation: 0,
        paused: false,
        pausedAt: null,
        pausedReason: null,
      },
    }
  }

  const { ceilingCents, spendCents, utilisation, paused } = status
  let transition: CheckResult['transition']

  // 100% trigger: flip pause flag (if not already paused) + notify.
  if (utilisation >= 1.0 && !paused) {
    const reason =
      `daily cost ceiling reached: ${dollarsFromCents(spendCents)} of ${dollarsFromCents(ceilingCents)} ` +
      `(${(utilisation * 100).toFixed(0)}% utilisation)`
    const { error: pauseErr } = await supabase
      .from('venue_config')
      .update({
        autonomous_paused: true,
        autonomous_paused_at: new Date().toISOString(),
        autonomous_paused_reason: reason,
      })
      .eq('venue_id', venueId)

    if (pauseErr) {
      console.error(
        `[cost-ceiling] Failed to set autonomous_paused for ${venueId}:`,
        pauseErr.message
      )
    } else {
      transition = 'crossed_100'
      await createNotification({
        venueId,
        type: 'cost_ceiling_paused',
        title: `Autonomous behavior paused — ${dollarsFromCents(spendCents)} spent today (ceiling ${dollarsFromCents(ceilingCents)})`,
        body: JSON.stringify({
          ceilingCents,
          spendCents,
          utilisation,
          reason,
          resumeUrl: '/api/agent/cost-ceiling/resume',
        }),
      })
    }
  } else if (utilisation >= 0.8 && utilisation < 1.0) {
    // 80% trigger: notify (no pause). Stamp warned_at so the cron
    // doesn't double-fire the same day.
    const { data: cfg } = await supabase
      .from('venue_config')
      .select('cost_ceiling_warned_at')
      .eq('venue_id', venueId)
      .maybeSingle()

    const lastWarn = (cfg?.cost_ceiling_warned_at as string) ?? null
    const lastWarnDay = lastWarn ? new Date(lastWarn).toISOString().slice(0, 10) : null
    const todayDay = new Date().toISOString().slice(0, 10)

    if (lastWarnDay !== todayDay) {
      await supabase
        .from('venue_config')
        .update({ cost_ceiling_warned_at: new Date().toISOString() })
        .eq('venue_id', venueId)

      transition = 'crossed_80'
      await createNotification({
        venueId,
        type: 'cost_ceiling_warning',
        title: `LLM spend at ${(utilisation * 100).toFixed(0)}% of daily ceiling — ${dollarsFromCents(spendCents)} of ${dollarsFromCents(ceilingCents)}`,
        body: JSON.stringify({
          ceilingCents,
          spendCents,
          utilisation,
          message:
            'Autonomous behavior will pause if 100% is reached. ' +
            'Investigate which service is driving spend (api_costs by service / context).',
        }),
      })
    }
  }

  return { status, transition }
}

/**
 * Cron entry: check every venue. Returns counts for telemetry.
 */
export async function enforceCeilingsAllVenues(): Promise<{
  checked: number
  warned: number
  paused: number
}> {
  const supabase = createServiceClient()
  const { data: venues } = await supabase
    .from('venues')
    .select('id, name')

  let checked = 0
  let warned = 0
  let paused = 0

  for (const venue of venues ?? []) {
    const venueId = venue.id as string
    try {
      const result = await checkAndEnforceCeiling(venueId)
      checked++
      if (result.transition === 'crossed_80') warned++
      if (result.transition === 'crossed_100') {
        paused++
        console.warn(
          `[cost-ceiling] PAUSED ${venue.name ?? venueId}: ${result.status.pausedReason}`
        )
      }
    } catch (err) {
      console.error(
        `[cost-ceiling] check failed for ${venue.name ?? venueId}:`,
        err
      )
    }
  }

  return { checked, warned, paused }
}

// ---------------------------------------------------------------------------
// Reset: clear stale pauses at UTC day boundary
// ---------------------------------------------------------------------------

/**
 * Clears autonomous_paused for any venue whose paused_at is in a prior
 * UTC calendar day AND whose current spend is now under ceiling. Belt:
 * the spend check protects against an edge case where the cron picks
 * up at 00:00:01 UTC and finds a venue still over because the day
 * literally just rolled — defer the reset to the next tick.
 *
 * Coordinator overrides clear immediately via the /resume endpoint;
 * this catches the natural-reset case.
 */
export async function clearStaleAutonomousPauses(): Promise<number> {
  const supabase = createServiceClient()

  const { data: pausedVenues } = await supabase
    .from('venue_config')
    .select('venue_id, autonomous_paused_at')
    .eq('autonomous_paused', true)

  let cleared = 0
  const utcTodayStart = utcDayStart()

  for (const row of pausedVenues ?? []) {
    const venueId = row.venue_id as string
    const pausedAt = row.autonomous_paused_at as string | null

    // Only clear if pause happened in a previous UTC day
    if (!pausedAt || pausedAt >= utcTodayStart) continue

    // And only if current spend is under ceiling (defends the
    // 00:00:01-edge case described above)
    const status = await getCostCeilingStatus(venueId)
    if (!status || status.utilisation >= 1.0) continue

    const { error } = await supabase
      .from('venue_config')
      .update({
        autonomous_paused: false,
        autonomous_paused_at: null,
        autonomous_paused_reason: null,
        cost_ceiling_warned_at: null,
      })
      .eq('venue_id', venueId)

    if (!error) {
      cleared++
      console.log(`[cost-ceiling] auto-resumed venue ${venueId} (new day)`)
      await createNotification({
        venueId,
        type: 'cost_ceiling_resumed',
        title: 'Autonomous behavior resumed (new day, ceiling reset)',
        body: JSON.stringify({
          previousReason: status.pausedReason,
          currentSpendCents: status.spendCents,
          ceilingCents: status.ceilingCents,
        }),
      })
    }
  }

  return cleared
}

// ---------------------------------------------------------------------------
// Coordinator override
// ---------------------------------------------------------------------------

/**
 * Manually clear a venue's autonomous-pause. Called by the coordinator
 * resume endpoint. Records who and when via the notification trail.
 */
export async function resumeAutonomousBehavior(
  venueId: string,
  actor: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = createServiceClient()

  const status = await getCostCeilingStatus(venueId)
  if (!status) return { ok: false, reason: 'venue_config not found' }
  if (!status.paused) return { ok: false, reason: 'not currently paused' }

  const { error } = await supabase
    .from('venue_config')
    .update({
      autonomous_paused: false,
      autonomous_paused_at: null,
      autonomous_paused_reason: null,
    })
    .eq('venue_id', venueId)

  if (error) return { ok: false, reason: error.message }

  await createNotification({
    venueId,
    type: 'cost_ceiling_overridden',
    title: 'Autonomous behavior resumed by coordinator override',
    body: JSON.stringify({
      actor,
      previousReason: status.pausedReason,
      currentSpendCents: status.spendCents,
      ceilingCents: status.ceilingCents,
      utilisation: status.utilisation,
    }),
  })

  return { ok: true }
}
