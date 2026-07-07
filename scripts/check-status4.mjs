import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => {
      const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
)
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Check if venue row actually exists (minimal select)
const { data: venueMin, error: venueErr } = await supabase
  .from('venues')
  .select('id, name')
  .eq('id', VENUE_ID)
  .maybeSingle()
console.log('=== VENUE ROW ===')
console.log(`  found: ${venueMin ? `${venueMin.id} / ${venueMin.name}` : 'null'}`)
if (venueErr) console.log(`  error: ${venueErr.message}`)

// Try backfill columns with error reporting
const { data: venueState, error: stateErr } = await supabase
  .from('venues')
  .select('gmail_backfill_status, gmail_backfill_phase, gmail_backfill_emails')
  .eq('id', VENUE_ID)
  .maybeSingle()
console.log('=== BACKFILL COLUMNS ===')
if (stateErr) console.log(`  column error: ${stateErr.message}`)
else console.log(`  status=${venueState?.gmail_backfill_status ?? 'null'} phase=${venueState?.gmail_backfill_phase ?? 'null'} emails=${venueState?.gmail_backfill_emails ?? 'null'}`)

// Check historical_backfill table if it exists
const { data: hbRows, error: hbErr } = await supabase
  .from('historical_backfill')
  .select('*')
  .limit(5)
console.log('\n=== historical_backfill TABLE ===')
if (hbErr) console.log(`  error: ${hbErr.message}`)
else console.log(`  rows: ${JSON.stringify(hbRows)}`)

// Outbound interactions: how many per wedding, earliest timestamp
const { data: outbound } = await supabase
  .from('interactions')
  .select('wedding_id, timestamp')
  .eq('venue_id', VENUE_ID)
  .eq('direction', 'outbound')
  .not('wedding_id', 'is', null)
  .order('timestamp', { ascending: true })

const byWedding = {}
for (const r of outbound ?? []) {
  if (!byWedding[r.wedding_id]) byWedding[r.wedding_id] = r.timestamp
}
console.log(`\n=== OUTBOUND BY WEDDING ===`)
console.log(`  Distinct weddings with outbound: ${Object.keys(byWedding).length}`)

// Weddings that need first_response_at and have a candidate
const { data: weds } = await supabase
  .from('weddings')
  .select('id, inquiry_date, first_response_at')
  .eq('venue_id', VENUE_ID)
  .is('first_response_at', null)
  .not('inquiry_date', 'is', null)

let fillable = 0
for (const w of weds ?? []) {
  const earliest = byWedding[w.id]
  if (earliest && earliest > w.inquiry_date) fillable++
}
console.log(`  Weddings missing first_response_at: ${weds?.length ?? 0}`)
console.log(`  Fillable from outbound interactions: ${fillable}`)
