/**
 * Stream SSS — re-run booked-data recovery against Rixey.
 *
 * Why
 * ---
 * Stream MMM (booked-data recovery) wrote `booking_value` for venues
 * whose calculator-estimate emails carry the contract total. SSS
 * extends the calculator-extract branch so that when the hit comes
 * from a *universal* third-party calculator vendor
 * (interactivecalculator.com), `weddings.source` is also backfilled
 * to `'venue_calculator'` — but only when source is currently NULL.
 * Venue-templated estimate emails (sent from the venue's own domain)
 * remain ambiguous: they could be web_form, direct, coordinator-
 * routed, or a half-dozen other origins, so SSS leaves source alone
 * in that branch.
 *
 * Rixey demo wants the fix visible immediately. The cron will pick
 * up nightly going forward, but Paige & Tanner today shows
 * "Untracked / Pre-Bloom" on the Source Comparison page despite
 * having a recovered $16,695 booking_value from a clear
 * interactivecalculator.com hit. This script re-runs the recovery
 * sweep so SSS can flip her source.
 *
 * What it does
 * ------------
 *   1. Pre-run snapshot — Rixey's current source distribution.
 *   2. Probe — count weddings whose interactions include an
 *      `@interactivecalculator.com` from-address AND whose source
 *      is currently NULL. This is the eligible set for SSS auto-
 *      backfill.
 *   3. Run `recoverBookedDataForVenue` against Rixey.
 *   4. Post-run snapshot — re-fetch source distribution + report
 *      delta on `source = 'venue_calculator'`.
 *   5. Cross-venue probe — same eligible-set count for every
 *      non-Rixey venue, so we can see who else benefits from SSS
 *      cron sweeps. (Read-only — no recovery is run on those
 *      venues here; the daily cron handles them.)
 *
 * Idempotent
 * ----------
 * The recovery service's candidate filter restricts to weddings with
 * NULL or 0 booking_value. Once SSS has flipped Paige's source on the
 * first run, day-2 re-runs of THIS script won't process her again
 * (her booking_value is now non-zero, so she's no longer a candidate).
 * Other untouched gaps may still be processed.
 *
 * Run
 * ---
 *   npx tsx scripts/rixey-load/74-sss-rerun-rixey.ts
 *
 * Optional: pass `--dry-run` to skip the recovery call and only
 * print before / cross-venue probe (useful for inspection in
 * production-mirrored environments).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

function loadEnv(): Record<string, string> {
  // Worktree's CWD doesn't carry .env.local; fall back to the main
  // repo's copy. Both share the same Supabase project.
  const candidates = ['.env.local', 'C:\\Users\\Ismar\\bloom-house\\.env.local']
  let raw = ''
  for (const c of candidates) {
    try { raw = readFileSync(c, 'utf8'); break } catch { /* try next */ }
  }
  if (!raw) throw new Error('.env.local not found (looked in worktree + main repo)')
  return Object.fromEntries(
    raw
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
      }),
  )
}

interface SourceDistRow {
  source: string | null
}

async function snapshotSourceDist(
  sb: SupabaseClient,
  venueId: string,
): Promise<Map<string, number>> {
  const { data } = await sb
    .from('weddings')
    .select('source')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
  const dist = new Map<string, number>()
  for (const r of (data ?? []) as SourceDistRow[]) {
    const k = r.source ?? '(NULL)'
    dist.set(k, (dist.get(k) ?? 0) + 1)
  }
  return dist
}

function printDist(label: string, dist: Map<string, number>): void {
  console.log(`  ${label}:`)
  const sorted = [...dist.entries()].sort((a, b) => b[1] - a[1])
  for (const [k, v] of sorted) {
    console.log(`    ${k.padEnd(24)} ${v}`)
  }
}

/**
 * Count weddings (active, status booked/completed) for a venue whose
 * interactions include at least one `@interactivecalculator.com`
 * from-address AND where weddings.source is currently NULL. This is
 * the SSS auto-backfill eligible set.
 */
async function countSssEligibleForVenue(
  sb: SupabaseClient,
  venueId: string,
): Promise<{ eligible: number; weddingIds: string[] }> {
  // Step 1: pull all interactions for the venue from interactive
  // calculator. Interactions table doesn't carry venue_id directly;
  // use wedding-id pivot via join-style fetch in two shots.
  const { data: weddingsRaw } = await sb
    .from('weddings')
    .select('id, source')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .in('status', ['booked', 'completed'])
  const venueWeddings = (weddingsRaw ?? []) as Array<{ id: string; source: string | null }>
  if (venueWeddings.length === 0) return { eligible: 0, weddingIds: [] }

  const nullSourceWeddings = venueWeddings.filter((w) => w.source == null)
  if (nullSourceWeddings.length === 0) return { eligible: 0, weddingIds: [] }

  // Page through wedding_id batches to keep the .in() URL bounded.
  const eligibleIds = new Set<string>()
  const BATCH = 100
  for (let i = 0; i < nullSourceWeddings.length; i += BATCH) {
    const batch = nullSourceWeddings.slice(i, i + BATCH).map((w) => w.id)
    const { data: hits } = await sb
      .from('interactions')
      .select('wedding_id, from_email')
      .in('wedding_id', batch)
      .ilike('from_email', '%@interactivecalculator.com%')
    for (const h of (hits ?? []) as Array<{ wedding_id: string | null }>) {
      if (h.wedding_id) eligibleIds.add(h.wedding_id)
    }
  }

  return { eligible: eligibleIds.size, weddingIds: [...eligibleIds] }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const env = loadEnv()
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  console.log('=== Stream SSS rerun (Rixey source-backfill) ===')
  if (dryRun) console.log('(--dry-run: skipping recovery call)')

  // ---- Pre-run snapshots ----
  console.log('\n--- Pre-run Rixey source distribution ---')
  const distBefore = await snapshotSourceDist(sb, RIXEY_VENUE_ID)
  printDist('BEFORE', distBefore)
  const vcBefore = distBefore.get('venue_calculator') ?? 0

  // SSS-eligible probe for Rixey.
  console.log('\n--- Pre-run SSS-eligible probe (Rixey) ---')
  const rixeyEligible = await countSssEligibleForVenue(sb, RIXEY_VENUE_ID)
  console.log(`  Rixey weddings with @interactivecalculator.com + NULL source: ${rixeyEligible.eligible}`)
  if (rixeyEligible.eligible > 0) {
    console.log(`  candidate wedding ids: ${rixeyEligible.weddingIds.slice(0, 5).join(', ')}${rixeyEligible.eligible > 5 ? ', …' : ''}`)
  }

  // ---- Cross-venue probe (read-only) ----
  console.log('\n--- Cross-venue eligible probe (informational; cron handles these) ---')
  const { data: venuesRaw } = await sb
    .from('venues')
    .select('id, name')
    .neq('id', RIXEY_VENUE_ID)
  const otherVenues = (venuesRaw ?? []) as Array<{ id: string; name: string | null }>

  let crossVenueTotal = 0
  const venueRows: Array<{ id: string; name: string | null; eligible: number }> = []
  for (const v of otherVenues) {
    const r = await countSssEligibleForVenue(sb, v.id)
    if (r.eligible > 0) {
      venueRows.push({ id: v.id, name: v.name, eligible: r.eligible })
      crossVenueTotal += r.eligible
    }
  }
  if (venueRows.length === 0) {
    console.log('  (no other venues currently have eligible weddings)')
  } else {
    console.log(`  other venues with SSS-eligible weddings (count > 0):`)
    for (const r of venueRows.sort((a, b) => b.eligible - a.eligible)) {
      console.log(`    ${(r.name ?? '(unnamed)').padEnd(28)} ${r.id}  eligible=${r.eligible}`)
    }
    console.log(`  cross-venue eligible total: ${crossVenueTotal}`)
  }

  // ---- Recovery run ----
  if (dryRun) {
    console.log('\n--- Skipping recovery (--dry-run) ---')
    return
  }

  console.log('\n--- Running recoverBookedDataForVenue(Rixey) ---')
  const { recoverBookedDataForVenue } = await import('../../src/lib/services/booked-data-recovery.js')
  const report = await recoverBookedDataForVenue(sb, RIXEY_VENUE_ID)
  console.log(`  total_candidates : ${report.totalCandidates}`)
  console.log(`  recovered        : ${report.recovered.length}`)
  console.log(`  merged           : ${report.merged.length}`)
  console.log(`  no_match         : ${report.noMatch.length}`)
  console.log(`  errors           : ${report.errors.length}`)

  if (report.errors.length > 0) {
    console.log('\n  errors detail:')
    for (const e of report.errors) {
      console.log(`    - wedding=${e.weddingId} cap=${e.capability} err=${e.errorMessage}`)
    }
  }

  // ---- Post-run snapshot ----
  console.log('\n--- Post-run Rixey source distribution ---')
  const distAfter = await snapshotSourceDist(sb, RIXEY_VENUE_ID)
  printDist('AFTER', distAfter)
  const vcAfter = distAfter.get('venue_calculator') ?? 0

  const delta = vcAfter - vcBefore
  console.log(`\n  source='venue_calculator' delta: ${delta >= 0 ? '+' : ''}${delta} (was ${vcBefore}, now ${vcAfter})`)

  // ---- SSS-specific audit ----
  console.log('\n--- SSS audit-log slice (calculator_extract recoveries this run) ---')
  const { data: logsRaw } = await sb
    .from('booked_data_recovery_log')
    .select('wedding_id, outcome, recovered_value_cents, evidence, attempted_at')
    .eq('venue_id', RIXEY_VENUE_ID)
    .eq('capability', 'calculator_extract')
    .order('attempted_at', { ascending: false })
    .limit(20)
  const logs = (logsRaw ?? []) as Array<{
    wedding_id: string
    outcome: string
    recovered_value_cents: number | null
    evidence: Record<string, unknown> | null
    attempted_at: string
  }>
  if (logs.length === 0) {
    console.log('  (no calculator_extract log rows for Rixey)')
  } else {
    for (const r of logs) {
      const val = r.recovered_value_cents != null
        ? `$${(r.recovered_value_cents / 100).toFixed(0)}`.padStart(10)
        : '       n/a'
      const inferred = (r.evidence as Record<string, unknown> | null)?.inferred_source ?? '(none)'
      const senderClass = (r.evidence as Record<string, unknown> | null)?.sender_class ?? '(none)'
      console.log(
        `  ${r.wedding_id.slice(0, 8)} ${r.outcome.padEnd(10)} ` +
          `${val} sender=${String(senderClass).padEnd(16)} inferred_source=${inferred}`,
      )
    }
  }

  console.log('\n=== Stream SSS rerun complete ===')
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
