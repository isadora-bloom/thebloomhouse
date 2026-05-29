#!/usr/bin/env node
/**
 * Guard: every venue-scoped table has RLS + a venue_id policy
 * (Gap G17 / FIX-PLAN §1.6 — the guard the plan requires but that
 * does not exist yet).
 *
 * Multi-tenant isolation is a Canonical v1.0 non-negotiable (§3.6):
 * "no scenario in which a read from one venue's scope is caused by an
 * event in another venue's scope." The consolidation defers verifying
 * this to the FINAL Phase-4 gate, against a second venue that doesn't
 * exist yet — i.e. ~15 weeks of writer/reader surgery with the
 * isolation invariant untested. This guard makes it a per-commit check.
 *
 * Heuristic (static scan of supabase/migrations/*.sql):
 *   1. Collect tables that HAVE a venue_id column (CREATE TABLE … venue_id,
 *      or ALTER TABLE … ADD … venue_id).
 *   2. Collect tables with `ENABLE ROW LEVEL SECURITY`.
 *   3. Collect tables that have at least one policy referencing venue_id.
 *   4. A venue_id table that is missing (2) or (3) is a potential leak —
 *      reported unless it's in ALLOWLIST with a justification.
 *
 * This is a STATIC heuristic, not a live RLS test (policies can be added
 * in later migrations — the scan unions across all files, so that's
 * handled; but it cannot prove a policy is CORRECT, only present). Pair
 * it with the Phase-4 live two-venue isolation test. The PII tables the
 * audit flagged (notifications, wedding_timeline) and the 13 default-deny
 * tables should appear here until fixed.
 *
 * Usage: node scripts/check-rls-on-venue-id.mjs [--report]
 * Exit 0 = clean (or report mode). Exit 1 = unallowlisted gap.
 *
 * Companion: BLOOM-CONSOLIDATION-GAP-REGISTER.md G17, CONSOLIDATION-AUDIT.md §G.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/')
const MIG_DIR = join(REPO_ROOT, 'supabase', 'migrations')
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'rls-baseline.json')
const REPORT = process.argv.includes('--report')   // print full list, exit 0
const UPDATE = process.argv.includes('--update')    // snapshot current gap count as baseline

// Tables intentionally NOT venue-isolated (global/reference data, or
// venue_id-bearing but isolated by another column). Each needs a reason.
const ALLOWLIST = new Map([
  // ['platform_benchmarks', 'cross-venue aggregate by design (min cohort >= 10) — not venue-isolated'],
  // ['venues', 'the tenant registry itself'],
])

if (!existsSync(MIG_DIR)) {
  console.log('check-rls-on-venue-id: no supabase/migrations dir. Skipping.')
  process.exit(0)
}

const sql = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(MIG_DIR, f), 'utf8'))
  .join('\n')

const venueIdTables = new Set()
const rlsEnabled = new Set()
const venuePolicyTables = new Set()

// 1. CREATE TABLE blocks that contain a venue_id column.
//    Grab "CREATE TABLE [IF NOT EXISTS] <name> ( … )" and check the body.
for (const m of sql.matchAll(
  /create\s+table\s+(?:if\s+not\s+exists\s+)?["']?(?:public\.)?(\w+)["']?\s*\(([\s\S]*?)\n\s*\)\s*;/gi,
)) {
  const [, table, body] = m
  if (/\bvenue_id\b/i.test(body)) venueIdTables.add(table)
}
// 1b. ALTER TABLE … ADD … venue_id
for (const m of sql.matchAll(
  /alter\s+table\s+(?:if\s+exists\s+)?["']?(?:public\.)?(\w+)["']?\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?["']?venue_id\b/gi,
)) {
  venueIdTables.add(m[1])
}

// 2. ENABLE ROW LEVEL SECURITY
for (const m of sql.matchAll(
  /alter\s+table\s+(?:if\s+exists\s+)?["']?(?:public\.)?(\w+)["']?\s+enable\s+row\s+level\s+security/gi,
)) {
  rlsEnabled.add(m[1])
}

// 3. CREATE POLICY … ON <table> … (body references venue_id)
for (const m of sql.matchAll(
  /create\s+policy\s+[\s\S]*?\son\s+["']?(?:public\.)?(\w+)["']?([\s\S]*?);/gi,
)) {
  const [, table, body] = m
  if (/\bvenue_id\b/i.test(body)) venuePolicyTables.add(table)
}

const gaps = []
for (const t of [...venueIdTables].sort()) {
  if (ALLOWLIST.has(t)) continue
  const missingRls = !rlsEnabled.has(t)
  const missingPolicy = !venuePolicyTables.has(t)
  if (missingRls || missingPolicy) {
    gaps.push({
      table: t,
      issue: [missingRls ? 'no ENABLE RLS' : null, missingPolicy ? 'no venue_id policy' : null]
        .filter(Boolean)
        .join(' + '),
    })
  }
}

console.log(
  `check-rls-on-venue-id: ${venueIdTables.size} venue_id tables, `
    + `${rlsEnabled.size} RLS-enabled, ${venuePolicyTables.size} with a venue_id policy, `
    + `${gaps.length} isolation gap(s).`,
)

// --update: snapshot current gap count as the baseline (deliberate ratchet move).
if (UPDATE) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ gaps: gaps.length }, null, 2) + '\n')
  console.log(`rls-baseline.json set to { gaps: ${gaps.length} }. Commit it; the count may only fall.`)
  process.exit(0)
}

if (gaps.length === 0) {
  console.log('OK — every venue_id table has RLS + a venue_id policy.')
  process.exit(0)
}

// Always print the full list so the debt is visible every run.
const log = REPORT ? console.log : console.error
log('\nvenue_id tables missing isolation (potential cross-venue leak):\n')
for (const g of gaps) log(`  ${g.table}: ${g.issue}`)
log(
  '\nThis is a RATCHET (gap G17): the count may only DECREASE. Add `ENABLE ROW LEVEL\n'
    + 'SECURITY` + a `USING (venue_id = …)` policy in a migration to fix a table, or\n'
    + 'allowlist genuinely-global tables in this script with a justification. Canonical\n'
    + 'v1.0 §3.6 — venue isolation is a non-negotiable.\n',
)

if (REPORT) process.exit(0)

// Enforce: fail only if the gap count GREW past the committed baseline.
const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).gaps : null
if (baseline === null) {
  console.error(`No rls-baseline.json — seed it once: node scripts/check-rls-on-venue-id.mjs --update, then commit.\n`)
  process.exit(1)
}
if (gaps.length > baseline) {
  console.error(`FAIL — RLS isolation gaps rose ${baseline} → ${gaps.length}. A new venue_id table shipped without a policy. Add the policy (don't raise the baseline).\n`)
  process.exit(1)
}
console.log(`\nOK — ${gaps.length} gap(s), at or below baseline ${baseline}.`
  + (gaps.length < baseline ? ' You closed some — run --update to ratchet the baseline down.' : ''))
process.exit(0)
