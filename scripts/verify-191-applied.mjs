// Verify migration 191 applied successfully — probes each signal_class
// column + the new attribution_parity_log table + reports backfill counts.
//
// Run: node scripts/verify-191-applied.mjs

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

const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

const TABLES = ['interactions', 'tours', 'tangential_signals', 'lost_deals', 'attribution_events']
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

console.log('=== Migration 191 verification ===\n')

// 1. Column existence + per-class counts.
for (const t of TABLES) {
  console.log(`Table: ${t}`)
  const { error: colCheck } = await sb.from(t).select('signal_class').limit(1)
  if (colCheck) {
    console.log(`  signal_class column: MISSING (${colCheck.message})`)
    continue
  }
  console.log(`  signal_class column: present`)
  for (const cls of ['source', 'touchpoint', 'crm', 'outcome', 'unclassified']) {
    const { count, error } = await sb.from(t)
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', RIXEY)
      .eq('signal_class', cls)
    if (error) {
      console.log(`    ${cls.padEnd(14)} error: ${error.message.slice(0, 60)}`)
    } else {
      console.log(`    ${cls.padEnd(14)} ${count ?? 0}`)
    }
  }
}

// 2. attribution_parity_log table.
console.log('\nTable: attribution_parity_log')
const { error: pErr, count: pCount } = await sb.from('attribution_parity_log')
  .select('id', { count: 'exact', head: true })
if (pErr) {
  console.log(`  status: MISSING (${pErr.message})`)
} else {
  console.log(`  status: present (${pCount ?? 0} rows)`)
}
