// Phase 8: Lead-source derivation. Run multiple passes since the function caps at 500 per call.
//
// T5-Rixey-OO #6 (2026-05-02): the cron now stamps
// lead_source_derivation_attempted_at after every attempt and skips
// rows attempted within the last 30 days. Each pass therefore makes
// real forward progress (no infinite loop on the no_signal bucket).
// We loop until weddingsScanned drops to 0, which means every NULL
// lead_source row has an attempted_at stamp.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { deriveLeadSourceForVenue } from '../../src/lib/services/attribution/lead-source-derivation'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  // Pre-count
  const { count: nullBefore } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
    .is('lead_source', null)
  console.log(`Active weddings with NULL lead_source: ${nullBefore}`)

  // T5-Rixey-OO #6: with attempted_at pagination, weddingsScanned
  // strictly decreases every pass until 0. Cap at 10 passes to be
  // safe against runaway loops if the SELECT or the stamp ever
  // regresses.
  let pass = 0
  while (pass < 10) {
    pass++
    console.log(`\n=== Pass ${pass} ===`)
    const r = await deriveLeadSourceForVenue(sb, RIXEY_ID)
    console.log(`weddingsScanned=${r.weddingsScanned} derived=${r.derived} noSignal=${r.noSignal}`)
    console.log('perPriority:', r.perPriority)
    if (r.errors.length > 0) console.log(`errors[0..4]: ${r.errors.slice(0, 5).join(' | ')}`)
    if (r.weddingsScanned === 0) break
  }

  // Post-count
  const { count: nullAfter } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
    .is('lead_source', null)
  console.log(`\nActive weddings with NULL lead_source: ${nullAfter}`)

  // Distribution
  const { data: bySource } = await sb
    .from('weddings')
    .select('lead_source')
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
  const tally: Record<string, number> = {}
  for (const w of bySource ?? []) {
    const k = w.lead_source ?? '(null)'
    tally[k] = (tally[k] ?? 0) + 1
  }
  console.log('\nLead-source distribution (active):')
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(30)} ${v}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
