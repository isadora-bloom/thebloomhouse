import { createServiceClient } from '@/lib/supabase/service'
import { asCents, centsToDollars } from '@/lib/types/monetary'
import { NextRequest, NextResponse } from 'next/server'
import { fetchAllVenueTrends } from '@/lib/services/intel/trends'
import { fetchWeatherForecast } from '@/lib/services/intel/weather'
import { fetchAllDefaultFredSeries } from '@/lib/services/external-context/fred-fetch'
import { autoProposeFromTrendSpikes } from '@/lib/services/insights/cultural-moments-auto-propose'
import { autoProposeCulturalMomentsLlmAllVenues } from '@/lib/services/insights/cultural-moments-llm-propose'
import { archiveExpiredCulturalMoments } from '@/lib/services/external-context/cultural-moments'
import { runAllVenueAnomalies } from '@/lib/services/intel/anomaly-detection'
import {
  generateWeeklyBriefing,
  generateMonthlyBriefing,
} from '@/lib/services/intel/briefings'
import { generateWeeklyDigest } from '@/lib/services/intel/weekly-digest'
import { measureInsightOutcomes } from '@/lib/services/intel/insight-tracking'
import { sendAllDigests } from '@/lib/services/intel/daily-digest'
import { processAllVenueFollowUps } from '@/lib/services/email/follow-up-sequences'
import { applyDailyDecay, recalculateHeatScore } from '@/lib/services/heat-mapping'
import { processAllNewEmails, flushPendingAutoSends } from '@/lib/services/email/pipeline'
import { runAllVenueIntelligence } from '@/lib/services/intel/intelligence-engine'
import { createNotification } from '@/lib/services/admin-notifications'
import { learnFiltersForAllVenues } from '@/lib/services/email/inbox-filters'
import { computeAllVenueHealth } from '@/lib/services/intel/venue-health-compute'
import { persistDropoffInsights } from '@/lib/services/intel/quality-signals'
import { refreshAllCensusData } from '@/lib/services/ingestion/census'
import { computeCorrelationsAllVenues } from '@/lib/services/intel/correlation-engine'
import { analyzeWeatherCancellationsAllVenues } from '@/lib/services/insights/weather-cancellation'
import { mineTranscriptVoiceForAllVenues } from '@/lib/services/tour/transcript-voice-learning'
import { findBacktraceCandidates } from '@/lib/services/attribution/source-backtrace'
import { reclusterVenue } from '@/lib/services/identity/candidate-clusterer'
import { resolveVenueCandidates } from '@/lib/services/identity/candidate-resolver'
import { runBacktrackAllVenues } from '@/lib/services/identity/backtrack'
import { syncMeetings as syncZoomMeetings } from '@/lib/services/ingestion/zoom'
import { syncAllVenues as syncOpenPhoneAllVenues } from '@/lib/services/ingestion/openphone'
import { runDataIntegritySweepAllVenues } from '@/lib/services/data-integrity'
import { sweepReEngagementConversions } from '@/lib/services/re-engagement'
import {
  enforceCeilingsAllVenues,
  clearStaleAutonomousPauses,
} from '@/lib/services/cost-ceiling'
import { runEssentialsSuggester } from '@/lib/services/onboarding/essentials-suggester'
import {
  populateUSCalendarEvents,
  populateVirginiaCalendarEvents,
} from '@/lib/services/external-context/calendar-writer'
import { refreshVoiceDnaForAllVenues } from '@/lib/services/brain/voice-dna-extract'
import { logEvent } from '@/lib/observability/logger'
import { computeAttributionParityAllVenues } from '@/lib/services/attribution/parity'
import { mergePeopleAliasesAllVenues } from '@/lib/services/identity/people-merge-aliases'
import {
  runAgencyActivitySweep,
  runTbhReportsMonthly,
  runAgencyDocumentOrphans,
} from '@/lib/services/intel/marketing-agency-cron'
import { classifyTourOutcomesAllVenues } from '@/lib/services/tour/outcome-classifier'
import { recoverBookedDataAllVenues } from '@/lib/services/booked-data-recovery'
import { runTelemetryRetentionPrune } from '@/lib/services/telemetry-retention'
import {
  computeFreshnessReports,
  suggestNextCadence,
} from '@/lib/services/intel/source-freshness'

// ---------------------------------------------------------------------------
// Valid job names
// ---------------------------------------------------------------------------

const VALID_JOBS = [
  'email_poll',
  'heat_decay',
  'trends_refresh',
  'weather_forecast',
  // T5-ε.1 (2026-05-01): renamed from 'economic_indicators' which wrote
  // the legacy economic_indicators table (FRED series id mapped to a
  // friendly name). The correlation engine reads fred_indicators, so the
  // legacy writer left the macro channels permanently empty. The new
  // handler calls fetchAllDefaultFredSeries() against fred_indicators.
  // Old job name kept as alias below so already-deployed Vercel cron
  // entries keep working until vercel.json is fully migrated.
  'fred_daily_refresh',
  'economic_indicators',
  'cultural_moments_auto_propose',
  // TRENDS-DIAGNOSIS Fix 3 / Finding A (2026-05-09). LLM judgement-tier
  // proposer running ALONGSIDE the statistical proposer. Names actual
  // cultural events ("Royal Wedding 2026", "cottagecore Pinterest peak")
  // instead of templated z-score headlines. Inserts as
  // proposed_by='ai_llm' (CHECK constraint extended in migration 250);
  // existing per-venue confirm/dismiss flow handles review.
  'cultural_moments_llm_propose',
  'anomaly_detection',
  'intelligence_analysis',
  'weekly_briefing',
  'weekly_digest',
  'monthly_briefing',
  'daily_digest',
  'follow_up_sequences',
  'attribution_refresh',
  'post_event_feedback_check',
  'outcome_measurement',
  'inbox_filter_learning',
  'venue_health_compute',
  'quality_signals_refresh',
  'census_refresh',
  'transcript_voice_mining',
  'correlation_analysis',
  'backtrace_scan',
  'identity_cascade_sweep',
  'zoom_poll',
  'openphone_poll',
  'sms_rematch',
  // Pattern 9 W2 (mig 318). Voice-channel sequences. Mirrors the email
  // follow_up_sequences runner but at 15-min cadence (SMS expects faster
  // turnaround than email). Drains channel='sms' rows from
  // follow_up_sequences with trigger types sms_no_reply / sms_tour_reminder
  // / sms_post_tour. Lands Haiku-drafted SMS into pending_sms_drafts for
  // coordinator review until the P6 routable send path ships. Not
  // registered in vercel.json (Pro at 40-cron cap); piggybacks on
  // openphone_poll handler below. Operator can curl
  // /api/cron?job=sms_sequences for manual runs.
  'sms_sequences',
  'phase_b_sweep',
  // T5-Rixey-CCC (2026-05-02). Candidate-resolver backtrack — when
  // weddings become known-email, retroactively scan unresolved storefront
  // candidate_identities and link the orphans. BBB spike measured 12.7%
  // of tangential signals connected to active weddings on Rixey; the
  // 1,704-orphan tail (553 of which are The Knot) never gets attribution
  // even when the same person submits the calculator weeks later. Daily
  // sweep runs alongside phase_b_sweep so any new wedding inserts AND
  // any new storefront imports get retried. Stamps backtrack_attempted_at
  // (migration 191) so re-runs paginate past recently-evaluated rows.
  'identity_backtrack',
  'data_integrity_sweep',
  're_engagement_attribution',
  // Cost-ceiling circuit breaker (Playbook OPS-21.4.3). cost_ceiling_check
  // runs hourly to flip autonomous_paused on venues at 100% and notify at
  // 80%. cost_ceiling_reset runs at the UTC day boundary to clear stale
  // pauses (separate jobs so vercel.json can give them different cadences).
  'cost_ceiling_check',
  'cost_ceiling_reset',
  // T5-delta.2 (2026-05-02). Drains weddings.heat_recompute_pending
  // set by the temporal-change trigger (migration 158) when a
  // coordinator corrects inquiry_date / wedding_date / guest_count.
  // Runs every 5 minutes — INV-2.5 derived-state recompute.
  'recompute_pending_temporal',
  // T5-γ.3 (2026-05-02). Essentials slider suggestion engine. Reads
  // essentials_action_log nightly and fires per-user notifications when
  // a coordinator has dismissed 5+ high-density cards on the same
  // surface in the last 30 days.
  'essentials_suggest',
  // T5-followup (2026-05-02). Populates external_calendar_events with
  // US-nationwide federal / religious / cultural / industry events that
  // shift wedding-inquiry behavior. Closes the empty calendar
  // correlation channel flagged by Stream T's cron-coverage audit.
  // Runs daily, idempotent; rolling 365-day window.
  'external_calendar_refresh',
  // T5-followup-X (2026-05-02). Monthly voice-DNA refresh. The Stream-S
  // seed at Day 4 of onboarding is one-shot; without this cron, new
  // outbound emails accumulating over the months never propagate to
  // voice anchors. Runs incrementally over the last 30 days of NEW
  // outbound (since voice_dna_last_refresh_at), inserts new phrases /
  // increments frequencies on existing ones, never deletes seed rows.
  // Per-venue cost-ceiling gating per Stream B; gated venues skip.
  'voice_dna_refresh',
  // T5-followup-W (2026-05-02). Nightly DELETE of pulse_snoozes whose
  // snoozed_until is in the past, plus dismissals older than the
  // 90-day TTL. The aggregator already query-time-filters these, so the
  // cron is a hygiene/audit layer — keeps the table small and stops
  // the audit page from listing zombies. seasoned MED 16.
  'prune_expired_pulse_snoozes',
  // T5-followup-EE (2026-05-02). Nightly telemetry retention prune
  // (#96 / Pattern I regression). 4 telemetry tables had no retention
  // policy — `api_costs` (90d), `cron_runs` (30d), `metered_events`
  // (90d), `lead_score_history` (365d). `phrase_usage` and
  // `interactions` are coordinator-derived signals / forensic record
  // and are NEVER pruned. Coordinator-data tables (weddings,
  // voice_preferences, marketing_spend, pricing_history,
  // cultural_moments) are NEVER pruned by this job — telemetry only.
  // Runs at 02:00 UTC, before the 03:00+ morning crons fire so the
  // pre-burst telemetry is already trimmed.
  'prune_telemetry',
  // PROJECT-AUDIT-V2 BUG-12 (2026-05-05). Daily sweep of the
  // rate_limit_buckets table — drops rows whose updated_at < now() - 7d.
  // Kept as a valid job name for manual invocations / local testing.
  // The Vercel cron now uses prune_maintenance to keep the cron count
  // under the Pro plan limit of 40.
  'prune_rate_limits',
  // Phase 1 audit Fix 2 (2026-05-05). Unified nightly maintenance cron
  // that runs both prune_telemetry AND prune_rate_limits in one tick.
  // Replaces the two separate Vercel cron entries (was 41, now 40).
  // Runs at 02:00 UTC — before the 03:00+ morning crons fire.
  // Phase 6 brain-dump gap (2026-05-05): also runs prune_brain_dump_stale
  // inside runPruneMaintenance. No new Vercel cron entry (count is at 40).
  'prune_maintenance',
  // Phase 6 brain-dump gap (2026-05-05). Marks brain_dump_entries stuck in
  // needs_clarification for >30 days as 'abandoned'. Merged into
  // prune_maintenance so vercel.json stays at 40 (Pro limit). Kept as a
  // valid job name for manual invocations and local testing.
  'prune_brain_dump_stale',
  // T5-Rixey-BBB (2026-05-02). Side-by-side parity scan: writes one
  // attribution_parity_log row per active wedding per run with the
  // legacy 7-tier chain output AND the new identity-cluster compute
  // output. Drives /intel/sources/parity dashboard. Cutover gate:
  // USE_CLUSTER_FIRST_TOUCH flips ON only when dashboard shows
  // >=90% agreement for 7 consecutive days AND CCC has been running
  // for >=48h. Sequenced AFTER backtrace_scan (04:30) and
  // phase_b_sweep (04:45).
  'compute_attribution_parity',
  // T5-Rixey-EEE Bug 1 (2026-05-02). Per-wedding alias collapse for
  // the same human under multiple email addresses (Knot proxy + real
  // Gmail; Knot + WW + real Gmail). Stream KK collapses duplicate
  // weddings; this collapses duplicate people rows within ONE
  // wedding. Conservative gate — auto-merge only when one row holds
  // a real-domain email AND every other row holds a known platform-
  // alias domain (member.theknot.com / notifications.honeybook.com /
  // etc.). Anything ambiguous is logged + skipped for coordinator
  // review. Sequenced AFTER phase_b_sweep (04:45) so KK has already
  // done the wedding-level merge, BEFORE attribution_refresh + the
  // morning lead-source-derivation runs so the canonical-person view
  // is stable when source attribution computes.
  'merge_people_aliases',
  // T5-Rixey-GGG (2026-05-02). Tour outcome classifier. Walks past-due
  // tours with outcome IN ('pending', NULL) and stamps the right
  // terminal outcome (completed / cancelled / no_show) based on
  // evidence (cancellation interactions, no-show notes, otherwise
  // completed). Sequenced AFTER weather (05:00) and correlation
  // (05:00) so the post-cancellation hooks have fresh context. Bias is
  // toward false negatives — when uncertain, leaves 'pending' so the
  // coordinator review surfaces it. Bug 12.
  'tour_outcome_classifier',
  // T5-Rixey-MMM (2026-05-03). Booked-data recovery sweep — for every
  // venue, walks weddings with status booked/completed AND
  // (booking_value IS NULL OR = 0) AND merged_into_id IS NULL, and
  // tries three capabilities in order: HoneyBook duplicate dedup
  // (HIGH-confidence partner-name + date match → merge source into
  // HoneyBook record), calculator-estimate extract (largest dollar
  // amount from latest interactivecalculator.com OR venue-domain
  // estimate email), HoneyBook export-payload recover (extract from
  // the import interaction's extracted_identity blob). Every attempt
  // logs to booked_data_recovery_log. Sequenced 03:00 UTC — BEFORE
  // tour_outcome_classifier (06:00 UTC) so dedup-merged rows aren't
  // re-evaluated by the classifier as standalone weddings. Pure
  // regex extraction; no AI call. Idempotent — orchestrator filter
  // restricts to missing-bv weddings so successful recoveries are
  // not re-attempted on subsequent days.
  'booked_data_recovery',
  // Tier-C #118 follow-up (2026-05-08). Nightly flip of pending /
  // processing consumer_requests rows whose expires_at < now() to
  // status='expired'. Mig 231 documented this as cron-driven but
  // shipped without an actual cron — caught by Round 9 audit. Merged
  // into prune_maintenance to stay under the 40-cron Vercel cap.
  'consumer_requests_expire',
  // D3 (2026-05-08). Daily dunning escalation for past_due venues.
  // Day 8 reminder email; Day 14 second email + banner; Day 21 sage
  // paused; Day 30 read-only. Forward-only state machine on
  // venues.dunning_stage; idempotent re-runs.
  'dunning_escalate',
  // 2026-05-09. Source-freshness AI monitor. Reads tracked_sources for
  // every venue, compares the most-recent marketing_spend upload per
  // source against the row's expected cadence, and fires
  // admin_notifications (type='source_freshness_reminder') when a row
  // crosses cadence. Suppression: 7d since last reminder, 14d since
  // last coordinator dismissal. Stamps last_reminded_at on fire so
  // the next tick is a no-op until either suppression expires or the
  // coordinator uploads (which collapses the gap).
  'source_freshness',
  // Wave 4 Phase 2 (2026-05-09). Identity-reconstruction queue worker.
  // Drains identity_reconstruction_jobs (signal-driven enqueues from
  // pipeline / calendly / contracts + manual_bulk + drift_refresh).
  // Per-tick budget 50 jobs, time-boxed at 280s. Drift enqueue layer
  // adds up to 5 weddings whose last_reconstructed_at is older than
  // 7 days for processing on the next tick. Routed through the
  // dispatcher to stay within Vercel Pro's 40-cron limit; standalone
  // route at /api/cron/identity-judge-sweep also exists for ops curls.
  'identity_judge_sweep',
  // Wave 5A (2026-05-09). Per-couple intel derive worker. Drains
  // couple_intel_jobs (profile_updated / manual_bulk / drift_refresh).
  // Per-tick budget 50 jobs, time-boxed at 280s. Drift enqueue layer
  // adds up to 5 weddings whose last_derived_at is older than 7 days.
  // Routed through the dispatcher to stay under the 40-cron Vercel Pro
  // ceiling.
  'couple_intel_sweep',
  // Wave 5B (2026-05-10). Per-venue cohort rollup synthesizer. Sonnet
  // weekly aggregation across the venue's couples → emerging themes,
  // conversion correlations, voice calibration, service demand,
  // timing patterns. Cost ~$2-5/venue/week. Drains venue_intel_jobs +
  // refreshes 7d-stale drift candidates.
  'cohort_rollup_sweep',
  // Wave 6A (2026-05-10). Marketing spend connector sync. Iterates
  // venues with spend_auto_sync_enabled. Connector stubs for Google
  // Ads / Meta / TikTok; manual + Knot fee paths live. Idempotent on
  // (venue, channel, campaign, date) unique constraint.
  'spend_sync_sweep',
  // Wave 7B (2026-05-10). Forensic channel-role classifier. Reads
  // attribution_role_jobs queue + drift-refreshes events whose
  // role_classified_at < 30d. Forensic rule first; Sonnet judge for
  // ambiguous mixed/unknown cases. Reveals validation-vs-acquisition
  // distortion (~18-19% of Rixey Knot leads forensically reclassify
  // as validation-not-acquisition).
  'attribution_role_sweep',
  // Wave 5C (2026-05-10). External-signal cohort matcher. Scans
  // venues for vendor mentions, regional benchmarks, competitor
  // mentions, cultural-moment cohort fit, cross-platform handle
  // activity. Forensic rules first; Sonnet judge for cohort-fit
  // scoring on cultural moments. Writes intel_matches.
  'external_match_sweep',
  // Wave 6B (2026-05-10). Per-venue persona × channel × revenue
  // rollup recompute. Joins marketing_spend_records + attribution_events
  // (with persona_overlay) + weddings booking_value to produce CAC,
  // conversion%, ROI per (channel, persona, time-window) cell.
  // n_too_small suppression at n<10 enforced at write time.
  'persona_channel_rollup_sweep',
  // Wave 7A (2026-05-10). Pattern discovery engine — Sonnet hypothesis
  // hunter for unknown-unknowns. Free-form output (LLM invents the
  // category). 3 venues per tick, weekly drift refresh. Writes to
  // intel_discoveries.
  'discovery_engine_sweep',
  // Wave 5D (2026-05-10). Per-venue thesis synthesizer + cross-venue
  // overlap detector. Generates the venue's archetype + over-indexed
  // personas + voice principles + service demand gaps. 5 venues per
  // tick. Auto-fires when reconstructed couples cross 25/50/75/100.
  'venue_thesis_sweep',
  // Wave 6C (2026-05-10). Marketing reallocation recommendations
  // analyst. Reads persona_channel_rollups + cohort intel + external
  // signals. 3 venues per tick, weekly. Writes to marketing_recommendations.
  // Refuses when n<10. Never auto-executes.
  'marketing_recommendation_sweep',
  // Wave 7C (2026-05-10). Hypothesis validation — designs + runs +
  // interprets statistical tests on Wave 7A discoveries. 3 validations
  // per tick, 7d drift refresh on in-progress validations.
  'hypothesis_validation_sweep',
  // Wave 6D (2026-05-10). Spend loop flag detector — auto-flags
  // underperforming/overperforming/CAC-exceeds-LTV/persona-drift/
  // channel-anomaly conditions. AUTO-FLAG NEVER AUTO-EXECUTE.
  // 5 venues per tick, daily.
  'spend_loop_flag_sweep',
  // Wave 6D (2026-05-10). Weekly marketing digest builder. 3 venues
  // per tick. Sonnet narrates the week's flags + recommendations +
  // metric changes + concluded A/B tests + validated discoveries.
  'marketing_digest_sweep',
  // Wave 8 (2026-05-10). External signals health sweep — checks all
  // 8 signal sources per venue + auto-derives missing location fields
  // from address. Daily.
  'external_signals_health_sweep',
  // Wave 9 (2026-05-10). Data-integrity remediation sweep. Iterates
  // venues + applies idempotent fixes for each invariant
  // (wedding_has_people / direction_from_venue_own / inquiry_date_drift /
  // touchpoint_source_consistency). Defaults to dry_run unless venue
  // opts in via feature_flags.integrity_auto_remediate. 3 venues/tick.
  'integrity_remediation_sweep',
  // Wave 11 (2026-05-10). Lifecycle state machine sweep. Iterates
  // active (non-terminal) weddings + applies computeLifecycleStage.
  // 50 weddings/tick. Soft-judge queue processed in same call.
  'lifecycle_sweep',
  // Wave 13 (2026-05-11). Tour-prep brief generator. Finds tours
  // scheduled in next 24-48h without a brief, enqueues + processes.
  // 20 tours/tick. Daily cadence.
  'tour_prep_brief_sweep',
  // Wave 13 (2026-05-11). Review solicitation sweep. Couples in
  // post_event stage 7+ days past event without a solicitation get
  // queued. Drafts go to coordinator review (never auto-sent).
  // Daily.
  'review_solicit_sweep',
  // Wave 14 (2026-05-10). Referral extractor sibling-of-reconstruction.
  // Drains referral_extraction_jobs + 30d drift refresh. 10 weddings/tick.
  'referral_extraction_sweep',
  // Wave 14 (2026-05-10). Alumni cohort generator. Reads booked
  // couples + couple_intel + outcomes; Sonnet aggregates archetypes
  // (LLM-invented labels, not enum). 3 venues/tick. Weekly.
  'alumni_cohort_sweep',
  // F22 (2026-05-11). Knowledge-gap category backfill. Mig 298 reset
  // NULL → 'other' for ~447 legacy rows + added NOT NULL + CHECK.
  // This sweep re-categorizes 'other' rows with Haiku so the operator
  // review surface stops being a catch-all bucket. 50 rows/tick,
  // fire-and-forget on per-row errors.
  'knowledge_gap_category_backfill',
  // Wave 27 (2026-05-11). Author-class backfill. Drains the mig-293
  // pending index — inbound interactions whose author_class is still
  // 'unknown'. Outbound rows were synchronously backfilled by migration
  // 293 (operator / sage via drafts.auto_sent linkage); this cron only
  // touches inbound. Per-venue batched at 50 calls in parallel; capped
  // at 500 rows per venue per tick. Idempotent. NOT registered in
  // vercel.json (we're at the 40-cron Pro cap); operator triggers via
  // curl until a shared maintenance cron picks it up. Cost
  // ~$0.0003/email; full Rixey ~12k-row backfill is ~$3.60.
  'author_class_backfill',
  // Pattern 5 (mig 315). Drains interactions with haiku_classified_at
  // IS NULL AND direction='inbound'. Fire-and-forget path covers most
  // rows synchronously; this is the safety net + historical backfill.
  // 50 rows / tick, concurrency=5, 5-min buffer so freshly-inserted rows
  // get a chance via the fire-and-forget path first.
  'inbound_haiku_drain',
  // Wave 6E follow-up (2026-05-12). Agency-tracker maintenance jobs.
  // Each has a standalone /api/cron/{name}/route.ts for ad-hoc curl;
  // the Vercel cron schedule fires through here so the cron-runs
  // logging + verifyCronAuth pattern stays consistent.
  'agency_activity_sweep',
  'tbh_reports_monthly',
  'agency_document_orphans',
  // 2026-05-12 (mig 313). SMS lifecycle fix — rebinds engagement_events
  // whose wedding_id is NULL because the heat-fire raced ahead of the
  // identity-resolver wedding-mint. Walks orphan rows, joins through
  // interactions on metadata.interaction_id (or openphone_message_id
  // fallback), updates wedding_id, then recomputes heat once per
  // affected wedding. Daily — backstop only; openphone.ts ingest fires
  // recordEngagementEvent synchronously with a wedding_id when one is
  // resolved. NOT registered in vercel.json (Pro at 40-cron cap);
  // operator can curl /api/cron?job=orphan_engagement_rebind until a
  // shared maintenance cron picks it up.
  'orphan_engagement_rebind',
  // 2026-05-12 IDENTITY-RESOLUTION-AUDIT F1/F2/F3. Deferred identity
  // binder. Pulls unbound inbound interactions whose extracted_identity
  // has actionable signal (email or phone) and either binds them
  // (tier=high), enqueues for coordinator review (tier=medium), or
  // mints a fresh wedding (no match + primary email/phone). Companion
  // to mintWedding — closes the synchronous-resolver-throw bug class
  // and the "extracted-only identity never binds" gap that the
  // pipeline's inline match chain can't catch. NOT registered in
  // vercel.json (Pro at 40-cron cap); operator can curl
  // /api/cron?job=identity_binder until a shared maintenance cron
  // picks it up.
  'identity_binder',
  // 2026-05-12 (mig 319). Cohort damping cache refresh. Walks active
  // venues, enumerates discrete cohort signatures present in each
  // venue's recent weddings, and UPSERTs one cache row per (venue,
  // signature) so the wedding_heat view (mig 316/319) can apply
  // cohort damping at read time. Reconciles the lead-detail Cool
  // badge with the heat-narration prose (pre-319 the two paths could
  // disagree because damping ran only in TS). Daily cadence is fine;
  // the data updates slowly (a venue's bucket distribution shifts
  // over months, not hours). NOT registered in vercel.json (Pro at
  // 40-cron cap); operator can curl /api/cron?job=cohort_damping_refresh
  // until a shared maintenance cron picks it up.
  'cohort_damping_refresh',
  // 2026-05-12 IDENTITY-RESOLUTION-AUDIT F10. Retroactive duplicate-
  // people merge. The mintWedding chokepoint blocks NEW duplicates;
  // this sweep collapses legacy rows where (wedding_id, role,
  // lower(email)) — or (wedding_id, role, phone) with email-null on
  // both sides — is identical across multiple active people rows.
  // Sister sweep to merge_people_aliases (which handles real-vs-
  // platform-alias email pairings); this one handles same-email-
  // on-both-rows like the Crystal Fuller RM-0480 case. Calls the
  // existing mergePeople service per pair so the audit row + child
  // FK reassignments are uniform with operator-driven merges. NOT
  // registered in vercel.json (Pro at 40-cron cap); operator can
  // curl /api/cron?job=auto_merge_duplicate_partners. Same-name-
  // different-email duplicate class is DEFERRED — needs the AI
  // adjudicator + confidence gate.
  'auto_merge_duplicate_partners',
] as const

type JobName = (typeof VALID_JOBS)[number]

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

async function runJob(job: JobName): Promise<unknown> {
  switch (job) {
    case 'email_poll':
      return pollEmailsAllVenues()

    case 'heat_decay':
      return applyDecayAllVenues()

    case 'trends_refresh':
      return fetchAllVenueTrends()

    case 'weather_forecast':
      return runWeatherForecastWithTourStamp()

    case 'fred_daily_refresh':
    case 'economic_indicators':
      // T5-ε.1 (2026-05-01): writes fred_indicators (the table the
      // correlation engine + ./external-context/fred.ts actually read).
      // Old key 'economic_indicators' kept as alias so the running
      // Vercel cron continues to fire while vercel.json migrates.
      // Sanity-asserts at the end that the writer actually landed rows
      // in the last hour — if zero, logs loudly so a silent FRED
      // outage doesn't drag the macro channels back to null.
      return runFredDailyRefresh()

    case 'cultural_moments_auto_propose':
      // T5-ε.2 (2026-05-01): nightly sweep of every venue with a
      // google_trends_metro set. Without this cron the propose-and-
      // confirm queue stays empty unless an org_admin clicks the
      // manual trigger at /api/intel/cultural-moments/auto-propose.
      // Audit yc-partner.md CRITICAL 3.
      return runCulturalMomentsAutoPropose()

    case 'cultural_moments_llm_propose':
      // TRENDS-DIAGNOSIS Fix 3 / Finding A (2026-05-09). Judgement-tier
      // proposer. Sonnet, ~$0.01/venue/day, 0-3 NAMED proposals per
      // venue per run. Cost-ceiling gated per-venue inside the service.
      return autoProposeCulturalMomentsLlmAllVenues(createServiceClient())

    case 'anomaly_detection':
      return runAllVenueAnomalies()

    case 'intelligence_analysis':
      return runAllVenueIntelligence()

    case 'weekly_briefing':
      return generateBriefingsForAllVenues('weekly')

    case 'weekly_digest':
      return generateDigestsForAllVenues()

    case 'monthly_briefing':
      return generateBriefingsForAllVenues('monthly')

    case 'daily_digest':
      return sendAllDigests()

    case 'follow_up_sequences':
      return processAllVenueFollowUps()

    case 'attribution_refresh':
      return refreshAttributionAllVenues()

    case 'compute_attribution_parity':
      // T5-Rixey-BBB. Side-by-side scan: per-wedding chain + cluster
      // outputs into attribution_parity_log. Read-only against
      // weddings; only writes are to the parity log. Cutover gate
      // is the dashboard at /intel/sources/parity.
      return computeAttributionParityAllVenues(createServiceClient())

    case 'agency_activity_sweep':
      // Wave 6E follow-up. Auto-writes kpi_missed + report_late entries
      // into agency_activity_log so the timeline self-populates.
      return runAgencyActivitySweep()

    case 'tbh_reports_monthly':
      // Wave 6E follow-up. First of each month — generates internal-
      // mode TBH Report for every agency with an active engagement
      // covering the prior calendar month. Idempotent.
      return runTbhReportsMonthly()

    case 'agency_document_orphans':
      // Wave 6E follow-up. Sweeps Supabase Storage for files whose
      // agency_documents row was soft-deleted >30 days ago. Hard
      // removal only past the retention window so accidental deletes
      // are recoverable.
      return runAgencyDocumentOrphans()

    case 'merge_people_aliases':
      // T5-Rixey-EEE Bug 1. Per-wedding alias collapse. Sweeps every
      // venue, buckets each wedding's people rows by normalized name,
      // and folds platform-alias-email rows (member.theknot.com /
      // notifications.honeybook.com / etc.) into the canonical row
      // holding a real-domain address. Conservative gate — never
      // auto-merges when ambiguous (multiple real or multiple alias
      // rows for the same name). Sequenced AFTER phase_b_sweep
      // (04:45) so KK has done the wedding-level merge, BEFORE
      // attribution_refresh so source attribution sees the canonical
      // person view.
      return mergePeopleAliasesAllVenues(createServiceClient())

    case 'post_event_feedback_check':
      return checkPostEventFeedback()

    case 'outcome_measurement':
      return measureOutcomesAllVenues()

    case 'inbox_filter_learning':
      return learnFiltersForAllVenues()

    case 'venue_health_compute':
      return computeAllVenueHealth()

    case 'quality_signals_refresh':
      // Two-email drop-offs per venue. We iterate active venues and
      // fire-and-forget the insights upsert. Keep this cheap — runs
      // weekly, not daily.
      return refreshQualitySignalsAllVenues()

    case 'census_refresh':
      // Monthly pull of Census ACS5 demographics. Rolls county data up
      // to state + national rows in market_intelligence. Never throws —
      // per-state failures are logged inside the service.
      return refreshAllCensusData()

    case 'transcript_voice_mining':
      // Phase 7 Task 64. Mine vocabulary from tour transcripts of couples
      // who booked AND left a 5-star review. Per-venue data-gated — the
      // service returns { dataGated: true } and skips AI entirely for
      // venues with fewer than MIN_ELIGIBLE_TOURS eligible tours. Runs
      // weekly; cheap when gated, modest when not.
      return mineTranscriptVoiceForAllVenues()

    case 'correlation_analysis':
      // Phase 8 Step 6. Pearson correlation with lag search across every
      // pair of channels (inquiries, marketing_metric series, tangential
      // signals per platform). Writes named insights into
      // intelligence_insights where |r| >= 0.6 and both series have >= 20
      // non-zero days. Pure stats — no AI call.
      // T5-followup-AA (2026-05-02): cadence bumped weekly → daily
      // (`0 5 * * *`). Investor-demo question "has the latest Fed move
      // shown up here?" now gets a same-day answer instead of "next
      // Tuesday." Slot chosen so FRED (03:00 UTC) + external_calendar
      // (04:00 UTC) refresh first so upstream channels are fresh.
      // Cost-ceiling gate inside computeCorrelationsAllVenues already
      // filters paused venues — no extra activity gate needed because
      // the engine is sub-cent per venue per run.
      //
      // T5-Rixey-ZZ / Z7 (2026-05-02): also runs the weather × tour
      // cancellation analyzer. Same daily cadence; gates internally on
      // missing weather_data (returns dataGated=true). Pure SQL +
      // bucket-rate compute — no AI call. Writes correlation_narration
      // insights with signal_class='weather_x_venue' when a bad-weather
      // bucket has cancellation_rate >= 1.5x baseline.
      return runCorrelationAndWeatherCancellation()

    case 'zoom_poll':
      // Daily Zoom recording sync per active connection. We poll once a
      // day because Zoom's cloud recording + transcript pipeline can take
      // tens of minutes to materialize after a meeting ends, and there's
      // no webhook fanout in our current Zoom app config — so a slow
      // daily cadence is plenty. The service handles dedup against
      // processed_zoom_meetings, so re-running is idempotent.
      return pollZoomAllVenues()

    case 'openphone_poll': {
      // Every-15-minutes OpenPhone (Quo) sync. Pulls SMS, voicemails,
      // and call summaries for each active connection and dedups
      // through processed_sms_messages before mirroring into
      // interactions. The service already iterates active connections
      // and catches per-venue failures so we just call it.
      //
      // Pattern 9 W2 piggyback (mig 318): also run the SMS sequence
      // runner on the same 15-min tick. SMS sequences and openphone
      // ingest are naturally paired. fresh SMS rows from the poll plus
      // the time-based no-reply / tour-reminder / post-tour triggers all
      // want the same cadence, and the Vercel Pro 40-cron cap forbids a
      // standalone sms_sequences entry today. The standalone case
      // 'sms_sequences' below is still callable via curl for manual runs.
      const pollResult = await syncOpenPhoneAllVenues()
      let smsSequenceResult: Record<string, number> = {}
      try {
        const { processAllVenueSmsSequences } = await import(
          '@/lib/services/sms/sequences'
        )
        smsSequenceResult = await processAllVenueSmsSequences()
      } catch (err) {
        console.error(
          '[cron:openphone_poll] sms sequences run failed (non-fatal):',
          err instanceof Error ? err.message : String(err),
        )
      }
      return { openphone: pollResult, sms_sequences: smsSequenceResult }
    }

    case 'sms_rematch':
      // 2026-05-11: SMS name + event-context matcher (sms-name-match.ts)
      // re-runs over unlinked SMS interactions every venue. Catches the
      // common case where a couple inquired by email then later texts
      // from a new phone — the body says "Hi, this is Sarah" or
      // references their tour time, and we link the SMS to the existing
      // wedding. Idempotent: once linked, the row is skipped on every
      // subsequent sweep. Hourly cadence is plenty.
      const { rematchSmsAllVenues } = await import(
        '@/lib/services/ingestion/sms-rematch-sweep'
      )
      return rematchSmsAllVenues()

    case 'sms_sequences': {
      // Pattern 9 W2 (mig 318). Standalone entry point for the SMS
      // sequence runner. Normally piggybacks on openphone_poll above;
      // this case lets operators curl /api/cron?job=sms_sequences for
      // manual runs (debugging, post-deployment smoke tests).
      const { processAllVenueSmsSequences } = await import(
        '@/lib/services/sms/sequences'
      )
      return processAllVenueSmsSequences()
    }

    case 'backtrace_scan':
      // Daily re-scan of source-backtrace candidates per venue. The
      // initial scan happens on the onboarding Go Live step, but Gmail
      // polling continues to ingest emails for hours/days after that —
      // the high-confidence relay matches we couldn't see at T0 land
      // later. This job re-runs findBacktraceCandidates(useLiveGmail)
      // and notifies the coordinator when new high-confidence
      // candidates exist that they haven't already reviewed. Skips
      // venues without Gmail (no inbox = no point), uses unread
      // admin_notifications as the dedup mechanism (one open notif per
      // venue at a time; coordinator marks read and the next batch
      // creates a fresh one).
      return scanBacktraceAllVenues()

    case 'identity_cascade_sweep': {
      // 2026-05-12: daily venue-wide identity-cascade sweep. The
      // per-wedding cascade (cascade-on-enrichment.ts) fires
      // synchronously when a specific wedding gets new identity
      // signals (SMS body-email match, name-evidence override, brain-
      // dump enrichment). But the inverse case — a NEW anonymous
      // signal arrives (operator confirms a Knot CSV upload, IG
      // screenshot ingest, Pinterest scrape) — needs to re-evaluate
      // every wedding against it. The brain-dump-confirm path fires
      // a synchronous venue-wide sweep when scraper_json lands; this
      // cron is the safety net for missed fires (signals uploaded
      // before the cascade wiring, operator confirmed something
      // offline, etc).
      //
      // Bounded: only weddings updated in the last 365 days, active
      // status only (no lost / cancelled / completed). The underlying
      // backtrack / resolver / first-touch services are idempotent so
      // re-running on a fully-resolved wedding is a no-op.
      const { runIdentityCascadeAllVenues } = await import(
        '@/lib/services/identity/cascade-on-enrichment'
      )
      const supabase = createServiceClient()
      return runIdentityCascadeAllVenues(supabase)
    }

    case 'phase_b_sweep':
      // Phase B safety sweep (PB.8 — 2026-04-28). Daily catch-up that
      // re-clusters any tangential_signals still without a candidate
      // and re-resolves any candidate_identities still without a
      // wedding. Idempotent: signals already attached + candidates
      // already resolved are skipped. Catches edges where the
      // brain-dump-time clusterer/resolver chain failed (timeouts,
      // RLS race, transient service unavailable) and ensures no
      // signal silently sits unattributed. Does NOT call AI for
      // ambiguous cases on the sweep — that already happened at
      // import time; AI is too expensive to retry every night.
      return sweepPhaseBAllVenues()

    case 'identity_backtrack':
      // T5-Rixey-CCC (2026-05-02). Daily backtrack — for each venue,
      // for each wedding with inquiry_date, score every unresolved
      // storefront candidate (Knot/WW/IG/Pinterest/...) on first_name
      // + last_initial + state + ±90/+14d window. High-confidence
      // matches auto-link via attribution_events; medium queue for
      // /intel/identity-backtrack coordinator review; low + no-match
      // get backtrack_attempted_at stamped so the next sweep skips
      // them for REATTEMPT_WINDOW_DAYS (7d). Idempotent — re-running
      // doesn't re-link or duplicate. Pure rule scoring; no LLM.
      return sweepIdentityBacktrackAllVenues()

    case 'data_integrity_sweep':
      // Phase 2 multi-venue rollout (2026-04-30). Runs the 8 data
      // integrity invariants on every venue and persists current
      // violations as 'data_anomaly' rows on intelligence_insights.
      // Self-healing: when an invariant returns clean on a venue
      // that previously had an open anomaly, the row is dismissed
      // with status='self_healed'. Coordinators see live anomaly
      // status on /intel/anomalies without having to re-run any
      // script. Cheap (~5-10s per venue) and idempotent.
      return sweepDataIntegrityAllVenues()

    case 're_engagement_attribution':
      // Phase D Tier 2 / Stage 3 (2026-04-30). Daily — for each
      // sent re_engagement_action whose 60-day window is still
      // open, look for a wedding that arrived within the window
      // whose primary person matches the candidate's first_name
      // + last_initial. Unique match → attribute. Ambiguous
      // (2+) → leave for coordinator. Closed window with no
      // match → counted, no attribution. Idempotent; rerun-safe.
      return sweepReEngagementAttribution()

    case 'cost_ceiling_check':
      // Hourly. Sums today's api_costs per venue, fires 80% notify
      // alert and 100% autonomous-pause + alert. Idempotent within
      // a day via cost_ceiling_warned_at and the autonomous_paused
      // flag itself. Playbook OPS-21.4.3.
      return enforceCeilingsAllVenues()

    case 'cost_ceiling_reset':
      // Hourly (cheap). Clears autonomous_paused for any venue
      // whose paused_at is in a prior UTC day AND whose current
      // spend is back under ceiling. Coordinators who can't wait
      // for the natural reset use POST /api/agent/cost-ceiling/resume.
      return clearStaleAutonomousPauses()

    case 'recompute_pending_temporal':
      // T5-delta.2 (2026-05-02). Every 5 minutes. Drains
      // weddings.heat_recompute_pending — the BEFORE-UPDATE trigger
      // installed by migration 158 stamps it true when a coordinator
      // corrects inquiry_date / wedding_date / guest_count. Heat
      // recompute is multi-table so it can't run inline in the trigger
      // without holding row locks; cron is the deferred path.
      return runRecomputePendingTemporal()
    case 'essentials_suggest':
      // T5-γ.3 (2026-05-02). Daily. Reads essentials_action_log and
      // fires a per-user 'essentials_suggestion' admin_notification
      // when a coordinator has dismissed 5+ high-density cards (level
      // 'expanded' or 'everything') on the same surface in the last
      // 30 days. Idempotent — the 30d suppression window prevents
      // re-firing the same suggestion every day. Closes the loop on
      // the slider learning telemetry that was being written but
      // never read (Pattern A).
      return runEssentialsSuggester(createServiceClient())

    case 'external_calendar_refresh':
      // T5-followup (2026-05-02). Populates external_calendar_events
      // for the next 365 days starting today. Idempotent UPSERT on
      // (geo_scope, title, start_date) so daily re-runs don't
      // duplicate. Stream T's cron-coverage audit (T5-ε.3) found this
      // table has zero writers anywhere — the correlation engine's
      // calendar channel + intel-brain venue context were both
      // permanently empty. populateUSCalendarEvents covers federal
      // holidays, major religious observances (computus + lunar
      // table), Super Bowl, peak-season industry anchors, and the
      // wedding-inquiry-relevant cultural calendar (Valentine's,
      // Mother's Day, etc.). geo_scope='us' only — state-level
      // rollout is a follow-up.
      return runExternalCalendarRefresh()

    case 'voice_dna_refresh':
      // T5-followup-X (2026-05-02). Monthly. For each venue with a
      // prior voice-DNA seed (voice_preferences rows tagged
      // confidence_flag='imported_high'), pulls the last 30 days of
      // NEW outbound emails (since voice_dna_last_refresh_at) and runs
      // the voice-DNA extractor incrementally. INSERTS rows for newly-
      // discovered patterns; INCREMENTS score/frequency on existing
      // matches. Never DELETEs seed rows (one-way ratchet).
      //
      // Per-venue cost-ceiling gate inside the service so paused venues
      // skip without affecting healthy ones. Anti-Sage filter preserved
      // (sampleCoordinatorEmails drops auto_sent drafts).
      return refreshVoiceDnaForAllVenues(createServiceClient())
    case 'prune_expired_pulse_snoozes':
      // T5-followup-W (2026-05-02). Nightly DELETE of pulse_snoozes
      // whose action='snoozed' AND snoozed_until < now(), plus rows
      // whose action='dismissed' AND created_at < now() - 90d. The
      // pulse aggregator already query-time-filters these so the cron
      // is hygiene only — keeps the table small and stops the audit
      // page (/settings/pulse-snoozes) from listing zombies. Idempotent.
      return runPrunePulseSnoozes()

    case 'prune_telemetry':
      // T5-followup-EE (2026-05-02) + Stream PPP (2026-05-03). Nightly
      // retention prune for the 4 telemetry tables that had no policy:
      // api_costs (90d), cron_runs (30d), metered_events (90d),
      // lead_score_history (365d). `phrase_usage` and `interactions`
      // are coordinator-derived signals / forensic record and are
      // NEVER pruned. Migration 203 added the supporting per-table
      // (timestamp) indexes so the DELETEs stay range-scan-cheap.
      // Extracted to src/lib/services/telemetry-retention.ts (#96 /
      // Pattern-I closure) so the prune logic + TTL constants are
      // testable + reusable from a future audit page.
      return runTelemetryRetentionPrune()

    case 'prune_rate_limits':
      // PROJECT-AUDIT-V2 BUG-12 (2026-05-05). Daily sweep of the
      // rate_limit_buckets table (migration 208). Drops rows whose
      // updated_at < now() - 7d. Conservative: every active limiter has
      // windowSec <= 1h, so a 7d retention can never evict a row that's
      // about to be re-checked. Kept for manual/local invocation.
      return runPruneRateLimits()

    case 'prune_maintenance':
      // Phase 1 audit Fix 2 (2026-05-05). Consolidated nightly maintenance
      // cron: runs prune_telemetry + prune_rate_limits in one tick so the
      // Vercel Pro cron count stays at 40 (limit). Phase 6 (2026-05-05)
      // also runs prune_brain_dump_stale in the same tick.
      // Runs 02:00 UTC before the 03:00+ morning crons. All sub-jobs are
      // idempotent — running them together vs separately is equivalent.
      return runPruneMaintenance()

    case 'prune_brain_dump_stale':
      // Phase 6 brain-dump gap (2026-05-05). Mark stale clarifications as
      // 'abandoned' after 30 days. Merged into prune_maintenance for the
      // nightly Vercel cron (cron count is at the 40 Pro-plan limit).
      // This case is kept so the job can be triggered manually via
      // GET /api/cron?job=prune_brain_dump_stale for one-off runs.
      return runPruneBrainDumpStale()

    case 'tour_outcome_classifier':
      // T5-Rixey-GGG (2026-05-02). For each tour with outcome IN
      // ('pending', NULL) AND scheduled_at + duration < now(), walk
      // the evidence and flip to completed / cancelled / no_show.
      // Coordinator notes win first, then engagement_events, then
      // inbound interactions, then post-tour notes. When uncertain,
      // keeps 'pending'. Idempotent — re-running is a no-op for rows
      // already classified. Backfills the existing pending-tour
      // backlog automatically the first time it runs.
      return classifyTourOutcomesAllVenues(createServiceClient())

    case 'dunning_escalate': {
      const { runDunningEscalate } = await import('@/lib/services/billing/dunning')
      return runDunningEscalate()
    }

    case 'consumer_requests_expire':
      // Tier-C #118 follow-up. Flip pending / processing rows whose
      // expires_at < now() to expired. Append-only ledger requires
      // each transition to leave a resolution_notes audit trail.
      return runConsumerRequestsExpire()

    case 'booked_data_recovery':
      // T5-Rixey-MMM (2026-05-03). Booked-data recovery — universal
      // back-fill for missing booking_value across booked / completed
      // weddings on every onboarding venue. Three capabilities run in
      // priority order: HoneyBook duplicate dedup (HIGH confidence →
      // merge), calculator-estimate extract (largest plausible $
      // amount from interactivecalculator.com OR venue-domain
      // estimate emails), HoneyBook export-payload recover (extract
      // from the import interaction's extracted_identity blob).
      // Logs every attempt to booked_data_recovery_log. Pure regex —
      // no AI. Sequenced 03:00 UTC, BEFORE tour_outcome_classifier
      // (06:00) so dedup-merged rows are not re-classified.
      return recoverBookedDataAllVenues()

    case 'source_freshness':
      // 2026-05-09. Daily fan-out across every venue. For each tracked
      // source the cron computes current_gap_days vs expected cadence
      // and, when overdue + suppression windows have expired, inserts
      // an admin_notifications row + stamps last_reminded_at. The
      // page at /intel/sources/track + the banner on /intel/sources
      // both read the same FreshnessReport[] so coordinator state is
      // single-sourced.
      return runSourceFreshnessSweep()

    case 'identity_judge_sweep': {
      // Wave 4 Phase 2. Drains identity_reconstruction_jobs and enqueues
      // weekly drift refresh. Up to 50 jobs per tick, time-boxed at
      // 280s. Standalone route at /api/cron/identity-judge-sweep calls
      // into the same shared runIdentityJudgeSweep service.
      const { runIdentityJudgeSweep } = await import('@/lib/services/identity/judge-sweep')
      return runIdentityJudgeSweep()
    }

    case 'couple_intel_sweep': {
      // Wave 5A. Drains couple_intel_jobs (profile_updated / manual_bulk
      // / drift_refresh) + enqueues 7d-stale drift candidates. Up to 50
      // derives per tick, time-boxed at 280s. Per-couple cost ~$0.02
      // (Sonnet, ~3000 max output tokens).
      const { runCoupleIntelSweep } = await import('@/lib/services/intel/couple-intel-sweep')
      return runCoupleIntelSweep()
    }

    case 'cohort_rollup_sweep': {
      // Wave 5B. Drains venue_intel_jobs + 7d-stale drift refresh. 5
      // venue rollups per tick (cohort rollup is per-venue not per-couple
      // so volume is low). Sonnet aggregation, ~$2-5/venue/week.
      const { runCohortRollupSweep } = await import('@/lib/services/intel/cohort-rollup-sweep')
      return runCohortRollupSweep()
    }

    case 'spend_sync_sweep': {
      // Wave 6A. Iterates venues with spend_auto_sync_enabled, dispatches
      // to configured connector. Stubs for Google Ads / Meta / TikTok;
      // manual + Knot fee paths live. Returns connector status per venue.
      const { runSpendSyncSweep } = await import('@/lib/services/marketing-spend/spend-sync-sweep')
      return runSpendSyncSweep()
    }

    case 'attribution_role_sweep': {
      // Wave 7B. Drains attribution_role_jobs + 30d-stale drift refresh.
      // 50 events per tick. Forensic rule first (acquisition vs
      // validation vs conversion based on pre-inquiry engagement
      // evidence); defers to Sonnet judge for mixed/unknown cases.
      const { runRoleSweep } = await import('@/lib/services/attribution-roles/role-sweep')
      return runRoleSweep()
    }

    case 'external_match_sweep': {
      // Wave 5C. Drains intel_match_jobs + 24h drift refresh per venue.
      // 5 venues per tick (signal scanning is venue-level, low volume).
      // Vendor-mention forensic rule, competitor mention scan,
      // cross-platform handle activity, cultural-moment cohort fit.
      const { runExternalMatchSweep } = await import('@/lib/services/intel/external-match-sweep')
      return runExternalMatchSweep()
    }

    case 'persona_channel_rollup_sweep': {
      // Wave 6B. Recomputes persona_channel_rollups for venues with
      // recent marketing_spend_records. 5 venues per tick. Joins spend
      // + attribution_events.persona_overlay + booking_value to produce
      // CAC/conversion/ROI per (channel, persona, window) cell.
      const { runPersonaChannelRollupSweep } = await import('@/lib/services/intel/persona-channel-rollup/sweep')
      return runPersonaChannelRollupSweep()
    }

    case 'discovery_engine_sweep': {
      // Wave 7A. Pattern discovery engine — Sonnet hypothesis hunter.
      // 3 venues per tick, weekly drift refresh. Writes free-form
      // hypothesis_category discoveries to intel_discoveries.
      const { runDiscoverySweep } = await import('@/lib/services/intel/discovery/sweep')
      return runDiscoverySweep()
    }

    case 'venue_thesis_sweep': {
      // Wave 5D. Venue thesis synthesizer + cross-venue overlap. 5
      // venues per tick, weekly. Auto-fires at reconstruction milestones.
      const { runVenueThesisSweep } = await import('@/lib/services/intel/onboarding/sweep')
      return runVenueThesisSweep()
    }

    case 'marketing_recommendation_sweep': {
      // Wave 6C. Marketing reallocation recommendations analyst.
      // 3 venues per tick, weekly after persona_channel_rollup_sweep.
      // Refuses when n<10. Never auto-executes.
      const { runMarketingRecommendationSweep } = await import('@/lib/services/marketing-spend/recommendations/sweep')
      return runMarketingRecommendationSweep()
    }

    case 'hypothesis_validation_sweep': {
      // Wave 7C. Validates Wave 7A discoveries via Sonnet test
      // designer + executor + interpreter. 3 validations per tick.
      const { runValidationSweep } = await import('@/lib/services/intel/validation/sweep')
      return runValidationSweep()
    }

    case 'spend_loop_flag_sweep': {
      // Wave 6D. Auto-flags spend conditions (CAC>LTV, underperforming,
      // overperforming, persona drift, channel anomaly). 5 venues/tick.
      const { runSpendLoopFlagSweep } = await import('@/lib/services/marketing-spend/loop/flag-sweep')
      return runSpendLoopFlagSweep()
    }

    case 'marketing_digest_sweep': {
      // Wave 6D. Weekly digest builder. 3 venues per tick. Sonnet
      // narrates flags + recommendations + week-over-week metrics.
      const { runMarketingDigestSweep } = await import('@/lib/services/marketing-spend/loop/digest-sweep')
      return runMarketingDigestSweep()
    }

    case 'external_signals_health_sweep': {
      // Wave 8. Health-check + auto-derive for all 8 external signal
      // sources per venue. Daily.
      const { runExternalSignalsHealthSweep } = await import('@/lib/services/external-signals-config/sweep')
      return runExternalSignalsHealthSweep({})
    }

    case 'integrity_remediation_sweep': {
      // Wave 9. Iterates venues + applies idempotent remediation for
      // each data-integrity invariant. Dry-run by default; per-venue
      // opt-in via feature_flags.integrity_auto_remediate. 3 venues/tick.
      const { runIntegrityRemediationSweep } = await import('@/lib/services/data-integrity/remediation/sweep')
      return runIntegrityRemediationSweep()
    }

    case 'lifecycle_sweep': {
      // Wave 11. Iterates active weddings + applies state-machine
      // transitions. 50 weddings/tick + soft-judge queue processed in
      // same call.
      const { runLifecycleSweep } = await import('@/lib/services/lifecycle/sweep')
      return runLifecycleSweep()
    }

    case 'tour_prep_brief_sweep': {
      // Wave 13. Generates briefs for tours scheduled in next 24-48h
      // that don't yet have one. 20 tours/tick. Daily.
      const { runTourPrepBriefSweep } = await import('@/lib/services/tour/prep-brief-sweep')
      return runTourPrepBriefSweep()
    }

    case 'review_solicit_sweep': {
      // Wave 13. Couples in post_event stage 7+ days past event get
      // review solicitations drafted (never auto-sent). Daily.
      const { runReviewSolicitSweep } = await import('@/lib/services/reviews/solicit-sweep')
      return runReviewSolicitSweep()
    }

    case 'referral_extraction_sweep': {
      // Wave 14. Sibling-of-reconstruction referral extractor.
      // Drains referral_extraction_jobs + 30d drift. 10 weddings/tick.
      const { runReferralSweep } = await import('@/lib/services/intel/referrals/sweep')
      return runReferralSweep()
    }

    case 'alumni_cohort_sweep': {
      // Wave 14. Sonnet aggregates booked couples + outcomes into
      // archetypes (LLM-invented labels). 3 venues/tick. Weekly.
      const { runAlumniSweep } = await import('@/lib/services/intel/alumni/sweep')
      return runAlumniSweep()
    }

    case 'knowledge_gap_category_backfill': {
      // F22 (2026-05-11). Haiku re-categorizer for legacy 'other' rows.
      // 50 rows/tick; fire-and-forget per row.
      const { runKnowledgeGapCategoryBackfill } = await import(
        '@/lib/services/knowledge-gaps/category-backfill'
      )
      return runKnowledgeGapCategoryBackfill()
    }

    case 'author_class_backfill': {
      // Wave 27. Drains mig-293 'unknown' inbound rows. Per-venue, 50
      // calls in parallel, capped at 500 rows/venue/tick. Cost
      // ~$0.0003/row. Idempotent.
      const { runAuthorClassBackfill } = await import(
        '@/lib/services/email/author-class-backfill'
      )
      return runAuthorClassBackfill()
    }

    case 'inbound_haiku_drain': {
      // Pattern 5 (mig 315). Drains pending inbound rows whose
      // haiku_classified_at IS NULL. 5-min buffer so the fire-and-forget
      // path attached to the email pipeline gets first pass. 50 rows/tick,
      // concurrency=5 inside the worker. Idempotent.
      const { runInboundHaikuDrain } = await import(
        '@/lib/services/intel/inbound-haiku-drain'
      )
      return runInboundHaikuDrain()
    }

    case 'orphan_engagement_rebind': {
      // 2026-05-12 (mig 313). Daily backstop for SMS heat orphans. Rebinds
      // engagement_events.wedding_id from the matched interaction (via
      // metadata.interaction_id or openphone_message_id fallback). 1000
      // rows/tick — well above steady-state arrival rate. Per-wedding
      // recompute deduped via Set keyed on (venue, wedding) so a 14-event
      // orphan cluster (Justin & Sandy case) recomputes exactly once.
      const { rebindOrphanEngagementEvents } = await import(
        '@/lib/services/sms/orphan-rebind'
      )
      return rebindOrphanEngagementEvents(createServiceClient())
    }

    case 'identity_binder': {
      // 2026-05-12 IDENTITY-RESOLUTION-AUDIT. Drains unbound inbound
      // interactions with extracted_identity, routes each to bind /
      // defer / mint, and fires the cascade per newly-bound wedding.
      // 100 rows/tick. Dynamic import keeps the binder out of the
      // cold-path bundle for ticks that hit other jobs.
      const { runIdentityBinder } = await import(
        '@/lib/services/identity/binder-cron'
      )
      return runIdentityBinder(createServiceClient())
    }

    case 'cohort_damping_refresh': {
      // 2026-05-12 (mig 319). Walks active venues, enumerates discrete
      // cohort signatures present in each venue's recent weddings,
      // UPSERTs one cache row per (venue, signature) so wedding_heat
      // (mig 316/319) applies the same damping multiplier at read time
      // that the heat-narration insight used to compute in TS. Daily
      // cadence; idempotent.
      const { refreshCohortDampingCache } = await import(
        '@/lib/services/intel/cohort-damping-refresh'
      )
      return refreshCohortDampingCache(createServiceClient())
    }

    case 'auto_merge_duplicate_partners': {
      // 2026-05-12 IDENTITY-RESOLUTION-AUDIT F10. Retroactive sweep
      // of duplicate `people` rows where (wedding_id, role, email)
      // or (wedding_id, role, phone with email-null) collides on
      // multiple active rows. Calls mergePeople per pair so the
      // audit row + FK reassignment + tombstone path is shared with
      // operator merges. Same-name-different-email class is deferred
      // pending the AI adjudicator. Dynamic import keeps the sweep
      // out of the cold-path bundle for ticks hitting other jobs.
      const { autoMergeDuplicatePartners } = await import(
        '@/lib/services/identity/auto-merge-duplicates'
      )
      return autoMergeDuplicatePartners(createServiceClient())
    }
  }
}

/**
 * T5-followup-W (2026-05-02). Nightly DELETE of expired pulse_snoozes.
 * Mirrors the aggregator's filter so the row store + the read path
 * agree on what's "live". Returns counts so cron telemetry surfaces
 * any unexpected churn (e.g. a sudden 10x in expired-dismiss rows is
 * a useful signal that someone's mass-dismissing).
 */
async function runPrunePulseSnoozes(): Promise<{
  expired_snoozes_deleted: number
  expired_dismisses_deleted: number
}> {
  const supabase = createServiceClient()
  const nowIso = new Date().toISOString()
  const ninetyDaysAgoIso = new Date(Date.now() - 90 * 86_400_000).toISOString()

  // Expired snoozes — snoozed_until is in the past.
  const { data: snoozeDel, error: snoozeErr } = await supabase
    .from('pulse_snoozes')
    .delete()
    .eq('action', 'snoozed')
    .lt('snoozed_until', nowIso)
    .select('id')

  // Expired dismissals — created_at older than the 90-day TTL.
  const { data: dismissDel, error: dismissErr } = await supabase
    .from('pulse_snoozes')
    .delete()
    .eq('action', 'dismissed')
    .lt('created_at', ninetyDaysAgoIso)
    .select('id')

  if (snoozeErr) console.error('[prune_expired_pulse_snoozes] snooze delete failed:', snoozeErr.message)
  if (dismissErr) console.error('[prune_expired_pulse_snoozes] dismiss delete failed:', dismissErr.message)

  return {
    expired_snoozes_deleted: (snoozeDel ?? []).length,
    expired_dismisses_deleted: (dismissDel ?? []).length,
  }
}

// PROJECT-AUDIT-V2 BUG-12 (2026-05-05). Rate-limit bucket sweep — calls
// the SQL helper public.prune_rate_limit_buckets() which DELETEs rows
// whose updated_at < now() - 7 days. The active limiters have
// windowSec <= 1h so a 7d retention is a comfortable safety margin.
async function runPruneRateLimits(): Promise<{ rows_deleted: number }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('prune_rate_limit_buckets')
  if (error) {
    console.error('[prune_rate_limits] RPC failed:', error.message)
    return { rows_deleted: 0 }
  }
  return { rows_deleted: Number(data ?? 0) }
}

/**
 * Phase 1 audit Fix 2 (2026-05-05). Combined nightly maintenance cron.
 * Runs prune_telemetry + prune_rate_limits in a single tick so we stay
 * within the Vercel Pro cron limit of 40.
 *
 * Phase 6 brain-dump gap (2026-05-05): also runs prune_brain_dump_stale
 * in the same tick so stale clarifications are cleaned up without
 * needing a separate Vercel cron entry.
 *
 * Each sub-job is independently error-handled so one failure doesn't
 * suppress the others.
 */
async function runPruneMaintenance(): Promise<{
  telemetry: Awaited<ReturnType<typeof runTelemetryRetentionPrune>>
  rate_limits: { rows_deleted: number }
  brain_dump_stale: { rows_abandoned: number }
  audit: { activity_log_deleted: number; errors: string[] }
  bulk_read_anomaly: { users_flagged: number; notifications_created: number; errors: string[] }
  consumer_requests_expired: { rows_expired: number; errors: string[] }
  dunning: { reminder_1_fired: number; reminder_2_fired: number; sage_paused_fired: number; read_only_fired: number; errors: string[] }
  source_freshness: Awaited<ReturnType<typeof runSourceFreshnessSweep>>
}> {
  const { runAuditRetentionPrune } = await import('@/lib/services/audit-retention')
  const { detectBulkReadAnomalies } = await import('@/lib/services/bulk-read-anomaly')
  const { runDunningEscalate } = await import('@/lib/services/billing/dunning')
  const [telemetry, rate_limits, brain_dump_stale, audit, bulkRead, expired, dunning, sourceFreshness] = await Promise.allSettled([
    runTelemetryRetentionPrune(),
    runPruneRateLimits(),
    runPruneBrainDumpStale(),
    runAuditRetentionPrune(),
    detectBulkReadAnomalies(),
    runConsumerRequestsExpire(),
    runDunningEscalate(),
    // Folded in 2026-05-09 to keep the cron count under Vercel Pro's
    // 40-cron limit. The source-freshness sweep ran as its own
    // 'source_freshness' cron entry; collapsing it into prune_maintenance
    // costs us nothing (both run daily, both are venue-fanout reads with
    // a small admin_notifications write surface). The standalone
    // 'source_freshness' job string is still accepted for ad-hoc runs.
    runSourceFreshnessSweep(),
  ])

  const telemetryResult =
    telemetry.status === 'fulfilled'
      ? telemetry.value
      : (() => {
          console.error('[prune_maintenance] telemetry prune failed:', telemetry.reason)
          return {
            api_costs_deleted: 0,
            cron_runs_deleted: 0,
            metered_events_deleted: 0,
            lead_score_history_deleted: 0,
            errors: [String(telemetry.reason)],
          }
        })()

  const rateLimitsResult =
    rate_limits.status === 'fulfilled'
      ? rate_limits.value
      : (() => {
          console.error('[prune_maintenance] rate_limits prune failed:', rate_limits.reason)
          return { rows_deleted: 0 }
        })()

  const brainDumpStaleResult =
    brain_dump_stale.status === 'fulfilled'
      ? brain_dump_stale.value
      : (() => {
          console.error('[prune_maintenance] brain_dump_stale prune failed:', brain_dump_stale.reason)
          return { rows_abandoned: 0 }
        })()

  const auditResult =
    audit.status === 'fulfilled'
      ? audit.value
      : (() => {
          console.error('[prune_maintenance] audit prune failed:', audit.reason)
          return { activity_log_deleted: 0, errors: [String(audit.reason)] }
        })()

  const bulkReadResult =
    bulkRead.status === 'fulfilled'
      ? bulkRead.value
      : (() => {
          console.error('[prune_maintenance] bulk-read anomaly detect failed:', bulkRead.reason)
          return { users_flagged: 0, notifications_created: 0, errors: [String(bulkRead.reason)] }
        })()

  const expiredResult =
    expired.status === 'fulfilled'
      ? expired.value
      : (() => {
          console.error('[prune_maintenance] consumer_requests expire failed:', expired.reason)
          return { rows_expired: 0, errors: [String(expired.reason)] }
        })()

  const dunningResult =
    dunning.status === 'fulfilled'
      ? {
          reminder_1_fired: dunning.value.reminder_1_fired,
          reminder_2_fired: dunning.value.reminder_2_fired,
          sage_paused_fired: dunning.value.sage_paused_fired,
          read_only_fired: dunning.value.read_only_fired,
          errors: dunning.value.errors,
        }
      : (() => {
          console.error('[prune_maintenance] dunning escalate failed:', dunning.reason)
          return { reminder_1_fired: 0, reminder_2_fired: 0, sage_paused_fired: 0, read_only_fired: 0, errors: [String(dunning.reason)] }
        })()

  const sourceFreshnessResult =
    sourceFreshness.status === 'fulfilled'
      ? sourceFreshness.value
      : (() => {
          console.error('[prune_maintenance] source freshness sweep failed:', sourceFreshness.reason)
          return { venues_scanned: 0, reminders_fired: 0, errors: 1 }
        })()

  return {
    telemetry: telemetryResult,
    rate_limits: rateLimitsResult,
    brain_dump_stale: brainDumpStaleResult,
    audit: auditResult,
    bulk_read_anomaly: bulkReadResult,
    consumer_requests_expired: expiredResult,
    dunning: dunningResult,
    source_freshness: sourceFreshnessResult,
  }
}

/**
 * Tier-D #164 (2026-05-08). Wraps the weather_forecast cron handler
 * with a per-tour weather-snapshot stamp pass. Same cron entry, two
 * sub-jobs: (a) refresh forecasts for every venue (existing), then
 * (b) stamp upcoming + recently-completed tours from the freshly-
 * refreshed weather_data table. Zero added API cost — pure DB join.
 */
async function runWeatherForecastWithTourStamp() {
  const forecastResult = await fetchWeatherForAllVenues()
  let tourStamp: { tours_stamped: number; errors: string[] } = { tours_stamped: 0, errors: [] }
  try {
    const { stampTourWeather } = await import('@/lib/services/intel/tour-weather')
    tourStamp = await stampTourWeather(createServiceClient())
  } catch (err) {
    console.error('[weather_forecast] tour stamp failed:', err)
    tourStamp.errors.push(err instanceof Error ? err.message : String(err))
  }
  return { forecast: forecastResult, tour_stamp: tourStamp }
}

/**
 * Tier-C #118 follow-up (2026-05-08). Nightly sweep of consumer_requests
 * rows past their expires_at. Mig 231 sets expires_at = created_at + 45d
 * by default, and the page renders an "overdue" badge — but the row
 * never moves to status='expired' without this sweeper. Append-only
 * ledger: leaves a resolution_notes line so the audit trail is intact.
 */
async function runConsumerRequestsExpire(): Promise<{
  rows_expired: number
  errors: string[]
}> {
  const supabase = createServiceClient()
  const errors: string[] = []
  const nowIso = new Date().toISOString()

  const { data: stale, error } = await supabase
    .from('consumer_requests')
    .select('id, resolution_notes')
    .in('status', ['pending', 'processing'])
    .lt('expires_at', nowIso)
    .limit(500)
  if (error) {
    errors.push(`select: ${error.message}`)
    return { rows_expired: 0, errors }
  }

  let updated = 0
  for (const r of (stale ?? []) as Array<{ id: string; resolution_notes: string | null }>) {
    const note = `Auto-expired at ${nowIso} (45-day SLA elapsed without resolution)`
    const merged = r.resolution_notes ? `${r.resolution_notes}\n${note}` : note
    const { error: upErr } = await supabase
      .from('consumer_requests')
      .update({ status: 'expired', resolution_notes: merged })
      .eq('id', r.id)
    if (upErr) {
      errors.push(`update ${r.id}: ${upErr.message}`)
      continue
    }
    updated += 1
  }
  console.log(`[consumer_requests_expire] rows_expired=${updated}` + (errors.length ? ` errors=${errors.length}` : ''))
  return { rows_expired: updated, errors }
}

/**
 * 2026-05-09. Source-freshness sweep. Daily fan-out across every venue
 * (active rows in venues; we filter on plan_tier IS NOT NULL to skip
 * tombstoned / pre-onboarding venues). For each venue we compute the
 * full FreshnessReport[] then fire admin_notifications for any row
 * with `reminder_due === true`. After a successful insert we stamp
 * tracked_sources.last_reminded_at so the next tick is a no-op until
 * the suppression window expires.
 *
 * Returns a small rollup — venues scanned, reminders fired, errors —
 * for cron telemetry. Failures on a single venue are logged + counted
 * but never abort the sweep.
 */
async function runSourceFreshnessSweep(): Promise<{
  venues_scanned: number
  reminders_fired: number
  errors: number
}> {
  const supabase = createServiceClient()

  const { data: venues, error: venuesErr } = await supabase
    .from('venues')
    .select('id, name')
    .not('plan_tier', 'is', null)

  if (venuesErr) {
    console.error('[source_freshness] venues lookup failed:', venuesErr)
    return { venues_scanned: 0, reminders_fired: 0, errors: 1 }
  }

  const venueRows = (venues ?? []) as Array<{ id: string; name: string | null }>
  let venuesScanned = 0
  let remindersFired = 0
  let errors = 0
  const nowIso = new Date().toISOString()

  for (const venue of venueRows) {
    try {
      const reports = await computeFreshnessReports(venue.id)
      venuesScanned += 1

      const due = reports.filter((r) => r.reminder_due)
      for (const r of due) {
        const monthKey = nowIso.slice(0, 7)
        // Direct insert (bypassing createNotification's 5-minute
        // dedup on (venue_id, type)). Suppression here is owned by
        // tracked_sources.last_reminded_at (7d) + last_dismissed_at
        // (14d), which run per-source. If we fanned through
        // createNotification, a venue with multiple overdue sources
        // would only fire ONE reminder per cron tick — every source
        // after the first would collide on the 5-minute dedup key.
        const { error: insertErr } = await supabase.from('admin_notifications').insert({
          venue_id: r.venueId,
          type: 'source_freshness_reminder',
          title: `Time to upload ${r.source_label} for ${monthKey}`,
          body: JSON.stringify({
            source_key: r.source_key,
            source_label: r.source_label,
            last_upload_at: r.last_upload_at,
            current_gap_days: r.current_gap_days,
            expected_cadence_days: r.expected_cadence_days,
            status: r.status,
            suggested_next_cadence: suggestNextCadence(r),
          }),
          priority: 'normal',
        })
        if (insertErr) {
          console.error(
            `[source_freshness] notification insert failed for ${r.venueId}/${r.source_key}:`,
            insertErr,
          )
          errors += 1
          continue
        }

        // Stamp last_reminded_at so suppression kicks in. We update
        // by composite key (venue_id, source_key) — the unique
        // constraint guarantees one row.
        const { error: stampErr } = await supabase
          .from('tracked_sources')
          .update({ last_reminded_at: nowIso })
          .eq('venue_id', r.venueId)
          .eq('source_key', r.source_key)
        if (stampErr) {
          console.error(
            `[source_freshness] stamp failed for ${r.venueId}/${r.source_key}:`,
            stampErr,
          )
          errors += 1
          continue
        }
        remindersFired += 1
      }
    } catch (err) {
      errors += 1
      console.error(`[source_freshness] venue ${venue.id} failed:`, err)
    }
  }

  console.log(
    `[source_freshness] venues_scanned=${venuesScanned} reminders_fired=${remindersFired} errors=${errors}`,
  )
  return {
    venues_scanned: venuesScanned,
    reminders_fired: remindersFired,
    errors,
  }
}

/**
 * Phase 6 brain-dump gap (2026-05-05). Marks brain_dump_entries entries
 * stuck in needs_clarification for > 30 days as 'abandoned'.
 *
 * Rationale: clarification entries that go unanswered for 30 days are
 * permanently orphaned — the coordinator has moved on or the context is
 * stale. Leaving them as needs_clarification inflates the clarification
 * queue and blocks any aggregate metrics that count pending entries.
 * 'abandoned' keeps the row for audit purposes without cluttering the
 * live queue.
 *
 * Uses brain_dump_entries_cleanup_idx (migration 213) so the scan is
 * cheap even at large table sizes.
 */
async function runPruneBrainDumpStale(): Promise<{ rows_abandoned: number }> {
  const adminClient = createServiceClient()
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const now = new Date().toISOString()
  const { data, error } = await adminClient
    .from('brain_dump_entries')
    .update({ parse_status: 'abandoned', updated_at: now })
    .eq('parse_status', 'needs_clarification')
    .lt('created_at', cutoff)
    .select('id')
  if (error) {
    console.error('[prune_brain_dump_stale] update failed:', error.message)
    return { rows_abandoned: 0 }
  }
  return { rows_abandoned: (data ?? []).length }
}

// Stream PPP (2026-05-03): the inline runPruneTelemetry helper that used
// to live here was extracted to src/lib/services/telemetry-retention.ts —
// see runTelemetryRetentionPrune. Closes #96 (Pattern-I retention
// regression). The 'prune_telemetry' job handler above now calls the
// service directly. Migration 203 adds the supporting per-table
// (timestamp) indexes so the DELETE range-scans stay cheap.

/**
 * T5-followup. Daily writer for external_calendar_events covering the
 * next 365 days. Stream T's audit flagged this table as having zero
 * writers; without the cron, the correlation engine's calendar channel
 * never surfaces patterns like "Mother's Day → +14d inquiry lift" or
 * "Memorial Day weekend → tour spike". Idempotent — repeated runs
 * upsert onto (geo_scope, title, start_date).
 */
async function runExternalCalendarRefresh(): Promise<{
  rows_total: number
  rows_inserted: number
  rows_updated: number
  rows_failed: number
  by_category: Record<string, number>
  warnings: string[]
}> {
  const supabase = createServiceClient()
  const today = new Date()
  // Anchor at UTC midnight so re-runs within the same day produce
  // identical windows.
  const start = new Date(Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  ))
  const end = new Date(start)
  end.setUTCDate(start.getUTCDate() + 365)

  const usResult = await populateUSCalendarEvents(supabase, {
    startDate: start,
    endDate: end,
  })

  // T5-Rixey-ZZ / Z8 — Virginia-region calendar (university graduations,
  // regional festivals, Greater Northern Virginia bridal shows). The
  // calendar reader's hierarchical geo_scope expansion picks these up
  // automatically for any VA venue. Idempotent UPSERT mirrors the US
  // writer; failures here don't block the US result.
  let vaResult: Awaited<ReturnType<typeof populateVirginiaCalendarEvents>> | null = null
  try {
    vaResult = await populateVirginiaCalendarEvents(supabase, {
      startDate: start,
      endDate: end,
    })
  } catch (err) {
    logEvent({
      level: 'error',
      msg: 'va-calendar-refresh.failed',
      event_type: 'external_calendar_refresh',
      outcome: 'fail',
      data: { error: err instanceof Error ? err.message : String(err) },
    })
  }

  // Combine results — caller cares about the rolled-up counts.
  const merged = {
    rows_total: usResult.rows_total + (vaResult?.rows_total ?? 0),
    rows_inserted: usResult.rows_inserted + (vaResult?.rows_inserted ?? 0),
    rows_updated: usResult.rows_updated + (vaResult?.rows_updated ?? 0),
    rows_failed: usResult.rows_failed + (vaResult?.rows_failed ?? 0),
    by_category: { ...usResult.by_category } as Record<string, number>,
    warnings: [...usResult.warnings, ...((vaResult?.warnings) ?? [])],
  }
  if (vaResult) {
    for (const [k, v] of Object.entries(vaResult.by_category)) {
      merged.by_category[k] = (merged.by_category[k] ?? 0) + (v as number)
    }
  }

  logEvent({
    level: merged.rows_failed > 0 ? 'error' : 'info',
    msg: 'external-calendar-refresh.complete',
    event_type: 'external_calendar_refresh',
    outcome: merged.rows_failed > 0 ? 'fail' : 'ok',
    data: {
      rows_total: merged.rows_total,
      rows_inserted: merged.rows_inserted,
      rows_updated: merged.rows_updated,
      rows_failed: merged.rows_failed,
      by_category: merged.by_category,
      warnings: merged.warnings,
      us_rows: usResult.rows_total,
      va_rows: vaResult?.rows_total ?? 0,
      window_start: start.toISOString().slice(0, 10),
      window_end: end.toISOString().slice(0, 10),
    },
  })

  return merged
}

/**
 * Daily re-scan for source-backtrace candidates. For each venue with a
 * live Gmail connection, walks weddings whose first-touch is a
 * scheduling tool and asks the source-backtrace service whether any
 * high-confidence relay matches now exist. Only emits a notification
 * when there's at least one open candidate AND the coordinator has
 * already cleared (read) the previous notification — so we don't keep
 * pushing the same alert at someone who's actively triaging.
 *
 * Returns per-venue stats so the cron log shows what changed.
 */
/**
 * Phase B safety sweep across every venue. Re-attaches any orphaned
 * signals (clusterer) and re-resolves any unmatched candidates
 * (resolver). Returns per-venue counts. AI adjudicator is NOT
 * triggered here — ambiguous cases stay queued for coordinator.
 */
async function sweepPhaseBAllVenues(): Promise<
  Record<string, {
    signals_processed: number
    new_clusters: number
    candidates_resolved: number
    deferred: number
    conflicts: number
    errors: number
  }>
> {
  const supabase = createServiceClient()
  const { data: venues } = await supabase
    .from('venues')
    .select('id, name')
    .is('archived_at', null)
  const out: Record<string, {
    signals_processed: number
    new_clusters: number
    candidates_resolved: number
    deferred: number
    conflicts: number
    errors: number
  }> = {}

  for (const v of ((venues ?? []) as Array<{ id: string; name: string }>)) {
    try {
      const cluster = await reclusterVenue({ supabase, venueId: v.id })
      const resolve = await resolveVenueCandidates({ supabase, venueId: v.id, skipAI: true })
      out[v.name] = {
        signals_processed: cluster.signals_processed,
        new_clusters: cluster.signals_creating_new_cluster,
        candidates_resolved:
          resolve.resolved_tier_1_exact +
          resolve.resolved_tier_1_name_window +
          resolve.resolved_tier_1_full_name +
          resolve.resolved_tier_2_ai +
          resolve.resolved_tier_2_wide_ai,
        deferred: resolve.deferred_to_ai,
        conflicts: resolve.conflicts_flagged,
        errors: cluster.errors.length + resolve.errors.length,
      }
    } catch (err) {
      out[v.name] = {
        signals_processed: 0,
        new_clusters: 0,
        candidates_resolved: 0,
        deferred: 0,
        conflicts: 0,
        errors: 1,
      }
      console.error(`[phase_b_sweep] ${v.name}:`, err instanceof Error ? err.message : err)
    }
  }

  return out
}

/**
 * T5-Rixey-CCC identity-backtrack sweep wrapper. Per-venue runner
 * lives in the identity-backtrack service; this wraps it so the cron
 * switch stays consistent. Returns per-venue summary keyed by venue
 * name for log readability.
 */
async function sweepIdentityBacktrackAllVenues() {
  const supabase = createServiceClient()
  return runBacktrackAllVenues(supabase)
}

/**
 * Daily data-integrity sweep wrapper. Runs the 8 invariants on
 * every venue, persists violations as data_anomaly insights, and
 * self-heals previously-open anomalies that now pass. Thin wrapper
 * over runDataIntegritySweepAllVenues — exists so the cron switch
 * stays consistent with the other named jobs.
 */
async function sweepDataIntegrityAllVenues() {
  const supabase = createServiceClient()
  return runDataIntegritySweepAllVenues(supabase)
}

async function sweepReEngagementAttribution() {
  const supabase = createServiceClient()
  return sweepReEngagementConversions(supabase)
}

/**
 * T5-delta.2 (2026-05-02). Drains weddings.heat_recompute_pending.
 *
 * The BEFORE-UPDATE trigger from migration 158 stamps the flag true
 * when inquiry_date / wedding_date / guest_count change. The AFTER
 * trigger nulls T3 cache signatures + stamps stale_since on journey
 * narratives + tour briefs in the same transaction. This cron does
 * the load-bearing heat-score recompute that has to be deferred —
 * recalculateHeatScore reads engagement_events + candidate_identities
 * + attribution_events, which is too expensive to run inline.
 *
 * Caps at 100 weddings per tick so a bulk back-fill correction (a
 * coordinator running an import-fix script that touches thousands of
 * rows) doesn't blow the function timeout. The next 5-min tick picks
 * up the rest.
 *
 * Per-wedding errors are logged + the flag is left true so the next
 * tick retries. Permanent failures will surface in cron_runs telemetry.
 */
async function runRecomputePendingTemporal(): Promise<{
  scanned: number
  recomputed: number
  failed: number
  remaining_estimate: number
}> {
  const supabase = createServiceClient()

  const { data: pending } = await supabase
    .from('weddings')
    .select('id, venue_id')
    .eq('heat_recompute_pending', true)
    .limit(100)

  const list = ((pending ?? []) as Array<{ id: string; venue_id: string }>)
  if (list.length === 0) {
    return { scanned: 0, recomputed: 0, failed: 0, remaining_estimate: 0 }
  }

  let recomputed = 0
  let failed = 0

  for (const w of list) {
    try {
      await recalculateHeatScore(w.venue_id, w.id)
      const { error } = await supabase
        .from('weddings')
        .update({ heat_recompute_pending: false })
        .eq('id', w.id)
        .eq('heat_recompute_pending', true)
      if (error) {
        console.error(`[recompute_pending_temporal] flag clear failed for ${w.id}:`, error.message)
        failed++
        continue
      }
      recomputed++
    } catch (err) {
      console.error(`[recompute_pending_temporal] recompute failed for ${w.id}:`, err)
      failed++
    }
  }

  // Cheap remaining-estimate so the cron telemetry shows pressure.
  // head:true skips the row payload — count-only.
  const { count: remaining } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('heat_recompute_pending', true)

  return {
    scanned: list.length,
    recomputed,
    failed,
    remaining_estimate: remaining ?? 0,
  }
}

/**
 * T5-ε.1 (2026-05-01). Daily FRED refresh writing fred_indicators
 * (the table read by correlation-engine.ts and external-context/fred.ts).
 *
 * Pre-fix the cron called fetchAllEconomicIndicators which writes the
 * legacy economic_indicators table — the correlation engine never
 * looked at that table, so the macro channels (CPI, mortgage rate,
 * S&P 500, unemployment, consumer sentiment) sat permanently empty
 * after onboarding's one-shot backfill.
 *
 * Sanity assertion: after the writer returns, count fred_indicators
 * rows whose fetched_at is in the last hour. If the writer claims
 * success but no rows landed (FRED outage, network blip, RLS quirk),
 * we log loudly so the failure doesn't go silent.
 */
async function runFredDailyRefresh(): Promise<{
  series: Array<{ series_id: string; observations_returned: number; rows_upserted: number; error?: string }>
  totalRowsUpserted: number
  rowsLandedLastHour: number | null
  freshnessOk: boolean
}> {
  const results = await fetchAllDefaultFredSeries()
  const totalRowsUpserted = results.reduce((sum, r) => sum + r.rows_upserted, 0)

  const supabase = createServiceClient()
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count, error: countError } = await supabase
    .from('fred_indicators')
    .select('id', { count: 'exact', head: true })
    .gte('fetched_at', oneHourAgo)

  let rowsLandedLastHour: number | null = null
  if (countError) {
    console.error('[cron][fred_daily_refresh] sanity count failed:', countError.message)
  } else {
    rowsLandedLastHour = count ?? 0
  }

  const freshnessOk = rowsLandedLastHour !== null && rowsLandedLastHour > 0
  if (!freshnessOk) {
    console.error(
      `[cron][fred_daily_refresh] FRESHNESS ALERT — fetchAllDefaultFredSeries reported ${totalRowsUpserted} rows ` +
      `upserted across ${results.length} series, but fred_indicators has ${rowsLandedLastHour ?? 'unknown'} ` +
      `rows fetched in the last hour. ` +
      `Per-series detail: ${JSON.stringify(results)}. ` +
      `Likely causes: missing FRED_API_KEY, FRED outage, RLS blocking service-role write, network egress.`,
    )
  }

  return {
    series: results,
    totalRowsUpserted,
    rowsLandedLastHour,
    freshnessOk,
  }
}

/**
 * T5-ε.2 (2026-05-01). Nightly cultural-moments auto-propose sweep.
 *
 * Runs autoProposeFromTrendSpikes against every venue with a
 * google_trends_metro configured. Pre-fix the propose-and-confirm
 * queue stayed empty unless an org_admin clicked the manual trigger
 * at POST /api/intel/cultural-moments/auto-propose. Audit
 * yc-partner.md CRITICAL 3.
 *
 * Per-venue dedup is handled inside the service (fingerprint on
 * (term, weekStart) across all venues) — calling repeatedly is safe.
 *
 * TRENDS-DIAGNOSIS Fix 1 (2026-05-09): also runs the daily
 * archive-expired sweep as a sub-step. Folded in here (not a new
 * Vercel cron entry) because we're at the 40-cron Pro plan limit
 * and the work is logically contiguous with proposing — both
 * keep the queue clean.
 */
async function runCulturalMomentsAutoPropose(): Promise<{
  venuesChecked: number
  spikesDetected: number
  proposed: number
  deduped: number
  errors: number
  expiredArchived: number
  perVenue: Array<{ venueId: string; spikesDetected: number; proposed: number; deduped: number; errors: number }>
}> {
  const supabase = createServiceClient()

  const { data: venueRows } = await supabase
    .from('venues')
    .select('id')
    .not('google_trends_metro', 'is', null)
    .is('archived_at', null)

  const venueIds = ((venueRows ?? []) as Array<{ id: string }>).map((v) => v.id)

  const summary = {
    venuesChecked: venueIds.length,
    spikesDetected: 0,
    proposed: 0,
    deduped: 0,
    errors: 0,
    expiredArchived: 0,
    perVenue: [] as Array<{
      venueId: string
      spikesDetected: number
      proposed: number
      deduped: number
      errors: number
    }>,
  }

  // TRENDS-DIAGNOSIS Fix 1 v2 (2026-05-09): archive expired moments
  // (any status NOT IN ('archived','dismissed') with end_at < now())
  // before re-running the proposer. Order matters: archiving first
  // means a freshly-proposed moment whose window already closed
  // (extremely unlikely but possible) gets caught on the NEXT run, not
  // the same run — keeps the per-tick semantics simple. Service-role
  // global table — no per-venue loop required.
  try {
    const archiveResult = await archiveExpiredCulturalMoments(supabase)
    summary.expiredArchived = archiveResult.archivedCount
  } catch (err) {
    console.error('[cron][cultural_moments_archive_expired] failed:', err)
    summary.errors += 1
  }

  for (const venueId of venueIds) {
    try {
      const r = await autoProposeFromTrendSpikes(supabase, venueId)
      summary.spikesDetected += r.spikesDetected
      summary.proposed += r.proposed
      summary.deduped += r.deduped
      summary.errors += r.errors
      summary.perVenue.push({
        venueId,
        spikesDetected: r.spikesDetected,
        proposed: r.proposed,
        deduped: r.deduped,
        errors: r.errors,
      })
    } catch (err) {
      console.error(`[cron][cultural_moments_auto_propose] failed for venue ${venueId}:`, err)
      summary.errors += 1
      summary.perVenue.push({
        venueId,
        spikesDetected: 0,
        proposed: 0,
        deduped: 0,
        errors: 1,
      })
    }
  }

  return summary
}

async function scanBacktraceAllVenues(): Promise<
  Record<string, { highConfidence: number; mediumConfidence: number; notified: boolean }>
> {
  const supabase = createServiceClient()

  // Only scan venues that actually have a live Gmail connection — no
  // inbox = no findBacktraceCandidates work worth doing.
  const { data: connectedRows } = await supabase
    .from('gmail_connections')
    .select('venue_id')
    .eq('sync_enabled', true)
    .eq('status', 'active')
  const venueIds = new Set<string>()
  for (const row of connectedRows ?? []) {
    if (row.venue_id) venueIds.add(row.venue_id as string)
  }
  if (venueIds.size === 0) return {}

  const out: Record<string, { highConfidence: number; mediumConfidence: number; notified: boolean }> = {}

  for (const venueId of venueIds) {
    try {
      const candidates = await findBacktraceCandidates(venueId, { useLiveGmail: true })
      const high = candidates.filter((c) => c.confidence === 'high').length
      const medium = candidates.filter((c) => c.confidence === 'medium').length

      let notified = false
      if (high > 0) {
        // Dedup window: at most one notification per 7 days per venue,
        // regardless of read state. This balances two pressures:
        //   - Don't spam: a coordinator who's seen the alert once
        //     this week shouldn't get pinged again every cron tick.
        //   - Don't fall silent: if new candidates land later (Gmail
        //     polling delivers more emails over time), we want them
        //     to surface within a week without needing a re-scan
        //     click.
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        const { data: recent } = await supabase
          .from('admin_notifications')
          .select('id')
          .eq('venue_id', venueId)
          .eq('type', 'source_backtrace_ready')
          .gte('created_at', sevenDaysAgo)
          .limit(1)
        if (!recent || recent.length === 0) {
          await createNotification({
            venueId,
            type: 'source_backtrace_ready',
            title: `Source attribution: ${high} ${high === 1 ? 'lead' : 'leads'} ready for re-attribution`,
            body:
              `We found ${high} high-confidence ${high === 1 ? 'match' : 'matches'} ` +
              `where the real first-touch source was misattributed to a scheduling ` +
              `tool. Review and apply at /settings/sources.`,
          })
          notified = true
        }
      }

      out[venueId] = { highConfidence: high, mediumConfidence: medium, notified }
    } catch (err) {
      console.error(`[cron] backtrace scan failed for venue ${venueId}:`, err)
      out[venueId] = { highConfidence: -1, mediumConfidence: -1, notified: false }
    }
  }
  return out
}

/**
 * Poll Zoom recordings for every venue with an active connection. The
 * service's syncMeetings handler dedups against processed_zoom_meetings, so
 * even if recordings land slowly we just keep picking up new ones each day.
 *
 * If a connection's refresh token is permanently dead, the service marks
 * it inactive and throws "reconnect needed" — we catch and continue so one
 * dead venue doesn't block the rest.
 */
async function pollZoomAllVenues(): Promise<
  Record<string, { fetched: number; newlyProcessed: number; matched: number; errors: number; reconnectNeeded?: boolean }>
> {
  const supabase = createServiceClient()

  const { data: rows } = await supabase
    .from('zoom_connections')
    .select('venue_id')
    .eq('is_active', true)

  const venueIds = new Set<string>()
  for (const row of rows ?? []) {
    if (row.venue_id) venueIds.add(row.venue_id as string)
  }
  if (venueIds.size === 0) return {}

  const out: Record<
    string,
    { fetched: number; newlyProcessed: number; matched: number; errors: number; reconnectNeeded?: boolean }
  > = {}

  for (const venueId of venueIds) {
    try {
      const result = await syncZoomMeetings(venueId, { sinceDays: 30 })
      out[venueId] = {
        fetched: result.fetched,
        newlyProcessed: result.newlyProcessed,
        matched: result.matched,
        errors: result.errors,
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'reconnect needed') {
        out[venueId] = { fetched: 0, newlyProcessed: 0, matched: 0, errors: 0, reconnectNeeded: true }
      } else {
        console.error(`[cron] zoom poll failed for venue ${venueId}:`, err)
        out[venueId] = { fetched: 0, newlyProcessed: 0, matched: 0, errors: 1 }
      }
    }
  }
  return out
}

async function refreshQualitySignalsAllVenues(): Promise<Record<string, number>> {
  const supabase = createServiceClient()
  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')
  const out: Record<string, number> = {}
  for (const v of venues ?? []) {
    try {
      out[v.id as string] = await persistDropoffInsights(v.id as string)
    } catch (err) {
      console.error(`[quality-signals] failed for ${v.id}:`, err)
      out[v.id as string] = -1
    }
  }
  return out
}

/**
 * Poll emails for all venues with Gmail connected.
 *
 * Gmail tokens live in two places:
 *   - venue_config.gmail_tokens (legacy single-inbox flow)
 *   - gmail_connections (multi-Gmail, current flow — sync_enabled + status='active')
 *
 * Union venue ids from both so a venue that only exists in gmail_connections
 * isn't silently skipped when the legacy column is null.
 *
 * Concurrency: venues are processed in parallel chunks of POLL_CHUNK_SIZE (20)
 * so that at ~30 venues the cron no longer approaches the Vercel 300s ceiling.
 * Each venue is individually error-isolated — one failure cannot abort others.
 */
const POLL_CHUNK_SIZE = 20

/**
 * Phase 6 FIX 1: After flushing auto-sends for a venue, check whether the
 * daily cap has been reached for any enabled auto-send rule. If so, fire a
 * coordinator notification at most once per day per venue using dedup_key.
 *
 * Why here and not inside email-pipeline.ts: the pipeline only knows whether
 * THIS specific email was blocked by the cap. The cron flush pass is the
 * natural aggregation point to describe the venue-wide paused state.
 */
async function checkAndNotifyAutoSendCap(venueId: string): Promise<void> {
  try {
    const supabase = createServiceClient()
    const today = new Date().toISOString().slice(0, 10)
    const dedupKey = `auto_send_cap:${venueId}:${today}`

    // Fetch all enabled auto-send rules for this venue.
    const { data: rules } = await supabase
      .from('auto_send_rules')
      .select('context, daily_limit')
      .eq('venue_id', venueId)
      .eq('enabled', true)

    if (!rules || rules.length === 0) return

    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    // Check each context — fire once if ANY context hit its cap today.
    let capHit = false
    for (const rule of rules) {
      const context = rule.context as string
      const limit = rule.daily_limit as number
      if (!limit || limit <= 0) continue

      const { count } = await supabase
        .from('drafts')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .eq('auto_sent', true)
        .eq('context_type', context)
        .gte('created_at', todayStart.toISOString())

      if ((count ?? 0) >= limit) {
        capHit = true
        break
      }
    }

    if (!capHit) return

    // Insert with ON CONFLICT DO NOTHING via dedup_key partial UNIQUE index
    // (migration 209). 23505 = already inserted today — silently swallow.
    const { error } = await supabase.from('admin_notifications').insert({
      venue_id: venueId,
      type: 'auto_send_cap_reached',
      title: 'Auto-send paused',
      body: `Your venue reached its daily auto-send limit. Emails are queued and will resume tomorrow.`,
      priority: 'high',
      dedup_key: dedupKey,
    })

    if (error) {
      const code = (error as unknown as { code?: string }).code
      if (code !== '23505') {
        console.error('[cron] auto_send_cap notification failed:', error.message)
      }
    }
  } catch (err) {
    // Best-effort — never let notification errors block the poll.
    console.error('[cron] checkAndNotifyAutoSendCap failed:', err)
  }
}

/**
 * Phase 6 FIX 2: After the email poll, check for Gmail connections in error
 * state (token refresh failed). Fire a coordinator notification at most once
 * per connection per day using dedup_key so they know to reconnect.
 *
 * gmail.ts stamps status='error' on a connection whenever ensureFreshTokens
 * throws (invalid_grant, network failure, etc.). This cron pass surfaces it.
 */
async function checkAndNotifyGmailTokenErrors(venueId: string): Promise<void> {
  try {
    const supabase = createServiceClient()

    const { data: errorConns } = await supabase
      .from('gmail_connections')
      .select('id, email_address, error_message')
      .eq('venue_id', venueId)
      .eq('status', 'error')

    if (!errorConns || errorConns.length === 0) return

    const today = new Date().toISOString().slice(0, 10)

    for (const conn of errorConns) {
      const connId = conn.id as string
      const emailAddress = conn.email_address as string
      const dedupKey = `gmail_token_expired:${connId}:${today}`

      // Insert with ON CONFLICT DO NOTHING. 23505 = already fired today.
      const { error } = await supabase.from('admin_notifications').insert({
        venue_id: venueId,
        type: 'gmail_token_expired',
        title: 'Gmail reconnection needed',
        body: `Your Gmail inbox (${emailAddress}) is disconnected. Reconnect at Settings → Gmail to resume email processing.`,
        priority: 'urgent',
        dedup_key: dedupKey,
      })

      if (error) {
        const code = (error as unknown as { code?: string }).code
        if (code !== '23505') {
          console.error('[cron] gmail_token_expired notification failed:', error.message)
        }
      }
    }
  } catch (err) {
    console.error('[cron] checkAndNotifyGmailTokenErrors failed:', err)
  }
}

async function pollEmailsAllVenues(): Promise<Record<string, number>> {
  const supabase = createServiceClient()

  const venueIds = new Set<string>()

  const { data: legacyRows } = await supabase
    .from('venue_config')
    .select('venue_id')
    .not('gmail_tokens', 'is', null)

  for (const row of legacyRows ?? []) {
    if (row.venue_id) venueIds.add(row.venue_id as string)
  }

  // Union with ALL gmail_connections (any status) so a venue whose
  // connection just flipped to 'error' is still included — we need
  // to run checkAndNotifyGmailTokenErrors for it.
  const { data: connectionRows } = await supabase
    .from('gmail_connections')
    .select('venue_id')

  for (const row of connectionRows ?? []) {
    if (row.venue_id) venueIds.add(row.venue_id as string)
  }

  if (venueIds.size === 0) return {}

  const ids = Array.from(venueIds)
  const results: Record<string, number> = {}

  // Process venues in parallel chunks so a 30-venue run takes roughly
  // max(venue_latency) per chunk rather than sum(venue_latency) total.
  // Promise.allSettled ensures one slow/failing venue never blocks the rest.
  for (let i = 0; i < ids.length; i += POLL_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + POLL_CHUNK_SIZE)
    const settled = await Promise.allSettled(
      chunk.map(async (id) => {
        const result = await processAllNewEmails(id)
        // Flush any pending auto-sends whose 5-minute delay has elapsed
        const flushed = await flushPendingAutoSends(id)
        // Phase 6 FIX 1: notify if daily auto-send cap was hit today.
        await checkAndNotifyAutoSendCap(id)
        // Phase 6 FIX 2: notify if a Gmail connection has a token error.
        await checkAndNotifyGmailTokenErrors(id)
        return { id, count: result.processed + flushed }
      })
    )
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results[outcome.value.id] = outcome.value.count
      } else {
        // Extract the venue id from the rejection reason if possible, otherwise
        // log with a chunk-level key so the failure is still visible in the cron
        // telemetry without crashing the rest of the chunk.
        console.error('[cron] Email poll failed for venue in chunk:', outcome.reason)
      }
    }
  }

  return results
}

/**
 * Apply heat score decay, graduated cooling warnings, and auto-mark-lost
 * to all venues in a single pass. applyDailyDecay now owns all three,
 * so one cron call covers lifecycle.
 */
async function applyDecayAllVenues(): Promise<
  Record<string, { decayed: number; warnings: number; autoLost: number }>
> {
  const supabase = createServiceClient()

  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')

  if (!venues || venues.length === 0) return {}

  const results: Record<string, { decayed: number; warnings: number; autoLost: number }> = {}
  for (const v of venues) {
    const id = v.id as string
    try {
      const summary = await applyDailyDecay(id)
      results[id] = {
        decayed: summary.decayedCount,
        warnings: summary.warningsFired,
        autoLost: summary.autoLostCount,
      }
    } catch (err) {
      console.error(`[cron] Heat decay failed for venue ${id}:`, err)
      results[id] = { decayed: 0, warnings: 0, autoLost: 0 }
    }
  }
  return results
}

/**
 * Refresh source attribution calculations for all venues.
 *
 * T5-Rixey-NN bug #4: pre-fix the cron wrote one row per (venue, source)
 * tagged period_start = Jan 1 of CURRENT year, but read weddings +
 * marketing_spend with no period filter. So 24 months of historical
 * spend rolled into a row labeled "2026" which Sage misreported as
 * "Jan-May 2026 spend". Now bucket by year: one row per
 * (venue, source, year) with period_start=<year>-01-01,
 * period_end=<year>-12-31 (Dec 31 even for the in-progress current
 * year — keeps the period_start primary key stable across cron ticks).
 *
 * T5-Rixey-NN bug #8: weddings.booking_value is ALWAYS in cents per
 * the Bloom convention (see src/lib/services/crm-import/index.ts:121
 * + migration 175). The pre-fix sum here treated raw integer dollars
 * and integer cents identically, producing the $51M phantom-revenue
 * artifact. Convert booking_value to dollars when summing into
 * source_attribution.revenue (which is decimal dollars, matching
 * marketing_spend.amount).
 */
async function refreshAttributionAllVenues(): Promise<Record<string, boolean>> {
  const supabase = createServiceClient()

  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')

  if (!venues || venues.length === 0) return {}

  const results: Record<string, boolean> = {}
  for (const v of venues) {
    const id = v.id as string
    try {
      // Calculate source attribution from weddings + marketing_spend.
      // Pull `month` from marketing_spend so we can year-bucket the
      // spend side (matches the wedding-side year extraction below).
      const { data: weddings } = await supabase
        .from('weddings')
        .select('source, status, booking_value, created_at, inquiry_date')
        .eq('venue_id', id)

      const { data: spend } = await supabase
        .from('marketing_spend')
        .select('source, amount, month')
        .eq('venue_id', id)

      if (!weddings) { results[id] = false; continue }

      // Bucket key: `${year}|${source}`. One source_attribution row per
      // (venue, source, year). Year is derived from inquiry_date when
      // present (more accurate first-touch year), else created_at.
      type Bucket = { inquiries: number; tours: number; bookings: number; revenue: number; spend: number }
      const buckets = new Map<string, Bucket>()
      const empty = (): Bucket => ({ inquiries: 0, tours: 0, bookings: 0, revenue: 0, spend: 0 })

      for (const w of weddings) {
        const src = (w.source as string | null) || 'unknown'
        const dateStr = (w.inquiry_date as string | null) ?? (w.created_at as string | null)
        if (!dateStr) continue
        const year = new Date(dateStr).getUTCFullYear()
        if (!Number.isFinite(year)) continue
        const k = `${year}|${src}`
        const b = buckets.get(k) ?? empty()
        b.inquiries++
        if (['tour_scheduled', 'tour_completed', 'proposal_sent', 'booked', 'completed'].includes(w.status as string)) b.tours++
        if (['booked', 'completed'].includes(w.status as string)) {
          b.bookings++
          // booking_value is branded Cents (T5-Rixey-RR fix #5);
          // convert to dollars at the boundary into source_attribution.revenue.
          const cents = asCents(Number(w.booking_value) || 0)
          b.revenue += centsToDollars(cents)
        }
        buckets.set(k, b)
      }

      for (const s of (spend || [])) {
        const src = (s.source as string | null) || 'unknown'
        const monthStr = s.month as string | null
        if (!monthStr) continue
        const year = new Date(monthStr).getUTCFullYear()
        if (!Number.isFinite(year)) continue
        const k = `${year}|${src}`
        const b = buckets.get(k) ?? empty()
        b.spend += Number(s.amount) || 0
        buckets.set(k, b)
      }

      // Upsert one row per (venue, source, year). period_start fixed at
      // Jan 1 so the unique-index target (venue_id, source, period_start)
      // stays stable across re-runs (migration 180).
      const now = new Date().toISOString()
      for (const [k, data] of buckets) {
        const [yearStr, source] = k.split('|', 2)
        const year = Number(yearStr)
        const periodStart = `${year}-01-01`
        const periodEnd = `${year}-12-31`

        const costPerInquiry = data.inquiries > 0 ? data.spend / data.inquiries : 0
        const costPerBooking = data.bookings > 0 ? data.spend / data.bookings : 0
        const conversionRate = data.inquiries > 0 ? data.bookings / data.inquiries : 0
        const roi = data.spend > 0 ? (data.revenue - data.spend) / data.spend : 0

        await supabase.from('source_attribution').upsert({
          venue_id: id,
          source,
          period_start: periodStart,
          period_end: periodEnd,
          spend: data.spend,
          inquiries: data.inquiries,
          tours: data.tours,
          bookings: data.bookings,
          revenue: data.revenue,
          cost_per_inquiry: costPerInquiry,
          cost_per_booking: costPerBooking,
          conversion_rate: conversionRate,
          roi,
          calculated_at: now,
        }, { onConflict: 'venue_id,source,period_start' })
      }

      results[id] = true
    } catch (err) {
      console.error(`[cron] Attribution refresh failed for venue ${id}:`, err)
      results[id] = false
    }
  }
  return results
}

/**
 * Fetch weather forecasts for all venues that have lat/lng configured.
 */
async function fetchWeatherForAllVenues(): Promise<Record<string, number>> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .not('latitude', 'is', null)
    .not('longitude', 'is', null)

  if (error || !venues || venues.length === 0) {
    console.warn('[cron] No venues with lat/lng found for weather forecast')
    return {}
  }

  const results: Record<string, number> = {}

  for (const venue of venues) {
    const id = venue.id as string
    try {
      const records = await fetchWeatherForecast(id)
      results[id] = records.length
    } catch (err) {
      console.error(`[cron] Weather forecast failed for venue ${id}:`, err)
      results[id] = 0
    }
  }

  return results
}

/**
 * Generate weekly intelligence digests for all active venues.
 * Runs on Mondays — checks day of week before generating.
 * Creates an admin notification when the digest is ready.
 */
async function generateDigestsForAllVenues(): Promise<Record<string, boolean>> {
  // Only generate on Mondays
  const dayOfWeek = new Date().getDay()
  if (dayOfWeek !== 1) {
    console.log('[cron] Weekly digest skipped — not Monday (day=' + dayOfWeek + ')')
    return {}
  }

  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')

  if (error || !venues || venues.length === 0) {
    console.warn('[cron] No active venues found for weekly digest')
    return {}
  }

  // Cost-ceiling gate: weekly digests are LLM-narrated proactive
  // surfaces. Skip paused venues per Playbook 21.4.3.
  const venueIds = venues.map((v) => v.id as string)
  const { filterActiveVenues } = await import('@/lib/services/cost-ceiling')
  const { active, skipped } = await filterActiveVenues(venueIds, {
    workType: 'weekly_digest',
  })
  if (skipped.length > 0) {
    console.log(`[cron] Weekly digest skipping ${skipped.length} paused venue(s); running ${active.length}`)
  }

  const results: Record<string, boolean> = {}

  for (const id of active) {
    try {
      await generateWeeklyDigest(id)

      // Create notification that the digest is ready
      await createNotification({
        venueId: id,
        type: 'weekly_digest',
        title: 'Your weekly intelligence digest is ready',
        body: 'Review your leads, performance trends, and actionable insights for this week.',
      })

      results[id] = true
    } catch (err) {
      console.error(`[cron] Weekly digest failed for venue ${id}:`, err)
      results[id] = false
    }
  }

  return results
}

/**
 * Measure insight outcomes for all active venues.
 * Checks pending outcomes whose measurement window has elapsed.
 */
async function measureOutcomesAllVenues(): Promise<Record<string, number>> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')

  if (error || !venues || venues.length === 0) {
    return {}
  }

  const results: Record<string, number> = {}

  for (const venue of venues) {
    const id = venue.id as string
    try {
      const measured = await measureInsightOutcomes(id)
      results[id] = measured
    } catch (err) {
      console.error(`[cron] Outcome measurement failed for venue ${id}:`, err)
      results[id] = 0
    }
  }

  return results
}

/**
 * Generate briefings for all venues that have a briefing_email configured.
 */
async function generateBriefingsForAllVenues(
  type: 'weekly' | 'monthly'
): Promise<Record<string, boolean>> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .not('briefing_email', 'is', null)

  if (error || !venues || venues.length === 0) {
    console.warn(`[cron] No venues with briefing_email found for ${type} briefing`)
    return {}
  }

  // Cost-ceiling gate: weekly + monthly briefings call Sonnet for
  // narration. Skip paused venues per Playbook 21.4.3.
  const venueIds = venues.map((v) => v.id as string)
  const { filterActiveVenues } = await import('@/lib/services/cost-ceiling')
  const { active, skipped } = await filterActiveVenues(venueIds, {
    workType: type === 'weekly' ? 'weekly_briefing' : 'monthly_briefing',
  })
  if (skipped.length > 0) {
    console.log(`[cron] ${type} briefing skipping ${skipped.length} paused venue(s); running ${active.length}`)
  }

  const results: Record<string, boolean> = {}

  for (const id of active) {
    try {
      if (type === 'weekly') {
        await generateWeeklyBriefing(id)
      } else {
        await generateMonthlyBriefing(id)
      }
      results[id] = true
    } catch (err) {
      console.error(`[cron] ${type} briefing failed for venue ${id}:`, err)
      results[id] = false
    }
  }

  return results
}

/**
 * Check for weddings that happened 3 days ago and don't have feedback yet.
 * Creates a notification prompting the coordinator to submit feedback.
 */
async function checkPostEventFeedback(): Promise<{ notified: number }> {
  const supabase = createServiceClient()

  // Find weddings where wedding_date was 3 days ago, status is booked or completed,
  // and no event_feedback row exists yet
  const threeDaysAgo = new Date()
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)
  const dateStr = threeDaysAgo.toISOString().split('T')[0]

  const { data: weddings, error } = await supabase
    .from('weddings')
    .select(`
      id,
      venue_id,
      wedding_date,
      status
    `)
    .eq('wedding_date', dateStr)
    .in('status', ['booked', 'completed'])

  if (error || !weddings || weddings.length === 0) {
    return { notified: 0 }
  }

  // Filter out weddings that already have feedback
  const weddingIds = weddings.map((w) => w.id as string)
  const { data: existingFeedback } = await supabase
    .from('event_feedback')
    .select('wedding_id')
    .in('wedding_id', weddingIds)

  const feedbackWeddingIds = new Set(
    (existingFeedback ?? []).map((f) => f.wedding_id as string)
  )

  const needsFeedback = weddings.filter(
    (w) => !feedbackWeddingIds.has(w.id as string)
  )

  if (needsFeedback.length === 0) {
    return { notified: 0 }
  }

  let notified = 0

  for (const w of needsFeedback) {
    const weddingId = w.id as string
    const venueId = w.venue_id as string

    // Get couple names for the notification.
    // T5-Rixey-EEE Bug 1 (defense-in-depth): pull last_name too so
    // dedupePeopleByName can collapse alias-row duplicates by full
    // name signature.
    const { data: people } = await supabase
      .from('people')
      .select('first_name, last_name, role')
      .eq('wedding_id', weddingId)

    const { dedupePeopleByName } = await import('@/lib/utils/couple-name')
    const coupleNames = dedupePeopleByName(
      (people ?? []).filter((p) =>
        ['partner1', 'partner2', 'bride', 'groom', 'partner'].includes(p.role)
      )
    )
      .map((p) => p.first_name)
      .join(' & ')

    const label = coupleNames || 'the couple'

    try {
      await createNotification({
        venueId,
        weddingId,
        type: 'post_event_feedback',
        title: `Time to share your feedback on ${label}'s wedding!`,
        body: `Your observations help Bloom House learn. Complete the post-event feedback while it's fresh.`,
      })
      notified++
    } catch (err) {
      console.error(`[cron] Feedback notification failed for wedding ${weddingId}:`, err)
    }
  }

  return { notified }
}

/**
 * T5-Rixey-ZZ / Z7 (2026-05-02): correlation engine + weather × tour
 * cancellation analyzer in one cron tick. Both are pure-stats classical
 * compute — no AI call — so running them back-to-back keeps the
 * cron-coverage map simple. Each handler swallows its own errors so
 * one bad venue doesn't take down the other side.
 *
 * Returns rolled-up counts so the cron telemetry shows what fired.
 */
async function runCorrelationAndWeatherCancellation(): Promise<{
  correlations: Record<string, number>
  weather_cancellations: {
    venues_total: number
    venues_with_signal: number
    venues_data_gated: number
    by_reason: Record<string, number>
  }
}> {
  const supabase = createServiceClient()
  const correlations = await computeCorrelationsAllVenues(supabase)

  const wxResults = await analyzeWeatherCancellationsAllVenues(supabase)
  const summary = {
    venues_total: 0,
    venues_with_signal: 0,
    venues_data_gated: 0,
    by_reason: {} as Record<string, number>,
  }
  for (const r of Object.values(wxResults)) {
    summary.venues_total++
    if (r.dataGated) {
      summary.venues_data_gated++
      const reason = r.gatedReason ?? 'unknown'
      summary.by_reason[reason] = (summary.by_reason[reason] ?? 0) + 1
    } else if (r.ok && r.insightId) {
      summary.venues_with_signal++
    }
  }

  return { correlations, weather_cancellations: summary }
}

// ---------------------------------------------------------------------------
// GET — Vercel cron sends GET requests
//   Header: Authorization: Bearer <CRON_SECRET>
//   Query: ?job=JOB_NAME
// ---------------------------------------------------------------------------

// Vercel function timeout. Defaults to 60s on Pro plan; this dispatcher
// runs ~40 different jobs ranging from quick (~1s) to deep (email_poll
// across N venues, attribution refresh across N venues, alumni cohort
// regeneration). At 30+ venues the email_poll job exceeds 60s under
// load. 300s is the Vercel Pro ceiling and gives the fleet the runway
// it needs through ~80-100 venues. Beyond that the architecture needs
// to move to a queue-per-venue pattern (see scaling notes 2026-05-12).
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const job = searchParams.get('job') as JobName | null

  if (!job || !VALID_JOBS.includes(job)) {
    return NextResponse.json(
      { error: `Invalid job. Must be one of: ${VALID_JOBS.join(', ')}` },
      { status: 400 }
    )
  }

  // Tier-C #126 two-tier cron auth. The destructive secondary kicks in
  // for the merge / prune / outbound jobs when CRON_SECRET_DESTRUCTIVE
  // is configured; otherwise behaves identically to single-secret.
  const { verifyCronAuth } = await import('@/lib/cron-auth')
  const authResult = verifyCronAuth(request, { jobName: job })
  if (!authResult.ok) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status })
  }

  // OPS-21.2.3: every cron tick gets a cron_runs row via trackCronRun.
  // Captures started_at / ended_at / duration_ms / status / error_class
  // so the pipeline-health page + alerts can detect stuck/failed crons.
  const { trackCronRun } = await import('@/lib/observability/metrics')
  try {
    console.log(`[cron] Starting job: ${job}`)
    const wrapped = await trackCronRun(job, async () => runJob(job))
    console.log(`[cron] Completed job: ${job} in ${wrapped.duration_ms}ms`)
    return NextResponse.json({ job, success: true, result: wrapped.result, duration_ms: wrapped.duration_ms })
  } catch (err) {
    console.error(`[cron] Job ${job} failed:`, err)
    return NextResponse.json(
      { job, success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
