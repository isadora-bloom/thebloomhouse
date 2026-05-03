// Stream QQ: verify the $794k Honeybook revenue is now visible
// AND check why Calendly source rows show 21 bookings $0
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  // Mirror the source-quality page query: by lead_source
  console.log('=== weddings rolled up by LEAD_SOURCE (active only) ===')
  const { data: byLead } = await sb
    .from('weddings')
    .select('lead_source, status, booking_value')
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
  const lead: Record<string, { count: number; bookings: number; rev: number }> = {}
  let totalRev = 0
  for (const w of byLead ?? []) {
    const k = w.lead_source ?? '(null)'
    if (!lead[k]) lead[k] = { count: 0, bookings: 0, rev: 0 }
    lead[k].count++
    if (['booked', 'completed'].includes(w.status as string)) {
      lead[k].bookings++
      const cents = Number(w.booking_value) || 0
      lead[k].rev += cents / 100
      totalRev += cents / 100
    }
  }
  console.log('source                        | count | book | revenue $')
  console.log('------------------------------+-------+------+----------')
  for (const [k, v] of Object.entries(lead).sort((a,b) => b[1].rev - a[1].rev)) {
    console.log(`${k.padEnd(30)} | ${String(v.count).padStart(5)} | ${String(v.bookings).padStart(4)} | ${String(Math.round(v.rev)).padStart(9)}`)
  }
  console.log(`TOTAL revenue (cents/100): $${Math.round(totalRev).toLocaleString()}`)

  // weddings rolled up by SOURCE (the rollup the cron uses)
  console.log('\n=== weddings rolled up by SOURCE (active only) ===')
  const { data: bySrc } = await sb
    .from('weddings')
    .select('source, status, booking_value')
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
  const src: Record<string, { count: number; bookings: number; rev: number }> = {}
  for (const w of bySrc ?? []) {
    const k = w.source ?? '(null)'
    if (!src[k]) src[k] = { count: 0, bookings: 0, rev: 0 }
    src[k].count++
    if (['booked', 'completed'].includes(w.status as string)) {
      src[k].bookings++
      src[k].rev += (Number(w.booking_value) || 0) / 100
    }
  }
  console.log('source                        | count | book | revenue $')
  for (const [k, v] of Object.entries(src).sort((a,b) => b[1].rev - a[1].rev)) {
    console.log(`${k.padEnd(30)} | ${String(v.count).padStart(5)} | ${String(v.bookings).padStart(4)} | ${String(Math.round(v.rev)).padStart(9)}`)
  }

  // Sample weddings with source=calendly + booked status to see why $0
  console.log('\n=== Calendly+booked sample (10) ===')
  const { data: calBooked } = await sb
    .from('weddings')
    .select('id, source, lead_source, status, booking_value, inquiry_date, wedding_date')
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
    .eq('source', 'calendly')
    .in('status', ['booked', 'completed'])
    .limit(10)
  for (const w of calBooked ?? []) {
    console.log(`  ${w.id.slice(0,8)} status=${w.status} bv=${w.booking_value} lead=${w.lead_source} inq=${w.inquiry_date}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
