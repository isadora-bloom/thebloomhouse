/**
 * Wave 7B verification probe: confirm attribution_events shape +
 * Rixey distribution before building the classifier.
 *
 * Usage:
 *   npx tsx scripts/wave7b-check-attribution-data.ts
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

function loadEnv() {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const raw = readFileSync('.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
  return env
}

async function main() {
  const env = loadEnv()
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  // Find Rixey venue id
  const { data: rixey } = await sb
    .from('venues')
    .select('id, name, slug')
    .ilike('name', '%rixey%')
    .limit(3)
  console.log('Rixey venues:', rixey)

  // Sample attribution_events to confirm role column landed
  const { data: ae, error } = await sb
    .from('attribution_events')
    .select(
      'id, venue_id, source_platform, decided_at, is_first_touch, signal_id, wedding_id, bucket, role, role_confidence_0_100, role_classified_at',
    )
    .limit(5)
  console.log('attribution_events sample:', ae?.length, 'err:', error?.message ?? 'none')
  if (ae?.[0]) console.log('  first row:', ae[0])

  if (!rixey?.[0]) return
  const venueId = (rixey[0] as { id: string }).id

  // Sources distribution
  const { data: bySource } = await sb
    .from('attribution_events')
    .select('source_platform, signal_class, bucket')
    .eq('venue_id', venueId)
    .is('reverted_at', null)
  const counts: Record<string, number> = {}
  const classCounts: Record<string, number> = {}
  for (const r of (bySource ?? []) as Array<{ source_platform: string | null; signal_class: string | null }>) {
    counts[r.source_platform ?? 'null'] = (counts[r.source_platform ?? 'null'] ?? 0) + 1
    classCounts[r.signal_class ?? 'null'] = (classCounts[r.signal_class ?? 'null'] ?? 0) + 1
  }
  console.log(`\nRixey attribution_events by source_platform (total ${bySource?.length}):`)
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)
  console.log('signal_class distribution:', classCounts)

  // Find a Knot-source event to dry-run
  const { data: knotEvents } = await sb
    .from('attribution_events')
    .select('id, source_platform, decided_at, wedding_id, signal_id, bucket, signal_class')
    .eq('venue_id', venueId)
    .or(
      'source_platform.eq.theknot,source_platform.eq.the_knot,source_platform.eq.theknot.com,source_platform.ilike.%knot%',
    )
    .is('reverted_at', null)
    .limit(3)
  console.log('\nSample Knot-class attribution events:', knotEvents)

  // tangential_signals shape
  const { data: ts, error: tsErr } = await sb
    .from('tangential_signals')
    .select('*')
    .eq('venue_id', venueId)
    .limit(2)
  console.log('\ntangential_signals query err:', tsErr?.message)
  console.log('tangential_signals sample (first row):', ts?.[0])
  if (ts?.[0]) console.log('tangential_signals columns:', Object.keys(ts[0]).join(', '))

  // weddings shape — find a knot-source wedding to test classify on
  const { data: wedding } = await sb
    .from('weddings')
    .select('id, source, utm_source, inquiry_date, wedding_date, status')
    .eq('venue_id', venueId)
    .ilike('source', '%knot%')
    .limit(2)
  console.log('\nKnot-source wedding sample:', wedding)

  // bucket distribution split (attribution vs nurture) of role='unknown'
  const { count: attribCount } = await sb
    .from('attribution_events')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('bucket', 'attribution')
    .is('reverted_at', null)
  const { count: nurtureCount } = await sb
    .from('attribution_events')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('bucket', 'nurture')
    .is('reverted_at', null)
  console.log(`\nbucket distribution: attribution=${attribCount}, nurture=${nurtureCount}`)

  // For one knot wedding, look at its tangential_signals + interactions to
  // exercise the forensic check
  const wid = (wedding as Array<{ id: string }> | null)?.[0]?.id
  if (wid) {
    // Get all tangential signals attached to candidate_identity_ids tied
    // to attribution_events for this wedding
    const { data: weddingAEs } = await sb
      .from('attribution_events')
      .select('id, candidate_identity_id, source_platform, signal_id, decided_at, bucket, is_first_touch, signal_class')
      .eq('wedding_id', wid)
      .is('reverted_at', null)
    console.log(`\n[wedding ${wid}] attribution_events count:`, weddingAEs?.length)
    console.log('  sample row:', weddingAEs?.[0])

    if (weddingAEs?.length) {
      const candidateIds = [...new Set((weddingAEs as Array<{ candidate_identity_id: string }>).map((r) => r.candidate_identity_id))]
      const { data: candidateSignals } = await sb
        .from('tangential_signals')
        .select('id, source_platform, signal_date, source_context, action_class, candidate_identity_id')
        .in('candidate_identity_id', candidateIds)
      console.log(`[wedding ${wid}] candidate signals total:`, candidateSignals?.length)
      const platformDist: Record<string, number> = {}
      for (const s of (candidateSignals ?? []) as Array<{ source_platform: string | null }>) {
        platformDist[s.source_platform ?? 'null'] = (platformDist[s.source_platform ?? 'null'] ?? 0) + 1
      }
      console.log('  platform distribution across this wedding:', platformDist)
    }

    // Sample wedding_touchpoints for this wedding
    const { data: tps } = await sb
      .from('wedding_touchpoints')
      .select('source, occurred_at, touch_type, signal_class')
      .eq('wedding_id', wid)
      .order('occurred_at', { ascending: true })
      .limit(20)
    console.log(`[wedding ${wid}] touchpoints:`, tps?.length, '— first 5:')
    for (const tp of (tps ?? []).slice(0, 5)) console.log('   ', tp)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
