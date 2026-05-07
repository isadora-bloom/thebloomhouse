// Stream QQ: force re-derivation by clearing attempted_at on all NULL
// lead_source rows for Rixey, then re-run derivation. The OO cleanup
// widened patterns and the NN HTML guard fixed bug #7, so a fresh
// attempt may catch derivations the prior pass missed.
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

  const { count: nullBefore } = await sb
    .from('weddings').select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null).is('lead_source', null)
  console.log(`NULL lead_source (active): ${nullBefore}`)

  // Clear attempted_at so the OO pagination cursor resets (the prior
  // run already stamped these; we need a fresh pass with the NN+OO
  // pattern improvements). One-off operation for stream QQ.
  console.log('Clearing lead_source_derivation_attempted_at on NULL rows...')
  const { error: clrErr, count: cleared } = await sb
    .from('weddings')
    .update({ lead_source_derivation_attempted_at: null }, { count: 'exact' })
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
    .is('lead_source', null)
    .not('lead_source_derivation_attempted_at', 'is', null)
  if (clrErr) { console.error(clrErr); process.exit(1) }
  console.log(`Cleared ${cleared} attempted_at stamps.`)

  let pass = 0
  let totalDerived = 0
  while (pass < 10) {
    pass++
    console.log(`\n=== Pass ${pass} ===`)
    const r = await deriveLeadSourceForVenue(sb, RIXEY_ID)
    console.log(`weddingsScanned=${r.weddingsScanned} derived=${r.derived} noSignal=${r.noSignal}`)
    console.log('perPriority:', r.perPriority)
    if (r.errors.length > 0) console.log(`errors[0..4]: ${r.errors.slice(0,5).join(' | ')}`)
    totalDerived += r.derived
    if (r.weddingsScanned === 0) break
  }

  const { count: nullAfter } = await sb
    .from('weddings').select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null).is('lead_source', null)
  console.log(`\nNULL lead_source (active): ${nullAfter}  (was ${nullBefore})`)
  console.log(`Total derived this run: ${totalDerived}`)

  const { data: bySource } = await sb
    .from('weddings').select('lead_source')
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null)
  const tally: Record<string, number> = {}
  for (const w of bySource ?? []) {
    const k = w.lead_source ?? '(null)'
    tally[k] = (tally[k] ?? 0) + 1
  }
  console.log('\nLead-source distribution (active):')
  for (const [k, v] of Object.entries(tally).sort((a,b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(30)} ${v}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
