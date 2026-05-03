// Stream QQ diagnostic: why did 620 fall to priority 6 (no_signal)?
// Sample 5 NULL-lead-source weddings + show what signals exist.
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

  // Count interactions per NULL-lead-source wedding
  const { data: nulls, error: nullsErr } = await sb
    .from('weddings')
    .select('id, inquiry_date, source_records, source, source_detail')
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
    .is('lead_source', null)
    .order('inquiry_date', { ascending: false, nullsFirst: false })
    .limit(8)
  if (nullsErr) { console.error('nulls query error:', nullsErr); }
  console.log(`fetched ${(nulls ?? []).length} NULL weddings to inspect`)

  for (const w of nulls ?? []) {
    console.log(`\n--- ${w.id} src=${w.source ?? '(null)'} sd=${(w.source_detail ?? '').slice(0,40)} ${w.inquiry_date ?? '(no inquiry)'}`)
    console.log(`  source_records.length = ${(w.source_records as unknown[] | null)?.length ?? 0}`)

    const { count: ic } = await sb
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', w.id)
    console.log(`  interactions count: ${ic}`)

    const { data: ints } = await sb
      .from('interactions')
      .select('type, direction, from_email, subject, timestamp')
      .eq('wedding_id', w.id)
      .order('timestamp', { ascending: true })
      .limit(3)
    for (const i of ints ?? []) {
      console.log(`    ${i.timestamp} ${i.type} ${i.direction} ${i.from_email ?? ''} | ${(i.subject ?? '').slice(0, 60)}`)
    }

    const { data: ae } = await sb
      .from('attribution_events')
      .select('source_platform, is_first_touch')
      .eq('wedding_id', w.id)
    console.log(`  attribution_events: ${(ae ?? []).map(a => a.source_platform).join(', ') || '(none)'}`)
  }

  // Recent derivation log for Rixey
  console.log('\n=== Last 10 derivation_log rows for Rixey ===')
  const { data: logs } = await sb
    .from('lead_source_derivation_log')
    .select('wedding_id, derived_source, priority_used, evidence, derived_at')
    .eq('venue_id', RIXEY_ID)
    .order('derived_at', { ascending: false })
    .limit(10)
  for (const l of logs ?? []) {
    const ev = JSON.stringify(l.evidence).slice(0, 100)
    console.log(`  ${l.derived_at} p=${l.priority_used} src=${l.derived_source} ev=${ev}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
