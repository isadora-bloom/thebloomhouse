// Wave 18 verification script.
//
// 1) Counts existing prediction_snapshots / outcomes
// 2) Backfills snapshots from couple_intel rows for Rixey (since the
//    real Wave 5A snapshots come from new derives going forward — we
//    simulate the historical predictions so analyze.ts has data)
// 3) Runs measureOutcomes for Rixey
// 4) Counts terminal-state weddings to verify match
// 5) Prints Brier headline
//
// Usage:
//   node scripts/test-wave18.mjs

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

// Resolve Rixey venue id
const { data: rixey } = await sb
  .from('venues')
  .select('id, name')
  .ilike('name', '%rixey%')
  .limit(1)
  .maybeSingle()

if (!rixey) {
  console.error('Rixey venue not found in database')
  process.exit(1)
}
const venueId = rixey.id
console.log('Rixey venue:', venueId, rixey.name)

// 1) Baseline counts
const { count: snapCount } = await sb
  .from('prediction_snapshots')
  .select('id', { count: 'exact', head: true })
  .eq('venue_id', venueId)
const { count: outcomeCount } = await sb
  .from('prediction_outcomes')
  .select('id', { count: 'exact', head: true })
  .eq('venue_id', venueId)
console.log('\nBefore backfill:')
console.log('  snapshots:', snapCount ?? 0)
console.log('  outcomes:', outcomeCount ?? 0)

// 2) Backfill: For every couple_intel row at Rixey, insert a synthetic
// prediction_snapshot if we don't already have one for that wedding.
// This is one-time bootstrap data so analyze.ts has something to chew on.
const { data: intel } = await sb
  .from('couple_intel')
  .select(
    'wedding_id, venue_id, predicted_close_probability_pct, persona_label, last_derived_at, prompt_version, cost_cents',
  )
  .eq('venue_id', venueId)
  .not('predicted_close_probability_pct', 'is', null)
  .limit(2000)
console.log('\nFound', intel?.length ?? 0, 'couple_intel rows with predictions at Rixey.')

// Skip backfill for weddings already snapshotted
const intelWeddingIds = (intel ?? []).map((r) => r.wedding_id)
const { data: existingSnaps } = await sb
  .from('prediction_snapshots')
  .select('wedding_id')
  .in('wedding_id', intelWeddingIds.length > 0 ? intelWeddingIds : ['00000000-0000-0000-0000-000000000000'])
  .eq('prediction_kind', 'close_probability_pct')
const existingSet = new Set((existingSnaps ?? []).map((r) => r.wedding_id))

const inserts = []
for (const row of intel ?? []) {
  if (existingSet.has(row.wedding_id)) continue
  inserts.push({
    wedding_id: row.wedding_id,
    venue_id: row.venue_id,
    prediction_kind: 'close_probability_pct',
    predicted_value: { pct_0_100: row.predicted_close_probability_pct },
    prediction_source: 'wave_5a_couple_intel_backfill',
    prompt_version: row.prompt_version,
    cost_cents: row.cost_cents,
    snapshotted_at: row.last_derived_at,
  })
}

if (inserts.length > 0) {
  // Insert in batches of 200
  let inserted = 0
  for (let i = 0; i < inserts.length; i += 200) {
    const batch = inserts.slice(i, i + 200)
    const { error: ie } = await sb.from('prediction_snapshots').insert(batch)
    if (ie) {
      console.error('insert error at offset', i, ':', ie.message)
      break
    }
    inserted += batch.length
  }
  console.log('Backfilled', inserted, 'new snapshots.')
} else {
  console.log('No new snapshots to backfill (already up-to-date).')
}

// 3) Run measureOutcomes via the service
// Import the compiled TS via tsx require since this is .mjs we'll
// invoke the same logic via the API route instead.
const { measureOutcomes } = await import('../src/lib/services/calibration/measure-outcomes.ts').catch(
  () => null,
) || { measureOutcomes: null }

let measureResult
if (measureOutcomes) {
  measureResult = await measureOutcomes({ venueId, limit: 2000 })
} else {
  // tsx not available — fall back to inline SQL replicating the logic
  console.log('(running measure-outcomes inline since tsx import failed)')
  // Load candidate snapshots without outcomes
  const { data: snaps } = await sb
    .from('prediction_snapshots')
    .select('id, wedding_id, venue_id, prediction_kind, predicted_value, snapshotted_at')
    .eq('venue_id', venueId)
    .eq('prediction_kind', 'close_probability_pct')
    .limit(2000)
  const snapIds = (snaps ?? []).map((s) => s.id)
  const { data: existingOutcomes } = await sb
    .from('prediction_outcomes')
    .select('prediction_snapshot_id')
    .in('prediction_snapshot_id', snapIds.length > 0 ? snapIds : ['00000000-0000-0000-0000-000000000000'])
  const measured = new Set((existingOutcomes ?? []).map((o) => o.prediction_snapshot_id))

  const candidates = (snaps ?? []).filter((s) => !measured.has(s.id))
  const weddingIds = [...new Set(candidates.map((s) => s.wedding_id))]
  const { data: weddings } = await sb
    .from('weddings')
    .select('id, lifecycle_stage, lifecycle_stage_set_at, booked_at, status')
    .in('id', weddingIds.length > 0 ? weddingIds : ['00000000-0000-0000-0000-000000000000'])
  const wmap = new Map((weddings ?? []).map((w) => [w.id, w]))

  const TERMINAL = new Set(['booked', 'planning_active', 'day_of', 'post_event', 'long_tail', 'lost', 'cancelled'])
  const BOOKED = new Set(['booked', 'planning_active', 'day_of', 'post_event', 'long_tail'])
  const NOT_BOOKED = new Set(['lost', 'cancelled'])

  const outcomeInserts = []
  let skipped = 0
  for (const s of candidates) {
    const w = wmap.get(s.wedding_id)
    if (!w || !w.lifecycle_stage || !TERMINAL.has(w.lifecycle_stage)) { skipped++; continue }
    const predicted = Number(s.predicted_value?.pct_0_100)
    if (!Number.isFinite(predicted)) { skipped++; continue }
    const booked = BOOKED.has(w.lifecycle_stage)
    const notBooked = NOT_BOOKED.has(w.lifecycle_stage)
    if (!booked && !notBooked) { skipped++; continue }
    const matched = (predicted >= 50 && booked) || (predicted < 50 && notBooked)
    const errorMag = Math.abs(predicted - (booked ? 100 : 0))
    outcomeInserts.push({
      prediction_snapshot_id: s.id,
      wedding_id: s.wedding_id,
      venue_id: s.venue_id,
      actual_outcome: {
        booked,
        lifecycle_stage: w.lifecycle_stage,
        days_to_terminal: null,
      },
      matched_prediction: matched,
      error_magnitude: Number(errorMag.toFixed(2)),
      measured_at: new Date().toISOString(),
    })
  }

  let measuredCount = 0
  if (outcomeInserts.length > 0) {
    for (let i = 0; i < outcomeInserts.length; i += 200) {
      const batch = outcomeInserts.slice(i, i + 200)
      const { error: oe } = await sb.from('prediction_outcomes').insert(batch)
      if (oe) {
        console.error('outcome insert error:', oe.message)
        break
      }
      measuredCount += batch.length
    }
  }
  measureResult = { measured: outcomeInserts, skipped }
  console.log('Inline measureOutcomes:', { measured: measuredCount, skipped, candidates: candidates.length })
}

console.log('\nAfter measure:')
const { count: snapCount2 } = await sb
  .from('prediction_snapshots')
  .select('id', { count: 'exact', head: true })
  .eq('venue_id', venueId)
const { count: outcomeCount2 } = await sb
  .from('prediction_outcomes')
  .select('id', { count: 'exact', head: true })
  .eq('venue_id', venueId)
console.log('  snapshots:', snapCount2 ?? 0)
console.log('  outcomes:', outcomeCount2 ?? 0)

// 4) Count terminal-state weddings at Rixey
const TERMINAL_STAGES = ['booked', 'planning_active', 'day_of', 'post_event', 'long_tail', 'lost', 'cancelled']
const { count: terminalCount } = await sb
  .from('weddings')
  .select('id', { count: 'exact', head: true })
  .eq('venue_id', venueId)
  .in('lifecycle_stage', TERMINAL_STAGES)
  .is('merged_into_id', null)
console.log('  terminal-state weddings:', terminalCount ?? 0)

// 5) Compute headline Brier inline (mirrors analyze.ts)
const { data: outRows } = await sb
  .from('prediction_outcomes')
  .select('matched_prediction, error_magnitude, actual_outcome, prediction_snapshot_id, measured_at')
  .eq('venue_id', venueId)
  .order('measured_at', { ascending: false })
  .limit(5000)

if (!outRows || outRows.length === 0) {
  console.log('\nNo measured outcomes yet. Cannot compute Brier.')
} else {
  // Need predicted_value from snapshots
  const snapIds2 = outRows.map((r) => r.prediction_snapshot_id).filter(Boolean)
  const { data: snaps2 } = await sb
    .from('prediction_snapshots')
    .select('id, predicted_value')
    .in('id', snapIds2)
  const smap = new Map((snaps2 ?? []).map((s) => [s.id, s]))

  let sumSq = 0
  let n = 0
  let correct = 0
  for (const r of outRows) {
    const snap = smap.get(r.prediction_snapshot_id)
    if (!snap) continue
    const predicted = Number(snap.predicted_value?.pct_0_100) / 100
    if (!Number.isFinite(predicted)) continue
    const actual = r.actual_outcome?.booked ? 1 : 0
    sumSq += (predicted - actual) ** 2
    n++
    if (r.matched_prediction) correct++
  }
  const brier = n > 0 ? sumSq / n : null
  console.log('\n=== Rixey calibration headline ===')
  console.log('  n measured:', n)
  console.log('  Brier score:', brier !== null ? brier.toFixed(4) : 'NA', '(0 = perfect, 0.25 = coin-flip)')
  console.log('  Accuracy:', n > 0 ? ((correct / n) * 100).toFixed(1) + '%' : 'NA')

  // Quick reliability check — bucket by predicted decile
  const buckets = Array.from({ length: 10 }, () => ({ count: 0, booked: 0, sumPred: 0 }))
  for (const r of outRows) {
    const snap = smap.get(r.prediction_snapshot_id)
    if (!snap) continue
    const predicted = Number(snap.predicted_value?.pct_0_100)
    if (!Number.isFinite(predicted)) continue
    const bin = Math.min(9, Math.floor(predicted / 10))
    buckets[bin].count++
    buckets[bin].sumPred += predicted
    if (r.actual_outcome?.booked) buckets[bin].booked++
  }
  console.log('\n  Reliability diagram:')
  for (let i = 0; i < 10; i++) {
    const b = buckets[i]
    if (b.count === 0) continue
    const avgPred = b.sumPred / b.count
    const actualRate = (b.booked / b.count) * 100
    console.log(
      `    ${(i * 10).toString().padStart(2)}-${((i + 1) * 10).toString().padStart(3)}%: n=${String(b.count).padStart(3)}, avg predicted=${avgPred.toFixed(1)}%, actual booked rate=${actualRate.toFixed(1)}%`,
    )
  }
}

console.log('\nDONE')
