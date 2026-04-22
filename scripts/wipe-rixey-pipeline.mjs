// Wipe all pipeline data for every real (non-demo) venue.
//
// Deletes: intelligence_extractions, engagement_events, drafts,
//          interactions, people, weddings, lead_score_history,
//          activity_log, planning_notes, tours, draft_feedback,
//          client_codes
// Preserves: venue row, gmail_connections, venue_ai_config, user_profiles,
//            knowledge_base, prompt_layers, and any venue-config tables
//            (bar, shuttle, rooms, etc.).
//
// Use this after a botched onboarding when the pipeline is polluted with
// self-loop weddings, form-relay ghosts, or duplicate interactions and you
// want a clean slate. After wiping, click "Sync" in the inbox — a first
// sync on an empty venue automatically backfills 90 days.
//
// Usage:
//   node scripts/wipe-rixey-pipeline.mjs             # dry-run
//   node scripts/wipe-rixey-pipeline.mjs --execute   # actually delete
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const EXECUTE = process.argv.includes('--execute')
console.log(EXECUTE ? '=== EXECUTING PIPELINE WIPE ===\n' : '=== DRY RUN (pass --execute to delete) ===\n')

// 1. Enumerate real venues ----------------------------------------------------
const { data: venues, error: venueErr } = await sb
  .from('venues')
  .select('id, name, slug, is_demo')
  .eq('is_demo', false)
if (venueErr) { console.error('venues query failed:', venueErr.message); process.exit(1) }
if (!venues || venues.length === 0) { console.log('No real venues found. Nothing to wipe.'); process.exit(0) }

console.log(`Real venues in scope: ${venues.length}`)
for (const v of venues) console.log(`  ${v.name.padEnd(28)} ${v.id}`)

const venueIds = venues.map((v) => v.id)

// 2. Gather wedding IDs (for tables keyed on wedding_id, not venue_id) --------
const { data: weddingRows } = await sb
  .from('weddings')
  .select('id')
  .in('venue_id', venueIds)
const weddingIds = (weddingRows ?? []).map((w) => w.id)
console.log(`\nWedding rows to remove: ${weddingIds.length}`)

// 3. Count what will cascade --------------------------------------------------
console.log('\n=== Row counts that will be removed ===')
const VENUE_TABLES = [
  'intelligence_extractions',
  'drafts',
  'interactions',
  'people',
  'weddings',
  'client_codes',
  'activity_log',
  'planning_notes',
  'tours',
]
const WEDDING_TABLES = ['engagement_events', 'lead_score_history', 'draft_feedback']

for (const t of VENUE_TABLES) {
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).in('venue_id', venueIds)
  if (error) console.log(`  ${t.padEnd(26)} (skip: ${error.message.slice(0, 50)})`)
  else console.log(`  ${t.padEnd(26)} ${count} rows`)
}
for (const t of WEDDING_TABLES) {
  if (weddingIds.length === 0) { console.log(`  ${t.padEnd(26)} 0 rows (no weddings)`); continue }
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).in('wedding_id', weddingIds)
  if (error) console.log(`  ${t.padEnd(26)} (skip: ${error.message.slice(0, 50)})`)
  else console.log(`  ${t.padEnd(26)} ${count} rows`)
}

if (!EXECUTE) {
  console.log('\nDry run complete. Re-run with --execute to delete.')
  process.exit(0)
}

// 4. Execute — child tables first, then weddings ------------------------------
console.log('\n=== Deleting ===')

for (const t of WEDDING_TABLES) {
  if (weddingIds.length === 0) continue
  const { count, error } = await sb.from(t).delete({ count: 'exact' }).in('wedding_id', weddingIds)
  if (error) console.log(`  ${t.padEnd(26)} skip/err: ${error.message.slice(0, 60)}`)
  else console.log(`  ${t.padEnd(26)} deleted ${count}`)
}

// intelligence_extractions → drafts → interactions → people → weddings
// (extractions and drafts FK to interactions; interactions, people, weddings
//  are independent at the venue_id level but FK-linked between each other)
const ORDER = [
  'intelligence_extractions',
  'activity_log',
  'planning_notes',
  'tours',
  'client_codes',
  'drafts',
  'interactions',
  'people',
  'weddings',
]
for (const t of ORDER) {
  const { count, error } = await sb.from(t).delete({ count: 'exact' }).in('venue_id', venueIds)
  if (error) console.log(`  ${t.padEnd(26)} skip/err: ${error.message.slice(0, 60)}`)
  else console.log(`  ${t.padEnd(26)} deleted ${count}`)
}

// 5. Verify -------------------------------------------------------------------
console.log('\n=== Post-wipe counts (should all be 0) ===')
for (const t of VENUE_TABLES) {
  const { count } = await sb.from(t).select('*', { count: 'exact', head: true }).in('venue_id', venueIds)
  console.log(`  ${t.padEnd(26)} ${count}`)
}
console.log('\nDone. Click Sync in the inbox to pull a fresh 90-day backfill.')
