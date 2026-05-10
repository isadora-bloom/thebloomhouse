/**
 * Wave 7B: bulk reclassify a small batch WITH the LLM judge enabled to
 * compute the real validation share for Knot.
 *
 * Cost guard: noLLM=false but we keep the batch small (limit=20) so
 * cost stays under ~$0.20.
 *
 * Usage:
 *   npx tsx scripts/wave7b-bulk-llm.ts
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
  for (const k of Object.keys(env)) process.env[k] = env[k]

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  const { reclassifyVenueAttribution } = await import(
    '../src/lib/services/attribution-roles/reclassify-venue'
  )
  const { getRoleSummary } = await import(
    '../src/lib/services/attribution-roles/role-summary'
  )

  // Find the mixed events specifically — those are the LLM-judge candidates.
  const { data: mixedTargets } = await sb
    .from('attribution_events')
    .select('id')
    .eq('venue_id', RIXEY_VENUE_ID)
    .eq('role', 'mixed')
    .is('reverted_at', null)
    .order('decided_at', { ascending: false })
    .limit(20)
  console.log(`Found ${mixedTargets?.length ?? 0} mixed events to LLM-judge`)

  const { classifyAndPersistAttributionEvent } = await import(
    '../src/lib/services/attribution-roles/classify'
  )

  let totalCost = 0
  const tally: Record<string, number> = {}
  for (const t of (mixedTargets ?? []) as Array<{ id: string }>) {
    try {
      const r = await classifyAndPersistAttributionEvent(
        { attributionEventId: t.id },
        { supabase: sb as never, noLLM: false },
      )
      totalCost += r.cost_cents
      tally[r.role] = (tally[r.role] ?? 0) + 1
      console.log(`  ${t.id} -> ${r.role} (${r.role_confidence_0_100}%)`)
    } catch (err) {
      console.warn(`  ${t.id} ERROR:`, err instanceof Error ? err.message : err)
    }
  }
  console.log('\nLLM judge tally on 20 mixed events:', tally)
  console.log('total cost cents:', totalCost.toFixed(2))

  console.log('\nFinal role-summary:')
  const summary = await getRoleSummary(RIXEY_VENUE_ID, { supabase: sb as never })
  console.log('  totalEvents:', summary.totalEvents)
  console.log('  byRole:', summary.byRole)
  for (const cell of summary.byChannel) {
    const valShare =
      cell.validation_share_0_1 === null
        ? 'n/a'
        : `${Math.round(cell.validation_share_0_1 * 100)}%`
    console.log(
      `  ${cell.channel}: total=${cell.total} acq=${cell.acquisition} val=${cell.validation} conv=${cell.conversion} mixed=${cell.mixed} unk=${cell.unknown} | %validation=${valShare}`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
