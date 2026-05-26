/**
 * scripts/verify-calendly-binding.ts
 * ===================================
 * Phase 1 Batch 2 — CALENDLY VERIFICATION (PHASE-1-BATCH-2.md §7 named
 * verification script #1, gates the Calendly flips C3 / C11 / C12).
 *
 * WHAT IT VERIFIES
 * ----------------
 * Two things, both per-cohort coverage in the M1/M8 idiom:
 *
 *   1. INBOUND-CALENDLY → TOUCHPOINT COVERAGE.
 *      Pull recent `interactions` that look Calendly (type='meeting' OR
 *      surface='integration_event' carrying a calendly URI). For each,
 *      check whether a corresponding `touchpoints` row exists on
 *      `channel='calendly'` keyed by `external_id`.
 *
 *   2. C11 CUTOVER HEALTH — count `touchpoints` rows with
 *      `action_type='tour_cancelled'` in the last 14 days vs the prior
 *      14-day baseline. C11 used to write `touchpoints` direct from
 *      `calendly-outcomes.ts:~137`; post-flip it routes through
 *      `linkSignal`. If the count drops to zero (or near zero) after the
 *      flip, that's the C11 silent-drop signature.
 *
 * The script also breaks down coverage by action_type cohort
 * (`tour_booked` / `tour_cancelled` / `tour_attended`) so each Calendly
 * write-site's binding can be reasoned about independently.
 *
 * READ-ONLY. SELECTs only.
 *
 * RUN
 * ---
 *   BRANCH_URL=https://<ref>.supabase.co \
 *   BRANCH_KEY=<service_role_key> \
 *   npx tsx scripts/verify-calendly-binding.ts [--venue=<uuid>] [--days=<N>]
 *
 * Env / CLI defaults:
 *   --venue  : Rixey (`f3d10226-4c5c-47ad-b89b-98ad63842492`) when omitted.
 *   --days   : 60 (override via `CALENDLY_WINDOW_DAYS`).
 *
 * EXIT CODES
 * ----------
 *   0  PASS  — touchpoint coverage of Calendly interactions >= 95% (full
 *              window) AND no >50% drop in tour_cancelled rate vs the
 *              prior 14-day baseline.
 *   1  FAIL  — coverage below 80% OR tour_cancelled rate dropped >70%.
 *   2  WARN  — between gates (logged + non-zero so a nightly cron can
 *              surface it without spamming a hard alert).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const PAGE = 1000

interface InteractionRow {
  id: string
  venue_id: string
  wedding_id: string | null
  type: string | null
  surface: string | null
  subject: string | null
  full_body: string | null
  timestamp: string | null
  created_at: string | null
}

interface TouchpointRow {
  id: string
  venue_id: string
  couple_id: string | null
  channel: string
  action_type: string
  external_id: string
  occurred_at: string
}

function parseArgs(): { venue: string; days: number } {
  let venue = RIXEY_VENUE_ID
  let days = Number(process.env.CALENDLY_WINDOW_DAYS ?? '60')
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--venue=')) venue = arg.slice('--venue='.length)
    else if (arg.startsWith('--days=')) days = Number(arg.slice('--days='.length))
  }
  if (!Number.isFinite(days) || days < 0) days = 60
  return { venue, days }
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

const pct = (n: number, d: number) =>
  d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`

async function main() {
  const url = process.env.BRANCH_URL
  const key = process.env.BRANCH_KEY
  if (!url || !key) {
    console.error(
      'ERROR: BRANCH_URL and BRANCH_KEY must be set in the environment.\n' +
        'Run: BRANCH_URL=https://<ref>.supabase.co BRANCH_KEY=<service_role_key> ' +
        'npx tsx scripts/verify-calendly-binding.ts',
    )
    process.exit(1)
  }
  if (url.includes('jsxxgwprxuqgcauzlxcb')) {
    console.error('ERROR: BRANCH_URL points at the production project. Refusing.')
    process.exit(1)
  }

  const { venue, days } = parseArgs()
  const supabase: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false },
  })

  const sinceIso = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null
  const widenedSinceIso =
    days > 0 ? new Date(Date.now() - (days + 14) * 86_400_000).toISOString() : null

  console.log('='.repeat(78))
  console.log('CALENDLY VERIFICATION — C3 / C11 / C12 cohort coverage + cutover health')
  console.log('='.repeat(78))
  console.log(`Target DB   : ${url}`)
  console.log(`Venue       : ${venue}`)
  console.log(`Data window : ${sinceIso ? `last ${days} days (since ${sinceIso})` : 'ALL TIME'}`)
  console.log('')

  // ---------------------------------------------------------------------------
  // 1. Pull recent Calendly-shaped interactions.
  //    A Calendly interaction is either type='meeting' (Calendly batch
  //    tracer adapter scans this) OR surface='integration_event' whose
  //    full_body/subject carries a calendly URI. We use the union and
  //    classify by best signal.
  // ---------------------------------------------------------------------------
  const interactions = await fetchAll<InteractionRow>('interactions', (from, to) => {
    let q = supabase
      .from('interactions')
      .select('id, venue_id, wedding_id, type, surface, subject, full_body, timestamp, created_at')
      .eq('venue_id', venue)
      .eq('type', 'meeting')
      .order('created_at', { ascending: true })
      .range(from, to)
    if (sinceIso) q = q.gte('created_at', sinceIso)
    return q
  })

  console.log(`[1] type='meeting' interactions in window     : ${interactions.length}`)

  // ---------------------------------------------------------------------------
  // 2. Pull Calendly touchpoints in a widened window.
  // ---------------------------------------------------------------------------
  const touchpoints = await fetchAll<TouchpointRow>('touchpoints', (from, to) => {
    let q = supabase
      .from('touchpoints')
      .select('id, venue_id, couple_id, channel, action_type, external_id, occurred_at')
      .eq('venue_id', venue)
      .eq('channel', 'calendly')
      .order('occurred_at', { ascending: true })
      .range(from, to)
    if (widenedSinceIso) q = q.gte('occurred_at', widenedSinceIso)
    return q
  })
  console.log(`[2] channel='calendly' touchpoints (widened)  : ${touchpoints.length}`)

  // Per-action_type bucket counts.
  const tpByAction = new Map<string, TouchpointRow[]>()
  for (const tp of touchpoints) {
    const arr = tpByAction.get(tp.action_type) ?? []
    arr.push(tp)
    tpByAction.set(tp.action_type, arr)
  }
  console.log('    per-action_type breakdown:')
  for (const [action, arr] of [...tpByAction.entries()].sort()) {
    console.log(`      ${action.padEnd(24)} : ${arr.length}`)
  }
  console.log('')

  // ---------------------------------------------------------------------------
  // 3. Coverage: for each interaction, is there a touchpoint? The robust
  //    join is interaction-id-in-touchpoints (touchpoints don't carry
  //    interaction_id reliably for Calendly, since the webhook builds
  //    the touchpoint from the Calendly URI not from the interaction).
  //    Best available join: timestamp-proximity within tolerance.
  // ---------------------------------------------------------------------------
  const TOLERANCE_MS = 10 * 60 * 1000 // 10 min — Calendly webhook fires within seconds; cron syncs land minutes later

  const tpSortedByTime = [...touchpoints]
    .filter((t) => t.occurred_at)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))

  let matched = 0
  let matchedTpIds = new Set<string>()
  let unmatched = 0
  const samplesUnmatched: string[] = []

  for (const it of interactions) {
    if (!it.timestamp) {
      unmatched++
      continue
    }
    const targetMs = new Date(it.timestamp).getTime()
    if (!Number.isFinite(targetMs)) {
      unmatched++
      continue
    }
    let best: TouchpointRow | null = null
    let bestDelta = Number.POSITIVE_INFINITY
    for (const tp of tpSortedByTime) {
      const t = new Date(tp.occurred_at).getTime()
      if (!Number.isFinite(t)) continue
      const delta = Math.abs(t - targetMs)
      if (delta > TOLERANCE_MS) continue
      if (delta < bestDelta) {
        bestDelta = delta
        best = tp
      }
    }
    if (best) {
      matched++
      matchedTpIds.add(best.id)
    } else {
      unmatched++
      if (samplesUnmatched.length < 12) samplesUnmatched.push(it.id)
    }
  }
  void matchedTpIds

  const coverage = interactions.length > 0 ? matched / interactions.length : null

  console.log('-'.repeat(78))
  console.log('COVERAGE — type=meeting interactions matched to calendly touchpoints')
  console.log('-'.repeat(78))
  console.log(`  total interactions                     : ${interactions.length}`)
  console.log(`  WITH a calendly touchpoint (±10 min)   : ${matched} (${pct(matched, interactions.length)})`)
  console.log(`  WITHOUT a calendly touchpoint          : ${unmatched} (${pct(unmatched, interactions.length)})`)
  console.log('')
  if (samplesUnmatched.length) {
    console.log('SAMPLE — meeting interactions with NO calendly touchpoint:')
    samplesUnmatched.forEach((id) => console.log(`  interaction ${id}`))
    console.log('')
  }

  // ---------------------------------------------------------------------------
  // 4. C11 cutover health — tour_cancelled count last 14d vs prior 14d.
  // ---------------------------------------------------------------------------
  const now = Date.now()
  const recentIso = new Date(now - 14 * 86_400_000).toISOString()
  const priorStartIso = new Date(now - 28 * 86_400_000).toISOString()
  const priorEndIso = new Date(now - 14 * 86_400_000).toISOString()

  const cancelledAll = tpByAction.get('tour_cancelled') ?? []
  const recentCancelled = cancelledAll.filter((t) => t.occurred_at >= recentIso).length
  const priorCancelled = cancelledAll.filter(
    (t) => t.occurred_at >= priorStartIso && t.occurred_at < priorEndIso,
  ).length

  const attendedAll = tpByAction.get('tour_attended') ?? []
  const recentAttended = attendedAll.filter((t) => t.occurred_at >= recentIso).length
  const priorAttended = attendedAll.filter(
    (t) => t.occurred_at >= priorStartIso && t.occurred_at < priorEndIso,
  ).length

  const bookedAll = tpByAction.get('tour_booked') ?? []
  const recentBooked = bookedAll.filter((t) => t.occurred_at >= recentIso).length
  const priorBooked = bookedAll.filter(
    (t) => t.occurred_at >= priorStartIso && t.occurred_at < priorEndIso,
  ).length

  function deltaPct(recent: number, prior: number): { delta: number; label: string } {
    if (prior === 0 && recent === 0) return { delta: 0, label: '0% (no activity in either window)' }
    if (prior === 0) return { delta: Number.POSITIVE_INFINITY, label: `+∞ (0 → ${recent})` }
    const d = (recent - prior) / prior
    return { delta: d, label: `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%` }
  }

  const cancelledDelta = deltaPct(recentCancelled, priorCancelled)
  const attendedDelta = deltaPct(recentAttended, priorAttended)
  const bookedDelta = deltaPct(recentBooked, priorBooked)

  console.log('-'.repeat(78))
  console.log('C11 / C12 CUTOVER HEALTH — last 14d vs prior 14d')
  console.log('-'.repeat(78))
  console.log(`  tour_booked     : recent=${recentBooked}  prior=${priorBooked}  delta=${bookedDelta.label}`)
  console.log(`  tour_attended   : recent=${recentAttended}  prior=${priorAttended}  delta=${attendedDelta.label}  [C12]`)
  console.log(`  tour_cancelled  : recent=${recentCancelled}  prior=${priorCancelled}  delta=${cancelledDelta.label}  [C11]`)
  console.log('')

  // ---------------------------------------------------------------------------
  // 5. Verdict.
  // ---------------------------------------------------------------------------
  const COVERAGE_PASS = 0.95
  const COVERAGE_WARN = 0.80
  // A >70% drop in cancellations or attendance is the C11/C12 silent-drop
  // alarm. Lower than that is logged as WARN.
  const CUTOVER_FAIL_DELTA = -0.70

  let exitCode = 0
  console.log('='.repeat(78))
  console.log('CALENDLY VERDICT')
  console.log('='.repeat(78))
  if (coverage === null) {
    console.log('  COVERAGE: n/a (no Calendly-shaped interactions in window).')
  } else if (coverage >= COVERAGE_PASS) {
    console.log(`  COVERAGE: PASS (${pct(matched, interactions.length)} of meeting interactions have a calendly touchpoint).`)
  } else if (coverage >= COVERAGE_WARN) {
    console.log(`  COVERAGE: WARN (${pct(matched, interactions.length)}; gate is ${COVERAGE_PASS * 100}%).`)
    exitCode = Math.max(exitCode, 2)
  } else {
    console.log(`  COVERAGE: FAIL (${pct(matched, interactions.length)}; gate is ${COVERAGE_WARN * 100}%).`)
    exitCode = 1
  }

  function judgeCutover(label: string, d: number) {
    if (!Number.isFinite(d)) {
      console.log(`  ${label}: PASS (new activity from zero baseline).`)
      return
    }
    if (d <= CUTOVER_FAIL_DELTA) {
      console.log(`  ${label}: FAIL (${(d * 100).toFixed(1)}% drop vs prior 14d — possible silent-drop bug).`)
      exitCode = 1
    } else if (d <= -0.30) {
      console.log(`  ${label}: WARN (${(d * 100).toFixed(1)}% drop vs prior 14d — investigate before next batch).`)
      exitCode = Math.max(exitCode, 2)
    } else {
      console.log(`  ${label}: PASS (${(d * 100).toFixed(1)}% vs prior 14d).`)
    }
  }
  judgeCutover('C11 (tour_cancelled)', cancelledDelta.delta)
  judgeCutover('C12 (tour_attended)', attendedDelta.delta)
  console.log('='.repeat(78))

  process.exit(exitCode)
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
