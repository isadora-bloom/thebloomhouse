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

const { count: total } = await supabase.from('weddings').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID)
const { count: hasSource } = await supabase.from('weddings').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID).not('lead_source', 'is', null)
const { count: nullSource } = await supabase.from('weddings').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID).is('lead_source', null)

console.log(`Lead source coverage: ${hasSource}/${total} (${nullSource} still null)`)

// Breakdown by source
const { data: breakdown } = await supabase.from('weddings').select('lead_source').eq('venue_id', VENUE_ID).not('lead_source', 'is', null)
const counts = {}
for (const r of breakdown ?? []) {
  counts[r.lead_source] = (counts[r.lead_source] ?? 0) + 1
}
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
console.log('\nBy source:')
for (const [src, n] of sorted) console.log(`  ${src}: ${n}`)

// first_response_at coverage
const { count: hasResponse } = await supabase.from('weddings').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID).not('first_response_at', 'is', null)
console.log(`\nfirst_response_at: ${hasResponse}/${total}`)

// booking_value — still missing?
const { count: bookedTotal } = await supabase.from('weddings').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID).eq('status', 'booked')
const { count: bookedWithValue } = await supabase.from('weddings').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID).eq('status', 'booked').not('booking_value', 'is', null).gt('booking_value', 0)
console.log(`booking_value: ${bookedWithValue}/${bookedTotal} booked (${bookedTotal - bookedWithValue} missing)`)
