// Stream TT pre-migration snapshot for Rixey:
//   - count of weddings.source values currently set to scheduling-tool /
//     CRM provenance values that migration 187 will NULL out
//   - distribution by source value
//   - count of NULL lead_source rows (active)
//   - count of weddings with at least one interaction whose
//     extracted_identity.hear_source is set (Q7 backlog)
//   - current backtrace queue size
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

  console.log('=== Stream-TT pre-snapshot for Rixey ===\n')

  // 1. Distribution of weddings.source for Rixey
  const { data: allRows, error: allErr } = await sb
    .from('weddings')
    .select('source, lead_source')
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
  if (allErr) { console.error('weddings load:', allErr); process.exit(1) }
  const tally = new Map<string, number>()
  let nullLeadSource = 0
  let nullSource = 0
  for (const r of allRows ?? []) {
    const k = (r.source as string | null) ?? '(NULL)'
    tally.set(k, (tally.get(k) ?? 0) + 1)
    if (!r.lead_source) nullLeadSource++
    if (!r.source) nullSource++
  }
  console.log(`Total active weddings (Rixey): ${allRows?.length ?? 0}`)
  console.log(`Currently NULL source: ${nullSource}`)
  console.log(`Currently NULL lead_source: ${nullLeadSource}\n`)

  console.log('weddings.source distribution:')
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1])
  let toNullCount = 0
  const TO_NULL = new Set([
    'calendly', 'honeybook', 'other', 'web_form',
    'tour_scheduler', 'generic_csv', 'dubsado', 'aisle_planner',
  ])
  for (const [k, v] of sorted) {
    const flag = TO_NULL.has(k) ? '   ⟵ migration 187 NULLs' : ''
    if (TO_NULL.has(k)) toNullCount += v
    console.log(`  ${k.padEnd(25)} ${String(v).padStart(5)}${flag}`)
  }
  console.log(`\nTotal rows migration 187 will NULL: ${toNullCount}\n`)

  // 2. interactions w/ hear_source
  const { count: hearSourceCount } = await sb
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .not('extracted_identity', 'is', null)
  console.log(`Interactions w/ extracted_identity (any): ${hearSourceCount ?? 0}`)

  // 3. backtrace queue size — call the API service directly
  try {
    const { findBacktraceCandidates } = await import('../../src/lib/services/attribution/source-backtrace')
    const queue = await findBacktraceCandidates(RIXEY_ID, { useLiveGmail: false })
    const queueAll = await findBacktraceCandidates(RIXEY_ID, { useLiveGmail: false, includeNoMatch: true })
    console.log(`\nBacktrace queue (visible / weak+confident): ${queue.length}`)
    console.log(`Backtrace candidates incl. no_match: ${queueAll.length}`)
    let weak = 0, conf = 0, no = 0
    for (const c of queueAll) {
      if (c.status === 'weak_match') weak++
      else if (c.status === 'confident_match') conf++
      else no++
    }
    console.log(`  confident_match: ${conf}`)
    console.log(`  weak_match:      ${weak}`)
    console.log(`  no_match:        ${no}`)
  } catch (e) {
    console.log(`Backtrace probe failed: ${e instanceof Error ? e.message : e}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
