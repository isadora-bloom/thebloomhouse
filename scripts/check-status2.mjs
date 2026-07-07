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

// Check all venue_config fields for this venue
const { data: cfg } = await supabase
  .from('venue_config')
  .select('*')
  .eq('venue_id', VENUE_ID)
console.log('\n=== VENUE CONFIG (all fields) ===')
if (cfg && cfg[0]) {
  // Print fields that contain 'backfill' or 'gmail'
  const row = cfg[0]
  for (const [k, v] of Object.entries(row)) {
    if (k.includes('backfill') || k.includes('gmail') || k.includes('sync')) {
      console.log(`  ${k}: ${JSON.stringify(v)}`)
    }
  }
} else {
  console.log('No venue_config row found')
}

// Also check the gmail_connections table
const { data: connections } = await supabase
  .from('gmail_connections')
  .select('id, email, status, last_sync_at, backfill_status, backfill_phase, backfill_cursor, backfill_emails_processed, backfill_completed_at')
  .eq('venue_id', VENUE_ID)
console.log('\n=== GMAIL CONNECTIONS ===')
for (const c of connections ?? []) {
  console.log(JSON.stringify(c, null, 2))
}

// Interactions by year breakdown
const { data: byYear } = await supabase
  .from('interactions')
  .select('timestamp')
  .eq('venue_id', VENUE_ID)

const yearCounts = {}
for (const i of byYear ?? []) {
  const y = i.timestamp?.slice(0, 4) ?? 'null'
  yearCounts[y] = (yearCounts[y] ?? 0) + 1
}
console.log('\n=== INTERACTIONS BY YEAR ===')
for (const [y, n] of Object.entries(yearCounts).sort()) {
  console.log(`  ${y}: ${n}`)
}

// first_response_at — sample the 3 that have it
const { data: sample } = await supabase
  .from('weddings')
  .select('id, inquiry_date, first_response_at, status')
  .eq('venue_id', VENUE_ID)
  .not('first_response_at', 'is', null)
console.log('\n=== WEDDINGS WITH first_response_at (sample) ===')
for (const w of sample ?? []) {
  console.log(`  ${w.status} | inquiry: ${w.inquiry_date?.slice(0,10)} | first_response: ${w.first_response_at?.slice(0,16)}`)
}
