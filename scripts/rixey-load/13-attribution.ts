// Trigger source_attribution refresh for Rixey so the NLQ context loader
// (which reads source_attribution not marketing_spend) can see the spend.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  const { data: weddings } = await sb
    .from('weddings')
    .select('source, status, booking_value')
    .eq('venue_id', id)
    .is('merged_into_id', null)
  const { data: spend } = await sb
    .from('marketing_spend')
    .select('source, amount')
    .eq('venue_id', id)

  const sources = new Map<string, { inquiries: number; tours: number; bookings: number; revenue: number; spend: number }>()

  for (const w of weddings ?? []) {
    const src = (w.source as string | null) || 'unknown'
    const existing = sources.get(src) || { inquiries: 0, tours: 0, bookings: 0, revenue: 0, spend: 0 }
    existing.inquiries++
    if (['tour_scheduled', 'tour_completed', 'proposal_sent', 'booked', 'completed'].includes(w.status as string)) existing.tours++
    if (['booked', 'completed'].includes(w.status as string)) {
      existing.bookings++
      existing.revenue += Number(w.booking_value) || 0
    }
    sources.set(src, existing)
  }
  for (const s of spend ?? []) {
    const existing = sources.get(s.source as string) || { inquiries: 0, tours: 0, bookings: 0, revenue: 0, spend: 0 }
    existing.spend += Number(s.amount) || 0
    sources.set(s.source as string, existing)
  }

  const now = new Date().toISOString()
  const periodStart = new Date(new Date().getFullYear(), 0, 1).toISOString()

  // Delete prior rows with the same period_start (the upsert can't use
  // ON CONFLICT because the table lacks a unique index).
  await sb.from('source_attribution').delete().eq('venue_id', id).eq('period_start', periodStart)

  console.log('Source-attribution rollup for Rixey:')
  console.log('source           inq  tour book   spend     rev      conv%   roi%   $/inq')
  for (const [source, d] of sources) {
    const conv = d.inquiries > 0 ? (d.bookings / d.inquiries) * 100 : 0
    const roi = d.spend > 0 ? ((d.revenue - d.spend) / d.spend) * 100 : 0
    const cpi = d.inquiries > 0 ? d.spend / d.inquiries : 0
    console.log(`${source.padEnd(16)} ${String(d.inquiries).padStart(4)} ${String(d.tours).padStart(4)} ${String(d.bookings).padStart(4)}  ${`$${d.spend.toFixed(0)}`.padStart(8)} ${`$${d.revenue.toFixed(0)}`.padStart(9)}   ${conv.toFixed(1).padStart(4)}%  ${roi.toFixed(0).padStart(5)}%  $${cpi.toFixed(0)}`)

    const { error } = await sb.from('source_attribution').insert({
      venue_id: id,
      source,
      period_start: periodStart,
      period_end: now,
      spend: d.spend,
      inquiries: d.inquiries,
      tours: d.tours,
      bookings: d.bookings,
      revenue: d.revenue,
      cost_per_inquiry: d.inquiries > 0 ? d.spend / d.inquiries : 0,
      cost_per_booking: d.bookings > 0 ? d.spend / d.bookings : 0,
      conversion_rate: d.inquiries > 0 ? d.bookings / d.inquiries : 0,
      roi: d.spend > 0 ? (d.revenue - d.spend) / d.spend : 0,
      calculated_at: now,
    })
    if (error) console.error('  upsert err:', error.message)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
