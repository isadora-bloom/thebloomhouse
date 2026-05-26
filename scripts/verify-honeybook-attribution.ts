/**
 * scripts/verify-honeybook-attribution.ts
 * ========================================
 * Phase 1 Batch 2 — HONEYBOOK H3 VERIFICATION
 * (PHASE-1-BATCH-2.md §7 named verification script #2).
 *
 * WHAT IT VERIFIES
 * ----------------
 * H3 is the HoneyBook CSV batch interactions writer at
 * `crm-import/index.ts:~1031`. Per H3 spec the CSV adapter emits four
 * action_types:
 *   - `crm_imported_inquiry`
 *   - `crm_imported_booked`
 *   - `crm_imported_lost`
 *   - `crm_attribution`   ← the SYNTHETIC PROVENANCE row carrying
 *                            `extracted_identity.hear_source`.
 *
 * The provenance row lands in legacy `interactions` with
 * `surface='crm_attribution'` (migration 294); the cascade equivalent is
 * a `touchpoints` row with `channel='honeybook'` AND
 * `action_type='crm_attribution'`.
 *
 * The H3 flip's coverage gate: every `surface='crm_attribution'`
 * interaction should have a corresponding `honeybook` touchpoint with
 * the matching `crm_attribution` action_type.
 *
 * The script also surfaces total per-action_type counts for the four CSV
 * verbs so the operator can see "are the row imports landing at all,
 * even if the synthetic provenance fanout is broken?"
 *
 * READ-ONLY. SELECTs only.
 *
 * JOIN MODEL — HONEST CAVEAT
 * --------------------------
 * HoneyBook's CSV adapter constructs each row's NormalizedSignal with
 * an external_id of the form
 *   `honeybook:project:<projectId>:<actionType>`
 *   OR  `honeybook:provenance:<slug>:<dateIso>:<actionType>`
 * (see `honeybook-csv-to-signal.ts:~200-215`). The corresponding legacy
 * `interactions` row has NO matching `external_id` column to join on —
 * the join is by timing + venue + the existence of a same-window CSV
 * import row in `crm_import_rows`. The cleanest available join is
 * timestamp + a same-day proximity match within the venue, which is
 * what this script does.
 *
 * RUN
 * ---
 *   BRANCH_URL=https://<ref>.supabase.co \
 *   BRANCH_KEY=<service_role_key> \
 *   npx tsx scripts/verify-honeybook-attribution.ts [--venue=<uuid>] [--days=<N>]
 *
 * EXIT CODES
 * ----------
 *   0 PASS — synthetic-provenance coverage >= 90% (full window).
 *   1 FAIL — coverage < 70%.
 *   2 WARN — between gates.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const PAGE = 1000

interface InteractionRow {
  id: string
  venue_id: string
  surface: string | null
  type: string | null
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

function parseArgs(): { venue: string; days: number } {
  let venue = RIXEY_VENUE_ID
  let days = Number(process.env.HONEYBOOK_WINDOW_DAYS ?? '180')
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--venue=')) venue = arg.slice('--venue='.length)
    else if (arg.startsWith('--days=')) days = Number(arg.slice('--days='.length))
  }
  if (!Number.isFinite(days) || days < 0) days = 180
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
        'npx tsx scripts/verify-honeybook-attribution.ts',
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
  console.log('HONEYBOOK H3 VERIFICATION — synthetic-provenance + per-action_type cohort')
  console.log('='.repeat(78))
  console.log(`Target DB   : ${url}`)
  console.log(`Venue       : ${venue}`)
  console.log(`Data window : ${sinceIso ? `last ${days} days (since ${sinceIso})` : 'ALL TIME'}`)
  console.log('')

  // ---------------------------------------------------------------------------
  // 1. Pull surface='crm_attribution' interactions — the synthetic
  //    provenance rows H3 emits per CSV row.
  // ---------------------------------------------------------------------------
  const provenanceInteractions = await fetchAll<InteractionRow>(
    'interactions(crm_attribution)',
    (from, to) => {
      let q = supabase
        .from('interactions')
        .select('id, venue_id, surface, type, timestamp, created_at')
        .eq('venue_id', venue)
        .eq('surface', 'crm_attribution')
        .order('timestamp', { ascending: true })
        .range(from, to)
      if (sinceIso) q = q.gte('created_at', sinceIso)
      return q
    },
  )
  console.log(`[1] surface='crm_attribution' interactions    : ${provenanceInteractions.length}`)

  // ---------------------------------------------------------------------------
  // 2. Pull HoneyBook touchpoints (the cascade side).
  // ---------------------------------------------------------------------------
  const honeybookTouchpoints = await fetchAll<TouchpointRow>(
    'touchpoints(honeybook)',
    (from, to) => {
      let q = supabase
        .from('touchpoints')
        .select('id, venue_id, channel, action_type, external_id, occurred_at')
        .eq('venue_id', venue)
        .eq('channel', 'honeybook')
        .order('occurred_at', { ascending: true })
        .range(from, to)
      if (widenedSinceIso) q = q.gte('occurred_at', widenedSinceIso)
      return q
    },
  )
  console.log(`[2] channel='honeybook' touchpoints (widened) : ${honeybookTouchpoints.length}`)

  const tpByAction = new Map<string, TouchpointRow[]>()
  for (const tp of honeybookTouchpoints) {
    const arr = tpByAction.get(tp.action_type) ?? []
    arr.push(tp)
    tpByAction.set(tp.action_type, arr)
  }
  console.log('    per-action_type breakdown:')
  for (const action of [
    'crm_imported_inquiry',
    'crm_imported_booked',
    'crm_imported_lost',
    'crm_attribution',
  ]) {
    const arr = tpByAction.get(action) ?? []
    console.log(`      ${action.padEnd(24)} : ${arr.length}`)
  }
  for (const [action, arr] of [...tpByAction.entries()].sort()) {
    if (
      ![
        'crm_imported_inquiry',
        'crm_imported_booked',
        'crm_imported_lost',
        'crm_attribution',
      ].includes(action)
    ) {
      console.log(`      ${action.padEnd(24)} : ${arr.length}  [unexpected — investigate]`)
    }
  }
  console.log('')

  // ---------------------------------------------------------------------------
  // 3. Provenance coverage — does every surface='crm_attribution'
  //    interaction have a same-day honeybook/crm_attribution touchpoint?
  //    Join by same-day proximity (CSV imports are batch-stamped at the
  //    import moment; touchpoints get occurred_at from the CSV inquiry
  //    date, which differs from the interaction created_at).
  //
  //    The honest constraint: we can't do exact-row matching without a
  //    shared external id, so the gate is COUNT-RATIO (per-venue-per-day).
  // ---------------------------------------------------------------------------
  const attributionTps = tpByAction.get('crm_attribution') ?? []

  const dayOf = (iso: string | null) => (iso ? iso.slice(0, 10) : 'unknown')

  const intByDay = new Map<string, number>()
  for (const it of provenanceInteractions) {
    const k = dayOf(it.created_at)
    intByDay.set(k, (intByDay.get(k) ?? 0) + 1)
  }
  const tpByDay = new Map<string, number>()
  for (const tp of attributionTps) {
    const k = dayOf(tp.occurred_at)
    tpByDay.set(k, (tpByDay.get(k) ?? 0) + 1)
  }

  // Per-day coverage = min(tpByDay[k], intByDay[k]) / intByDay[k].
  let totalInteractions = 0
  let totalCovered = 0
  const perDayRows: Array<{ day: string; interactions: number; touchpoints: number; covered: number }> = []
  const dayKeys = new Set<string>([...intByDay.keys(), ...tpByDay.keys()])
  for (const k of [...dayKeys].sort()) {
    const iCount = intByDay.get(k) ?? 0
    const tCount = tpByDay.get(k) ?? 0
    const c = Math.min(iCount, tCount)
    totalInteractions += iCount
    totalCovered += c
    perDayRows.push({ day: k, interactions: iCount, touchpoints: tCount, covered: c })
  }

  console.log('-'.repeat(78))
  console.log('SYNTHETIC-PROVENANCE COVERAGE — per-day count parity')
  console.log('-'.repeat(78))
  console.log(`  total crm_attribution interactions      : ${totalInteractions}`)
  console.log(`  total crm_attribution touchpoints       : ${attributionTps.length}`)
  console.log(`  per-day count-ratio coverage            : ${pct(totalCovered, totalInteractions)}`)
  console.log('')
  if (perDayRows.length && perDayRows.length <= 30) {
    console.log('  per-day breakdown:')
    for (const r of perDayRows) {
      console.log(
        `    ${r.day}  interactions=${String(r.interactions).padStart(4)}  ` +
          `touchpoints=${String(r.touchpoints).padStart(4)}  ` +
          `covered=${String(r.covered).padStart(4)} (${pct(r.covered, Math.max(r.interactions, 1))})`,
      )
    }
    console.log('')
  } else if (perDayRows.length > 30) {
    console.log('  (per-day breakdown suppressed — > 30 days; widen --days to see all)')
    console.log('')
  }

  // ---------------------------------------------------------------------------
  // 4. Verdict.
  // ---------------------------------------------------------------------------
  const PASS_GATE = 0.90
  const WARN_GATE = 0.70

  const coverage = totalInteractions === 0 ? null : totalCovered / totalInteractions
  let exitCode = 0
  console.log('='.repeat(78))
  console.log('HONEYBOOK H3 VERDICT')
  console.log('='.repeat(78))
  if (coverage === null) {
    console.log('  PROVENANCE COVERAGE: n/a (no crm_attribution interactions in window).')
    console.log('  This is expected pre-Phase-2-reimport. Re-run after the first HoneyBook')
    console.log('  CSV import lands.')
  } else if (coverage >= PASS_GATE) {
    console.log(`  PROVENANCE COVERAGE: PASS (${pct(totalCovered, totalInteractions)}).`)
    console.log('  H3 synthetic-provenance signal is reaching the spine.')
  } else if (coverage >= WARN_GATE) {
    console.log(`  PROVENANCE COVERAGE: WARN (${pct(totalCovered, totalInteractions)}; gate is ${PASS_GATE * 100}%).`)
    console.log('  Some crm_attribution interactions have no matching touchpoint that day.')
    console.log('  Likely cause: H3 partial flip (some CSV rows route through linkSignalBatch,')
    console.log('  others still through the legacy interactions-only path).')
    exitCode = 2
  } else {
    console.log(`  PROVENANCE COVERAGE: FAIL (${pct(totalCovered, totalInteractions)}; gate is ${WARN_GATE * 100}%).`)
    console.log('  H3 is not wired — the synthetic provenance row is invisible to the spine.')
    console.log('  Discovery-source attribution (hear_source) is lost downstream.')
    exitCode = 1
  }
  console.log('='.repeat(78))

  process.exit(exitCode)
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
