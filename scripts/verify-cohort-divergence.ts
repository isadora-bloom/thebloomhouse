/**
 * scripts/verify-cohort-divergence.ts
 * ===================================
 * Read-only divergence counter — the verify-side of
 * `sync-couple-lifecycle-from-weddings.ts`.
 *
 * WHAT IT DOES
 * ------------
 * For every couple with `source_wedding_id`, derive the doctrinally-
 * correct `lifecycle_state` from `weddings.status` (+ the post-wedding
 * `booked -> completed` flip per mig 365) and count agreements +
 * divergences. Prints a matrix of (current_state -> derived_state)
 * so the operator can SEE the shape of the cohort divergence the
 * sync writer would close.
 *
 * The derivation here is the SAME projection function as in
 * `sync-couple-lifecycle-from-weddings.ts`. Both scripts share the
 * mapping; this one just doesn't write. Keeping the projection
 * duplicated (rather than imported) keeps both scripts standalone
 * with no internal `@/` alias dependency — same pattern as
 * `scripts/resolve-partner-dups.ts`.
 *
 * USAGE
 * -----
 *   # Consolidation branch:
 *   BRANCH_URL=https://ciwqxwohczzthvzqqgjx.supabase.co \
 *   BRANCH_KEY=<service_role_key> \
 *   npx tsx scripts/verify-cohort-divergence.ts
 *
 *   # Prod (still read-only, but kept behind the same gate as the
 *   # writer for operator-clarity):
 *   BRANCH_URL=https://jsxxgwprxuqgcauzlxcb.supabase.co BRANCH_KEY=... \
 *     npx tsx scripts/verify-cohort-divergence.ts --allow-prod
 *
 *   # Single venue:
 *   SYNC_VENUE_ID=<uuid> npx tsx scripts/verify-cohort-divergence.ts
 *
 * NEVER WRITES. The supabase client is service-role for read parity
 * with the writer (same RLS context) but no .insert / .upsert /
 * .update / .delete call appears in this file.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ALLOW_PROD = process.argv.includes('--allow-prod')
const VENUE_SCOPE = process.env.SYNC_VENUE_ID || null
const PAGE = 1000
const CHUNK = 500
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
}

interface WeddingRow {
  id: string
  status: string | null
  wedding_date: string | null
  merged_into_id: string | null
}

interface DerivationResult {
  derived: LifecycleState | null
  category:
    | 'mapped'
    | 'skip_agent'
    | 'skip_wedding_merged_away'
    | 'skip_unknown_status'
    | 'skip_null_status'
}

// ---------------------------------------------------------------------------
// Derivation — MUST match sync-couple-lifecycle-from-weddings.ts
// ---------------------------------------------------------------------------

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function deriveLifecycleFromStatus(
  couple: CoupleRow,
  wedding: WeddingRow | undefined,
): DerivationResult {
  if (couple.lifecycle_state === 'agent') {
    return { derived: null, category: 'skip_agent' }
  }
  if (!wedding) {
    return { derived: null, category: 'skip_unknown_status' }
  }
  if (wedding.merged_into_id) {
    return { derived: null, category: 'skip_wedding_merged_away' }
  }
  const status = wedding.status?.toLowerCase() ?? null
  if (!status) {
    return { derived: null, category: 'skip_null_status' }
  }
  if (status === 'lost' || status === 'cancelled' || status === 'non_couple') {
    return { derived: 'ghost', category: 'mapped' }
  }
  if (status === 'booked') {
    const weddingDate = wedding.wedding_date ?? couple.wedding_date ?? null
    const passed = weddingDate !== null && weddingDate < todayIso()
    return { derived: passed ? 'completed' : 'booked', category: 'mapped' }
  }
  if (status === 'completed') {
    return { derived: 'completed', category: 'mapped' }
  }
  if (
    status === 'inquiry' ||
    status === 'tour_scheduled' ||
    status === 'tour_completed' ||
    status === 'proposal_sent'
  ) {
    return { derived: 'resolved', category: 'mapped' }
  }
  return { derived: null, category: 'skip_unknown_status' }
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
        'npx tsx scripts/verify-cohort-divergence.ts',
    )
    process.exit(1)
  }
  if (url.includes(PROD_REF) && !ALLOW_PROD) {
    console.error(
      `ERROR: BRANCH_URL points at production (${PROD_REF}). Refusing.\n` +
        'Pass --allow-prod to confirm the read is intentional. ' +
        '(Script is read-only — gate matches the writer for operator clarity.)',
    )
    process.exit(1)
  }

  const supabase: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false },
  })

  console.log('='.repeat(78))
  console.log('verify-cohort-divergence — couples.lifecycle_state vs weddings.status')
  console.log('='.repeat(78))
  console.log(`Target DB   : ${url}`)
  console.log(`Venue scope : ${VENUE_SCOPE ?? '(all venues)'}`)
  console.log(`Today (UTC) : ${todayIso()}  (post-wedding flip cutoff)`)
  console.log('')

  // Pull bridged couples.
  const couples = await fetchAll<CoupleRow>('couples', (from, to) => {
    let q = supabase
      .from('couples')
      .select(
        'id, venue_id, lifecycle_state, wedding_date, source_wedding_id',
      )
      .not('source_wedding_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to)
    if (VENUE_SCOPE) q = q.eq('venue_id', VENUE_SCOPE)
    return q
  })
  console.log(`bridged couples loaded: ${couples.length}`)
  if (couples.length === 0) {
    console.log('Nothing to verify.')
    return
  }

  // Pull their weddings.
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
  console.log(`weddings resolved:     ${weddingById.size} / ${weddingIds.length}`)
  console.log('')

  // Bucket.
  let agree = 0
  let diverge = 0
  const matrix = new Map<string, number>() // "current -> derived" -> count
  const skips = new Map<string, number>() // category -> count

  // Also count the headline cohort sizes (current AND derived buckets)
  // so the operator can compare "26 booked vs 86 vs 66/67" at a glance.
  const currentBuckets = new Map<string, number>()
  const derivedBuckets = new Map<string, number>()

  for (const c of couples) {
    const cur = c.lifecycle_state ?? '(null)'
    currentBuckets.set(cur, (currentBuckets.get(cur) ?? 0) + 1)

    const w = weddingById.get(c.source_wedding_id)
    const d = deriveLifecycleFromStatus(c, w)
    if (d.derived === null) {
      skips.set(d.category, (skips.get(d.category) ?? 0) + 1)
      // Skipped rows go into a derived bucket of their category so the
      // operator can SEE that "the script can't derive these" rather
      // than treating them as agreements.
      const derivedKey = `(skip:${d.category})`
      derivedBuckets.set(derivedKey, (derivedBuckets.get(derivedKey) ?? 0) + 1)
      // Skip rows are also a divergence shape worth surfacing —
      // particularly skip_null_status + skip_unknown_status, which
      // mean a wedding row is missing data the spine needs.
      if (d.category !== 'skip_agent') {
        const k = `${cur} -> ${derivedKey}`
        matrix.set(k, (matrix.get(k) ?? 0) + 1)
      }
      continue
    }
    derivedBuckets.set(d.derived, (derivedBuckets.get(d.derived) ?? 0) + 1)
    if (cur === d.derived) {
      agree++
    } else {
      diverge++
      const k = `${cur} -> ${d.derived}`
      matrix.set(k, (matrix.get(k) ?? 0) + 1)
    }
  }

  // -----------------------------------------------------------------------
  // Report.
  // -----------------------------------------------------------------------
  console.log('-'.repeat(78))
  console.log('HEADLINE COUNTS')
  console.log('-'.repeat(78))
  console.log(`  total bridged couples : ${couples.length}`)
  console.log(`  in agreement          : ${agree}`)
  console.log(`  diverging             : ${diverge}`)
  const skipTotal = [...skips.values()].reduce((s, n) => s + n, 0)
  console.log(`  skipped               : ${skipTotal}`)
  console.log('')

  console.log('-'.repeat(78))
  console.log('CURRENT couples.lifecycle_state buckets')
  console.log('-'.repeat(78))
  for (const [s, n] of [...currentBuckets.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(20)}: ${n}`)
  }
  console.log('')

  console.log('-'.repeat(78))
  console.log('DERIVED couples.lifecycle_state buckets (what the projection says)')
  console.log('-'.repeat(78))
  for (const [s, n] of [...derivedBuckets.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(40)}: ${n}`)
  }
  console.log('')

  if (skips.size > 0) {
    console.log('-'.repeat(78))
    console.log('SKIP CATEGORIES (rows the projection cannot derive)')
    console.log('-'.repeat(78))
    for (const [c, n] of [...skips.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${c.padEnd(30)}: ${n}`)
    }
    console.log('')
  }

  if (matrix.size > 0) {
    console.log('-'.repeat(78))
    console.log('DIVERGENCE MATRIX (current_state -> derived_state)')
    console.log('-'.repeat(78))
    for (const [k, n] of [...matrix.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(48)}: ${n}`)
    }
    console.log('')
  } else {
    console.log('No divergences. couples.lifecycle_state is fully aligned with weddings.status.')
  }

  console.log('='.repeat(78))
  console.log('(Read-only.)')
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
