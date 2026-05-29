#!/usr/bin/env node
/**
 * Guard: plan-as-source-of-truth (FIX-PLAN Layer B.2, Mandate B.2).
 *
 * The rule that 378 migrations prove House never had: every change
 * cites the section of the plan it implements. Code without a plan-trace
 * is rejected — either it's out of scope (cut it) or the plan is
 * incomplete (amend the plan first, then build). This is the single
 * discipline that stops drift.
 *
 * This guard scans the commit messages on the current branch (vs the
 * base) and requires each non-merge commit to cite a plan anchor:
 * a `§`, a `Phase N` / `Batch N`, a mandate id (`M3`, `G7`), a golden
 * case (`GC-4`), or `Implements <DOC>`. A commit that cites nothing is
 * a drift risk and fails CI.
 *
 * Usage:
 *   node scripts/check-pr-cites-section.mjs                 # base = origin/master
 *   node scripts/check-pr-cites-section.mjs --base <ref>
 *
 * Exit 0 = every commit cites a plan anchor (or we're on the base
 * branch / no new commits). Exit 1 = an un-traced commit exists.
 *
 * Companion: BLOOM-CONSOLIDATION-GAP-REGISTER.md, FIX-PLAN §B.2.
 */

import { execSync } from 'node:child_process'

const baseArgIdx = process.argv.indexOf('--base')
const BASE = baseArgIdx !== -1 ? process.argv[baseArgIdx + 1] : 'origin/master'

// A commit "cites the plan" if its message matches any of these. Kept
// deliberately lenient — we want a real reference, not a format war.
const CITATION = new RegExp(
  [
    '§\\s*\\d',                       // §1.2
    '\\bPhase\\s+\\d',                // Phase 1
    '\\bBatch\\s+\\d',                // Batch 2
    '\\bGC-\\d',                      // GC-4 (golden case)
    '\\b[MG]\\d{1,2}\\b',             // M3 / G7 (mandate / gap id)
    '\\bImplements\\b',               // Implements <doc>
    '\\b(PLAN|FIX-PLAN|CASCADE-CANONICAL|INTEL-CANONICAL|CANONICAL-RECONCILIATION|GAP-REGISTER)\\b',
  ].join('|'),
  'i',
)

// Commits exempt from the rule (mechanical/no-logic).
const EXEMPT = /^(Merge|Revert|chore\(release\)|bump version|wip:)/i

function sh(cmd) {
  return execSync(cmd, { cwd: process.cwd(), encoding: 'utf8' }).trim()
}

let range
try {
  // Resolve the merge-base so we only inspect THIS branch's commits.
  const mb = sh(`git merge-base ${BASE} HEAD`)
  range = `${mb}..HEAD`
} catch {
  console.log(`check-pr-cites-section: base ${BASE} not found (fresh clone / detached). Skipping.`)
  process.exit(0)
}

const raw = sh(`git log --no-merges --format=%H%x1f%s%x1f%b%x1e ${range}`)
if (!raw) {
  console.log('check-pr-cites-section: no new commits vs base. OK.')
  process.exit(0)
}

const commits = raw
  .split('\x1e')
  .map((c) => c.trim())
  .filter(Boolean)
  .map((c) => {
    const [hash, subject, body = ''] = c.split('\x1f')
    return { hash, subject, body }
  })

const offenders = []
for (const c of commits) {
  if (EXEMPT.test(c.subject)) continue
  const text = `${c.subject}\n${c.body}`
  if (!CITATION.test(text)) offenders.push(c)
}

if (offenders.length === 0) {
  console.log(`check-pr-cites-section: all ${commits.length} commit(s) cite a plan anchor. OK.`)
  process.exit(0)
}

console.error('\nFAIL — commits without a plan-trace (FIX-PLAN §B.2):\n')
for (const c of offenders) {
  console.error(`  ${c.hash.slice(0, 9)}  ${c.subject}`)
}
console.error(
  '\nEvery commit must cite the plan section it implements — a §, a Phase/Batch,\n'
    + 'a mandate (M3) or gap (G7) id, a golden case (GC-4), or "Implements <DOC>".\n'
    + 'If the work has no home in the plan, it is out of scope (cut it) or the plan\n'
    + 'is incomplete (amend it first, with Lead/CEO sign-off). See BLOOM-CONSOLIDATION-GAP-REGISTER.md.\n',
)
process.exit(1)
