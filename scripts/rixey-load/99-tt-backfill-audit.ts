// Stream TT backfill: write the migration-187 audit rows that the
// initial apply script failed to insert (priority_used CHECK was [0..6];
// the script used -1). Re-runs only on rows that lack an existing
// audit row tagged 'migration_187_adapter_as_facts'.
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

  // Find the rows that the migration just NULLed (source IS NULL AND
  // attempted_at IS NULL — that's the marker the migration sets).
  const { data: targets } = await sb
    .from('weddings')
    .select('id, venue_id')
    .is('source', null)
    .is('lead_source_derivation_attempted_at', null)
  if (!targets) { console.error('select failed'); process.exit(1) }
  console.log(`Candidate weddings (source IS NULL + attempted_at IS NULL): ${targets.length}`)

  // Skip rows that already have a migration-187 log row (idempotent).
  const ids = targets.map((t) => t.id as string)
  const existing = new Set<string>()
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { data: rows } = await sb
      .from('lead_source_derivation_log')
      .select('wedding_id')
      .eq('reason', 'migration_187_adapter_as_facts')
      .in('wedding_id', chunk)
    for (const r of rows ?? []) existing.add(r.wedding_id as string)
  }
  console.log(`Already-logged: ${existing.size}; needing log: ${targets.length - existing.size}`)

  const toInsert = targets
    .filter((t) => !existing.has(t.id as string))
    .map((t) => ({
      venue_id: t.venue_id as string,
      wedding_id: t.id as string,
      derived_source: null,
      priority_used: 6,
      evidence: {
        migration: '187_null_scheduling_tool_sources',
        reason: 'adapter-as-facts cleanup; weddings.source reset to NULL so derivation can run.',
      },
      confidence: 'low',
      decided_by: 'auto',
      reason: 'migration_187_adapter_as_facts',
    }))

  let logged = 0
  for (let i = 0; i < toInsert.length; i += 100) {
    const chunk = toInsert.slice(i, i + 100)
    const { error } = await sb.from('lead_source_derivation_log').insert(chunk)
    if (error) { console.error(`chunk ${i}:`, error.message.slice(0, 200)); continue }
    logged += chunk.length
  }
  console.log(`Logged ${logged} audit rows.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
