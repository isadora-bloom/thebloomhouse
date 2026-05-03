// Phase 2: marketing_spend load. Generates ~150 monthly rows from the
// task brief's spend table. Idempotent: ON CONFLICT (venue_id, source, month)
// DO UPDATE.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Helper to enumerate first-of-month dates between two YYYY-MM endpoints (inclusive).
function months(fromYm, toYm) {
  const out = []
  const [fy, fm] = fromYm.split('-').map(Number)
  const [ty, tm] = toYm.split('-').map(Number)
  let y = fy, m = fm
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

// Marketing spend rows per the brief's table.
// Format: { source, month, amount, confidence_flag, notes }
const rows = []

// --- The Knot ---
for (const m of months('2024-05', '2024-09')) rows.push({ source: 'the_knot', month: m, amount: 1237.85, confidence_flag: 'imported_high', notes: 'WeddingPro half of $2,475.70 combined bill' })
for (const m of months('2024-10', '2026-04')) rows.push({ source: 'the_knot', month: m, amount: 1261.05, confidence_flag: 'imported_high', notes: 'Post-Oct hike' })
rows.push({ source: 'the_knot', month: '2026-05-01', amount: 122.04, confidence_flag: 'imported_high', notes: 'Partial through May 3 (3/31 days × $1,261.05)' })

// --- WeddingWire ---
for (const m of months('2024-05', '2024-09')) rows.push({ source: 'wedding_wire', month: m, amount: 1237.85, confidence_flag: 'imported_high', notes: 'WeddingPro half of $2,475.70 combined bill' })
for (const m of months('2024-10', '2024-12')) rows.push({ source: 'wedding_wire', month: m, amount: 1261.05, confidence_flag: 'imported_high', notes: 'Post-Oct hike' })
rows.push({ source: 'wedding_wire', month: '2025-01-01', amount: 0, confidence_flag: 'imported_high', notes: 'Cancellation refund (invoice + credit memo net out)' })
// 2025-02 onward dropped — per brief leave a marker row at $0 for Feb 2025 (start of dropped state)
rows.push({ source: 'wedding_wire', month: '2025-02-01', amount: 0, confidence_flag: 'imported_high', notes: 'DROPPED (end-of-life marker)' })

// --- Google Ads ---
rows.push({ source: 'google', month: '2024-03-01', amount: 304, confidence_flag: 'imported_high', notes: 'Google Ads (Mar 2024)' })
rows.push({ source: 'google', month: '2024-04-01', amount: 304, confidence_flag: 'imported_high', notes: 'Google Ads (Apr 2024)' })
rows.push({ source: 'google', month: '2024-05-01', amount: 109, confidence_flag: 'imported_high', notes: 'Google Ads (May 2024)' })
for (const m of months('2024-06', '2024-12')) rows.push({ source: 'google', month: m, amount: 300, confidence_flag: 'imported_low', notes: 'Imputed (between known data points)' })
for (const m of months('2025-01', '2025-02')) rows.push({ source: 'google', month: m, amount: 300, confidence_flag: 'imported_low', notes: 'Imputed' })
rows.push({ source: 'google', month: '2025-03-01', amount: 912, confidence_flag: 'imported_high', notes: 'Google Ads (Mar 2025)' })
rows.push({ source: 'google', month: '2025-04-01', amount: 913, confidence_flag: 'imported_high', notes: 'Google Ads (Apr 2025)' })
rows.push({ source: 'google', month: '2025-05-01', amount: 908, confidence_flag: 'imported_high', notes: 'Google Ads (May 2025)' })
for (const m of months('2025-06', '2025-10')) rows.push({ source: 'google', month: m, amount: 910, confidence_flag: 'imported_low', notes: 'Imputed' })
rows.push({ source: 'google', month: '2025-11-01', amount: 913, confidence_flag: 'imported_high', notes: 'Google Ads (Nov 2025)' })
rows.push({ source: 'google', month: '2025-12-01', amount: 899, confidence_flag: 'imported_high', notes: 'Google Ads (Dec 2025)' })
rows.push({ source: 'google', month: '2026-01-01', amount: 1004, confidence_flag: 'imported_high', notes: 'Google Ads (Jan 2026)' })
rows.push({ source: 'google', month: '2026-02-01', amount: 1400, confidence_flag: 'imported_low', notes: 'Imputed (between Jan $1,004 and Mar $1,791)' })
rows.push({ source: 'google', month: '2026-03-01', amount: 1791, confidence_flag: 'imported_high', notes: 'Google Ads (Mar 2026)' })
rows.push({ source: 'google', month: '2026-04-01', amount: 1817, confidence_flag: 'imported_high', notes: 'Google Ads (Apr 2026)' })
rows.push({ source: 'google', month: '2026-05-01', amount: 67, confidence_flag: 'imported_high', notes: 'Google Ads partial (3 days through May 3)' })

// --- Reddit ---
for (const m of months('2026-02', '2026-04')) rows.push({ source: 'reddit', month: m, amount: 100, confidence_flag: 'imported_medium', notes: 'Verbal report' })

// --- Here Comes The Guide ---
for (const m of months('2024-05', '2026-04')) rows.push({ source: 'here_comes_the_guide', month: m, amount: 125, confidence_flag: 'imported_low', notes: 'Start date unknown, defaulted to May 2024' })

console.log(`Generated ${rows.length} marketing_spend rows.`)
console.log()

// Existing marketing_spend table doesn't have a unique constraint on
// (venue_id, source, month) by default. Use upsert via select-then-insert
// instead, since onConflict needs an actual unique constraint.
// Strategy: pull all existing rows for (venue_id), key them, and decide
// per row whether to update or insert.

const { data: existing, error: exErr } = await sb
  .from('marketing_spend')
  .select('id, source, month')
  .eq('venue_id', RIXEY_ID)
if (exErr) {
  console.error('existing query failed:', exErr)
  process.exit(1)
}
const existingMap = new Map((existing ?? []).map((r) => [`${r.source}|${r.month}`, r.id]))

let inserted = 0, updated = 0, errors = 0
for (const row of rows) {
  const key = `${row.source}|${row.month}`
  const payload = {
    venue_id: RIXEY_ID,
    source: row.source,
    month: row.month,
    amount: row.amount,
    notes: row.notes,
    confidence_flag: row.confidence_flag,
    source_provenance: 'csv_import', // closest match in 146 enum
  }
  if (existingMap.has(key)) {
    const id = existingMap.get(key)
    const { error } = await sb.from('marketing_spend').update(payload).eq('id', id)
    if (error) { errors++; console.error(`upd ${key}: ${error.message}`) } else updated++
  } else {
    const { error } = await sb.from('marketing_spend').insert(payload)
    if (error) { errors++; console.error(`ins ${key}: ${error.message}`) } else inserted++
  }
}

console.log(`inserted=${inserted} updated=${updated} errors=${errors}`)

// Verify
const { count } = await sb.from('marketing_spend').select('id', { count: 'exact', head: true }).eq('venue_id', RIXEY_ID)
console.log(`marketing_spend total for Rixey now: ${count}`)
