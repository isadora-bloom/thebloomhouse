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

// 1. Backfill status
const { data: cfgRows } = await supabase
  .from('venue_config')
  .select('gmail_backfill_status, gmail_backfill_phase, gmail_backfill_cursor, gmail_backfill_emails, gmail_backfill_started_at, gmail_backfill_completed_at')
  .eq('venue_id', VENUE_ID)
console.log('\n=== BACKFILL STATUS ===')
console.log(JSON.stringify(cfgRows?.[0] ?? null, null, 2))

// 2. first_response_at coverage
const { count: total } = await supabase.from('weddings').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID)
const { count: hasResponse } = await supabase.from('weddings').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID).not('first_response_at', 'is', null)
const { count: hasInquiry } = await supabase.from('weddings').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID).not('inquiry_date', 'is', null)
console.log('\n=== first_response_at COVERAGE ===')
console.log(`Total weddings: ${total}`)
console.log(`Has inquiry_date: ${hasInquiry}`)
console.log(`Has first_response_at: ${hasResponse}`)

// 3. lead_source coverage
const { count: hasLeadSource } = await supabase.from('weddings').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID).not('lead_source', 'is', null)
const { count: nullLeadSource } = await supabase.from('weddings').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID).is('lead_source', null)
console.log('\n=== LEAD SOURCE COVERAGE ===')
console.log(`Has lead_source: ${hasLeadSource} / ${total}`)
console.log(`Still null: ${nullLeadSource}`)

// 4. Interactions
const { count: totalInteractions } = await supabase.from('interactions').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID)
const { count: pre2026 } = await supabase.from('interactions').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID).lt('timestamp', '2026-01-01')
const { data: earliest } = await supabase.from('interactions').select('timestamp').eq('venue_id', VENUE_ID).order('timestamp', { ascending: true }).limit(1)
const { data: latest } = await supabase.from('interactions').select('timestamp').eq('venue_id', VENUE_ID).order('timestamp', { ascending: false }).limit(1)
console.log('\n=== INTERACTIONS ===')
console.log(`Total: ${totalInteractions}`)
console.log(`Pre-2026 (historical backfill): ${pre2026}`)
console.log(`Earliest: ${earliest?.[0]?.timestamp?.slice(0,10)}`)
console.log(`Latest: ${latest?.[0]?.timestamp?.slice(0,10)}`)

// 5. Battery-critical checks
const { count: bookedCount } = await supabase.from('weddings').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID).eq('status', 'booked')
const { count: bookedWithValue } = await supabase.from('weddings').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID).eq('status', 'booked').not('booking_value', 'is', null).gt('booking_value', 0)
console.log('\n=== BOOKED DATA ===')
console.log(`Booked weddings: ${bookedCount}`)
console.log(`With booking_value: ${bookedWithValue}`)
console.log(`Missing booking_value: ${bookedCount - bookedWithValue}`)
