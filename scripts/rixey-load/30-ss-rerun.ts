/**
 * Stream SS — re-run lead-source derivation with the new Priority 7
 * (weddings.source legacy fallback).
 *
 * Migrations 185 + 186 are already applied to staging (via the prior
 * apply pass). The derivation chain in lead-source-derivation.ts now
 * has tryPriority7WeddingsSourceFallback wired in, but the prior cron
 * stamped attempted_at on all 620 NULL rows so we need to clear those
 * before re-running.
 *
 * Sequence:
 *   1. BEFORE snapshot (NULL count + lead_source distribution)
 *   2. Clear lead_source_derivation_attempted_at on NULL rows
 *   3. Loop deriveLeadSourceForVenue(...) until empty
 *   4. AFTER snapshot
 *   5. Refresh source_attribution rollup (so /intel/sources reads new
 *      sources)
 *
 * Usage: npx tsx scripts/rixey-load/30-ss-rerun.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { deriveLeadSourceForVenue } from '../../src/lib/services/attribution/lead-source-derivation'

const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

function loadEnv(): Record<string, string> {
  // Worktree's CWD doesn't carry .env.local; use the main repo's
  // copy (the worktree shares the same supabase project).
  const candidates = ['.env.local', 'C:\\Users\\Ismar\\bloom-house\\.env.local']
  let raw = ''
  for (const c of candidates) {
    try { raw = readFileSync(c, 'utf8'); break } catch { /* try next */ }
  }
  if (!raw) throw new Error('.env.local not found')
  return Object.fromEntries(
    raw
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
      })
  )
}

async function refreshAttributionForVenue(sb: SupabaseClient, vid: string) {
  const { data: weddings } = await sb
    .from('weddings')
    .select('source, status, booking_value, created_at, inquiry_date')
    .eq('venue_id', vid)
  const { data: spend } = await sb
    .from('marketing_spend')
    .select('source, amount, month')
    .eq('venue_id', vid)
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
  const env = loadEnv()
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  console.log('=== Stream SS rerun (Priority 7 derivation) ===\n')

  // BEFORE
  const { count: nullBefore } = await sb
    .from('weddings').select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null).is('lead_source', null)
  const { data: distBefore } = await sb
    .from('weddings').select('lead_source')
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null)
  const distB = new Map<string, number>()
  for (const r of (distBefore ?? []) as Array<{ lead_source: string | null }>) {
    const k = r.lead_source ?? '(null)'
    distB.set(k, (distB.get(k) ?? 0) + 1)
  }
  console.log(`BEFORE: NULL=${nullBefore}`)
  for (const [k, v] of [...distB.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)

  // Clear stamps
  console.log('\nClearing lead_source_derivation_attempted_at on NULL rows...')
  const { count: cleared } = await sb
    .from('weddings')
    .update({ lead_source_derivation_attempted_at: null }, { count: 'exact' })
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
    .is('lead_source', null)
    .not('lead_source_derivation_attempted_at', 'is', null)
  console.log(`  cleared ${cleared ?? 0} stamps`)

  // Re-run
  console.log('\nRunning lead-source derivation passes...')
  let totalDerived = 0
  let totalScanned = 0
  for (let pass = 1; pass <= 8; pass++) {
    const r = await deriveLeadSourceForVenue(sb, RIXEY_ID)
    if (r.weddingsScanned === 0) {
      console.log(`  pass ${pass}: scanned=0 — done`)
      break
    }
    totalScanned += r.weddingsScanned
    totalDerived += r.derived
    console.log(
      `  pass ${pass}: scanned=${r.weddingsScanned} derived=${r.derived} ` +
      `noSignal=${r.noSignal} perPriority=${JSON.stringify(r.perPriority)}`
    )
    if (r.errors.length > 0) {
      console.log(`    errors: ${r.errors.slice(0, 3).join(' | ')}`)
    }
    if (r.derived === 0 && r.noSignal === 0) break
  }
  console.log(`  TOTAL: scanned=${totalScanned} derived=${totalDerived}`)

  // AFTER
  const { count: nullAfter } = await sb
    .from('weddings').select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null).is('lead_source', null)
  const { data: distAfter } = await sb
    .from('weddings').select('lead_source')
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null)
  const distA = new Map<string, number>()
  for (const r of (distAfter ?? []) as Array<{ lead_source: string | null }>) {
    const k = r.lead_source ?? '(null)'
    distA.set(k, (distA.get(k) ?? 0) + 1)
  }
  console.log(`\nAFTER: NULL=${nullAfter} (BEFORE=${nullBefore}, delta=${(nullBefore ?? 0) - (nullAfter ?? 0)})`)
  for (const [k, v] of [...distA.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)

  // Refresh source_attribution
  console.log('\nRefreshing source_attribution...')
  await refreshAttributionForVenue(sb, RIXEY_ID)

  // Top sources
  const { data: srcRows } = await sb
    .from('source_attribution').select('source, revenue, period_start').eq('venue_id', RIXEY_ID)
  const totalsBySource = new Map<string, number>()
  for (const r of (srcRows ?? []) as Array<{ source: string; revenue: number }>) {
    totalsBySource.set(r.source, (totalsBySource.get(r.source) ?? 0) + Number(r.revenue || 0))
  }
  console.log('\nsource_attribution top revenue sources (after refresh):')
  for (const [s, r] of [...totalsBySource.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${s}: $${r.toFixed(2)}`)
  }

  // Final intelligence_insights count
  const { count: insightsAfter } = await sb
    .from('intelligence_insights').select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
  console.log(`\nintelligence_insights rows: ${insightsAfter}`)

  console.log('\n=== Stream SS rerun complete ===')
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
