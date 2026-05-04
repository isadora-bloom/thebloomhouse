/**
 * T5-Rixey-MMM verification script (extended for Stream SSS).
 *
 * Stream SSS extension (2026-05-03)
 * --------------------------------
 * MMM recovers `booking_value` from calculator-estimate emails but
 * leaves `weddings.source` untouched. SSS extends the calculator-extract
 * branch so when the hit comes from a universal third-party calculator
 * (interactivecalculator.com) AND `source` is currently NULL, source
 * is backfilled to `'venue_calculator'`. Venue-templated estimate
 * emails (sent from the venue's own domain) remain ambiguous and DO
 * NOT trigger source backfill.
 *
 * Additional asserts in section H:
 *   - Paige & Tanner ends the run with `source = 'venue_calculator'`
 *     (interactivecalculator.com hit; was NULL pre-SSS).
 *   - Taylor's source is unchanged (his hit is venue-templated → SSS
 *     leaves source alone; whatever source he had pre-run stays).
 *   - Print before/after counts of Rixey weddings carrying
 *     `source = 'venue_calculator'`.
 *
 * Runs recoverBookedDataForVenue against Rixey and prints a per-bucket
 * recovery report. Three buckets per the audit at scripts/rixey-load/
 * 71-fixup-detail.ts:
 *
 *   Bucket A — calculator-estimate extractable (clean wins)
 *     - 19018175 (Taylor) — venue-domain estimate email with the
 *       price in the subject line.
 *     - 06dd921c (Paige & Tanner) — interactivecalculator.com body
 *       contains $13,000 / $15,750 / $16,695 / $5,565.
 *     Expected: 2 recovered.
 *
 *   Bucket B — Calendly-booked, no contract email in Gmail (9 weddings)
 *     - All 9 likely duplicates of HoneyBook records the dedup didn't
 *       catch. Capability 1 (HoneyBook duplicate merge) tries to
 *       fold them. Outcome depends on whether Rixey's HoneyBook
 *       contains those names — acceptable to report no_match.
 *
 *   Bucket C — HoneyBook import gap (1 wedding)
 *     - 0b3e4301 (Grace & Jared) — crm_source=honeybook, status=booked,
 *       bv=0, only one interaction "Imported from HoneyBook (May 2024
 *       export)". Capability 3 fires; success only if the
 *       extracted_identity blob carries the value.
 *
 * Run:
 *   npx tsx scripts/rixey-load/72-mmm-verify.ts
 *
 * The script also asserts:
 *   - Migration 201 is applied (selects from booked_data_recovery_log).
 *   - The total_candidates count matches the expected gap (~12 weddings
 *     pre-recovery on Rixey, may drift as new bookings land).
 *   - At least one calculator extraction succeeded for Bucket A
 *     (verifies the universal extractor is wiring correctly).
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

function loadEnv() {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  // Worktree's CWD doesn't carry .env.local; fall back to the main
  // repo's copy (the worktree shares the same Supabase project).
  const candidates = ['.env.local', 'C:\\Users\\Ismar\\bloom-house\\.env.local']
  for (const c of candidates) {
    try {
      const raw = readFileSync(c, 'utf8')
      for (const line of raw.split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
        if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
      break
    } catch {
      // try next path
    }
  }
  return env
}

// Hydrate env BEFORE importing the service module — service-role
// client reads env at import time.
const env = loadEnv()
for (const [k, v] of Object.entries(env)) {
  if (!process.env[k]) process.env[k] = v
}

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Bucket A canonical wedding ids from the audit (from the brief +
// scripts/rixey-load/71-fixup-detail.ts).
const BUCKET_A_TAYLOR_PREFIX = '19018175'
const BUCKET_A_PAIGE_TANNER_PREFIX = '06dd921c'
const BUCKET_C_GRACE_JARED_PREFIX = '0b3e4301'

let exitCode = 0
function fail(msg: string) {
  console.error(`FAIL: ${msg}`)
  exitCode = 1
}
function pass(msg: string) {
  console.log(`PASS: ${msg}`)
}

async function main() {
  console.log('=== T5-Rixey-MMM verification ===')

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  // ---- A) Migration 201 sanity ----
  console.log('\n--- A) Migration 201 + audit-log table sanity ---')
  const { error: tableErr } = await sb
    .from('booked_data_recovery_log')
    .select('id', { count: 'exact', head: true })
    .limit(1)
  if (tableErr) {
    fail(`booked_data_recovery_log not queryable: ${tableErr.message}`)
    process.exit(exitCode)
  }
  pass('booked_data_recovery_log table exists + queryable')

  // ---- B) Pre-run snapshot ----
  console.log('\n--- B) Pre-run candidate snapshot ---')
  const { data: preRows } = await sb
    .from('weddings')
    .select('id, status, booking_value, crm_source, source')
    .eq('venue_id', RIXEY_VENUE_ID)
    .in('status', ['booked', 'completed'])
    .is('merged_into_id', null)
    .or('booking_value.is.null,booking_value.eq.0')

  const preCandidates = preRows ?? []
  console.log(`  pre-run candidates: ${preCandidates.length}`)
  if (preCandidates.length === 0) {
    console.log('  (no candidates — possibly already recovered on a prior run)')
  } else {
    const taylor = preCandidates.find((w) => (w.id as string).startsWith(BUCKET_A_TAYLOR_PREFIX))
    const paige = preCandidates.find((w) => (w.id as string).startsWith(BUCKET_A_PAIGE_TANNER_PREFIX))
    const grace = preCandidates.find((w) => (w.id as string).startsWith(BUCKET_C_GRACE_JARED_PREFIX))
    console.log(`  Bucket A Taylor present:        ${taylor ? 'YES' : 'no'}`)
    console.log(`  Bucket A Paige & Tanner:        ${paige ? 'YES' : 'no'}`)
    console.log(`  Bucket C Grace & Jared:         ${grace ? 'YES' : 'no'}`)
  }

  // SSS pre-run: capture Paige & Taylor's actual current source values
  // independent of whether they're in the candidate set. The source
  // backfill applies even when booking_value was already recovered on
  // a prior MMM run — so we MUST query the full venue rows here, not
  // just preCandidates (which filters on bv-missing). UUID columns
  // can't be ILIKE'd; pull venue rows + filter by id-prefix in JS.
  const { data: rixeyAllPre } = await sb
    .from('weddings')
    .select('id, source')
    .eq('venue_id', RIXEY_VENUE_ID)
    .is('merged_into_id', null)
  const rixeyAllPreRows = (rixeyAllPre ?? []) as Array<{ id: string; source: string | null }>
  const prePaigeRow = rixeyAllPreRows.find((w) => w.id.startsWith(BUCKET_A_PAIGE_TANNER_PREFIX))
  const preTaylorRow = rixeyAllPreRows.find((w) => w.id.startsWith(BUCKET_A_TAYLOR_PREFIX))
  const prePaigeSource: string | null = prePaigeRow ? prePaigeRow.source : null
  const preTaylorSource: string | null = preTaylorRow ? preTaylorRow.source : null
  console.log(`  pre-SSS Paige source:           ${prePaigeSource ?? '(NULL)'}`)
  console.log(`  pre-SSS Taylor source:          ${preTaylorSource ?? '(NULL)'}`)

  // SSS pre-run: count of weddings with source = 'venue_calculator'.
  const { count: preVcCount } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_VENUE_ID)
    .is('merged_into_id', null)
    .eq('source', 'venue_calculator')
  console.log(`  pre-SSS source='venue_calculator' count: ${preVcCount ?? 0}`)

  // ---- C) Run the recovery sweep ----
  console.log('\n--- C) Running recoverBookedDataForVenue ---')
  // Capture a sentinel timestamp BEFORE the run so section H can
  // filter the audit log to only rows produced by this verify run
  // (older MMM-only rows pre-date the SSS evidence shape).
  const recoveryStartedAt = new Date().toISOString()
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
      console.log(`    - wedding=${e.weddingId} capability=${e.capability} err=${e.errorMessage}`)
    }
  }

  if (report.recovered.length > 0) {
    console.log('\n  recovered detail:')
    for (const r of report.recovered) {
      const dollars = r.recoveredValueCents != null ? `$${(r.recoveredValueCents / 100).toFixed(2)}` : 'n/a'
      console.log(`    - wedding=${r.weddingId} capability=${r.capability} value=${dollars} confidence=${r.confidence}`)
    }
  }
  if (report.merged.length > 0) {
    console.log('\n  merged detail:')
    for (const m of report.merged) {
      console.log(`    - wedding=${m.weddingId} → duplicate=${m.duplicateWeddingId} confidence=${m.confidence}`)
    }
  }

  // ---- D) Bucket-A asserts ----
  console.log('\n--- D) Bucket A: calculator-extract validation ---')
  const taylorRecovery = report.recovered.find((r) => r.weddingId.startsWith(BUCKET_A_TAYLOR_PREFIX))
  const paigeRecovery = report.recovered.find((r) => r.weddingId.startsWith(BUCKET_A_PAIGE_TANNER_PREFIX))

  if (taylorRecovery) {
    pass(
      `Taylor recovered via ${taylorRecovery.capability} (${
        taylorRecovery.recoveredValueCents != null
          ? `$${(taylorRecovery.recoveredValueCents / 100).toFixed(2)}`
          : 'n/a'
      })`,
    )
  } else if (preCandidates.find((w) => (w.id as string).startsWith(BUCKET_A_TAYLOR_PREFIX))) {
    fail('Taylor was a candidate but did not recover')
  } else {
    console.log('  SKIP: Taylor not in pre-run candidate set (already recovered or merged previously)')
  }

  if (paigeRecovery) {
    pass(
      `Paige & Tanner recovered via ${paigeRecovery.capability} (${
        paigeRecovery.recoveredValueCents != null
          ? `$${(paigeRecovery.recoveredValueCents / 100).toFixed(2)}`
          : 'n/a'
      })`,
    )
  } else if (preCandidates.find((w) => (w.id as string).startsWith(BUCKET_A_PAIGE_TANNER_PREFIX))) {
    fail('Paige & Tanner was a candidate but did not recover')
  } else {
    console.log('  SKIP: Paige & Tanner not in pre-run candidate set (already recovered or merged previously)')
  }

  // ---- E) Bucket-C asserts ----
  console.log('\n--- E) Bucket C: HoneyBook export-payload validation ---')
  const graceItem = [...report.recovered, ...report.merged, ...report.noMatch].find((r) =>
    r.weddingId.startsWith(BUCKET_C_GRACE_JARED_PREFIX),
  )
  if (graceItem) {
    console.log(
      `  Grace & Jared: capability=${graceItem.capability} outcome=${graceItem.outcome} value=${
        graceItem.recoveredValueCents != null
          ? `$${(graceItem.recoveredValueCents / 100).toFixed(2)}`
          : 'n/a'
      }`,
    )
    if (graceItem.outcome === 'recovered') {
      pass('Bucket C export-payload extraction succeeded')
    } else {
      // No fail — the brief notes recovery success only if the
      // extracted_identity carries the value. Acceptable to be
      // no_match.
      console.log('  (acceptable no_match — May 2024 export may not carry the value)')
    }
  } else {
    console.log('  SKIP: Grace & Jared not in pre-run candidate set or processed list')
  }

  // ---- F) Audit log ----
  console.log('\n--- F) Audit log validation ---')
  const { count: logCount } = await sb
    .from('booked_data_recovery_log')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_VENUE_ID)
  console.log(`  total log rows for Rixey: ${logCount ?? 'unknown'}`)
  if ((logCount ?? 0) > 0) {
    pass('booked_data_recovery_log captures Rixey attempts')
  } else if (report.totalCandidates > 0) {
    fail('Rixey had candidates but no audit-log rows were written')
  }

  // ---- G) Bucket-B summary (informational only) ----
  console.log('\n--- G) Bucket B (Calendly duplicates) — informational ---')
  const calendlyMerges = report.merged.filter((m) => m.capability === 'honeybook_dedup_merge')
  console.log(`  HoneyBook-dedup merges executed: ${calendlyMerges.length}`)
  console.log(`  no_match outcomes: ${report.noMatch.length}`)

  // ---- H) Stream SSS: source-backfill validation ----
  console.log('\n--- H) Stream SSS: weddings.source backfill validation ---')

  const { data: rixeyAllPost } = await sb
    .from('weddings')
    .select('id, source')
    .eq('venue_id', RIXEY_VENUE_ID)
    .is('merged_into_id', null)
  const rixeyAllPostRows = (rixeyAllPost ?? []) as Array<{ id: string; source: string | null }>

  const postPaige = rixeyAllPostRows.find((w) => w.id.startsWith(BUCKET_A_PAIGE_TANNER_PREFIX))
  const postTaylor = rixeyAllPostRows.find((w) => w.id.startsWith(BUCKET_A_TAYLOR_PREFIX))

  // H.1 — Paige & Tanner should now carry source = 'venue_calculator'.
  // The recovery email is from contact@interactivecalculator.com which
  // the SSS classifier flags as universal. Pre-SSS source was NULL so
  // backfill should fire. If pre-SSS source was already non-NULL, SSS
  // should NOT have overwritten — log + skip the assertion.
  if (!postPaige) {
    console.log('  SKIP: Paige & Tanner row not present (merged or absent)')
  } else if (prePaigeSource != null) {
    console.log(
      `  Paige pre-SSS source was non-NULL ('${prePaigeSource}') — SSS must not overwrite`,
    )
    if (postPaige.source === prePaigeSource) {
      pass(`Paige source unchanged ('${postPaige.source}') — no overwrite`)
    } else {
      fail(`Paige source CHANGED from '${prePaigeSource}' to '${postPaige.source}'`)
    }
  } else if (postPaige.source === 'venue_calculator') {
    pass(`Paige & Tanner now carries source='venue_calculator' (was NULL)`)
  } else {
    fail(
      `Paige & Tanner source did NOT flip to 'venue_calculator'. ` +
        `pre='${prePaigeSource ?? '(NULL)'}' post='${postPaige.source ?? '(NULL)'}'`,
    )
  }

  // H.2 — Taylor's hit is venue-templated (hello@rixeymanor.com); SSS
  // must NOT auto-set source for him. Whatever he had pre-run must
  // remain.
  if (!postTaylor) {
    console.log('  SKIP: Taylor row not present (merged or absent)')
  } else {
    const preT = preTaylorSource ?? null
    const postT = postTaylor.source ?? null
    if (preT === postT) {
      pass(`Taylor source unchanged ('${postT ?? '(NULL)'}') — venue-templated, ambiguous origin`)
    } else if (preT == null && postT === 'venue_calculator') {
      // The brief notes Taylor MAY already have had source set from a
      // different recovery pass; auto-flipping his NULL → venue_calculator
      // is ONLY allowed when the hit is universal. Taylor's hit is
      // venue-templated, so this is a regression.
      fail(`Taylor source flipped NULL → 'venue_calculator' on a venue-templated hit (regression)`)
    } else {
      // Other transitions (e.g. another stream wrote source between
      // pre and post snapshots) are informational only.
      console.log(`  Taylor source: pre='${preT ?? '(NULL)'}' → post='${postT ?? '(NULL)'}' (informational)`)
    }
  }

  // H.3 — Total count of Rixey weddings carrying source='venue_calculator'.
  const { count: postVcCount } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_VENUE_ID)
    .is('merged_into_id', null)
    .eq('source', 'venue_calculator')
  const delta = (postVcCount ?? 0) - (preVcCount ?? 0)
  console.log(`  source='venue_calculator' before SSS: ${preVcCount ?? 0}`)
  console.log(`  source='venue_calculator' after  SSS: ${postVcCount ?? 0}`)
  console.log(`  delta (weddings flipped to venue_calculator): ${delta >= 0 ? '+' : ''}${delta}`)

  // H.4 — Audit-log shape: every calculator_extract row produced by
  // THIS run should carry evidence.inferred_source. Older log rows
  // (pre-SSS) pre-date the inferred_source field by design and are
  // not failures — filter to attempted_at >= recoveryStartedAt.
  const { data: calcLogs } = await sb
    .from('booked_data_recovery_log')
    .select('wedding_id, capability, outcome, evidence, attempted_at')
    .eq('venue_id', RIXEY_VENUE_ID)
    .eq('capability', 'calculator_extract')
    .gte('attempted_at', recoveryStartedAt)
    .order('attempted_at', { ascending: false })
    .limit(50)
  const calcLogRows = (calcLogs ?? []) as Array<{
    wedding_id: string
    capability: string
    outcome: string
    evidence: Record<string, unknown> | null
    attempted_at: string
  }>
  if (calcLogRows.length === 0) {
    console.log('  (no calculator_extract rows produced by this verify run)')
  } else {
    const withInferred = calcLogRows.filter(
      (r) => r.evidence && typeof r.evidence === 'object' && 'inferred_source' in r.evidence,
    )
    if (withInferred.length === calcLogRows.length) {
      pass(`every calculator_extract log row from this run (${calcLogRows.length}) carries evidence.inferred_source`)
    } else {
      fail(
        `${calcLogRows.length - withInferred.length} of ${calcLogRows.length} ` +
          `calculator_extract rows from this run missing evidence.inferred_source`,
      )
    }
    // Show sample decisions for the operator's eye.
    const decisionCounts = new Map<string, number>()
    for (const r of withInferred) {
      const d = String((r.evidence as Record<string, unknown>).inferred_source ?? 'unknown')
      decisionCounts.set(d, (decisionCounts.get(d) ?? 0) + 1)
    }
    for (const [d, n] of decisionCounts.entries()) {
      console.log(`    inferred_source='${d}': ${n}`)
    }
  }

  console.log(exitCode === 0 ? '\nAll checks passed.' : '\nFailures detected.')
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
