/**
 * Phase B matcher 90% acceptance gate.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §2 last paragraph: "50
 * hand-labeled candidate pairs from Rixey historical data with
 * expected tier. Matcher must hit 90% agreement before shipping."
 *
 * How to run
 * ----------
 *   npx tsx scripts/matcher-acceptance.ts
 *
 * Exit codes
 * ----------
 *   0   ≥90% agreement (gate passes — Phase B Tracer is unblocked)
 *   1   <90% agreement (gate fails — print per-pair disagreements
 *       grouped by direction so the matcher weights can be tuned)
 *
 * No DB access; pure-TS run of matcher.ts against the JSON fixture.
 * Safe to run in CI.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scoreCandidate, type MatchableRecord, type MatchTier } from '../src/lib/services/identity/matcher'

interface FixtureCase {
  case_id: string
  primary: MatchableRecord
  secondary: MatchableRecord
  expected_tier: MatchTier
  notes?: string
}

interface Fixture {
  pairs: FixtureCase[]
}

const fixturePath = join(__dirname, 'matcher-fixture.json')
const raw = readFileSync(fixturePath, 'utf-8')
const fixture = JSON.parse(raw) as Fixture

const ACCEPT_THRESHOLD = 0.9

interface CaseResult {
  case_id: string
  expected: MatchTier
  actual: MatchTier
  score: number
  signals: string[]
  pass: boolean
  notes?: string
}

const results: CaseResult[] = []

for (const c of fixture.pairs) {
  const verdict = scoreCandidate(c.primary, c.secondary)
  results.push({
    case_id: c.case_id,
    expected: c.expected_tier,
    actual: verdict.tier,
    score: verdict.score,
    signals: verdict.signals.map((s) => `${s.name}=${s.weight}`),
    pass: verdict.tier === c.expected_tier,
    notes: c.notes,
  })
}

const total = results.length
const passes = results.filter((r) => r.pass).length
const rate = total === 0 ? 0 : passes / total

console.log('\n=== Phase B matcher acceptance ===')
console.log(`Cases:    ${total}`)
console.log(`Passes:   ${passes}`)
console.log(`Failures: ${total - passes}`)
console.log(`Rate:     ${(rate * 100).toFixed(1)}%`)
console.log(`Gate:     ${(ACCEPT_THRESHOLD * 100).toFixed(0)}%`)

const showDisagreements = rate < ACCEPT_THRESHOLD || process.argv.includes('--verbose')
if (showDisagreements) {
  console.log('\n--- Disagreements (matcher vs human label) ---')
  const overMerge: CaseResult[] = []
  const underMerge: CaseResult[] = []
  const other: CaseResult[] = []
  const tierRank: Record<MatchTier, number> = {
    high: 3,
    medium: 2,
    low: 1,
    below_threshold: 0,
  }
  for (const r of results) {
    if (r.pass) continue
    const a = tierRank[r.actual]
    const e = tierRank[r.expected]
    if (a > e) overMerge.push(r)
    else if (a < e) underMerge.push(r)
    else other.push(r)
  }
  const printGroup = (label: string, list: CaseResult[]) => {
    if (list.length === 0) return
    console.log(`\n[${label}] (${list.length})`)
    for (const r of list) {
      console.log(`  ${r.case_id}: expected=${r.expected} actual=${r.actual} score=${r.score}`)
      console.log(`    signals: ${r.signals.length === 0 ? '(none)' : r.signals.join(' + ')}`)
      if (r.notes) console.log(`    notes:   ${r.notes}`)
    }
  }
  printGroup('OVER-MERGE (matcher hotter than label — risks false positives)', overMerge)
  printGroup('UNDER-MERGE (matcher cooler than label — risks missed promotion)', underMerge)
  printGroup('SAME-RANK MISMATCH', other)
}

if (rate < ACCEPT_THRESHOLD) {
  console.log('\nGate FAILED. Tune weights or relabel the fixture before Phase B ships.')
  process.exit(1)
}

console.log('\nGate PASSED. Phase B matcher is unblocked.')
process.exit(0)
