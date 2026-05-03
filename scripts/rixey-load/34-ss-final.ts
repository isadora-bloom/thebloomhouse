/**
 * Stream SS — final verification pass:
 *   1. Refresh source_attribution (HoneyBook should appear separately)
 *   2. Re-narrate one insight to verify Bug B fix landed (insert/update path)
 *   3. Final snapshot of all the bug-status deltas
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { persistInsight } from '../../src/lib/services/insights/persist'

const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
let raw = ''
for (const c of ['.env.local', 'C:\\Users\\Ismar\\bloom-house\\.env.local']) {
  try { raw = readFileSync(c, 'utf8'); break } catch { /* */ }
}
const env = Object.fromEntries(
  raw.split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')] })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

async function refreshAttributionForVenue(sb: SupabaseClient, vid: string) {
  const { data: weddings } = await sb
    .from('weddings').select('source, status, booking_value, created_at, inquiry_date')
    .eq('venue_id', vid)
  const { data: spend } = await sb
    .from('marketing_spend').select('source, amount, month').eq('venue_id', vid)
  if (!weddings) return

  type Bucket = { inquiries: number; tours: number; bookings: number; revenue: number; spend: number }
  const buckets = new Map<string, Bucket>()
  const empty = (): Bucket => ({ inquiries: 0, tours: 0, bookings: 0, revenue: 0, spend: 0 })
  for (const w of weddings as Array<{ source: string | null; status: string | null; booking_value: number | null; created_at: string; inquiry_date: string | null }>) {
    const dateStr = w.inquiry_date ?? w.created_at
    const year = new Date(dateStr).getUTCFullYear()
    const src = w.source ?? 'other'
    const key = `${year}|${src}`
    const b = buckets.get(key) ?? empty()
    b.inquiries += 1
    if (w.status === 'tour_scheduled' || w.status === 'tour_completed' || w.status === 'booked') b.tours += 1
    if (w.status === 'booked') {
      b.bookings += 1
      if (w.booking_value != null) b.revenue += w.booking_value / 100
    }
    buckets.set(key, b)
  }
  for (const s of (spend as Array<{ source: string | null; amount: number | null; month: string | null }> ?? [])) {
    if (!s.month) continue
    const year = new Date(s.month).getUTCFullYear()
    const src = s.source ?? 'other'
    const key = `${year}|${src}`
    const b = buckets.get(key) ?? empty()
    b.spend += Number(s.amount ?? 0)
    buckets.set(key, b)
  }

  await sb.from('source_attribution').delete().eq('venue_id', vid)
  const inserts: Array<Record<string, unknown>> = []
  for (const [key, b] of buckets) {
    const [yearStr, src] = key.split('|')
    const periodStart = `${yearStr}-01-01`
    const periodEnd = `${yearStr}-12-31`
    inserts.push({
      venue_id: vid,
      source: src,
      period_start: periodStart,
      period_end: periodEnd,
      inquiries: b.inquiries,
      tours: b.tours,
      bookings: b.bookings,
      revenue: b.revenue,
      spend: b.spend,
    })
  }
  if (inserts.length > 0) {
    const { error: insErr } = await sb.from('source_attribution').insert(inserts)
    if (insErr) console.error('  source_attribution insert failed:', insErr.message)
    else console.log(`  inserted ${inserts.length} source_attribution rows`)
  }
}

async function main() {
  console.log('=== Stream SS final verification ===\n')

  // 1. Refresh source_attribution
  console.log('[Bug D] Refreshing source_attribution rollup...')
  await refreshAttributionForVenue(sb, RIXEY_ID)

  const { data: srcRows } = await sb
    .from('source_attribution').select('source, revenue, period_start, bookings, inquiries')
    .eq('venue_id', RIXEY_ID).order('period_start')
  console.log(`  source_attribution rows: ${srcRows?.length ?? 0}`)
  const totalsBySource = new Map<string, { rev: number; bookings: number; inquiries: number }>()
  for (const r of (srcRows ?? []) as Array<{ source: string; revenue: number; bookings: number; inquiries: number }>) {
    const e = totalsBySource.get(r.source) ?? { rev: 0, bookings: 0, inquiries: 0 }
    e.rev += Number(r.revenue || 0)
    e.bookings += r.bookings
    e.inquiries += r.inquiries
    totalsBySource.set(r.source, e)
  }
  console.log('  source_attribution top 8 by revenue:')
  for (const [s, v] of [...totalsBySource.entries()].sort((a, b) => b[1].rev - a[1].rev).slice(0, 8)) {
    console.log(`    ${s.padEnd(22)}  inq=${v.inquiries.toString().padStart(4)}  bk=${v.bookings.toString().padStart(3)}  rev=$${v.rev.toFixed(2)}`)
  }

  // 2. Test persistInsight with a synthetic correlation insight
  console.log('\n[Bug B] Testing persistInsight via direct call...')
  const testCacheKey = `ss-bug-b-test-${Date.now()}`
  const result = await persistInsight(sb, {
    venueId: RIXEY_ID,
    insightType: 'correlation',
    contextId: null,
    category: 'source_attribution',
    surfaceLayer: 'on_demand',
    classical: {
      cacheKey: testCacheKey,
      numbers: ['0.71', '14', '365'],
      payload: {
        channel_a: 'the_knot_signals',
        channel_b: 'fred_unemployment_rate',
        correlation: -0.713,
        lag_days: 14,
        window_days: 365,
      },
      sampleSize: 365,
      effectSize: 0.71,
    },
    narration: {
      title: 'SS Bug B test: knot drops when unemployment rises',
      body: 'The Knot signals and unemployment rate moved in opposite directions with about a 14-day lag over the last 365 days (correlation 0.71).',
      action: 'Monitor economic news this week — if unemployment reports show increases, expect potential drops in online wedding interest about two weeks out.',
    },
    llmModelUsed: 'test',
    promptVersionUsed: 'test-v1',
    confidence: 0.7,
    surfacePriority: 50,
  })
  console.log(`  persistInsight result: ${JSON.stringify(result, null, 2).slice(0, 400)}`)
  if (result.ok && result.insightId) {
    // Verify the row actually landed
    const { data: row } = await sb
      .from('intelligence_insights').select('id, title, cache_key, insight_type')
      .eq('id', result.insightId).maybeSingle()
    console.log(`  row in DB: ${row ? 'YES (id=' + (row as { id: string }).id.slice(0, 8) + ')' : 'NO'}`)

    // Re-narrate same cache_key — should return state='updated'
    const reRun = await persistInsight(sb, {
      venueId: RIXEY_ID,
      insightType: 'correlation',
      contextId: null,
      category: 'source_attribution',
      surfaceLayer: 'on_demand',
      classical: {
        cacheKey: testCacheKey,
        numbers: ['0.71', '14', '365'],
        payload: { channel_a: 'the_knot_signals', channel_b: 'fred_unemployment_rate', correlation: -0.713, lag_days: 14, window_days: 365 },
        sampleSize: 365,
        effectSize: 0.71,
      },
      narration: {
        title: 'SS Bug B test (UPDATED): knot drops when unemployment rises',
        body: 'The Knot signals and unemployment rate moved in opposite directions with about a 14-day lag over the last 365 days (correlation 0.71).',
        action: 'Monitor economic news this week — if unemployment reports show increases, expect potential drops in online wedding interest about two weeks out.',
      },
      llmModelUsed: 'test',
      promptVersionUsed: 'test-v1',
      confidence: 0.7,
      surfacePriority: 50,
    })
    console.log(`  rerun (same cache_key): state=${reRun.state} insightId=${reRun.insightId?.slice(0, 8)}`)
    console.log(`  state should be 'updated': ${reRun.state === 'updated' ? 'PASS' : 'FAIL'}`)

    // Cleanup the test row
    await sb.from('intelligence_insights').delete().eq('id', result.insightId)
    console.log(`  cleaned up test row`)
  }

  // 3. Final snapshot
  console.log('\n[final snapshot]')
  const { count: nullLeads } = await sb
    .from('weddings').select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null).is('lead_source', null)
  const { count: insightsCount } = await sb
    .from('intelligence_insights').select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
  console.log(`  NULL lead_source (active): ${nullLeads}  (was 620 pre-SS)`)
  console.log(`  intelligence_insights rows: ${insightsCount}`)

  // lead_source distribution
  const { data: dist } = await sb
    .from('weddings').select('lead_source')
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null)
  const distMap = new Map<string, number>()
  for (const r of (dist ?? []) as Array<{ lead_source: string | null }>) {
    const k = r.lead_source ?? '(null)'
    distMap.set(k, (distMap.get(k) ?? 0) + 1)
  }
  console.log('  lead_source distribution:')
  for (const [k, v] of [...distMap.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(22)} ${v}`)
  }

  console.log('\n=== Stream SS final verification complete ===')
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1) })
