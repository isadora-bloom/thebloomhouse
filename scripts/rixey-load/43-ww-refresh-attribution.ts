// Stream WW: refresh source_attribution rollup for Rixey AFTER the
// Calendly extracted_identity backfill (40) + lead_source rederive
// (42). Mirrors the cron route's refreshAttributionAllVenues but
// scoped to one venue + with the T5-Rixey-WW lead_source-first
// fallback (matches src/app/api/cron/route.ts).
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
  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  console.log('=== Stream WW: refresh source_attribution for Rixey ===\n')

  const { count: beforeCount } = await sb
    .from('source_attribution')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
  console.log(`source_attribution rows BEFORE: ${beforeCount}`)

  const { data: weddings } = await sb
    .from('weddings')
    .select('lead_source, source, status, booking_value, created_at, inquiry_date')
    .eq('venue_id', RIXEY_ID)
  const { data: spend } = await sb
    .from('marketing_spend')
    .select('source, amount, month')
    .eq('venue_id', RIXEY_ID)
  if (!weddings) { console.error('no weddings'); process.exit(1) }
  console.log(`weddings: ${weddings.length}, marketing_spend: ${spend?.length ?? 0}`)

  type Bucket = { inquiries: number; tours: number; bookings: number; revenue: number; spend: number }
  const buckets = new Map<string, Bucket>()
  const empty = (): Bucket => ({ inquiries: 0, tours: 0, bookings: 0, revenue: 0, spend: 0 })

  for (const w of weddings) {
    // T5-Rixey-WW: lead_source first (post-Stream-TT canonical),
    // fall back to source (pre-migration-187 rows), then 'unknown'.
    const src = (w.lead_source as string | null) || (w.source as string | null) || 'unknown'
    const dateStr = (w.inquiry_date as string | null) ?? (w.created_at as string | null)
    if (!dateStr) continue
    const year = new Date(dateStr).getUTCFullYear()
    if (!Number.isFinite(year)) continue
    const k = `${year}|${src}`
    const b = buckets.get(k) ?? empty()
    b.inquiries++
    if (['tour_scheduled', 'tour_completed', 'proposal_sent', 'booked', 'completed'].includes(w.status as string)) b.tours++
    if (['booked', 'completed'].includes(w.status as string)) {
      b.bookings++
      // booking_value is cents (Bloom convention); convert to dollars.
      const cents = Number(w.booking_value) || 0
      b.revenue += cents / 100
    }
    buckets.set(k, b)
  }
  for (const s of (spend || [])) {
    const src = (s.source as string | null) || 'unknown'
    const monthStr = s.month as string | null
    if (!monthStr) continue
    const year = new Date(monthStr).getUTCFullYear()
    if (!Number.isFinite(year)) continue
    const k = `${year}|${src}`
    const b = buckets.get(k) ?? empty()
    b.spend += Number(s.amount) || 0
    buckets.set(k, b)
  }

  const now = new Date().toISOString()
  let upserts = 0
  for (const [k, data] of buckets) {
    const [yearStr, source] = k.split('|', 2)
    const year = Number(yearStr)
    const periodStart = `${year}-01-01`
    const periodEnd = `${year}-12-31`
    const cpi = data.inquiries > 0 ? data.spend / data.inquiries : 0
    const cpb = data.bookings > 0 ? data.spend / data.bookings : 0
    const conv = data.inquiries > 0 ? data.bookings / data.inquiries : 0
    const roi = data.spend > 0 ? (data.revenue - data.spend) / data.spend : 0
    const { error } = await sb.from('source_attribution').upsert({
      venue_id: RIXEY_ID, source, period_start: periodStart, period_end: periodEnd,
      spend: data.spend, inquiries: data.inquiries, tours: data.tours, bookings: data.bookings,
      revenue: data.revenue, cost_per_inquiry: cpi, cost_per_booking: cpb,
      conversion_rate: conv, roi, calculated_at: now,
    }, { onConflict: 'venue_id,source,period_start' })
    if (error) console.warn(`upsert ${k}: ${error.message}`)
    else upserts++
  }
  console.log(`Upserted ${upserts} buckets.`)

  const { data: after } = await sb
    .from('source_attribution')
    .select('source, period_start, spend, inquiries, bookings, revenue, roi')
    .eq('venue_id', RIXEY_ID)
    .order('period_start', { ascending: true })
    .order('revenue', { ascending: false })
  console.log(`\nsource_attribution rows AFTER: ${after?.length ?? 0}`)
  console.log('\nyear  | source                 | spend $    | inq | book | revenue $   | roi')
  console.log('------+------------------------+------------+-----+------+-------------+------')
  for (const r of after ?? []) {
    const yr = String(r.period_start).slice(0, 4)
    console.log(
      `${yr.padEnd(5)} | ${(r.source as string ?? '').padEnd(22)} | ` +
      `${String(Math.round(r.spend ?? 0)).padStart(10)} | ` +
      `${String(r.inquiries ?? 0).padStart(3)} | ${String(r.bookings ?? 0).padStart(4)} | ` +
      `${String(Math.round(r.revenue ?? 0)).padStart(11)} | ${(r.roi ?? 0).toFixed(2)}`
    )
  }
}
main().catch(e => { console.error(e); process.exit(1) })
