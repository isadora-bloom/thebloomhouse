/**
 * Phase 2 step D.6 — re-import the Knot visitor-activity CSVs through the real
 * adapter (knot_visitor_activity is on the wipe list, so the history has to be
 * replayed). Idempotent on row_fingerprint, so re-running is safe. Runs the
 * matcher sweep afterwards, same as the UI commit.
 *
 * Usage: npx tsx scripts/phase2-run-knot-visitor-import.ts [--apply --allow-prod]
 * Dry-run by default (parses + reports counts, writes nothing).
 */
import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { parseSafetyFlags, assertNotProd, requireApply } from './_safety.mjs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const DOWNLOADS = 'C:/Users/Ismar/Downloads'
// Oldest first. Overlapping exports are fine: fingerprint dedup skips repeats.
const CSV_FILES = [
  `${DOWNLOADS}/RixeyManor-visitor-activities.csv`,
  `${DOWNLOADS}/RixeyManor-visitor-activities (1).csv`,
  `${DOWNLOADS}/RixeyManor-visitor-activities (2).csv`,
]

async function main() {
  const { apply, allowProd } = parseSafetyFlags(process.argv)
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  assertNotProd(url, { allowProd })
  const supabase = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const { knotVisitorActivityAdapter } = await import('../src/lib/services/crm-import/knot-visitor-activity-adapter')

  let inserted = 0
  for (const file of CSV_FILES) {
    if (!existsSync(file)) { console.log(`SKIP (not found): ${file}`); continue }
    const csvText = readFileSync(file, 'utf8')
    const parsed = await knotVisitorActivityAdapter.parse({ csvText, venueId: VENUE_ID } as never) as
      Awaited<ReturnType<typeof knotVisitorActivityAdapter.parse>> & { knotVisitorRows?: unknown[] }
    const rows = parsed.knotVisitorRows ?? []
    console.log(`\n=== ${file.split('/').pop()} === parsed ${rows.length} rows, ${parsed.errors.length} errors, ${parsed.warnings.length} warnings`)
    for (const e of parsed.errors.slice(0, 5)) console.log('  ERR', e)
    if (!requireApply(apply, 'phase2-run-knot-visitor-import')) continue
    const res = await knotVisitorActivityAdapter.commit({
      supabase, venueId: VENUE_ID, rows: [], knotVisitorRows: rows,
    } as never)
    console.log(`  inserted ${res.interactionsInserted} · ok=${res.ok} · ${res.errors.length} notes`)
    for (const e of res.errors.slice(0, 8)) console.log('  ', e)
    inserted += res.interactionsInserted ?? 0
  }
  console.log(`\nTotal knot_visitor_activity rows inserted: ${inserted}`)
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1) })
