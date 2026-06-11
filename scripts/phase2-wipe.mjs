// ============================================================================
// Phase 2 wipe — built from PHASE-2-WIPE-MANIFEST.md (2026-06-11).
// CONSOLIDATION-PLAN-PHASED.md v2.1 §2. REPLACES the old wipe scripts:
//   - fixes manifest bug 1: the Tier-8 script wrongly wiped operator data
//     (event_feedback, annotations, natural_language_queries, draft_feedback,
//     sage_conversations/_uncertain_queue, wedding_internal_notes,
//     intel_acknowledgments) — all excluded here, asserted in NEVER_WIPE.
//   - fixes manifest bug 2: neither old script touched the migration-346
//     spine (couples / touchpoints / fragments / agent_couple_links /
//     couple_merge_events / couple_progression_events / candidate_matches /
//     tracer_run_events) — wiped here, children before parents.
//   - resets the email_sync_state watermark + wipes the Zoom/SMS dedup
//     ledgers so every channel re-ingests (manifest operator-decisions).
//   - gates on a FRESH export from phase2-export-danger.mjs (<48h) before
//     touching the EXPORT-AND-REMERGE tables. --skip-export-check overrides.
//
// Safety: dry-run by default (counts only); --apply to delete; prod ref
// refused without --allow-prod (scripts/_safety.mjs). Venue identity is
// triple-checked (id + name + org) before anything runs.
//
// Usage:
//   node scripts/phase2-wipe.mjs                       # dry-run vs .env.local
//   node scripts/phase2-wipe.mjs --apply               # execute (non-prod)
//   node scripts/phase2-wipe.mjs --apply --allow-prod  # execute on PROD
// ============================================================================

import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { parseSafetyFlags, assertNotProd, requireApply } from './_safety.mjs'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const RIXEY_VENUE_NAME = 'Rixey Manor'
const EXPORT_MANIFEST = 'phase2-exports/export-manifest.json'
const EXPORT_MAX_AGE_MS = 48 * 60 * 60 * 1000

// --- Migration-346 spine (manifest bug 2 — MUST be wiped or the reimport
// collides with stale couples on uq_couples_source_wedding). Children first.
// couple_progression_events has NO venue_id (deleted via couple ids).
const SPINE_TABLES = [
  'touchpoints',
  'fragments',
  'candidate_matches',
  'couple_merge_events', // EXPORT-AND-REMERGE manual rows — export-gated below
  'agent_couple_links',
  'tracer_run_events',
  // couple_progression_events handled via couple-id batch (no venue_id col)
  // 'couples' deleted LAST in this group (parent).
]

// --- Legacy pipeline + ingestion ledgers. Order matters loosely (children
// before weddings/people). Every row reproducible from origin replay.
const LEGACY_TABLES = [
  'interactions',
  'drafts',
  'attribution_events',
  'wedding_touchpoints',
  'engagement_events',
  'lead_score_history',
  'tangential_signals',
  'candidate_identities',
  'intelligence_extractions',
  'mint_wedding_telemetry',
  'merge_reattachment_log',
  'lead_source_derivation_log',
  'client_match_queue',
  'pending_sms_drafts',
  'lost_deals',
  'wedding_lifecycle_events',
  'wedding_journey_narratives',
  'wedding_auto_context',
  'tour_prep_briefs',
  'tour_transcript_orphans',
  'transcript_segments',
  'tours',
  'booked_data_recovery_log',
  'filter_match_log',
  'venue_email_filter_matches',
  'knot_visitor_activity',
  'contacts',
  'people',
  // 'weddings' deleted LAST overall (parent of the event tables).
]

// --- Derived intel — recomputed post-reimport by the sweeps.
const DERIVED_TABLES = [
  'couple_intel',
  'couple_identity_profile',
  'venue_intel',
  'venue_thesis',
  'cohort_damping_cache',
  'cohort_rollups',
  'persona_channel_rollups',
  'intelligence_insights',
  'anomaly_alerts',
  'channel_intel_snapshots',
  'channel_truth_audits',
  'intel_matches',
  'marketing_recommendations',
  'marketing_digests',
  'trend_recommendations',
  'phrase_usage',
  'paused_period_skipped',
  'prediction_snapshots',
  'prediction_outcomes',
  'discovery_digests',
  'purchase_recommendations',
]

// --- Job queues — all transient.
const JOB_TABLES = [
  'identity_reconstruction_jobs',
  'couple_intel_jobs',
  'tour_prep_jobs',
  'post_tour_followup_jobs',
  'referral_extraction_jobs',
  'review_solicit_jobs',
  'review_solicit_requests',
  'intel_match_jobs',
  'intel_discovery_jobs',
  'marketing_loop_jobs',
  'marketing_recommendation_jobs',
  'measure_outcome_jobs',
  'hypothesis_validation_jobs',
  'lifecycle_transition_jobs',
  'attribution_role_jobs',
  'attribution_intent_jobs',
  'venue_intel_jobs',
  'venue_thesis_jobs',
]

// --- Import + dedup ledgers — wiped so every channel re-ingests fresh
// (manifest operator-decision items: email watermark, Zoom/SMS ledgers).
const LEDGER_TABLES = [
  'crm_import_rows',
  'import_runs',
  'processed_zoom_meetings',
  'processed_sms_messages',
  'email_sync_state', // watermark reset → Gmail re-backfills from scratch
]

// --- EXPORT-AND-REMERGE (manifest DANGER #6/8/11/16/20/22 + candidate/merge
// resolutions). Wiped ONLY behind a fresh phase2-export-danger run.
const EXPORT_GATED_TABLES = [
  'draft_feedback',
  'evidence_overrides',
  'identity_decision_clusters',
  'person_merges',
  'discovery_feedback_actions',
  're_engagement_actions',
]

// --- Event-planning tables (PRESERVE-EVENT in the manifest, relaxed by
// decision D-3 2026-05-29: "portal has NO data → Phase 2 wipes event tables
// too". The script WARNS LOUDLY if any holds rows — that means the portal
// gained data since D-3 was verified and the operator must re-decide.)
const EVENT_TABLES = [
  'guest_list', 'guest_meal_options', 'guest_care_notes',
  'guest_tag_assignments', 'guest_tags', 'timeline', 'budget',
  'budget_items', 'budget_payments', 'seating_tables', 'seating_assignments',
  'wedding_party', 'wedding_relationships', 'wedding_tables',
  'wedding_config', 'wedding_detail_config', 'wedding_details',
  'wedding_sequences', 'wedding_worksheets', 'wedding_website_settings',
  'contracts', 'checklist_items', 'planning_notes', 'messages',
  'inspo_gallery', 'photo_library', 'day_of_media', 'bar_planning',
  'bar_recipes', 'bar_shopping_list', 'bedroom_assignments',
  'borrow_selections', 'ceremony_chair_plans', 'ceremony_order',
  'decor_inventory', 'makeup_schedule', 'rehearsal_dinner',
  'rsvp_responses', 'shuttle_schedule', 'staffing_assignments',
  'vendor_checklist', 'client_codes', 'section_finalisations',
]
const WEDDING_ONLY_TABLES = ['table_map_layouts'] // no venue_id — via wedding ids
const WEDDING_SCOPED_TABLES = ['admin_notifications', 'notifications'] // wipe wedding-scoped rows only

// --- NEVER WIPE — manifest DANGER PRESERVE-IN-PLACE + the Tier-8 script's
// bug list. The script ASSERTS no overlap with any wipe group at startup.
const NEVER_WIPE = new Set([
  'wedding_internal_notes', 'event_feedback', 'event_feedback_vendors',
  'annotations', 'natural_language_queries', 'sage_conversations',
  'sage_uncertain_queue', 'draft_edit_insights', 'intel_acknowledgments',
  'insight_outcomes', 'brain_dump_entries', 'brain_dump_pattern_grants',
  'knowledge_captures', 'knowledge_gaps', 'handle_merge_decisions',
  'integrity_remediations', 'discovery_sources', 'reviews', 'review_language',
  'voice_preferences', 'voice_dna_derivations', 'voice_training_sessions',
  'learned_preferences', 'brand_assets', 'knowledge_base', 'marketing_spend',
  'gmail_connections', 'web_visits', 'tracked_sources',
])

// ---------------------------------------------------------------------------
const { apply, allowProd } = parseSafetyFlags(process.argv)
const skipExportCheck = process.argv.includes('--skip-export-check')

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const url = env.NEXT_PUBLIC_SUPABASE_URL
assertNotProd(url, { allowProd })
const sb = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Self-check: no wipe group may name a NEVER_WIPE table.
const ALL_WIPE = [
  ...SPINE_TABLES, 'couples', ...LEGACY_TABLES, 'weddings', ...DERIVED_TABLES,
  ...JOB_TABLES, ...LEDGER_TABLES, ...EXPORT_GATED_TABLES, ...EVENT_TABLES,
  ...WEDDING_ONLY_TABLES, ...WEDDING_SCOPED_TABLES,
]
const overlap = ALL_WIPE.filter((t) => NEVER_WIPE.has(t))
if (overlap.length > 0) {
  console.error(`SELF-CHECK FAIL: wipe list names NEVER_WIPE table(s): ${overlap.join(', ')}`)
  process.exit(1)
}
const dupes = ALL_WIPE.filter((t, i) => ALL_WIPE.indexOf(t) !== i)
if (dupes.length > 0) {
  console.error(`SELF-CHECK FAIL: duplicate wipe entries: ${[...new Set(dupes)].join(', ')}`)
  process.exit(1)
}

// Venue triple-check.
const { data: venue, error: vErr } = await sb
  .from('venues').select('id, name, org_id, is_demo').eq('id', RIXEY_VENUE_ID).single()
if (vErr || !venue) { console.error(`SAFETY FAIL: venue ${RIXEY_VENUE_ID} not found (${vErr?.message}).`); process.exit(1) }
if (venue.name !== RIXEY_VENUE_NAME) { console.error(`SAFETY FAIL: venue name "${venue.name}" != "${RIXEY_VENUE_NAME}".`); process.exit(1) }
if (venue.is_demo) { console.error('SAFETY FAIL: venue is_demo=true.'); process.exit(1) }

// Export freshness gate.
let exportOk = false
if (existsSync(EXPORT_MANIFEST)) {
  try {
    const m = JSON.parse(readFileSync(EXPORT_MANIFEST, 'utf8'))
    const age = Date.now() - Date.parse(m.exportedAt)
    exportOk = m.venueId === RIXEY_VENUE_ID && age >= 0 && age < EXPORT_MAX_AGE_MS
    console.log(`Export manifest: ${m.exportedAt} (${Math.round(age / 3_600_000)}h old) → ${exportOk ? 'FRESH' : 'STALE'}`)
  } catch { /* unreadable → not ok */ }
} else {
  console.log('Export manifest: NOT FOUND (run scripts/phase2-export-danger.mjs first)')
}
if (apply && !exportOk && !skipExportCheck) {
  console.error('REFUSED: no fresh DANGER-table export (<48h). Run scripts/phase2-export-danger.mjs, or pass --skip-export-check to accept the data loss.')
  process.exit(1)
}

console.log(`\nTarget: ${venue.name} (${RIXEY_VENUE_ID}) on ${url}`)
console.log(apply ? '=== APPLY ===' : '=== DRY RUN (counts only; --apply to delete) ===')

// Collect ids for non-venue-keyed deletes.
const { data: wRows } = await sb.from('weddings').select('id').eq('venue_id', RIXEY_VENUE_ID)
const weddingIds = (wRows ?? []).map((w) => w.id)
const { data: cRows } = await sb.from('couples').select('id').eq('venue_id', RIXEY_VENUE_ID)
const coupleIds = (cRows ?? []).map((c) => c.id)
console.log(`weddings: ${weddingIds.length} · couples: ${coupleIds.length}\n`)

async function countVenue(t) {
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('venue_id', RIXEY_VENUE_ID)
  return error ? { skip: error.message } : { count: count ?? 0 }
}

const plan = [] // { table, mode, count }
async function stage(group, tables, mode = 'venue') {
  for (const t of tables) {
    let r
    if (mode === 'venue') r = await countVenue(t)
    else if (mode === 'wedding') {
      if (weddingIds.length === 0) { plan.push({ table: t, group, mode, count: 0 }); continue }
      const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).in('wedding_id', weddingIds)
      r = error ? { skip: error.message } : { count: count ?? 0 }
    } else if (mode === 'wedding_scoped') {
      const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true })
        .eq('venue_id', RIXEY_VENUE_ID).not('wedding_id', 'is', null)
      r = error ? { skip: error.message } : { count: count ?? 0 }
    } else if (mode === 'couple') {
      if (coupleIds.length === 0) { plan.push({ table: t, group, mode, count: 0 }); continue }
      const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).in('couple_id', coupleIds)
      r = error ? { skip: error.message } : { count: count ?? 0 }
    }
    if (r.skip) console.log(`  ${t.padEnd(40)} (skip: ${String(r.skip).slice(0, 60)})`)
    else plan.push({ table: t, group, mode, count: r.count })
  }
}

console.log('--- spine (migration 346) ---')
await stage('spine', SPINE_TABLES)
await stage('spine', ['couple_progression_events'], 'couple')
await stage('spine', ['couples'])
console.log('--- legacy pipeline ---')
await stage('legacy', LEGACY_TABLES)
console.log('--- derived intel ---')
await stage('derived', DERIVED_TABLES)
console.log('--- job queues ---')
await stage('jobs', JOB_TABLES)
console.log('--- import/dedup ledgers + watermark ---')
await stage('ledgers', LEDGER_TABLES)
console.log('--- export-gated DANGER tables ---')
await stage('export-gated', EXPORT_GATED_TABLES)
console.log('--- event tables (D-3: portal verified empty 2026-05-29) ---')
await stage('event', EVENT_TABLES)
await stage('event', WEDDING_ONLY_TABLES, 'wedding')
await stage('event', WEDDING_SCOPED_TABLES, 'wedding_scoped')
console.log('--- weddings (parent, last) ---')
await stage('legacy', ['weddings'])

let total = 0
for (const p of plan) {
  if (p.count > 0) { console.log(`  ${p.table.padEnd(40)} ${p.count}`); total += p.count }
}
console.log(`\nTotal rows in scope: ${total}`)

const eventRows = plan.filter((p) => p.group === 'event' && p.count > 0)
if (eventRows.length > 0) {
  console.log(`\n⚠⚠ EVENT TABLES HOLD ${eventRows.reduce((s, p) => s + p.count, 0)} ROWS (${eventRows.map((p) => p.table).join(', ')}).`)
  console.log('⚠⚠ D-3 ("portal has NO data") was verified 2026-05-29 — if a couple/operator added portal data since, STOP and re-decide before --apply.')
}

if (!requireApply(apply, 'phase2-wipe')) process.exit(0)

console.log('\n=== Deleting (children → parents) ===')
async function wipeOne(p) {
  let q = sb.from(p.table).delete({ count: 'exact' })
  if (p.mode === 'venue') q = q.eq('venue_id', RIXEY_VENUE_ID)
  else if (p.mode === 'wedding') q = q.in('wedding_id', weddingIds)
  else if (p.mode === 'wedding_scoped') q = q.eq('venue_id', RIXEY_VENUE_ID).not('wedding_id', 'is', null)
  else if (p.mode === 'couple') q = q.in('couple_id', coupleIds)
  const { error, count } = await q
  if (error) console.log(`  ${p.table.padEnd(40)} FAIL: ${error.message}`)
  else if ((count ?? 0) > 0) console.log(`  ${p.table.padEnd(40)} deleted ${count}`)
}
// Execute in the staged order, except parents (couples / weddings) AFTER
// their children — plan[] is already ordered that way by the stage calls,
// with one exception: 'couples' was staged inside the spine group before
// legacy/event children that FK weddings (not couples), so the order holds.
for (const p of plan) {
  if ((p.count ?? 0) === 0) continue
  if (p.mode === 'wedding' && weddingIds.length === 0) continue
  if (p.mode === 'couple' && coupleIds.length === 0) continue
  await wipeOne(p)
}

console.log('\n=== Post-wipe verification ===')
let dirty = 0
for (const p of plan.filter((x) => x.count > 0)) {
  let q = sb.from(p.table).select('*', { count: 'exact', head: true })
  if (p.mode === 'venue') q = q.eq('venue_id', RIXEY_VENUE_ID)
  else if (p.mode === 'wedding') q = q.in('wedding_id', weddingIds)
  else if (p.mode === 'wedding_scoped') q = q.eq('venue_id', RIXEY_VENUE_ID).not('wedding_id', 'is', null)
  else if (p.mode === 'couple') q = q.in('couple_id', coupleIds)
  const { count } = await q
  if ((count ?? 0) > 0) { console.log(`  ⚠ ${p.table.padEnd(38)} still has ${count}`); dirty += 1 }
}
console.log(dirty === 0 ? '  ✓ every wiped table is empty for the venue' : `  ⚠ ${dirty} table(s) not fully wiped — investigate before reimport`)
console.log('\nDone. Preserved: NEVER_WIPE set (operator data, voice DNA, reviews, brand, knowledge, connections, marketing, external feeds).')
console.log('Next: PHASE2-GO-CHECKLIST.md §reimport — HoneyBook CSV → calendly_qa re-merge → Calendly replay → Gmail backfill.')
