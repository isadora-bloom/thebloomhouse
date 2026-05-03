/**
 * T5-Rixey-LLL B9 — re-run identity backtrack on Rixey at all-time
 * scope. The Multi-touch Split panel on /intel/sources reports only
 * 5 / 82 booked weddings have multi-platform attribution coverage.
 * The 90d default panel window is one explanation; the deeper one is
 * that the original CCC backtrack (script 51) only walked candidates
 * inside the default lookback windows. Re-running with skipReattempt
 * and the full historical wedding set lets every storefront candidate
 * get a second pass against every wedding inquiry — including the
 * ones from before the candidate's window was set.
 *
 * Idempotent: per migration 191, candidate_identities.backtrack_attempted_at
 * gates re-evaluation. We pass `{ skipReattemptWindow: true }` so
 * every candidate is re-considered. Already-resolved candidates are
 * skipped by the service's resolved_wedding_id race-guard, and
 * already-linked attribution_events are NOT duplicated thanks to the
 * (candidate, wedding) signal_id check inside autoLinkCandidate.
 *
 * Run: npx tsx scripts/rixey-load/58-lll-rixey-backtrack-all.ts
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { runBacktrackForVenue } from '../../src/lib/services/identity-backtrack'

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

async function count(table: string, filter: (q: any) => any): Promise<number> {
  const { count, error } = await filter(sb.from(table).select('*', { count: 'exact', head: true }))
  if (error) {
    console.warn(`[count ${table}] ${error.message}`)
    return -1
  }
  return count ?? 0
}

interface Snapshot {
  totalCandidates: number
  candidatesResolved: number
  candidatesUnresolved: number
  totalSignals: number
  signalsAttached: number // tangential_signals with at least one attribution_event
  attributionEvents: number
  // Multi-touch coverage proxy: distinct booked weddings with at least
  // one attribution_event row.
  bookedWeddings: number
  bookedWithAttribution: number
}

async function snapshot(label: string): Promise<Snapshot> {
  const totalCandidates = await count('candidate_identities', (q) =>
    q.eq('venue_id', RIXEY).is('deleted_at', null))
  const candidatesResolved = await count('candidate_identities', (q) =>
    q.eq('venue_id', RIXEY).is('deleted_at', null).not('resolved_wedding_id', 'is', null))
  const candidatesUnresolved = await count('candidate_identities', (q) =>
    q.eq('venue_id', RIXEY).is('deleted_at', null).is('resolved_wedding_id', null))
  const totalSignals = await count('tangential_signals', (q) => q.eq('venue_id', RIXEY))
  const attributionEvents = await count('attribution_events', (q) =>
    q.eq('venue_id', RIXEY).is('reverted_at', null))

  // signalsAttached = distinct signal_id in attribution_events for Rixey.
  // Two-step: pull all signal_ids from attribution_events, dedupe.
  let signalsAttached = 0
  {
    const ids = new Set<string>()
    const PAGE = 1000
    let from = 0
    for (;;) {
      const { data, error } = await sb
        .from('attribution_events')
        .select('signal_id')
        .eq('venue_id', RIXEY)
        .is('reverted_at', null)
        .not('signal_id', 'is', null)
        .range(from, from + PAGE - 1)
      if (error) {
        console.warn(`[signalsAttached] ${error.message}`)
        break
      }
      const page = (data ?? []) as Array<{ signal_id: string | null }>
      for (const r of page) if (r.signal_id) ids.add(r.signal_id)
      if (page.length < PAGE) break
      from += PAGE
    }
    signalsAttached = ids.size
  }

  const bookedWeddings = await count('weddings', (q) =>
    q.eq('venue_id', RIXEY).is('merged_into_id', null).in('status', ['booked', 'completed']))

  // bookedWithAttribution = distinct wedding_id in attribution_events
  // where the wedding is booked/completed.
  let bookedWithAttribution = 0
  {
    const wedIds = new Set<string>()
    const PAGE = 1000
    let from = 0
    for (;;) {
      const { data, error } = await sb
        .from('attribution_events')
        .select('wedding_id')
        .eq('venue_id', RIXEY)
        .is('reverted_at', null)
        .range(from, from + PAGE - 1)
      if (error) {
        console.warn(`[bookedWithAttribution.events] ${error.message}`)
        break
      }
      const page = (data ?? []) as Array<{ wedding_id: string | null }>
      for (const r of page) if (r.wedding_id) wedIds.add(r.wedding_id)
      if (page.length < PAGE) break
      from += PAGE
    }
    if (wedIds.size > 0) {
      const idsArr = Array.from(wedIds)
      const CHUNK = 200
      for (let i = 0; i < idsArr.length; i += CHUNK) {
        const chunk = idsArr.slice(i, i + CHUNK)
        const { data, error } = await sb
          .from('weddings')
          .select('id')
          .in('id', chunk)
          .in('status', ['booked', 'completed'])
          .is('merged_into_id', null)
        if (error) {
          console.warn(`[bookedWithAttribution.weddings] ${error.message}`)
          break
        }
        bookedWithAttribution += (data ?? []).length
      }
    }
  }

  console.log(`\n=== ${label} ===`)
  console.log(`  candidate_identities (total):              ${totalCandidates}`)
  console.log(`  candidate_identities resolved:             ${candidatesResolved}`)
  console.log(`  candidate_identities unresolved:           ${candidatesUnresolved}`)
  console.log(`  tangential_signals (total):                ${totalSignals}`)
  console.log(`  tangential_signals attached (distinct):    ${signalsAttached}`)
  console.log(`  attribution_events (live rows):            ${attributionEvents}`)
  console.log(`  booked weddings (status booked/completed): ${bookedWeddings}`)
  console.log(`  booked weddings with attribution coverage: ${bookedWithAttribution}`)

  return {
    totalCandidates,
    candidatesResolved,
    candidatesUnresolved,
    totalSignals,
    signalsAttached,
    attributionEvents,
    bookedWeddings,
    bookedWithAttribution,
  }
}

async function main() {
  console.log('=== T5-Rixey-LLL B9 — Rixey backtrack all-time ===')
  console.log(`Rixey venue: ${RIXEY}`)

  const before = await snapshot('PRE-LLL')

  console.log('\n[1] running runBacktrackForVenue(skipReattemptWindow:true)...')
  const t0 = Date.now()
  const summary = await runBacktrackForVenue(sb as any, RIXEY, { skipReattemptWindow: true })
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`  elapsed:               ${dt}s`)
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

  const after = await snapshot('POST-LLL')

  console.log('\n=== DIFF SUMMARY ===')
  const fmt = (b: number, a: number) => `${b} → ${a} (Δ ${a - b >= 0 ? '+' : ''}${a - b})`
  console.log(`  candidate_identities resolved:             ${fmt(before.candidatesResolved, after.candidatesResolved)}`)
  console.log(`  candidate_identities unresolved:           ${fmt(before.candidatesUnresolved, after.candidatesUnresolved)}`)
  console.log(`  tangential_signals attached (distinct):    ${fmt(before.signalsAttached, after.signalsAttached)}`)
  console.log(`  attribution_events (live rows):            ${fmt(before.attributionEvents, after.attributionEvents)}`)
  console.log(`  booked weddings with attribution coverage: ${fmt(before.bookedWithAttribution, after.bookedWithAttribution)} (of ${after.bookedWeddings} booked total)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
