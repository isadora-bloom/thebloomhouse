/**
 * scripts/verify-sms-binding.ts
 * ==============================
 * Phase 1 Batch 2 — SMS T2 + O4 VERIFICATION
 * (PHASE-1-BATCH-2.md §7 named verification script #3).
 *
 * WHAT IT VERIFIES
 * ----------------
 * T2 is the Twilio webhook SMS write (`webhooks/twilio/route.ts:~275`).
 * O4 is the OpenPhone cron SMS write (`ingestion/openphone.ts:~994`).
 * Both insert `interactions` with `type='sms'`. The cascade equivalent
 * is a `touchpoints` row with `channel='sms'` OR a `fragments` row
 * (identity-poor cold SMS → fragment per `route-by-tier.ts`).
 *
 * For each recent `type='sms'` interaction, this script checks:
 *   - is there a `touchpoints` row with `channel='sms'` whose
 *     `external_id` matches a likely dedup key (Twilio MessageSid,
 *     OpenPhone openphone_message_id), OR
 *   - is there a `fragments` row with `channel='sms'` likewise?
 *
 * Coverage is reported per-direction (inbound vs outbound) because the
 * progression-event surface and the silent-drop classes differ:
 *   - inbound  → `sms_inbound` → couple_progression_event 'inbound_sms'
 *   - outbound → `sms_outbound` → no progression (per progression.ts)
 *
 * READ-ONLY. SELECTs only.
 *
 * JOIN MODEL
 * ----------
 * The signal builder `sms-to-signal.ts:152` sets
 *   `external_id = messageSid`
 * where messageSid is Twilio's `MessageSid` or OpenPhone's
 * `openphone_message_id`. The legacy `interactions` row stores the SAME
 * id in different fields per channel — Twilio sets it on
 * `interactions.gmail_message_id` (legacy column reused as the SMS
 * provider id, verified at webhooks/twilio/route.ts) OR carries it in
 * `extracted_identity`. We try multiple join strategies and report
 * which one worked.
 *
 * Time-proximity join as fallback (±5 minutes — SMS lands fast).
 *
 * RUN
 * ---
 *   BRANCH_URL=https://<ref>.supabase.co \
 *   BRANCH_KEY=<service_role_key> \
 *   npx tsx scripts/verify-sms-binding.ts [--venue=<uuid>] [--days=<N>]
 *
 * EXIT CODES
 * ----------
 *   0 PASS — touchpoint-OR-fragment coverage >= 95% for inbound SMS
 *            (outbound is informational only).
 *   1 FAIL — coverage < 80% inbound.
 *   2 WARN — between gates.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const PAGE = 1000
const TIME_TOLERANCE_MS = 5 * 60 * 1000

interface InteractionRow {
  id: string
  venue_id: string
  type: string | null
  direction: string | null
  gmail_message_id: string | null
  timestamp: string | null
  created_at: string | null
}

interface TouchpointRow {
  id: string
  venue_id: string
  channel: string
  action_type: string
  external_id: string
  occurred_at: string
}

interface FragmentRow {
  id: string
  venue_id: string
  channel: string
  external_id: string
  occurred_at: string
}

function parseArgs(): { venue: string; days: number } {
  let venue = RIXEY_VENUE_ID
  let days = Number(process.env.SMS_WINDOW_DAYS ?? '60')
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
        'npx tsx scripts/verify-sms-binding.ts',
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
  console.log('SMS VERIFICATION — T2 (Twilio) + O4 (OpenPhone) cohort coverage')
  console.log('='.repeat(78))
  console.log(`Target DB   : ${url}`)
  console.log(`Venue       : ${venue}`)
  console.log(`Data window : ${sinceIso ? `last ${days} days (since ${sinceIso})` : 'ALL TIME'}`)
  console.log('')

  // ---------------------------------------------------------------------------
  // 1. Pull SMS interactions.
  // ---------------------------------------------------------------------------
  const interactions = await fetchAll<InteractionRow>('interactions(sms)', (from, to) => {
    let q = supabase
      .from('interactions')
      .select('id, venue_id, type, direction, gmail_message_id, timestamp, created_at')
      .eq('venue_id', venue)
      .eq('type', 'sms')
      .order('timestamp', { ascending: true })
      .range(from, to)
    if (sinceIso) q = q.gte('created_at', sinceIso)
    return q
  })

  const inbound = interactions.filter((i) => i.direction === 'inbound')
  const outbound = interactions.filter((i) => i.direction === 'outbound')

  console.log(`[1] type='sms' interactions in window         : ${interactions.length}`)
  console.log(`    inbound  : ${inbound.length}`)
  console.log(`    outbound : ${outbound.length}`)
  console.log('')

  if (interactions.length === 0) {
    console.log('No SMS interactions in window. Nothing to verify.')
    console.log('Per PHASE-1-BATCH-2.md §7: "If N=0, script run is logged and gate is')
    console.log("'verification deferred — re-run after 14 days live traffic.'\"")
    process.exit(0)
  }

  // ---------------------------------------------------------------------------
  // 2. Pull SMS touchpoints + fragments.
  // ---------------------------------------------------------------------------
  const touchpoints = await fetchAll<TouchpointRow>('touchpoints(sms)', (from, to) => {
    let q = supabase
      .from('touchpoints')
      .select('id, venue_id, channel, action_type, external_id, occurred_at')
      .eq('venue_id', venue)
      .eq('channel', 'sms')
      .order('occurred_at', { ascending: true })
      .range(from, to)
    if (widenedSinceIso) q = q.gte('occurred_at', widenedSinceIso)
    return q
  })

  const fragments = await fetchAll<FragmentRow>('fragments(sms)', (from, to) => {
    let q = supabase
      .from('fragments')
      .select('id, venue_id, channel, external_id, occurred_at')
      .eq('venue_id', venue)
      .eq('channel', 'sms')
      .order('occurred_at', { ascending: true })
      .range(from, to)
    if (widenedSinceIso) q = q.gte('occurred_at', widenedSinceIso)
    return q
  })

  console.log(`[2] channel='sms' touchpoints (widened)       : ${touchpoints.length}`)
  console.log(`[2] channel='sms' fragments  (widened)        : ${fragments.length}`)

  const tpByAction = new Map<string, number>()
  for (const tp of touchpoints) {
    tpByAction.set(tp.action_type, (tpByAction.get(tp.action_type) ?? 0) + 1)
  }
  console.log('    touchpoint action_type breakdown:')
  for (const [a, c] of [...tpByAction.entries()].sort()) {
    console.log(`      ${a.padEnd(24)} : ${c}`)
  }
  console.log('')

  // ---------------------------------------------------------------------------
  // 3. Build coverage indices.
  // ---------------------------------------------------------------------------
  const tpByExtId = new Map<string, TouchpointRow>()
  for (const tp of touchpoints) {
    if (tp.external_id) tpByExtId.set(tp.external_id, tp)
  }
  const frByExtId = new Map<string, FragmentRow>()
  for (const fr of fragments) {
    if (fr.external_id) frByExtId.set(fr.external_id, fr)
  }

  // Time-sorted arrays for proximity fallback.
  const tpByTime = [...touchpoints]
    .filter((t) => t.occurred_at)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
  const frByTime = [...fragments]
    .filter((f) => f.occurred_at)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))

  function nearestTime<T extends { occurred_at: string }>(arr: T[], targetMs: number): T | null {
    let best: T | null = null
    let bestDelta = Number.POSITIVE_INFINITY
    for (const item of arr) {
      const t = new Date(item.occurred_at).getTime()
      if (!Number.isFinite(t)) continue
      const delta = Math.abs(t - targetMs)
      if (delta > TIME_TOLERANCE_MS) continue
      if (delta < bestDelta) {
        bestDelta = delta
        best = item
      }
    }
    return best
  }

  // ---------------------------------------------------------------------------
  // 4. Per-interaction classification.
  // ---------------------------------------------------------------------------
  function classify(it: InteractionRow): {
    coveredByExtId: 'tp' | 'fragment' | null
    coveredByTime: 'tp' | 'fragment' | null
    covered: boolean
  } {
    let coveredByExtId: 'tp' | 'fragment' | null = null
    if (it.gmail_message_id) {
      if (tpByExtId.has(it.gmail_message_id)) coveredByExtId = 'tp'
      else if (frByExtId.has(it.gmail_message_id)) coveredByExtId = 'fragment'
    }
    // Also try the interaction id itself as external_id (fallback some
    // adapters use — same convention as email-to-signal's fallback).
    if (!coveredByExtId) {
      if (tpByExtId.has(it.id)) coveredByExtId = 'tp'
      else if (frByExtId.has(it.id)) coveredByExtId = 'fragment'
    }

    let coveredByTime: 'tp' | 'fragment' | null = null
    if (!coveredByExtId && it.timestamp) {
      const targetMs = new Date(it.timestamp).getTime()
      if (Number.isFinite(targetMs)) {
        if (nearestTime(tpByTime, targetMs)) coveredByTime = 'tp'
        else if (nearestTime(frByTime, targetMs)) coveredByTime = 'fragment'
      }
    }

    return {
      coveredByExtId,
      coveredByTime,
      covered: coveredByExtId !== null || coveredByTime !== null,
    }
  }

  type DirCohort = { total: number; covered: number; coveredByExtId: number; coveredByTime: number; tpCount: number; fragmentCount: number }
  function emptyCohort(): DirCohort {
    return { total: 0, covered: 0, coveredByExtId: 0, coveredByTime: 0, tpCount: 0, fragmentCount: 0 }
  }
  const cohorts = new Map<string, DirCohort>()
  cohorts.set('inbound', emptyCohort())
  cohorts.set('outbound', emptyCohort())
  const samplesMissed: Array<{ id: string; direction: string }> = []

  for (const it of interactions) {
    const dirKey = it.direction === 'inbound' ? 'inbound' : it.direction === 'outbound' ? 'outbound' : 'unknown'
    if (!cohorts.has(dirKey)) cohorts.set(dirKey, emptyCohort())
    const cohort = cohorts.get(dirKey)!
    cohort.total++
    const r = classify(it)
    if (r.covered) {
      cohort.covered++
      const which = r.coveredByExtId ?? r.coveredByTime
      if (r.coveredByExtId) cohort.coveredByExtId++
      else if (r.coveredByTime) cohort.coveredByTime++
      if (which === 'tp') cohort.tpCount++
      else if (which === 'fragment') cohort.fragmentCount++
    } else if (samplesMissed.length < 12) {
      samplesMissed.push({ id: it.id, direction: dirKey })
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Report.
  // ---------------------------------------------------------------------------
  console.log('-'.repeat(78))
  console.log('COVERAGE BY DIRECTION — interactions with a sms touchpoint OR fragment')
  console.log('-'.repeat(78))
  for (const [dir, c] of cohorts) {
    if (c.total === 0) continue
    console.log(`  ${dir}:`)
    console.log(`    total                 : ${c.total}`)
    console.log(`    covered               : ${c.covered} (${pct(c.covered, c.total)})`)
    console.log(`      via external_id     : ${c.coveredByExtId}`)
    console.log(`      via time-proximity  : ${c.coveredByTime}`)
    console.log(`      → touchpoint        : ${c.tpCount}`)
    console.log(`      → fragment          : ${c.fragmentCount}`)
    console.log('')
  }
  if (samplesMissed.length) {
    console.log('SAMPLE — SMS interactions with NO touchpoint or fragment:')
    samplesMissed.forEach((s) => console.log(`  interaction ${s.id} (${s.direction})`))
    console.log('')
  }

  // ---------------------------------------------------------------------------
  // 6. Verdict.
  // ---------------------------------------------------------------------------
  const inboundCohort = cohorts.get('inbound')!
  const inboundCoverage = inboundCohort.total > 0 ? inboundCohort.covered / inboundCohort.total : null

  const PASS_GATE = 0.95
  const WARN_GATE = 0.80

  let exitCode = 0
  console.log('='.repeat(78))
  console.log('SMS VERDICT')
  console.log('='.repeat(78))
  if (inboundCoverage === null) {
    console.log('  INBOUND COVERAGE: n/a (no inbound SMS in window).')
    console.log('  Per §7: deferred — re-run after 14 days live traffic.')
  } else if (inboundCoverage >= PASS_GATE) {
    console.log(`  INBOUND COVERAGE: PASS (${pct(inboundCohort.covered, inboundCohort.total)}).`)
    console.log('  T2 / O4 cascade routing is healthy for inbound SMS.')
  } else if (inboundCoverage >= WARN_GATE) {
    console.log(`  INBOUND COVERAGE: WARN (${pct(inboundCohort.covered, inboundCohort.total)}; gate is ${PASS_GATE * 100}%).`)
    console.log('  Some inbound SMS have no spine signal — review samples above.')
    exitCode = 2
  } else {
    console.log(`  INBOUND COVERAGE: FAIL (${pct(inboundCohort.covered, inboundCohort.total)}; gate is ${WARN_GATE * 100}%).`)
    console.log('  T2 / O4 flips not landing — inbound SMS invisible to the spine.')
    exitCode = 1
  }
  console.log('='.repeat(78))

  process.exit(exitCode)
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
