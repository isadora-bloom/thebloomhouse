// ============================================================================
// Phase 2 DANGER-table export — built from PHASE-2-WIPE-MANIFEST.md.
// CONSOLIDATION-PLAN-PHASED.md v2.1 §2.2. Run BEFORE scripts/phase2-wipe.mjs
// (the wipe refuses --apply without a fresh manifest from this script).
//
// Exports every EXPORT-AND-REMERGE table as full-row JSON under
// phase2-exports/, plus FULL weddings + people rows. Full rows on purpose:
// the re-merge (§2.6) re-keys against NEW couple/wedding ids by stable
// identifiers (emails / external CRM ids), and full rows keep every possible
// join key available — including the weddings operator column-cluster
// (owner_note / owner_photo / manual lead_source) and calendly_qa, which is
// ALSO the Calendly replay's payload source (replayCalendlyFromQa reads
// weddings.calendly_qa — gone after the wipe unless re-merged first; see
// PHASE2-GO-CHECKLIST.md for the ordering).
//
// READ-ONLY against the database (writes only local JSON files), so it runs
// against prod without safety flags — that is the point: export FROM prod
// immediately before the prod wipe.
//
// Usage: node scripts/phase2-export-danger.mjs
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const OUT_DIR = 'phase2-exports'

// Manifest DANGER verdicts: #6 evidence_overrides, #8 identity_decision_clusters,
// #9 couple_merge_events (manual rows — we export ALL, re-merge filters),
// #10 candidate_matches resolutions, #11 person_merges (audit), #16 draft_feedback,
// #20 discovery_feedback_actions, #21 discovery_sources (safety net — the table
// itself is NOT wiped), #22 re_engagement_actions, C weddings column-cluster
// (carried by the full weddings export). people exported as the stable-key
// source (emails per wedding) for every re-merge join.
const EXPORTS = [
  { table: 'evidence_overrides', scope: 'venue' },
  { table: 'identity_decision_clusters', scope: 'venue' },
  { table: 'couple_merge_events', scope: 'venue' },
  { table: 'candidate_matches', scope: 'venue' },
  { table: 'person_merges', scope: 'venue' },
  { table: 'draft_feedback', scope: 'venue' },
  { table: 'discovery_feedback_actions', scope: 'venue' },
  { table: 'discovery_sources', scope: 'venue' }, // safety net (table preserved in place)
  { table: 're_engagement_actions', scope: 'venue' },
  { table: 'weddings', scope: 'venue' }, // full rows: column-cluster + calendly_qa + join keys
  { table: 'people', scope: 'venue' },   // full rows: stable emails per wedding
]

const PAGE = 1000

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const url = env.NEXT_PUBLIC_SUPABASE_URL
const sb = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

mkdirSync(OUT_DIR, { recursive: true })
console.log(`Exporting DANGER tables for venue ${RIXEY_VENUE_ID} from ${url}\n`)

async function exportTable(table) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from(table)
      .select('*')
      .eq('venue_id', RIXEY_VENUE_ID)
      .range(from, from + PAGE - 1)
    if (error) return { error: error.message }
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return { rows }
}

const manifest = { exportedAt: new Date().toISOString(), venueId: RIXEY_VENUE_ID, url, tables: {} }
let failed = 0
for (const e of EXPORTS) {
  const r = await exportTable(e.table)
  if (r.error) {
    console.log(`  ${e.table.padEnd(34)} FAIL: ${r.error}`)
    manifest.tables[e.table] = { error: r.error }
    failed += 1
    continue
  }
  const file = `${OUT_DIR}/${e.table}.json`
  writeFileSync(file, JSON.stringify(r.rows, null, 1))
  manifest.tables[e.table] = { rows: r.rows.length, file }
  console.log(`  ${e.table.padEnd(34)} ${String(r.rows.length).padStart(6)} rows → ${file}`)
}

writeFileSync(`${OUT_DIR}/export-manifest.json`, JSON.stringify(manifest, null, 2))
console.log(`\nManifest → ${OUT_DIR}/export-manifest.json`)
if (failed > 0) {
  console.error(`\n${failed} table(s) FAILED to export — the wipe gate will still see a manifest; FIX THESE FIRST.`)
  process.exit(1)
}
console.log('All exports complete. phase2-exports/ is gitignored operator data — copy it somewhere safe too.')
