// T5-Rixey-NN: verify the rewritten cron — should produce per-(year,source) rows.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    })
)

const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Clear existing rows so we see ONLY what the new cron writes.
await sb.from('source_attribution').delete().eq('venue_id', RIXEY)

// Inline the new logic from src/app/api/cron/route.ts (the exported helper
// isn't exposed; mirror the algorithm).
const { data: weddings } = await sb
  .from('weddings')
  .select('source, status, booking_value, created_at, inquiry_date')
  .eq('venue_id', RIXEY)

const { data: spend } = await sb
  .from('marketing_spend')
  .select('source, amount, month')
  .eq('venue_id', RIXEY)

const buckets = new Map()
const empty = () => ({ inquiries: 0, tours: 0, bookings: 0, revenue: 0, spend: 0 })

for (const w of weddings ?? []) {
  const src = w.source || 'unknown'
  const dateStr = w.inquiry_date ?? w.created_at
  if (!dateStr) continue
  const year = new Date(dateStr).getUTCFullYear()
  if (!Number.isFinite(year)) continue
  const k = `${year}|${src}`
  const b = buckets.get(k) ?? empty()
  b.inquiries++
  if (['tour_scheduled', 'tour_completed', 'proposal_sent', 'booked', 'completed'].includes(w.status)) b.tours++
  if (['booked', 'completed'].includes(w.status)) {
    b.bookings++
    b.revenue += (Number(w.booking_value) || 0) / 100
  }
  buckets.set(k, b)
}

for (const s of spend ?? []) {
  const src = s.source || 'unknown'
  const monthStr = s.month
  if (!monthStr) continue
  const year = new Date(monthStr).getUTCFullYear()
  if (!Number.isFinite(year)) continue
  const k = `${year}|${src}`
  const b = buckets.get(k) ?? empty()
  b.spend += Number(s.amount) || 0
  buckets.set(k, b)
}

const now = new Date().toISOString()
let writeCount = 0
for (const [k, data] of buckets) {
  const [yearStr, source] = k.split('|', 2)
  const year = Number(yearStr)
  const periodStart = `${year}-01-01`
  const periodEnd = `${year}-12-31`
  const costPerInquiry = data.inquiries > 0 ? data.spend / data.inquiries : 0
  const costPerBooking = data.bookings > 0 ? data.spend / data.bookings : 0
  const conversionRate = data.inquiries > 0 ? data.bookings / data.inquiries : 0
  const roi = data.spend > 0 ? (data.revenue - data.spend) / data.spend : 0

  const r = await sb.from('source_attribution').upsert({
    venue_id: RIXEY,
    source,
    period_start: periodStart,
    period_end: periodEnd,
    spend: data.spend,
    inquiries: data.inquiries,
    tours: data.tours,
    bookings: data.bookings,
    revenue: data.revenue,
    cost_per_inquiry: costPerInquiry,
    cost_per_booking: costPerBooking,
    conversion_rate: conversionRate,
    roi,
    calculated_at: now,
  }, { onConflict: 'venue_id,source,period_start' })
  if (r.error) console.error('upsert fail', k, r.error.message)
  else writeCount++
}

console.log(`wrote/updated ${writeCount} source_attribution rows for Rixey`)
console.log()

// Show resulting layout — should have multiple periods per source.
const { data: rows } = await sb
  .from('source_attribution')
  .select('source, period_start, period_end, spend, inquiries, bookings, revenue, cost_per_inquiry, roi')
  .eq('venue_id', RIXEY)
  .order('period_start', { ascending: true })
  .order('source', { ascending: true })

console.log('source_attribution rows for Rixey:')
console.log('year       source                  spend     inq  bk      rev   $/inq    roi')
for (const r of rows ?? []) {
  const yr = r.period_start.slice(0, 4)
  const src = String(r.source).padEnd(22)
  const sp = `$${Math.round(r.spend ?? 0)}`.padStart(8)
  const inq = String(r.inquiries ?? 0).padStart(4)
  const bk = String(r.bookings ?? 0).padStart(3)
  const rev = `$${Math.round(r.revenue ?? 0)}`.padStart(8)
  const cpi = r.cost_per_inquiry ? `$${Number(r.cost_per_inquiry).toFixed(0)}` : '--'
  const roi = r.roi != null ? `${(Number(r.roi) * 100).toFixed(0)}%` : '--'
  console.log(`${yr}  ${src} ${sp} ${inq} ${bk} ${rev}  ${cpi.padStart(6)}  ${roi.padStart(6)}`)
}

// Compute total revenue from the attribution rollup — should be REASONABLE now.
const totalRev = (rows ?? []).reduce((s, r) => s + (Number(r.revenue) || 0), 0)
console.log()
console.log(`TOTAL revenue across all years: $${totalRev.toFixed(2)} (was $51,432,396 pre-fix)`)
