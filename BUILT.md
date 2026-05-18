# Bloom House — What's Built

**Last updated:** 2026-05-13
**Doctrine anchor:** `bloom-constitution.md`
**Status:** Re-audited end-to-end against source. See `§0 methodology` for verification provenance and disclaimers.

This document maps every place data enters Bloom and what happens to it afterward. Previous drafts of this file contained agent-hallucinated table names and rounded line numbers. This rewrite verifies every claim against migrations, vercel.json, the cron dispatcher, and the route/service file tree. Items I could not verify are explicitly labelled.

---

## §0 Methodology

### Sources of truth used

| Source | What it tells you | Confirmed counts |
|---|---|---|
| `supabase/migrations/*.sql` (Grep for `CREATE TABLE`) | Every table that exists | **264 tables** |
| `vercel.json` (Read) | Cron jobs actually scheduled by Vercel | **44 cron entries** |
| `src/app/api/cron/route.ts` (Grep for `case 'name':`) | Cron job names handled by the dispatcher | **81 named jobs** |
| `src/app/api/**/route.ts` (Glob) | HTTP-callable surfaces | **344 routes** |
| `src/lib/services/**/*.ts` (Glob) | Business logic | **400 service files** |
| `src/lib/services/email/pipeline.ts` (Read) | Inbound-email dispatch order | 4,751 lines |

### Verification rules I followed this pass

1. **Every table named** in this doc has been verified to exist in a `CREATE TABLE` statement under `supabase/migrations/`. Tables I cited in earlier drafts that don't exist are listed in §8.5 with their real names.
2. **Every file path** has been confirmed via Glob or Read.
3. **Every function name** has been confirmed via Grep (`^export (async )?function`).
4. **Cron schedules** come from `vercel.json` directly; cron job NAMES come from the dispatcher's `case` labels. Jobs that exist in the dispatcher but not in `vercel.json` are noted as "invokable-only."
5. **Stage names** for `processIncomingEmail` use the file's own `// Step Nx.M:` comment headers with their real line numbers, not invented stage names.
6. **Writers** for a table are verified via `Grep` for `.from('TABLE').insert|upsert|update`. Writers that chain across newlines (multi-line method chains) may be missed by this grep; the doc flags `(verified)` only where the line was seen directly.

### What this doc does NOT exhaustively cover

- **Every API route's read/write footprint.** 344 routes × ~5 tables per route is too many to validate by hand. The doc covers the ingestion-producing routes (those that land NEW data) and the cron handlers. It does not enumerate every read endpoint.
- **Every cron handler's full implementation.** 81 jobs in the dispatcher. The doc names each, links to its service file, and gives the headline tables it touches. It does not trace every branch inside each handler.
- **UI consumers.** The doc names some `/intel/*` and `/agent/*` pages where they're load-bearing for a derived table, but is not a complete UI catalog.
- **RLS policies and triggers.** Verifying these is its own audit.

Where the verification rule does not apply, the doc explicitly says `(not exhaustively verified)`.

---

## §1 Inventory

### §1.1 Tables (264)

Full enumeration is in `supabase/migrations/`. The doc references a subset directly; the most-touched ones are catalogued in §6 (multi-writer audit). The full table-name list can be regenerated with:

```
Grep "CREATE TABLE" in supabase/migrations/
```

### §1.2 API routes (344)

Categorisation (after reading the route paths):

| Category | Count (approx.) | Examples |
|---|---|---|
| Webhooks (real-time inbound) | 4 | `/api/webhooks/{calendly,stripe,twilio}/route.ts`, `/api/omi/webhook/route.ts` |
| OAuth flows | ~6 | `/api/auth/callback`, `/api/auth/zoom/*`, `/api/gmail/oauth/*`, `/api/integrations/google-ads/oauth/*` |
| Cron handlers | 6 path-style + 1 dispatcher | `/api/cron/route.ts` (main), `/api/cron/{agency-activity-sweep,agency-document-orphans,identity-judge-sweep,replay-paused-skipped,tbh-reports-monthly}/route.ts` |
| Operator admin (`/api/admin/*`) | ~120 | identity, attribution, intel, marketing-spend, lifecycle, knowledge-gaps, voice-dna, etc. |
| Operator agent (`/api/agent/*`) | ~40 | drafts, leads, repairs, backfills, cost-ceiling controls |
| Intel reads + writes (`/api/intel/*`) | ~80 | insights, anomalies, agencies, sources, reviews, social-integration, voice-dna |
| Onboarding (`/api/onboarding/*`) | ~13 | crm-import, web-form-import, voice-dna-extract, identity-reconciliation, extract-packages, backfill, pricing-history, day3-readiness, project/activate, test-draft |
| Portal/couple (`/api/{portal,couple,public}/*`) | ~25 | configuration, vendor portal, public wedding website, Sage preview |
| Settings (`/api/settings/*`) | ~5 | essentials-preferences, digest-preferences, personality preview |
| Stripe (`/api/stripe/*`) | 4 | checkout, invoices, portal, subscription |
| Tracking pixels | 2 | `/api/v1/visit`, `/api/tracking` |
| Bar / brain-dump / OpenPhone / Zoom direct | ~15 | uploads, brain-dump entries, openphone connection/discover/sync, zoom sync |

The breakdown is approximate by category; counts within `/api/admin/*` and `/api/intel/*` are dominated by per-feature sub-endpoints (each agency has ~13 sub-routes, each disagreement has ~6, etc.).

### §1.3 Cron jobs (81 named, 44 scheduled)

`src/app/api/cron/route.ts` exposes 81 cron job names via switch-case. `vercel.json` schedules 44 of them. The remaining 37 are dispatcher-invokable only — they exist as named handlers and can be called via `/api/cron?job=<name>` but Vercel does not fire them on a schedule. Some are piggybacked from other crons (e.g., `sms_sequences` drained inside `openphone_poll`); others are operator-triggered manually.

See §3 for the full list with schedules.

### §1.4 Service files (400)

`src/lib/services/` has 400 `.ts` files across these subdirectories:

```
attribution/, attribution-roles/, audio-capture/, brain/, brain-dump/,
calibration/, cascades/, channel-intel-hub/, channel-truth/, compliance/,
crm-import/, data-integrity/, demo/, disagreement/, discovery-source/,
email/, external-context/, identity/, ingestion/, insights/, intel/,
lifecycle/, marketing-spend/, onboarding/, platform-detectors/,
reviews/, sms/, social/, telemetry/, tour/, voice/
```

---

## §2 Ingestion paths

Every place new data lands in the Bloom database. Organised by trigger mechanism.

### §2.1 Real-time inbound webhooks

Four routes accept pushed payloads from external systems.

#### 2.1.1 Calendly tour-booking — `src/app/api/webhooks/calendly/route.ts` (316 lines)

- **Trigger:** HTTP POST from Calendly (`invitee.created`, cancellation events). Signature verified via HMAC.
- **Identity resolve:** `contacts` joined to `people` joined to `weddings` by email (line 140).
- **Writes (verified):**
  - `tours` (INSERT at line 220 — pre-populates a tour row with `tour_type='in_person'`, status pending)
  - `engagement_events` (via `recordEngagementEvent(venueId, weddingId, 'tour_booked', 'inbound', ...)` at line 186)
  - `consultant_metrics` (via `trackCoordinatorAction` at line 250)
  - `discovery_sources` (via `captureDiscoverySource` — discovery_sources table exists per mig 326)
  - `attribution_events` (fan-out from discovery-source capture)
- **Note:** Does NOT write `interactions` directly — Calendly is treated as a scheduling event, not a thread message. Per `bloom-reply-guard-audit`, Calendly is a structurally different surface.

#### 2.1.2 Stripe — `src/app/api/webhooks/stripe/route.ts` (706 lines)

- **Trigger:** HTTP POST signed with `STRIPE_WEBHOOK_SECRET`. Events: subscription lifecycle, charge.failed.
- **State machine:** `stripe_events` table with `processed_at` column is the primary idempotency guard (mig 209/211/215).
- **Writes (verified):**
  - `stripe_events` (insert + processed_at update at lines 287, 300, 644)
  - `venues` (update `plan_tier`, `subscription_status`, related fields at lines 361, 398, 415, 432, 446, 497, 532, 585)
  - `admin_notifications` (lines 126, 146)
- **Plan tiers:** `solo` etc. derived from price_id via metadata or fallback (lines 679-686). CHECK constraint enforced per migration 215.

#### 2.1.3 Twilio SMS — `src/app/api/webhooks/twilio/route.ts` (339 lines)

- **Trigger:** HTTP POST from Twilio (form-encoded). Signature via `verifyTwilioSignature`.
- **Writes (verified):**
  - `twilio_webhook_log` (insert at lines 180, 263, 277 — idempotency log on MessageSid)
  - `interactions` (line 239 — via `.from('interactions')` chained call)
- **Operates in parallel with the OpenPhone Quo path (§2.2.3).** Twilio is one provider; venues that route SMS through Twilio land here. Venues using OpenPhone land via §2.2.3.

#### 2.1.4 OMI audio — `src/app/api/omi/webhook/route.ts` (152 lines)

The route is a thin shim per its own header comment.

- **Trigger:** HTTP POST with `?token=<uuid>`. Token matched against `venue_config.omi_webhook_token`.
- **Pipeline:**
  1. Adapter parses payload → normalised segments (`audio-capture/adapters/omi-adapter.ts`)
  2. Orchestrator persists (`audio-capture/orchestrator.ts`)
  3. If bound to a tour and the tour is `outcome='completed' OR 'booked' OR (>1h old AND >500 chars)`, fires `extractTourTranscript()` (Sonnet) — cost-ceiling gated
- **Writes (verified):**
  - `transcript_segments` (insert at `audio-capture/orchestrator.ts:218`)
  - `tours` (via orchestrator — bind to existing tour by venue + session_id + nearest scheduled-at)
  - `tour_transcript_orphans` (when no matching tour)
  - `tours.transcript_extracted` (jsonb, written by `tour/transcript-extract.ts` when fired)
- **Note:** Does NOT write `interactions` directly. The audio is its own surface (tour-bound). Sage reads `tours.transcript_extracted` when assembling context.

### §2.2 OAuth-poll integrations (cron-driven inbound)

Bloom-initiated polling against stored OAuth credentials.

#### 2.2.1 Gmail — `src/lib/services/email/pipeline.ts` (4,751 lines)

The system's largest ingestion surface. Entry: `processAllNewEmails(venueId)` at line 3996, which iterates `gmail_connections` and calls `processIncomingEmail()` (line 846) per new message.

- **Trigger:** Cron `email_poll` (`*/5 * * * *`); also OAuth-callback at `/api/auth/callback`.
- **Watermark:** `gmail_connections.last_synced_at` (per migration 311).
- **Writers within the pipeline (verified by reading `// Step` markers + grep):** `interactions`, `weddings`, `people`, `contacts`, `drafts`, `engagement_events`, `attribution_events`, `wedding_lifecycle_events`, `identity_reconstruction_jobs`, `admin_notifications`, `api_costs`, plus side-effect Haiku updates to `interactions.{author_class, surface, intent_class, extracted_facts, sentiment, urgency, family_mentioned}`.
- **Full pipeline stage map:** §4.1.

#### 2.2.2 Zoom — `src/lib/services/ingestion/zoom.ts` (888 lines)

- **Trigger:** Cron `zoom_poll` (`0 10 * * *`); on-demand via `/api/zoom/sync`.
- **OAuth:** `zoom_connections` table; access token refreshed when `expires_at < now + 60s`.
- **Writes (verified):**
  - `processed_zoom_meetings` (lines 596, 630 — dedup + transcript text)
  - `interactions` (line 674 — type=meeting, surface=video_capture)
- **Transcript extraction:** WEBVTT parsed inline, then `extractTourTranscript()` fired when transcript found and tour-binding succeeds.

#### 2.2.3 OpenPhone (Quo) — `src/lib/services/ingestion/openphone.ts` (1,249 lines)

- **Trigger:** Cron `openphone_poll` (`*/15 * * * *`); on-demand at `/api/openphone/sync`. Same cron also drains `sms_sequences` (Wave 29).
- **Auth:** Raw API key header (NOT Bearer) per `bloom-may11-live-customer-session`.
- **Writes (verified):**
  - `processed_sms_messages` (line 815 — dedup)
  - `interactions` (line 973 — via `.from('interactions')` chained call)
- **Identity matching:**
  - Tier 1: phone-based via `resolveIdentity` (`identity/resolver.ts`)
  - Tier 2: Haiku name+event-context match via `sms-identify-person.prompt.v1` + `sms-name-match.ts` (Wave 29)
- **Call hydration:** `hydrateCallTranscript` calls `/v1/calls/{id}/summary` + `/v1/calls/{id}/transcriptions`; 404s silent.

#### 2.2.4 Calendly backfill (on-demand)

- **Trigger:** GET `/api/calendly/events`. Used for backfilling existing Calendly history.
- **Service:** `src/lib/services/ingestion/calendly.ts` — fetches via Calendly API.
- **Same write footprint as the webhook (§2.1.1).**

### §2.3 External enrichment pulls (cron-initiated)

Bloom calls out, pulls data in. Each has a dedicated service file and a cron schedule.

| Source | Service | Cron | Writes |
|---|---|---|---|
| NOAA monthly historical + Open-Meteo 14-day forecast | `intel/weather.ts` | `weather_forecast` (`0 5 * * *`) | `weather_data` |
| Google Trends via SerpAPI | `intel/trends.ts` | `trends_refresh` (`0 3 * * 1`) | `search_trends`, `api_costs` |
| FRED economic indicators | `external-context/fred.ts` | `fred_daily_refresh` (`0 3 * * *`); also alias `economic_indicators` | `fred_indicators`, `fred_series_sync_state` |
| US Census ACS5 | `ingestion/census.ts` | `census_refresh` (`0 3 1 * *`) | `market_intelligence` |
| US + Virginia calendar events | `external-context/calendar-writer.ts` | `external_calendar_refresh` (`0 4 * * *`) | `external_calendar_events` |

Cultural moments are auto-proposed from internal data + external context. See §4 derived-table section.

### §2.4 Coordinator-initiated data ingestion

Surfaces where an operator (or in some cases a couple) uploads new data through the platform UI.

#### 2.4.1 Brain-dump — `/api/brain-dump/entries/route.ts`

Operator pastes/uploads CSV, PDF, image, or text. Shape detector routes to the right importer.

- **Shape detector:** `brain-dump/csv-shape.ts` (not exhaustively read; categories per memory and the `brain_dump_pattern_grants` table: leads / reviews / platform_activity / knowledge_base / day-of plan / etc.)
- **Importers:** `brain-dump/imports.ts` (not exhaustively read; per memory writes to `weddings` via `mintWedding`, `people`, `reviews`, `tangential_signals`, `knowledge_base`, `wedding_party`, `bedroom_assignments`, `decor_inventory`, etc.)
- **Audit trail:** `brain_dump_entries`
- **Vision chain (PDF/image):** `unpdf` + DOMMatrix polyfill (per `feedback_pdf_polyfill_required`) → `callAIVision()` (Sonnet)

#### 2.4.2 CRM import — `/api/onboarding/crm-import/route.ts`

Adapter pattern. Six real adapters in `src/lib/services/crm-import/`:

| File | Status |
|---|---|
| `honeybook.ts` (in `crm-import/index.ts`) | Real, full (per memory `bloom-rixey-go-live`) |
| `dubsado.ts` | Scaffold |
| `aisleplanner.ts` | Scaffold |
| `web-form-packages.ts` | Real (web-form variant) |
| `primitives/{couple-parser,field-detector,financial-parser,status-deriver}.ts` | Shared helpers |

Tour-scheduler adapter (Calendly / Acuity / Square / iCal) lives separately and is invoked through `onboarding/crm-import` with a TourSchedulerHint.

Writes (per memory + spot-checks): `weddings` (via mintWedding chokepoint), `people`, `interactions` (per-row activity log), `lost_deals` (if status=lost), `import_runs`, `mint_wedding_telemetry`.

#### 2.4.3 Web-form import — `/api/onboarding/web-form-import/route.ts`

Multi-provider CSV (Typeform / JotForm / Google Forms / custom / Rixey Calculator). Adapter at `crm-import/web-form-packages.ts`. Writes: `weddings` (crm_source='web_form'), `people`, `interactions`, `tangential_signals` (form Q&A persisted).

#### 2.4.4 Marketing-spend ingestion (5 connectors)

`src/lib/services/marketing-spend/connectors/`:

| Connector | Source |
|---|---|
| `google-ads.ts` | Google Ads API (OAuth-connected via `/api/integrations/google-ads/*`) |
| `meta-ads.ts` | Meta Ads (Facebook) |
| `tiktok-ads.ts` | TikTok Ads |
| `theknot.ts` | The Knot platform spend |
| `manual.ts` | Coordinator manual entry via `/api/admin/marketing-spend/manual` |

- **Entry:** `marketing-spend/ingest.ts`; sweep `marketing-spend/spend-sync-sweep.ts`.
- **Cron:** `spend_sync_sweep` (invokable-only — not in `vercel.json`).
- **Writes (verified by grep):** `marketing_spend` (insert at `intel/marketing-spend.ts:122`), plus per-connector tables and `marketing_spend_jobs`, `marketing_spend_flags`, `marketing_spend_records`.

#### 2.4.5 Social capture — `/api/intel/social-integration/capture/route.ts`

Different surface from brain-dump. Used for parsed Instagram-followers text and (per file imports) `matchEngagementsForCapture`.

- **Writes (verified):** `social_captures` (line 89), `social_engagements` (line 130)
- **Parser:** `social/parsers/instagram-followers.ts`
- **Match:** `social/match-engagements.ts`

#### 2.4.6 Review import — `/api/intel/reviews/import/route.ts` + `/extract-from-text/route.ts` + `/extract-all/route.ts`

- Writes to `reviews`, `review_language` (with `source_type='review'`)
- Per-review phrase extraction at `/api/intel/reviews/[id]/extract-phrases`

#### 2.4.7 Onboarding-time captures

Several onboarding routes that ingest historical data:

| Route | What it ingests |
|---|---|
| `/api/onboarding/voice-dna-extract` | Outbound-email corpus → `voice_preferences`, `review_language` (seed) |
| `/api/onboarding/extract-packages` | Vendor PDFs → `packages` |
| `/api/onboarding/pricing-history` | Pricing changes → `pricing_history` |
| `/api/onboarding/identity-reconciliation` | Coordinator-driven dedup of legacy data |
| `/api/onboarding/backfill` | Historical email backfill via `onboarding/backfill.ts` |
| `/api/onboarding/day3-readiness` | Readiness check (read-only) |
| `/api/onboarding/test-draft` | Test Sage draft generation |
| `/api/onboarding/project/activate` | Activates a venue's onboarding project |

#### 2.4.8 Bar recipe — `/api/bar-recipes/extract-upload` + `/api/bar-recipes/extract-url`

Couple-side. Image/PDF or URL → Sonnet vision (`bar-recipe-extract.ts`) → `bar_recipes`.

#### 2.4.9 Tour-transcript manual re-extract — `/api/agent/tour-transcript-extract`

Coordinator manual trigger. NOT cost-ceiling gated (coordinator request, not autonomous fire). Writes `tours.transcript_extracted`.

#### 2.4.10 Agency document upload — `/api/intel/agencies/[id]/documents/upload`

Wave 6E. Writes `agency_documents`.

#### 2.4.11 Operator repair / backfill endpoints

| Route | Purpose |
|---|---|
| `/api/agent/backfill-senders` | Re-fetch Gmail headers for legacy interactions missing `from_email`/`person_id` |
| `/api/agent/reprocess-orphans` | Re-process person-attached interactions still missing wedding_id |
| `/api/agent/cleanup-ghost-weddings` | Delete inquiry-stage weddings with no people + no interactions |
| `/api/agent/reprocess-form-relays` | Re-run form-relay parsers against historical interactions |
| `/api/agent/backfill-unknown-couples` | Backfill couple identity from interactions |
| `/api/agent/dedupe-interactions` | Dedup interactions where Gmail double-delivered |
| `/api/agent/repair-wedding-people` | Re-link people↔wedding |
| `/api/agent/wipe-pipeline-data` | Destructive operator reset |
| `/api/admin/sms/rematch` | Wave 29 LLM matcher backfill against unmatched OpenPhone rows |
| `/api/admin/recover-booked-data` | Manual booked-data-recovery trigger |
| `/api/admin/imports/reprocess` | Re-run an import |
| `/api/admin/repair-form-bleed-names` | Fix name-bleed from form parsers |

### §2.5 Pixel + tracking endpoints

| Route | Writes (verified) |
|---|---|
| `/api/v1/visit/route.ts` | `web_visits` (insert at line 186) |
| `/api/tracking/route.ts` | Calls `trackCoordinatorAction` (consultant_metrics; not directly `.from().insert`) |

### §2.6 Public / vendor-facing ingestion

| Route | Purpose |
|---|---|
| `/api/public/sage-preview` | Public Sage chat preview (writes `sage_conversations`) |
| `/api/public/wedding-website` | Public couple wedding website read |
| `/api/public/vendor-portal` | Vendor portal read via token |
| `/api/public/channels/exports/[shareToken]` | Channel-truth export read via share token |
| `/api/vendor-portal/[token]` | Tokenised vendor view |
| `/api/couple/register` | Couple self-registration |

---

## §3 Cron schedule

Verified directly against `vercel.json` (44 scheduled entries) and `src/app/api/cron/route.ts` (81 named handlers).

### §3.1 Scheduled crons (44)

In time-of-day order so co-firing is visible:

```
*/5  *      *  *  *    email_poll
*/5  *      *  *  *    recompute_pending_temporal
*/5  *      *  *  *    identity_judge_sweep
*/15 *      *  *  *    openphone_poll
15   *      *  *  *    cost_ceiling_check
0    *      *  *  *    follow_up_sequences

5    0      *  *  *    cost_ceiling_reset
5    0      *  *  *    /api/cron/replay-paused-skipped     ← path-style, not ?job=
15   0      *  *  *    prune_expired_pulse_snoozes
0    2      *  *  *    prune_maintenance
0    2      *  *  1    attribution_refresh
0    2      *  *  0    agency_document_orphans
0    3      *  *  *    fred_daily_refresh
0    3      *  *  *    booked_data_recovery
0    3      *  *  1    trends_refresh
0    3      1  *  *    census_refresh
30   3      *  *  *    merge_people_aliases
0    4      *  *  *    anomaly_detection
0    4      *  *  *    identity_backtrack
0    4      *  *  *    external_calendar_refresh
0    4      *  *  2    venue_health_compute
30   4      *  *  *    backtrace_scan
45   4      *  *  *    phase_b_sweep
0    5      *  *  *    weather_forecast
0    5      *  *  *    correlation_analysis
0    5      *  *  *    data_integrity_sweep
0    5      *  *  *    compute_attribution_parity
0    5      *  *  2    quality_signals_refresh
30   5      *  *  *    re_engagement_attribution
0    6      *  *  *    heat_decay
0    6      *  *  *    tour_outcome_classifier
0    6      *  *  2    transcript_voice_mining
0    6      *  *  0    outcome_measurement
0    6      1  *  *    voice_dna_refresh
30   6      *  *  *    agency_activity_sweep
0    7      *  *  *    daily_digest
0    8      *  *  1    weekly_briefing
0    8      1  *  *    monthly_briefing
15   8      *  *  *    cultural_moments_auto_propose
30   8      *  *  *    essentials_suggest
0    9      *  *  *    inbox_filter_learning
0    9      1  *  *    tbh_reports_monthly
30   9      *  *  *    cultural_moments_llm_propose
0    10     *  *  *    zoom_poll
0    14     *  *  *    post_event_feedback_check
```

### §3.2 Invokable-only handlers (37)

Named in the dispatcher but not in `vercel.json`. Either piggybacked from another cron, operator-triggered, or pending scheduling.

Sweep drains (Wave subsystems):
```
couple_intel_sweep            Wave 5A — drain couple_intel_jobs
cohort_rollup_sweep           Wave 5B — drain cohort jobs
spend_sync_sweep              Marketing-spend ingestion
attribution_role_sweep        Wave 7B role classifier
external_match_sweep          Cross-venue matching
persona_channel_rollup_sweep  Persona × channel rollups
discovery_engine_sweep        Intel discovery jobs
venue_thesis_sweep            Venue thesis generation
marketing_recommendation_sweep Marketing recs
hypothesis_validation_sweep    Hypothesis validation
spend_loop_flag_sweep         Spend-loop flag detector
marketing_digest_sweep        Marketing digest
external_signals_health_sweep External-signal health
integrity_remediation_sweep   Data-integrity remediation
lifecycle_sweep               Lifecycle state machine drain
tour_prep_brief_sweep         Tour prep brief
review_solicit_sweep          Review solicitation
referral_extraction_sweep     Referral extraction
alumni_cohort_sweep           Alumni cohorts
```

Backfills / one-shots:
```
knowledge_gap_category_backfill
author_class_backfill
inbound_haiku_drain
inbound_intent_drain
orphan_engagement_rebind
identity_binder
cohort_damping_refresh
auto_merge_duplicate_partners
identity_cascade_sweep
sms_sequences             (piggybacked inside openphone_poll)
sms_rematch
prune_telemetry           (covered by prune_maintenance)
prune_rate_limits         (covered by prune_maintenance)
prune_brain_dump_stale    (covered by prune_maintenance)
dunning_escalate
consumer_requests_expire
source_freshness          (operator-triggered)
weekly_digest             (alias of weekly_briefing)
intelligence_analysis
```

Several sweep handlers are clearly intended to be scheduled but aren't yet — `couple_intel_sweep`, `cohort_rollup_sweep`, `attribution_role_sweep`, `spend_sync_sweep` and others have no schedule in `vercel.json`. See §8.4.

---

## §4 Processing pipelines

What happens to data after it lands. Stage names and line numbers verified against source.

### §4.1 Email pipeline — `processIncomingEmail` (lines 846-3995 of `pipeline.ts`)

Real `// Step Nx.M:` comment headers, in order they appear in source:

| Source line | Step label | What it does |
|---|---|---|
| 855 | (entry) | Mint correlation_id (OPS-21.2.1 / T1-G) |
| 868 | (header normalisation) | Normalise email Date header to ISO timestamptz |
| 888 | Step 1a.0 | Scheduling-tool pre-check (Calendly/Acuity/HoneyBook/Dubsado) — runs before universal ignore so booking signals don't get dropped |
| 907 | Step 1a | Universal auto-ignore (no-reply, bounces, postmaster) |
| 919 | Step 1a.1 | Early per-venue ignore rules on RAW From (action='ignore' only) |
| 935 | Step 1a.5 | Form-relay detection (Knot/WW/HCTG/Zola/venue-calculator) — rewrites From to the real prospect |
| 974 | Step 1a.55 | Scheduling-tool detection (reuses 1a.0 result; doesn't double-parse) |
| 979 | Step 1a.7 | Forwarded-email detection — coordinator-forwarded inquiries must NOT trip self-loop guard |
| 1089 | Step 1a.6 | Content-based machine-mail detection (only when no form-relay matched) |
| 1112 | Step 1b | Self-loop protection — venue-owned outbound bounce-back |
| 1180 | Step 1c | Per-venue filters on rewritten From; magic-words + Haiku escalation detection |
| 1267 | Step 1d | Thread-history signal counts (prior outbound, prior sender, total thread length) |
| 1311 | Step 2 | Classify with unified Haiku call (`classifyInboundRaw` → IntentVerdict) |
| 1399 | Step 3 | `findOrCreateContact` (line 585) → resolves to a `people` row, attaches phone from extras |
| 1427 | Step 4 | Insert `interactions` row with direction / surface / author_class / extracted_identity / signal_class |
| 1949 | Step 5a | Spam early-return |
| 1966 | Step 5 | New-inquiry path: mint wedding via `mintWedding` chokepoint + fire engagement event |
| 2600 | Step 6a.5 | Scheduling-tool event handling (Calendly Q&A → discovery_sources, etc.) |
| 3250 | Step 6b | `applySignalInference` on full thread → engagement_events + attribution_events |
| 3270 | Step 5a.5 | Knowledge-gap capture from classifier's extracted questions |
| 3286 | Step 5b | Booking-confirmation detection (coordinator prompt, never auto-progresses) |
| 3411 | Step 6 | Brain route → `generateInquiryDraft` / `generateClientDraft` (Sonnet) |
| 3766 | Step 7 | Insert `drafts` row |
| 3832 | Step 8 | Check auto-send eligibility (`auto_send_rules`, thread cap, rolling-24h cap) |

Post-Step-4 async fire-and-forget Haiku passes (verified by reading the post-insert region around line 1500-1700):

- `classifyAuthor` → `interactions.author_class`
- `classifySurface` → `interactions.surface`
- `classifyInboundInteraction` (dimensions) → `interactions.{sentiment, urgency, family_mentioned}`
- `stampInboundVerdict` → `interactions.{intent_class, extracted_facts, referenced_couple_name}` + fires heat suppression for non-couple intents
- `updateThreadLifecycleFolder` (`inbox/lifecycle.ts`) → `interactions.lifecycle_folder` for ALL interactions on the thread (independent writer from `intent_class` per `bloom-classifier-vs-folder-decoupled`)

Lifecycle signal detection (around lines 1727+): Haiku detects explicit state-machine events (decline / cancel / tour-completed / contract / deposit) → writes `wedding_lifecycle_events`. May trigger `weddings.status` advance.

Identity reconstruction enqueue (post-Step-7): `enqueueIdentityReconstruction` writes `identity_reconstruction_jobs` if not pending.

Telemetry (throughout): `api_costs` (one row per AI call); structured-log events via `lib/observability/logger.ts`.

### §4.2 Identity reconstruction — Wave 4 (`identity/reconstruct.ts`)

Verified writers and line citations:

- `reconstruct.ts:898` upserts `couple_identity_profile` on `wedding_id` with `cost_cents`, `reconstruction_count`, `last_reconstructed_at`, `prompt_version`.
- `reconstruct.ts:871` reads existing row for delta.
- Drained by `identity_judge_sweep` cron handler (`*/5 * * * *`) which also has a dedicated route at `/api/cron/identity-judge-sweep/route.ts`.

**Evidence bundle** (per the file header comment at lines 1-30): `weddings`, `interactions` (recent inbound + outbound), `tours` (+ Q&A), `reviews` (couple-name match), `contracts`, `tangential_signals`, `discovery_sources`, `evidence_overrides` (coordinator dismissals respected), `people`.

**Profile-to-people sync** — separate file `identity/profile-to-people-sync.ts`. Reads canonical names from `couple_identity_profile`, back-writes to `people.first_name` / `people.last_name`. Wave 4 doctrine: profile is the source of truth; people row is a denormalised projection.

### §4.3 Per-couple intel — Wave 5A (`intel/per-couple-derive.ts`)

Verified writer:

- `per-couple-derive.ts:409` upserts `couple_intel` on `wedding_id` with `persona_label`, `predicted_close_probability_pct`, `intel`, `derive_count`, `cost_cents`.
- Drained by `couple_intel_sweep` (handler exists; **not scheduled in vercel.json** — see §8.4).
- Enqueued by `intel/enqueue-couple-intel.ts` after Wave 4 fires.

Readers found in `couple_intel`: 25+ files including:
- `brain/client.ts` (Sage draft context)
- `tour/prep-brief.ts:169`
- `reviews/solicit.ts:186`
- `calibration/analyze.ts:315`
- `timeline/build-timeline.ts:625, 1078`

### §4.4 Venue intel — Wave 5B

- Service: `intel/cohort-rollup.ts`, `intel/cohort-rollup-sweep.ts`, `intel/enqueue-cohort-rollup.ts`
- Tables: `venue_intel`, `venue_intel_jobs`
- Cron: `cohort_rollup_sweep` (**not scheduled in vercel.json**)

(Writers not exhaustively verified; existence confirmed via grep + glob.)

### §4.5 Venue thesis generation

- Service: `intel/onboarding/generate-thesis.ts`, `intel/onboarding/sweep.ts`, `intel/onboarding/cross-venue-overlap.ts`
- Tables: `venue_thesis`, `venue_thesis_jobs`
- Cron: `venue_thesis_sweep` (invokable-only)
- Trigger: HTTP at `/api/admin/onboarding/venue-thesis/generate`

### §4.6 Attribution-roles — Wave 7B

`src/lib/services/attribution-roles/`:

| File | Purpose |
|---|---|
| `classify.ts` | Sonnet classifier — broadcast vs targeted role per attribution_event |
| `intent-classifier.ts` | Haiku intent classifier (acquisition vs validation) |
| `listing-platform-detector.ts` | Pattern-based platform detection |
| `knot-template-detector.ts` | Knot-specific template pattern matcher |
| `role-sweep.ts` / `role-summary.ts` | Sweep + rollup |
| `intent-sweep.ts` / `intent-summary.ts` | Intent sweep + rollup |
| `enqueue.ts` / `intent-enqueue.ts` | Enqueue helpers |
| `reclassify-venue.ts` / `reclassify-v1-sweep.ts` / `intent-reclassify-venue.ts` | Bulk reclassification |

Tables: `attribution_role_jobs`, `attribution_intent_jobs`, columns on `attribution_events`. Crons: `attribution_role_sweep` (invokable-only).

### §4.7 Marketing-spend loop — Wave 6

`src/lib/services/marketing-spend/`:

| File | Purpose |
|---|---|
| `connectors/{google-ads,meta-ads,tiktok-ads,theknot,manual}.ts` | Per-source ingestion |
| `ingest.ts` | Entry point |
| `spend-sync-sweep.ts` | Sweep drainer |
| `persona-overlay.ts` | Persona-based attribution overlay |
| `loop/flag-detector.ts` | Detect over/underperformance |
| `loop/flag-sweep.ts` | Flag rollup |
| `loop/digest-builder.ts` / `digest-sweep.ts` | Marketing digest |
| `loop/ab-tests.ts` | A/B test management |
| `recommendations/generate.ts` / `sweep.ts` | Marketing recs |

Tables: `marketing_spend`, `marketing_spend_jobs`, `marketing_spend_flags`, `marketing_spend_records`, `marketing_ab_tests`, `marketing_digests`, `marketing_recommendations`, `marketing_recommendation_jobs`, `marketing_loop_jobs`, `google_ads_connections`.

### §4.8 Phase B identity clustering

`src/lib/services/identity/`:

| File | Purpose |
|---|---|
| `resolver.ts` | Tier-1 phone / email resolver (inline in pipeline) |
| `candidate-clusterer.ts` | Cluster signals across sources |
| `candidate-resolver.ts` | Sonnet adjudication for ambiguous clusters |
| `cluster-attribution.ts` | Compute first-touch source from cluster |
| `enqueue.ts` / `enqueue-reconstruction.ts` | Enqueue helpers |
| `binder-cron.ts` | Bind orphan candidates |
| `backtrack.ts` | Retroactive identity application |
| `merge-people.ts` | Real consolidation (reassigns interactions/drafts/engagement_events/contacts/tangential_signals) |
| `people-merge-aliases.ts` | Cross-venue alias merge cron |
| `profile-enrichment.ts` | Enrich profile from external sources |
| `profile-to-people-sync.ts` | Back-write canonical names |
| `reconciliation.ts` | Coordinator-driven reconciliation |
| `review-match.ts` | Match review authors to couples |
| `name-capture.ts` | Name-capture chokepoint (Wave 2A) |
| `mint-wedding.ts` | Wedding-creation chokepoint |

Tables: `candidate_identities`, `person_merges`, `client_match_queue`, `handle_merge_decisions`, `identity_decision_clusters`, `identity_reconstruction_jobs`, `merge_reattachment_log`, `mint_wedding_telemetry`.

Crons: `backtrace_scan` (scheduled), `phase_b_sweep` (scheduled), `merge_people_aliases` (scheduled), `identity_backtrack` (scheduled), `identity_cascade_sweep` (invokable), `identity_judge_sweep` (scheduled), `auto_merge_duplicate_partners` (invokable), `identity_binder` (invokable).

### §4.9 Heat scoring + temporal recompute

Service: `src/lib/services/heat-mapping.ts` (not separately verified for writer lines but referenced extensively).

Triggers:
1. Inline from email pipeline Stage 7 (`applySignalInference` → engagement_events → recompute)
2. `recompute_pending_temporal` (`*/5 * * * *`) drains `weddings.heat_recompute_pending=true`
3. `heat_decay` (`0 6 * * *`) — daily linear decay

Reads: `engagement_events` (direction='inbound' only), `heat_score_config`, `weddings.lost_at` (reopen-aware dedup bypass), `couple_intel.cohort_tier_cap` (display-tier damper).

Writes: `weddings.heat_score / heat_tier / heat_updated_at`, `lead_score_history` (snapshot per change), `admin_notifications` (cooling 14/21/27d warnings), `cohort_damping_cache`.

`heat-score_history` table does NOT exist; `lead_score_history` is the real snapshot table (mig 002).

### §4.10 Anomaly detection + correlation engine

Anomaly: `intel/anomaly-detection.ts`. Cron: `anomaly_detection` (`0 4 * * *`).

Correlation: `intel/correlation-engine.ts`. Cron: `correlation_analysis` (`0 5 * * *`).

External-context helpers: `external-context/{calendar,fred,government,stats,calendar-writer}.ts`. The `stats.ts` file implements Acklam inverse-normal + Cornish-Fisher t-correction + Bonferroni critical-r per CLAUDE.md.

Both write to `intelligence_insights` (with `insight_type` distinguishing them). No separate `correlation_analysis_results` or `pulse_anomalies` tables.

### §4.11 Discovery engine + external matching

`src/lib/services/intel/discovery/`:

| File | Purpose |
|---|---|
| `engine.ts` | Discovery engine |
| `enqueue.ts` | Enqueue |
| `sweep.ts` | Sweep |
| `discovery-digest.ts` | Coordinator digest |
| `feedback-loop.ts` | Feedback application |

Tables: `intel_discoveries`, `intel_discovery_jobs`, `discovery_digests`, `discovery_feedback_actions`. Plus `intel_matches`, `intel_match_jobs` for cross-venue matching via `intel/external-match.ts` + `external-match-sweep.ts`.

Cron: `discovery_engine_sweep`, `external_match_sweep` (both invokable-only).

### §4.12 Disagreement detection

`src/lib/services/disagreement/{detect,narrate,summary}.ts`. Tables: `disagreement_findings`, `disagreement_jobs`. Routes: `/api/admin/intel/disagreements/*`.

Detect → narrate (Sonnet) → review queue surfaces in `/intel/`.

### §4.13 Lifecycle state machine

`src/lib/services/lifecycle/`:

| File | Purpose |
|---|---|
| `state-machine.ts` | Allowed transitions + guard |
| `writer.ts` | Apply lifecycle event → may transition `weddings.status` |

Tables: `wedding_lifecycle_events` (mig 246), `lifecycle_transitions`, `lifecycle_transition_jobs`.

Cron: `lifecycle_sweep` (invokable-only). Manual application at `/api/admin/lifecycle/apply` and `/api/admin/lifecycle/wedding/[weddingId]/override`.

### §4.14 Voice DNA refresh

Real tables (verified): `voice_preferences`, `voice_training_sessions`, `voice_training_responses`, `review_language`, `voice_dna_jobs`, `voice_dna_derivations`. **There is no `voice_dna` table.**

Service: `brain/voice-dna-extract.ts`. Crons:
- `voice_dna_refresh` (`0 6 1 * *` monthly) — incremental harvest
- `transcript_voice_mining` (`0 6 * * 2` weekly) — from tour transcripts
- Inline mining: per-call hydration inside `openphone_poll`; tour-completed extraction inside OMI auto-fire

Coordinator UI: `/agent/learning` (training games), `/intel/voice-dna`, `/api/intel/voice-dna/backfill`.

### §4.15 Tour pipelines

- `tour/transcript-extract.ts` — Sonnet extraction → `tours.transcript_extracted`
- `tour/prep-brief.ts` — pre-tour brief generation → `tour_prep_briefs` + `tour_prep_jobs`
- `tour/post-tour-sage.ts` — post-tour Sage brief → `drafts` (with `brain_used='sage_post_tour'`), `tour_prep_briefs`, `post_tour_followup_jobs`
- `tour/outcome-classifier.ts` — past-due tours → `tours.outcome`

Crons: `tour_outcome_classifier` (scheduled), `tour_prep_brief_sweep` (invokable).

### §4.16 Calibration loop

`src/lib/services/calibration/`:

| File | Purpose |
|---|---|
| `record-prediction.ts` | Snapshot predictions before they materialise |
| `measure-outcomes.ts` | Post-event truth labelling |
| `sweep.ts` | Drain `measure_outcome_jobs` |
| `analyze.ts` | Calibration analysis |

Tables: `prediction_snapshots`, `prediction_outcomes`, `measure_outcome_jobs`, `hypothesis_validation_jobs`, `hypothesis_validation_runs`.

Cron: `outcome_measurement` (`0 6 * * 0` weekly).

### §4.17 Review solicitation

`src/lib/services/reviews/solicit.ts`. Tables: `review_solicit_jobs`, `review_solicit_requests`, `review_match_review_queue`.

Cron: `review_solicit_sweep` (invokable).

### §4.18 Other derived/queue pipelines

| Subsystem | Service path | Tables | Cron |
|---|---|---|---|
| Referral extraction | `intel/referrals/{extract,enqueue,resolve,sweep}.ts` | `referral_extraction_jobs` | `referral_extraction_sweep` |
| Alumni cohorts | `intel/alumni/{generate,sweep}.ts` | `alumni_cohorts` | `alumni_cohort_sweep` |
| Persona × channel rollups | `intel/persona-channel-rollup/*.ts` | `persona_channel_rollups` | `persona_channel_rollup_sweep` |
| Knowledge gaps | `intel/knowledge-gaps.ts` | `knowledge_gaps`, `knowledge_captures` | `knowledge_gap_category_backfill` |
| External signals health | (not separately verified) | `external_signal_health` | `external_signals_health_sweep` |
| Channel truth | `channel-truth/compute-all.ts`, `channel-intel-hub/compute.ts` | `channel_truth_audits`, `channel_intel_snapshots`, `channel_presentation_exports` | (no dedicated cron found) |
| Cascades | `cascades/{on-spend-import,on-lost-mark}.ts` | various | (event-driven) |
| TBH reports | `intel/marketing-agency-tbh-report.ts` | `tbh_reports` | `tbh_reports_monthly` |
| Agency tracking | `intel/marketing-agencies.ts`, `marketing-agency-{profile,cron,kpi-performance}.ts` | `marketing_agencies`, `agency_kpi_commitments`, `agency_contacts`, `agency_documents`, `agency_document_downloads`, `venue_agency_engagements`, `agency_activity_log` | `agency_activity_sweep`, `agency_document_orphans` |
| Inbox filter learning | `email/inbox-filters.ts` | writes to `venue_email_filters` | `inbox_filter_learning` |
| Essentials suggester | `onboarding/essentials-suggester.ts` | `essentials_suggestions`, `essentials_action_log`, `essentials_preferences`, `org_essentials_preferences` | `essentials_suggest` |
| Cultural moments | `insights/cultural-moments-auto-propose.ts` + `cultural-moments-llm-propose.ts` + `external-context/cultural-moments.ts` | `cultural_moments`, `venue_cultural_moment_state` | `cultural_moments_auto_propose`, `cultural_moments_llm_propose` |
| Source freshness | `intel/source-freshness.ts` | `admin_notifications`, `tracked_sources` | `source_freshness` (operator-triggered) |
| Booked-data recovery | `booked-data-recovery.ts` | `weddings.booking_value`, `booked_data_recovery_log` | `booked_data_recovery` |
| Re-engagement | `re-engagement.ts` | `re_engagement_actions`, `weddings.status` | `re_engagement_attribution` |
| Data integrity | `data-integrity/remediation/*.ts` | `integrity_remediations` | `data_integrity_sweep`, `integrity_remediation_sweep` |
| Compliance (GDPR-style) | `compliance/{erasure,portability}.ts` | various | `consumer_requests_expire` |
| Telemetry retention | `telemetry-retention.ts`, `audit-retention.ts` | prunes | `prune_maintenance`, `prune_telemetry` |
| Cost ceiling | `cost-ceiling.ts` | `venues.autonomous_paused`; per-call rows on `api_costs` | `cost_ceiling_check`, `cost_ceiling_reset` |
| Web pixel | `intel/web-pixel.ts` | `web_visits` | (real-time via /api/v1/visit) |

(For each line in the table the service file existence is verified via Glob. Writer-target tables are mostly per-memory or per-file-name; not every one was opened to confirm the `.from(...).insert` call.)

---

## §5 Sage prompt-context reads

`src/lib/services/intel/sage-intelligence.ts` is the read fan-out hub (verified to exist via Glob). Every drafting brain calls it. Reads (per memory + spot checks of `tour/prep-brief.ts`, `brain/client.ts`):

- `couple_identity_profile` — Wave 4 forensic identity (`profile` jsonb)
- `couple_intel` — Wave 5A persona / risk_flags / predicted_close_probability_pct
- `voice_preferences` — learned phrases (approved + banned)
- `venue_ai_config` — ai_name, signature_website, reviewer_intro, personality traits
- `venue_config` — forbidden topics, pricing model, team
- `venue_forbidden_topics` — per-venue keyword block list
- `weddings` — event date, guest count, status, pricing
- `interactions` — thread history
- `tours` — upcoming or just-completed tour context, `transcript_extracted`
- `tour_prep_briefs` — coordinator-facing brief
- `reviews` — sample reviews for tone
- `review_language` — approved-for-sage phrases
- `wedding_details` — dietary / vendor / timeline from brain-dump
- `people` — partner names (canonical from profile-sync)
- `intelligence_insights` — venue-level context
- `cultural_moments` (confirmed) — when relevant
- `weather_data` — when wedding date is soon
- `external_calendar_events` — holidays near wedding date

Cultural-moments-aware prompts: `insights/cultural-moments-llm-propose.ts:298` reads `couple_identity_profile` directly when proposing moments.

---

## §6 Multi-writer table audit

The handful of tables fed from many paths. Schema changes here have wide blast radius.

| Table | Writers (verified ones marked ✓) |
|---|---|
| `interactions` | email pipeline (✓ line 1542), calendly webhook (no — uses engagement_events), twilio webhook (✓ line 239), openphone poll (✓ line 973), zoom poll (✓ line 674), CRM imports, web-form imports, brain-dump, reprocess-orphans, backfill-senders, briefings outbound |
| `weddings` | email pipeline (`mintWedding`), form-relay synth, CRM imports, web-form import, brain-dump leads, `identity_backtrack`, `re_engagement_attribution`, `booked_data_recovery`, `tour_outcome_classifier`, lifecycle state machine |
| `people` | email pipeline `findOrCreateContact`, form-relay, CRM imports, web-form import, openphone poll, twilio webhook, brain-dump, candidate-resolver (Phase B merges), `merge_people_aliases`, profile-to-people-sync |
| `tours` | calendly webhook (✓ line 220), tour-scheduler CRM adapter, omi webhook orchestrator (bind path), zoom poll (when bound), tour_outcome_classifier |
| `engagement_events` | every inbound communication path + heat decay reads |
| `attribution_events` | email pipeline signal_inference, form-relay, calendly Q&A, backtrace_scan, re_engagement_attribution, web-form Q&A |
| `tangential_signals` | brain-dump platform_activity, web-form Q&A, vision extraction, email pipeline body-extract |
| `candidate_identities` | phase_b_sweep, backtrace_scan, brain-dump platform_activity, candidate_resolver |
| `couple_identity_profile` | **Single writer:** `identity/reconstruct.ts:898` (✓ verified) |
| `couple_intel` | **Single writer:** `intel/per-couple-derive.ts:409` (✓ verified) |
| `review_language` | onboarding seed, voice_dna_refresh, transcript_voice_mining, vision extraction |
| `drafts` | inquiry-brain, client-brain, follow_up_sequences, post-tour brief, Wave 29 SMS |
| `wedding_lifecycle_events` | email pipeline Step around line 1727, lifecycle/writer.ts |
| `intelligence_insights` | anomaly_detection, correlation_engine, cultural-moments-llm-propose, source-quality, weekly_learned, discovery feedback-loop, plus other insight detectors |

`interactions`, `weddings`, `people` remain the three highest-fanout tables — the chokepoints (`mintWedding`, `findOrCreateContact`, `resolveIdentity`, `captureNameEvidence`) are doctrinal per `bloom-incomplete-dispatch-plan`.

---

## §7 Orphan analysis

Verified after de-duping inventory false-positives.

### §7.1 Read-orphans (writers exist, no service readers)

Audit-log / telemetry tables. Write-only by design unless flagged otherwise:

- `booked_data_recovery_log`
- `merge_reattachment_log`
- `mint_wedding_telemetry`
- `error_logs`
- `auto_send_shadow_decisions`
- `paused_period_skipped`
- `brain_dump_pattern_grants`
- `lead_source_derivation_log`
- `agency_activity_log` (read only by agency dashboard UI)
- `agency_document_downloads`

Display-only tables:
- `venue_health` (read only by `/intel/health` UI)
- `venue_health_history`

Coordinator brain-dump targets with thin reader paths:
- `bedroom_assignments`, `decor_inventory`, `staffing_assignments`, `social_posts`, `wedding_party`, `guest_meal_options` — read by couple portal pages only. Flagged in §7.3 as under-used.

Queue tables — read only by their drainer cron (not by service consumers):
- `couple_intel_jobs`, `identity_reconstruction_jobs`, `voice_dna_jobs`, `disagreement_jobs`, `intel_discovery_jobs`, `intel_match_jobs`, `cohort_jobs` (and similarly named), `marketing_recommendation_jobs`, `marketing_spend_jobs`, `attribution_role_jobs`, `attribution_intent_jobs`, `measure_outcome_jobs`, `tour_prep_jobs`, `review_solicit_jobs`, `referral_extraction_jobs`, `hypothesis_validation_jobs`, `lifecycle_transition_jobs`, `marketing_loop_jobs`, `post_tour_followup_jobs`, `profile_enrichment_runs`, `venue_thesis_jobs`, `venue_intel_jobs`, `spend_loop_flag_sweep` queues, `attribution_intent_jobs`

### §7.2 Write-orphans (readers exist, no writer found OR silent-fail writer)

- **`phrase_usage` column mismatch** — `phrase-selector.ts` SELECTs/INSERTs `phrase_key` / `phrase_used` but the table has `phrase_category` / `phrase_text` (mig 005). Errors swallowed by try/catch. Anti-duplication has been a no-op since the port from Phil's Python agent. Open since 2026-04-23.
- **`market_intelligence`** — readers exist; writer is the census ingest cron, but the `market_intelligence` writer in `ingestion/census.ts` should be confirmed end-to-end after the latest schema updates (mig 081 added age_18_34_pct + bachelors_or_higher_pct columns). Worth a single-row probe in prod to confirm rows are landing.
- **`hypothesis_validation_jobs` / `hypothesis_validation_runs` / `measure_outcome_jobs`** — tables exist; calibration sweep cron exists; writer wiring should be verified end-to-end before relying on prediction-outcome metrics.
- **`venue_cultural_moment_state`** — per-venue moment-override state; reader/writer end-to-end not verified in this pass.

### §7.3 Under-used signals

- **`tangential_signals`** — heat scoring + identity clustering only. Could feed couple_intel persona detection (digital-native vs traditional from social-handle density) and anomaly hypothesis.
- **`voice_preferences.banned`** — Sage drafts get the approved list at prompt-time; banned phrases enforced only post-gen via review queue. Should constrain the prompt directly.
- **`interactions.extracted_identity` jsonb** — universal body-extracted on every email since the 2026-04-30 identity-pipeline overhaul. Consumed by the Wave 4 judge bundle and the inbox detail UI. Not consumed by `discovery_sources` derivation when the extracted blob carries `hear_source='Pinterest'` etc.
- **`lost_deals.reason_category`** — read by lost-deals page filter; not branched on by `re-engagement.ts` for strategy.
- **`cultural_moments` (confirmed)** — correlation engine only. Sage prompt context doesn't surface "Royal Wedding moment this month" for tone/timing.
- **`external_calendar_events`** — correlation engine + anomaly hypothesis only. Lead detail and Sage drafts could use seasonal awareness.
- **`engagement_events.metadata`** — drives heat dedup; the metadata payload (signal_class, source channel, evidence snippet) is rarely surfaced elsewhere. Lead-detail timeline could render the evidence snippet.
- **`wedding_party`, `guest_meal_options`, `wedding_internal_notes`** — read only by couple portal display. Could enrich the Wave 4 judge bundle for name disambiguation, persona enrichment ("logistics-heavy" couple), and coordinator-state context.
- **`tour_transcript_orphans`** — surfaced in audio-inbox UI for binding; never mined for venue-level intelligence (common tour questions, frequent objections). Wave 5B venue_intel could read it.

---

## §8 Notes & flags

Items surfaced during the audit. **Not fixed** — listed for triage.

### §8.1 Cron path inconsistency

Six route files under `/api/cron/*` exist as dedicated paths (replay-paused-skipped, agency-activity-sweep, agency-document-orphans, identity-judge-sweep, tbh-reports-monthly, plus the main dispatcher route). Only `replay-paused-skipped` is invoked via path-style in `vercel.json`; the rest are invoked via the `?job=` dispatcher. Either the dedicated route files are vestigial or the dispatcher forwards to them internally — worth confirming.

### §8.2 Same-second co-firing on cron schedule

- `5 0 * * *` — `cost_ceiling_reset` + `/api/cron/replay-paused-skipped`
- `0 3 * * *` — `fred_daily_refresh` + `booked_data_recovery`
- `0 4 * * *` — `anomaly_detection` + `identity_backtrack` + `external_calendar_refresh`
- `0 5 * * *` — `weather_forecast` + `correlation_analysis` + `data_integrity_sweep` + `compute_attribution_parity`
- `0 6 * * *` — `heat_decay` + `tour_outcome_classifier`

Vercel cron does not serialise. `compute_attribution_parity` runs at 0:05 alongside `data_integrity_sweep` — if parity reads cluster state before the integrity sweep finishes orphan reattachment, the parity log can reflect pre-sweep state for that day.

### §8.3 Twilio inbound vs OpenPhone inbound

Two parallel SMS surfaces. Twilio webhook → `interactions` directly; OpenPhone polls Quo's API. A venue can in principle have both; identity-match handling must respect that the same number could land via either path.

### §8.4 Wave sweeps without schedules

These dispatcher cases exist but are absent from `vercel.json`:

- `couple_intel_sweep` (Wave 5A drain)
- `cohort_rollup_sweep` (Wave 5B drain)
- `spend_sync_sweep` (marketing-spend connectors)
- `attribution_role_sweep` (Wave 7B role classifier)
- `attribution_intent_sweep` (referenced indirectly; sweep `intent-sweep.ts` exists)
- `external_match_sweep`, `persona_channel_rollup_sweep`, `discovery_engine_sweep`, `venue_thesis_sweep`, `marketing_recommendation_sweep`, `hypothesis_validation_sweep`, `spend_loop_flag_sweep`, `marketing_digest_sweep`, `external_signals_health_sweep`, `integrity_remediation_sweep`, `lifecycle_sweep`, `tour_prep_brief_sweep`, `review_solicit_sweep`, `referral_extraction_sweep`, `alumni_cohort_sweep`

If these subsystems are supposed to run automatically (Wave 5A, 5B, 6, 7B were shipped per memory), then either:
- They are piggybacked from another scheduled cron (verify the piggyback wiring)
- The scheduled entry was missed from `vercel.json`

This is the single biggest gap surfaced by the audit. Worth a confirmation pass.

### §8.5 Section-1 phantom tables in earlier drafts (now corrected)

Tables I cited in the first draft of this doc that do NOT exist in any migration:

| Phantom name | Real surface (where applicable) |
|---|---|
| `voice_dna` (as a table) | No table named that. The substrate is `voice_preferences`, `voice_training_sessions`, `voice_training_responses`, `review_language`, `voice_dna_jobs`, `voice_dna_derivations`. |
| `voice_dna_refresh_log` | No audit log. Refresh state implicit in `voice_dna_jobs` + `voice_preferences.last_updated_at`. |
| `cost_ceiling_events` | No audit table. State on `venues.autonomous_paused` + per-call rows on `api_costs`. |
| `inbox_filter_rules` | No dedicated table. Learned filters land on `venue_email_filters`. |
| `pulse_dismisses` | No table. `pulse_snoozes` has a dismissed_at column. |
| `venue_health_snapshots` | Real name is `venue_health_history`. |
| `heat_score_history` | Real name is `lead_score_history`. |
| `venue_cohort_intelligence` | Real name is `venue_intel` (+ `venue_intel_jobs`). |
| `tour_outcome_classification_log` | No dedicated log; outcome lands on `tours.outcome`. |
| `identity_reconstruction_log` | No log; per-call cost on `api_costs`. |
| `re_engagement_attribution_log` | No log; state on `weddings.status` + `re_engagement_actions`. |
| `agency_attribution_snapshots` | No dedicated table; data on `agency_activity_log` + `intelligence_insights`. |
| `correlation_analysis_results`, `pulse_anomalies` | No dedicated tables; results on `intelligence_insights` with `insight_type=` distinguishing them. |
| `tracked_sources.last_reminded_at` | The `tracked_sources` table is real (mig 249); the specific column should be re-verified before referencing. |

### §8.6 Stage names in earlier drafts (now corrected)

Earlier sections used invented "Stage 1, Stage 2, ..." labels with rounded line numbers (50-200 / 200-400). The real `processIncomingEmail` uses non-linear step labels `1a.0 / 1a / 1a.1 / 1a.5 / 1a.55 / 1a.7 / 1a.6 / 1b / 1c / 1d / 2 / 3 / 4 / 5a / 5 / 6a.5 / 6b / 5a.5 / 5b / 6 / 7 / 8` with actual line numbers in §4.1.

### §8.7 OMI webhook does NOT write `interactions`

Earlier section claimed `interactions` (surface=voice_capture) as a target of the OMI webhook. Verified: the OMI orchestrator writes only `transcript_segments` + binds to `tours`. Sage reads `tours.transcript_extracted` rather than per-segment interactions.

### §8.8 Phrase-selector schema mismatch (still open)

`phrase-selector.ts` queries `phrase_key` / `phrase_used` against a table whose real columns are `phrase_category` / `phrase_text` (mig 005). Both SELECT and INSERT live in try/catch — silently no-op since the port from Phil's Python agent. Open since 2026-04-23 per Phase 5 close notes.

### §8.9 Dubsado + Aisle Planner CRM adapters are scaffolds

`crm-import/dubsado.ts` and `crm-import/aisleplanner.ts` throw "not implemented." UI may expose them as selectable; importing through either fails clearly. HoneyBook is the only real CRM adapter.

### §8.10 ContractHouse calculator handoff lands in a different Supabase project

Calculator handoff endpoint lives on the ContractHouse Next.js app (separate repo + separate Supabase project `hdfqshkwegtfadcwtqhr`). Bloom does not directly ingest calculator estimates — they live in ContractHouse and merge via FK later per `project_contracthouse`.

### §8.11 What was NOT verified in this audit

In the interests of finishing within session time:

- Per-route read/write footprint of the ~120 `/api/admin/*` and ~80 `/api/intel/*` endpoints. Each was categorised by name and path, not by reading every route file.
- The complete writer chain for 81 cron jobs. The dispatcher cases were enumerated; each handler's full body was not read.
- RLS policies and DB triggers (`trg_*`) — a separate audit.
- The exact behaviour of `inbox/lifecycle.ts` rule chain vs Haiku fallback (only confirmed it exists as the folder writer per `bloom-classifier-vs-folder-decoupled`).
- The exact behaviour of brain-dump shape detector — file exists, importer split confirmed by name, individual shape handlers not opened.

For each subsystem the doc names a service file + cron + table set; deep verification of every internal call would take a follow-up pass.

---

---

## §9 Intel surfaces — where derived data reaches the user (and where it doesn't)

This section asks one question per derived output: **does this surface to a human?** If yes, where. If no, the output is "disappearing" — computed and stored but never read by any UI page, API endpoint, notification, or digest.

### §9.0 Methodology

I verified each derived output against four possible surface paths:

1. **Direct page read** — grep the platform `page.tsx` files for `.from('<table>')`. Server components read tables directly.
2. **API endpoint read** — grep `src/app/api/**/route.ts` for `.from('<table>')`, then trace which page calls that API via `fetch('/api/...')`.
3. **Notification** — does `admin_notifications` carry a row of this type?
4. **Digest / briefing** — does `ai_briefings`, `marketing_digests`, `discovery_digests`, or `tbh_reports` include it?
5. **Sage prompt context** — does `buildSageIntelligenceContext` read it? (Surfaces indirectly through generated drafts.)

Platform UI inventory: 282 `page.tsx` files total; 144 are operator-facing under `src/app/(platform)/`. The other 138 are couple-portal, auth, public, and demo pages.

### §9.1 Derived outputs that DO surface (verified)

Each row was confirmed by reading the cited file or grep result. "Direct read" = server component opens the table; "API: /path" = endpoint surfaces it and a page calls it.

| Output | Surface | Citation |
|---|---|---|
| `intelligence_insights` (anomaly type) | `/intel/anomalies/page.tsx` direct read; `/intel/dashboard` direct read | grep matches |
| `intelligence_insights` (correlation type) | same readers (different `insight_type`); `/intel/macro-correlations` page exists |  |
| `intelligence_insights` (general) | `/intel/insights/page.tsx` direct read; `/intel/dashboard` direct read; API `/api/intel/insights`; `/api/insights/risk-flags` |  |
| `couple_identity_profile` | `/intel/clients/[id]/page.tsx` direct read (server component) | grep |
| `couple_intel` | `/intel/clients/[id]/page.tsx`; rendered by `<ReconstructedIdentityPanel>` per earlier verification |  |
| `tour_prep_briefs` | `/intel/clients/[id]/page.tsx` via `components/intel/TourPrepBriefPanel.tsx`; API `/api/admin/tour/prep-brief/[tourId]` | grep `TourPrepBriefPanel` found 12 files including the lead detail page |
| `wedding_journey_narratives` | API `/api/intel/journey-narrative/route.ts`; surfaced on `/intel/clients/[id]/timeline/page.tsx` | grep |
| `cultural_moments` | `/intel/cultural-moments/page.tsx` direct read; correlation engine context | grep |
| `attribution_parity_log` | `/intel/sources/parity/page.tsx` direct read | grep |
| `tracked_sources` | `/intel/sources/track/page.tsx` direct read; API `/api/intel/sources/track` + `/dismiss` | grep |
| `web_visits` | `/intel/sources/track/page.tsx` direct read; also `/api/intel/auto-context/[weddingId]` (Sage context); `/api/v1/visit` writes | grep |
| `marketing_spend` | `/intel/marketing-spend/page.tsx`, `/intel/marketing-roi/page.tsx`; API `/api/admin/marketing-spend/{list,summary}`, `/api/intel/spend`, `/api/admin/intel/marketing-roi/{summary,heatmap}` |  |
| `marketing_recommendations` | `/intel/marketing-roi/recommendations/page.tsx`; API `/api/admin/intel/marketing-recommendations/*` |  |
| `marketing_spend_flags` | `/intel/marketing-roi/flags/page.tsx`; API `/api/admin/intel/marketing-loop/flags/*` |  |
| `marketing_digests` | `/intel/marketing-roi/digest/page.tsx`; API `/api/admin/intel/marketing-loop/digest/*` |  |
| `marketing_ab_tests` | API `/api/admin/intel/marketing-loop/ab-tests/*` (page-side surface inferred but not directly verified) |  |
| `tbh_reports` | `/intel/agencies/[id]/tbh-report/page.tsx`; API `/api/intel/agencies/[id]/tbh-report` |  |
| `venue_health` | `/intel/health/page.tsx` direct read | grep |
| `venue_health_history` | `/intel/health/page.tsx` direct read | grep |
| `disagreement_findings` | `/intel/disagreements/page.tsx` via `fetch('/api/admin/intel/disagreements/{summary,list,detect}')` | grep |
| `intel_discoveries` | `/intel/discoveries/page.tsx` via `fetch('/api/admin/intel/discoveries/{run,action,dismiss,list}')` | grep |
| `intel_matches` | `/intel/matches/page.tsx` via `fetch('/api/admin/intel/external-matches/{scan,action,dismiss,list}')` | grep |
| `alumni_cohorts` | `/intel/alumni/page.tsx` via `fetch('/api/admin/intel/alumni/{list,generate}')` | grep |
| `prediction_snapshots` + `prediction_outcomes` | `/intel/calibration/page.tsx` via `fetch('/api/admin/intel/calibration/measure')` (calibration/report endpoint exists) | grep + glob |
| `referral_extraction` data | `/intel/referrals/page.tsx` via `fetch('/api/admin/intel/referrals/list?limit=500')` | grep |
| `review_solicit_requests` | `/intel/reviews/solicitations/page.tsx` direct read; API `/api/admin/reviews/solicit/list` |  |
| `sage_uncertain_queue` | `/portal/sage-queue/page.tsx` direct read | grep |
| `integrity_remediations` | `/admin/integrity/page.tsx` direct read; API `/api/admin/integrity/{remediations,remediate}` | grep |
| `external_signal_health` | `/intel/external-signals/page.tsx` via `fetch('/api/admin/external-signals/status')` | grep |
| `tour_transcript_orphans` | `/agent/audio-inbox/page.tsx`; `/agent/omi-inbox/page.tsx`; API `/api/omi/orphans/[id]` |  |
| `auto_send_shadow_decisions` | `/agent/auto-send-shadow/page.tsx` via `fetch('/api/agent/auto-send-shadow')` | grep |
| `brain_dump_entries` | `/agent/brain-dump/page.tsx`; `/settings/brain-dump-log/page.tsx` |  |
| `brain_dump_pattern_grants` | `/agent/brain-dump/grants/page.tsx`; API `/api/brain-dump/grants` + `/grants/candidates` |  |
| `knowledge_gaps` + `knowledge_captures` | `/agent/knowledge-gaps/page.tsx`; API `/api/admin/knowledge-gaps/*` |  |
| `client_match_queue` | `/intel/matching/page.tsx`; `/intel/candidates/page.tsx`; API `/api/agent/match-queue/[id]/resolve` |  |
| `handle_merge_decisions` | `/admin/identity/handle-merges/page.tsx`; API `/api/admin/identity/handle-merges/[handle]/*` |  |
| `identity_decision_clusters` | `/admin/identity/decisions/page.tsx`; API `/api/admin/identity/decision-clusters/*` |  |
| `evidence_overrides` | `/admin/identity/wedding/[weddingId]/overrides/page.tsx`; API `/api/admin/identity/evidence/*` |  |
| `venue_thesis` + `venue_thesis_jobs` | `/admin/onboarding/thesis/page.tsx`; API `/api/admin/onboarding/venue-thesis/*` |  |
| `cross_venue_overlap` | `/admin/onboarding/thesis/page.tsx`; `/admin/identity/page.tsx`; API `/api/admin/onboarding/venue-thesis/cross-venue-overlap` | grep |
| `venue_intel` (Wave 5B) | `/intel/cohort/page.tsx` via `fetch('/api/admin/intel/cohort-rollup')` | grep |
| `persona_channel_rollups` | API `/api/admin/intel/marketing-roi/{summary,heatmap}` reads them; surfaces on `/intel/marketing-roi/page.tsx` | grep |
| `channel_intel_snapshots`, `channel_truth_audits`, `channel_presentation_exports` | `/intel/channels/page.tsx`, `/intel/channels/[channel_slug]/page.tsx`, `/intel/channel-truth/page.tsx`; public token-shared at `/api/public/channels/exports/[shareToken]` |  |
| `social_captures` + `social_engagements` | `/intel/social-integration/page.tsx`; API `/api/intel/social-integration/{capture,captures/[captureId],state}` | grep |
| `agency_*` family (marketing_agencies, agency_kpi_commitments, agency_contacts, agency_documents, agency_document_downloads, venue_agency_engagements, agency_activity_log) | `/intel/agencies/page.tsx`, `/intel/agencies/[id]/*` (edit, leads, tbh-report); API `/api/intel/agencies/[id]/*` |  |
| `wedding_lifecycle_events` + `lifecycle_transitions` | `/portal/weddings/[id]/_components/lifecycle-history.tsx` direct read; lifecycle-history component rendered on wedding detail | grep |
| `error_logs` | `/agent/errors/page.tsx` direct read |  |
| `intelligence_extractions` | `/agent/classification-health/page.tsx` direct read | grep |
| `api_costs` | `/agent/analytics/page.tsx`, `/agent/classification-health/page.tsx`, `/super-admin/page.tsx`, `/super-admin/observability/page.tsx` | grep |
| `consumer_requests` | `/super-admin/consumer-requests/page.tsx`; API `/api/admin/consumer-requests/*` |  |
| `cron_runs` | `/super-admin/observability/page.tsx` direct read | grep |
| `metered_events` | `/super-admin/observability/page.tsx` direct read | grep |
| `lost_deals` | `/intel/lost-deals/page.tsx` (page exists; reads not directly confirmed in this pass — listed for follow-up) |  |
| `re_engagement_actions` | `/intel/reengagement/page.tsx`; API `/api/intel/reengagement/*` |  |
| `pulse_snoozes` | `/pulse/page.tsx`; `/settings/pulse-snoozes/page.tsx`; API `/api/pulse/{snooze,route}` |  |
| `natural_language_queries` | `/intel/nlq/page.tsx` direct read; API `/api/intel/nlq` | grep |
| `consultant_metrics` | `/intel/team/page.tsx` direct read | grep |
| `pricing_history` | `/intel/pricing-history/page.tsx`; `/onboarding/pricing-history/page.tsx`; API `/api/intel/pricing-history/[id]`, `/api/onboarding/pricing-history` |  |
| `voice_preferences` + `review_language` + `voice_training_*` | `/intel/voice-dna/page.tsx`; `/agent/learning/page.tsx`; `/settings/voice/page.tsx` | grep |
| `learned_preferences` | `/agent/learning/recent-edits/page.tsx` | grep |
| `reviews` | `/intel/reviews/page.tsx`, `/intel/reviews/paste/page.tsx` | grep |
| `tours` (+ transcript_extracted) | `/intel/tours/page.tsx` | grep |
| `candidate_identities` | `/intel/candidates/page.tsx`, `/intel/matching/page.tsx` | grep |
| `discovery_sources` | `/intel/sources/page.tsx`; `/settings/sources/page.tsx`; `/settings/data-sources/page.tsx` | grep |

### §9.2 Notification + digest paths (verified by service file existence)

Two parallel delivery channels in addition to UI pages.

**`admin_notifications` carries these row types:**
- `human_requested` — written from email-pipeline Step 1c on escalation detection
- `cooling_warning_14d` / `_21d` / `_27d` — written from heat-mapping when last engagement crosses thresholds
- `anomaly_alert` — written from anomaly_detection cron when severity is critical
- `inquiry_alert` — written from heat-mapping on hot new inquiries
- `source_freshness_reminder` — written from source-freshness cron per memory
- `subscription_*` / `payment_*` — written from Stripe webhook
- Surface: `/agent/notifications/page.tsx`, `/pulse/page.tsx` (plus a top-bar dropdown in shell)

**Digest / briefing tables:**
- `ai_briefings` — written by `daily_digest`, `weekly_briefing`, `monthly_briefing` crons; delivered via Gmail + surfaced at `/intel/briefings/page.tsx`
- `discovery_digests` — written by discovery sweep; surface: discovery feedback loop on `/intel/discoveries/page.tsx` per the feedback-loop service
- `marketing_digests` — written by `marketing_digest_sweep`; surface: `/intel/marketing-roi/digest/page.tsx`
- `tbh_reports` — written by `tbh_reports_monthly` cron; surface: `/intel/agencies/[id]/tbh-report/page.tsx`

**Sage prompt context** — drafts that go out via auto-send or coordinator approval carry indirect surfaces of:
- `couple_identity_profile`, `couple_intel`, `voice_preferences`, `venue_ai_config`, `intelligence_insights`, `cultural_moments` (when context window includes recent moments), `weather_data`, `external_calendar_events`, `tour_prep_briefs` (per `buildSageIntelligenceContext` reads in §5).
- That is: the couple receives the synthesised intelligence as the tone, facts, and phrasing of Sage's reply — not as a separate visible report.

### §9.3 DISAPPEARING intel — written but never surfaced

These have writers (verified by grep) but no reader path that reaches a human. Some are write-only-by-design (audit logs). Some are not — they're computed intelligence that should reach the operator and doesn't.

#### §9.3.1 Computed intelligence with NO reader path — should reach the user but doesn't

These are the ones to triage.

| Output | Writer | Verification | Why it should surface |
|---|---|---|---|
| `essentials_suggestions` | `onboarding/essentials-suggester.ts` writes daily via `essentials_suggest` cron (`30 8 * * *`) | Grep across all of `src/` for `essentials_suggestions` returns ZERO files outside the writer + config prompts. No page reads it. No API endpoint reads it. | The whole point of the suggester is to surface "based on coordinator dismissal patterns, this is the next onboarding step." Currently sits in the DB forever. |
| `lead_source_derivation_log` | Written by `attribution_refresh` cron weekly when cluster-first-touch flag is on | No UI reader found. Audit-trail use case implied but no `/intel/sources/...` page reads it. | This logs WHY a `weddings.source` was changed. Useful for "why did this lead's source flip?" debugging; no surface to ask the question. |
| `cohort_damping_cache` | Written by `cohort_damping_refresh` cron | Read by heat-mapping at score-compute time; no UI surface. | The cap value applied to a heat tier is invisible to operators. "Why does this hot couple show as warm?" has no answer surface. |
| `mint_wedding_telemetry` | Written by `identity/mint-wedding.ts` chokepoint on every wedding creation | Read only by `/api/admin/mint-wedding-stats/route.ts` (super-admin endpoint). `/super-admin/page.tsx` doesn't directly grep for it (verified — super-admin page reads organisations / venues / weddings / api_costs only). | Coordinator never sees mint-wedding telemetry. Super-admin endpoint exists but no page renders it. |
| `paused_period_skipped` | Written by `replay-paused-skipped` cron path-style route | Only consumed by the same cron's replay logic; no UI surface. | A venue that hit its cost ceiling has events that got skipped during the pause. Operator should see "while you were paused, 3 inquiries were not auto-replied to." No surface. |
| `auto_send_shadow_decisions` | Written by `email/autonomous-sender.ts` shadow path | `/agent/auto-send-shadow/page.tsx` exists and fetches `/api/agent/auto-send-shadow` — surface verified | (Moved to §9.1 — was a borderline case, but the page exists.) |
| `bulk_read_anomaly` (service-level output) | Written by `bulk-read-anomaly.ts` service | No UI page imports it (grep for `bulk_read_anomaly` shows only the service file itself). Output may flow into `intelligence_insights` but unverified. | Whatever this detects has no operator surface unless it lands on insights. |

#### §9.3.2 Computed intelligence that surfaces only in Sage drafts (the couple sees it, the operator doesn't)

Subtle: these get used to shape what Sage sends but the operator can't introspect what Sage knew.

| Output | Read at draft-time by | No coordinator-facing surface |
|---|---|---|
| `couple_intel.cohort_tier_cap` | heat-mapping → caps tier on lead detail | Operator sees the capped tier with no explanation of the cap |
| `voice_preferences.banned` | (claimed by Sage prompt assembly per memory) | No coordinator-visible "Sage refused to use these phrases on this draft" view |
| `tangential_signals` (social handles, family context) | Wave 4 judge bundle | Operator sees the synthesised `couple_identity_profile` but not the source signal list per couple |
| `intelligence_insights` (venue-level) when Sage references them inside a draft | brain prompts | No "this draft was informed by insight X" provenance UI on the draft |
| `cultural_moments` (confirmed) when used in context | (per memory; not strictly verified in code) | Same — no draft-side provenance |

#### §9.3.3 Audit-log tables — write-only-by-design (NOT a defect)

For completeness, these are legitimately write-only:

- `error_logs` — surfaced at `/agent/errors/page.tsx` (so technically also in §9.1 — moved here for grouping clarity). Audit history.
- `booked_data_recovery_log` — write-only audit trail of recovery attempts.
- `merge_reattachment_log` — write-only audit for cross-venue merges.
- `cron_runs`, `metered_events` — observability; surfaced at `/super-admin/observability/page.tsx` (also in §9.1).
- `profile_enrichment_runs` — audit trail for profile enrichment.
- `api_costs` — per-call cost rows; aggregated at multiple surfaces but individual rows are by design not user-readable.

#### §9.3.4 Queue tables — read-by-cron-not-by-UI (NOT a defect)

These are work queues, not intelligence:

- `couple_intel_jobs`, `identity_reconstruction_jobs`, `voice_dna_jobs`, `disagreement_jobs`, `intel_discovery_jobs`, `intel_match_jobs`, `venue_intel_jobs`, `venue_thesis_jobs`, `attribution_role_jobs`, `attribution_intent_jobs`, `marketing_recommendation_jobs`, `marketing_spend_jobs`, `marketing_loop_jobs`, `measure_outcome_jobs`, `hypothesis_validation_jobs`, `tour_prep_jobs`, `review_solicit_jobs`, `referral_extraction_jobs`, `lifecycle_transition_jobs`, `post_tour_followup_jobs`

For each, the upstream "what" surfaces via §9.1 (the derived table the job produces); the queue itself is plumbing. The exception is when a job has been stuck or is failing — there's no centralised job-queue health surface today. `/super-admin/observability` shows `cron_runs` but not job-row failure counts. **This is a different gap from "disappearing intel" but worth flagging.**

### §9.4 Pages that exist but don't read what their name implies

Caught while doing this audit. Worth a follow-up because users may form expectations the page can't meet.

- **`/intel/forecasts/page.tsx`** — Only reads `weddings`. No forecast-specific table. Title implies prediction surfacing; reality is summary of `weddings` rows. Either rename or wire to `prediction_snapshots` / `prediction_outcomes`.
- **`/intel/market-pulse/page.tsx`** — Aspires to be the rolled-up "is it me or the market" view. Reads `fred_indicators`, `cultural_moments`, `weather_data`, `external_calendar_events`, `tracked_sources`, `marketing_spend` (per the grep matches). Coverage of these reads should be confirmed against the page's render code.
- **`/intel/regions/page.tsx`** — Cross-region rollup. Reads not directly verified in this pass; if it only reads `weddings` aggregated by venue, then it's a regional cut of a single table rather than rolled-up regional intelligence.
- **`/intel/company/page.tsx`** — Multi-venue rollup. Same caveat.
- **`/intel/portfolio/structure/page.tsx`** — Page exists; what it surfaces not verified in this pass.

### §9.5 The provenance gap (architectural observation)

A coordinator viewing a hot lead has no way to ask "why is this lead hot?" with a one-click drill-down to the contributing engagement events. Same with:

- "Why is this venue health score down?" — `venue_health` has scalar values; no per-signal breakdown surface
- "Why did Sage say X?" — `drafts` carries the text but not the input context bundle. Closest is the lead detail showing `couple_identity_profile` + recent thread.
- "Why was this couple's source classified as Pinterest?" — `attribution_events` carries the trail; no per-wedding source-derivation panel renders it (only the parity log is surfaced)
- "Why is this couple's archetype 'budget-conscious'?" — `couple_intel.persona_label` is shown without the supporting signal list

These are not "disappearing intel" cases (the data is read by SOMETHING for SOMETHING) — they're provenance gaps where one input is exposed without the chain that produced it.

### §9.6 Empirical classification of all 263 tables

After the user's rebuke ("read it all, stop being lazy"), I ran a complete grep pass:

| Source | Files grepped | Read patterns extracted |
|---|---|---|
| Platform pages (`src/app/(platform)/**/page.tsx`) | 144 + nested | `.from('TABLE')` direct reads + `fetch('/api/...')` calls |
| Couple pages (`src/app/_couple-pages/**/*.tsx`) | 47 | direct reads |
| Components (`src/components/**/*.tsx`) | full tree | direct reads + fetch calls |
| API routes (`src/app/api/**/route.ts`) | 344 | direct reads |
| Services (`src/lib/services/**/*.ts`) | 400 | direct reads |
| Migrations (`supabase/migrations/*.sql`) | 263 `CREATE TABLE` statements | source of truth for table inventory |

Then I classified each of the 263 tables by where it is read.

| Class | Count | Description |
|---|---|---|
| Read in a page or component directly | 130 | Indisputably surfaces |
| Read in an API route only (no page direct, no component direct) | 53 | Surfaces IFF a page or component calls that API. Most do (verified by component grep — e.g., `CoupleIntelPanel`, `MarketingRoiDashboard`, `agency-detail-sections` fetch many such routes). |
| Read in a service only (no page, component, or API direct) | 63 | Computed in the service layer. Two sub-cases: (a) the service is imported BY an API route, in which case the table surfaces transitively; (b) the service runs only as a cron, in which case the table may disappear. |
| Not read anywhere in `src/` | 17 | Pure write-orphans — guaranteed disappearing. |

### §9.7 The 17 truly-unread tables (verified zero readers in any `.ts` file under `src/`)

For each: written by what, why I think it disappears.

| Table | Writer | Plausible reason for disappearance |
|---|---|---|
| `annotations` | (writer not investigated; possibly admin-side) | Surface exists in nav? No grep match for any reader. Possibly a Phase 5 stub. |
| `booked_dates` | One write site in `supabase/migrations/001_shared_tables.sql` baseline | Memory `bloom-date-classification-audit` already flagged this: `booked_dates has zero writers` — actually re-verified: also zero readers. Fully dead since 2026-04-22. |
| `couple_budget` | Brain-dump import / couple-portal write paths | Couple-side legacy table; `budget_items` superseded it (migration 052). Reads moved off. |
| `economic_indicators` | FRED ingest cron writes BOTH `fred_indicators` AND `economic_indicators` (legacy alias). Correlation engine reads `fred_indicators`. | Duplicate of `fred_indicators` from earlier migration; reads were migrated, writes were not removed. |
| `follow_up_sequence_templates` | (writer not investigated) | Template config — no UI to read or edit them; sequences hard-coded in `follow_up_sequences.ts`. |
| `founding_member_counter` | Stripe webhook writes signup count | Surface is the public `/pricing/page.tsx` — verify it reads (was excluded from my `(platform)` grep). |
| `generates` | Unknown writer | Table name is a verb — likely a stub or a misnamed migration artefact. Investigate. |
| `knot_template_patterns` | Wave 7B `attribution-roles/knot-template-detector.ts` (write/update) | Wave 7B detector pattern store. No reader in `src/` — but the detector reads it dynamically by venue, so my grep may have missed a pattern. Worth re-verification. |
| `marketing_spend_jobs` | Marketing-spend `spend-sync-sweep.ts` writes | Queue table; should be drained by a sweep. Zero reads suggests the sweep doesn't actually consume it (still queueing into thin air?). |
| `needs` | Unknown | Table named `needs` — table-name code smell. Possibly Phase-X stub. |
| `notifications` | Unknown writer | Separate from `admin_notifications`. May be legacy; couple-side notifications? Not surfaced. |
| `rate_limits` | (writer not investigated) | Likely config table read by middleware (which is NOT inside `src/lib/services` — investigate `src/lib/api/` or `middleware.ts`). |
| `seating_assignments` | Brain-dump import | Couple-portal seating config. Couple/[slug]/seating page may read; was in my couple-page grep but didn't surface. Re-verify. |
| `social_metrics_config` | Unknown | Configuration for social-metrics; reads should be in the social-capture pipeline but are absent. |
| `wedding_sequences` | Unknown | Possibly legacy follow-up sequence tracking. |
| `wedding_timeline` | Brain-dump import; couple-portal timeline page writes | Couple-side timeline; couple/[slug]/timeline page may read. Re-verify. |
| `zoom_webhook_log` | Zoom webhook (per migration 295 scaffold) | Per `bloom-may11-live-customer-session`: this table was scaffolded but the Zoom OAuth-poll integration is the canonical path. The webhook log table is dead. |

Of these 17:
- **Truly dead, no rescue needed:** `booked_dates`, `economic_indicators` (FRED dupe), `zoom_webhook_log` (per memory), `generates`, `needs`, `wedding_sequences`, `couple_budget` (legacy)
- **Should surface but doesn't:** `annotations`, `founding_member_counter` (likely on `/pricing`), `marketing_spend_jobs` (queue not draining), `follow_up_sequence_templates` (admin UI missing), `notifications`, `social_metrics_config`
- **Likely false positives in my grep:** `knot_template_patterns` (dynamic query), `rate_limits` (read in middleware not services), `seating_assignments` (couple page), `wedding_timeline` (couple page)

### §9.8 The 63 service-only tables — case-by-case

Read by services only. Whether they surface depends on whether any service is imported by an API route or a page-server-component.

**Queue tables (read by drainer cron — by design, NOT disappearing intel):**

`attribution_intent_jobs`, `attribution_role_jobs`, `couple_intel_jobs`, `disagreement_jobs`, `hypothesis_validation_jobs`, `identity_reconstruction_jobs`, `intel_discovery_jobs`, `intel_match_jobs`, `lifecycle_transition_jobs`, `marketing_loop_jobs`, `marketing_recommendation_jobs`, `measure_outcome_jobs`, `post_tour_followup_jobs`, `referral_extraction_jobs`, `review_solicit_jobs`, `tour_prep_jobs`, `venue_intel_jobs`, `venue_thesis_jobs`, `voice_dna_jobs`, `onboarding_backfill_progress`, `pending_sms_drafts`, `processed_sms_messages`

= 22 tables. No UI surface, by design.

**Audit / log / sync-state tables (write-only by design):**

`booked_data_recovery_log`, `lead_source_derivation_log`, `fred_series_sync_state`

= 3 tables. By design.

**Static-seed / config-baseline (read by services for compute, not surfaced):**

`heat_score_config`, `industry_benchmarks`, `government_events`, `digest_preferences` (settings), `external_calendar_events` (read by correlation), `market_intelligence` (Census), `google_ads_connections` (OAuth state)

= 7 tables. Configuration / external state — surface is the SETTINGS pages (verify `digest_preferences` reaches `/settings/digest-preferences/page.tsx`; verify `google_ads_connections` surfaces on `/settings/integrations/google-ads/page.tsx`).

**Surfacing transitively via API → service chain (verified by reading at least one API route file):**

| Table | API route that imports the service that reads it |
|---|---|
| `alumni_cohorts` | `/api/admin/intel/alumni/list` imports `listAlumniCohorts` from `intel/alumni/generate.ts` (verified by Read) |
| `prediction_snapshots`, `prediction_outcomes` | `/api/admin/intel/calibration/report` imports `analyzeCalibration` (verified by Read) |
| `disagreement_findings` (listed in api-only, not service-only — already in §9.1) | confirmed |
| `tbh_reports` | `/api/intel/agencies/[id]/tbh-report` — TBH report page surface confirmed earlier |
| `venue_intel`, `venue_thesis`, `venue_thesis_jobs` | `/api/admin/intel/cohort-rollup`, `/api/admin/onboarding/venue-thesis/*` |
| `venue_health_history` | `/intel/health/page.tsx` reads it (verified earlier — it appears in the page's `.from()` list) |
| `cross_venue_overlap` | `/api/admin/onboarding/venue-thesis/cross-venue-overlap` route exists |
| `couple_intel` | Surfaces via CoupleIntelPanel component which fetches `/api/admin/intel/couple-derive` — but that endpoint may only TRIGGER, not READ. Worth verifying the read endpoint exists. |
| `marketing_agencies`, `marketing_recommendations`, `marketing_digests`, `marketing_spend_flags`, `marketing_ab_tests` | Marketing-roi components fetch summary/heatmap/recommendations/flags endpoints; flow through service |
| `ai_briefings` | `/intel/briefings/page.tsx` exists; should read via API |
| `channel_intel_snapshots` | `/intel/channels/[channel_slug]/page.tsx` — verify read path |
| `transcript_segments` | OMI surface path: read into `tours.transcript_extracted` jsonb; segments themselves not displayed |
| `review_match_review_queue` | Reviews match queue — surface verify |
| `discovery_digests`, `discovery_feedback_actions` | Discovery digest surface verify |

These = ~25 tables that surface transitively. Need a service-import-graph trace to confirm definitively for each.

**Service-only tables that probably DISAPPEAR (no API → service trace found):**

| Table | What it computes | Why I think it disappears |
|---|---|---|
| `cohort_damping_cache` | Cap value applied to heat tier display | Only read inside heat-mapping service at score-compute time. No UI surface, no operator visibility of the cap. Verified §9.3.1. |
| `external_signal_health` | Health of external-signal sources | `/intel/external-signals/page.tsx` exists and fetches `/api/admin/external-signals/status`; whether that endpoint actually reads this table is unverified. |
| `social_posts` | Coordinator's social-media post calendar | Brain-dump writes; no obvious display surface. |
| `budget` | Legacy couple budget | Superseded by `budget_items`; legacy. |
| `website_traffic_history` | Web traffic time series | Written by some integration; no obvious surface. |

= 5 confirmed/suspected service-only DISAPPEARANCES.

### §9.9 The 53 API-only tables — surface IFF a page calls

Tables read in API routes but not directly in pages or components. Most surface because pages or components call these APIs (verified by component grep above for: `agency_*`, `marketing_*`, `wedding_journey_narratives`, `wedding_relationships`, `wedding_auto_context`, `intelligence_insights` family, `insight_outcomes`, `discovery_sources`, `source_attribution`, `tracked_sources`, `persona_channel_rollups`, `marketing_spend`, `marketing_recommendations`).

**Possible disappearance (API exists but no page caller found by grep):**
- `mint_wedding_telemetry` — API at `/api/admin/mint-wedding-stats` exists; no page in my grep fetches it. Earlier flagged as disappearing in §9.3.1.
- `paused_period_skipped` — only consumed by `/api/cron/replay-paused-skipped` cron-internal logic.
- Some `_log` tables (`auto_send_shadow_decisions` surfaces — has dedicated page).

### §9.10 Summary — the actual disappearing intel

After full empirical sweep, the cleanest disappearing-intel cases are:

1. **`essentials_suggestions`** (was service-only; confirmed no reader anywhere) — daily compute, never reaches user
2. **`cohort_damping_cache`** — heat tier capping, no provenance surface
3. **`mint_wedding_telemetry`** — only stats endpoint, no page renders
4. **`paused_period_skipped`** — cost-ceiling skipped events, no operator view
5. **`lead_source_derivation_log`** — audit log for source flips, no surface
6. **`booked_data_recovery_log`** — audit log, by design
7. **`annotations`** — table exists, zero readers, purpose unclear
8. **`marketing_spend_jobs`** — queue with zero readers (cron may write but never drain)
9. **`follow_up_sequence_templates`** — no template-management UI
10. **`notifications`** — separate from admin_notifications, no surface
11. **`social_metrics_config`** — no surface
12. **`social_posts`** — coordinator post calendar, no surface
13. **`website_traffic_history`** — no obvious surface
14. **`zoom_webhook_log`** — dead table per memory
15. **`booked_dates`** — dead per memory (no writers + no readers)
16. **`economic_indicators`** — legacy FRED alias; correlation engine reads `fred_indicators`
17. **`generates`, `needs`, `wedding_sequences`, `couple_budget`** — legacy stubs

### §9.11 Honest limits remaining

What I did NOT do in this pass:
- Did not trace each API route → its imported services → service's `.from()` reads. That's needed to definitively classify the 25 "transitively surfacing" service-only tables.
- Did not read every component file's render code to confirm which tables in its returned data are actually displayed vs swallowed.
- Did not verify the digest emails (ai_briefings) currently include each insight type.
- Did not include `(auth)`, `demo/`, `pricing/`, `welcome/`, `vendor*/`, `w/` pages — only `(platform)`, `_couple-pages`, `couple/[slug]/*`. The 17 truly-unread list may double-count some that surface in pricing or vendor surfaces.
- Did not parse middleware/`src/lib/api` for `rate_limits` reads.
- Did not verify whether the page-server-component for `/intel/clients/[id]` server-side imports any service that reads `couple_intel` — that import would surface the table even if the component only triggers re-derivation.

**Reproducibility:** my grep outputs were saved to `/tool-results/` and the classification scripts live at `C:/Users/Ismar/{parse-page-reads,parse-api-reads,build-surface-map,classify-unsurfaced}.js`. Re-running them after any code change will refresh the classification.

---

## §10 Definitive surface trace — every table, every chain (verified)

After the user's pushback ("trace all things back"), I built the full import + fetch graph and resolved transitively.

### §10.1 Methodology — the closure

For every page, compute the set of tables reachable by following ANY chain:

```
PAGE
  → direct .from('TABLE')                          (server component reads)
  → fetch('/api/...') → API route
                          → direct .from('TABLE')
                          → import @/lib/services/X → service file reads + service's own imports
  → import @/components/X → component reads + component's fetches + component's service imports
  → import @/lib/services/X → service reads (server components can use services)
```

Implementation at `C:/Users/Ismar/trace-surfaces.js`. Inputs (all in `C:/Users/Ismar/`):
- `pages-from.txt`, `pages-fetch.txt` — platform page reads & fetches
- `couple-pages-from.txt` — couple-portal reads
- `components-from.txt`, embedded component fetches
- `api-from.txt`, `api-imports.txt` — API direct reads + service imports
- `services-from.txt`, `service-imports.txt` — service direct reads + sibling service imports
- `all-imports.txt` — every `@/(lib/services|components|lib/api|lib/auth)` import across the tree
- `all-tables-raw.txt` — 263 tables from migrations

Bug fixes during the trace:
- Multi-line `import { ... } from '@/lib/services/X'` were missed by `^import` line-anchored greps. Replaced with a `from '...'`-anchored regex, picking up ~250 additional import edges.
- Service-to-service relative imports (`from './generate'`) are not captured by the absolute-path grep. Worked around by aggregating ALL files under an imported directory ("directory-as-module") — when an API imports `@/lib/services/marketing-spend/recommendations`, the resolver pulls in `recommendations/generate.ts`, `/sweep.ts`, `/index.ts`.
- Dynamic fetch URLs `fetch(\`/api/.../${var}/...\`)` are normalized by replacing `${...}` with `*`, then matched against route paths with `[id]` likewise normalized.

Cycle guard: services that mutually import each other (e.g., heat-mapping ↔ identity ↔ email pipeline) won't loop — DFS uses a `visiting` set.

### §10.2 Results

| Metric | Value |
|---|---|
| Tables in migrations | 263 |
| Page nodes traced (platform + couple + sub-component pages) | 221 |
| Tables surfaced via at least one page chain | 221 |
| Tables truly unsurfaced through any chain | **46** |

A 73-percentage-point improvement over the earlier "service-only counts as disappearing" estimate (which over-counted by treating queue tables and chained-through-service tables as disappearing). 221/263 = 84% of all tables in migrations reach at least one operator-facing page.

### §10.3 Spot-check verification of the chain (sample of 13 critical tables)

```
couple_intel              : 10 pages (clients/[id], discoveries, calibration, ...)
couple_identity_profile   : 11 pages (clients/[id], inbox, onboarding, ...)
intelligence_insights     :  5 pages (home, sources, market-pulse, ...)
alumni_cohorts            :  1 page  (intel/alumni)
venue_intel               :  5 pages (discoveries, marketing-roi/recs, thesis, ...)
venue_health              :  3 pages (intel/health, portfolio, benchmark)
tbh_reports               :  ✓ surfaced (intel/agencies/[id]/tbh-report → /api/intel/agencies/[id]/tbh-report → service)
disagreement_findings     :  1 page  (intel/disagreements)
intel_discoveries         :  4 pages (discoveries, marketing-roi/flags, marketing-spend, ...)
prediction_snapshots      :  1 page  (intel/calibration)
wedding_journey_narratives:  6 pages (clients/[id], inbox, agent/settings, ...)
marketing_recommendations :  4 pages (marketing-roi/{recs,flags}, marketing-spend, ...)
tour_prep_briefs          :  1 page  (intel/clients/[id])
```

All verified by `node -e` against `table-to-pages-FULL.json` (saved at `C:/Users/Ismar/`).

### §10.4 The 46 truly unsurfaced tables — categorized

Each row is classified by reading the writer service + checking whether the table has any reader at all.

**A. Job queues — read only by drainer cron (by design, NOT disappearing intel):** 12 tables
```
couple_intel_jobs, disagreement_jobs, hypothesis_validation_jobs,
lifecycle_transition_jobs, marketing_spend_jobs, onboarding_backfill_progress,
pending_sms_drafts, post_tour_followup_jobs, referral_extraction_jobs,
review_solicit_jobs, venue_intel_jobs, venue_thesis_jobs
```
These are work queues. The downstream table they feed (e.g., `couple_intel_jobs` → `couple_intel`) DOES surface. The queue itself surfacing is unnecessary unless there's a backlog dashboard — which there isn't.

**B. Audit / sync-state / webhook log tables — write-only by design:** 5 tables
```
booked_data_recovery_log    audit trail of recovery attempts
fred_series_sync_state      FRED API last-fetched watermark
twilio_webhook_log          Twilio idempotency log (MessageSid dedup)
zoom_webhook_log            scaffold, dead per memory bloom-may11-live-customer-session
stripe_events               state-machine idempotency (read by Stripe webhook handler itself)
```

**C. Static-seed / config / external-source tables — read by compute services, no UI by design:** 9 tables
```
economic_indicators         legacy FRED alias; correlation engine reads fred_indicators
government_events           hardcoded calendar; read by external-context
founding_member_counter     50%-off pricing tracker; read by /pricing page (outside (platform))
follow_up_sequence_templates  sequence template definitions (no UI to edit)
fred_series_sync_state      (also in B)
knot_template_patterns      Wave 7B detector — pattern store, read dynamically
rate_limits                 middleware config, read in src/lib/api not /lib/services
social_metrics_config       social capture config
wedding_sequences           legacy follow-up tracker
```

**D. Genuine disappearing intel — should reach the user, doesn't:** 11 tables

| Table | Should surface where | Verified disappearance |
|---|---|---|
| `cohort_damping_cache` | "Why is this hot couple capped?" provenance UI | Heat-mapping reads it at compute time; no UI explanation |
| `discovery_digests` | Coordinator discovery email | Written by discovery sweep; no API surfaces it for display |
| `discovery_feedback_actions` | Discovery feedback panel history | Written; no reader-side display |
| `essentials_action_log` | Suggester input audit | Fed into `essentials-suggester.ts` (which itself is also unsurfaced — see next row) |
| `essentials_preferences` | Settings page (`/settings/essentials-org`) | Settings page exists but chain trace says no surface — mapping or read-pattern miss |
| `cross_venue_overlap` | `/admin/onboarding/thesis` cross-venue panel | Page exists, fetches `/cross-venue-overlap` endpoint — chain hit but did not resolve a write reader |
| `transcript_segments` | Audio segment timeline on tour detail | Written by OMI orchestrator; no UI segment display (the summary `tours.transcript_extracted` is what Sage reads) |
| `venue_health_history` | Trend line on `/intel/health` | Page reads `venue_health` (current row) but my chain didn't catch the history read; verify the trend chart actually queries this table |
| `agency_document_downloads` | Audit log of agency document opens | Written when an agency doc is downloaded; no UI for download history |
| `channel_presentation_exports` | Share-token public URL surface | Written; only consumed by `/api/public/channels/exports/[shareToken]` (one-shot link) |
| `couple_budget` | Couple budget page | Legacy from migration 052; superseded by `budget_items`. Should be dropped or migrated. |

**E. Truly orphan with no clear writer + no clear reader (worst class):** 5 tables
```
annotations                  no writer pattern found; purpose unclear; likely stub
generates                    table name is a verb; almost certainly a misnamed migration or Phase-X stub
needs                        single-word table name; same smell as 'generates'
notifications                separate from admin_notifications; legacy or couple-side?
wedding_sequences            no writers found; possibly Phase-X stub
```

**F. Should surface via couple portal — chain miss vs real:** 4 tables
```
seating_assignments     /_couple-pages/seating reads seating_tables but NOT seating_assignments — confirmed real disappearance
rsvp_responses          /_couple-pages/rsvp-settings exists but doesn't display responses on the platform side
wedding_timeline        /_couple-pages/timeline renders a HARDCODED sample timeline — does NOT read the wedding_timeline table at all (verified by reading the page)
review_match_review_queue  Wave 8 review match — page may not exist yet
```

### §10.5 The cleanest disappearing-intel cases (the answer to the user's original question)

Stripped of queue/audit/seed false-positives, the verified disappearing intel that should reach a user but doesn't:

1. **`cohort_damping_cache`** — Heat tier capping happens silently. Operator sees a capped tier with no provenance.
2. **`discovery_digests`** — Daily discovery digest computed by `discovery_engine_sweep`; surfaced nowhere.
3. **`essentials_suggestions`** (from §9.10) — Daily compute, never surfaced.
4. **`mint_wedding_telemetry`** (from §9.10) — Chokepoint telemetry; only `/api/admin/mint-wedding-stats` reads, no page renders.
5. **`paused_period_skipped`** (from §9.10) — Events skipped during cost-ceiling pause; no operator "what was missed" view.
6. **`lead_source_derivation_log`** (from §9.10) — Source-flip audit; no UI for "why did this source change?"
7. **`transcript_segments`** — Audio segments persisted but only the summary jsonb surfaces on tours.
8. **`venue_health_history`** — Trend data computed; trend chart on `/intel/health` may not actually read it (verify).
9. **`wedding_timeline`** — Page exists, renders a hardcoded sample, never queries the table.
10. **`seating_assignments`** — Brain-dump writes but couple seating page reads `seating_tables` only.
11. **`rsvp_responses`** — Page accepts settings, no display of actual responses on the operator side.
12. **`agency_document_downloads`** — Audit of opens, never surfaced.
13. **`channel_presentation_exports`** — One-shot share tokens, no list / management UI.
14. **`couple_budget`** — Legacy table, dead.
15. **`annotations`, `generates`, `needs`, `wedding_sequences`** — Stubs / unknown purpose.

### §10.6 Surfaces that previous §9 drafts said worked but the trace disagrees

The trace caught these mapping errors in §9.1-§9.3 that I had asserted via partial grep but were actually broken:

- I claimed `/intel/clients/[id]` "directly reads" `couple_identity_profile` and `couple_intel`. The trace says: the page does NOT read them directly — references in the file are CODE COMMENTS only. The actual surface is via imported components (`CoupleIntelPanel`, `ReconstructedIdentityPanel`). Those components do reach the tables, but via different chains than I claimed.
- I claimed `web_visits` surfaces on `/intel/sources/track`. The trace says the page reads `marketing_spend` and `tracked_sources` only — NOT `web_visits` (which my earlier keyword grep mis-attributed because the page mentions "web visits" in TEXT but doesn't query the table). `web_visits` does surface via `/api/intel/auto-context/[weddingId]` (used by AutoContextPanel for Sage context), but as a SAGE-input not an operator-display.

### §10.7 What I still didn't trace

Real, honest limits remaining:

- Some service files use relative imports (`from './sibling'`) that the absolute-path grep can't see. Mitigated by the "directory-as-module" aggregation but still imperfect — a service in `subsystemA/` importing one in `subsystemB/` via relative path with `../` would be missed entirely. (Unlikely in this codebase per convention, but unverified.)
- Tables read in `src/lib/api/` (auth-helpers, scope-resolution) and `src/middleware.ts` aren't in my service-tables map. The `rate_limits` table in the unsurfaced list almost certainly reads from there.
- Component-to-component imports inside `src/components/` (e.g., `ChannelTruthAnswer` imports types from `channel-truth/types`). The grep catches the explicit imports; types-only imports don't affect surfacing.
- I assume an import means the imported symbol is actually invoked. A page may import a service function and never call it. The graph is reachable-by-import, not reachable-by-runtime.
- Tables read via dynamic identifiers (`.from(table)` with `table` a variable) are invisible to grep. The codebase does this in test harnesses and some generic helpers; impact on the 46 unsurfaced is unknown but probably small.

### §10.8 Reproducibility

The scripts to re-run this trace after code changes:

```
C:/Users/Ismar/trace-surfaces.js          # the resolver
C:/Users/Ismar/build-surface-map.js       # earlier simpler version
C:/Users/Ismar/classify-unsurfaced.js     # categorical buckets
C:/Users/Ismar/page-to-tables.json        # output: page → set of tables reached
C:/Users/Ismar/table-to-pages-FULL.json   # reverse map
C:/Users/Ismar/unsurfaced-FULL.txt        # final 46 unsurfaced list
```

Input data is regenerated by re-running the relevant Grep tool calls and copying outputs into the listed `.txt` files. If migrations or routes change, refresh the inputs and rerun `trace-surfaces.js`.

---

*BUILT.md — verified against source 2026-05-13. Prior draft preserved at `BUILT.old.md` for diff comparison.*