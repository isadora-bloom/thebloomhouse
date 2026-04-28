// Phase A self-review on the real Rixey Knot CSV.
//
// Verifies, end-to-end:
//   1. detectPlatformSource picks the_knot at high confidence
//   2. parseVendorDate handles every date in the file (no silent nulls)
//   3. importPlatformSignals lands rows in tangential_signals with full
//      identity capture (name parsed into first_name + last_initial,
//      raw_row preserved, source_platform/action_class set)
//   4. Dedup: re-running the import doesn't duplicate
//   5. Cleanup: deletes the test rows so the script is idempotent
//
// Read-only inspection mode by default. Pass --apply to actually
// insert rows; otherwise the script just reports what would happen.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { detectPlatformSource } from '../src/lib/services/platform-detectors'
import { importPlatformSignals } from '../src/lib/services/platform-signals-import'
import { parseVendorDate } from '../src/lib/services/parse-vendor-date'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const APPLY = process.argv.includes('--apply')
const CSV_PATH = process.argv.find((a) => a.endsWith('.csv'))
  ?? 'C:\\Users\\Ismar\\Downloads\\RixeyManor-visitor-activities (1).csv'

function parseCsvLine(line: string): string[] {
  // Light CSV parser — handles quoted fields with commas inside.
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++ } else { inQuote = !inQuote }
    } else if (ch === ',' && !inQuote) {
      out.push(cur); cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map((s) => s.trim().replace(/^"|"$/g, ''))
}

async function main() {
  console.log(`\n=== Phase A self-review (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`)
  console.log(`CSV: ${CSV_PATH}\n`)

  const text = readFileSync(CSV_PATH, 'utf8')
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  const headers = parseCsvLine(lines[0])
  const rows = lines.slice(1).map(parseCsvLine)
  console.log(`Headers: ${headers.join(' | ')}`)
  console.log(`Data rows: ${rows.length}\n`)

  // CHECK 1: platform detection
  console.log('[1] platform detection')
  const detection = detectPlatformSource(headers, rows.slice(0, 30))
  if (detection.best) {
    console.log(`  ✓ best: ${detection.best.detector.key} @ ${detection.best.confidence}%`)
    for (const e of detection.best.evidence) console.log(`    - ${e}`)
  } else {
    console.log(`  ❌ no detector matched`)
    return
  }
  if (detection.alternatives.length > 0) {
    console.log(`  alternatives:`)
    for (const a of detection.alternatives) console.log(`    - ${a.detector.key} @ ${a.confidence}%`)
  }

  // CHECK 2: date parse coverage
  console.log('\n[2] date parse coverage across all rows')
  const dateColIdx = headers.findIndex((h) => /date/i.test(h))
  if (dateColIdx < 0) console.log('  no date column found')
  else {
    let parsed = 0
    let unparseable = 0
    const failed: string[] = []
    const formats = new Map<string, number>()
    for (const r of rows) {
      const raw = r[dateColIdx] ?? ''
      const result = parseVendorDate(raw)
      if (result) {
        parsed++
        formats.set(result.format, (formats.get(result.format) ?? 0) + 1)
      } else {
        unparseable++
        if (failed.length < 5) failed.push(raw)
      }
    }
    console.log(`  parsed:      ${parsed}/${rows.length} (${((parsed / rows.length) * 100).toFixed(1)}%)`)
    console.log(`  unparseable: ${unparseable}`)
    for (const [fmt, n] of formats) console.log(`    via ${fmt}: ${n}`)
    if (failed.length > 0) console.log(`  sample failures: ${failed.join(' / ')}`)
  }

  // CHECK 3: row mapping spot-check
  console.log('\n[3] row mapping spot-check (5 samples)')
  const det = detection.best.detector
  for (const r of rows.slice(0, 5)) {
    const m = det.mapRow(headers, r)
    console.log(`  ${m.name_raw?.padEnd(20) ?? '(empty)'.padEnd(20)} | first=${m.first_name ?? '—'} init=${m.last_initial ?? '—'} | action=${m.action_class.padEnd(8)} | date=${m.signal_date ?? '—'} | city=${m.city ?? '—'}`)
  }

  // CHECK 4: action breakdown
  console.log('\n[4] action_class distribution')
  const actionCounts = new Map<string, number>()
  for (const r of rows) {
    const m = det.mapRow(headers, r)
    actionCounts.set(m.action_class, (actionCounts.get(m.action_class) ?? 0) + 1)
  }
  for (const [a, n] of [...actionCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${a.padEnd(15)} ${n}`)
  }

  // CHECK 5: import (apply mode only)
  if (APPLY) {
    console.log('\n[5] importing into tangential_signals…')
    const result = await importPlatformSignals({
      supabase: sb,
      venueId: RIXEY,
      detector: det,
      headers,
      rows,
    })
    console.log(`  inserted:                ${result.inserted}`)
    console.log(`  skipped (duplicate):     ${result.skipped_duplicate}`)
    console.log(`  skipped (empty name):    ${result.skipped_empty_name}`)
    console.log(`  skipped (bad date):      ${result.skipped_unparseable_date}`)
    console.log(`  errors:                  ${result.errors.length}`)
    if (result.errors.length > 0) {
      for (const e of result.errors.slice(0, 5)) console.log(`    - ${e}`)
    }
    console.log(`  date parse rate:         ${result.date_parse_rate.parsed}/${result.date_parse_rate.parsed + result.date_parse_rate.unparseable}`)
    console.log(`  by action_class:`)
    for (const [a, n] of Object.entries(result.by_action)) console.log(`    ${a.padEnd(15)} ${n}`)

    // CHECK 6: idempotency
    console.log('\n[6] re-running to confirm dedup')
    const second = await importPlatformSignals({
      supabase: sb,
      venueId: RIXEY,
      detector: det,
      headers,
      rows,
    })
    console.log(`  second-pass inserted: ${second.inserted} (expect 0)`)
    console.log(`  second-pass duplicate-skipped: ${second.skipped_duplicate}`)

    // Cleanup
    console.log('\n[cleanup] removing test rows')
    const { error: delErr } = await sb
      .from('tangential_signals')
      .delete()
      .eq('venue_id', RIXEY)
      .eq('source_platform', det.key)
    if (delErr) console.log(`  cleanup error: ${delErr.message}`)
  } else {
    console.log('\n[5] import skipped — pass --apply to actually insert')
  }

  console.log('\n=== done ===')
}

main().catch((err) => { console.error(err); process.exit(1) })
