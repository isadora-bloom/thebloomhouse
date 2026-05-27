/**
 * scripts/sync-couple-lifecycle-from-weddings.ts
 * =============================================
 * Repair sweep that propagates `weddings.status` into
 * `couples.lifecycle_state` for every couple bridged via
 * `couples.source_wedding_id`.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The 2026-05-26 bridge backfill (`backfill-couples-bridge.ts`)
 * repairs the FK linkage when `couples.source_wedding_id` is missing,
 * but it does NOT propagate `weddings.status -> couples.lifecycle_state`
 * after the link is in place. As a result the consolidation branch
 * shows 26 booked couples vs 86 on prod vs 66/67 derived — the spine
 * has drifted from the legacy event row even when the bridge is
 * intact.
 *
 * Doctrinally `couples.lifecycle_state` is the spine-side projection of
 * the weddings-side `status` for any couple with `source_wedding_id`.
 * This script is the convergence writer: read every bridged couple,
 * derive the correct lifecycle_state from `weddings.status` (+ the
 * post-wedding `booked -> completed` flip when wedding_date has passed,
 * per mig 365 doctrine), and UPDATE only the divergent rows.
 *
 * WHY THIS IS NOT A CASCADE-CHOKEPOINT VIOLATION
 * ----------------------------------------------
 * R1 (`CASCADE-CANONICAL-WRITER.md` §1) is a CREATION boundary, not a
 * commit boundary. Lifecycle / heat / metadata UPDATEs are explicitly
 * allowed outside the cascade. This script ONLY UPDATEs
 * `couples.lifecycle_state` — it never INSERTs / UPSERTs the couples,
 * touchpoints, fragments, or couple_merge_events tables. The CI guard
 * (`check-cascade-only-writer.mjs`) does not block UPDATEs and will
 * stay green.
 *
 * MAPPING (the doctrinal projection)
 * ----------------------------------
 * Sourced from:
 *   - migration 346 §10 backfill SQL (canonical first projection)
 *   - migration 365 (`completed` added as a positive-terminal state)
 *   - src/lib/services/identity/mirror-couple.ts (live mirror writer)
 *   - src/lib/services/identity/post-wedding-sweep.ts (booked -> completed
 *     when wedding_date < today)
 *   - src/lib/services/identity/lifecycle-audit.ts deriveExpectedState
 *     (the richest existing derivation — joins progression events)
 *
 * This script is the STATUS-ONLY subset of the audit derivation. It
 * intentionally does NOT join progression events — those are out of
 * scope for the bridge-divergence repair (the audit script handles
 * progression-derived states). The mapping:
 *
 *   weddings.status                                 -> couples.lifecycle_state
 *   --------------------------------------------------------------------
 *   'lost'                                          -> 'ghost'
 *   'cancelled'                                     -> 'ghost'
 *   'non_couple'                                    -> 'ghost'     (informal, see audit)
 *   'booked' + wedding_date < today                 -> 'completed' (mig 365 flip)
 *   'booked' + wedding_date >= today or NULL        -> 'booked'
 *   'completed'                                     -> 'completed' (mig 365)
 *   'inquiry'                                       -> 'resolved'
 *   'tour_scheduled'                                -> 'resolved'
 *   'tour_completed'                                -> 'resolved'
 *   'proposal_sent'                                 -> 'resolved'
 *   NULL                                            -> (skip; report)
 *   anything else                                   -> (skip; report)
 *
 * Couples with `lifecycle_state = 'agent'` are skipped entirely — agents
 * are administrative entities (planners / parents), not the spine
 * projection of a wedding (lifecycle-audit.ts:325 mirrors this).
 *
 * Couples whose wedding has `merged_into_id IS NOT NULL` (the loser
 * half of a merge) are skipped — the canonical wedding is the
 * `merged_into_id` target; mirroring the tombstoned half would write
 * lifecycle for a dead pointer. Mirrors `mirror-couple.ts:112`.
 *
 * SAFETY
 * ------
 * - Read-only by default. Prints what it would do. Pass `--apply` to
 *   actually UPDATE divergent rows.
 * - Refuses to run against the known production project ref unless
 *   `--allow-prod` is ALSO passed. Same pattern as
 *   `scripts/backfill-couples-bridge.ts` + `scripts/resolve-partner-dups.ts`.
 * - Idempotent: re-runs against converged data write zero rows.
 * - Per-row UPDATEs include a defensive `.eq('lifecycle_state',
 *   <previousCurrent>)` predicate so a concurrent writer (post-wedding
 *   sweep cron, mirror writer) racing the UPDATE wins; we don't clobber
 *   a transition that landed between our SELECT and our UPDATE.
 *
 * USAGE
 * -----
 *   # Dry-run against the consolidation Supabase branch:
 *   BRANCH_URL=https://ciwqxwohczzthvzqqgjx.supabase.co \
 *   BRANCH_KEY=<service_role_key> \
 *   npx tsx scripts/sync-couple-lifecycle-from-weddings.ts
 *
 *   # Apply on the consolidation branch:
 *   BRANCH_URL=... BRANCH_KEY=... \
 *   npx tsx scripts/sync-couple-lifecycle-from-weddings.ts --apply
 *
 *   # Apply on prod (operator opt-in):
 *   BRANCH_URL=https://jsxxgwprxuqgcauzlxcb.supabase.co \
 *   BRANCH_KEY=... \
 *   npx tsx scripts/sync-couple-lifecycle-from-weddings.ts --apply --allow-prod
 *
 *   # Scope to a single venue:
 *   SYNC_VENUE_ID=<uuid> npx tsx scripts/sync-couple-lifecycle-from-weddings.ts
 *
 *   # Cap (default: no cap):
 *   SYNC_LIMIT=500 npx tsx scripts/sync-couple-lifecycle-from-weddings.ts --apply
 *
 * The service_role key is read from process.env — NEVER written into
 * this file. Run from the repo root so relative paths resolve.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes('--apply')
const ALLOW_PROD = process.argv.includes('--allow-prod')

const VENUE_SCOPE = process.env.SYNC_VENUE_ID || null
const LIMIT = process.env.SYNC_LIMIT
  ? Math.max(0, Number(process.env.SYNC_LIMIT))
  : null

/** Page size for SELECT pagination (supabase caps at 1000/req). */
const PAGE = 1000

/** Chunk size for IN() lookups (PostgREST caps at 1000). */
const CHUNK = 500

/** Known production project ref. Refuse-by-default unless --allow-prod. */
const PROD_REF = 'jsxxgwprxuqgcauzlxcb'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LifecycleState =
  | 'channel_scoped'
  | 'resolved'
  | 'booked'
  | 'completed'
  | 'ghost'
  | 'agent'

interface CoupleRow {
  id: string
  venue_id: string
  lifecycle_state: string | null
  wedding_date: string | null
  source_wedding_id: string
  primary_contact_name: string | null
}

interface WeddingRow {
  id: string
  status: string | null
  wedding_date: string | null
  merged_into_id: string | null
}

interface DerivationResult {
  /** The doctrinally-correct lifecycle_state, or null if not derivable. */
  derived: LifecycleState | null
  /** One-line explanation for the operator log. */
  rationale: string
  /** When `derived` is null, the bucket the row landed in (operator
   *  review category — these are the divergence shapes that aren't a
   *  1:1 mapping). */
  category:
    | 'mapped'
    | 'skip_agent'
    | 'skip_wedding_merged_away'
    | 'skip_unknown_status'
    | 'skip_null_status'
}

// ---------------------------------------------------------------------------
// Derivation — the doctrinal projection
// ---------------------------------------------------------------------------

/** ISO-date string for today (UTC). wedding_date is a DATE column. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function deriveLifecycleFromStatus(
  couple: CoupleRow,
  wedding: WeddingRow | undefined,
): DerivationResult {
  if (couple.lifecycle_state === 'agent') {
    return {
      derived: null,
      rationale: 'couple is administrative (agent); skipped',
      category: 'skip_agent',
    }
  }

  if (!wedding) {
    return {
      derived: null,
      rationale: `couples.source_wedding_id ${couple.source_wedding_id} not found in weddings`,
      category: 'skip_unknown_status',
    }
  }

  if (wedding.merged_into_id) {
    return {
      derived: null,
      rationale: `wedding tombstoned (merged_into_id=${wedding.merged_into_id}); canonical is the target`,
      category: 'skip_wedding_merged_away',
    }
  }

  const status = wedding.status?.toLowerCase() ?? null

  if (!status) {
    return {
      derived: null,
      rationale: 'weddings.status is NULL; no projection',
      category: 'skip_null_status',
    }
  }

  // Terminal-negative: lost / cancelled / non_couple -> ghost.
  if (status === 'lost' || status === 'cancelled' || status === 'non_couple') {
    return {
      derived: 'ghost',
      rationale: `weddings.status = '${status}'`,
      category: 'mapped',
    }
  }

  // Terminal-positive (booked). Apply the mig-365 post-wedding flip:
  // a 'booked' wedding whose wedding_date has already passed becomes
  // 'completed'. Mirrors post-wedding-sweep.ts + lifecycle-audit.ts.
  if (status === 'booked') {
    const today = todayIso()
    // Wedding_date can live on either side; weddings is authoritative
    // for the event date, fall back to couples if the wedding row is
    // missing it (rare).
    const weddingDate = wedding.wedding_date ?? couple.wedding_date ?? null
    const passed = weddingDate !== null && weddingDate < today
    return {
      derived: passed ? 'completed' : 'booked',
      rationale: passed
        ? `weddings.status = 'booked' AND wedding_date ${weddingDate} < ${today} -> mig-365 completed flip`
        : `weddings.status = 'booked'${weddingDate ? ` (wedding_date ${weddingDate} not yet passed)` : ' (no wedding_date)'}`,
      category: 'mapped',
    }
  }

  // Terminal-positive (completed). Stays completed regardless of date.
  if (status === 'completed') {
    return {
      derived: 'completed',
      rationale: `weddings.status = 'completed'`,
      category: 'mapped',
    }
  }

  // Live engaged: any pre-booked workflow state -> resolved.
  if (
    status === 'inquiry' ||
    status === 'tour_scheduled' ||
    status === 'tour_completed' ||
    status === 'proposal_sent'
  ) {
    return {
      derived: 'resolved',
      rationale: `weddings.status = '${status}'`,
      category: 'mapped',
    }
  }

  // Unknown status — not in the mig-001 CHECK list. Surface to operator.
  return {
    derived: null,
    rationale: `weddings.status = '${status}' is not in the documented mapping`,
    category: 'skip_unknown_status',
  }
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
        'npx tsx scripts/sync-couple-lifecycle-from-weddings.ts [--apply] [--allow-prod]',
    )
    process.exit(1)
  }
  if (url.includes(PROD_REF) && !ALLOW_PROD) {
    console.error(
      `ERROR: BRANCH_URL points at production (${PROD_REF}). Refusing.\n` +
        'Pass --allow-prod to override. UPDATE is on couples.lifecycle_state only — ' +
        'never an INSERT/UPSERT — but operator must opt in explicitly to prod writes.',
    )
    process.exit(1)
  }

  const supabase: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false },
  })

  const tag = APPLY ? '[APPLY]' : '[DRY-RUN]'
  console.log('='.repeat(78))
  console.log(`${tag} sync-couple-lifecycle-from-weddings`)
  console.log('='.repeat(78))
  console.log(`Target DB    : ${url}`)
  console.log(`Venue scope  : ${VENUE_SCOPE ?? '(all venues)'}`)
  console.log(`Limit        : ${LIMIT ?? '(none)'}`)
  console.log(`Today (UTC)  : ${todayIso()}  (post-wedding flip cutoff)`)
  console.log('')

  // -------------------------------------------------------------------------
  // 1. Load every couple with a source_wedding_id.
  // -------------------------------------------------------------------------
  console.log('[1] Loading bridged couples (source_wedding_id IS NOT NULL)...')
  const couples = await fetchAll<CoupleRow>('couples', (from, to) => {
    let q = supabase
      .from('couples')
      .select(
        'id, venue_id, lifecycle_state, wedding_date, source_wedding_id, primary_contact_name',
      )
      .not('source_wedding_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to)
    if (VENUE_SCOPE) q = q.eq('venue_id', VENUE_SCOPE)
    return q
  })
  console.log(`    bridged couples loaded: ${couples.length}`)

  if (couples.length === 0) {
    console.log('Nothing to do — no bridged couples in the requested scope.')
    return
  }

  // -------------------------------------------------------------------------
  // 2. Bulk-load the weddings rows for those source_wedding_ids.
  // -------------------------------------------------------------------------
  console.log('[2] Loading weddings for bridged couples...')
  const weddingIds = couples.map((c) => c.source_wedding_id)
  const weddingById = new Map<string, WeddingRow>()
  for (let i = 0; i < weddingIds.length; i += CHUNK) {
    const slice = weddingIds.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from('weddings')
      .select('id, status, wedding_date, merged_into_id')
      .in('id', slice)
    if (error) throw new Error(`weddings lookup: ${error.message}`)
    for (const w of (data ?? []) as WeddingRow[]) {
      weddingById.set(w.id, w)
    }
  }
  console.log(`    weddings resolved:     ${weddingById.size} / ${weddingIds.length}`)

  // -------------------------------------------------------------------------
  // 3. Compute divergences.
  // -------------------------------------------------------------------------
  interface Divergence {
    couple: CoupleRow
    wedding: WeddingRow | undefined
    derivation: DerivationResult
  }
  const divergences: Divergence[] = []
  const skipBuckets = new Map<string, number>() // category -> count
  let agreeCount = 0

  for (const c of couples) {
    const w = weddingById.get(c.source_wedding_id)
    const d = deriveLifecycleFromStatus(c, w)
    if (d.derived === null) {
      skipBuckets.set(d.category, (skipBuckets.get(d.category) ?? 0) + 1)
      // Only surface skips that look like real divergence shapes
      // (not the boring agent skip).
      if (d.category !== 'skip_agent') {
        divergences.push({ couple: c, wedding: w, derivation: d })
      }
      continue
    }
    if (c.lifecycle_state === d.derived) {
      agreeCount++
      continue
    }
    divergences.push({ couple: c, wedding: w, derivation: d })
  }

  // -------------------------------------------------------------------------
  // 4. Report — divergence matrix.
  // -------------------------------------------------------------------------
  console.log('')
  console.log('-'.repeat(78))
  console.log('DIVERGENCE SUMMARY')
  console.log('-'.repeat(78))
  console.log(`  total bridged couples           : ${couples.length}`)
  console.log(`    in agreement (already aligned): ${agreeCount}`)
  console.log(`    diverging (would update)      : ${divergences.filter((d) => d.derivation.derived !== null).length}`)
  console.log(`    skipped (operator review)     : ${[...skipBuckets.entries()].reduce((s, [, n]) => s + n, 0)}`)
  for (const [cat, n] of [...skipBuckets.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${cat.padEnd(30)}: ${n}`)
  }
  console.log('')

  // Divergence shape matrix: (current_state -> derived_state) -> count.
  const shapeCount = new Map<string, number>()
  for (const d of divergences) {
    if (d.derivation.derived === null) continue
    const key = `${d.couple.lifecycle_state ?? '(null)'} -> ${d.derivation.derived}`
    shapeCount.set(key, (shapeCount.get(key) ?? 0) + 1)
  }
  if (shapeCount.size > 0) {
    console.log('DIVERGENCE SHAPES (current -> derived):')
    for (const [k, n] of [...shapeCount.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(38)}: ${n}`)
    }
    console.log('')
  }

  const actionable = divergences.filter((d) => d.derivation.derived !== null)
  const capped = LIMIT != null ? actionable.slice(0, LIMIT) : actionable

  if (actionable.length === 0) {
    console.log('No actionable divergences.')
    if (divergences.some((d) => d.derivation.derived === null)) {
      console.log('Some couples landed in skip buckets — review the matrix above.')
    }
    return
  }

  // -------------------------------------------------------------------------
  // 5. Sample of rows that would be updated.
  // -------------------------------------------------------------------------
  console.log('-'.repeat(78))
  console.log(`SAMPLE OF DIVERGENCES (first 20 of ${actionable.length}):`)
  console.log('-'.repeat(78))
  for (const d of actionable.slice(0, 20)) {
    const name = d.couple.primary_contact_name ?? '(no name)'
    const cur = d.couple.lifecycle_state ?? '(null)'
    const derived = d.derivation.derived
    console.log(
      `  couple ${d.couple.id.slice(0, 8)}  "${name}"  ${cur.padEnd(15)} -> ${(derived as string).padEnd(11)}  | ${d.derivation.rationale}`,
    )
  }
  if (actionable.length > 20) {
    console.log(`  ... and ${actionable.length - 20} more`)
  }
  console.log('')

  if (!APPLY) {
    console.log('DRY-RUN — no writes.')
    console.log('Re-run with --apply to UPDATE the divergent rows.')
    return
  }

  // -------------------------------------------------------------------------
  // 6. Apply — UPDATE per row, with a defensive `.eq(lifecycle_state,
  //    previousCurrent)` guard so a concurrent writer wins.
  // -------------------------------------------------------------------------
  console.log('-'.repeat(78))
  console.log(`APPLYING — updating ${capped.length} couples.lifecycle_state rows...`)
  if (LIMIT != null && capped.length < actionable.length) {
    console.log(`  (capped by SYNC_LIMIT=${LIMIT}; ${actionable.length - capped.length} deferred)`)
  }
  console.log('-'.repeat(78))

  let updated = 0
  let raceLost = 0
  let failed = 0
  const failures: Array<{ couple: string; reason: string }> = []

  const LOG_EVERY = 25
  for (let i = 0; i < capped.length; i++) {
    const d = capped[i]
    const derived = d.derivation.derived as LifecycleState // narrowed by filter
    const previousCurrent = d.couple.lifecycle_state

    // Build the predicate. supabase-js does not have a fluent IS NULL
    // for .eq, so we branch.
    let q = supabase
      .from('couples')
      .update(
        { lifecycle_state: derived, updated_at: new Date().toISOString() },
        { count: 'exact' },
      )
      .eq('id', d.couple.id)
    if (previousCurrent === null) {
      q = q.is('lifecycle_state', null)
    } else {
      q = q.eq('lifecycle_state', previousCurrent)
    }
    const { error, count } = await q
    if (error) {
      failed++
      failures.push({ couple: d.couple.id, reason: error.message })
    } else if ((count ?? 0) === 0) {
      raceLost++
    } else {
      updated++
    }

    if ((i + 1) % LOG_EVERY === 0 || i === capped.length - 1) {
      console.log(
        `  progress: ${i + 1}/${capped.length}  ` +
          `(updated=${updated} race_lost=${raceLost} failed=${failed})`,
      )
    }
  }

  // -------------------------------------------------------------------------
  // 7. Report.
  // -------------------------------------------------------------------------
  console.log('')
  console.log('='.repeat(78))
  console.log('RESULT')
  console.log('='.repeat(78))
  console.log(`  attempted        : ${capped.length}`)
  console.log(`  updated          : ${updated}`)
  console.log(`  race-lost (skip) : ${raceLost}   (concurrent writer beat us)`)
  console.log(`  failed           : ${failed}`)
  console.log('')

  if (failures.length > 0) {
    console.log('FAILURE SAMPLE (first 20):')
    for (const f of failures.slice(0, 20)) {
      console.log(`  couple ${f.couple}  reason: ${f.reason}`)
    }
    console.log('')
    console.log('Re-run the sweep to retry — UPDATEs are idempotent.')
  } else {
    console.log('All target couples now reflect their wedding.status projection.')
    console.log('Re-running this script on the same scope should report 0 divergences.')
  }
  console.log('='.repeat(78))
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
