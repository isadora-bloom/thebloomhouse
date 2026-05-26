/**
 * scripts/verify-c11-c12-cutover.ts
 * ==================================
 * Phase 1 Batch 2 — CALENDLY C11/C12 CUTOVER HEALTH
 * (PHASE-1-BATCH-2.md §7 named verification script #5).
 *
 * WHAT IT DOES
 * ------------
 * C11 replaces `calendly-outcomes.ts:~137`'s direct `touchpoints.upsert`
 * for cancellations with `linkSignal({action_type:'tour_cancelled'})`.
 * C12 does the same for the daily attendance sweep at
 * `calendly-outcomes.ts:~344` with `linkSignalBatch`.
 *
 * Both are CHOKEPOINT-VIOLATION FLIPS (replace, not dual-write) — so
 * the only post-flip telemetry is the rate of cancellation /
 * attendance signals reaching `touchpoints`. If C11 silently drops to
 * fragments (identity-poor cancellations have no `tourCancellationFallback`
 * fired, or the fallback regressed) the `tour_cancelled` count
 * collapses. If C12 over-attributes (the new linkSignalBatch matcher
 * resolves attendance to the wrong couple, or fires duplicate rows
 * because of an external_id collision) the `tour_attended` count
 * surges.
 *
 * Cron-friendly: emits one alert line per cohort to stdout AND exits
 * non-zero when the delta crosses the gate. Suitable for nightly
 * invocation:
 *
 *   vercel.json (proposed — NOT WRITTEN by this script):
 *     {
 *       "crons": [
 *         { "path": "/api/admin/verify/c11-c12-cutover", "schedule": "0 9 * * *" }
 *       ]
 *     }
 *   ...or a GitHub Actions schedule with this script as the step.
 *
 * READ-ONLY. SELECTs only.
 *
 * RUN
 * ---
 *   BRANCH_URL=https://<ref>.supabase.co \
 *   BRANCH_KEY=<service_role_key> \
 *   npx tsx scripts/verify-c11-c12-cutover.ts [--venue=<uuid>]
 *
 * CLI flags:
 *   --venue          : default Rixey.
 *   --recent-days    : default 7  (the post-cutover window).
 *   --baseline-days  : default 14 (the prior comparison window, immediately
 *                                  before the recent window).
 *   --alert-delta    : default 0.30 (alert if |recent - baseline|/baseline > 30%).
 *
 * EXIT CODES
 * ----------
 *   0  OK     — both cohorts within the alert band.
 *   2  ALERT  — at least one cohort's delta exceeds the threshold; the
 *               script always prints a single ALERT line per cohort so the
 *               cron output is one-line-grep-friendly.
 *   1  FATAL  — DB error or arg parse failure.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const PAGE = 1000

interface TouchpointRow {
  id: string
  venue_id: string
  channel: string
  action_type: string
  occurred_at: string
}

function parseArgs(): { venue: string; recentDays: number; baselineDays: number; alertDelta: number } {
  let venue = RIXEY_VENUE_ID
  let recentDays = 7
  let baselineDays = 14
  let alertDelta = 0.30
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--venue=')) venue = arg.slice('--venue='.length)
    else if (arg.startsWith('--recent-days=')) recentDays = Number(arg.slice('--recent-days='.length))
    else if (arg.startsWith('--baseline-days=')) baselineDays = Number(arg.slice('--baseline-days='.length))
    else if (arg.startsWith('--alert-delta=')) alertDelta = Number(arg.slice('--alert-delta='.length))
  }
  if (!Number.isFinite(recentDays) || recentDays < 1) recentDays = 7
  if (!Number.isFinite(baselineDays) || baselineDays < 1) baselineDays = 14
  if (!Number.isFinite(alertDelta) || alertDelta <= 0) alertDelta = 0.30
  return { venue, recentDays, baselineDays, alertDelta }
}

async function fetchAll<T>(
  label: string,
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    const batch = data ?? []
    out.push(...batch)
    if (batch.length < PAGE) break
    from += PAGE
  }
  return out
}

async function main() {
  const url = process.env.BRANCH_URL
  const key = process.env.BRANCH_KEY
  if (!url || !key) {
    console.error(
      'ERROR: BRANCH_URL and BRANCH_KEY must be set in the environment.\n' +
        'Run: BRANCH_URL=https://<ref>.supabase.co BRANCH_KEY=<service_role_key> ' +
        'npx tsx scripts/verify-c11-c12-cutover.ts',
    )
    process.exit(1)
  }
  if (url.includes('jsxxgwprxuqgcauzlxcb')) {
    console.error('ERROR: BRANCH_URL points at the production project. Refusing.')
    process.exit(1)
  }

  const { venue, recentDays, baselineDays, alertDelta } = parseArgs()
  const supabase: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false },
  })

  const now = Date.now()
  const recentStartMs = now - recentDays * 86_400_000
  const baselineStartMs = recentStartMs - baselineDays * 86_400_000
  const recentStartIso = new Date(recentStartMs).toISOString()
  const baselineStartIso = new Date(baselineStartMs).toISOString()

  console.log('='.repeat(78))
  console.log('CALENDLY C11/C12 CUTOVER HEALTH')
  console.log('='.repeat(78))
  console.log(`Target DB    : ${url}`)
  console.log(`Venue        : ${venue}`)
  console.log(`Recent window: last ${recentDays} days  (since ${recentStartIso})`)
  console.log(`Baseline     : prior ${baselineDays} days (${baselineStartIso} → ${recentStartIso})`)
  console.log(`Alert delta  : ±${(alertDelta * 100).toFixed(0)}%`)
  console.log('')

  // ---------------------------------------------------------------------------
  // Pull calendly touchpoints across both windows.
  // ---------------------------------------------------------------------------
  const touchpoints = await fetchAll<TouchpointRow>('touchpoints', (from, to) =>
    supabase
      .from('touchpoints')
      .select('id, venue_id, channel, action_type, occurred_at')
      .eq('venue_id', venue)
      .eq('channel', 'calendly')
      .gte('occurred_at', baselineStartIso)
      .order('occurred_at', { ascending: true })
      .range(from, to),
  )

  function countInWindow(action: string, startMs: number, endMs: number): number {
    return touchpoints.filter((t) => {
      if (t.action_type !== action) return false
      const ms = new Date(t.occurred_at).getTime()
      return Number.isFinite(ms) && ms >= startMs && ms < endMs
    }).length
  }

  const cancellationsRecent = countInWindow('tour_cancelled', recentStartMs, now)
  const cancellationsBaseline = countInWindow('tour_cancelled', baselineStartMs, recentStartMs)
  // Normalise baseline-per-day rate so the comparison is apples-to-apples
  // when recentDays != baselineDays.
  const cancellationsBaselineRecentEquiv =
    (cancellationsBaseline / baselineDays) * recentDays

  const attendanceRecent = countInWindow('tour_attended', recentStartMs, now)
  const attendanceBaseline = countInWindow('tour_attended', baselineStartMs, recentStartMs)
  const attendanceBaselineRecentEquiv =
    (attendanceBaseline / baselineDays) * recentDays

  function alertLine(
    label: string,
    recent: number,
    baselineEquiv: number,
    baselineRaw: number,
  ): { line: string; alert: boolean; delta: number | null } {
    if (baselineEquiv === 0 && recent === 0) {
      return {
        line: `OK ${label}: recent=${recent} baseline=${baselineRaw} (zero activity in either window)`,
        alert: false,
        delta: null,
      }
    }
    if (baselineEquiv === 0) {
      return {
        line: `ALERT ${label}: recent=${recent} baseline=${baselineRaw} (new activity from zero baseline — investigate)`,
        alert: true,
        delta: null,
      }
    }
    const delta = (recent - baselineEquiv) / baselineEquiv
    const dStr = `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`
    const verdict = Math.abs(delta) > alertDelta ? 'ALERT' : 'OK'
    return {
      line:
        `${verdict} ${label}: recent=${recent} baseline=${baselineRaw} ` +
        `(per-${recentDays}d-equiv ${baselineEquiv.toFixed(1)}; delta ${dStr})`,
      alert: verdict === 'ALERT',
      delta,
    }
  }

  const cancellationsAlert = alertLine(
    'tour_cancelled [C11]',
    cancellationsRecent,
    cancellationsBaselineRecentEquiv,
    cancellationsBaseline,
  )
  const attendanceAlert = alertLine(
    'tour_attended  [C12]',
    attendanceRecent,
    attendanceBaselineRecentEquiv,
    attendanceBaseline,
  )

  console.log(cancellationsAlert.line)
  console.log(attendanceAlert.line)
  console.log('')

  // ---------------------------------------------------------------------------
  // Operational interpretation table — readable for the cron consumer.
  // ---------------------------------------------------------------------------
  console.log('-'.repeat(78))
  console.log('INTERPRETATION (what each alert shape means operationally)')
  console.log('-'.repeat(78))
  console.log('  C11 alert + tour_cancelled DROPPED:')
  console.log('    → likely cause: identity-poor cancellations silently routing to')
  console.log('      fragments (linkSignal returns {action:"fragment"}) and the')
  console.log('      Pbatch2-10 tourCancellationFallback path regressed or did not')
  console.log('      ship. D9 cohort funnel reads tour_cancelled touchpoints, not')
  console.log('      fragments — funnel numbers would degrade silently. CODE BUG.')
  console.log('  C11 alert + tour_cancelled SURGED:')
  console.log('    → likely cause: duplicate cancellation touchpoints from the')
  console.log('      fallback firing AND linkSignal both writing, OR a real spike')
  console.log('      in couple cancellations (operator should know which).')
  console.log('  C12 alert + tour_attended DROPPED:')
  console.log('    → likely cause: daily attendance-sweep cron not running, or the')
  console.log('      linkSignalBatch matcher failing to bind. Compare to Calendly')
  console.log('      API booking count manually.')
  console.log('  C12 alert + tour_attended SURGED:')
  console.log('    → likely cause: external_id collision causing the same booking to')
  console.log('      be re-attributed across multiple couples. Check the per-day')
  console.log('      count vs the per-day Calendly /scheduled_events API count.')
  console.log('  Both alerts: investigate the daily cron + the Calendly API quota.')
  console.log('  Neither alert + low absolute counts: low-tour-volume venue; widen')
  console.log('    --baseline-days or accept that the cohort is too small to alarm.')
  console.log('')

  const alerted = cancellationsAlert.alert || attendanceAlert.alert
  console.log('='.repeat(78))
  console.log(alerted ? 'RESULT: ALERT (exit 2).' : 'RESULT: OK.')
  console.log('='.repeat(78))

  process.exit(alerted ? 2 : 0)
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
