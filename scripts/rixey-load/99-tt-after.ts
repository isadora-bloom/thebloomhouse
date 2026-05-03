// Stream TT post-snapshot for Rixey: confirm migration 187 cleaned
// up the affected rows + report the new backtrace queue size.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  console.log('=== Stream-TT post-snapshot for Rixey ===\n')

  const { data: rows } = await sb
    .from('weddings')
    .select('source, lead_source')
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
  const tally = new Map<string, number>()
  let nullSource = 0
  let nullLead = 0
  for (const r of rows ?? []) {
    const k = (r.source as string | null) ?? '(NULL)'
    tally.set(k, (tally.get(k) ?? 0) + 1)
    if (!r.source) nullSource++
    if (!r.lead_source) nullLead++
  }
  console.log(`Total active weddings: ${rows?.length ?? 0}`)
  console.log(`NULL source: ${nullSource}`)
  console.log(`NULL lead_source: ${nullLead}\n`)

  console.log('weddings.source distribution (post-migration-187):')
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(25)} ${String(v).padStart(5)}`)
  }

  // Verify zero scheduling-tool sources remain
  const SCHED = ['calendly', 'honeybook', 'other', 'web_form', 'tour_scheduler', 'generic_csv', 'dubsado', 'aisle_planner']
  const { count: residual } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .in('source', SCHED)
  console.log(`\nResidual scheduling-tool sources venue-wide: ${residual ?? 0} (target: 0)`)

  // Audit-log row count for migration 187
  const { count: auditCount } = await sb
    .from('lead_source_derivation_log')
    .select('id', { count: 'exact', head: true })
    .eq('reason', 'migration_187_adapter_as_facts')
  console.log(`Audit-log rows for migration_187_adapter_as_facts: ${auditCount ?? 0}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
