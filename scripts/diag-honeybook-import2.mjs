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

// 1. import_runs without venue_id filter
console.log('=== import_runs (all) ===')
const { data: runs, error: rErr } = await sb.from('import_runs').select('*').order('created_at', { ascending: false }).limit(10)
if (rErr) console.log('error:', rErr.message)
else console.log(JSON.stringify(runs, null, 2))

// 2. Wedding status breakdown
console.log('\n=== weddings by status ===')
const { data: weds } = await sb.from('weddings').select('status').eq('venue_id', VENUE)
if (weds) {
  const counts = {}
  for (const w of weds) counts[w.status ?? 'null'] = (counts[w.status ?? 'null'] ?? 0) + 1
  console.log(JSON.stringify(counts))
}

// 3. Sample of booked weddings (should have honeybook_contact_id or crm data)
console.log('\n=== sample booked weddings ===')
const { data: booked } = await sb.from('weddings').select('id, status, wedding_date, primary_contact_email, created_at, source').eq('venue_id', VENUE).eq('status', 'booked').limit(5)
console.log(JSON.stringify(booked, null, 2))

// 4. crm_import_rows without venue_id filter (check if venue_id col exists)
console.log('\n=== crm_import_rows (no venue filter, limit 5) ===')
const { data: crmRows, error: cErr } = await sb.from('crm_import_rows').select('*').limit(5)
if (cErr) console.log('error:', cErr.message)
else console.log(JSON.stringify(crmRows, null, 2))

// 5. What sources built the 98 weddings?
console.log('\n=== weddings by source ===')
const { data: wSrc } = await sb.from('weddings').select('source').eq('venue_id', VENUE)
if (wSrc) {
  const counts = {}
  for (const w of wSrc) counts[w.source ?? 'null'] = (counts[w.source ?? 'null'] ?? 0) + 1
  console.log(JSON.stringify(counts))
}

// 6. Email sync state
console.log('\n=== email_sync_state ===')
const { data: ess } = await sb.from('email_sync_state').select('*').eq('venue_id', VENUE)
console.log(JSON.stringify(ess, null, 2))
