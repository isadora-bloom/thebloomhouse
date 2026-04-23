// Wipe ALL Rixey Manor data (not just the pipeline) and reset the venue to a
// fresh-onboarding state on the enterprise tier.
//
// What this DELETES:
//   * Every transactional row in every venue-id-scoped table for Rixey
//   * Every wedding-id-scoped row (ceremony_chair_plans, table_map_layouts)
//     whose parent wedding belongs to Rixey
//   * venue_config, venue_ai_config, venue_email_filters, auto_send_rules
//     (then RE-INSERTS fresh default rows so onboarding has a base to work
//      from)
//
// What this KEEPS:
//   * organisations row (Rixey Manor org)
//   * venues row (Rixey Manor venue) — plan_tier bumped to 'enterprise'
//   * user_profiles (Isadora's login stays intact)
//   * auth.users (you can sign in with your existing credentials)
//   * gmail_connections (so you don't have to re-OAuth — remove it from
//     PRESERVE_TABLES below if you want a full OAuth reset)
//
// What this UNLOCKS:
//   * venues.plan_tier = 'enterprise' (all tiers visible in the UI)
//   * organisations.plan_tier = 'enterprise'
//
// Safety:
//   * Hardcoded venue_id + org_id + expected names. If they don't match the
//     DB (someone renamed Rixey, or the venue_id changed), the script bails
//     before touching anything.
//   * Dry run by default. Requires --execute to actually delete.
//
// Usage:
//   node scripts/wipe-rixey-for-reonboard.mjs              # dry run
//   node scripts/wipe-rixey-for-reonboard.mjs --execute    # real wipe

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Config — the only hardcoded identifiers in this file
// ---------------------------------------------------------------------------

const RIXEY_VENUE_ID   = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const RIXEY_ORG_ID     = 'c8c829da-c190-44eb-86aa-4cbf59f0640c'
const RIXEY_VENUE_NAME = 'Rixey Manor'
const RIXEY_ORG_NAME   = 'Rixey Manor'

// Every table that carries venue_id — we'll wipe each one for Rixey. Generated
// from information_schema on 2026-04-23. Update this list if new tables land.
const VENUE_TABLES = [
  // Pipeline + email
  'interactions', 'drafts', 'draft_feedback', 'email_sync_state', 'auto_send_rules',
  'venue_email_filters', 'follow_up_sequences', 'sage_conversations',
  'sage_uncertain_queue', 'messages',
  // Client data
  'people', 'weddings', 'tours', 'client_codes', 'client_match_queue',
  'wedding_touchpoints', 'relationships', 'tour_transcript_orphans',
  // Intelligence / AI
  'intelligence_extractions', 'intelligence_insights', 'anomaly_alerts',
  'knowledge_gaps', 'knowledge_base', 'ai_briefings', 'lead_score_history',
  'insight_outcomes', 'engagement_events', 'source_attribution',
  'marketing_spend', 'consultant_metrics', 'campaigns', 'lost_deals',
  'social_posts', 'natural_language_queries', 'trend_recommendations',
  'planning_notes', 'annotations', 'brain_dump_entries', 'vendor_recommendations',
  // Voice
  'voice_preferences', 'voice_training_sessions', 'review_language',
  'phrase_usage', 'learned_preferences',
  // Availability + external context
  'venue_availability', 'weather_data', 'search_trends',
  'venue_health', 'venue_health_history',
  // Couple portal content
  'reviews', 'event_feedback',
  'contracts', 'booked_vendors',
  'budget', 'budget_items', 'budget_payments',
  'checklist_items', 'decor_inventory',
  'bar_planning', 'bar_recipes', 'bar_shopping_list',
  'staffing_assignments', 'shuttle_schedule', 'rehearsal_dinner',
  'ceremony_order', 'seating_tables',
  'guest_list', 'guest_tags', 'guest_meal_options', 'guest_care_notes',
  'allergy_registry', 'makeup_schedule', 'bedroom_assignments',
  'wedding_config', 'wedding_detail_config', 'wedding_details',
  'wedding_party', 'wedding_tables',
  'wedding_website_settings', 'wedding_worksheets',
  'rsvp_config', 'rsvp_responses', 'timeline',
  'photo_library', 'inspo_gallery',
  'borrow_catalog', 'borrow_selections', 'storefront',
  'venue_assets', 'venue_resources', 'venue_seasonal_content', 'venue_usps',
  'accommodations', 'brand_assets',
  // Operational
  'activity_log', 'admin_notifications', 'notifications',
  'api_costs', 'error_logs',
  'heat_score_config',
  'portal_section_config', 'section_finalisations',
  'team_invitations',
  'onboarding_progress',
  // Legacy archived — harmless to touch
  '_archived_couple_budget', '_archived_follow_up_sequence_templates',
  '_archived_seating_assignments', '_archived_wedding_sequences',
]

// Tables keyed on wedding_id with no venue_id — scoped through weddings.
const WEDDING_ONLY_TABLES = ['ceremony_chair_plans', 'table_map_layouts']

// Tables we explicitly DO NOT touch.
const PRESERVE_TABLES = [
  'venues', 'organisations', 'user_profiles',
  'gmail_connections',           // keep OAuth so you don't have to re-auth
  'venue_groups', 'venue_group_members', // group membership (Rixey has none today)
]

// Tables we RESET (delete then re-insert a fresh default row).
const RESET_TABLES = [
  'venue_config',
  'venue_ai_config',
  'venue_email_filters',
  'auto_send_rules',
]

// ---------------------------------------------------------------------------
// Env + client
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Safety guard — venue_id + name + org_id must match DB
// ---------------------------------------------------------------------------

const { data: venueCheck, error: vErr } = await sb
  .from('venues')
  .select('id, name, org_id, is_demo')
  .eq('id', RIXEY_VENUE_ID)
  .single()
if (vErr || !venueCheck) {
  console.error(`SAFETY FAIL: venue ${RIXEY_VENUE_ID} not found.`)
  process.exit(1)
}
if (venueCheck.name !== RIXEY_VENUE_NAME) {
  console.error(`SAFETY FAIL: venue ${RIXEY_VENUE_ID} is named "${venueCheck.name}", expected "${RIXEY_VENUE_NAME}". Aborting.`)
  process.exit(1)
}
if (venueCheck.org_id !== RIXEY_ORG_ID) {
  console.error(`SAFETY FAIL: venue ${RIXEY_VENUE_ID} has org_id ${venueCheck.org_id}, expected ${RIXEY_ORG_ID}. Aborting.`)
  process.exit(1)
}
if (venueCheck.is_demo) {
  console.error(`SAFETY FAIL: venue ${RIXEY_VENUE_ID} is flagged is_demo=true. This script is for the real Rixey Manor venue only. Aborting.`)
  process.exit(1)
}

const { data: orgCheck, error: oErr } = await sb
  .from('organisations')
  .select('id, name')
  .eq('id', RIXEY_ORG_ID)
  .single()
if (oErr || !orgCheck || orgCheck.name !== RIXEY_ORG_NAME) {
  console.error(`SAFETY FAIL: org ${RIXEY_ORG_ID} is named "${orgCheck?.name}", expected "${RIXEY_ORG_NAME}". Aborting.`)
  process.exit(1)
}

console.log(`Target: ${venueCheck.name} / ${orgCheck.name}  (venue=${RIXEY_VENUE_ID})`)
console.log(EXECUTE ? '=== EXECUTING WIPE ===\n' : '=== DRY RUN (pass --execute to delete) ===\n')

// ---------------------------------------------------------------------------
// 1. Enumerate weddings for the wedding-id-only tables
// ---------------------------------------------------------------------------

const { data: weddingRows } = await sb.from('weddings').select('id').eq('venue_id', RIXEY_VENUE_ID)
const weddingIds = (weddingRows ?? []).map((w) => w.id)
console.log(`Rixey wedding rows: ${weddingIds.length}`)

// ---------------------------------------------------------------------------
// 2. Dry run — count what would be deleted in each table
// ---------------------------------------------------------------------------

let nonZeroCount = 0
let skippedCount = 0
const nonZeroTables = []

for (const t of VENUE_TABLES) {
  const { count, error } = await sb
    .from(t)
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_VENUE_ID)
  if (error) {
    console.log(`  ${t.padEnd(34)} (skip: ${error.message.slice(0, 50)})`)
    skippedCount++
    continue
  }
  if ((count ?? 0) > 0) {
    console.log(`  ${t.padEnd(34)} ${count}`)
    nonZeroCount += count
    nonZeroTables.push({ name: t, count })
  }
}

for (const t of WEDDING_ONLY_TABLES) {
  if (weddingIds.length === 0) {
    console.log(`  ${t.padEnd(34)} 0 (no Rixey weddings)`)
    continue
  }
  const { count, error } = await sb
    .from(t)
    .select('id', { count: 'exact', head: true })
    .in('wedding_id', weddingIds)
  if (error) {
    console.log(`  ${t.padEnd(34)} (skip: ${error.message.slice(0, 50)})`)
    skippedCount++
    continue
  }
  if ((count ?? 0) > 0) {
    console.log(`  ${t.padEnd(34)} ${count}`)
    nonZeroCount += count
    nonZeroTables.push({ name: t, count, byWedding: true })
  }
}

console.log(`\nReset tables (will be deleted + re-seeded with defaults):`)
for (const t of RESET_TABLES) console.log(`  ${t}`)

console.log(`\nPreserved tables (untouched):`)
for (const t of PRESERVE_TABLES) console.log(`  ${t}`)

console.log(`\nTotal rows that would be deleted: ${nonZeroCount}`)
if (skippedCount > 0) console.log(`(${skippedCount} tables skipped — likely missing or not scoped as expected)`)

if (!EXECUTE) {
  console.log('\nDry run complete. Re-run with --execute to actually delete + reset.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 3. Execute wipe
// ---------------------------------------------------------------------------

console.log('\n=== Deleting ===')

// 3a. Wedding-id-only tables first (they FK to weddings which we wipe next)
for (const t of WEDDING_ONLY_TABLES) {
  if (weddingIds.length === 0) continue
  const { error, count } = await sb.from(t).delete({ count: 'exact' }).in('wedding_id', weddingIds)
  if (error) console.log(`  ${t.padEnd(34)} FAIL: ${error.message}`)
  else console.log(`  ${t.padEnd(34)} deleted ${count ?? '?'}`)
}

// 3b. Venue-id-scoped tables (order doesn't matter much because of ON DELETE
// CASCADE on the FK to venues — we're using DELETE WHERE venue_id=x, not
// DELETE FROM venues, so cascade isn't involved either way. Fire in list order.
for (const t of VENUE_TABLES) {
  const { error, count } = await sb.from(t).delete({ count: 'exact' }).eq('venue_id', RIXEY_VENUE_ID)
  if (error) console.log(`  ${t.padEnd(34)} FAIL: ${error.message}`)
  else if ((count ?? 0) > 0) console.log(`  ${t.padEnd(34)} deleted ${count}`)
}

// 3c. Reset config tables — delete then re-insert minimal defaults
console.log('\n=== Resetting config to fresh-onboarding defaults ===')

{
  await sb.from('venue_config').delete().eq('venue_id', RIXEY_VENUE_ID)
  const { error } = await sb.from('venue_config').insert({
    venue_id: RIXEY_VENUE_ID,
    business_name: RIXEY_VENUE_NAME,
  })
  console.log(`  venue_config                        reset ${error ? 'FAIL: ' + error.message : 'OK'}`)
}

{
  await sb.from('venue_ai_config').delete().eq('venue_id', RIXEY_VENUE_ID)
  const { error } = await sb.from('venue_ai_config').insert({
    venue_id: RIXEY_VENUE_ID,
    ai_name: 'Sage',
  })
  console.log(`  venue_ai_config                     reset ${error ? 'FAIL: ' + error.message : 'OK'}`)
}

{
  // Re-seed the 4 scheduling-tool filter domains the Phase 1 v4 trigger
  // (migration 072) adds to every new venue. We already deleted them above.
  // Column shape mirrors migration 072 exactly.
  await sb.from('venue_email_filters').delete().eq('venue_id', RIXEY_VENUE_ID)
  const defaults = [
    { pattern: 'calendly.com',         action: 'ignore',   note: 'Calendly confirmation email — webhook is source of truth (reseed)' },
    { pattern: 'acuityscheduling.com', action: 'ignore',   note: 'Acuity Scheduling confirmation email (reseed)' },
    { pattern: 'honeybook.com',        action: 'no_draft', note: 'HoneyBook system mail — classify but do not draft (reseed)' },
    { pattern: 'dubsado.com',          action: 'no_draft', note: 'Dubsado system mail — classify but do not draft (reseed)' },
  ]
  const { error } = await sb.from('venue_email_filters').insert(
    defaults.map((d) => ({
      venue_id: RIXEY_VENUE_ID,
      pattern_type: 'sender_domain',
      pattern: d.pattern,
      action: d.action,
      source: 'manual',
      note: d.note,
    }))
  )
  console.log(`  venue_email_filters                 reset ${error ? 'FAIL: ' + error.message : 'OK'} (4 defaults)`)
}

{
  await sb.from('auto_send_rules').delete().eq('venue_id', RIXEY_VENUE_ID)
  // Don't re-insert — onboarding flow builds these per source as the admin
  // configures behaviour. An absent row means auto-send is off by default.
  console.log(`  auto_send_rules                     cleared (onboarding re-creates)`)
}

// 3d. Bump plan tier to enterprise so nothing is gated
console.log('\n=== Unlocking all tiers ===')
{
  const { error } = await sb.from('venues').update({ plan_tier: 'enterprise' }).eq('id', RIXEY_VENUE_ID)
  console.log(`  venues.plan_tier = 'enterprise'     ${error ? 'FAIL: ' + error.message : 'OK'}`)
}
{
  const { error } = await sb.from('organisations').update({ plan_tier: 'enterprise' }).eq('id', RIXEY_ORG_ID)
  console.log(`  organisations.plan_tier = enterprise ${error ? 'FAIL: ' + error.message : 'OK'}`)
}

// ---------------------------------------------------------------------------
// 4. Verify
// ---------------------------------------------------------------------------

console.log('\n=== Post-wipe verification ===')
for (const t of nonZeroTables.slice(0, 20)) {
  const q = sb.from(t.name).select('id', { count: 'exact', head: true })
  const { count } = t.byWedding
    ? await q.in('wedding_id', weddingIds)
    : await q.eq('venue_id', RIXEY_VENUE_ID)
  console.log(`  ${t.name.padEnd(34)} after: ${count ?? 0}`)
}

const { data: venueAfter } = await sb.from('venues').select('plan_tier').eq('id', RIXEY_VENUE_ID).single()
console.log(`\n  venues.plan_tier                    ${venueAfter?.plan_tier}`)

console.log('\nDone. Log in as Isadora — the venue should feel like a fresh onboarding.')
