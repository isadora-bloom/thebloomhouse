// Stream WW: re-fire lead-source derivation for Rixey after the
// extracted_identity backfill (40-ww-calendly-reimport.ts). Resets
// the OO pagination cursor (lead_source_derivation_attempted_at) on
// every active NULL-lead_source wedding so the cron immediately
// re-tries them rather than waiting 30 days.
//
// Captures per-priority counts so we can confirm Priority 2
// (extracted_identity.hear_source) is now firing on the Calendly
// cohort that previously fell through to no_signal.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { deriveLeadSourceForVenue } from '../../src/lib/services/lead-source-derivation'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  console.log('=== Stream WW: re-derive lead_source for Rixey ===\n')

  const { count: nullBefore } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
    .is('lead_source', null)
  console.log(`NULL lead_source (active) BEFORE: ${nullBefore}`)

  // Reset attempted_at so the cron re-tries every NULL row this pass.
  // Without this, Stream OO's 30-day pagination guard would skip rows
  // we just tried within the last 30 days.
  console.log('Resetting lead_source_derivation_attempted_at on NULL rows...')
  const { error: clrErr, count: cleared } = await sb
    .from('weddings')
    .update({ lead_source_derivation_attempted_at: null }, { count: 'exact' })
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
    .is('lead_source', null)
    .not('lead_source_derivation_attempted_at', 'is', null)
  if (clrErr) {
    console.error(`reset error: ${clrErr.message}`)
    process.exit(1)
  }
  console.log(`Reset ${cleared} attempted_at stamps.\n`)

  // Run the derivation cron in a loop until it scans 0 weddings (the
  // cron is paginated so multiple passes may be needed for >500 NULLs).
  let pass = 0
  let totalDerived = 0
  const aggregatePerPriority: Record<number, number> = {}
  while (pass < 20) {
    pass++
    const r = await deriveLeadSourceForVenue(sb, RIXEY_ID)
    console.log(`Pass ${pass}: scanned=${r.weddingsScanned} derived=${r.derived} noSignal=${r.noSignal}`)
    console.log(`  perPriority:`, r.perPriority)
    for (const [k, v] of Object.entries(r.perPriority)) {
      aggregatePerPriority[Number(k)] = (aggregatePerPriority[Number(k)] ?? 0) + v
    }
    if (r.errors.length > 0) {
      console.log(`  errors[0..3]: ${r.errors.slice(0, 3).join(' | ')}`)
    }
    totalDerived += r.derived
    if (r.weddingsScanned === 0) break
  }

  console.log()
  console.log(`TOTAL derived this run: ${totalDerived}`)
  console.log(`Aggregate perPriority:`, aggregatePerPriority)

  const { count: nullAfter } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
    .is('lead_source', null)
  console.log(`\nNULL lead_source (active) AFTER: ${nullAfter}  (was ${nullBefore})`)

  // Lead-source distribution.
  const { data: byLead } = await sb
    .from('weddings')
    .select('lead_source, status')
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
  const tally = new Map<string, { all: number; booked: number }>()
  for (const w of byLead ?? []) {
    const k = (w.lead_source as string | null) ?? '(NULL)'
    const cur = tally.get(k) ?? { all: 0, booked: 0 }
    cur.all++
    if (['booked', 'completed'].includes(String(w.status))) cur.booked++
    tally.set(k, cur)
  }
  console.log(`\nlead_source distribution (active weddings):`)
  console.log(`  source                    | total | booked`)
  console.log(`  --------------------------+-------+-------`)
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1].all - a[1].all)) {
    console.log(`  ${k.padEnd(25)} | ${String(v.all).padStart(5)} | ${String(v.booked).padStart(5)}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
