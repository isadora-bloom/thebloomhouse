// Wipe Rixey Manor client data for the Tier 8 layered-backtrace restart.
//
// Built 2026-05-14. Supersedes wipe-rixey-for-reonboard.mjs (which preceded
// Waves 4-8 + TIER 0-7 and wipes voice DNA / reviews / brand assets that
// Isadora has chosen to KEEP).
//
// User-confirmed scope (2026-05-14 conversation):
//   KEEP — voice DNA (voice_preferences, voice_dna_derivations, review_language,
//          voice_training_sessions, voice_training_responses)
//   KEEP — reviews + review_language
//   KEEP — all connections (OAuth, integrations, webhook config)
//   KEEP — venue config, brand assets, knowledge base, brain-dump knowledge,
//          marketing spend, weather data, climate norms, cultural moments,
//          tracked sources, coordinator absences, venue operational state,
//          essentials preferences, venue forbidden topics, heat score config
//   WIPE — all per-client (weddings, people, interactions, drafts, tours,
//          candidate_identities, attribution_events, couple_identity_profile,
//          couple_intel, every *_job queue scoped to wedding/person)
//   WIPE — phrase_usage (orphan tracker after client wipe)
//   WIPE — venue_intel + venue_thesis + cohort rollups + persona_channel_rollups
//          + intelligence_insights (user chose full forensic restart on cohort intel)
//   WIPE — review_solicit_requests + review_solicit_jobs (per-client)
//   WIPE — admin_notifications + notifications (where wedding_id IS NOT NULL)
//   WIPE — crm_import_rows (the imports we'll re-run)
//
// Safety:
//   * Hardcoded venue_id + org_id + name check; bails if any mismatch
//   * is_demo guard — refuses to run on the demo venue
//   * Dry run by default — requires --execute
//   * Audits information_schema for venue_id-scoped tables NOT in either
//     list and reports them before any DELETE runs
//
// Usage:
//   node scripts/wipe-rixey-tier8-fresh.mjs              # dry run + audit
//   node scripts/wipe-rixey-tier8-fresh.mjs --execute    # real wipe

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const RIXEY_VENUE_ID   = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const RIXEY_ORG_ID     = 'c8c829da-c190-44eb-86aa-4cbf59f0640c'
const RIXEY_VENUE_NAME = 'Rixey Manor'
const RIXEY_ORG_NAME   = 'Rixey Manor'

// Tables to WIPE for Rixey. Each row deleted WHERE venue_id = Rixey.
// Order is approximate FK-leaf-first; ON DELETE CASCADE handles most chains
// since we delete by venue_id not by parent row.
const WIPE_TABLES = [
  // ---- Phase 1: leaf tables (depend on weddings/people/interactions) ----
  // Drafts + email pipeline
  'drafts',
  'draft_feedback',
  'intelligence_extractions',
  'engagement_events',
  'lead_score_history',
  'tangential_signals',
  'attribution_events',
  'wedding_touchpoints',
  'mint_wedding_telemetry',
  'merge_reattachment_log',
  'lead_source_derivation_log',
  'person_merges',
  'client_match_queue',

  // Couple-side reconstruction (Wave 4-5)
  'couple_intel',
  'couple_identity_profile',
  'candidate_identities',
  'wedding_journey_narratives',
  'wedding_auto_context',
  'tour_prep_briefs',

  // Tour + post-tour
  'tours',
  'tour_transcript_orphans',
  'transcript_segments',

  // Identity + reconstruction queues
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
  'wedding_lifecycle_events',

  // Predictions (per-wedding)
  'prediction_snapshots',
  'prediction_outcomes',

  // Discovery (per-couple feedback)
  'discovery_feedback_actions',
  'discovery_digests',  // synthesized from clients

  // Per-couple data surfaces (couple portal + day-of)
  'guest_list',
  'guest_meal_options',
  'guest_care_notes',
  'guest_tag_assignments',
  'guest_tags',
  'timeline',
  'budget',
  'budget_items',
  'budget_payments',
  'seating_tables',
  'seating_assignments',
  'wedding_party',
  'wedding_relationships',
  'wedding_tables',
  'wedding_config',
  'wedding_detail_config',
  'wedding_details',
  'wedding_internal_notes',
  'wedding_sequences',
  'wedding_worksheets',
  'wedding_website_settings',
  'contracts',
  'checklist_items',
  'sage_conversations',
  'sage_uncertain_queue',
  'planning_notes',
  'messages',
  'inspo_gallery',
  'photo_library',
  'day_of_media',
  'bar_planning',
  'bar_recipes',
  'bar_shopping_list',
  'bedroom_assignments',
  'borrow_selections',
  'ceremony_chair_plans',
  'ceremony_order',
  'decor_inventory',
  'makeup_schedule',
  'rehearsal_dinner',
  'rsvp_responses',
  'shuttle_schedule',
  'staffing_assignments',
  'vendor_checklist',
  'purchase_recommendations',
  'client_codes',

  // Interactions (parent of drafts) — wipe AFTER drafts
  'interactions',
  'pending_sms_drafts',

  // Per-client lost / re-engagement
  'lost_deals',
  're_engagement_actions',

  // Import history (we'll re-import)
  'crm_import_rows',

  // Cohort + venue intel (user chose to wipe these)
  'venue_intel',
  'venue_intel_jobs',
  'venue_thesis',
  'venue_thesis_jobs',
  'cohort_damping_cache',
  'persona_channel_rollups',
  'intelligence_insights',
  'anomaly_alerts',
  'channel_intel_snapshots',
  'channel_truth_audits',
  'intel_matches',
  'intel_acknowledgments',
  'marketing_recommendations',
  'marketing_digests',
  'event_feedback',
  'annotations',
  'natural_language_queries',
  'trend_recommendations',
  'phrase_usage',
  'paused_period_skipped',

  // Audit-of-deleted-state
  'booked_data_recovery_log',
  'filter_match_log',
  'venue_email_filter_matches',

  // ---- Phase 2: parents ----
  'contacts',
  'people',
  'weddings',
]

// Tables scoped by wedding_id only (no venue_id) — handle separately.
const WEDDING_ONLY_TABLES = ['table_map_layouts']

// Tables where we WIPE rows scoped by wedding_id but PRESERVE venue-scoped rows.
// These are notifications tables where some rows are per-couple and others are venue-wide.
const SCOPED_BY_WEDDING_ID_TABLES = ['admin_notifications', 'notifications']

// Tables we explicitly preserve. Verified by name during the unaccounted-table audit.
const PRESERVE_TABLES = new Set([
  // Identity / org
  'venues', 'organisations', 'user_profiles', 'venue_groups', 'venue_group_members',
  'team_invitations', 'plans', 'pricing_history',

  // Connections + integrations (KEEP)
  'gmail_connections', 'oauth_tokens', 'email_sync_state',
  'calendly_connections', 'openphone_connections', 'zoom_connections',
  'google_ads_connections', 'stripe_events', 'twilio_webhook_log',
  'zoom_webhook_log', 'web_visits', 'website_traffic_history',
  'watermark_sync_state', 'profile_enrichment_runs',
  'processed_sms_messages', 'processed_zoom_meetings',
  'external_calendar_events', 'notification_tokens',
  'multi_channel_inbox_settings',
  'fred_series_sync_state',

  // Voice DNA (KEEP per user choice)
  'voice_preferences', 'voice_dna_derivations', 'voice_dna_jobs',
  'voice_training_sessions', 'voice_training_responses',
  'review_language',

  // Reviews (KEEP)
  'reviews',

  // Venue brand + config
  'venue_config', 'venue_ai_config',
  'venue_email_filters', 'auto_send_rules',
  'brand_assets', 'venue_assets', 'venue_resources',
  'venue_seasonal_content', 'venue_usps',
  'knowledge_base', 'knowledge_captures', 'knowledge_gaps',
  'venue_forbidden_topics', 'venue_vendor_domains',
  'coordinator_absences', 'venue_operational_state',
  'essentials_preferences', 'essentials_action_log',
  'heat_score_config', 'venue_cultural_moment_state',
  'learned_preferences', 'follow_up_sequences', 'follow_up_sequence_templates',
  'rsvp_config', 'accommodations', 'packages',
  'allergy_registry', 'venue_availability', 'booked_dates',
  'venue_health', 'venue_health_history',

  // Operational venue data (KEEP)
  'marketing_spend', 'marketing_spend_records', 'marketing_channels',
  'marketing_agencies', 'venue_agency_engagements', 'campaigns',
  'source_attribution', 'tracked_sources',
  'cultural_moments', 'fred_indicators',
  'weather_data', 'weather_climate_norms',
  'weather_anomaly_events', 'weather_anomaly_monthly_types',
  'search_trends', 'market_intelligence', 'industry_benchmarks',
  'ai_briefings', 'consultant_metrics',

  // Brain dump (operational knowledge)
  'brain_dump_entries', 'brain_dump_pattern_grants',

  // Social + storefront (venue assets)
  'social_metrics_config', 'social_captures', 'social_engagements',
  'social_posts', 'storefront', 'borrow_catalog',

  // Vendor + agency intel
  'vendor_recommendations', 'booked_vendors',
  'agencies', 'agency_documents', 'agency_activity_log',
  'agency_document_downloads', 'tbh_reports',
  'channel_presentation_exports', 'discovery_sources',

  // System / global
  'api_costs', 'rate_limits', 'rate_limit_buckets',
  'cron_runs', 'error_logs', 'metered_events',
  'foundingmember_counter', 'platform_configs',
  'audit_log', 'activity_log',
])

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

// ---- Safety: venue must match expected ----
const { data: venueCheck, error: vErr } = await sb
  .from('venues').select('id, name, org_id, is_demo')
  .eq('id', RIXEY_VENUE_ID).single()
if (vErr || !venueCheck) { console.error(`SAFETY FAIL: venue ${RIXEY_VENUE_ID} not found.`); process.exit(1) }
if (venueCheck.name !== RIXEY_VENUE_NAME) { console.error(`SAFETY FAIL: venue name is "${venueCheck.name}", expected "${RIXEY_VENUE_NAME}".`); process.exit(1) }
if (venueCheck.org_id !== RIXEY_ORG_ID) { console.error(`SAFETY FAIL: org_id mismatch.`); process.exit(1) }
if (venueCheck.is_demo) { console.error(`SAFETY FAIL: venue is_demo=true.`); process.exit(1) }

const { data: orgCheck, error: oErr } = await sb
  .from('organisations').select('id, name').eq('id', RIXEY_ORG_ID).single()
if (oErr || !orgCheck || orgCheck.name !== RIXEY_ORG_NAME) {
  console.error(`SAFETY FAIL: org name mismatch.`); process.exit(1)
}

console.log(`Target: ${venueCheck.name} / ${orgCheck.name}  (venue=${RIXEY_VENUE_ID})`)
console.log(EXECUTE ? '=== EXECUTING WIPE ===\n' : '=== DRY RUN (pass --execute to delete) ===\n')

// ---- Audit: find venue-scoped tables NOT in either list ----
// Best-effort: try a custom RPC, fall back silently if it isn't deployed.
console.log('--- Audit: information_schema vs script lists ---')
let allVenueScoped = null
try {
  const { data } = await sb.rpc('list_venue_scoped_tables')
  allVenueScoped = data
} catch {}
if (!allVenueScoped) {
  console.log('  (skipping audit — list_venue_scoped_tables RPC not available; proceeding with explicit list only)')
} else {
  const seen = new Set([...WIPE_TABLES, ...WEDDING_ONLY_TABLES, ...SCOPED_BY_WEDDING_ID_TABLES, ...PRESERVE_TABLES])
  const unaccounted = allVenueScoped.filter((t) => !seen.has(t.table_name))
  if (unaccounted.length > 0) {
    console.log(`  ⚠ ${unaccounted.length} venue-scoped table(s) not in any list (will NOT be touched):`)
    for (const t of unaccounted) console.log(`     - ${t.table_name}`)
  } else {
    console.log('  ✓ Every venue-scoped table is accounted for.')
  }
}

// ---- Enumerate wedding ids for wedding-only tables ----
const { data: weddingRows } = await sb.from('weddings').select('id').eq('venue_id', RIXEY_VENUE_ID)
const weddingIds = (weddingRows ?? []).map((w) => w.id)
console.log(`\nRixey wedding rows: ${weddingIds.length}`)

// ---- Dry-run: count rows that would be deleted ----
console.log('\n--- Rows that would be deleted ---')
let total = 0
const nonZeroTables = []
for (const t of WIPE_TABLES) {
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('venue_id', RIXEY_VENUE_ID)
  if (error) { console.log(`  ${t.padEnd(38)} (skip: ${error.message.slice(0, 60)})`); continue }
  if ((count ?? 0) > 0) { console.log(`  ${t.padEnd(38)} ${count}`); total += count; nonZeroTables.push({ name: t, count, mode: 'venue' }) }
}
for (const t of WEDDING_ONLY_TABLES) {
  if (weddingIds.length === 0) continue
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).in('wedding_id', weddingIds)
  if (error) { console.log(`  ${t.padEnd(38)} (skip: ${error.message.slice(0, 60)})`); continue }
  if ((count ?? 0) > 0) { console.log(`  ${t.padEnd(38)} ${count}`); total += count; nonZeroTables.push({ name: t, count, mode: 'wedding' }) }
}
for (const t of SCOPED_BY_WEDDING_ID_TABLES) {
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_VENUE_ID).not('wedding_id', 'is', null)
  if (error) { console.log(`  ${t.padEnd(38)} (skip: ${error.message.slice(0, 60)})`); continue }
  if ((count ?? 0) > 0) { console.log(`  ${t.padEnd(38)} ${count} (wedding-scoped only)`); total += count; nonZeroTables.push({ name: t, count, mode: 'wedding_id_scoped' }) }
}
console.log(`\nTotal rows that would be deleted: ${total}`)

if (!EXECUTE) {
  console.log('\nDry run complete. Re-run with --execute to actually delete.')
  console.log('Reminder: pre-tier-8-2026-05-14 git tag + Supabase branch (jvtnfnkgwvvfwixqivwv) are the revert path.')
  process.exit(0)
}

// ---- Execute ----
console.log('\n=== Deleting ===')
for (const t of WIPE_TABLES) {
  const { error, count } = await sb.from(t).delete({ count: 'exact' }).eq('venue_id', RIXEY_VENUE_ID)
  if (error) console.log(`  ${t.padEnd(38)} FAIL: ${error.message}`)
  else if ((count ?? 0) > 0) console.log(`  ${t.padEnd(38)} deleted ${count}`)
}
for (const t of WEDDING_ONLY_TABLES) {
  if (weddingIds.length === 0) continue
  const { error, count } = await sb.from(t).delete({ count: 'exact' }).in('wedding_id', weddingIds)
  if (error) console.log(`  ${t.padEnd(38)} FAIL: ${error.message}`)
  else if ((count ?? 0) > 0) console.log(`  ${t.padEnd(38)} deleted ${count}`)
}
for (const t of SCOPED_BY_WEDDING_ID_TABLES) {
  const { error, count } = await sb.from(t).delete({ count: 'exact' })
    .eq('venue_id', RIXEY_VENUE_ID).not('wedding_id', 'is', null)
  if (error) console.log(`  ${t.padEnd(38)} FAIL: ${error.message}`)
  else if ((count ?? 0) > 0) console.log(`  ${t.padEnd(38)} deleted ${count}`)
}

console.log('\n=== Post-wipe verification ===')
for (const t of nonZeroTables.slice(0, 30)) {
  let q = sb.from(t.name).select('*', { count: 'exact', head: true })
  if (t.mode === 'wedding') q = q.in('wedding_id', weddingIds)
  else if (t.mode === 'wedding_id_scoped') q = q.eq('venue_id', RIXEY_VENUE_ID).not('wedding_id', 'is', null)
  else q = q.eq('venue_id', RIXEY_VENUE_ID)
  const { count } = await q
  console.log(`  ${t.name.padEnd(38)} after: ${count ?? 0}`)
}

console.log('\nDone. Connections, voice DNA, reviews, brand, brain-dump knowledge, and weather data preserved.')
console.log('Re-import client data via CRM import (HoneyBook CSV, Calendly CSV) + Gmail sync to seed Tier 8 layered backtrace.')
