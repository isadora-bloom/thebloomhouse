import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const VENUE = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// 1. Current table counts
const tables = ['weddings', 'couples', 'people', 'interactions', 'touchpoints', 'crm_import_rows', 'import_runs']
console.log('=== Table counts ===')
for (const t of tables) {
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('venue_id', VENUE)
  console.log(`  ${t.padEnd(20)} ${error ? '(skip: ' + error.message.slice(0,40) + ')' : count}`)
}

// 2. Most recent import_runs
console.log('\n=== Recent import_runs ===')
const { data: runs } = await sb.from('import_runs')
  .select('*').eq('venue_id', VENUE).order('created_at', { ascending: false }).limit(5)
console.log(JSON.stringify(runs, null, 2))

// 3. Most recent crm_import_rows (sample + status breakdown)
console.log('\n=== crm_import_rows status breakdown ===')
const { data: rows } = await sb.from('crm_import_rows')
  .select('status, error_message').eq('venue_id', VENUE)
if (rows) {
  const counts = {}
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1
  console.log(JSON.stringify(counts))
  const errs = rows.filter(r => r.error_message).slice(0, 5)
  if (errs.length) { console.log('Sample errors:'); errs.forEach(r => console.log(' ', r.status, r.error_message)) }
}

// 4. Sample of what crm_import_rows has (first 3 rows)
console.log('\n=== crm_import_rows sample (first 3) ===')
const { data: sample } = await sb.from('crm_import_rows')
  .select('id, external_id, status, error_message, created_at').eq('venue_id', VENUE)
  .order('created_at', { ascending: false }).limit(3)
console.log(JSON.stringify(sample, null, 2))
