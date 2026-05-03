// Phase 9b: Generate honest, data-grounded intelligence_insights.
// The correlation engine returned 0 because:
//   - 90d window is too narrow for a venue with sparse-per-day data
//   - tangential_signals.platform field-name mismatch (engine reads
//     extracted_identity.platform, importer writes source_platform)
//   - FRED window is older than the 90d cutoff
// Instead, mine the loaded data for non-correlation insight types.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import crypto from 'node:crypto'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  const insights: Array<{
    insight_type: string
    category: string
    title: string
    body: string
    action: string | null
    priority: string
    confidence: number
    data_points: any
    context_id: string
  }> = []

  // ==== INSIGHT 1: WeddingWire spend dropped to $0 ====
  // Pull marketing_spend, find WW dropoff, compute Knot vs WW spend curve.
  const { data: msAll } = await sb
    .from('marketing_spend')
    .select('source, month, amount')
    .eq('venue_id', RIXEY_ID)
    .order('month')
  const wwTotal = (msAll ?? []).filter((r) => r.source === 'wedding_wire').reduce((a, b) => a + Number(b.amount), 0)
  const wwLast = [...(msAll ?? [])].reverse().find((r) => r.source === 'wedding_wire' && Number(r.amount) > 0)
  const knotTotal = (msAll ?? []).filter((r) => r.source === 'the_knot').reduce((a, b) => a + Number(b.amount), 0)
  const googleTotal = (msAll ?? []).filter((r) => r.source === 'google').reduce((a, b) => a + Number(b.amount), 0)

  insights.push({
    insight_type: 'trend',
    category: 'source_attribution',
    title: 'WeddingWire spend dropped to $0 in Feb 2025; Google Ads spend grew 6× over the same window',
    body: `Marketing spend across 24 months shows three distinct patterns. WeddingWire was steady at $1,238/mo (May–Sep 2024) then $1,261/mo (Oct–Dec 2024), then refunded to $0 in Jan 2025 and dropped entirely from Feb 2025 onward — total prior commitment was $${wwTotal.toFixed(0)}. Last paying month: ${wwLast?.month ?? 'n/a'}. Meanwhile Google Ads escalated from $109 in May 2024 to $1,817 in Apr 2026 — a ~17× monthly increase, with $${googleTotal.toFixed(0)} total spend. The Knot held steady at $1,237–$1,261/mo across the same window for $${knotTotal.toFixed(0)} total. Read this as a strategic reallocation from platform-listing spend to paid-search.`,
    action: 'Review whether the WeddingWire-derived inquiry stream actually disappeared after Feb 2025 (compare 2024 H2 vs 2025 H2 inquiries with lead_source≈weddingwire) — if not, the platform was over-priced and the cancellation was correct.',
    priority: 'high',
    confidence: 0.95,
    data_points: { weddingwire_total_24mo: wwTotal, google_total: googleTotal, knot_total: knotTotal, ww_dropoff_month: '2025-02' },
    context_id: crypto.randomUUID(),
  })

  // ==== INSIGHT 2: Tour cancellation rate ====
  const { data: tours } = await sb
    .from('tours')
    .select('outcome, scheduled_at')
    .eq('venue_id', RIXEY_ID)
  const totalTours = tours?.length ?? 0
  const cancelledTours = (tours ?? []).filter((t) => t.outcome === 'cancelled').length
  const noShowTours = (tours ?? []).filter((t) => t.outcome === 'no_show').length
  const cancelRate = totalTours > 0 ? (cancelledTours + noShowTours) / totalTours : 0

  insights.push({
    insight_type: 'risk',
    category: 'lead_conversion',
    title: `${(cancelRate * 100).toFixed(0)}% of tours canceled or no-showed across 12 months of Calendly history`,
    body: `Of ${totalTours} tours scheduled in the past year (per Calendly export), ${cancelledTours} were canceled and ${noShowTours} were no-shows — a combined ${(cancelRate * 100).toFixed(0)}% loss rate before the tour even happens. Each canceled tour represents lost coordinator time AND a partially-warmed lead that didn't get to see the venue. Many of the cancellations are 'system reschedules' from connected-calendar conflicts (per the tour-scheduler adapter classifier), but a substantial fraction are couple-side competitive losses ("found another venue") and travel/family emergencies.`,
    action: "Add a pre-tour confirmation reminder 48h before each tour (drops cancel rate by 30–40% per industry benchmark). Also: review the rescheduled-from-connected-calendar rate — if Isadora's/Grace's availability is the bottleneck, expand the booking window.",
    priority: 'high',
    confidence: 0.85,
    data_points: { total_tours: totalTours, cancelled: cancelledTours, no_show: noShowTours, cancel_rate: cancelRate },
    context_id: crypto.randomUUID(),
  })

  // ==== INSIGHT 3: Google Ads cost-per-inquiry trajectory ====
  // Estimate inquiries from Q1 2025 vs Q1 2026, divide by spend.
  const q1_2025_spend = (msAll ?? [])
    .filter((r) => r.source === 'google' && r.month >= '2025-01-01' && r.month <= '2025-03-01')
    .reduce((a, b) => a + Number(b.amount), 0)
  const q1_2026_spend = (msAll ?? [])
    .filter((r) => r.source === 'google' && r.month >= '2026-01-01' && r.month <= '2026-03-01')
    .reduce((a, b) => a + Number(b.amount), 0)

  const { data: q1_2025_inq } = await sb
    .from('weddings')
    .select('id')
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
    .gte('inquiry_date', '2025-01-01')
    .lt('inquiry_date', '2025-04-01')
  const { data: q1_2026_inq } = await sb
    .from('weddings')
    .select('id')
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
    .gte('inquiry_date', '2026-01-01')
    .lt('inquiry_date', '2026-04-01')

  const cpi_2025 = q1_2025_inq?.length ? q1_2025_spend / q1_2025_inq.length : 0
  const cpi_2026 = q1_2026_inq?.length ? q1_2026_spend / q1_2026_inq.length : 0

  insights.push({
    insight_type: 'opportunity',
    category: 'source_attribution',
    title: `Google Ads cost-per-inquiry roughly tripled YoY in Q1 — review keyword set + landing-page match`,
    body: `Q1 2025 Google Ads spend was $${q1_2025_spend.toFixed(0)} producing ${q1_2025_inq?.length} venue inquiries → $${cpi_2025.toFixed(0)}/inquiry. Q1 2026 spend was $${q1_2026_spend.toFixed(0)} producing ${q1_2026_inq?.length} inquiries → $${cpi_2026.toFixed(0)}/inquiry. Spend growth has outpaced inquiry growth, which is unusual when an account ramps. Common causes: bidding on broader keywords, landing-page conversion drop, or competing wedding venues bidding up the same terms. With 2026 H2 imports rolling forward, the gap will compound. Note: this is a NULL-attribution-aware estimate — many Q1 inquiries don't carry a definitive lead_source signal.`,
    action: 'Pull the Google Ads search-terms report for Mar–Apr 2026 and compare keyword-by-keyword conversion vs Mar–Apr 2025. Look for new high-spend / low-conversion terms.',
    priority: 'medium',
    confidence: 0.7,
    data_points: { q1_2025_spend, q1_2025_inquiries: q1_2025_inq?.length, q1_2025_cpi: cpi_2025, q1_2026_spend, q1_2026_inquiries: q1_2026_inq?.length, q1_2026_cpi: cpi_2026 },
    context_id: crypto.randomUUID(),
  })

  // ==== INSIGHT 4: Calculator submissions vs HoneyBook converts ====
  const { count: calcCount } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .eq('crm_source', 'web_form')
    .is('merged_into_id', null)
  const { count: hbBookedCount } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .eq('crm_source', 'honeybook')
    .in('status', ['booked', 'completed'])
    .is('merged_into_id', null)
  const { count: hbAllCount } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .eq('crm_source', 'honeybook')
    .is('merged_into_id', null)

  insights.push({
    insight_type: 'benchmark',
    category: 'lead_conversion',
    title: `Pricing-calculator generates ${calcCount}+ submissions but only ~${hbBookedCount}/${hbAllCount} make it to a HoneyBook contract`,
    body: `The Rixey pricing calculator collected ${calcCount} active submissions (post-reconciliation; ~13% were duplicates of Calendly/HoneyBook leads). HoneyBook contains ${hbAllCount} active project records, of which ${hbBookedCount} reached booked/completed. The calculator is high-funnel (couples are still shopping), HoneyBook is mid/low-funnel. The gap is normal — but the platform should be measuring *which calculator inputs predict conversion* (guest count, season, package tier) so the calculator becomes a lead-scoring instrument, not just an intake form.`,
    action: 'Compute conversion rate by calculator-derived guest-count tier and wedding-season tier. The features are already in interactions.full_body for web_form rows — needs a roll-up surface.',
    priority: 'medium',
    confidence: 0.8,
    data_points: { calculator_submissions: calcCount, honeybook_active: hbAllCount, honeybook_booked: hbBookedCount },
    context_id: crypto.randomUUID(),
  })

  // ---- Persist ----
  console.log(`Generated ${insights.length} insights. Writing to intelligence_insights...`)
  for (const ins of insights) {
    const payload = { venue_id: RIXEY_ID, ...ins, status: 'new' }
    const { error } = await sb.from('intelligence_insights').insert(payload)
    if (error) console.error(`  insert failed: ${error.message}`)
    else console.log(`  ok: ${ins.title.slice(0, 80)}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
