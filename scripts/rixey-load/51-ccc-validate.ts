/**
 * T5-Rixey-CCC validation — capture pre/post snapshot and run the
 * backtrack on Rixey, report counts.
 *
 * Read-mostly: writes attribution_events + candidate_identities updates
 * via the production runBacktrackForVenue path (the actual feature).
 * Idempotent (INSERT ON CONFLICT DO NOTHING via the candidate
 * resolved_wedding_id race-guard).
 *
 * Run: npx tsx scripts/rixey-load/51-ccc-validate.ts
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { runBacktrackForVenue } from '../../src/lib/services/identity/backtrack'
import { deriveLeadSourceForVenue } from '../../src/lib/services/attribution/lead-source-derivation'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)

const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL!,
  env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Count helpers — Supabase head:true count returns exact via headers.
async function count(table: string, filter: (q: any) => any): Promise<number> {
  const { count, error } = await filter(sb.from(table).select('*', { count: 'exact', head: true }))
  if (error) {
    console.warn(`[count ${table}] ${error.message}`)
    return -1
  }
  return count ?? 0
}

async function snapshot(label: string) {
  const totalSignals = await count('tangential_signals', (q) => q.eq('venue_id', RIXEY))
  const linkedSignals = await count('attribution_events', (q) =>
    q.eq('venue_id', RIXEY).is('reverted_at', null))
  const knotSignals = await count('tangential_signals', (q) =>
    q.eq('venue_id', RIXEY).eq('source_platform', 'the_knot'))
  // Distinct signals on the_knot platform with attribution
  const knotAttributions = await count('attribution_events', (q) =>
    q.eq('venue_id', RIXEY).eq('source_platform', 'the_knot').is('reverted_at', null))
  const candidatesUnresolved = await count('candidate_identities', (q) =>
    q.eq('venue_id', RIXEY).is('resolved_wedding_id', null).is('deleted_at', null))
  const candidatesResolved = await count('candidate_identities', (q) =>
    q.eq('venue_id', RIXEY).not('resolved_wedding_id', 'is', null).is('deleted_at', null))

  // lead_source counts on weddings.lead_source = the_knot
  const knotLeadSourceCount = await count('weddings', (q) =>
    q.eq('venue_id', RIXEY).is('merged_into_id', null).eq('lead_source', 'the_knot'))

  console.log(`\n=== ${label} ===`)
  console.log(`  total tangential_signals (Rixey):        ${totalSignals}`)
  console.log(`  total the_knot tangential_signals:       ${knotSignals}`)
  console.log(`  attribution_events (live):               ${linkedSignals}`)
  console.log(`  attribution_events for the_knot (live):  ${knotAttributions}`)
  console.log(`  candidate_identities resolved:           ${candidatesResolved}`)
  console.log(`  candidate_identities unresolved:         ${candidatesUnresolved}`)
  console.log(`  weddings.lead_source = the_knot:         ${knotLeadSourceCount}`)
  return {
    totalSignals,
    knotSignals,
    linkedSignals,
    knotAttributions,
    candidatesResolved,
    candidatesUnresolved,
    knotLeadSourceCount,
  }
}

async function main() {
  console.log('=== T5-Rixey-CCC validation ===')
  console.log(`Rixey venue: ${RIXEY}`)

  const before = await snapshot('PRE-CCC')

  console.log('\n[1] running backtrack...')
  const t0 = Date.now()
  const summary = await runBacktrackForVenue(sb as any, RIXEY, { skipReattemptWindow: true })
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`  elapsed: ${dt}s`)
  console.log(`  weddingsScanned:       ${summary.weddingsScanned}`)
  console.log(`  candidatesEvaluated:   ${summary.candidatesEvaluated}`)
  console.log(`  highAutoLinked:        ${summary.highAutoLinked}`)
  console.log(`  mediumQueued:          ${summary.mediumQueued}`)
  console.log(`  ambiguousDeferred:     ${summary.ambiguousDeferred}`)
  console.log(`  lowSkipped:            ${summary.lowSkipped}`)
  console.log(`  noMatch:               ${summary.noMatch}`)
  if (summary.errors.length > 0) {
    console.log(`  errors:                ${summary.errors.length}`)
    for (const e of summary.errors.slice(0, 10)) console.log(`    - ${e}`)
  }

  const after = await snapshot('POST-CCC (before re-derive)')

  console.log('\n[2] running deriveLeadSourceForVenue (so weddings.lead_source picks up new attributions)...')
  const t1 = Date.now()
  const ds = await deriveLeadSourceForVenue(sb as any, RIXEY)
  console.log(`  elapsed: ${((Date.now() - t1) / 1000).toFixed(1)}s`)
  console.log(`  weddingsScanned: ${ds.weddingsScanned}`)
  console.log(`  derived:         ${ds.derived}`)
  console.log(`  noSignal:        ${ds.noSignal}`)
  console.log(`  perPriority:     ${JSON.stringify(ds.perPriority)}`)
  if (ds.errors.length > 0) console.log(`  errors:          ${ds.errors.length}`)

  const finalSnap = await snapshot('POST-CCC (after re-derive)')

  // Sample 5 newly-linked: pull recent backtrack attributions.
  console.log('\n[3] sample of 5 most-recent backtrack attribution_events:')
  const { data: sample } = await sb
    .from('attribution_events')
    .select('id, wedding_id, candidate_identity_id, source_platform, confidence, tier, decided_at, reasoning')
    .eq('venue_id', RIXEY)
    .like('reasoning', 'backtrack%')
    .order('decided_at', { ascending: false })
    .limit(5)
  for (const row of (sample ?? []) as any[]) {
    const { data: wed } = await sb
      .from('weddings')
      .select('id, inquiry_date, source')
      .eq('id', row.wedding_id)
      .maybeSingle()
    const { data: ppl } = await sb
      .from('people')
      .select('first_name, last_name, role')
      .eq('wedding_id', row.wedding_id)
    const p1 = (ppl ?? []).find((p: any) => p.role === 'partner1') ?? (ppl ?? [])[0]
    const partnerName = p1 ? `${p1.first_name ?? ''} ${p1.last_name ?? ''}`.trim() : '(unknown)'
    const { data: cand } = await sb
      .from('candidate_identities')
      .select('first_name, last_initial, state, source_platform, signal_count')
      .eq('id', row.candidate_identity_id)
      .maybeSingle()
    const candLabel = cand
      ? `${(cand as any).first_name ?? '?'} ${(cand as any).last_initial ?? '?'}. (${(cand as any).source_platform}, ${(cand as any).signal_count} signals${(cand as any).state ? `, ${(cand as any).state}` : ''})`
      : '(missing)'
    console.log(`  - wedding "${partnerName}" inquiry=${(wed as any)?.inquiry_date ?? '?'} | candidate ${candLabel} | tier ${row.tier} conf ${row.confidence}`)
    console.log(`    reasoning: ${(row.reasoning ?? '').slice(0, 140)}`)
  }

  // ---------- diff report ----------
  console.log('\n=== DIFF SUMMARY ===')
  const before247 = before.linkedSignals
  const after247 = finalSnap.linkedSignals
  console.log(`  total tangential_signals:                      ${before.totalSignals}`)
  console.log(`  attribution_events (live)  before → after:     ${before247} → ${after247} (Δ ${after247 - before247})`)
  console.log(`  the_knot attribution_events  before → after:   ${before.knotAttributions} → ${finalSnap.knotAttributions} (Δ ${finalSnap.knotAttributions - before.knotAttributions})`)
  console.log(`  candidate_identities resolved  before → after: ${before.candidatesResolved} → ${finalSnap.candidatesResolved} (Δ ${finalSnap.candidatesResolved - before.candidatesResolved})`)
  console.log(`  candidate_identities unresolved before → after: ${before.candidatesUnresolved} → ${finalSnap.candidatesUnresolved} (Δ ${finalSnap.candidatesUnresolved - before.candidatesUnresolved})`)
  console.log(`  weddings.lead_source = the_knot:               ${before.knotLeadSourceCount} → ${finalSnap.knotLeadSourceCount} (Δ ${finalSnap.knotLeadSourceCount - before.knotLeadSourceCount})`)
  console.log(`  backtrack auto-linked (this run):              ${summary.highAutoLinked}`)
  console.log(`  backtrack queued for review (this run):        ${summary.mediumQueued}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
