/**
 * Wave 17 detector verification — Rixey venue.
 *
 * Usage:
 *   npx tsx scripts/test-wave17-detector.ts
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { detectDisagreements } from '../src/lib/services/disagreement/detect'
import { narrateDisagreements } from '../src/lib/services/disagreement/narrate'
import { getDisagreementSummary } from '../src/lib/services/disagreement/summary'

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
    .limit(10)

  console.log('Production venues:')
  for (const v of (venues ?? []) as Array<{ id: string; name: string }>) {
    console.log(`  ${v.id} — ${v.name}`)
  }
  const rixey = ((venues ?? []) as Array<{ id: string; name: string }>).find((v) =>
    String(v.name ?? '').toLowerCase().includes('rixey'),
  )
  if (!rixey) {
    console.log('No Rixey venue found.')
    process.exit(1)
  }
  console.log(`\nUsing venue: ${rixey.id} — ${rixey.name}\n`)

  console.log('=== Running detector across Rixey weddings (limit 1100) ===')
  const detectResult = await detectDisagreements({
    venueId: rixey.id,
    supabase: sb,
    limit: 1100,
  })
  console.log(`Scanned: ${detectResult.scanned}`)
  console.log(`Written: ${detectResult.written}`)
  console.log(`Refreshed: ${detectResult.refreshed}`)
  console.log(`Candidates total: ${detectResult.candidates.length}`)
  if (detectResult.errors.length > 0) {
    console.log(`Errors: ${detectResult.errors.length}`)
    for (const e of detectResult.errors.slice(0, 5)) console.log(`  - ${e}`)
  }

  console.log('\n=== Per-axis breakdown ===')
  const byAxis: Record<string, number> = {}
  for (const c of detectResult.candidates) {
    byAxis[c.axis] = (byAxis[c.axis] ?? 0) + 1
  }
  const axisEntries = Object.entries(byAxis).sort((a, b) => b[1] - a[1])
  for (const [axis, count] of axisEntries) {
    console.log(`  ${axis}: ${count}`)
  }

  console.log('\n=== Sophie Thomas (948b79a5-5954-4a07-bed4-4fdd3a7d2b95) ===')
  const { data: sophieFindings } = await sb
    .from('disagreement_findings')
    .select('id, axis, stated_value, forensic_value, magnitude_score, confidence_0_100')
    .eq('wedding_id', '948b79a5-5954-4a07-bed4-4fdd3a7d2b95')
  const sf = (sophieFindings ?? []) as Array<{ axis: string; stated_value: unknown; forensic_value: unknown; magnitude_score: number | null; confidence_0_100: number | null }>
  console.log(`Findings: ${sf.length}`)
  for (const f of sf) {
    console.log(`  ${f.axis} mag=${f.magnitude_score} conf=${f.confidence_0_100}`)
    console.log(`    stated:   ${JSON.stringify(f.stated_value)}`)
    console.log(`    forensic: ${JSON.stringify(f.forensic_value)}`)
  }
  if (sf.length === 0) {
    const { data: discovery } = await sb
      .from('discovery_sources')
      .select('canonical_source, answer_text')
      .eq('wedding_id', '948b79a5-5954-4a07-bed4-4fdd3a7d2b95')
      .maybeSingle()
    console.log('  discovery_sources:', discovery)
    const { data: events } = await sb
      .from('attribution_events')
      .select('source_platform, role, intent_class')
      .eq('wedding_id', '948b79a5-5954-4a07-bed4-4fdd3a7d2b95')
      .limit(5)
    console.log('  attribution_events:', events)
  }

  console.log('\n=== Narrating uncached findings (max 3) ===')
  const narrateResult = await narrateDisagreements({
    venueId: rixey.id,
    supabase: sb,
    limit: 3,
  })
  console.log(`Narrated: ${narrateResult.narrated}`)
  console.log(`Cost cents: ${narrateResult.totalCostCents.toFixed(4)}`)
  for (const e of narrateResult.errors.slice(0, 5)) console.log(`  err: ${e}`)

  console.log('\n=== Summary ===')
  const summary = await getDisagreementSummary(rixey.id, { supabase: sb })
  console.log(`Totals: ${JSON.stringify(summary.totals)}`)
  console.log('By axis (with data):')
  for (const b of summary.byAxis.filter((b) => b.total > 0)) {
    console.log(`  ${b.axis}: active=${b.active} total=${b.total}`)
  }

  console.log('\n=== Biggest active finding ===')
  if (summary.biggest.length === 0) {
    console.log('  (none)')
  } else {
    const top = summary.biggest[0]
    console.log(`  axis=${top.axis} magnitude=${top.magnitude_score} confidence=${top.confidence_0_100}`)
    console.log(`  wedding_id: ${top.wedding_id}`)
    console.log(`  stated:   ${JSON.stringify(top.stated_value)}`)
    console.log(`  forensic: ${JSON.stringify(top.forensic_value)}`)
    console.log(`\n  --- narrator ---`)
    console.log(`  ${top.narrator_text ?? '(none yet)'}`)
  }

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
