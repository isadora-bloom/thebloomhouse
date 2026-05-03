// Verify migration 180 landed: try the actual upsert ON CONFLICT path.
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
const periodStart = '2099-01-01'   // probe key — won't collide with real data
const periodEnd = '2099-12-31'
const source = 'probe_180'

// First call — INSERT path.
const r1 = await sb.from('source_attribution').upsert({
  venue_id: RIXEY,
  source,
  period_start: periodStart,
  period_end: periodEnd,
  spend: 1, inquiries: 1, tours: 0, bookings: 0, revenue: 0,
  cost_per_inquiry: 1, cost_per_booking: 0, conversion_rate: 0, roi: 0,
  calculated_at: new Date().toISOString(),
}, { onConflict: 'venue_id,source,period_start' })
console.log('first upsert (insert path):', r1.error ? `FAIL ${r1.error.message}` : 'OK')

// Second call — UPDATE path.
const r2 = await sb.from('source_attribution').upsert({
  venue_id: RIXEY,
  source,
  period_start: periodStart,
  period_end: periodEnd,
  spend: 2, inquiries: 2, tours: 0, bookings: 0, revenue: 0,
  cost_per_inquiry: 1, cost_per_booking: 0, conversion_rate: 0, roi: 0,
  calculated_at: new Date().toISOString(),
}, { onConflict: 'venue_id,source,period_start' })
console.log('second upsert (update path):', r2.error ? `FAIL ${r2.error.message}` : 'OK')

// Verify only one row exists.
const { data: rows } = await sb
  .from('source_attribution')
  .select('id, spend, inquiries')
  .eq('venue_id', RIXEY)
  .eq('source', source)
  .eq('period_start', periodStart)
console.log('rows after upsert:', rows)

// Cleanup probe row.
await sb.from('source_attribution').delete()
  .eq('venue_id', RIXEY).eq('source', source).eq('period_start', periodStart)
console.log('probe row cleaned up')
