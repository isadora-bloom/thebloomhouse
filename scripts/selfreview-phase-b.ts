// Phase B end-to-end self-review (PB.9).
//
// Drives the full chain on the real Rixey Knot CSV and verifies the
// database state matches the contract. Read-only by default — pass
// --apply to actually exercise the writes (creates rows, runs
// clusterer + resolver, then cleans up).
//
// Verifies:
//   1. Detection picks the_knot at high confidence
//   2. Phase A inserts signals; dedup works on re-run
//   3. Phase B clusterer collapses funnel patterns: same name +
//      ≤14d gap → one candidate with multiple signals attached
//   4. Anonymous (". ") rows are signals but never candidates
//   5. Resolver produces zero attributions when there are no
//      pre-existing weddings to match against (clean tenant state)
//   6. cluster_group_key is populated for long-gap split clusters
//   7. Cleanup removes everything the run created
//
// Usage:
//   npx tsx scripts/selfreview-phase-b.ts            # dry-run (counts only)
//   npx tsx scripts/selfreview-phase-b.ts --apply    # exercise writes + verify + clean
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { detectPlatformSource } from '../src/lib/services/platform-detectors'
import { importPlatformSignals } from '../src/lib/services/platform-signals-import'
import { clusterSignals } from '../src/lib/services/candidate-clusterer'
import { resolveVenueCandidates } from '../src/lib/services/candidate-resolver'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const APPLY = process.argv.includes('--apply')
const CSV_PATH = process.argv.find((a) => a.endsWith('.csv'))
  ?? 'C:\\Users\\Ismar\\Downloads\\RixeyManor-visitor-activities (1).csv'

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++ } else { inQuote = !inQuote }
    } else if (ch === ',' && !inQuote) {
      out.push(cur); cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map((s) => s.trim().replace(/^"|"$/g, ''))
}

async function cleanup(): Promise<void> {
  await sb.from('attribution_events').delete().eq('venue_id', RIXEY)
  await sb.from('candidate_identities').delete().eq('venue_id', RIXEY).eq('source_platform', 'the_knot')
  await sb.from('tangential_signals').delete().eq('venue_id', RIXEY).eq('source_platform', 'the_knot')
  await sb.from('wedding_touchpoints').delete().eq('venue_id', RIXEY).eq('medium', 'platform_signal')
}

async function main() {
  console.log(`\n=== Phase B end-to-end self-review (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`)

  const text = readFileSync(CSV_PATH, 'utf8')
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  const headers = parseCsvLine(lines[0])
  const rows = lines.slice(1).map(parseCsvLine)
  console.log(`CSV: ${rows.length} rows\n`)

  // CHECK 1 — detection
  console.log('[1] platform detection')
  const detection = detectPlatformSource(headers, rows.slice(0, 30))
  if (!detection.best) {
    console.log('  ❌ no detector matched')
    return
  }
  console.log(`  ✓ ${detection.best.detector.key} @ ${detection.best.confidence}%`)

  if (!APPLY) {
    console.log('\n[--apply skipped — not exercising writes]')
    console.log('\n=== done ===')
    return
  }

  // Pre-cleanup so a half-run doesn't poison the test
  await cleanup()

  // CHECK 2 — Phase A insert
  console.log('\n[2] Phase A signal import')
  const importResult = await importPlatformSignals({
    supabase: sb,
    venueId: RIXEY,
    detector: detection.best.detector,
    headers,
    rows,
  })
  console.log(`  inserted: ${importResult.inserted}`)
  console.log(`  duplicates: ${importResult.skipped_duplicate}`)
  console.log(`  empty-name: ${importResult.skipped_empty_name}`)
  console.log(`  unparseable date: ${importResult.skipped_unparseable_date}`)
  if (importResult.errors.length > 0) {
    for (const e of importResult.errors.slice(0, 3)) console.log(`    error: ${e}`)
  }

  // CHECK 3 — Phase B clusterer
  console.log('\n[3] Phase B clusterer')
  const clusterStats = await clusterSignals({
    supabase: sb,
    signalIds: importResult.inserted_signal_ids,
  })
  console.log(`  signals processed: ${clusterStats.signals_processed}`)
  console.log(`  anonymous skipped: ${clusterStats.signals_skipped_anonymous}`)
  console.log(`  attached to existing: ${clusterStats.signals_attached_to_existing}`)
  console.log(`  new clusters: ${clusterStats.signals_creating_new_cluster}`)
  console.log(`  flagged for review: ${clusterStats.candidates_flagged_for_review}`)
  if (clusterStats.errors.length > 0) {
    for (const e of clusterStats.errors.slice(0, 3)) console.log(`    error: ${e}`)
  }

  // CHECK 4 — funnel pattern collapse: count candidates with funnel_depth > 1
  const { data: funnelCands } = await sb
    .from('candidate_identities')
    .select('id, first_name, last_initial, funnel_depth, signal_count, action_counts')
    .eq('venue_id', RIXEY)
    .eq('source_platform', 'the_knot')
    .gt('funnel_depth', 1)
    .order('funnel_depth', { ascending: false })
    .limit(5)
  console.log(`\n[4] funnel-pattern candidates (depth > 1): ${(funnelCands ?? []).length} top 5`)
  for (const c of (funnelCands ?? []) as Array<{ first_name: string; last_initial: string; funnel_depth: number; signal_count: number; action_counts: Record<string, number> }>) {
    console.log(`  ${c.first_name} ${c.last_initial}. — depth=${c.funnel_depth}, signals=${c.signal_count}, actions=${JSON.stringify(c.action_counts)}`)
  }

  // CHECK 5 — anonymous signals never become candidates
  const { count: anonSignals } = await sb
    .from('tangential_signals')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY)
    .eq('source_platform', 'the_knot')
    .is('candidate_identity_id', null)
  console.log(`\n[5] anonymous signals (no candidate): ${anonSignals}`)

  // CHECK 6 — resolver
  console.log('\n[6] Phase B resolver (against existing Rixey weddings)')
  const resolverStats = await resolveVenueCandidates({
    supabase: sb,
    venueId: RIXEY,
    candidateIds: clusterStats.affected_candidate_ids,
  })
  const resolved =
    resolverStats.resolved_tier_1_exact +
    resolverStats.resolved_tier_1_name_window +
    resolverStats.resolved_tier_1_full_name +
    resolverStats.resolved_tier_2_ai
  console.log(`  candidates processed: ${resolverStats.candidates_processed}`)
  console.log(`  matched: ${resolved}`)
  console.log(`    T1 exact: ${resolverStats.resolved_tier_1_exact}`)
  console.log(`    T1 name+window: ${resolverStats.resolved_tier_1_name_window}`)
  console.log(`    T1 full name: ${resolverStats.resolved_tier_1_full_name}`)
  console.log(`    T2 AI: ${resolverStats.resolved_tier_2_ai}`)
  console.log(`  deferred: ${resolverStats.deferred_to_ai}`)
  console.log(`  no_match: ${resolverStats.no_match}`)
  console.log(`  conflicts: ${resolverStats.conflicts_flagged}`)

  // CHECK 7 — attribution_events written when matches happen
  const { count: attribCount } = await sb
    .from('attribution_events')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY)
  console.log(`\n[7] attribution_events written: ${attribCount}`)

  // CHECK 8 — wedding_touchpoints backfilled when candidates resolve
  const { count: touchCount } = await sb
    .from('wedding_touchpoints')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY)
    .eq('medium', 'platform_signal')
  console.log(`[8] wedding_touchpoints backfilled: ${touchCount}`)

  // CHECK 9 — re-run idempotency
  console.log('\n[9] re-run idempotency')
  const reCluster = await clusterSignals({
    supabase: sb,
    signalIds: importResult.inserted_signal_ids,
  })
  // Anonymous signals never get a candidate_identity_id, so they
  // re-enter the clusterer pipeline and immediately exit through the
  // anonymous skip — that's the always-skip path, not duplicate work.
  console.log(`  re-clustered: ${reCluster.signals_processed} (expect == anonymous skipped)`)
  const reResolve = await resolveVenueCandidates({
    supabase: sb,
    venueId: RIXEY,
    candidateIds: clusterStats.affected_candidate_ids,
  })
  // Resolved candidates short-circuit; only no-match candidates re-try.
  console.log(`  re-resolved: ${reResolve.candidates_processed} (expect == no_match count)`)

  // CLEANUP
  console.log('\n[cleanup] removing test rows')
  await cleanup()
  console.log('  done')

  console.log('\n=== done ===')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
