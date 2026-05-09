# Prompts Changelog

Per-prompt revision history. Each brain module exports a
`BRAIN_PROMPT_VERSION` constant that gets logged to
`api_costs.prompt_version` on every call and stamped onto
`drafts.prompt_version_used` at insert time. Bump the constant when
the system prompt or task prompt structure changes meaningfully —
small wording tweaks below the cost-of-bumping threshold can stay on
the current version, but anything that could plausibly move output
quality / cost / latency should bump and get an entry here.

Per Playbook OPS-21.5.1 / BUILD-PLAN T1-E.

## Versioning rule

`<module-name>.prompt.v<MAJOR>.<MINOR>`

- **MAJOR** — task contract change (e.g. response format, brain
  scope, new layer added). Bump invalidates any prompt-version-keyed
  cache.
- **MINOR** — wording / instruction refinement that holds the
  contract. Bumps still get a changelog row.

## 2026-05-09 (Wave 1B — per-couple narrators read auto-context)

Per-couple narrators now consume the wedding's `wedding_auto_context`
notes as tone fuel. The IDENTITY-TRUTH-AUDIT (Tenant 1, table row 10)
flagged that briefings, digests, and intel narrators "treat every
couple as a flat row" — Sage knew the bride was grieving, the
business-decision layer didn't. Wave 1B closes that gap on the
per-couple side: heat narration, risk flags, decay re-engagement,
cohort match, and journey narrative now load
`loadAutoContextForWedding(supabase, weddingId, { limit: 8 })` and
inject the formatted COUPLE'S NOTES block into the system prompt
BEFORE the numbers-guard block. Wave 1C handles venue-aggregate
rollups (briefings, digests, intelligence-engine); pricing-elasticity
and venue-level anomaly explainer stay on v2.0 — neither has a focal
couple to read notes from.

Architectural decisions:
- **Block placement: BEFORE numbers-guard.** The LLM should set tone
  from the soft layer first, then satisfy numeric constraints.
  Reversing the order makes the prose feel mechanically slotted
  because the model commits to the numeric frame before reading the
  qualitative tone fuel.
- **Limit = 8 per narrator.** The brain reply path runs at the
  loader's default 12; narrators take 8 because their output is a
  1-2 sentence narration. More notes flood the prompt; fewer would
  miss pinned context.
- **Empty-block elision.** When the loader returns
  `brainBlock=null` (fresh wedding, zero active notes) the
  assembler emits no header at all — empty headers waste tokens
  and can mislead the LLM into thinking notes were suppressed.
- **Best-effort load.** Each narrator wraps the loader call in
  try/catch and logs a warn on failure. Auto-context is enrichment;
  a load failure must never block narration generation. Output
  shape stays identical when the block is absent.
- **Numbers-guard interaction.** When a COUPLE'S NOTES block is
  present, the assembler appends a one-liner to the NUMBERS YOU MAY
  USE block: "The COUPLE'S NOTES block above contains qualitative
  tone signals only; do not reference them as data points or quote
  them in the output." This prevents the LLM from treating note
  tokens (e.g. "March 12") as referenceable allowlist values.
- **Cohort-match privacy.** Only the FOCAL couple's notes are
  loaded, never the cohort members'. Cross-couple soft-context
  leakage would violate Tenant 1 / Constitution §4.

| Module | Old | New | Reason |
|--------|-----|-----|--------|
| heat-narration | v2.0 | v2.1 | Couple-notes block threaded via `coupleNotesBlock` param to `buildCoordinatorPrompt`. A heat drop in a couple with grief / family-illness markers narrates as "stalled by emotional bandwidth, not by us" instead of "cold". Cache invalidation intentional — pre-1B narrations missed the soft layer entirely. |
| cohort-match | v2.0 | v2.1 | Focal couple's notes shape the recommendation's tone ("for couples in this cohort with financial-stress markers, the differentiator is X"). Cohort members' notes deliberately NOT loaded — privacy posture. |
| decay-re-engagement | v2.0 | v2.1 | Cause diagnosis still picks from the fixed taxonomy (missing_info / waiting_on_partner / etc.) but the recommendation prose softens for couples with grief / family-illness / financial-stress markers. taskInstructions extended with the "tone fuel, not extra evidence" rule. |
| risk-flags | v2.0 | v2.1 | Both LLM calls (Haiku sentiment scan + Sonnet narration) read the same couple-notes block — the block is loaded once in `generateRiskFlags` and threaded into both calls. A short reply from a grieving couple stops being a comparison-shopping signal; a contract-delay flag in a financial-stress context narrates softer. |
| journey-narrative | v2.0 | v2.1 | Same factual chronology + first-touch contract; tone is shaped by the soft layer when present. Adds explicit `TASK_INSTRUCTIONS` rule: notes shape tone, never facts. |
| pricing-elasticity | v2.0 | (no bump) | Venue-level by construction; no focal couple. Documented inline alongside the version constant. |
| anomaly-detection (metric) | v2.0 | (no bump) | Venue-level by construction. Per-wedding anomaly surfaces don't exist yet; when they land they will load focal-couple notes for their own narration. |

## 2026-05-09 (late evening — coordinator-facing prompt unification)

Canonical coordinator-facing prompt assembler (`src/lib/ai/coordinator-prompt.ts`)
landed. One entry point (`buildCoordinatorPrompt`) replaces the three
different identity patterns catalogued in `LLM-CALL-INVENTORY.md`
personality-drift finding #3 (10 named-Sage / 10 nameless / 1
named-venue across 24 narrators). Every coordinator-facing narrator
now layers UNIVERSAL_RULES + COORDINATOR_RULES (new constant in
`src/config/prompts/coordinator-rules.ts`) + buildPersonalityPrompt +
numbersGuardBlock (optional) + per-task instructions. The new
`loadCoordinatorPersonalityData` (`src/lib/ai/personality-loader.ts`)
mirrors the strict couple-side loader but degrades gracefully to a
synthetic "your assistant" personality when `venue_ai_config` is
missing, so cron-driven narrators never throw on a half-onboarded
venue. Surface enum has 24 entries; default content tier per surface
keys off the inventory's tier-policy column (tier 1 for per-couple
paragraphs: heat, cohort, decay, risk, journey, post-tour brief; tier
2 for venue-aggregate dashboards).

Migrated call sites (23): heat-narration, correlation-narration,
cohort-match, decay-re-engagement, risk-flags (sentiment scan +
narration, both calls), pricing-elasticity, source-mix-counterfactual,
strength-area-cohort, coordinator-override-pattern, weather-cancellation,
anomaly-detection (metric explainer + availability explainer),
intelligence-engine-narration, briefings (weekly + monthly), daily-digest,
weekly-digest, weekly-learned, attendee-intelligence, journey-narrative,
intel-brain (NLQ), cultural-moments-llm-propose, post-tour-brief
(brief only — couple-facing follow-up draft stays on its dedicated
prompt). The `reengagement_drafter` surface enum entry is reserved for a
future coordinator-side narrator; the existing candidate-facing drafter
stays on its inline prompt per Agent N's couple-side scope.

COORDINATOR_RULES contents:
1. Address the coordinator as a teammate, not a customer.
2. You are still ${aiName} — the same character couples chat with.
3. NUMBERS DISCIPLINE — only the values in the NUMBERS YOU MAY USE
   block; never invent numbers, ratios, projections.
4. ABSOLUTE-CERTAINTY PHRASES BANNED — no "always", "every",
   "definitely", "100%", "guaranteed", "will book / will lose";
   prefer probability framing.
5. Output is data-aware narrative, not bullet counts.
6. No em dashes. No exclamation marks. No couple/vendor names unless
   the task block invites them.

| Module | Old | New | Reason |
|--------|-----|-----|--------|
| heat-narration | v1.2 | v2.0 | Migrated to `buildCoordinatorPrompt({surface:'narration_heat'})`. ai_name now flows through the unified personality block; `loadAiName` removed. Numbers-guard explicit (heat_score, raw_heat_score, cohort booked/total/pct, multiplier, total_events, top-event point values). |
| correlation-narration | v1 | v2.0 | Migrated. Allowed numbers passed via `numbersGuard`; identity layer unified. |
| cohort-match | v1.0 | v2.0 | Migrated. Numbers-guard exposes n_total / booked / lost / conversion_pct / median value / median days / confidence-mix counts. |
| decay-re-engagement | v1.0 | v2.0 | Migrated. Numbers-guard: current_score, peak_score, decline_magnitude, days_since_last_inbound. |
| risk-flags | v1.1 | v2.0 | Both calls (Haiku sentiment scan + Sonnet narration) migrated onto `narration_risk`. |
| pricing-elasticity | v1.0 | v2.0 | Migrated. Numbers-guard: price_change_pct, pre/post conversion_pct + resolved counts, elasticity, marketing_delta_pct. |
| source-mix-counterfactual | v1.0 | v2.0 | Migrated. Numbers-guard: cac_ratio, reallocation_amount, projected gains/losses, donor/recipient CAC + bookings. |
| strength-area-cohort | v1.0 | v2.0 | Migrated. Numbers-guard: per-band conversion_pct + n, gap_pp, total_resolved. |
| coordinator-override-pattern | v1.0 | v2.0 | Migrated. Numbers-guard: recent + prior approve/edit/reject %, drift_pp, per-DoW anomaly stats. |
| weather-cancellation-narration | v1 | v2 | Migrated. Numbers-guard: bucket cancel %, baseline %, totals, multiplier_vs_baseline, lookback_days. |
| anomaly-detection | v1.0 | v2.0 | Metric anomaly explainer migrated to `narration_anomaly_metric` with current/baseline/change_pct as numbers-guard. |
| availability-anomaly-explanation | v1 | v2 | Migrated to `narration_anomaly_availability`. Numbers-guard: fill_rate_pct, saturday/non-saturday split, slot counts, days_out. |
| intelligence-engine-narration | v1 | v2 | Migrated. Numbers-guard sources from the detector's allowedNumbers list (already used by the post-call numbers-guard validator). |
| briefings (weekly) | v1.1 | v2.0 | Migrated to `briefing_weekly` surface. Numbers-guard exposes weekly metrics, prior-week metrics, deltas, demand_score, phase-B health counts. `withAiCache` key now keys off the assembler's promptVersion. |
| briefings (monthly) | v1.1 | v2.0 | Migrated to `briefing_monthly`. Numbers-guard: current/prior monthly metrics + month-over-month changes + demand_score. |
| daily-digest | v1.0 | v2.0 | Migrated. Numbers-guard exposes pending_drafts / unanswered / stale / yesterday-stats / upcoming counts / approval rate / AI cost. The previous "concise morning briefing assistant" framing folds into TASK_INSTRUCTIONS — identity now flows from the assembler. |
| weekly-digest | v1.0 | v2.0 | Migrated. Numbers-guard: this/last week inquiries + bookings, lost, revenue, avg response time. Pre-fix this surface was untagged (api_costs.prompt_version IS NULL); v2.0 closes that audit gap too. |
| weekly-learned | v1 | v2 | Migrated. Numbers-guard: voice prefs, training responses, this/last week bookings + delta, top source revenue, multi-touch counts, strongest correlation lag. |
| attendee-intel | v1 | v2 | Migrated. Numbers-guard: bucket / overall rate %, lift, tours_with_bucket, total_tours. |
| journey-narrative | v1.0 | v2.0 | Migrated. tier-1 (per-couple). Identity layer unified — pre-fix this was a nameless 1-2 sentence narrative writer; now the venue's `${aiName}` is the same voice telling the couple's story. |
| intel-brain (NLQ) | v1.2 | v2.0 | Migrated. NLQ system prompt's "you are the intelligence analyst for ${venueName}" framing replaced with the standard COORDINATOR_RULES + personality block; the data-domain catalogue (weddings / source attribution / FRED / cultural moments / correlation narrations / etc.) stays in TASK_INSTRUCTIONS. The intel-brain `BRAIN_PROMPT_VERSION` is shared with the positioning-suggestions call which is NOT migrated (positioning is not in the coordinator-narrator inventory's surface enum); positioning continues to log `intel-brain.prompt.v2.0` on api_costs but renders the existing positioning-strategist system prompt. |
| cultural-moments-llm-propose | v1 | v2 | Migrated. The previous explicit `You are an analyst for Bloom House` self-identification (the only narrator that named Bloom directly) flows through the standardised personality block. Continues to ship `contentTier: 3` (no PII; geography + categories only) explicitly so the assembler default doesn't downgrade the data sensitivity tag. |
| post-tour-brief | v1.0 | v2.0 | BRIEF migrated to `post_tour_brief`. The follow-up DRAFT stays on its dedicated couple-side `buildDraftSystemPrompt` per the coordinator-side scope of this unification. |

Net result of this batch: the `${aiName}` voice now appears
consistently across all migrated narrators. The "nameless analyst" /
"`${venueName}`-as-analyst" patterns are eliminated. Coordinators
reading their `/intel` dashboard hear one author across adjacent
tiles, briefings, digests, and lead-detail panels.

## 2026-05-09 (evening — couple-facing prompt unification)

Canonical couple-facing prompt assembler (`src/lib/ai/couple-prompt.ts`)
landed. One entry point (`buildCouplePrompt`) replaces the five different
prompt assemblies catalogued in `LLM-CALL-INVENTORY.md` "Couple-facing
observation". Every couple-facing surface now layers UNIVERSAL_RULES +
COUPLE_RULES (new constant in `src/config/prompts/couple-rules.ts`) +
buildPersonalityPrompt + per-task block + (optional) wedding context +
(optional) file context. `loadPersonalityDataCached` is reused so the
email-reply Sage and the couple-portal Sage now share one cache. Tier
policy: tier-1 when `weddingId` set OR `fileContext` may carry PII;
tier-2 otherwise (public preview + onboarding test-draft).

Migrated call sites: 5 contract calls (`api/couple/contracts/route.ts`),
1 portal file-extraction (`api/portal/sage/route.ts`), 1 event-feedback
proactive draft (`api/portal/event-feedback/route.ts`), 1 public sage
preview (`api/public/sage-preview/route.ts`), 1 onboarding test-draft
(`api/onboarding/test-draft/route.ts`), and the chat path
(`brain/sage.ts`, version sourced from the assembler).

| Module | Old | New | Reason |
|--------|-----|-----|--------|
| sage-brain | v1.2 | couple-chat.prompt.v2 | Sage chat now routes through `buildCouplePrompt({task:'chat'})`. Floor (UNIVERSAL_RULES + new COUPLE_RULES + personality + Sage task scaffold) is assembled by the canonical helper; chat-specific KB / intel / wedding / file blocks still append after. v2 jump captures the introduction of COUPLE_RULES (tenant-isolation, contract-quote-only-from-fileContext, first-name greeting, sign-off as ai_name) into Sage's input. Behavior preserved: timeline / budget / checklist context still pass, prompt-injection sanitizer unchanged, sign-off post-processor unchanged. |
| couple-contract | — | v1 | NEW. Used by 5 calls in `api/couple/contracts/route.ts` (vision OCR ×2, contract analysis, planning extraction, contract Q&A) and the PDF-binary fallback note. Prepends `TASK_CONTRACT_ANALYSIS` (the existing Sage contract scaffold with its lawyer disclaimer) so the same boundaries Sage already gives in chat carry over. fileContext block carries the contract text the model is allowed to cite. tier-1 (wedding-linked + document PII). |
| couple-event-feedback | — | v1 | NEW. Used by `api/portal/event-feedback/route.ts` proactive review-response draft. Pre-fix opened with `You are a professional wedding venue coordinator` — no ai_name, no UNIVERSAL_RULES. Now layers full venue voice + COUPLE_RULES so the draft sounds like the same configured concierge across the venue's surfaces. tier-1 (wedding-linked partner names + guest count). |
| couple-file-extraction | — | v1 | NEW. Used by `api/couple/contracts/route.ts` vision OCR (×2) and `api/portal/sage/route.ts` file-extraction. Pre-fix opened with `You are a document text extraction specialist` — no venue identity. Now wraps OCR with the venue voice + the COUPLE_RULES floor so any commentary the model emits stays in-brand. Prepends `TASK_FILE_CHAT` so document-discussion behavior is consistent. tier-1 (couple's uploaded PII). |
| couple-sage-preview | — | v1 | NEW. Used by `api/public/sage-preview/route.ts`. Pre-fix the public marketing-site preview was the only Sage that skipped UNIVERSAL_RULES — banned phrases + AI-disclosure rule were not enforced. Now routes through the assembler so the public preview honors the same floor as the authenticated portal Sage. tier-2 (no auth, no wedding link). Friendly 400 still fires when `ai_name` is unset to avoid a public-facing chat speaking in another venue's brand. |
| couple-onboarding-test | — | v1 | NEW. Used by `api/onboarding/test-draft/route.ts`. Pre-fix opened with `You are an AI assistant for "${venueName}"` — no ai_name, no UNIVERSAL_RULES. Now layers full venue voice + COUPLE_RULES; in-flight wizard dial values + edited FAQs are passed as a "PREVIEW DIAL OVERRIDES" block inside taskInstructions so the test draft reflects what the wizard currently shows even before the dials are saved. tier-2 (no auth-context wedding). |

## 2026-05-05

| Module | Old | New | Reason |
|--------|-----|-----|--------|
| anomaly-detection | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| brain-dump | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| briefings (weekly) | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| briefings (monthly) | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| candidate-ai-adjudicator | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| daily-digest | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| data-detection | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| extraction | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| planning-extraction | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| marketing-spend | — | v1.0 | Initial versioning (T1-E / OPS-21.5.1) |
| bar-recipe-extract | — | v1.0 | Initial versioning; image path rewired through callAIVision (T1-E / OPS-21.5.1) |

## 2026-05-06

| Module | Old | New | Reason |
|--------|-----|-----|--------|
| journey-narrative | — | v1.0 | Initial versioning; closed Tier-B #75 audit gap (call landed in api_costs with prompt_version=NULL) |
| re-engagement-drafter | — | v1.0 | Initial versioning; closed Tier-B #75 audit gap (call landed in api_costs with prompt_version=NULL) |

## 2026-05-09 (afternoon: LLM-CALL-INVENTORY tier-correctness sweep + promptVersion backfill)

Tier-correctness fixes from `LLM-CALL-INVENTORY.md`. Four bounded enum
classifiers demoted Sonnet to Haiku (cost). Two judgement calls promoted
Haiku to Sonnet (quality). Five untagged call sites backfilled with
prompt-version constants.

| Module | Old | New | Reason |
|--------|-----|-----|--------|
| cancellation-classifier | v1.0 | v1.1 | Tier demote Sonnet to Haiku. Bounded 9-bucket enum classifier (`weather` / `date_conflict` / `family_emergency` / `venue_concern` / `travel_blocker` / `lost_to_competitor` / `venue_unavailable` / `health_emergency` / `rescheduled` / `no_show_followup` / `other`) with closed schema and 3-level confidence. Sibling Haiku classifiers (router-brain, lifecycle.signal-detector) handle the same shape. Cache-key model id flipped from `'sonnet'` to `'haiku'` so cached responses stay tier-correct. Prompt body unchanged. |
| tour-cancellation-reason | — | v1.0 | Initial versioning plus tier demote Sonnet to Haiku. Bounded 8-bucket enum on inbound cancel-email body. Same shape as brain/cancellation-classifier. Was previously logging api_costs.prompt_version=NULL. |
| review-language | — | v1.0 | Initial versioning plus tier demote Sonnet to Haiku. Bounded extraction with closed `REVIEW_THEMES` enum (12 buckets). Identical shape to voice/gmail-backfill which already runs on Haiku. Was previously logging api_costs.prompt_version=NULL. |
| transcript-voice-learning | — | v1.0 | Initial versioning plus tier demote Sonnet to Haiku. Bounded extraction over the same `REVIEW_THEMES` enum as intel/review-language. Per-tour volume is moderate; the schema is the load-bearing constraint, not free-form judgement. Was previously logging api_costs.prompt_version=NULL. |
| risk-flags | v1.0 | v1.1 | Tier promote Haiku to Sonnet on the sentiment-scan call (line 346). The classifier weighs hesitation, comparison-shopping, and stress signals across the last 3 inbound emails. The companion narrator (line 487) is Sonnet and treats this output as load-bearing input. If classification is wrong, narration compounds the error. Narrator call left at Sonnet. (Note: subsequently rolled into the v2.0 coordinator-prompt assembler migration; tier promote preserved.) |
| candidate-ai-adjudicator | v1.0 | v1.1 | Tier promote Haiku to Sonnet. The adjudicator weighs first-name + last-initial + state + timing + funnel-depth + recent_email_subjects text patterns ("saw you on The Knot") to pick one of 2+ weddings. A wrong call lands the wrong wedding's history on the wrong couple. Qualitative attribution, not bounded classification. The original `Sonnet was overkill` rationale assumed the schema constraint did the work; the schema is bounded but the inputs are qualitative. |
| portal-quick-add | — | v1.0 | Initial versioning for the document-to-CSV extraction surface. Covers the docx text path (callAIJson) + vision path (callAIVision) inside `app/api/portal/quick-add/route.ts`. Was previously logging api_costs.prompt_version=NULL on both calls. |
| weekly-digest | — | v1.0 | Initial versioning for the executive-summary call inside the weekly-digest generator (`generateDigestSummary`). Was previously logging api_costs.prompt_version=NULL. |
| trends-recommendations | — | v1.0 | Initial versioning for the trend-recommendations generator (`generateTrendRecommendations`). Was previously logging api_costs.prompt_version=NULL. |

## 2026-05-09

| Module | Old | New | Reason |
|--------|-----|-----|--------|
| weekly-learned | — | v1 | AI-VS-TEMPLATED-AUDIT finding #5. Replaces the deterministic "[Sage] learned 5 voice preferences this week" bullets with a real Sonnet-narrated 3-5 sentence weekly observation. Structured counts (voice prefs / training responses / bookings vs last week / inquiries / top source quality / strongest correlation / multi-touch journey aggregate) become INPUT to the LLM call; the model composes a coordinator-readable paragraph and the bullets become a "by the numbers" footer. taskType `weekly_learned`, tier sonnet, temperature 0.6 (warmer for narrative voice), maxTokens 360. Cost-ceiling gate before the Sonnet call; deterministic bullets render alone when the gate closes or the call fails. Response stamped with `narration_source: 'llm' \| 'template'` so the UI can drop the anthropomorphic "[Sage] learned" framing on the template path. |
| attendee-intel | — | v1 | AI-VS-TEMPLATED-AUDIT finding #6. Replaces the hardcoded "Parents have booked at 65% vs an overall 42%" format string with a real Sonnet narration that frames the outlier as a coordinator action ("when a couple mentions parents in their inquiry, prioritise getting all attendees onto the tour calendar"). Bucket math + outlier detection stay deterministic; only the `topInsight` string changes path. taskType `attendee_intelligence_top`, tier sonnet, temperature 0.4, maxTokens 220. Cost-ceiling gate before the Sonnet call; deterministic format string preserved as the fallback. Return shape adds `top_insight_source: 'llm' \| 'template' \| null` so callers can distinguish provenance. |
| intel-brain | v1.1 | v1.2 | TRENDS-DIAGNOSIS Fix 4 / Finding F. Sage NLQ data block now enumerates the top-5 most-recent `correlation_narration` rows so questions like "what's the macro story for May" / "did Memorial Day weekend hurt our tour conversion" surface engine-confirmed cross-channel pairs. System prompt adds CORRELATION NARRATIONS section + USE-THESE-FIRST guidance. Cultural moments / FRED deltas / calendar events were already plumbed (T5-θ.2); this closes the macro-story gap. |
| briefings (weekly) | v1.0 | v1.1 | TRENDS-DIAGNOSIS Fix 4 / Finding F. Weekly briefing now receives a MACRO CONTEXT block (cultural moments + FRED deltas + upcoming calendar events + correlation narrations). System prompt instructs the LLM to weave the most relevant macro signal into summary + recommendations, prefer quoting correlation-narration titles over re-describing numbers, and never invent macro relationships when the block is empty. Closes YC-partner HIGH 12. |
| briefings (monthly) | v1.0 | v1.1 | TRENDS-DIAGNOSIS Fix 4 / Finding F. Same MACRO CONTEXT plumbing as weekly; monthly system prompt directs the macro signal into strategic_recommendations specifically. |
| cultural-moments-llm-propose | — | v1 | TRENDS-DIAGNOSIS Fix 3 / Finding A. NEW judgement-tier proposer running ALONGSIDE the legacy z-score detector (cultural-moments-auto-propose). Sonnet, temp 0.4, maxTokens 800, taskType `cultural_moments_propose`. Proposes 0-3 NAMED cultural moments per venue per day with evidence URLs and dateable windows. Inserts as `proposed_by='ai_llm'` (CHECK constraint extended in migration 250). Cron: `cultural_moments_llm_propose` runs at 09:30 UTC daily — different time from the statistical proposer (08:15) so the two don't compete. Cost ceiling: ~$0.01/venue/day. |
| weather-cancellation-narration | — | v1 | AI-VS-TEMPLATED-AUDIT Finding #3. NEW Sonnet narrator over the deterministic weather x cancellation detector in `insights/weather-cancellation.ts`. Pre-fix the file wrote `insight_type='correlation_narration'` rows with hardcoded title/body/action templates, impersonating real LLM-narrated `correlation_narration` rows from `correlation-narration.ts` on `/intel/insights`. Now the deterministic detector (rain-day vs baseline cancel-rate buckets) builds a struct of the numbers and the Sonnet narrator composes coordinator-voice {title, body, action} from it. callAIJson, tier 'sonnet', temp 0.4, maxTokens 360, taskType `weather_cancellation_narration`. Numbers-guard via `insights/persist.ts` rejects any number not in the struct. Persist path moves from a direct `intelligence_insights` insert to `persistInsight` (cache-key + numbers-guard contract). Fallback: deterministic template fires when `gateForBrainCall` closes (cost ceiling) OR Sonnet fails OR numbers-guard rejects; the template is constructed from struct numbers only and is guaranteed to pass the guard. Provenance recorded on `data_points.narration_source` ('ai' / 'template'). |
| availability-anomaly-explanation | — | v1 | AI-VS-TEMPLATED-AUDIT Finding #4. NEW Sonnet narrator for `detectAvailabilityAnomalies` in `intel/anomaly-detection.ts`. Pre-fix both branches at l. 1052-1057 hardcoded the `ai_explanation` string ("Saturdays in October are filling fast..." / "Unusually high demand for October dates...") even though the column rendered alongside real-LLM `getAIExplanation` rows from `runAnomalyDetection`. The detector still computes the anomaly (80%/60-day rule for high demand, 90%/30% rule for Saturday skew); the LLM takes the struct (fill rate %, Saturday vs weekday split, slot counts, days out) and produces a 2-3 sentence `ai_explanation` in coordinator voice. callAIJson, tier 'sonnet', temp 0.3, maxTokens 300, taskType `availability_anomaly_explanation`. Cost-ceiling gate via `gateForBrainCall`; when closed OR Sonnet fails, falls back to the original templates so behaviour at the edge is unchanged. Migration 252 adds `anomaly_alerts.explanation_source` ('ai' / 'template' / 'rule') stamped on every new write — the UI can now distinguish a Sonnet hypothesis from a template fallback. `runAnomalyDetection` also stamps the column ('ai' when the existing `getAIExplanation` returned a result, 'rule' when it failed and the column stayed NULL). |
| intelligence-engine-narration | — | v1 | AI-VS-TEMPLATED-AUDIT.md finding #1. NEW LLM narrator over the 14 deterministic detectors in `src/lib/services/intel/intelligence-engine.ts`. Each detector still does the math (which day converts best, which source has the highest conversion, etc.) and emits `narrator_facts` (family + framing string + numeric allowlist). The narrator dispatches by family (9 shape-families: conversion_comparison / volume_comparison / source_quality / concentration_pattern / count_with_risk / capacity_signal / per_couple_score / entity_outlier / operational_pattern) into one Sonnet call (temp 0.4, maxTokens 320, taskType `intelligence_engine_narration`). Output is numbers-guarded against the detector's allowlist (reuses `insights/numbers-guard.ts`). Falls back to the existing detector-composed template when the cost-ceiling gate is closed, the LLM call fails, or the numbers-guard rejects the narration. Each persisted row stamps `narration_source = 'llm' \| 'template'` (migration 251) so a future UI badge can distinguish real LLM narration from template-fallback rows. Per Isadora directive 2026-05-09: switch to all-LLM narration until cost-optimisation matters; option C hybrid is parked. |

## 2026-05-08

| Module | Old | New | Reason |
|--------|-----|-----|--------|
| brain-dump | v1.0 | v1.1 | Added `help_question` intent + disambiguation rule for help vs knowledge_base import (Isadora feedback round). |
| brain-dump-help | — | v1.0 | New help-mode answer prompt; curated surface map of ~50 Bloom routes; constrained-output JSON. |
| asset-matcher | — | v1.0 | New Haiku prompt for Sage email auto-attach. Picks 0-3 brand-assets photos that would clearly add value to an outbound reply; defaults to empty. Pairs with migration 244 opt-in toggle. |
| inbox-folder-ai | — | v1.0 | New Haiku prompt for inbox folder triage. Reads from/subject/body and picks one of the six lifecycle folders (new_inquiry / potential_client / client / vendor / advertiser / other) when the structured rule chain in lifecycle.ts cannot. Used as a fallback when rules return 'other' with no strong CRM signal, and powers the coordinator-triggered /api/admin/reclass-folders-ai sweep that relabels historical 'other' rows. Body sliced to 2000 chars; maxTokens=200; defensive fallback to 'other' on any malformed output so a bad response never blocks the pipeline. |
| lifecycle-signal | — | v1.0 | New Haiku prompt for wedding-lifecycle signal detection. Reads one inbound email and emits a LifecycleSignal (lead_declined / going_with_other / silent_close / tour_cancelled / tour_completed / contract_signed / deposit_paid) or null. Output feeds the pure state machine in `lib/services/lifecycle/wedding-lifecycle-engine.ts` (migration 246). Closes the Naina Davidar regression where WeddingPro "decided to close the conversation" produced a chirpy auto-reply because no upstream surface knew the lead was gone. Body sliced to 2000 chars; maxTokens=200; temperature 0.1; confidence floor=70 (below the floor returns null); outbound rows + auto-mail return null without an LLM call. taskType='lifecycle_signal_detect'. |

## Per-brain history

### inquiry-brain (`inquiry-brain.prompt.v1.1`)
- **v1.1** (2026-05-02) — T5-schema-gap (migration 165). EXTRACTED
  DATA context block now emits a "Headcount status: KNOWN | NOT YET
  CAPTURED" line so Sage knows whether to ask for guest count. Paired
  with `task-prompts-inquiry.ts` "GATHER PERSONALIZATION DETAILS"
  edit that says don't infer a number from "small / intimate / large".
- **v1.0** (2026-05-01) — Initial versioning baseline. Captures the
  4-layer assembly (UNIVERSAL_RULES + personality + task prompt +
  learning block) as it stands at T1-E land.

### client-brain (`client-brain.prompt.v1.0`)
- **v1.0** (2026-05-01) — Initial versioning baseline. UNIVERSAL_RULES
  + CLIENT_RULES + personality + task prompt + learning block.

### sage-brain (`sage-brain.prompt.v1.2`)
- **v1.2** (2026-05-07) — Tier-A #3 closure. Ported the Rixey-portal
  Sage persona scaffold (SAGE_BASE_PERSONA in task-prompts-sage.ts).
  Voice characteristics, "what you're NOT" boundaries, factual-accuracy
  cite-your-source rule, and sign-off style now prepend every Sage task
  prompt. Production Rixey Sage had been running this scaffold for
  months with zero tone-related escalations; bringing the warmth +
  reassurance + non-human framing into the bloom-house Sage default.
  Venue-specific facts (property, rates, policies) still come from
  per-venue config + KB; this scaffold is the universal floor.
- **v1.0** (2026-05-01) — Initial versioning baseline. 4-layer assembly
  with KB context + intelligence-context block. Tier-1 content (couple
  PII, family context).

### router-brain (`router-brain.prompt.v1.1`)
- **v1.1** (2026-05-02) — T5-schema-gap (migration 165). Added
  `estimatedGuests` extraction field with explicit guidance for
  ranges (take midpoint), approximate phrasing ("around 150"), the
  1-1000 range gate, and the do-not-infer-from-adjectives rule for
  "small / intimate / large". Lands in `weddings.estimated_guests`.
- **v1.0** (2026-05-01) — Initial versioning baseline. Email
  classification on Haiku (per OPS-21.4.2) with the 7-class label set.

### intel-brain (`intel-brain.prompt.v1.2`)
- **v1.2** (2026-05-09) — TRENDS-DIAGNOSIS Fix 4 / Finding F. Added
  CORRELATION NARRATIONS section (top-5 by surface_priority,
  un-expired, un-dismissed) to gatherVenueData + formatDataContext so
  Sage can quote engine-discovered cross-channel pairs by title + r +
  lag instead of hedging on macro-story questions. System prompt's
  "When answering" preamble updated to point the LLM at CORRELATION
  NARRATIONS first when macro / FRED / cultural-moment questions land.
- **v1.1** (2026-05-02) — T5-Rixey-PP. NLQ context-loader gaps closed
  per Stream MM real-data load (Q4 "busiest tour month" returned
  ungrounded; Q1 "Google Ads ROI" needed a manual cron refresh first).
  `gatherVenueData` now pulls (a) `toursByMonth` — last 12 months of
  tours bucketed by `scheduled_at` UTC month with completed / cancelled
  / no_show / rescheduled / pending breakdown, and (b)
  `marketingSpendByMonth` — direct read of `marketing_spend` rows
  (source × month × amount × notes) to give Sage always-fresh per-month
  spend without depending on the weekly `source_attribution` cron.
  System prompt updated to describe both blocks, plus a clarifying note
  on SOURCE ATTRIBUTION explaining the cron-freshness caveat and
  pointing the LLM at MARKETING SPEND BY MONTH for recent-spend
  questions.
- **v1.0** (2026-05-01) — Initial versioning baseline. Covers both NLQ
  (`generateNLQResponse`) and positioning suggestions
  (`generatePositioningSuggestions`).

### post-tour-brief (`post-tour-brief.prompt.v1.0`)
- **v1.0** (2026-05-01) — Initial versioning baseline. Brief composer
  + follow-up draft composer. Tier-1 content (transcript-derived
  family/financial intelligence).

### heat-narration (`heat-narration.prompt.v1.1`)
- **v1.1** (2026-05-02) — T5-followup-AA. Trajectory bucket
  (rising / falling / plateau / volatile / unknown) added to the
  user prompt + system prompt instructions so the LLM grounds
  prose in heat direction over the last ~14 days, not just the
  static score. Prompted action selection now keys on (tier ×
  trajectory) — same warm score reads "stabilise with a clarifying
  call" when volatile vs "send a tour follow-up" when steady.
  Cache key gains a `trajectory` field so a wedding climbing 40→55→70
  and a wedding crashing 100→85→70 don't collapse onto the same
  cached prose. ONE more cache-miss vector by design — the platform
  underreports volatility today. 4 buckets (+ unknown) is enough.
- **v1.0** (2026-05-01) — Initial versioning baseline. T3-A heat
  narration generator. Sonnet-tier; deterministic fallback runs when
  cost ceiling pauses the venue.

### cancellation-classifier (`cancellation-classifier.prompt.v1.1`)
- **v1.1** (2026-05-09) — LLM-CALL-INVENTORY tier-correctness sweep.
  Demoted Sonnet to Haiku. The classifier output is a closed 9-bucket
  enum plus 3-level confidence; the same shape as router-brain and
  lifecycle.signal-detector which already run on Haiku. Cache key model
  id flipped from `'sonnet'` to `'haiku'` so cached entries stay
  tier-correct. Prompt body unchanged.
- **v1.0** (2026-05-02) — T5-Rixey-JJ. Free-text → enum classifier for
  tour cancellation reasons. Mirrors migration 176's extended CHECK
  enum (lost_to_competitor / venue_unavailable / health_emergency
  added beyond migration 166's original 8). Two-stage: heuristic over
  the dominant Rixey Calendly patterns first, then LLM (Sonnet, tier-1
  content, cost-ceiling-gated, FNV-1a-cached) for the long tail.
  Returns `{ reason, note, confidence: 'high'|'medium'|'low' }`.
  Empty / 'n/a' / single-char inputs short-circuit to 'other' / 'low'.
  Gated venues fall back to heuristic-only.

### voice-dna-extract (`voice-dna-extract.prompt.v1.0`)
- **v1.0** (2026-05-02) — T5-θ.3. Extracts greetings, signoffs, pet
  phrases, punctuation tics, voice rules, and sentence rhythm from a
  batch of coordinator-written outbound emails. Used for the Day-4
  onboarding seed pass over the 12-month Gmail backfill. Tier-1 content
  (outbound emails contain couple PII + sometimes family context).
  Sonnet-tier for the nuanced extraction; Haiku is too brittle on
  free-text style identification at this batch size.

### anomaly-detection (`anomaly-detection.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. AI hypothesis generation
  for metric anomalies with Internal Context bundle (absences, operational state,
  pricing changes, marketing channels). Haiku tier.

### brain-dump (`brain-dump.prompt.v1.1`)
- **v1.1** (2026-05-08) — Added `help_question` intent (8th class) for "where
  do I X" / "how do I X" coordinator questions. Help-mode does NOT propose-
  and-confirm; it returns a curated answer + click-through links via the new
  brain-dump-help prompt. Disambiguation rule added: a single platform
  question is help_question, a list of Q/A pairs is knowledge_base_import.
- **v1.0** (2026-05-05) — Initial versioning baseline. 7-intent classifier
  (client_note / availability / analytics / staff_observation / operational_note /
  knowledge_base_import / ambiguous). Haiku tier, tier-1 content.

### brain-dump-help (`brain-dump-help.prompt.v1.0`)
- **v1.0** (2026-05-08) — Help-mode Q&A answer prompt. Constrained-output
  JSON `{body, links}`. Surface map of ~50 Bloom routes embedded in the
  system prompt; the model is instructed never to invent paths and to
  admit uncertainty when no entry matches. Haiku tier, tier-3 content
  (no PII).

### briefings (`briefings.prompt.v1.1` / `briefings.monthly.v1.1`)
- **v1.1** (2026-05-09) — TRENDS-DIAGNOSIS Fix 4 / Finding F. Weekly +
  monthly briefings now receive a MACRO CONTEXT block from
  `getBriefingMacroContext` (cultural moments + FRED deltas + upcoming
  calendar events + top-5 correlation narrations). System prompts add
  guidance to weave the most relevant macro signal into the briefing,
  prefer quoting correlation-narration titles over re-describing
  numbers, and never invent macro relationships when the block is
  empty. Closes YC-partner HIGH 12.
- **v1.0** (2026-05-05) — Initial versioning baseline. Weekly briefing uses
  `BRIEFING_PROMPT_VERSION`; monthly uses `MONTHLY_BRIEFING_PROMPT_VERSION`.
  ANTI-19.9-A numbers-discipline guard in both prompts.

### cultural-moments-llm-propose (`cultural-moments-llm-propose.v1`)
- **v1** (2026-05-09) — TRENDS-DIAGNOSIS Fix 3 / Finding A. NEW
  judgement-tier proposer alongside the legacy z-score detector. Sonnet
  (Haiku would template the output). Temperature 0.4, maxTokens 800.
  Proposes 0-3 NAMED cultural moments per venue per day with evidence
  URL + dateable window + one-sentence rationale. Five-criterion bar
  enforced both in prompt + structurally (drop on missing URL / bad
  category / unparseable date). Inserts as `proposed_by='ai_llm'` per
  migration 250. Per-venue dedup against (kind='llm_propose', title,
  weekStart). Cost ceiling gated.

### intelligence-engine-narration (`intelligence-engine-narration.v1`)
- **v1** (2026-05-09) — AI-VS-TEMPLATED-AUDIT.md finding #1. Replaces
  the 14 deterministic detector templates in
  `src/lib/services/intel/intelligence-engine.ts` with a real
  numbers-guarded LLM narrator. Detectors still compute the
  numeric pass (which day converts best, source quality, pipeline
  stalls, etc.) and emit `narrator_facts` with three parts:
  `family` (one of 9 shape-families: conversion_comparison /
  volume_comparison / source_quality / concentration_pattern /
  count_with_risk / capacity_signal / per_couple_score /
  entity_outlier / operational_pattern), a plain-English `framing`
  string, and a `numbers` allowlist. The narrator dispatches by
  family into one Sonnet call (temp 0.4, maxTokens 320, taskType
  `intelligence_engine_narration`). Output is numbers-guarded
  against the allowlist via `insights/numbers-guard.ts` (same
  guard used by every other LLM-narrating insight surface). Falls
  back to the existing detector template when (a) the cost-ceiling
  gate is closed, (b) the LLM call fails, or (c) the numbers-guard
  rejects the narration. Per-row provenance recorded in
  `intelligence_insights.narration_source` ('llm' / 'template')
  via migration 251 so a future UI badge can distinguish real LLM
  narration from template-fallback rows. Per Isadora directive
  2026-05-09: switch to all-LLM narration until cost-optimisation
  matters; option C hybrid is parked.

### candidate-ai-adjudicator (`candidate-ai-adjudicator.prompt.v1.1`)
- **v1.1** (2026-05-09) — LLM-CALL-INVENTORY tier-correctness sweep.
  Promoted Haiku to Sonnet. Schema is bounded but inputs are qualitative:
  first-name + last-initial + state + timing + funnel-depth +
  recent_email_subjects text patterns ("saw you on The Knot"). A wrong
  call lands the wrong wedding's history on the wrong couple, and the
  cost of that error far outweighs the 12x per-call delta. The original
  v1.0 `Sonnet was overkill` rationale assumed the schema constraint did
  the judgement work; the inventory pass found the schema is bounded
  but the reasoning is not.
- **v1.0** (2026-05-05) — Initial versioning baseline. Tier 2 ambiguous-match
  adjudicator: bounded JSON schema (match_wedding_id + confidence + reasoning).
  Haiku tier per OPS-21.4.2.

### daily-digest (`daily-digest.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. 2-3 sentence morning
  summary for coordinator. Sonnet tier.

### data-detection (`data-detection.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. Covers both detectDataType
  (24-class classification) and mapColumns (source→target dict). Haiku tier.

### extraction (`extraction.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. Structured signal extraction
  from inquiry email bodies (30-field schema). Haiku tier.

### planning-extraction (`planning-extraction.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. Wedding planning decision
  extraction from Sage chat messages (8-category schema). Sonnet tier.

### marketing-spend (`marketing-spend.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. Free-text → structured
  spend rows (source / month / amount). Sonnet tier.

### bar-recipe-extract (`bar-recipe-extract.prompt.v1.0`)
- **v1.0** (2026-05-05) — Initial versioning baseline. Covers URL extraction
  (via callAIJson) and upload extraction. Image uploads rewired through callAIVision
  so circuit breaker and cost logging apply. PDF path retains direct SDK call
  (document block) with manual api_costs insert + promptVersion. Sonnet tier.

### journey-narrative (`journey-narrative.prompt.v1.0`)
- **v1.0** (2026-05-06) — Initial versioning baseline. 2-3 sentence
  retrospective narrative composed from candidate-identity touchpoints +
  attribution events for a wedding. Sonnet tier; tier-1 content
  (couple PII via context). Closes Tier-B #75 telemetry gap — was logging
  api_costs.prompt_version=NULL.

### re-engagement-drafter (`re-engagement-drafter.prompt.v1.0`)
- **v1.0** (2026-05-06) — Initial versioning baseline. Tier-2 winback
  drafter (email + SMS variants) for re-engagement playbook. Sonnet tier;
  tier-1 content (couple first name / state / activity history). Closes
  Tier-B #75 telemetry gap — was logging api_costs.prompt_version=NULL.

### risk-flags (`risk-flags.prompt.v2.0`)
- **v2.0** (2026-05-09) — Coordinator-prompt assembler migration. Both
  the sentiment-scan call and the narrator call now route through the
  canonical `buildCoordinatorPrompt` so the addressee, voice, and
  numbers-guard discipline match every other coordinator narrator.
  Subsumes the v1.1 tier promote below.
- **v1.1** (2026-05-09) — LLM-CALL-INVENTORY tier-correctness sweep.
  Sentiment-scan call (line 346) promoted Haiku to Sonnet. Classifies
  the last 3 inbound emails as negative-or-hesitant true/false. The
  companion narrator on line 487 stays Sonnet and treats the
  classification as load-bearing input. Haiku errors compounded
  through the narrator. Narrator call left unchanged. Rolled forward
  into v2.0 above.
- **v1.0** (2026-05-05) — Initial versioning baseline. Sentiment scan
  plus narrator pair for couple risk-flag detection.

### tour-cancellation-reason (`tour-cancellation-reason.prompt.v1.0`)
- **v1.0** (2026-05-09) — LLM-CALL-INVENTORY backfill plus tier demote.
  Initial versioning of the inbound-email cancel-reason classifier.
  Haiku tier (was Sonnet by default; bounded 8-bucket enum). Sibling
  of brain/cancellation-classifier; same shape, same enum surface,
  applied at email-pipeline scheduling-event handling instead of
  coordinator free-text.

### review-language (`review-language.prompt.v1.0`)
- **v1.0** (2026-05-09) — LLM-CALL-INVENTORY backfill plus tier demote.
  Initial versioning of the per-review phrase extractor. Haiku tier
  (was Sonnet by default; closed `REVIEW_THEMES` enum, identical shape
  to voice/gmail-backfill).

### transcript-voice-learning (`transcript-voice-learning.prompt.v1.0`)
- **v1.0** (2026-05-09) — LLM-CALL-INVENTORY backfill plus tier demote.
  Initial versioning of the booked-and-5-star tour transcript phrase
  extractor. Haiku tier (was Sonnet by default; closed `REVIEW_THEMES`
  enum, same shape as voice/gmail-backfill and intel/review-language).

### portal-quick-add (`portal-quick-add.prompt.v1.0`)
- **v1.0** (2026-05-09) — LLM-CALL-INVENTORY backfill. Initial
  versioning of the document-to-CSV extraction surface. Covers the docx
  text path (callAIJson) and the vision path (callAIVision) inside
  `app/api/portal/quick-add/route.ts`.

### weekly-digest (`weekly-digest.prompt.v1.0`)
- **v1.0** (2026-05-09) — LLM-CALL-INVENTORY backfill. Initial
  versioning for the executive-summary call inside `generateDigestSummary`
  (`src/lib/services/intel/weekly-digest.ts`).

### trends-recommendations (`trends-recommendations.prompt.v1.0`)
- **v1.0** (2026-05-09) — LLM-CALL-INVENTORY backfill. Initial
  versioning for the trend-recommendations generator
  (`src/lib/services/intel/trends.ts`).

## Adding a new brain prompt

1. Export `BRAIN_PROMPT_VERSION` at the top of the brain file.
2. Pass `promptVersion: BRAIN_PROMPT_VERSION` to every `callAI` /
   `callAIJson` / `callAIVision` call inside the brain.
3. If the brain produces drafts, the consumer that inserts the draft
   row imports the constant and stamps `prompt_version_used`.
4. Add a row to this changelog under that brain's section.

## Bumping an existing version

1. Edit the prompt.
2. Increment the constant in the brain file.
3. Add a changelog row with date + reason + behavioural impact.
4. (Optional) Open a follow-up to compare api_costs cost / latency /
   confidence_score distribution before vs after the bump.
