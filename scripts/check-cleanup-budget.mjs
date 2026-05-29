#!/usr/bin/env node
/**
 * Guard: THE ANTI-BANDAID RATCHET (Mandate M1, FIX-PLAN Layer D).
 *
 * The disease of Bloom House is "we never deleted anything" — every
 * doctrine update layered instead of replaced, so the codebase only
 * grew (378 migrations, 49 crons, ~14 grandfathered insert sites, a
 * 35-table hand-maintained merge list, 5-6 parallel identity modules).
 *
 * The consolidation plan PROMISES to delete these in Phases 3-4, but
 * nothing FORCES the deletion — "disable not delete" and "derive the
 * kill list at Phase 4 start" let the cleanup slip forever. This guard
 * removes the slip: it tracks a set of cleanup metrics that must only
 * ever DECREASE, and fails CI if any of them rises above its committed
 * budget. You cannot add a new grandfather entry, a new cron, or a new
 * duplicate module without the budget visibly going up in the diff —
 * which is exactly the human decision point that was missing.
 *
 * This is how a lint-baseline ratchet works, applied to architectural
 * debt instead of lint warnings.
 *
 * Source of truth: scripts/cleanup-budget.json — a committed file of
 * { metric: budgetedMax }. Each phase boundary lowers these numbers;
 * the Phase-4 ship gate requires them at their target (mostly 0).
 *
 * Workflow:
 *   node scripts/check-cleanup-budget.mjs            # CI: fail if current > budget
 *   node scripts/check-cleanup-budget.mjs --report   # print current vs budget, exit 0
 *   node scripts/check-cleanup-budget.mjs --update    # snapshot current -> budget (intentional; shows in PR diff)
 *
 * Exit 0 = every metric at or below budget. Exit 1 = a metric rose
 * (debt grew) OR a metric is below budget and --update wasn't run to
 * ratchet the budget down (a "you cleaned up, now lock it in" nudge —
 * non-fatal warning, see ALLOW_SLACK).
 *
 * Companion: BLOOM-CONSOLIDATION-GAP-REGISTER.md (M1/M5/G5/G6/G10),
 * check-cascade-only-writer.mjs (the grandfather ledger this measures).
 */

import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/')
const BUDGET_PATH = join(REPO_ROOT, 'scripts', 'cleanup-budget.json')

const MODE =
  process.argv.includes('--update') ? 'update'
  : process.argv.includes('--report') ? 'report'
  : 'check'

// If a metric is BELOW budget (you cleaned up but didn't ratchet the
// budget down), warn but don't fail. Set false to make the ratchet
// strict (forces every cleanup to lower the committed budget in the
// same PR — recommended once the team is in the habit).
const ALLOW_SLACK = true

const read = (rel) => {
  const p = join(REPO_ROOT, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}
const countMatches = (text, re) => (text ? (text.match(re) || []).length : 0)

// ---------------------------------------------------------------------------
// The metrics. Each returns the CURRENT measured value via a robust probe.
// Keep probes dumb and deterministic — a flaky probe makes the ratchet
// untrustworthy. Where a probe is heuristic, say so.
// ---------------------------------------------------------------------------
const METRICS = {
  // G10 — cron count must only fall. Audit found 49 in vercel.json
  // (plan docs say 47 — already stale-grown). Robust: parse the crons array.
  cron_count() {
    const raw = read('vercel.json')
    if (!raw) return 0
    try {
      const json = JSON.parse(raw)
      return Array.isArray(json.crons) ? json.crons.length : 0
    } catch {
      // Fall back to counting "path" keys if JSON is malformed.
      return countMatches(raw, /"path"\s*:/g)
    }
  },

  // G5 — the 5-6 parallel identity modules must collapse to one matcher
  // + one writer. Probe: how many of the known-duplicate modules still
  // exist. Target end-state: identity-cascade.ts + forwards-linker.ts
  // survive; the rest are deleted. Counts files that should eventually
  // be GONE.
  duplicate_identity_modules() {
    const candidates = [
      'src/lib/services/identity/resolver.ts',
      'src/lib/services/identity/resolution.ts',
      'src/lib/services/identity/matcher.ts',
      'src/lib/services/identity/candidate-resolver.ts',
      'src/lib/services/identity/backtrack.ts',
    ]
    return candidates.filter((f) => existsSync(join(REPO_ROOT, f))).length
  },

  // M5/G7 — the mergeWeddings hand-maintained table list. Probe: count
  // literal `reassign('table')` call sites in resolver.ts. A clean
  // implementation (FK cascade or one generated loop) has 0. This is
  // the single clearest "hand-list still here" signal.
  resolver_reassign_calls() {
    return countMatches(read('src/lib/services/identity/resolver.ts'), /\breassign\(\s*['"`]/g)
  },

  // G6/M1 — grandfathered direct-insert bypass sites across the writer
  // guards. Probe: count GRANDFATHERED Map tuple-openers, which begin
  // `[ 'src/...'`. CHOKEPOINT_FILES are bare strings (no leading `[`)
  // so they don't match. Heuristic but stable against this file shape.
  grandfather_entries() {
    const guards = [
      'scripts/check-cascade-only-writer.mjs',
      'scripts/check-no-direct-people-insert.mjs',
      'scripts/check-no-direct-wedding-insert.mjs',
    ]
    let n = 0
    for (const g of guards) {
      const text = read(g)
      // \s matches newlines, so this catches `[\n    'src/...'` too.
      n += countMatches(text, /\[\s*['"`]src\//g)
    }
    return n
  },

  // G19 — migration sprawl. Probe: number of files in supabase/migrations.
  // Not deletable until the Phase-4 baseline flatten, but tracking it
  // means the count can't quietly grow past the budget mid-consolidation
  // without a visible bump. (Legit new migrations DO raise it — that's
  // fine, you ratchet the budget up deliberately and it shows in the diff.)
  migration_files() {
    const dir = join(REPO_ROOT, 'supabase', 'migrations')
    if (!existsSync(dir)) return 0
    return readdirSync(dir).filter((f) => f.endsWith('.sql')).length
  },
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const current = {}
for (const [name, fn] of Object.entries(METRICS)) current[name] = fn()

if (MODE === 'update') {
  writeFileSync(BUDGET_PATH, JSON.stringify(current, null, 2) + '\n')
  console.log('cleanup-budget.json snapshotted to current values:')
  console.log(JSON.stringify(current, null, 2))
  console.log('\nReview the diff — this is a deliberate ratchet change. Commit it in the PR that earned it.')
  process.exit(0)
}

if (!existsSync(BUDGET_PATH)) {
  console.error(
    `\nNo cleanup-budget.json found at ${BUDGET_PATH}.\n`
      + 'Seed it once on the consolidation branch:\n'
      + '  node scripts/check-cleanup-budget.mjs --update\n'
      + 'then commit it. After that, this guard enforces monotonic decrease.\n',
  )
  process.exit(1)
}

const budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'))
const rows = []
let failed = false
let slack = false

for (const name of Object.keys(METRICS)) {
  const cur = current[name]
  const bud = budget[name] ?? Infinity
  let status
  if (cur > bud) {
    status = 'GREW ✗'
    failed = true
  } else if (cur < bud) {
    status = 'below (ratchet down)'
    slack = true
  } else {
    status = 'at budget'
  }
  rows.push({ metric: name, current: cur, budget: bud, status })
}

const pad = (s, n) => String(s).padEnd(n)
console.log('\nCleanup budget (debt must only fall):\n')
console.log(`  ${pad('metric', 28)} ${pad('current', 9)} ${pad('budget', 8)} status`)
for (const r of rows) {
  console.log(`  ${pad(r.metric, 28)} ${pad(r.current, 9)} ${pad(r.budget, 8)} ${r.status}`)
}

if (MODE === 'report') process.exit(0)

if (failed) {
  console.error(
    '\nFAIL — architectural debt grew. A metric rose above its committed budget.\n'
      + 'This is the anti-bandaid ratchet: you cannot ADD a cron, a grandfather\n'
      + 'bypass, or a duplicate module without lowering something else or\n'
      + 'deliberately raising the budget (which shows in the PR diff and needs\n'
      + 'Lead/CEO sign-off per FIX-PLAN Layer B). See BLOOM-CONSOLIDATION-GAP-REGISTER.md.\n',
  )
  process.exit(1)
}

if (slack && !ALLOW_SLACK) {
  console.error(
    '\nFAIL (strict) — a metric is BELOW budget. You cleaned up; now lock it in:\n'
      + '  node scripts/check-cleanup-budget.mjs --update\n'
      + 'and commit the lowered budget so the gain cannot regress.\n',
  )
  process.exit(1)
}

console.log('\nOK — no debt growth.' + (slack ? ' (Some metrics below budget — consider --update to ratchet down.)' : ''))
process.exit(0)
