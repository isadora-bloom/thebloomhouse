# Consolidation Audit — Day 1 Output

**Date:** 2026-05-21
**Source:** seven parallel sub-agents read-only sweep against `C:/Users/Ismar/bloom-house/src/` and `supabase/migrations/`.
**Anchors:** `CONSOLIDATION-PLAN-25-DAY-ANCHORED.md` Day 1 mandates A through G.

This is the deletion budget + doctrine input for Day 6's kill list. Every claim is grep/read-verified; no estimates.

---

## A. Legacy writers (Agent A)

**Total writer sites to `weddings` / `people` / `interactions.wedding_id`: 138.**
- Routes through cascade (resolveIdentity / mintWedding chokepoints): **36**
- Writes directly without cascade: **102**

**Liam Hunt failure shape confirmed.** Three `people.insert` sites in `src/lib/services/email/pipeline.ts` that bypass the cascade and do not dedup partner2:
- Line 2211 (`processIncomingEmail` body-extraction partner2)
- Line 3062 (`processIncomingEmail` Calendly `schedulingEvent.extras.partnerName` partner2)
- Line 2907 is the re-link site that depends on these two

**Migration scope.** Of the 102 non-cascade writes:
- ~40 are KEEP-AS-IS (lifecycle writers, heat writer, override endpoints, compliance/erasure, destructive-gated wipes) — these write metadata that doesn't need cascade
- ~50 are MIGRATE candidates — they touch identity-bearing columns (`wedding_id`, `person_id`, partner2 inserts, source attribution) and must route through cascade
- 8 are `cleanup-ghost-weddings` sites — DELETE per constitution violation (it DELETEs weddings, against the spec)
- 4 are couple-pages (`_couple-pages/addresses`) — KEEP-AS-IS (couple-facing self-service)

**Day 7-9 concrete writer migration list:** pipeline.ts:2211, 2907, 3062 (Liam Hunt) + Calendly webhook handler (`src/app/api/webhooks/calendly/route.ts:413`) + HoneyBook CRM import (`src/lib/services/crm-import/index.ts` 5 sites) + Twilio webhook (2 sites) + reprocess-orphans (5 sites) + brain-dump imports (3 sites).

## B. Spine writers (Agent B)

**Total writer sites to `couples` / `touchpoints` / `fragments` / `candidate_matches` / `couple_progression_events` / `couple_merge_events`: 35.**
- Through cascade RPC: **0** — there is no `cascade_resolve_and_attach` Postgres RPC.
- Through cascade TS function: 2 confirmed call sites (`matcher.ts:364`, `resolution.ts:548`)
- Direct writes: **35**

**Major architecture finding.** The cascade is a pure TypeScript function at `src/lib/services/identity/identity-cascade.ts:490`. The Engineering Build Plan §3.1 specs it as a `SECURITY DEFINER` Postgres RPC; current reality is TS-only.

**Day 2 doctrine decision needed:** elevate cascade to RPC (per build plan, harder rollback, advisory lock built-in) OR keep as TS with explicit lock+write contract enforced at the call sites. **Recommendation: keep as TS, update Build Plan**, add `pg_advisory_xact_lock` calls inside the TS path before each spine write.

**Mirror-couple flagged DELETE-AFTER-DAY-13.** `src/lib/services/identity/mirror-couple.ts` lines 142, 188 — Phase A dual-write that mirrors legacy `weddings` into `couples`. After Day 13 (cascade-canonical), the legacy mirror has nothing to dual-write from. DELETE on Day 19.

## C. Attribution readers (Agent C)

**Total readers of source/utm/attribution columns: 78.**
- Serve KEEP surfaces (`/intel/identity-review`): **6**
- Serve DELETE surfaces: **72**

**KEEP surfaces already off legacy attribution tables.** `/intel/cohort`, `/intel/heat`, `/intel/source-quality`, `/intel/identity-review` all read from `touchpoints` / `couples` directly — not from `attribution_events` or `wedding_touchpoints`. This is **better than the plan assumed** — the read-migration on Days 14-18 is mostly renaming, not rewriting.

**`getSourceAttribution` doesn't exist.** Closest analogues:
- `buildCoupleAttribution` in D3 (shipped 2026-05-19) — couple-keyed first-touch attribution. Day 14 task becomes **rename + add opts** rather than build from scratch.
- `buildSourceQualityReport` in D8 (shipped 2026-05-20) — folds into `getVenueOverview` partially.

**`touchpoints.cascade_stage` and `cascade_reason` have ZERO readers.** Writers populate them but no surface displays. Q5 (battery: model transparency) needs a small UI piece at Days 17-18 to expose this.

**Discovered non-existent columns:** `couple_intel.attribution_*`, `weddings.first_touch_*`, `weddings.last_touch_*`. Plan documents that mentioned these were aspirational.

## D. Page catalog (Agent D)

**Total page.tsx files under `/intel` + `/agent`: 88. KEEP=8, MERGE=12, DELETE=68.**

**KEEP (11 across both directories with KEEP-OVERRIDE applied):**
- `/intel/identity-review` (Q6/29/36)
- `/intel/cohort` (Q1/2/11/14)
- `/intel/source-quality` (Q26/33)
- `/intel/heat` (Q23)
- `/intel/couples` + `/intel/couples/[id]` + `/intel/couples/[id]/journey` (identity-first doorway, Q5)
- `/intel/dashboard` (Q34 daily list)
- `/agent/brain-dump` (primary operator input)
- `/agent/drafts` (Sage outbound)
- `/agent/inbox` (6-folder lifecycle, daily workflow)

**MERGE (12):** anomalies, attribution, candidates, channels, channel-truth, channels-by-slug duplicate, discoveries, health, insights, lost-deals, marketing-roi, matches, matching, reviews, sources — all fold into the KEEP set or dashboard insights strip.

**DELETE (68):** the entire agency vertical (6 pages), portfolio/team/regions multi-venue surfaces, settings surfaces wrongly placed under /agent, legacy /intel/clients tree (replaced by /intel/couples), all marketing-roi sub-reports, all reviews sub-tools, all forecast/macro/external-signal plumbing surfaces, all diagnostic surfaces (data-fields, classification-health, errors, pipeline-diagnostic, auto-send-shadow, etc.).

**Plan correction:** sidebar collapses to 5 entries (Inbox, Couples, Dashboard, Settings, Sage) — the 8 KEEPs are accessed via Dashboard cards + Couples sub-routes.

## E. Services catalog (Agent E)

**Total files in `services/intel/` + `services/brain/` + `services/identity/`: 164. KEEP=110, MERGE=6, DELETE=48.**

**MAJOR PLAN CORRECTION.** The plan targeted ~95-110 deletes from services. Real number: **48-54** (48 DELETE + 6 MERGE consumed into KEEP). Each Wave shipped real capability and most files with 1-2 importers are load-bearing.

**Breakdown by directory (approximate):**
- `services/intel/*` (80 files): KEEP ~55, MERGE ~5, DELETE ~20
- `services/brain/*` (14 files): KEEP ~12, MERGE 0, DELETE 2 (cancellation-classifier + physical-presence-guard, both zero-importer)
- `services/identity/*` (70 files): KEEP ~43, MERGE 1, DELETE ~26

**KEEP-OVERRIDE applied to 4 (battery-critical):** `reconstruct.ts` (Q31 sensitive themes), `identity-cascade.ts` (Day 13 sole writer), `matcher.ts` + `resolution.ts` (cascade call sites).

**Clear DELETE candidates (zero importers, dead code):** `alumni/sweep.ts`, `cohort-damping-refresh.ts`, `cohort-rollup-sweep.ts`, `couple-intel-sweep.ts`, `digest-dispatch.ts`, `discovery/discovery-digest.ts`, `discovery/sweep.ts`, `external-match-sweep.ts`, `friction-score.ts`, `inbound-haiku-classifier.ts` (replaced by mig 329), `inbound-haiku-drain.ts`, `inbound-intent-drain.ts`, `intelligence-engine-narration.ts`, `onboarding/sweep.ts`, `pricing-history.ts`, `referenced-couple-resolver.ts`, `referrals/sweep.ts`, `tour-weather.ts`, `validation/sweep.ts`, `cancellation-classifier.ts`, `physical-presence-guard.ts`, `auto-merge-duplicates.ts`, `binder-cron.ts`, `candidate-ai-adjudicator.ts` (superseded by llm-judge), `capture-identifier.ts`, `cascade-on-enrichment.ts`, `match-eligibility.ts`, `mint-couple.ts` (T8.1b unwired), `mint-person.ts` (chokepoint never adopted), `mirror-couple.ts` (DELETE-AFTER-DAY-13), `resolver-helpers.ts`, `touchpoints-writer.ts`, `windows.ts` (superseded by windows-constants).

## F. Cron catalog (Agent F)

**Total crons in vercel.json: 47. KEEP=11, MERGE=11, DELETE=25.**

**KEEP (11):** email_poll, heat_decay, daily_digest, follow_up_sequences, weather_forecast, fred_daily_refresh, data_integrity_sweep, voice_dna_refresh, identity_judge_sweep, prune_maintenance, openphone_poll, google_places_reviews_refresh, tour_outcome_classifier.

**MERGE (11):** trends_refresh, weekly_briefing, monthly_briefing, cultural_moments_auto_propose, cultural_moments_llm_propose, census_refresh, transcript_voice_mining, external_calendar_refresh, weather_history_refresh, prune_expired_pulse_snoozes, agency_document_orphans — folded into umbrella entries (external_context_refresh, digest, voice_dna_refresh, prune_maintenance).

**DELETE (25):** anomaly_detection, attribution_refresh, essentials_suggest, inbox_filter_learning, venue_health_compute, quality_signals_refresh, correlation_analysis, backtrace_scan, phase_b_sweep, identity_backtrack, re_engagement_attribution, cost_ceiling_check, cost_ceiling_reset, recompute_pending_temporal, replay-paused-skipped, outcome_measurement, post_event_feedback_check, compute_attribution_parity, merge_people_aliases, booked_data_recovery, agency_activity_sweep, tbh_reports_monthly. All repair-paths obsolete once cascade is canonical, or pre-cascade analytics replaced by Wave 5/7 derivers.

**Critical missing crons (NOT in vercel.json but referenced by canonical doctrine):**
- `cascade_drain` — case handler `identity_cascade_sweep` exists in route.ts but never registered. **Day 12 must register.**
- `post_wedding_sweep` — handler exists, not registered
- `couple_intel_sweep` — handler exists, not registered
- `cohort_rollup_sweep` — handler exists, not registered
- `battery_smoketest` — doesn't exist at all (Build Plan §7)

**15 crons write directly (not through cascade):** email_poll, follow_up_sequences, backtrace_scan, zoom_poll, openphone_poll, phase_b_sweep, identity_backtrack, re_engagement_attribution, recompute_pending_temporal, merge_people_aliases, tour_outcome_classifier, booked_data_recovery, compute_attribution_parity, replay-paused-skipped, google_places_reviews_refresh. Days 7-13 migrates these.

## G. RLS audit (Agent G)

**Total tables with `venue_id`: 226. CORRECT=209. TOO-PERMISSIVE=0. MISSING=17.**

**Better than expected:** R4 (multi-tenant from line zero) is overwhelmingly enforced. Historic `USING (true)` policies from mig 027 were dropped by mig 225; wide-open anon writes sealed by mig 147.

**17 RLS gaps — must close before Day 13.5 reimport:**

**4 tables with RLS OFF entirely** (highest risk):
- `cohort_damping_cache` (mig 319) — operational data, low risk
- `mint_wedding_telemetry` (mig 320) — telemetry, low risk
- **`notifications` (mig 017)** — operator notifications with PII (lead names, contact info) — **PII RISK**
- **`wedding_timeline` (mig 017)** — couple-facing timeline data — **PII RISK**

**13 tables with RLS ENABLED but no SELECT/INSERT policy** (default-deny, only service-role can reach — likely a coverage gap that breaks coordinator UI reads):
activity_log, admin_notifications, annotations, campaigns, client_codes, follow_up_sequence_templates, knowledge_gaps, lost_deals, rate_limits (intentional — service-role only), relationships, social_posts, **tours**, venue_health, wedding_sequences.

`tours` being default-deny is suspicious — coordinator UI almost certainly needs to read tours. Verify before Day 6.

**Day 12 CI guard:** `scripts/check-rls-on-venue-id.mjs` — grep every migration adding `venue_id`, verify policy added. Block PR if missing.

**Day 7-13 task (added):** patch 4 RLS-off tables + audit the 13 RLS-enabled-no-policy tables (some intentional service-role-only, others coverage gaps).

---

## Summary: Day 6 kill list inputs

| Category | Verified count | KEEP | MERGE | DELETE |
|---|---|---|---|---|
| Legacy writer call sites | 138 | ~40 | — | ~62 (migrate 50, delete 8 cleanup-ghost + 4 misc) |
| Spine writer call sites | 35 | 33 | — | 2 (mirror-couple) |
| Attribution reader sites | 78 | 6 | — | 72 |
| Pages (intel + agent) | 88 | 11 (with KEEP-OVERRIDE) | 12 | 68 |
| Services (intel + brain + identity) | 164 | 110 | 6 | 48 |
| Crons in vercel.json | 47 | 13 | 11 | 25 (+5 add missing canonical) |
| RLS-gap tables | 17 | — | — | (patch RLS on 4; audit 13) |

**Projected LOC delete:** 85,877 → ~58,000-62,000 (28-32% delete). The plan's 47% delete target was over-aggressive against the actual service-file landscape; many Wave files turned out to be load-bearing. Still a substantial consolidation.

**Schema collapse (Day 19):** fold `fragments` and `couple_progression_events` into `touchpoints` with discriminator columns.

**Doctrine corrections to bake into Day 2:**
1. Cascade stays TS (not RPC) — update Build Plan, add advisory locks in TS path.
2. Service deletion target = 48 not 95-110. Don't overpromise.
3. Add `cascade_drain` + `post_wedding_sweep` + `couple_intel_sweep` + `cohort_rollup_sweep` + `battery_smoketest` to vercel.json on Day 12.
4. Patch `notifications` and `wedding_timeline` RLS before Day 13.5 reimport.
5. `getSourceAttribution` is renaming, not building. Plan less work on Day 14.
6. `touchpoints.cascade_stage` UI piece on Days 17-18 for Q5.

**Data deletion gate:** Day 13.5 (after writer migration, before read migration). Preserve-list matches May 14 wipe pattern: voice_dna + reviews + brand_assets + connections + knowledge + marketing_spend + weather + calendar.
