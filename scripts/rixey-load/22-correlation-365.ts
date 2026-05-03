// Stream QQ step 3: re-fire correlation engine for Rixey with 365-day
// window so the WeddingWire-cancellation Feb-2025 event falls inside.
// NN's bug fixes are now in:
//   - field-name fix: source_platform fallback (553 The Knot signals)
//   - threshold lowered 20 → 12 nonzero days
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { computeCorrelationsForVenue } from '../../src/lib/services/correlation-engine'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  // Existing correlation rows
  const { data: pre } = await sb
    .from('intelligence_insights')
    .select('id, title, data_points')
    .eq('venue_id', RIXEY_ID)
    .eq('insight_type', 'correlation')
  console.log(`existing correlation insights for Rixey: ${pre?.length ?? 0}`)

  console.log('\nRunning correlation engine for Rixey with windowDaysOverride=365...')
  const insights = await computeCorrelationsForVenue({
    supabase: sb, venueId: RIXEY_ID, maxInsights: 12, windowDaysOverride: 365,
  })

  console.log(`\nReturned ${insights.length} insight rows:`)
  for (const ins of insights) {
    console.log(`  [r=${ins.r.toFixed(3)} lag=${ins.lagDays}d]`)
    console.log(`    A=${ins.channelA}`)
    console.log(`    B=${ins.channelB}`)
    console.log(`    title=${ins.headline}`)
  }

  // Persisted rows
  const { data: post } = await sb
    .from('intelligence_insights')
    .select('id, title, priority, confidence, data_points, created_at')
    .eq('venue_id', RIXEY_ID)
    .eq('insight_type', 'correlation')
    .order('confidence', { ascending: false })
  console.log(`\npersisted correlation insights AFTER: ${post?.length ?? 0}`)
  for (const r of post ?? []) {
    const dp = r.data_points as { r?: number; lag_days?: number; channel_a?: string; channel_b?: string; window_days?: number } | null
    console.log(`  r=${(dp?.r ?? 0).toFixed(3)} lag=${dp?.lag_days}d win=${dp?.window_days}d  ${dp?.channel_a} × ${dp?.channel_b}`)
  }

  // Top-3 by |r|
  const ranked = (post ?? [])
    .map((r) => ({ ...r, dp: r.data_points as { r?: number; lag_days?: number; channel_a?: string; channel_b?: string } | null }))
    .filter((r) => typeof r.dp?.r === 'number')
    .sort((a, b) => Math.abs(b.dp!.r!) - Math.abs(a.dp!.r!))
    .slice(0, 3)
  console.log('\n=== TOP 3 BY |r| ===')
  for (const r of ranked) {
    console.log(`  |r|=${Math.abs(r.dp!.r!).toFixed(3)} lag=${r.dp!.lag_days}d`)
    console.log(`    ${r.dp!.channel_a} × ${r.dp!.channel_b}`)
    console.log(`    ${r.title}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
