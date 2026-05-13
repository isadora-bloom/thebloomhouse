# Bloom House — What's Built

**Last updated:** 2026-05-12
**Doctrine anchor:** `bloom-constitution.md` — Bloom is forensic identity reconstruction. This doc is the system's mouth: every place data enters, who reads it, where it lands.

---

## How to read this doc

This doc maps every path that lands data in the Bloom database. It is organised by **how** data enters, not by what feature it powers. For each path:

- **Source** — what produces the data (an inbox, a webhook, a CSV)
- **Trigger** — the mechanism that causes us to pick it up (HTTP webhook, OAuth poll cron, manual upload, scheduled API pull)
- **Parser / model** — what classifies, extracts, or transforms the payload (which Claude tier, which TS service, which regex pack)
- **Target tables** — where rows land

Configuration writes (operator filling out settings pages, brand assets, AI personality) are **excluded** unless they also produce intelligence rows. Those belong in a separate "configuration surfaces" section.

---

## 1. Ingestion paths

### 1A. Real-time inbound webhooks

These routes accept data pushed by external systems and process it on the request thread (with fan-out to background work where noted).

---

#### 1A.1 Gmail inbound (email pipeline)

The primary ingestion surface. Both real-time-ish (5-minute poll) and request-driven (OAuth callbacks).

- **Source:** Gmail messages on connected venue inboxes, inbound + outbound
- **Trigger:**
  - Cron `*/5 * * * *` → `email_poll` → `processAllNewEmails()` (`src/lib/services/email/pipeline.ts`)
  - OAuth connect at `src/app/api/auth/callback/route.ts`
  - Watermark: `gmail_connections.last_synced_at`
- **Parser chain (in order):**
  1. `detectFormRelay()` (`src/lib/services/ingestion/form-relay-parsers.ts`) — unpacks Knot / WeddingWire / Zola / HCTG / venue calculator emails (see 1B)
  2. `classifyInboundRaw()` (`src/lib/services/intel/inbound-intent-classifier.ts`) — Haiku verdict on intent (new_inquiry, follow_up, vendor, etc.)
  3. `classifySurface()` (`src/lib/services/email/surface-classifier.ts`) — inbox vs system_notification vs crm_attribution
  4. `decideLifecycleFolder()` (`src/lib/services/inbox/lifecycle.ts`) — state machine (rule chain + Haiku fallback). **Independent writer from intent_class — see `bloom-classifier-vs-folder-decoupled`.**
  5. `extractIdentityFromEmail()` (`src/lib/services/identity/body-extract.ts`) — universal body extraction (every email, not just new inquiries)
  6. `detectSchedulingEvent()` (`src/lib/services/ingestion/scheduling-tool-parsers.ts`) — Calendly Q&A from email body
  7. `detectBookingSignal()` (`src/lib/services/booking-signal.ts`) — contract-signed / payment-received regex pack
  8. `generateInquiryDraft()` / `generateClientDraft()` (`src/lib/services/brain/inquiry.ts`, `client.ts`) — Sonnet Sage drafts
  9. `applySignalInference()` (`src/lib/services/attribution/signal-inference.ts`) — emits attribution_events
  10. `enqueueIdentityReconstruction()` — signal-drives Wave 4 Sonnet judge
- **Targets:** `interactions` (with `direction`, `surface`, `author_class`, `lifecycle_folder`, `intent_class`, `disclosure_version`, `extracted_identity` jsonb), `weddings`, `people`, `person_identities`, `drafts`, `tangential_signals`, `attribution_events`, `engagement_events`, `identity_reconstruction_jobs`

---

#### 1A.2 Calendly tour-booking webhook

- **Source:** Calendly invitee.created events (and cancellation events)
- **Trigger:** HTTP POST → `src/app/api/webhooks/calendly/route.ts` (HMAC-SHA256 signature verified). On-demand backfill at `/api/calendly/events`.
- **Parser / model:**
  - `extractDiscoveryAnswerFromCalendly()` + `extractReferrerNameFromCalendly()` (`src/lib/services/discovery-source/capture.ts`)
  - Q&A extraction for the Wave 7B forensic role classifier (self-reported source recorded as `attribution_event` with `self_reported=true`, never overwrites `weddings.source` — see `feedback_self_reported_sources_not_truth`)
- **Targets:** `interactions` (type=meeting, surface=scheduling_tool, author_class=couple), `tours`, `engagement_events` (tour_requested, high_commitment_signal), `attribution_events`

---

#### 1A.3 OMI audio webhook

- **Source:** OMI wearable transcript segments. Provider-agnostic adapter — other audio providers slot in via `audio_provider` discriminator (migration 122).
- **Trigger:** HTTP POST → `src/app/api/omi/webhook/route.ts?token=<uuid>`
- **Parser chain:**
  - `omiAdapter()` (`src/lib/services/audio-capture/adapters/omi-adapter.ts`) normalises vendor payload
  - `persistAudioSegments()` (orchestrator) — binds segment to a tour by `(venue_id, session_id)` then nearest scheduled tour (±6h) or files as orphan. Cost-ceiling gated.
  - `extractTourTranscript()` (`src/lib/services/tour/transcript-extract.ts`) — Sonnet pass on completed-enough transcripts
  - `transcript-voice-learning.ts` — weekly mine of completed tours into voice phrases
- **Targets:** `tour_transcript_orphans`, `tours.transcript_extracted` (jsonb), `review_language` (with `source_type='transcript'`), `interactions` (surface=voice_capture)

---

#### 1A.4 Stripe webhook

- **Source:** Stripe subscription + payment lifecycle
- **Trigger:** HTTP POST → `src/app/api/webhooks/stripe/route.ts` (HMAC verified, idempotency via `stripe_events` ledger — see `bloom-phase1-audit-findings` for the state-machine work)
- **Parser:** `planTierForPriceId()` (`src/lib/billing/plans.ts`) maps Stripe price → plan_tier (Pre-Opening / Solo / Growth / Multi / Enterprise per `bloom-website-pricing-v2`)
- **Targets:** `venues.plan_tier`, `stripe_events`, `admin_notifications`

---

#### 1A.5 Twilio SMS webhook

- **Source:** SMS in/out via Twilio numbers (Quo/OpenPhone is the parallel path — see 1C.3)
- **Trigger:** HTTP POST → `src/app/api/webhooks/twilio/route.ts` (form-encoded; `verifyTwilioSignature()` from `src/lib/services/sms/twilio-signature.ts`)
- **Parser chain:**
  - `resolveIdentity()` (`src/lib/services/identity/resolver.ts`) — phone-first matching
  - `enqueueIdentityReconstruction()` — Wave 4 judge
- **Targets:** `interactions` (type=sms, surface=voice_capture), `twilio_webhook_log` (idempotency on MessageSid), `people`, `engagement_events`, `identity_reconstruction_jobs`

---

#### 1A.6 ContractHouse calculator handoff

- **Source:** rixeymanor.com (and future venue calculators) submit estimate via HTTPS handoff
- **Trigger:** HTTP POST → ContractHouse `/api/calculator/handoff`. Secret per venue at `venue_config.calculator_secret` (rotation playbook in `contracthouse-calculator-integration`).
- **Parser:** Schema validation against the published payload shape; calculator estimate stored as the first contract row.
- **Targets:** ContractHouse Supabase (separate project — `hdfqshkwegtfadcwtqhr`). Bloom merges via FK later. Cross-database, not Bloom-DB ingestion. **Listed for completeness; falls outside Bloom Supabase.**

---

### 1B. Form-relay parsers (sub-stage of the email pipeline)

These are not separate routes; they fire inside `processIncomingEmail` via `detectFormRelay()` before classification. Each unpacks a third-party lead-form email into a real inquiry.

| Source | Detector (in `form-relay-parsers.ts`) | What it extracts |
|---|---|---|
| The Knot | `parseTheKnot()` (sender `*.member.theknot.com`) | prospect email/name, wedding date, guest count, budget, note. Falls back to relay address if Knot redacted the email. |
| WeddingWire | `parseWeddingWire()` | same fields |
| Zola | `parseZola()` (sender `weddingvendors@zola.com`) | same fields |
| Here Comes the Guide | `parseHereComeTheGuide()` | same fields |
| Venue calculator | `parseVenueCalculator()` (matches `CALCULATOR_BODY_PATTERNS` and the venue's own emails via `venueOwnEmails()`) | calculator response payload + budget estimate |

All write to `weddings`, `people`, `interactions` with `confidence_flag='form_relay'`. Source attribution for these flows through Wave 7B's forensic classifier — the relay channel is **not** treated as canonical source (see `bloom-phase-b-decisions`).

---

### 1C. OAuth-poll integrations (cron-driven inbound)

Same shape as webhooks but Bloom-initiated pull, gated by stored OAuth tokens.

---

#### 1C.1 Gmail polling

Covered in 1A.1 — same parser chain, same targets. The poll is the primary path; webhook OAuth callback only handles new connections.

---

#### 1C.2 Zoom polling

- **Source:** Zoom recordings, transcripts, participant lists
- **Trigger:** Cron `0 10 * * *` → `zoom_poll` → `syncMeetings()` (`src/lib/services/ingestion/zoom.ts`)
- **Parser:** OAuth token refresh, recordings list GET, WEBVTT transcript parse, `extractTourTranscript()` if found
- **Targets:** `zoom_connections`, `processed_zoom_meetings`, `interactions` (surface=video_capture), `tours.transcript_extracted`, `tour_transcript_orphans`

---

#### 1C.3 OpenPhone / Quo polling

- **Source:** OpenPhone Quo SMS, voicemails, call summaries, call transcripts
- **Trigger:** Cron `*/15 * * * *` → `openphone_poll` → `syncAllVenues()` (`src/lib/services/ingestion/openphone.ts`). Also drains Wave 29 SMS sequence drafts.
- **Parser chain:**
  - API-key auth (raw header, NOT Bearer — see `bloom-may11-live-customer-session`)
  - First-sync backfill 180 days; subsequent runs use a 15-minute overlap window to handle Quo timestamp lag
  - E.164 normalisation
  - Tier 1 phone-match via `resolveIdentity()`
  - Tier 2 SMS LLM matcher: `sms-identify-person.prompt.v1` (Haiku) → `sms-name-match.ts` (name + event-context match against tours within ±90min). New numbers texting after email inquiry land on the right couple.
  - `hydrateCallTranscript()` — per-call `/v1/calls/{id}/summary` + `/transcriptions`. 404s silent; placeholder interaction recorded either way.
- **Targets:** `openphone_connections`, `processed_sms_messages`, `interactions` (surface=voice_capture), `people`, `engagement_events`
- **Backfill:** `POST /api/admin/sms/rematch` + hourly `sms_rematch` (operator-side "Re-match N unmatched" on `/agent/audio-inbox`)

---

#### 1C.4 Calendly polling (backfill)

Webhook is primary (1A.2). GET `/api/calendly/events` exists for on-demand coordinator pulls. Same parser, same targets.

---

### 1D. Coordinator-driven uploads

The operator pastes, uploads, or types data through platform UI. All routed through chokepoints that re-use the email-pipeline parsers where shapes overlap.

---

#### 1D.1 CRM import adapters

Shared scaffold at `src/lib/services/crm-import/*`. Onboarding Day-3 task; can re-run later via `/api/onboarding/crm-import`.

| Adapter | Status | Notes |
|---|---|---|
| `honeybook.ts` | **Real (full)** | Status enum mapping, lost_deals row when status=lost, `crm_source='honeybook'`, `source=NULL` (Wave 7B derives) |
| `dubsado.ts` | **Scaffold** — throws "not yet implemented" | Awaiting real export sample |
| `aisle-planner.ts` | **Scaffold** | Same |
| `generic-csv.ts` | **Real** | Coordinator-supplied column mapping. Handles guest-count ranges, Excel serial dates, ISO + M/D/YYYY. |
| `web-form.ts` | **Real** | Multi-provider (Typeform / JotForm / Google Forms / custom / Rixey Calculator) via `FORM_HINTS`. `crm_source='web_form'` (migration 178). Form Q&A persisted as `tangential_signals`. |
| `tour-scheduler.ts` | **Real** | Calendly / Acuity / Square Appointments / generic iCal. Classifies event rows: tour vs post-booking touchpoint vs other. Extracts Calendly Q7 ("where did you hear about us?"). |

All write to: `weddings` (with `confidence_flag='imported_high'` for curated, `'imported_medium'` for HoneyBook), `people`, `interactions` (Q&A or activity log rows), and adapter-specific extras (lost_deals, tangential_signals, tours).

---

#### 1D.2 Brain-dump uploads

`/api/brain-dump/entries` — single endpoint accepts CSV paste, file upload, or text dump. Shape detection routes to the right importer.

| Shape (via `brain-dump/csv-shape.ts`) | Importer | What it produces |
|---|---|---|
| `leads` | `importLeads()` | `weddings` (via mintWedding chokepoint), `people` |
| `reviews` | `importReviews()` | `reviews`, AI-extracted themes → `tangential_signals` |
| `platform_activity` | `importPlatformActivity()` | `tangential_signals`, `candidate_identities` (Phase B clusters + auto-merge / queue) |
| `knowledge_base` | `importKnowledgeBase()` | `knowledge_base` (per-venue FAQ rows) |
| PDF / image | Vision chain (see 1D.3) | Variable — recipes, contracts, storefronts, IG screenshots |

Audit trail: `brain_dump_entries` (raw_input, parse_status, routed_to). Clarification loop: PUT `/api/brain-dump/entries/{id}/clarify` answers ambiguous shapes.

Reminder: storefront ingestion (Knot / IG / Pinterest) is **manual via brain-dump** — those platforms have no APIs (see `bloom-storefront-ingestion`). Daily `identity_cascade_sweep` is the safety net.

---

#### 1D.3 Vision extraction

- **Source:** PDFs and screenshots uploaded via brain-dump or bar-recipes route
- **Trigger:** Multipart POST → `/api/brain-dump/entries` or `/api/bar-recipes/extract-upload`
- **Parser stack:**
  - `unpdf` + top-level DOMMatrix/Path2D/ImageData polyfill (see `feedback_pdf_polyfill_required` — both layers required, unpdf's stub is lazy and races serverless cold starts)
  - `callAIVision()` (`src/lib/ai/client.ts`) — Sonnet for image understanding
  - Co-extracts `identity_signals` from review screenshots, IG comments, follower lists, Knot storefronts (per `bloom-house-progress` Phase 8)
- **Targets:** `brain_dump_entries`, `knowledge_base`, `tangential_signals`, `brand_assets`, `bar_recipes`, `reviews`, `tour_transcript_orphans` (rare)

---

#### 1D.4 Onboarding wizard / 5-day project

- **Source:** Coordinator fills onboarding form
- **Triggers:**
  - Legacy: POST `/api/onboarding` (15-min wizard)
  - Enterprise: PUT `/api/onboarding/project/[id]/step/{step}` (5-day project)
- **Captures:** venue essentials, calendar integrations, CRM import handoff (1D.1), voice-DNA seed, brand assets, Calendly Q&A schema, auto-send rules, AI personality
- **Targets:** `venues`, `venue_config`, `venue_ai_config`, `voice_preferences` + `voice_training_sessions` + `review_language` (the actual voice substrate — there is no `voice_dna` table; the docs surface it as "Voice DNA"), `brand_assets`, `tour_booking_links`

---

### 1E. External enrichment pulls (cron-initiated)

Bloom pulls from outside on a schedule. Each lands data in a dedicated table for the correlation engine and Sage context layer.

| Pull | Cron | Service | Targets |
|---|---|---|---|
| NOAA monthly historical + Open-Meteo 14-day forecast | `0 5 * * *` `weather_forecast` | `src/lib/services/intel/weather.ts` (250ms NOAA throttle, °C→°F, WMO codes) | `weather_data` |
| Google Trends via SerpAPI | `0 3 * * 1` `trends_refresh` | `src/lib/services/intel/trends.ts` (per-venue geo-specific terms, 800ms throttle, 24h in-memory cache, Haiku recommendations on deviation) | `search_trends`, `api_costs` (prompt_version=`trends-recommendations.prompt.v1.0`) |
| FRED economic indicators | `0 3 * * *` `fred_daily_refresh` | `src/lib/services/external-context/fred-fetch.ts` (CPI, MORTGAGE30US, SP500, UNRATE, UMCSENT; monthly → daily forward-fill) | `fred_indicators` |
| Census ACS5 demographics | `0 3 1 * *` `census_refresh` | `src/lib/services/ingestion/census.ts` (county FIPS → metro, national 'US' fallback) | `market_intelligence` |
| US federal + Virginia regional calendar | `0 4 * * *` `external_calendar_refresh` | `src/lib/services/external-context/calendar-writer.ts` (hand-curated, rolling 365d) | `external_calendar_events` |

Cultural-moments and TBH-reports pulls live alongside but emit derived insights rather than raw external data — see 1F.

---

### 1F. Derived / computed writers

Crons that read existing tables, run a model or stats pass, and land rows that wouldn't exist without computation. They are ingestion-adjacent because they materialise new intelligence.

| Job | Cron | Service | Writes |
|---|---|---|---|
| `identity_judge_sweep` | `*/5 * * * *` | Wave 4 Sonnet judge worker | `couple_identity_profile`, `identity_reconstruction_log`. **Single read surface; retires Wave 1-3 piecemeal extractors per `bloom-wave4-identity-reconstruction`.** |
| `recompute_pending_temporal` | `*/5 * * * *` | heat-mapping derived-state drainer (INV-2.5) | `weddings.heat_score`, `weddings.heat_recompute_pending` |
| `backtrace_scan` | `30 4 * * *` | `findBacktraceCandidates()` | `candidate_identities`, retroactive `attribution_events` |
| `phase_b_sweep` | `45 4 * * *` | candidate clusterer + resolver (`src/lib/services/identity/*`) | `candidate_identities`, `people_merge_candidates`, `person_merges` |
| `merge_people_aliases` | `30 3 * * *` | Cross-venue alias merge | `people_merges`, `people.merged_into_id` |
| `data_integrity_sweep` | `0 5 * * *` | `runDataIntegritySweepAllVenues()` | 8 invariants logged; orphan reattachment in pipeline (see `bloom-data-integrity-sweep`) |
| `identity_backtrack` | `0 4 * * *` | Retroactive identity application | `weddings`, `people`, `interactions.extracted_identity` |
| `anomaly_detection` | `0 4 * * *` | Haiku hypothesis + z-score tests | `pulse_anomalies`, `admin_notifications` |
| `venue_health_compute` | `0 4 * * 2` | 7-signal weighted health | `venue_health_snapshots`, `quality_signals` |
| `quality_signals_refresh` | `0 5 * * 2` | Dropoff cohort analysis | `quality_signals` (intelligence_insights with `insight_type='source_quality'`, `two_email_dropoff`, etc.) |
| `correlation_analysis` | `0 5 * * *` | Lagged Pearson + Bonferroni stats | `correlation_analysis_results` |
| `compute_attribution_parity` | `0 5 * * *` | Cluster vs legacy attribution diff | `attribution_parity_log` |
| `re_engagement_attribution` | `30 5 * * *` | Reopen detection + 3-stage attribution | `weddings.status`, `re_engagement_attribution_log` |
| `tour_outcome_classifier` | `0 6 * * *` | Past-due tour evidence chain | `tours.outcome`, `tour_outcome_classification_log` |
| `booked_data_recovery` | `0 3 * * *` | Recover missing `booking_value` from HB / calculator / payload | `weddings.booking_value`, `booked_data_recovery_log` |
| `heat_decay` | `0 6 * * *` | 60-day exponential decay from last touch | `weddings.heat_score`, `heat_score_history` |
| `agency_activity_sweep` | `30 6 * * *` | Wave 6E rollup of `engagement.managed_channels` | `agency_attribution_snapshots` |
| `agency_document_orphans` | `0 2 * * 0` | Weekly Wave 6E doc orphan check | `agency_document_orphans` |
| `cultural_moments_auto_propose` | `15 8 * * *` | Trend-spike auto-propose | `cultural_moments` (proposed) |
| `cultural_moments_llm_propose` | `30 9 * * *` | LLM-proposed (`autoProposeCulturalMomentsLlmAllVenues()`) | `cultural_moments` (proposed) |
| `essentials_suggest` | `30 8 * * *` | Onboarding gap suggester | `essentials_suggestions` |
| `inbox_filter_learning` | `0 9 * * *` | Haiku pattern learner over 30d coordinator sorts | `inbox_filter_rules` |
| `voice_dna_refresh` | `0 6 1 * *` | Monthly incremental harvest | `voice_preferences`, `review_language`, `voice_dna_refresh_log` |
| `transcript_voice_mining` | `0 6 * * 2` | Tour-transcript phrase mining | `review_language` (source_type=`transcript`) |
| `outcome_measurement` | `0 6 * * 0` | Insight outcome scoring | `intelligence_insights.outcome_*` |
| `post_event_feedback_check` | `0 14 * * *` | Wave 8 post-event feedback collection | `post_event_feedback`, `interactions` (outbound prompts) |
| `tbh_reports_monthly` | `0 9 1 * *` | TBH-branded report generator | `tbh_reports` |
| `weekly_briefing` | `0 8 * * 1` | Coordinator briefing email | `ai_briefings`, `interactions` (outbound) |
| `monthly_briefing` | `0 8 1 * *` | Monthly rollup | `ai_briefings` |
| `daily_digest` | `0 7 * * *` | Daily coordinator digest | `ai_briefings`, sent via Gmail |
| `follow_up_sequences` | `0 * * * *` | Hourly sequence runner | `drafts`, `follow_up_sequences.last_run_at`, on-send `interactions` |
| `attribution_refresh` | `0 2 * * 1` | Weekly source derivation rerun | `weddings.source` (clusterer path, only if `USE_CLUSTER_FIRST_TOUCH` flag is set) |
| `cost_ceiling_check` | `15 * * * *` | Per-venue spend enforcement | `venues.autonomous_paused`, `cost_ceiling_events` |
| `cost_ceiling_reset` | `5 0 * * *` | UTC midnight clear of stale pauses | `venues.autonomous_paused` |
| `prune_maintenance` | `0 2 * * *` | Telemetry + rate_limit + brain_dump prune | prunes only — no new rows |
| `prune_expired_pulse_snoozes` | `15 0 * * *` | Snooze expiry + dismiss prune | `pulse_snoozes`, `pulse_dismisses` |

---

### 1G. Other ingestion-adjacent flows

| Flow | Trigger | Notes |
|---|---|---|
| Bar-recipe vision upload | POST `/api/bar-recipes/extract-upload` (multipart) | Couple-side, not coordinator. Sonnet vision → `bar_recipes`. |
| Tour-transcript manual re-extract | POST `/api/agent/tour-transcript-extract` | Coordinator manual; NOT cost-ceiling gated. |
| Backfill senders | POST `/api/agent/backfill-senders` | Re-fetches Gmail headers for legacy interactions missing `from_email`/`person_id` (see `bloom-house-progress` April 21 session). |
| Reprocess orphans | POST `/api/agent/reprocess-orphans` | For person-attached interactions still missing wedding_id. Confidence ≥65 + non-marketing body required. |
| Cleanup ghost weddings | POST `/api/agent/cleanup-ghost-weddings` | Deletes inquiry-stage weddings with zero people + zero interactions. |
| SMS rematch | POST `/api/admin/sms/rematch` (hourly `sms_rematch`) | Wave 29 LLM matcher backfill against unmatched OpenPhone rows. |

---

## 2. Cron schedule (authoritative)

Source of truth: `vercel.json`. Currently 44 entries. Listed in time-of-day order so concurrent jobs are visible.

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

---

## 3. Multi-writer audit (tables fed from many paths)

These tables get rows from multiple ingestion paths. Any schema change or invariant tightening must reckon with every writer.

| Table | Writers |
|---|---|
| `interactions` | email pipeline (1A.1), calendly webhook (1A.2), omi webhook (1A.3), twilio webhook (1A.5), openphone poll (1C.3), zoom poll (1C.2), form-relay synth (1B), CRM imports (1D.1), web-form import (1D.1), brain-dump (1D.2), reprocess-orphans, backfill-senders, daily/weekly/monthly briefings (outbound) |
| `weddings` | email pipeline new_inquiry, form-relay synth, CRM imports, web-form import, calendly webhook, brain-dump leads, identity_backtrack, re_engagement_attribution (status reopen), booked_data_recovery (booking_value), tour_outcome_classifier (status transition) |
| `people` | email pipeline identity resolver, form-relay, CRM imports, web-form import, openphone poll, twilio webhook, brain-dump, candidate-resolver (Phase B merges), merge_people_aliases |
| `tours` | calendly webhook, tour-scheduler CRM adapter (1D.1), omi webhook (when bound), zoom poll (when bound), tour_outcome_classifier |
| `engagement_events` | every inbound communication path + heat_decay reads |
| `attribution_events` | email pipeline signal_inference, form-relay, calendly Q&A, backtrace_scan, re_engagement_attribution, web-form Q&A |
| `tangential_signals` | brain-dump platform_activity, web-form Q&A, vision extraction, email pipeline body-extract |
| `candidate_identities` | phase_b_sweep, backtrace_scan, brain-dump platform_activity, candidate_resolver |
| `couple_identity_profile` | **Single writer:** identity_judge_sweep (Wave 4 Sonnet). Read surface for ALL identity reads. |
| `review_language` | onboarding seed, voice_dna_refresh, transcript_voice_mining, vision extraction (review screenshots) |
| `drafts` | inquiry-brain, client-brain, sage-brain, follow_up_sequences, post_tour_brief, Wave 29 SMS draft |

`interactions`, `weddings`, `people` are the three highest-fanout tables. Any new writer on these needs to thread through the existing chokepoints (`mintWedding`, `findOrCreateContact`, `resolveIdentity`, `captureNameEvidence`) — see `bloom-incomplete-dispatch-plan` for the Tier A branded-type lockdown.

---

## 4. Notes & flags

Items surfaced during this inventory. **Not fixed** — listed for triage.

### 4.1 Cron path inconsistency

- 43 of 44 entries use `/api/cron?job=<name>` query-style routing.
- One uses path-style: `/api/cron/replay-paused-skipped` at `5 0 * * *`.
- Same firing instant as `cost_ceiling_reset` (also `5 0 * * *`) but a different route, so the dispatcher handles them separately. Worth confirming this is intentional vs a legacy artefact from before the unified dispatcher.

### 4.2 Same-second co-firing

- `5 0 * * *` — `cost_ceiling_reset` + `replay-paused-skipped`
- `0 3 * * *` — `fred_daily_refresh` + `booked_data_recovery`
- `0 4 * * *` — `anomaly_detection` + `identity_backtrack` + `external_calendar_refresh`
- `0 5 * * *` — `weather_forecast` + `correlation_analysis` + `data_integrity_sweep` + `compute_attribution_parity`
- `0 6 * * *` — `heat_decay` + `tour_outcome_classifier`

`correlation_analysis` and `compute_attribution_parity` both read external-context tables that other 0:05 jobs write. The memory notes (`bloom-may10-wave4-8-shipped`) imply intended ordering: backtrace_scan → phase_b_sweep (✓ ordered) → weather → correlation → tour_outcome. Vercel cron does not serialise. If `compute_attribution_parity` runs before `data_integrity_sweep` finishes its orphan reattachment, the parity log will reflect pre-sweep state for that day. **Verify before relying on parity numbers.**

### 4.3 Dubsado + Aisle Planner adapters are scaffolds

`src/lib/services/crm-import/dubsado.ts` and `aisle-planner.ts` throw "not yet implemented." UI may surface them as selectable. Already noted in code; flagged here so the doc tracks the gap.

### 4.4 Voice substrate has no `voice_dna` table

The platform surfaces "Voice DNA" as a feature, but the underlying tables are `voice_preferences`, `voice_training_sessions`, `review_language`, and `venue_ai_config`. Any new code that grep'd for `voice_dna` and didn't find it isn't broken — there's no such table. (Inventory pass nearly cited a non-existent table.)

### 4.5 Phrase-selector schema mismatch (open since April 23)

Phase 5 close (`bloom-house-progress` April 23) caught that `phrase-selector.ts` queries `phrase_usage` for `phrase_key` / `phrase_used`, but the actual columns are `phrase_category` / `phrase_text` (migration 005). Both SELECT and INSERT are in `try/catch` so it fails silently — anti-duplication has been a no-op since the port from Phil's Python agent. Still unresolved per progress notes.

### 4.6 ContractHouse data lives in a separate Supabase project

Calculator handoff (1A.6) lands in `hdfqshkwegtfadcwtqhr`, not the Bloom project. Bloom merges via FK later (planned per `project_contracthouse`). Cross-database reads need explicit acknowledgement in any "where is the contract data" reasoning.

### 4.7 `couple_identity_profile` is a forensic read surface, not a CRM cache

Wave 4 doctrine: every identity-related read goes through `couple_identity_profile`. Anything that reads `people.first_name` / `weddings.partner1_name` directly for identity purposes should migrate to the profile read. Multiple legacy paths still hit the raw tables.

---

*Section 1 of the BUILT doc. Subsequent sections (processing pipelines, outbound surfaces, UI, telemetry) to follow as directed.*
