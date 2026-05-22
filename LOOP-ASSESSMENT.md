# LOOP-ASSESSMENT.md — Bloom House five-loop current-state code trace

**Date:** 2026-05-22
**Phase:** 0.3 of the phased consolidation (`CONSOLIDATION-PLAN-PHASED.md`).
**Status:** This document **supersedes the filename-only §0.3** of `CONSOLIDATION-PLAN-PHASED.md`. The plan's §0.3 loop characterisations were written from filenames; this is the real code trace. Every claim below is grep-verified or read-verified against the `consolidation` branch working tree. Where a loop does not close, the exact missing link is named.

**Verification method:** read each named file end-to-end, followed imports + callers via grep across `src/`, cross-checked `vercel.json` (scheduled crons) against `src/app/api/cron/route.ts` (the dynamic `case` dispatch + `VALID_JOBS` registry).

**One cross-cutting finding up front:** every loop's core services read and write the **legacy** tables only — `weddings`, `people`, `interactions`, `drafts`, `draft_feedback`, `attribution_events`, `wedding_touchpoints`. A grep for `from('couples')` / `from('touchpoints')` across `src/lib/services/{attribution,marketing-spend,calibration,voice-dna,draft-learning}` returns **zero hits**. None of the five loops touches the migration-346 spine. This is consistent with Phase 1/3 sequencing (writers unify first, readers migrate limb-by-limb) but means every loop is a Phase 3 reader-migration target.

---

## Loop 1 — Voice  (draft → operator edit → diff → voice-DNA → next draft)

### 1. The full chain

The §0.3 filename list collapsed **two distinct, parallel voice subsystems** into one. They are:

**Subsystem A — Wave 26 per-edit diff learner (the fast loop):**
- **Trigger:** operator approves an edited draft. `pipeline.ts:4694` updates `drafts`, `pipeline.ts:4708` inserts a `draft_feedback` row with `action='edited'`, then `pipeline.ts:4743-4761` fires `analyzeAndPersistDraftEdit` (dynamic import, `await`ed, wrapped in try/catch — best-effort).
- **Diff + extract:** `src/lib/services/draft-learning/analyze-edit.ts` `analyzeAndPersistDraftEdit()` — trivial-whitespace shortcut, then one Haiku call (`draft-edit-learner` prompt) diffing `drafts.original_sage_body` against the approved body.
- **Routing sink (`sinkForKind`, analyze-edit.ts:104):** `voice_rule`/`tone_shift` → `voice_preferences`; `content_addition`/`fact_correction` → `knowledge_captures`; structure/format/other → audit-only. Every insight also writes a `draft_edit_insights` audit row (analyze-edit.ts:381).
- **Feedback edge:** `brain/inquiry.ts:282` reads `voice_preferences`, splits into `bannedPhrases`/`approvedPhrases`/`dimensions` (inquiry.ts:312-360) and folds them into the next draft's prompt.

**Subsystem B — Wave 20 voice-DNA derivation (the slow/proposal loop):**
- **Evidence load:** `src/lib/services/voice-dna/derive.ts` `deriveVoiceDNA()` — loads up to 50 coordinator outbound emails from `interactions` (`loadCoordinatorEmails`, derive.ts:168) **and** up to 30 draft edits from `draft_feedback` `action='edited'` (`loadDraftEdits`, derive.ts:235).
- **Derive:** one Sonnet call (`voice-dna-derive` prompt) → four buckets persisted to `voice_dna_derivations` with `applied=false` (derive.ts:479).
- **Apply (operator-gated):** `voice-dna/apply.ts` `applyDerivation()` — operator picks buckets in the Voice DNA UI; upserts into `voice_preferences` (apply.ts:116).
- **Feedback edge:** same as A — `voice_preferences` → `brain/inquiry.ts`.

**Subsystem C — Wave 26 monthly incremental refresh:**
- `brain/voice-dna-extract.ts` `refreshVoiceDnaForAllVenues()` — pulls new outbound since last refresh, increments `voice_preferences` scores. Distinct from A and B; one-way ratchet (never deletes).

### 2. Where it is wired in
- **Subsystem A:** wired into the live pipeline at `pipeline.ts:4748`. Fires on every edited-draft approval. **Confirmed live.**
- **Subsystem B `deriveVoiceDNA`:** invoked by the admin route `api/admin/voice-dna/derive` and by `voice-dna/sweep.ts` `voiceDnaDriftSweep()`.
- **Subsystem B `voiceDnaDriftSweep` — NOT WIRED.** `sweep.ts:14-17` carries a literal `TODO`: *"register in src/app/api/cron/route.ts (case 'voice_dna_sweep') and vercel.json … Wave 20 leaves this for the reconciliation stream."* Grep confirms no `voice_dna_sweep` case in `route.ts`, no `voice_dna_sweep` in `vercel.json`. **The 60-day drift-refresh sweep is dead code with no caller.**
- **Subsystem C:** wired. `vercel.json` has `voice_dna_refresh` (`0 6 1 * *`, monthly); `route.ts:914` `case 'voice_dna_refresh'` → `refreshVoiceDnaForAllVenues`. **Confirmed live.** Note this is a *different* job from the unwired `voice_dna_sweep`.

### 3. Does the loop CLOSE?
**Yes — Subsystem A and C close; Subsystem B closes only via manual operator action.**
- A: edit → `draft_feedback` + Haiku diff → `voice_preferences` → `brain/inquiry.ts:282` → next draft. **Verified end-to-end, automatic.**
- B: the *derivation* closes (it reads `draft_feedback`, writes `voice_preferences` on apply). But the *automatic re-derivation* does not run — `voiceDnaDriftSweep` has no cron. B only re-fires if a human hits the admin derive route.

### 4. Spine or legacy?
**Legacy only.** Reads/writes `drafts`, `draft_feedback`, `interactions`, `voice_preferences`, `knowledge_captures`, `voice_dna_derivations`, `draft_edit_insights`. Zero spine reads.

### 5. Phase 3 verdict
**Loop 1 is ~85% closed.** The product-critical fast loop (A) is fully wired and closes automatically. Phase 3.1 must do exactly:
1. **Register `voice_dna_sweep` in `route.ts` + `vercel.json`** (resolve the `sweep.ts:14` TODO) — otherwise voice-DNA drift never auto-refreshes. ~5 lines.
2. Migrate `voice-dna/derive.ts` `loadCoordinatorEmails` from `interactions` to the spine touchpoint payload, and `pipeline.ts` draft reads to spine. The §0.3 claim "every part exists — confirms it closes end-to-end" is **correct for A/C but wrong for B**: the drift sweep part exists but is unreachable.

---

## Loop 2 — Prediction  (close-probability → record → measure outcome → calibrate → next prediction)

### 1. The full chain
- **Predict:** `intel/per-couple-derive.ts` `deriveCoupleIntel()` produces `intel.predicted_close_probability.pct_0_100`, upserts `couple_intel` (per-couple-derive.ts:408).
- **Record:** per-couple-derive.ts:427-446 fires `recordPrediction` (`calibration/record-prediction.ts`) fire-and-forget → inserts `prediction_snapshots` (kind `close_probability_pct`, 1h dedupe window).
- **Measure:** `calibration/measure-outcomes.ts` `measureOutcomes()` — for weddings in a terminal lifecycle stage, computes `matched_prediction` + `error_magnitude`, inserts `prediction_outcomes` (unique on `prediction_snapshot_id`).
- **Sweep:** `calibration/sweep.ts` `runCalibrationSweep()` — drains `measure_outcome_jobs` + a 30-day catch-up `measureOutcomes` per venue.
- **Analyse:** `calibration/analyze.ts` `analyzeCalibration()` — Brier score, 10-bin reliability diagram, per-persona breakdown, 30/90/365-day drift.

### 2. Where it is wired in
- **`recordPrediction`:** wired into `deriveCoupleIntel` (per-couple-derive.ts:432). Confirmed.
- **`measureOutcomes`:** wired. `vercel.json` has `outcome_measurement` (`0 6 * * 0`, weekly); `route.ts:639` `case 'outcome_measurement'` → `measureOutcomesAllVenues` (`route.ts:2831`). Confirmed live.
- **`runCalibrationSweep`:** **NOT WIRED.** `sweep.ts:21` carries a `TODO cron 'calibration_sweep' (registered separately)`. Grep confirms no `calibration_sweep` case in `route.ts`, no `calibration_sweep` in `vercel.json`. `enqueueMeasureOutcomes` (`measure-outcomes.ts:339`) is also dead — its docstring (measure-outcomes.ts:311-323) admits it is **not called from `stage-triggers.ts`** and relies on the unwired `calibration_sweep` as the fallback. So the *instant* per-wedding measurement path does not exist; only the weekly `outcome_measurement` cron measures. (Functionally the weekly cron covers it — just on a 7-day delay.)
- **`analyzeCalibration`:** invoked **only** from one admin API route, `api/admin/intel/calibration/report` (analyze.ts called at route line 56). It has no cron and no other caller.

### 3. Does the loop CLOSE?
**NO — this is a measure-only loop, not a calibrated loop.** The chain predict → record → measure runs. But `analyzeCalibration` is **pure read-only reporting** — it computes Brier/drift/reliability and returns a `CalibrationReport` to a dashboard. **Nothing consumes that report.** Grep for `calibration`/`brier`/`reliability` inside `per-couple-derive.ts` returns only the `recordPrediction` hook (lines 427-446) — the prediction model **never reads its own calibration history**. The feedback edge from "we were 20% over-confident on persona X" back into "adjust persona X predictions" **does not exist in code**.

**Exact missing link:** there is no writer that turns `analyzeCalibration` output (or `prediction_outcomes` aggregates) into an input the `couple-intel-derive` prompt reads. The Sonnet derive prompt is not calibration-aware.

### 4. Spine or legacy?
**Legacy only.** `prediction_snapshots`/`prediction_outcomes` are `wedding_id`-keyed; `measure-outcomes.ts:183` reads `weddings.lifecycle_stage`; `analyze.ts:309` joins `couple_intel` by `wedding_id`. Zero spine reads.

### 5. Phase 3 verdict
**Loop 2 is ~60% closed** — it measures itself but does not learn from the measurement. §0.3 ("substantial … built; Phase 3 confirms closure") is **too generous**: confirming closure is not enough because the closure does not exist. Phase 3.2 must do exactly:
1. **Wire `calibration_sweep`** into `route.ts` + `vercel.json` (resolve `sweep.ts:21` TODO) — or formally retire it and document that weekly `outcome_measurement` is the only measurer.
2. **Build the missing feedback edge:** feed per-persona calibration (e.g. "persona X predictions run +N% hot") into the `couple-intel-derive` prompt as a correction term, OR add a post-derive calibration adjustment. Until this exists, Loop 2 is open.
3. Migrate the calibration tables' `wedding_id` joins to the spine.

---

## Loop 3 — Attribution  (source-backtrace → spend rollup → flag → recommendation → digest)

### 1. The full chain
Two halves, loosely coupled:

**Half A — first-touch correction:**
- `attribution/source-backtrace.ts` `findBacktraceCandidates()` / `backtraceOneWedding()` — for weddings whose source is a scheduling tool (Calendly/Acuity/HoneyBook/Dubsado) or NULL, walks `interactions` + live Gmail for the earliest real upstream email, runs `detectFormRelay`.
- `applyBacktrace()` (source-backtrace.ts:1017) writes `weddings.source` + the `wedding_touchpoints` inquiry row. Auto-applies on `confident_match`, else queues for operator review.

**Half B — marketing-spend ROI loop (`marketing-spend/loop/`):**
- spend ingest (`spend-sync-sweep.ts`) → `persona-channel-rollup/sweep.ts` rollups → `marketing-spend/loop/flag-detector.ts` `detectMarketingFlags()` (deterministic threshold rules: CAC>LTV, under/over-performing, persona drift, channel anomaly → `marketing_spend_flags`) → `marketing-spend/recommendations/sweep.ts` reallocation recommendations → `marketing-spend/loop/digest-sweep.ts` Sonnet-narrated weekly digest.

### 2. Where it is wired in
- **`backtrace_scan`:** wired. `vercel.json` (`30 4 * * *`); `route.ts:754` `case 'backtrace_scan'` → `scanBacktraceAllVenues`. Confirmed live.
- **`attribution_refresh`:** wired (`vercel.json` `0 2 * * 1`; `route.ts:595`).
- **`compute_attribution_parity`** + **`re_engagement_attribution`:** both wired in `vercel.json` + `route.ts`.
- **The entire `marketing-spend/loop/` chain — NOT SCHEDULED.** `spend_sync_sweep`, `persona_channel_rollup_sweep`, `attribution_role_sweep`, `marketing_recommendation_sweep`, `spend_loop_flag_sweep`, `marketing_digest_sweep` **all have `VALID_JOBS` entries, `case` handlers in `route.ts`, and `DESTRUCTIVE_JOBS` entries in `cron-auth.ts`** — but a `grep -c "job=<name>" vercel.json` returns **0 for every one of them**. Each service file (e.g. `recommendations/sweep.ts:20-32`, `flag-sweep.ts:18-29`, `digest-sweep.ts:18-28`) carries a multi-step TODO comment whose step "add a row to vercel.json" was never done. **Half B fires only on a manual `/api/cron?job=...` hit. It does not run autonomously.**

### 3. Does the loop CLOSE?
**PARTIAL — Half A closes; Half B is built but not running.**
- Half A: backtrace → `weddings.source` corrected → daily re-scan picks up new evidence. Closes (idempotent via touchpoint metadata audit).
- Half B: the flag → recommendation → digest chain exists end-to-end as code and **would** close (flags + recommendations narrate into a digest the operator acts on; corrected spend feeds the next rollup). But because no `loop/` sweep is in `vercel.json`, the chain never advances on its own. **Missing link: six `vercel.json` cron rows.** The detector also explicitly never auto-executes (flag-detector.ts:31 "AUTO-FLAG NEVER AUTO-EXECUTE") — so even when wired, closure depends on operator action, which is by design.

### 4. Spine or legacy?
**Legacy only.** `source-backtrace.ts` reads `weddings`/`people`/`interactions`, writes `weddings.source` + `wedding_touchpoints`. `flag-detector.ts:330` reads `attribution_events`. Grep for `from('couples')`/`from('touchpoints')` in `marketing-spend/` and `attribution/` returns zero.

### 5. Phase 3 verdict
**Loop 3 is ~50% closed** (Half A live, Half B dark). §0.3 ("Partial — the §N.12 discovery work; Phase 3.3 finishes") **understates the gap**: the issue is not unfinished discovery work, it is **six unregistered crons**. Phase 3.3 must do exactly:
1. **Add 6 cron rows to `vercel.json`** for `spend_sync_sweep`, `persona_channel_rollup_sweep`, `attribution_role_sweep`, `marketing_recommendation_sweep`, `spend_loop_flag_sweep`, `marketing_digest_sweep`, in dependency order (sync → rollup → flag/recommendation → digest). The handlers and auth already exist.
2. Migrate `source-backtrace.ts` + `flag-detector.ts` reads from `weddings`/`interactions`/`attribution_events`/`wedding_touchpoints` to the spine.

---

## Loop 4 — Positioning  (review → extract language → operator approve → next draft + review response)

### 1. The full chain
- **Extract:** `intel/review-language.ts` `extractReviewLanguage()` — one Haiku call (`review-language` prompt) extracts themed quotable phrases from a review, upserts `review_language` (review-language.ts:131-159) with `approved_for_sage=false` + `approved_for_marketing=false` by default. `batchExtractReviews` is the bulk wrapper.
- **Approve:** operator approves phrases in the reviews UI; sets `review_language.approved_for_sage = true`.
- **Feedback edge:** `getApprovedPhrases(venueId, 'sage')` (review-language.ts:200) is imported by `brain/inquiry.ts:128` and `brain/client.ts:52`, and **called at `brain/inquiry.ts:797`** — approved phrases are folded into the inquiry draft prompt.
- **Review-response brain:** `brain/review-response.ts` drafts a public reply to a review, reusing the same 4-layer personality engine + `voice_preferences`.
- **Analytics:** `intel/reviews-analytics.ts` `computeReviewsAnalytics()` feeds `reviews-context.ts` (Sage intel context) — reporting, not a writer.

### 2. Where it is wired in
- **`extractReviewLanguage`/`batchExtractReviews`:** invoked from the reviews API routes (`api/intel/reviews`, `.../extract-phrases`, `.../extract-all`, `.../import`) — operator-triggered, not cron.
- **`google_places_reviews_refresh`:** wired (`vercel.json` `0 4 * * 1`; `route.ts:538`) — pulls Google reviews automatically.
- **`getApprovedPhrases`:** wired into the live draft path (`brain/inquiry.ts:797`). Confirmed.
- **`review-response.ts`:** invoked from the review-response API route (operator-triggered).
- Note: review *extraction* on a Google-pulled review is not automatically chained off `google_places_reviews_refresh` — extraction is operator-triggered or per-route. (Not verified as a closed gap; flagged for Phase 3.4 to check.)

### 3. Does the loop CLOSE?
**Yes — with an operator-approval gate (by design).** review → `review_language` (extracted) → operator approves → `getApprovedPhrases('sage')` → `brain/inquiry.ts:797` → next draft. The gate is intentional (constitution: operator authority). The review-response sub-path also closes: reviews in → public reply drafted from the same voice. **Verified end-to-end.**

### 4. Spine or legacy?
`reviews` and `review_language` are **venue-keyed** (per the wipe manifest `reviews` is PRESERVE-VENUE — it is operator-pasted + Google-pulled, not couple-keyed). `review-response.ts` optionally resolves a `wedding_id` to load `wedding_auto_context` + `couple_identity_profile` — that join is legacy. So Loop 4 is **mostly venue-scoped, with a thin legacy `wedding_id` join in the review-response brain only.**

### 5. Phase 3 verdict
**Loop 4 is ~90% closed.** §0.3 ("Partial. Phase 3.4 finishes") **understates it** — the language→draft loop is fully wired and closes. Phase 3.4 needs only:
1. Confirm/wire automatic phrase extraction off `google_places_reviews_refresh` so newly-pulled reviews enter the loop without an operator clicking "extract".
2. Migrate the `review-response.ts` `wedding_id` → `wedding_auto_context`/`couple_identity_profile` join to the spine.
No core wiring is missing — this is the lightest-touch loop after Loop 1's fast path.

---

## Loop 5 — Capacity  (coordinator capacity → auto-send pace → follow-up timing)

### 1. The full chain — AS DESCRIBED IN §0.3, THIS LOOP DOES NOT EXIST

The §0.3 description ("`coordinator_absences`, `venue_operational_state`, auto-send pacing exist but the close (capacity → auto-send pace → follow-up timing) is loosest") implies a loop with a loose close. **The code trace shows there is no close at all — and no chain.**

- **`coordinator_absences` + `venue_operational_state`:** grep across all of `src/` shows these tables are read by exactly one consumer — `intel/anomaly-detection.ts:610/619` `loadInternalContextForAnomaly()`. They feed the **anomaly-detection hypothesis prompt** so the AI can *explain* a metric dip ("inquiries fell because the coordinator was on leave"). That is an **explanatory** use inside Loop-3-adjacent intel — it is **not** a capacity signal feeding auto-send.
- **Auto-send pacing — `email/autonomous-sender.ts` `checkAutoSendEligible()`:** the eligibility gates (autonomous-sender.ts:265-275) are: cost-ceiling pause, direction filter, injection containment, confidence threshold, `require_new_contact`, per-thread rolling-24h cap (`auto_send_rules.thread_cap_24h`), venue-wide `auto_send_rules.daily_limit`. **A grep for `absence`/`operational_state`/`capacity`/`coordinator_absen` in `autonomous-sender.ts` returns ZERO hits.** Auto-send pace is governed by **fixed operator-configured caps**, never by coordinator capacity.
- **Follow-up timing — `email/follow-up-sequences.ts`:** grep for `absence`/`operational_state`/`capacity` returns **zero hits**. Follow-up timing is sequence-step-driven, not capacity-driven.
- **`venue-health-compute.ts`** does read `availability.booked_count`/`max_events` (lines 185-193) — but it produces a venue *health score* for reporting; nothing in the auto-send or follow-up path consumes it.

### 2. Where it is wired in
The two named tables are wired into anomaly-detection only (`anomaly_detection` cron is in `vercel.json`, `0 4 * * *`). There is **no wiring from any capacity table into any pacing or timing decision.**

### 3. Does the loop CLOSE?
**NO — and the loop as described is not even partially built.** There is no chain from coordinator capacity to auto-send pace to follow-up timing. The three components §0.3 names exist as *isolated* facts: absences exist (consumed by anomaly intel), operational-state exists (same), auto-send pacing exists (driven by fixed caps). They are **never connected**. There is no missing "link" — there is a missing **loop**.

### 4. Spine or legacy?
`coordinator_absences`, `venue_operational_state` — venue-scoped config tables. `auto_send_rules` — venue-scoped. `autonomous-sender.ts` resolves drafts/weddings (legacy `wedding_id`). No spine involvement.

### 5. Phase 3 verdict
**Loop 5 is 0% closed — it is not a loop, it is three unconnected parts.** §0.3's "the weakest … loosest close" is **a mischaracterisation**: there is no close, loose or otherwise. Phase 3 (per §0.3 "lighter-touch") must decide one of:
1. **Build the loop:** add a capacity signal (derive from `coordinator_absences` + `venue_operational_state` + `availability.booked_count`) and feed it as a new gate/scalar into `checkAutoSendEligible` (e.g. throttle `daily_limit` down during an absence window) and into `follow-up-sequences` step timing. This is net-new construction, ~1 session.
2. **Or formally descope Loop 5** and remove it from the five-loop framing — the consolidation does not depend on it.
Either way, Phase 3.5 cannot "confirm closure" or "finish wiring" — there is nothing to finish; it is a build-or-cut decision.

---

## Summary table

| Loop | Closed? | Wired (autonomous)? | Spine or legacy | Phase 3 step that finishes it |
|---|---|---|---|---|
| **1 — Voice** | **Partial (~85%)** — fast loop A closes auto; drift sweep B unreachable | A: yes (pipeline). C: yes (`voice_dna_refresh` cron). **B `voice_dna_sweep`: NO cron** | Legacy (`drafts`, `draft_feedback`, `interactions`, `voice_preferences`) | 3.1: register `voice_dna_sweep` cron (resolve `sweep.ts:14` TODO); migrate reads to spine |
| **2 — Prediction** | **No (~60%)** — measures itself, never learns from it | record + measure: yes (`outcome_measurement` cron). `calibration_sweep`: **NO cron**. `analyzeCalibration`: admin route only | Legacy (`prediction_snapshots`/`_outcomes` `wedding_id`-keyed, `couple_intel`) | 3.2: build the missing edge — feed calibration back into `couple-intel-derive` prompt; wire/retire `calibration_sweep` |
| **3 — Attribution** | **Partial (~50%)** — Half A (backtrace) live; Half B (spend loop) dark | backtrace_scan/attribution_refresh: yes. **6 `marketing-spend/loop/` sweeps: NO cron** | Legacy (`weddings.source`, `wedding_touchpoints`, `attribution_events`, `interactions`) | 3.3: add 6 `vercel.json` cron rows (handlers already exist); migrate reads to spine |
| **4 — Positioning** | **Yes (~90%)** — closes via operator-approval gate (by design) | extraction: operator/route-triggered. `getApprovedPhrases` injected at `inquiry.ts:797`: yes | Venue-keyed (`reviews`, `review_language`); thin legacy `wedding_id` join in review-response only | 3.4: wire auto-extraction off `google_places_reviews_refresh`; migrate the review-response `wedding_id` join |
| **5 — Capacity** | **No (0%)** — not a loop; three unconnected parts | capacity tables → anomaly-detection only; **never → pacing/timing** | Venue-scoped config tables; no spine | 3.5: build-or-cut decision — there is nothing to "finish wiring" |

---

## Corrections to CONSOLIDATION-PLAN-PHASED.md §0.3

§0.3's loop bullets were written from filenames. Specific corrections, each grep/read-verified:

1. **Loop 1 — §0.3 says "every part exists — Phase 3.1 confirms it closes end-to-end."**
   - *Correction:* §0.3 missed that "voice" is **two parallel subsystems plus a third refresh cron**, not one chain. The Wave 26 per-edit learner (`draft-learning/analyze-edit.ts`) and the Wave 20 derivation (`voice-dna/derive.ts`) are distinct. The fast learner closes automatically; the Wave 20 **drift sweep `voiceDnaDriftSweep` is dead code** — `sweep.ts:14-17` has an unresolved `TODO` and no `voice_dna_sweep` exists in `route.ts` or `vercel.json`. "Confirms it closes" is wrong for that part — it needs *building* (a cron registration), not confirming.

2. **Loop 2 — §0.3 says "substantial … Built; Phase 3 confirms closure."**
   - *Correction:* the loop **does not close**. `analyzeCalibration` is read-only reporting consumed by exactly one admin dashboard route; the prediction model (`per-couple-derive.ts`) never reads calibration history (grep-verified — only the `recordPrediction` hook is present). There is no "closure" to confirm. Additionally, `calibration_sweep` has an unresolved `TODO` (`sweep.ts:21`) and is unwired, and `enqueueMeasureOutcomes` is dead (its own docstring admits it is not called from `stage-triggers.ts`). Phase 3.2 must **build the calibration→prediction feedback edge**, not confirm it.

3. **Loop 3 — §0.3 says "Partial (the §N.12 discovery work). Phase 3.3 finishes."**
   - *Correction:* the gap is not "unfinished discovery work." The entire `marketing-spend/loop/` ROI chain — `spend_sync_sweep`, `persona_channel_rollup_sweep`, `attribution_role_sweep`, `marketing_recommendation_sweep`, `spend_loop_flag_sweep`, `marketing_digest_sweep` — is **fully built** (services + `route.ts` `case` handlers + `cron-auth.ts` entries) but **not in `vercel.json`** (verified: `grep -c` returns 0 for all six). Phase 3.3's concrete task is **registering 6 cron rows**, not finishing discovery code.

4. **Loop 4 — §0.3 says "Partial. Phase 3.4 finishes."**
   - *Correction:* the positioning loop is **~90% closed**, not "partial" in the same sense as Loops 2/3/5. `getApprovedPhrases('sage')` is verified-called at `brain/inquiry.ts:797`, so the review-language → draft feedback edge is live. The only real gap is auto-extraction off the Google-reviews pull and a spine join migration — much lighter than §0.3 implies.

5. **Loop 5 — §0.3 says "the weakest … auto-send pacing exist but the close … is loosest."**
   - *Correction:* this is the largest mischaracterisation. There is **no close, loose or otherwise** — and **no chain**. `coordinator_absences`/`venue_operational_state` feed only the anomaly-detection *explanatory* prompt (`anomaly-detection.ts:610/619`). `autonomous-sender.ts` `checkAutoSendEligible` has **zero references** to absence/operational-state/capacity (grep-verified) — pacing is fixed operator caps (`daily_limit`, `thread_cap_24h`). `follow-up-sequences.ts` likewise has zero capacity references. §0.3 implies a loop needing tightening; the reality is three isolated parts that were never connected. Phase 3.5 is a **build-or-cut decision**, not a "lighter-touch finish."

6. **Cross-cutting — §0.3 did not state this:** all five loops' core services read/write **legacy tables exclusively** (zero `from('couples')`/`from('touchpoints')` in `attribution/`, `marketing-spend/`, `calibration/`, `voice-dna/`, `draft-learning/`). Every loop is therefore also a Phase 3 reader-migration target, not just a "wiring" target.

---

## Things I could NOT verify from the code

- **Whether the unwired crons (`voice_dna_sweep`, `calibration_sweep`, the 6 `marketing-spend/loop/` sweeps) are unwired by oversight or by deliberate decision.** Each carries a `TODO`-style comment about a "reconciliation stream" / "another wave's zone" owning the `route.ts`/`vercel.json` edit. The handlers and `VALID_JOBS`/`DESTRUCTIVE_JOBS` entries *were* added — only the `vercel.json` rows are missing. This reads as incomplete work, but I cannot confirm from code alone that registration is still intended vs. deliberately parked.
- **Loop 4 auto-extraction off `google_places_reviews_refresh`:** I confirmed the Google-reviews refresh cron exists and that extraction routes exist, but did not fully trace whether `google_places_reviews_refresh` chains into `extractReviewLanguage` automatically. Flagged for Phase 3.4 to verify directly.
- **Runtime data state** (how many `prediction_snapshots`/`prediction_outcomes`/`voice_dna_derivations`/`marketing_spend_flags` rows actually exist): out of scope for a code trace — this is a SQL-against-the-DB question, not a repo question.
