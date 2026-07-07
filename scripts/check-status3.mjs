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

// Backfill state is on the venues table
const { data: venue } = await supabase
  .from('venues')
  .select('id, name, gmail_backfill_status, gmail_backfill_phase, gmail_backfill_cursor, gmail_backfill_emails, gmail_backfill_updated_at, gmail_backfill_completed_at')
  .eq('id', VENUE_ID)
  .maybeSingle()

console.log('=== BACKFILL STATUS ===')
if (venue) {
  console.log(`  status:       ${venue.gmail_backfill_status ?? 'null'}`)
  console.log(`  phase:        ${venue.gmail_backfill_phase ?? 'null'}`)
  console.log(`  cursor:       ${venue.gmail_backfill_cursor ?? 'null'}`)
  console.log(`  emails done:  ${venue.gmail_backfill_emails ?? 0}`)
  console.log(`  last updated: ${venue.gmail_backfill_updated_at?.slice(0,19) ?? 'null'}`)
  console.log(`  completed_at: ${venue.gmail_backfill_completed_at?.slice(0,19) ?? 'null (still running)'}`)
} else {
  console.log('  no venue row found')
}

// Interactions by year (full count via multiple queries)
const years = [2021, 2022, 2023, 2024, 2025, 2026]
console.log('\n=== INTERACTIONS BY YEAR ===')
for (const y of years) {
  const { count } = await supabase.from('interactions').select('*', { count: 'exact', head: true })
    .eq('venue_id', VENUE_ID)
    .gte('timestamp', `${y}-01-01`)
    .lt('timestamp', `${y+1}-01-01`)
  console.log(`  ${y}: ${count}`)
}

// first_response_at — how many can we fill now from existing outbound interactions?
const { count: wedNeedingResponse } = await supabase.from('weddings').select('*', { count: 'exact', head: true })
  .eq('venue_id', VENUE_ID)
  .is('first_response_at', null)
  .not('inquiry_date', 'is', null)
const { count: outboundInteractions } = await supabase.from('interactions').select('*', { count: 'exact', head: true })
  .eq('venue_id', VENUE_ID)
  .eq('direction', 'outbound')
  .not('wedding_id', 'is', null)
console.log('\n=== FIRST RESPONSE GAP ===')
console.log(`  Weddings missing first_response_at: ${wedNeedingResponse}`)
console.log(`  Outbound interactions with wedding_id (backfill material): ${outboundInteractions}`)
