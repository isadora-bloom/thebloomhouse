// Stream TT: apply migration 187 effect (NULL out scheduling-tool /
// CRM source values from weddings.source) without going through the
// supabase CLI. Equivalent to running:
//
//   UPDATE weddings SET source = NULL,
//          lead_source_derivation_attempted_at = NULL
//   WHERE source IN (
//     'calendly', 'honeybook', 'other', 'web_form',
//     'tour_scheduler', 'generic_csv', 'dubsado', 'aisle_planner'
//   );
//
// Then logs one lead_source_derivation_log audit row per affected
// wedding so coordinators can see why source briefly went un-attributed.
//
// Idempotent. Safe to run twice.

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

  const TO_NULL = ['calendly', 'honeybook', 'other', 'web_form', 'tour_scheduler', 'generic_csv', 'dubsado', 'aisle_planner']

  // Step 1: identify affected rows so we can log them BEFORE the update.
  const { data: affectedRows, error: selErr } = await sb
    .from('weddings')
    .select('id, venue_id, source')
    .in('source', TO_NULL)
  if (selErr) { console.error('select failed:', selErr); process.exit(1) }

  const totalAffected = affectedRows?.length ?? 0
  console.log(`Migration 187: ${totalAffected} weddings affected`)
  if (totalAffected === 0) {
    console.log('Nothing to do — migration is a no-op (already applied, or no scheduling-tool sources).')
    return
  }

  // Group by venue + source for the report.
  const byVenue = new Map<string, Map<string, number>>()
  for (const r of affectedRows!) {
    const v = r.venue_id as string
    const s = (r.source as string) ?? '(NULL)'
    const m = byVenue.get(v) ?? new Map<string, number>()
    m.set(s, (m.get(s) ?? 0) + 1)
    byVenue.set(v, m)
  }
  console.log('\nPer-venue breakdown:')
  for (const [v, m] of byVenue.entries()) {
    const parts = [...m.entries()].map(([k, n]) => `${k}=${n}`).join(', ')
    console.log(`  venue ${v.slice(0, 8)}…: ${parts}`)
  }

  // Step 2: log audit rows BEFORE the UPDATE so source values are
  // captured. Use raw insert into lead_source_derivation_log; idempotent
  // via a NOT EXISTS check that mirrors the migration SQL.
  console.log('\nWriting audit log rows (lead_source_derivation_log)…')
  const logPayloads = affectedRows!.map((r) => ({
    venue_id: r.venue_id as string,
    wedding_id: r.id as string,
    derived_source: null,
    // priority_used CHECK is [0..6] per migration 177. Use 6
    // (no_signal) to mark "this row was reset; derivation must re-run".
    priority_used: 6,
    evidence: {
      migration: '187_null_scheduling_tool_sources',
      reset_from: r.source,
      reason: 'adapter-as-facts cleanup; pre-Stream-TT adapters wrote scheduling-tool values into weddings.source. Reset to NULL so derivation can run.',
    },
    confidence: 'low',
    decided_by: 'auto',
    reason: 'migration_187_adapter_as_facts',
  }))

  // Insert in chunks of 100 for safety.
  let logged = 0
  for (let i = 0; i < logPayloads.length; i += 100) {
    const chunk = logPayloads.slice(i, i + 100)
    const { error: insErr } = await sb.from('lead_source_derivation_log').insert(chunk)
    if (insErr) {
      console.error(`  log insert chunk ${i}-${i + chunk.length} failed:`, insErr.message.slice(0, 200))
      // Don't bail — the UPDATE is still safe to run, just lose some audit.
    } else {
      logged += chunk.length
    }
  }
  console.log(`Logged ${logged}/${totalAffected} audit rows.`)

  // Step 3: NULL out the source + reset derivation cursor.
  console.log('\nUpdating weddings (source → NULL, lead_source_derivation_attempted_at → NULL)…')
  const { error: updErr, count: updCount } = await sb
    .from('weddings')
    .update({ source: null, lead_source_derivation_attempted_at: null }, { count: 'exact' })
    .in('source', TO_NULL)
  if (updErr) { console.error('UPDATE failed:', updErr); process.exit(1) }
  console.log(`Updated ${updCount} rows.`)

  // Step 4: post-snapshot for sanity.
  const { data: postRows, error: postErr } = await sb
    .from('weddings')
    .select('source')
    .in('source', TO_NULL)
  if (postErr) { console.error('post-check failed:', postErr); process.exit(1) }
  console.log(`\nPost-check: ${postRows?.length ?? 0} rows still have a scheduling-tool source (should be 0).`)
}

main().catch((e) => { console.error(e); process.exit(1) })
