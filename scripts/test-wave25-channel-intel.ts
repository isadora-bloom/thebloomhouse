/**
 * Wave 25 — channel-intel-hub verification on Rixey.
 *
 * Computes the Knot snapshot deterministically (skipping the Sonnet
 * narrator to keep it offline) and prints the story-arc cells + CAC
 * reveal so the reviewer can sanity-check the numbers.
 *
 * Usage:
 *   npx tsx scripts/test-wave25-channel-intel.ts
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { computeChannelSnapshot, listChannelsForVenue } from '../src/lib/services/channel-intel-hub/compute'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
) as Record<string, string>
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

async function main() {
  const { data: venues } = await sb
    .from('venues')
    .select('id, name, is_demo')
    .eq('is_demo', false)
    .limit(20)

  const rixey = ((venues ?? []) as Array<{ id: string; name: string }>).find((v) =>
    String(v.name ?? '').toLowerCase().includes('rixey'),
  )
  if (!rixey) {
    console.error('Rixey venue not found.')
    process.exit(1)
  }
  console.log(`\n=== Rixey: ${rixey.id} — ${rixey.name} ===\n`)

  // 1) List channels
  console.log('Channels with >=10 AE in last 365d:')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channels = await listChannelsForVenue({ venueId: rixey.id, windowDays: 365, supabase: sb as any })
  for (const c of channels) {
    console.log(`  ${c.source_platform.padEnd(28)} slug=${c.channel_slug.padEnd(24)} ae=${c.ae_count}`)
  }

  // 2) Compute Knot snapshot
  console.log('\n--- Computing the_knot snapshot (365d) ---')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const snap = await computeChannelSnapshot({
    venueId: rixey.id,
    sourcePlatform: 'the_knot',
    windowDays: 365,
    persist: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: sb as any,
  })

  console.log(`\nVenue:         ${snap.venue_id}`)
  console.log(`Channel:       ${snap.display_name} (${snap.source_platform}, slug=${snap.channel_slug})`)
  console.log(`Window:        ${snap.window_days}d`)
  console.log(`Unique weddings: ${snap.sample_sizes.unique_weddings}`)
  console.log(`AE total:      ${snap.sample_sizes.ae_total}`)
  console.log(`\nRole breakdown:`)
  for (const [k, v] of Object.entries(snap.role_breakdown)) console.log(`  ${k.padEnd(14)} ${v}`)
  console.log(`\nIntent breakdown:`)
  for (const [k, v] of Object.entries(snap.intent_breakdown)) console.log(`  ${k.padEnd(14)} ${v}`)
  console.log(`\nStory arc:`)
  for (const cell of snap.story_arc) {
    const tour = cell.conversion_to_tour_rate_0_1
    const book = cell.conversion_to_booked_rate_0_1
    console.log(
      `  ${cell.segment.padEnd(28)} n=${String(cell.unique_weddings).padStart(4)} booked=${String(cell.booked_weddings).padStart(3)} tour=${tour !== null ? (tour * 100).toFixed(1) + '%' : '—'} book=${book !== null ? (book * 100).toFixed(1) + '%' : '—'} v1=${cell.v1_contaminated_pct.toFixed(1)}%`,
    )
  }
  console.log(`\nCost reveal:`)
  console.log(`  Spend:                         $${(snap.cost_metrics.spend_cents / 100).toFixed(0)}`)
  console.log(`  Apparent CAC:                  ${fmt$(snap.cost_metrics.cac_cents)}`)
  console.log(`  Real CAC (no broadcast):       ${fmt$(snap.cost_metrics.cac_excluding_broadcast_cents)}`)
  console.log(`  Strict CAC (no broad+xplat):   ${fmt$(snap.cost_metrics.cac_excluding_broadcast_and_crossplatform_cents)}`)
  console.log(`  Cost per inquiry:              ${fmt$(snap.cost_metrics.cost_per_inquiry_cents)}`)
  console.log(`  Cost per tour:                 ${fmt$(snap.cost_metrics.cost_per_tour_cents)}`)
  console.log(`\nFunnel:`)
  console.log(`  inquiries=${snap.funnel.inquiries} tours=${snap.funnel.tours} booked=${snap.funnel.booked}`)
  console.log(`  inquiry→tour ${pct(snap.funnel.inquiry_to_tour_rate_0_1)} | tour→booked ${pct(snap.funnel.tour_to_booked_rate_0_1)} | inquiry→booked ${pct(snap.funnel.inquiry_to_booked_rate_0_1)}`)
  console.log(`\nQuality:`)
  console.log(`  Avg booking value: ${fmt$(snap.quality_metrics.avg_booking_value_cents)}`)
  console.log(`  Median lead time:  ${snap.quality_metrics.median_lead_time_days ?? '—'} days`)
  console.log(`  Avg review rating: ${snap.quality_metrics.avg_review_rating ?? '—'} (n=${snap.quality_metrics.review_count})`)
  console.log(`  Persona spread:    ${Object.keys(snap.quality_metrics.persona_distribution).length} personas`)
  console.log(`\nCalibration:`)
  console.log(`  v1-contaminated:   ${snap.confidence_signals.v1_contaminated_count}`)
  console.log(`  v2-classified:     ${snap.confidence_signals.v2_classified_count}`)
  console.log(`  null-classified:   ${snap.confidence_signals.null_classified_count}`)
  console.log(`  freshness:         ${snap.confidence_signals.data_freshness_iso}`)
  console.log(`  prompt versions:   ${JSON.stringify(snap.confidence_signals.prompt_versions_used)}`)
  console.log(`  computed via:      ${snap.confidence_signals.computed_with_function}`)
  console.log(`\nDisagreement findings touching this channel: ${snap.disagreement_findings_count}\n`)
}

function fmt$(cents: number | null): string {
  if (cents === null) return '—'
  return `$${(cents / 100).toFixed(0)}`
}
function pct(r: number | null): string {
  if (r === null) return '—'
  return `${(r * 100).toFixed(1)}%`
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
