/**
 * Wave 22 — pre-migration audit on Rixey theknot rows.
 *
 * Reads the existing source-of-truth — role_evidence.llm_judge.prompt_version
 * inside attribution_events — to count how many Rixey theknot rows were
 * classified by the LLM judge under the v1 prompt. This mirrors what mig
 * 288 will backfill into prompt_version_classified_under.
 *
 * Read-only. No LLM calls. Safe to run anywhere with .env.local.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

function extract(lines, key) {
  const line = lines.find((l) => l.startsWith(key + '='))
  return line ? line.slice(key.length + 1).trim() : ''
}

const env = (() => {
  try {
    const text = readFileSync('.env.local', 'utf-8')
    const lines = text.split('\n')
    return {
      url: extract(lines, 'NEXT_PUBLIC_SUPABASE_URL'),
      key: extract(lines, 'SUPABASE_SERVICE_ROLE_KEY'),
    }
  } catch {
    return {
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    }
  }
})()

const sb = createClient(env.url, env.key)
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Pull Rixey theknot rows with role_evidence (which carries the
// prompt_version of the judge that classified them).
const { data, error, count } = await sb
  .from('attribution_events')
  .select('id, source_platform, role, role_confidence_0_100, decided_at, role_evidence', { count: 'exact' })
  .eq('venue_id', RIXEY)
  .ilike('source_platform', '%knot%')
  .is('reverted_at', null)
  .order('decided_at', { ascending: false })
  .limit(500)

if (error) {
  console.error('Query error:', error.message)
  process.exit(1)
}

console.log(`Total Rixey theknot rows pulled: ${count} (showing up to 500)`)

// Bucket by prompt_version
const byVersion = {}
const v1Rows = []
const v1KnotRoleDist = {}
for (const row of data ?? []) {
  const v = row.role_evidence?.llm_judge?.prompt_version ?? '__rule_only__'
  byVersion[v] = (byVersion[v] ?? 0) + 1
  if (v === 'channel-role-classifier.prompt.v1') {
    v1Rows.push(row)
    const k = row.role ?? 'null'
    v1KnotRoleDist[k] = (v1KnotRoleDist[k] ?? 0) + 1
  }
}

console.log('\nClassification source distribution (Rixey theknot):')
for (const [k, v] of Object.entries(byVersion).sort((a, b) => b[1] - a[1])) {
  console.log(`  - ${k}: ${v}`)
}

if (v1Rows.length === 0) {
  console.log('\nNo v1-LLM-judged rows on Rixey theknot. Either:')
  console.log('  - all theknot rows went through forensic rule (rule_only)')
  console.log('  - or LLM-judge column was never populated for theknot')
  process.exit(0)
}

console.log(`\nv1-classified theknot rows: ${v1Rows.length}`)
console.log('v1 role distribution on the v1 sample:')
for (const [k, v] of Object.entries(v1KnotRoleDist).sort((a, b) => b[1] - a[1])) {
  console.log(`  - ${k}: ${v}`)
}

const v1Total = v1Rows.length
const v1ValidationPct = Math.round(100 * (v1KnotRoleDist.validation ?? 0) / v1Total)
console.log(`\nv1 validation %: ${v1ValidationPct}% (n=${v1Total})`)
console.log('Wave 21 cited ~18-19% validation on the broader 433-row Knot cohort under v1.')
console.log('\nThe most recent 20 v1-classified theknot rows are the Wave 22 re-test target.')
console.log('Sample row IDs (most recent 20):')
for (const r of v1Rows.slice(0, 20)) {
  console.log(`  ${r.id}  role=${r.role}  decided_at=${r.decided_at}`)
}
