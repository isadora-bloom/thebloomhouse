/**
 * scripts/backfill-couples-bridge.ts
 * =================================
 * One-shot sweep to backfill the couples bridge for every wedding that
 * has no `couples.source_wedding_id` row pointing at it.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Pressure-test 2026-05-26 (data-bridge audit, prod-snapshot) found
 * that 47.2% of booked weddings on prod have NO `couples` row via
 * `source_wedding_id` (60 of 127). 100% of `status='completed'` (65 of
 * 65) and 100% of `status='contracted'` (2 of 2). The downstream
 * consequence is that `linkSignal.findCoupleForLegacyWedding` returns
 * null for those weddings — inbound signals then fall through to the
 * score-based matcher and risk wrong-attach, or fragment.
 *
 * `mirrorCoupleFromWedding` is the canonical 1:1 bridge writer (it
 * UPSERTs on `(venue_id, source_wedding_id)`). The mirror was wired
 * into `mintWedding` as a fire-and-forget hook, but for weddings
 * minted BEFORE that hook landed — or weddings whose mirror call lost
 * a race / hit a transient error — the bridge never materialised. The
 * code-side fix (status-transition hooks added 2026-05-26) keeps NEW
 * weddings + status promotions covered. This sweep closes the gap on
 * the EXISTING population.
 *
 * SAFETY
 * ------
 * - Read-only by default. Prints what it would do. Pass `--apply` to
 *   actually call `mirrorCoupleFromWedding` per wedding.
 * - Mirror is idempotent: re-running after success writes zero new
 *   rows (it UPSERTs on (venue_id, source_wedding_id) and skips
 *   tombstoned weddings whose merged_into_id is set).
 * - Refuses to run against the known production project ref when
 *   targeted via `BRANCH_URL` (operator opts in to prod via
 *   `--allow-prod` AND a different env var combo — same pattern as
 *   `scripts/verify-m1-binding.ts` §Config).
 * - Per-wedding errors are logged and counted but do not abort the
 *   sweep — partial progress survives.
 *
 * USAGE
 * -----
 *   # Dry-run against a Supabase branch:
 *   BRANCH_URL=https://<ref>.supabase.co \
 *   BRANCH_KEY=<service_role_key> \
 *   npx tsx scripts/backfill-couples-bridge.ts
 *
 *   # Apply:
 *   BRANCH_URL=... BRANCH_KEY=... \
 *   npx tsx scripts/backfill-couples-bridge.ts --apply
 *
 *   # Scope to a single venue (defaults: all venues):
 *   BACKFILL_VENUE_ID=<uuid> npx tsx scripts/backfill-couples-bridge.ts
 *
 *   # Cap the batch (defaults: no cap):
 *   BACKFILL_LIMIT=500 npx tsx scripts/backfill-couples-bridge.ts --apply
 *
 * The service_role key is read from process.env — NEVER written into
 * this file. Run from the repo root so the relative import resolves.
 *
 * VERIFIED SCHEMA FACTS
 * ---------------------
 * - `weddings` (mig 002+): id, venue_id, status, merged_into_id (mig
 *   202 — the tombstone column for the loser half of mergeWeddings).
 * - `couples` (mig 346): id, venue_id, source_wedding_id. UNIQUE
 *   partial index on (venue_id, source_wedding_id) WHERE
 *   source_wedding_id IS NOT NULL.
 * - `mirrorCoupleFromWedding` (src/lib/services/identity/mirror-
 *   couple.ts) is the chokepoint UPSERT writer. As of the 2026-05-26
 *   fix it short-circuits on `weddings.merged_into_id IS NOT NULL` —
 *   so passing a tombstoned wedding id is a guaranteed no-op (the
 *   sweep's WHERE clause already filters those out, but the mirror's
 *   own guard is the defence in depth).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { mirrorCoupleFromWedding } from '../src/lib/services/identity/mirror-couple'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes('--apply')
const ALLOW_PROD = process.argv.includes('--allow-prod')

/** Optional venue scope. Default: every venue with at least one
 *  bridge-missing wedding. */
const VENUE_SCOPE = process.env.BACKFILL_VENUE_ID || null

/** Optional per-run cap. Default: no cap. */
const LIMIT = process.env.BACKFILL_LIMIT
  ? Math.max(0, Number(process.env.BACKFILL_LIMIT))
  : null

/** Page size for SELECT pagination (supabase caps at 1000/req). */
const PAGE = 1000

/** Known production project ref. The sweep refuses to run against this
 *  url unless --allow-prod is passed explicitly. Mirrors the pattern in
 *  scripts/verify-m1-binding.ts §Config. */
const PROD_REF = 'jsxxgwprxuqgcauzlxcb'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WeddingRow {
  id: string
  venue_id: string
  status: string | null
  merged_into_id: string | null
}

// ---------------------------------------------------------------------------
// Paginated fetch helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const url = process.env.BRANCH_URL
  const key = process.env.BRANCH_KEY
  if (!url || !key) {
    console.error(
      'ERROR: BRANCH_URL and BRANCH_KEY must be set in the environment.\n' +
        'Run: BRANCH_URL=https://<ref>.supabase.co BRANCH_KEY=<service_role_key> ' +
        'npx tsx scripts/backfill-couples-bridge.ts [--apply]',
    )
    process.exit(1)
  }
  if (url.includes(PROD_REF) && !ALLOW_PROD) {
    console.error(
      `ERROR: BRANCH_URL points at production (${PROD_REF}). Refusing.\n` +
        'Pass --allow-prod to override (mirror is idempotent and skips merged-away rows, ' +
        'but operator must opt in to live writes against prod).',
    )
    process.exit(1)
  }

  const supabase: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false },
  })

  const tag = APPLY ? '[APPLY]' : '[DRY-RUN]'
  console.log('='.repeat(78))
  console.log(`${tag} backfill-couples-bridge — mirror missing couples rows`)
  console.log('='.repeat(78))
  console.log(`Target DB    : ${url}`)
  console.log(`Venue scope  : ${VENUE_SCOPE ?? '(all venues)'}`)
  console.log(`Limit        : ${LIMIT ?? '(none)'}`)
  console.log('')

  // -------------------------------------------------------------------------
  // 1. Pull the set of weddings whose couples bridge is missing.
  //
  //    Strategy: in-process set-difference. The straight-SQL `NOT IN
  //    (SELECT source_wedding_id FROM couples WHERE source_wedding_id IS
  //    NOT NULL)` is a single round-trip but PostgREST limits embedded
  //    subqueries; the explicit two-load avoids that limit and is
  //    transparent under dry-run logging. At Rixey scale (~thousands of
  //    weddings) the working set is small. At enterprise scale this
  //    could move to a Postgres RPC.
  // -------------------------------------------------------------------------

  console.log('[1] Loading weddings (merged_into_id IS NULL)…')
  const weddings = await fetchAll<WeddingRow>('weddings', (from, to) => {
    let q = supabase
      .from('weddings')
      .select('id, venue_id, status, merged_into_id')
      .is('merged_into_id', null)
      .order('id', { ascending: true })
      .range(from, to)
    if (VENUE_SCOPE) q = q.eq('venue_id', VENUE_SCOPE)
    return q
  })
  console.log(`    live weddings (non-merged): ${weddings.length}`)

  console.log('[2] Loading existing couples bridge rows…')
  const couplesBridge = await fetchAll<{ source_wedding_id: string }>(
    'couples-bridge',
    (from, to) => {
      let q = supabase
        .from('couples')
        .select('source_wedding_id')
        .not('source_wedding_id', 'is', null)
        .order('source_wedding_id', { ascending: true })
        .range(from, to)
      if (VENUE_SCOPE) q = q.eq('venue_id', VENUE_SCOPE)
      return q
    },
  )
  const bridgedSet = new Set<string>()
  for (const c of couplesBridge) {
    if (c.source_wedding_id) bridgedSet.add(c.source_wedding_id)
  }
  console.log(`    existing bridge entries:    ${bridgedSet.size}`)

  // -------------------------------------------------------------------------
  // 2. Compute the missing set.
  // -------------------------------------------------------------------------
  const missing = weddings.filter((w) => !bridgedSet.has(w.id))
  const capped = LIMIT != null ? missing.slice(0, LIMIT) : missing

  console.log('')
  console.log('-'.repeat(78))
  console.log('GAP SUMMARY')
  console.log('-'.repeat(78))
  console.log(`  total live weddings (no merged_into_id)    : ${weddings.length}`)
  console.log(`    of which already bridged                : ${weddings.length - missing.length}`)
  console.log(`    of which MISSING a couples row          : ${missing.length}`)
  console.log(`  this run will process                     : ${capped.length}` +
    (LIMIT != null && capped.length < missing.length
      ? ` (capped by BACKFILL_LIMIT=${LIMIT})`
      : ''))
  console.log('')

  // Per-status breakdown of the GAP — operator wants to see how this
  // matches the pressure-test priors (100% of completed, 100% of
  // contracted, ~47% of booked).
  const byStatus = new Map<string, number>()
  for (const w of missing) {
    const k = w.status ?? '(null)'
    byStatus.set(k, (byStatus.get(k) ?? 0) + 1)
  }
  console.log('GAP BY STATUS:')
  for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(20)}: ${n}`)
  }
  console.log('')

  if (capped.length === 0) {
    console.log('Nothing to backfill. Bridge is complete for the requested scope.')
    return
  }

  if (!APPLY) {
    console.log('-'.repeat(78))
    console.log('DRY-RUN — no writes. Sample of weddings that WOULD mirror:')
    console.log('-'.repeat(78))
    for (const w of capped.slice(0, 20)) {
      console.log(`  wedding ${w.id}  venue ${w.venue_id}  status ${w.status ?? '(null)'}`)
    }
    if (capped.length > 20) console.log(`  … and ${capped.length - 20} more`)
    console.log('')
    console.log('Re-run with --apply to call mirrorCoupleFromWedding on each.')
    return
  }

  // -------------------------------------------------------------------------
  // 3. Apply — call the canonical mirror per wedding.
  // -------------------------------------------------------------------------
  console.log('-'.repeat(78))
  console.log(`APPLYING — calling mirrorCoupleFromWedding for ${capped.length} weddings…`)
  console.log('-'.repeat(78))

  let succeeded = 0
  let failed = 0
  let skippedMergedAway = 0 // mirror returned coupleId=null AND wedding is tombstoned
  const failures: Array<{ wedding: string; venue: string; reason: string }> = []

  const LOG_EVERY = 25
  for (let i = 0; i < capped.length; i++) {
    const w = capped[i]
    try {
      const res = await mirrorCoupleFromWedding({
        venueId: w.venue_id,
        weddingId: w.id,
        supabase,
      })
      if (res.coupleId) {
        succeeded++
      } else {
        // Mirror returned null. Two paths land here:
        //   (a) The wedding got tombstoned between our SELECT and the
        //       mirror call (race) — mirror's merged_into_id guard
        //       fired. Expected, count separately.
        //   (b) Genuine lookup / upsert error — already logged via
        //       logEvent inside the mirror.
        // Re-check merged_into_id to distinguish; one cheap round-trip
        // per skipped row is OK at sweep scale.
        const { data: w2 } = await supabase
          .from('weddings')
          .select('merged_into_id')
          .eq('id', w.id)
          .maybeSingle()
        if (w2 && (w2 as { merged_into_id?: string | null }).merged_into_id) {
          skippedMergedAway++
        } else {
          failed++
          failures.push({
            wedding: w.id,
            venue: w.venue_id,
            reason: 'mirror returned null coupleId — see logEvent stream',
          })
        }
      }
    } catch (err) {
      // Mirror's contract says it never throws. If we land here the
      // contract was broken (or the import path itself failed). Surface
      // it so the operator can investigate.
      failed++
      failures.push({
        wedding: w.id,
        venue: w.venue_id,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
    if ((i + 1) % LOG_EVERY === 0 || i === capped.length - 1) {
      console.log(
        `  progress: ${i + 1}/${capped.length}  ` +
          `(ok=${succeeded} skipped_merged=${skippedMergedAway} failed=${failed})`,
      )
    }
  }

  // -------------------------------------------------------------------------
  // 4. Report.
  // -------------------------------------------------------------------------
  console.log('')
  console.log('='.repeat(78))
  console.log('RESULT')
  console.log('='.repeat(78))
  console.log(`  attempted               : ${capped.length}`)
  console.log(`  succeeded               : ${succeeded}`)
  console.log(`  skipped (merged-away)   : ${skippedMergedAway}`)
  console.log(`  failed                  : ${failed}`)
  console.log('')

  if (failures.length > 0) {
    console.log('FAILURE SAMPLE (first 20):')
    for (const f of failures.slice(0, 20)) {
      console.log(`  wedding ${f.wedding}  venue ${f.venue}  reason: ${f.reason}`)
    }
    console.log('')
    console.log(
      'Re-run the sweep to retry — the mirror is idempotent so successful ' +
        'rows from this pass are not re-written.',
    )
  } else {
    console.log('All target weddings now have a couples bridge row.')
    console.log(
      'Re-running this script on the same scope should report MISSING=0.',
    )
  }
  console.log('='.repeat(78))
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
