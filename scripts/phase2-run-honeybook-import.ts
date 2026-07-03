/**
 * Phase 2: Run all HoneyBook booked-client CSVs through the real import path.
 * Uses service-role client directly — no HTTP auth needed.
 * Usage: npx tsx scripts/phase2-run-honeybook-import.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

const VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const DOWNLOADS = 'C:/Users/Ismar/Downloads'

// All booked-client CSV exports — oldest-first so newer data wins on conflict
const CSV_FILES = [
  `${DOWNLOADS}/January-2022-June-2024-Booked Client-report-(HoneyBook).csv`,
  `${DOWNLOADS}/June-2023-Booked Client-report-(HoneyBook).csv`,
  `${DOWNLOADS}/May-2024-Booked Client-report-(HoneyBook).csv`,
  `${DOWNLOADS}/January-2024-Booked Client-report-(HoneyBook).csv`,
  `${DOWNLOADS}/January-2025-March-2026-Booked Client-report-(HoneyBook).csv`,
]

async function main() {
  // Import the adapter — circular dep (honeybook ↔ index) is now resolved via
  // lazy import inside commitHoneybook, so top-level import is safe here.
  const { honeybookAdapter } = await import('../src/lib/services/crm-import/honeybook.js')

  let totalInserted = 0
  let totalMatched = 0
  let totalUpgraded = 0
  let totalInteractions = 0
  let totalErrors = 0

  for (const filePath of CSV_FILES) {
    if (!existsSync(filePath)) {
      console.log(`SKIP (not found): ${filePath}`)
      continue
    }

    const csvBuffer = readFileSync(filePath)
    console.log(`\n=== ${filePath.split('/').pop()} ===`)

    // Parse via adapter — parse() takes AdapterConfig with csvText string
    const parseResult = await honeybookAdapter.parse({ csvText: csvBuffer.toString('utf8') })
    console.log(`  Parsed: ${parseResult.rows.length} couples, ${parseResult.warnings.length} warnings`)
    if (parseResult.warnings.length) {
      for (const w of parseResult.warnings.slice(0, 5)) console.log(`    WARN: ${w}`)
    }

    if (parseResult.rows.length === 0) {
      console.log('  No rows — skipping')
      continue
    }

    // Check status distribution before commit
    const statusDist: Record<string, number> = {}
    for (const row of parseResult.rows) {
      const s = row.status ?? 'null'
      statusDist[s] = (statusDist[s] ?? 0) + 1
    }
    console.log('  Row status distribution:', JSON.stringify(statusDist))

    // Commit via adapter (real write, not dry-run — preview: undefined = false)
    const result = await honeybookAdapter.commit({
      supabase,
      venueId: VENUE_ID,
      rows: parseResult.rows,
    })

    const inserted = result.weddingsInserted ?? 0
    const matched = result.weddingsMatchedExisting ?? 0
    const upgraded = result.weddingsStatusUpgraded ?? 0
    const interactions = result.interactionsInserted ?? 0
    const errors = result.errors?.length ?? 0

    console.log(`  Result: ${inserted} new | ${matched} matched | ${upgraded} upgraded | ${interactions} interactions | ${errors} errors`)
    if (errors > 0) console.log('  Errors:', result.errors?.slice(0, 5))

    totalInserted += inserted
    totalMatched += matched
    totalUpgraded += upgraded
    totalInteractions += interactions
    totalErrors += errors
  }

  console.log('\n=== AGGREGATE ===')
  console.log(`New weddings:   ${totalInserted}`)
  console.log(`Matched/backfilled: ${totalMatched}`)
  console.log(`Status upgraded (→booked): ${totalUpgraded}`)
  console.log(`Interactions written: ${totalInteractions}`)
  console.log(`Errors: ${totalErrors}`)

  // Final DB check
  const { data: statusCounts } = await supabase
    .from('weddings')
    .select('status')
    .eq('venue_id', VENUE_ID)
  const counts: Record<string, number> = {}
  for (const r of statusCounts ?? []) {
    counts[r.status] = (counts[r.status] ?? 0) + 1
  }
  console.log('\nDB wedding status counts:', JSON.stringify(counts))
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
