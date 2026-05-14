#!/usr/bin/env node
/**
 * Verify the Pattern A dedup (mig 336) worked.
 *
 * Reports per-venue:
 *   - Live attribution_events count
 *   - Tombstoned attribution_events count (the dedup target)
 *   - Reverted attribution_events count
 *   - Touchpoints tombstoned by mig 336
 *   - Weddings with narrative_cache_busted_at set
 *
 * Then shows the top-N most-deduplicated weddings so you can verify
 * Zachary Gragan + Eleanor Pittinger + Anthony Fontana + Bonnie Alger
 * all got cleaned up.
 *
 * Pass --venue <uuid> to scope to one venue. Pass --apply-residual
 * to re-run the dedup logic for any duplicates that snuck through
 * (e.g. landed between migration apply and writer-conversion deploy).
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  env[m[1]] = v
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const args = process.argv.slice(2)
const venueArgIdx = args.indexOf('--venue')
const scopedVenue = venueArgIdx >= 0 ? args[venueArgIdx + 1] : null
const applyResidual = args.includes('--apply-residual')

const { data: venues } = await sb.from('venues').select('id, name')
const targets = scopedVenue ? (venues ?? []).filter((v) => v.id === scopedVenue) : (venues ?? [])

console.log(`\n=== Pattern A dedup verification (mig 336) ===\n`)
console.log(`Venues to inspect: ${targets.length}`)

for (const v of targets) {
  console.log(`\n--- ${v.name} (${v.id}) ---`)

  const [live, tomb, rev, tpTomb, busted] = await Promise.all([
    sb
      .from('attribution_events')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', v.id)
      .is('reverted_at', null)
      .is('tombstoned_at', null),
    sb
      .from('attribution_events')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', v.id)
      .not('tombstoned_at', 'is', null),
    sb
      .from('attribution_events')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', v.id)
      .not('reverted_at', 'is', null),
    sb
      .from('wedding_touchpoints')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', v.id)
      .filter('metadata->>tombstoned_at_336', 'not.is', null),
    sb
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', v.id)
      .not('narrative_cache_busted_at', 'is', null),
  ])

  console.log(`  live attribution_events       : ${live.count ?? 0}`)
  console.log(`  tombstoned by mig 336         : ${tomb.count ?? 0}`)
  console.log(`  reverted (operator unwind)    : ${rev.count ?? 0}`)
  console.log(`  touchpoints tombstoned 336    : ${tpTomb.count ?? 0}`)
  console.log(`  weddings w/ stale narrative   : ${busted.count ?? 0}`)

  // Top weddings by tombstoned count — the audit named Zachary Gragan
  // (9 dupes), Eleanor Pittinger, Anthony Fontana, Bonnie Alger.
  const { data: topTomb } = await sb
    .from('attribution_events')
    .select('wedding_id, weddings(partner1_name, partner2_name)')
    .eq('venue_id', v.id)
    .not('tombstoned_at', 'is', null)
    .limit(1000)
  const byWedding = new Map()
  for (const r of topTomb ?? []) {
    const wid = r.wedding_id
    const cur = byWedding.get(wid) ?? { count: 0, name: '' }
    cur.count += 1
    if (!cur.name && r.weddings) {
      const w = Array.isArray(r.weddings) ? r.weddings[0] : r.weddings
      cur.name = `${w?.partner1_name ?? '?'} & ${w?.partner2_name ?? '?'}`
    }
    byWedding.set(wid, cur)
  }
  const sorted = [...byWedding.entries()].sort((a, b) => b[1].count - a[1].count)
  if (sorted.length > 0) {
    console.log(`  top deduped weddings:`)
    for (const [wid, info] of sorted.slice(0, 10)) {
      console.log(`    ${info.count.toString().padStart(3)} dupes — ${info.name.padEnd(40)} (${wid.slice(0, 8)})`)
    }
  }

  // Residual check — any live duplicates remain? With the partial
  // unique index in place, Postgres makes this impossible for new
  // writes. We re-check anyway to catch any window between mig
  // apply and writer-conversion deploy. Iterate a sample.
  const { data: liveSample } = await sb
    .from('attribution_events')
    .select('candidate_identity_id, wedding_id, signal_id')
    .eq('venue_id', v.id)
    .is('reverted_at', null)
    .is('tombstoned_at', null)
    .not('signal_id', 'is', null)
    .limit(5000)
  const fpCounts = new Map()
  for (const r of liveSample ?? []) {
    const fp = `${r.candidate_identity_id}::${r.wedding_id}::${r.signal_id}`
    fpCounts.set(fp, (fpCounts.get(fp) ?? 0) + 1)
  }
  const residual = [...fpCounts.values()].filter((c) => c > 1).length
  if (residual > 0) {
    console.log(`  ⚠ ${residual} live duplicate groups in 5000-row sample`)
    if (applyResidual) {
      console.log(`  (--apply-residual: re-run mig 336 step 4 SQL via Supabase SQL editor)`)
    }
  }
}

console.log('\nDone.')
