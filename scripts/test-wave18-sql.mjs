// Wave 18 verification using direct SQL (bypasses PostgREST schema cache).
//
// Usage:
//   node scripts/test-wave18-sql.mjs

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

// Use exec_sql for everything — bypasses schema cache.
async function sql(stmt) {
  const { error } = await sb.rpc('exec_sql', { sql: stmt })
  if (error) throw new Error(stmt.slice(0, 60) + '... -> ' + error.message)
}

// We need a way to read results back. Use a fallback: create a temp
// view-like approach via a function. Actually exec_sql is fire-and-
// forget. Workaround: drop into raw pg via supabase-js postgrest
// won't see it. Use a different approach — direct connection string
// from env if present.
//
// Simpler: write our SQL operations + count via existing PostgREST
// where it works. Tables we already have access to: weddings,
// couple_intel.

const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// 1) Read couple_intel rows
const { data: intel, error: iErr } = await sb
  .from('couple_intel')
  .select(
    'wedding_id, venue_id, predicted_close_probability_pct, persona_label, last_derived_at, prompt_version, cost_cents',
  )
  .eq('venue_id', RIXEY_ID)
  .not('predicted_close_probability_pct', 'is', null)
  .limit(2000)

if (iErr) {
  console.error('intel fetch failed:', iErr.message)
  process.exit(1)
}

console.log('Found', intel.length, 'couple_intel rows for Rixey.')

// 2) Backfill prediction_snapshots via SQL
console.log('\nBackfilling snapshots via SQL...')
let snapshotsInserted = 0
for (const row of intel) {
  const stmt = `
    INSERT INTO prediction_snapshots (
      wedding_id, venue_id, prediction_kind, predicted_value,
      prediction_source, prompt_version, cost_cents, snapshotted_at
    )
    SELECT
      '${row.wedding_id}'::uuid,
      '${row.venue_id}'::uuid,
      'close_probability_pct',
      jsonb_build_object('pct_0_100', ${row.predicted_close_probability_pct}::int),
      'wave_5a_couple_intel_backfill',
      ${row.prompt_version ? `'${row.prompt_version.replace(/'/g, "''")}'` : 'NULL'},
      ${row.cost_cents ?? 'NULL'},
      ${row.last_derived_at ? `'${row.last_derived_at}'::timestamptz` : 'now()'}
    WHERE NOT EXISTS (
      SELECT 1 FROM prediction_snapshots
      WHERE wedding_id = '${row.wedding_id}'::uuid
        AND prediction_kind = 'close_probability_pct'
    );
  `
  try {
    await sql(stmt)
    snapshotsInserted++
  } catch (err) {
    console.error('  insert failed for', row.wedding_id, ':', err.message)
  }
}
console.log('  inserted up to', snapshotsInserted, 'snapshots (NOT EXISTS skips dups)')

// 3) Now measure outcomes via SQL
console.log('\nMeasuring outcomes via SQL...')
const measureStmt = `
  INSERT INTO prediction_outcomes (
    prediction_snapshot_id, wedding_id, venue_id,
    actual_outcome, matched_prediction, error_magnitude, measured_at
  )
  SELECT
    s.id,
    s.wedding_id,
    s.venue_id,
    jsonb_build_object(
      'booked', w.lifecycle_stage IN ('booked','planning_active','day_of','post_event','long_tail'),
      'lifecycle_stage', w.lifecycle_stage,
      'days_to_terminal', CASE
        WHEN w.lifecycle_stage_set_at IS NOT NULL THEN
          GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (w.lifecycle_stage_set_at - s.snapshotted_at)) / 86400))::int
        ELSE NULL
      END
    ),
    CASE
      WHEN (s.predicted_value->>'pct_0_100')::numeric >= 50
        AND w.lifecycle_stage IN ('booked','planning_active','day_of','post_event','long_tail') THEN true
      WHEN (s.predicted_value->>'pct_0_100')::numeric < 50
        AND w.lifecycle_stage IN ('lost','cancelled') THEN true
      ELSE false
    END,
    ROUND(ABS(
      (s.predicted_value->>'pct_0_100')::numeric
      - CASE WHEN w.lifecycle_stage IN ('booked','planning_active','day_of','post_event','long_tail') THEN 100 ELSE 0 END
    )::numeric, 2),
    now()
  FROM prediction_snapshots s
  JOIN weddings w ON w.id = s.wedding_id
  WHERE s.venue_id = '${RIXEY_ID}'::uuid
    AND s.prediction_kind = 'close_probability_pct'
    AND w.lifecycle_stage IN ('booked','planning_active','day_of','post_event','long_tail','lost','cancelled')
    AND NOT EXISTS (
      SELECT 1 FROM prediction_outcomes po WHERE po.prediction_snapshot_id = s.id
    );
`
await sql(measureStmt)
console.log('  measure SQL executed')

// 4) Trigger schema reload one more time + wait
await sql("NOTIFY pgrst, 'reload schema';")
console.log('  notified pgrst to reload schema')

// 5) Try reading via REST — may still fail if cache not propagated.
await new Promise((r) => setTimeout(r, 8000))
const { count: snapCount } = await sb
  .from('prediction_snapshots')
  .select('id', { count: 'exact', head: true })
  .eq('venue_id', RIXEY_ID)

const { count: outcomeCount } = await sb
  .from('prediction_outcomes')
  .select('id', { count: 'exact', head: true })
  .eq('venue_id', RIXEY_ID)

console.log('\nAfter operations (via REST):')
console.log('  snapshots:', snapCount ?? 'cache miss')
console.log('  outcomes:', outcomeCount ?? 'cache miss')

// 6) Compute Brier headline by SQL
// We can't read SELECT through exec_sql easily. Use a workaround: write
// to a single-row temp diagnostics row in an existing table? That's
// invasive. Use a SQL UPSERT into a deterministic key in a public log
// table OR just rely on PostgREST when the cache propagates.

// Instead, get the data via REST (likely works for SELECT since it
// did earlier for the count operations on the new tables).
const { data: outRows, error: oErr } = await sb
  .from('prediction_outcomes')
  .select('matched_prediction, error_magnitude, actual_outcome, prediction_snapshot_id, measured_at')
  .eq('venue_id', RIXEY_ID)
  .limit(5000)

if (oErr) {
  console.log('\nCannot read outcomes via REST yet:', oErr.message)
  console.log('Run again in 30s once PostgREST cache propagates.')
  process.exit(0)
}

if (!outRows || outRows.length === 0) {
  console.log('\nNo measured outcomes yet (and no errors). Possibly no terminal-state weddings with predictions.')
  process.exit(0)
}

const snapIds = outRows.map((r) => r.prediction_snapshot_id).filter(Boolean)
const { data: snaps } = await sb
  .from('prediction_snapshots')
  .select('id, predicted_value')
  .in('id', snapIds)
const smap = new Map((snaps ?? []).map((s) => [s.id, s]))

let sumSq = 0
let n = 0
let correct = 0
let above50 = { hi: 0, hi_correct: 0 }
let below50 = { lo: 0, lo_correct: 0 }
for (const r of outRows) {
  const snap = smap.get(r.prediction_snapshot_id)
  if (!snap) continue
  const predicted = Number(snap.predicted_value?.pct_0_100) / 100
  if (!Number.isFinite(predicted)) continue
  const actual = r.actual_outcome?.booked ? 1 : 0
  sumSq += (predicted - actual) ** 2
  n++
  if (r.matched_prediction) correct++
  if (predicted >= 0.5) {
    above50.hi++
    if (actual === 1) above50.hi_correct++
  } else {
    below50.lo++
    if (actual === 0) below50.lo_correct++
  }
}

const brier = n > 0 ? sumSq / n : null
console.log('\n=== Rixey calibration headline ===')
console.log('  n measured:', n)
console.log('  Brier score:', brier !== null ? brier.toFixed(4) : 'NA', '(0 = perfect, 0.25 = coin-flip)')
console.log('  Accuracy:', n > 0 ? ((correct / n) * 100).toFixed(1) + '%' : 'NA')
console.log('  Above-50 accuracy:', above50.hi > 0 ? ((above50.hi_correct / above50.hi) * 100).toFixed(1) + '%' : 'NA', `(${above50.hi_correct}/${above50.hi})`)
console.log('  Below-50 accuracy:', below50.lo > 0 ? ((below50.lo_correct / below50.lo) * 100).toFixed(1) + '%' : 'NA', `(${below50.lo_correct}/${below50.lo})`)

// Reliability bins
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

console.log('\nDONE')
