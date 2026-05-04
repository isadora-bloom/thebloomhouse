/**
 * Stream NNN verification script — universal merge reattachment.
 *
 * Migration 202 (`202_merge_reattachment_trigger.sql`):
 *   - Creates `merge_reattachment_log` audit table.
 *   - Creates `trg_weddings_reattach_on_merge` trigger that fires on
 *     `weddings.merged_into_id` NULL → non-NULL transitions, moving
 *     attribution_events / wedding_touchpoints / candidate_identities
 *     from loser to winner.
 *   - Backfills existing mergers in the same migration (one-shot,
 *     idempotent via WHERE NOT EXISTS against the audit log).
 *
 * What this script asserts
 * ------------------------
 *   A. Migration sanity: `merge_reattachment_log` table exists and is
 *      queryable (proves migration 202 applied successfully).
 *   B. Orphan-zero invariant: count attribution_events,
 *      wedding_touchpoints, candidate_identities currently pointing at
 *      ANY wedding with `merged_into_id IS NOT NULL`. After backfill
 *      these MUST be zero. If non-zero either the trigger isn't firing
 *      or the backfill missed rows.
 *   C. Backfill audit coverage: every loser wedding (those with
 *      merged_into_id IS NOT NULL) should have at least one row in
 *      merge_reattachment_log.
 *   D. Optional integration test (--integration flag): perform a
 *      throwaway merge on two demo weddings, observe the trigger fire,
 *      observe the audit row, then revert. Skipped by default to keep
 *      the verifier safe to run in any environment.
 *
 * Run:
 *   npx tsx scripts/rixey-load/73-nnn-verify.ts
 *   npx tsx scripts/rixey-load/73-nnn-verify.ts --integration
 *
 * Exit code 0 on all-pass; 1 on any failure.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

function loadEnv() {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const raw = readFileSync('.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
  return env
}

const env = loadEnv()
for (const [k, v] of Object.entries(env)) {
  if (!process.env[k]) process.env[k] = v
}

let exitCode = 0
function fail(msg: string) {
  console.error(`FAIL: ${msg}`)
  exitCode = 1
}
function pass(msg: string) {
  console.log(`PASS: ${msg}`)
}

async function main() {
  const integration = process.argv.includes('--integration')
  console.log('=== Stream NNN merge-reattachment verification ===')
  if (integration) console.log('(--integration: will exercise the trigger end-to-end)')

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  // ---- A) Migration 202 sanity ----
  console.log('\n--- A) Migration 202 + audit-log table sanity ---')
  const { error: tableErr } = await sb
    .from('merge_reattachment_log')
    .select('id', { count: 'exact', head: true })
    .limit(1)
  if (tableErr) {
    fail(`merge_reattachment_log not queryable: ${tableErr.message}`)
    process.exit(exitCode)
  }
  pass('merge_reattachment_log table exists + queryable')

  // ---- B) Orphan-zero invariant ----
  console.log('\n--- B) Orphan-zero invariant ---')

  // Pull loser ids in batches to avoid the .in() URL-length cap on large
  // venues. 146 today on Rixey; could grow once Stream MMM runs across
  // every venue. Page in 1000-row chunks.
  const loserIds: string[] = []
  let page = 0
  const PAGE_SIZE = 1000
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await sb
      .from('weddings')
      .select('id')
      .not('merged_into_id', 'is', null)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) {
      fail(`loser pagination failed: ${error.message}`)
      process.exit(exitCode)
    }
    if (!data || data.length === 0) break
    for (const r of data) loserIds.push(r.id as string)
    if (data.length < PAGE_SIZE) break
    page++
  }
  console.log(`  loser weddings (merged_into_id IS NOT NULL): ${loserIds.length}`)

  if (loserIds.length === 0) {
    pass('no mergers in DB — trigger has had nothing to do (vacuously satisfied)')
  } else {
    let aeOrphans = 0
    let tpOrphans = 0
    let ciOrphans = 0

    // Process loserIds in batches for the .in() filter.
    const IN_BATCH = 200
    for (let i = 0; i < loserIds.length; i += IN_BATCH) {
      const batch = loserIds.slice(i, i + IN_BATCH)

      const { count: ae, error: e1 } = await sb
        .from('attribution_events')
        .select('id', { count: 'exact', head: true })
        .in('wedding_id', batch)
        .is('reverted_at', null)
      if (e1) { fail(`attribution_events count failed: ${e1.message}`); process.exit(exitCode) }
      aeOrphans += ae ?? 0

      const { count: tp, error: e2 } = await sb
        .from('wedding_touchpoints')
        .select('id', { count: 'exact', head: true })
        .in('wedding_id', batch)
      if (e2) { fail(`wedding_touchpoints count failed: ${e2.message}`); process.exit(exitCode) }
      tpOrphans += tp ?? 0

      const { count: ci, error: e3 } = await sb
        .from('candidate_identities')
        .select('id', { count: 'exact', head: true })
        .in('resolved_wedding_id', batch)
        .is('deleted_at', null)
      if (e3) { fail(`candidate_identities count failed: ${e3.message}`); process.exit(exitCode) }
      ciOrphans += ci ?? 0
    }

    console.log(`  attribution_events orphans (live):     ${aeOrphans}`)
    console.log(`  wedding_touchpoints orphans:           ${tpOrphans}`)
    console.log(`  candidate_identities orphans (live):   ${ciOrphans}`)

    if (aeOrphans === 0) pass('attribution_events: zero orphans')
    else fail(`attribution_events: ${aeOrphans} orphans still pointing at losers`)

    if (tpOrphans === 0) pass('wedding_touchpoints: zero orphans')
    else fail(`wedding_touchpoints: ${tpOrphans} orphans still pointing at losers`)

    if (ciOrphans === 0) pass('candidate_identities: zero orphans')
    else fail(`candidate_identities: ${ciOrphans} orphans still pointing at losers`)
  }

  // ---- C) Backfill audit-log coverage ----
  console.log('\n--- C) Backfill audit-log coverage ---')
  const { count: logRowCount, error: logErr } = await sb
    .from('merge_reattachment_log')
    .select('id', { count: 'exact', head: true })
  if (logErr) {
    fail(`audit log count failed: ${logErr.message}`)
  } else {
    console.log(`  merge_reattachment_log row count: ${logRowCount ?? 0}`)
    if (loserIds.length > 0 && (logRowCount ?? 0) === 0) {
      fail('losers exist but the audit log is empty — backfill did not run')
    } else if (loserIds.length > 0) {
      pass('audit log populated')
    }

    if (loserIds.length > 0) {
      // Spot-check: every loser should have ≥1 audit row. Scan in
      // batches and count distinct loser_wedding_ids covered.
      const covered = new Set<string>()
      const IN_BATCH = 200
      for (let i = 0; i < loserIds.length; i += IN_BATCH) {
        const batch = loserIds.slice(i, i + IN_BATCH)
        const { data, error } = await sb
          .from('merge_reattachment_log')
          .select('loser_wedding_id')
          .in('loser_wedding_id', batch)
        if (error) { fail(`coverage scan failed: ${error.message}`); break }
        for (const r of data ?? []) covered.add(r.loser_wedding_id as string)
      }
      const missing = loserIds.filter((id) => !covered.has(id))
      console.log(`  losers with ≥1 audit row: ${covered.size}/${loserIds.length}`)
      if (missing.length === 0) {
        pass('every loser has an audit row')
      } else {
        fail(`${missing.length} losers missing audit rows (e.g. ${missing.slice(0, 3).join(', ')})`)
      }

      // Per-table backfill totals — informational. Re-totalled from the log.
      // Pull in batches to avoid huge response bodies.
      let aeMoved = 0
      let tpMoved = 0
      let ciMoved = 0
      const SUM_BATCH = 1000
      for (let off = 0; off < (logRowCount ?? 0); off += SUM_BATCH) {
        const { data, error } = await sb
          .from('merge_reattachment_log')
          .select('attribution_events_moved, touchpoints_moved, candidates_moved')
          .range(off, off + SUM_BATCH - 1)
        if (error) { fail(`sum scan failed: ${error.message}`); break }
        for (const r of data ?? []) {
          aeMoved += (r.attribution_events_moved as number) ?? 0
          tpMoved += (r.touchpoints_moved as number) ?? 0
          ciMoved += (r.candidates_moved as number) ?? 0
        }
      }
      console.log(`  total attribution_events moved (lifetime): ${aeMoved}`)
      console.log(`  total wedding_touchpoints moved (lifetime): ${tpMoved}`)
      console.log(`  total candidate_identities moved (lifetime): ${ciMoved}`)
    }
  }

  // ---- D) Optional integration test ----
  if (integration) {
    console.log('\n--- D) Integration test (--integration) ---')
    // Find two demo weddings (same venue, both active, neither already
    // merged) so we can stamp a throwaway merge.
    const { data: demoVenues } = await sb
      .from('venues')
      .select('id')
      .eq('is_demo', true)
      .limit(1)
    if (!demoVenues || demoVenues.length === 0) {
      console.log('  SKIP: no demo venue found')
    } else {
      const demoVenueId = demoVenues[0]!.id as string
      const { data: candidates } = await sb
        .from('weddings')
        .select('id')
        .eq('venue_id', demoVenueId)
        .is('merged_into_id', null)
        .limit(2)
      if (!candidates || candidates.length < 2) {
        console.log('  SKIP: need ≥2 active demo weddings for the integration test')
      } else {
        const loserId = candidates[0]!.id as string
        const winnerId = candidates[1]!.id as string
        console.log(`  test merge: ${loserId} → ${winnerId}`)

        const beforeForLoser = (
          await sb
            .from('merge_reattachment_log')
            .select('id', { count: 'exact', head: true })
            .eq('loser_wedding_id', loserId)
        ).count ?? 0

        // Stamp the merge.
        const { error: mergeErr } = await sb
          .from('weddings')
          .update({ merged_into_id: winnerId })
          .eq('id', loserId)
        if (mergeErr) {
          fail(`merge UPDATE failed: ${mergeErr.message}`)
        } else {
          // Trigger should have inserted exactly one new audit row.
          const afterForLoser = (
            await sb
              .from('merge_reattachment_log')
              .select('id', { count: 'exact', head: true })
              .eq('loser_wedding_id', loserId)
          ).count ?? 0
          if (afterForLoser === beforeForLoser + 1) {
            pass(`trigger fired: audit row count for loser went ${beforeForLoser} → ${afterForLoser}`)
          } else {
            fail(`trigger did NOT fire: audit row count stayed at ${afterForLoser}`)
          }

          // Revert the merge so the demo data stays clean.
          const { error: revertErr } = await sb
            .from('weddings')
            .update({ merged_into_id: null })
            .eq('id', loserId)
          if (revertErr) {
            console.log(`  WARN: failed to revert demo merge: ${revertErr.message}`)
          } else {
            console.log('  reverted demo merge (loser restored to active)')
          }
        }
      }
    }
  }

  console.log(exitCode === 0 ? '\nAll checks passed.' : '\nFailures detected.')
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
