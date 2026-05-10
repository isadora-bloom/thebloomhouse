/**
 * Wave 5B smoke test: run a cohort rollup against the Rixey venue and
 * print the top emerging themes + correlations + cost.
 *
 * Usage:
 *   npx tsx scripts/smoke-wave-5b.ts             # default 90d window
 *   npx tsx scripts/smoke-wave-5b.ts 60          # 60d window
 *   npx tsx scripts/smoke-wave-5b.ts 90 force    # ignore cache
 *
 * Requires .env.local with NEXT_PUBLIC_SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY + ANTHROPIC_API_KEY.
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

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
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
  process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY
  if (env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = env.OPENAI_API_KEY

  const windowDays = Number(process.argv[2]) || 90
  const force = process.argv[3] === 'force'

  const sb = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL!,
    env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  // Find the Rixey venue (by name "Rixey Manor").
  const { data: rixeyRow } = await sb
    .from('venues')
    .select('id, name')
    .ilike('name', 'Rixey Manor')
    .maybeSingle()

  const venue =
    (rixeyRow as { id: string; name: string } | null) ?? null
  if (!venue) {
    console.error('Rixey Manor venue not found.')
    process.exit(1)
  }
  const venueId = venue.id
  console.log(`\nUsing venue: ${venue.name} (${venueId})`)
  console.log(`Window: ${windowDays}d   force: ${force}\n`)

  const { runCohortRollup, getStoredVenueIntel } = await import(
    '../src/lib/services/intel/cohort-rollup'
  )

  if (!force) {
    const stored = await getStoredVenueIntel(venueId)
    if (stored) {
      const ageMs = Date.now() - Date.parse(stored.lastRefreshedAt)
      const ageDays = Math.floor(ageMs / 86_400_000)
      const cacheFresh =
        ageMs < 7 * 86_400_000 && stored.sourceWindowDays === windowDays
      console.log(
        `Stored rollup found. age=${ageDays}d  window=${stored.sourceWindowDays}d  fresh=${cacheFresh}`,
      )
      if (cacheFresh) {
        console.log('Cache hit — would NOT re-run. Pass "force" to override.\n')
        printRollup(stored.rollup, stored.couplesInWindow, stored.costCents)
        return
      }
    }
  }

  console.log('Running fresh rollup (Sonnet aggregator)...')
  const start = Date.now()
  const result = await runCohortRollup(venueId, { windowDays })
  const ms = Date.now() - start
  console.log(`Done in ${(ms / 1000).toFixed(1)}s\n`)
  console.log(
    `couplesInWindow=${result.couplesInWindow}   costCents=${result.costCents.toFixed(4)}   tokens=${result.inputTokens}->${result.outputTokens}`,
  )
  console.log(`promptVersion=${result.promptVersion}\n`)
  printRollup(result.rollup, result.couplesInWindow, result.costCents)
}

interface RollupShape {
  emerging_themes: Array<{
    theme: string
    trend: string
    evidence_count: number
    sensitivity_filtered_count: number
    summary: string
  }>
  conversion_correlations: Array<{
    signal: string
    outcome: string
    lift_pct: number
    n_couples: number
    confidence_0_100: number
    reasoning: string
  }>
  voice_calibration: Array<{
    persona_label: string
    language_that_lands: string[]
    language_to_avoid: string[]
  }>
  service_demand_map: Array<{
    service_or_offering: string
    demand_signal: string
    currently_offered: string
    investment_recommendation: string
  }>
  timing_patterns: Array<{
    pattern: string
    actionable_recommendation: string
  }>
  refusals: Array<{ field: string; reason: string }>
}

function printRollup(rollup: RollupShape, couples: number, costCents: number) {
  console.log(`================== ROLLUP ==================`)
  console.log(`couples=${couples}   cumulative_cost_cents=${costCents.toFixed(4)}`)
  console.log()

  console.log(`---- Emerging themes (${rollup.emerging_themes.length}) ----`)
  for (const t of rollup.emerging_themes.slice(0, 5)) {
    const sens = t.sensitivity_filtered_count > 0 ? ` [+${t.sensitivity_filtered_count} sensitive]` : ''
    console.log(`  • ${t.theme}  (${t.trend}, n=${t.evidence_count})${sens}`)
    console.log(`    ${t.summary}`)
  }
  console.log()

  console.log(`---- Conversion correlations (${rollup.conversion_correlations.length}) ----`)
  const sorted = [...rollup.conversion_correlations].sort(
    (a, b) => Math.abs(b.lift_pct) - Math.abs(a.lift_pct),
  )
  for (const c of sorted.slice(0, 5)) {
    console.log(
      `  • ${c.signal}  →  ${c.outcome}  ${c.lift_pct >= 0 ? '+' : ''}${c.lift_pct}% (n=${c.n_couples}, conf=${c.confidence_0_100})`,
    )
    console.log(`    ${c.reasoning}`)
  }
  console.log()

  console.log(`---- Voice calibration (${rollup.voice_calibration.length}) ----`)
  for (const v of rollup.voice_calibration.slice(0, 3)) {
    console.log(`  • ${v.persona_label}`)
    console.log(`    lands: ${v.language_that_lands.slice(0, 3).join(' | ')}`)
    console.log(`    avoid: ${v.language_to_avoid.slice(0, 3).join(' | ')}`)
  }
  console.log()

  console.log(`---- Service demand (${rollup.service_demand_map.length}) ----`)
  for (const s of rollup.service_demand_map.slice(0, 3)) {
    console.log(
      `  • ${s.service_or_offering}  [offered=${s.currently_offered}]`,
    )
    console.log(`    demand: ${s.demand_signal}`)
    console.log(`    → ${s.investment_recommendation}`)
  }
  console.log()

  console.log(`---- Timing (${rollup.timing_patterns.length}) ----`)
  for (const t of rollup.timing_patterns.slice(0, 3)) {
    console.log(`  • ${t.pattern}`)
    console.log(`    → ${t.actionable_recommendation}`)
  }
  console.log()

  if (rollup.refusals.length > 0) {
    console.log(`---- Refusals (${rollup.refusals.length}) ----`)
    for (const r of rollup.refusals) {
      console.log(`  • ${r.field}: ${r.reason}`)
    }
    console.log()
  }
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
