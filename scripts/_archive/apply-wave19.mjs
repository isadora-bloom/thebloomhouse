// Verify Wave 19 migration 286 (knowledge_captures + knowledge_gaps augment).
//
// Use this AFTER running: npx tsx scripts/run-migration.ts supabase/migrations/286_knowledge_capture.sql
// (The run-migration script handles multi-statement migrations correctly.)
//
// Usage:
//   node scripts/apply-wave19.mjs

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

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

console.log('=== Verifying Wave 19 schema ===')
let fail = 0

// 1. knowledge_captures table reachable
const { error: capErr } = await sb
  .from('knowledge_captures')
  .select('id, venue_id, knowledge_gap_id, question, answer, tags, source_kind, confidence_0_100, applies_until, active, created_at, updated_at')
  .limit(1)
if (capErr) {
  console.log('  ✗ knowledge_captures:', capErr.message)
  fail++
} else {
  console.log('  ✓ knowledge_captures (full schema)')
}

// 2. knowledge_gaps augmented columns
const { data: gapRow, error: gapErr } = await sb
  .from('knowledge_gaps')
  .select('id, captured_at, captured_id, dismissed_at, dismissed_reason')
  .limit(1)
  .maybeSingle()
if (gapErr) {
  console.log('  ✗ knowledge_gaps augmented columns:', gapErr.message)
  fail++
} else {
  console.log('  ✓ knowledge_gaps.captured_* + dismissed_* columns present')
}

// 3. Existing knowledge_gaps rows untouched
const { count: existingCount } = await sb
  .from('knowledge_gaps')
  .select('id', { count: 'exact', head: true })
console.log(`  ✓ existing knowledge_gaps row count: ${existingCount}`)

// 4. Round-trip a capture write
if (gapRow?.id) {
  const { data: venueRow } = await sb.from('knowledge_gaps').select('venue_id').eq('id', gapRow.id).maybeSingle()
  if (venueRow?.venue_id) {
    const { data: ins, error: insErr } = await sb
      .from('knowledge_captures')
      .insert({
        venue_id: venueRow.venue_id,
        question: '__wave19_test_question',
        answer: 'wave19 verify',
        tags: ['pricing'],
        source_kind: 'operator_input',
      })
      .select('id')
      .single()
    if (insErr) {
      console.log('  ✗ insert capture:', insErr.message)
      fail++
    } else {
      console.log('  ✓ insert capture round-trip OK:', ins.id)
      await sb.from('knowledge_captures').delete().eq('id', ins.id)
    }
  }
}

if (fail > 0) {
  console.error('\nfailures:', fail)
  process.exit(1)
}
console.log('\nALL OK')
