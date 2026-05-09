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

### cancellation-classifier (`cancellation-classifier.prompt.v1.0`)
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

### candidate-ai-adjudicator (`candidate-ai-adjudicator.prompt.v1.0`)
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
