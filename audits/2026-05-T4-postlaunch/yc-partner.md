# Bloom T0-T4 Audit — Character 4: The YC Partner

Date: 2026-05-02
Scope: Pitch-vs-product gap; USP scoring; multi-tenant story.

## Summary

The plumbing is real. USPs #1 (heat + decay) and #5 (NLQ) demo today on Rixey; #3 (Voice DNA) is end-to-end on a venue with reviews, but day-1 generic. USP #4 (External macro signal correlation) — the limb the playbook flags as the single biggest moat — is the gap of the deck: the FRED writer ships into onboarding-only, the daily cron writes a different table than the correlation engine reads, and no LLM-narrated surface anywhere ingests the external limb. Multi-tenant scope (`venue → group → company`) is wired in `resolvePlatformScope` and RLS via `user_visible_venue_ids()`, but there is no first-party three-level dashboard yet — `intel/regions` groups by `venues.state`, not Wedgewood's region model.

## Findings

### CRITICAL 1. USP #4 — FRED daily cron writes the wrong table
**USP / surface:** USP #4 — `src/app/api/cron/route.ts:97-98`, `src/lib/services/economics.ts:77-132`, `src/lib/services/external-context/fred-fetch.ts:106-161`
**Playbook reference:** Part 9.2 USP #4 / T2-C / ARCH-18.3-D / Playbook 17.4-A
**What this proves:** The daily `economic_indicators` cron (Wed @ 03:00 UTC, `vercel.json:44-46`) calls `economics.fetchAllEconomicIndicators` which writes `economic_indicators` (`economics.ts:122-124`). The correlation engine reads `fred_indicators` (`correlation-engine.ts:32` → `external-context/fred.ts:56`). The new `fred-fetch.ts` (which DOES write `fred_indicators`) is only invoked from `/api/onboarding/backfill/route.ts:134` — there is no daily writer. After the onboarding backfill, the macro series the engine consumes age out and the engine silently drops the FRED channels. USP #4's primary signal channel is on a one-shot heartbeat.
**Would experience this as:** "Show me how mortgage rates correlated with our inquiries this month" returns nothing because `fred_indicators` last updated when the venue onboarded; the engine quietly excludes the channel from its 90-day window.

### CRITICAL 2. USP #4 — No surface narrates a single macro correlation
**USP / surface:** USP #4 — `src/lib/services/correlation-engine.ts:380-398`, `src/lib/services/anomaly-detection.ts:597-656`
**Playbook reference:** Part 9.2 USP #4 / Anti-pattern: "shipping the limb without the narration"
**What this proves:** `correlation-engine.computeCorrelationsForVenue` writes raw r-coefficients with templated headlines like `"X correlates with Y (r=0.62)"` (`correlation-engine.ts:384`). Nothing calls Claude on these rows to explain WHY in plain English. The one LLM-narrated explainer that could close the gap — `anomaly-detection.getAIExplanation` (`anomaly-detection.ts:597`) — only reads `InternalContextBundle` (absences, operational state, pricing, marketing channels) at lines 408-439. It does NOT read FRED, cultural moments, or weather. Result: the macro limb computes, the macro limb writes, but no surface ever says "April booking velocity below trend, correlated with Memorial Day weekend + 30y mortgage rate at multi-year high."
**Would experience this as:** "Show me one real macro correlation Bloom surfaced this month" returns either an r-coefficient with a template headline or an internal-context-only anomaly hypothesis. There is no human-readable cross-limb story.

### CRITICAL 3. USP #4 — Cultural moments auto-propose has no cron
**USP / surface:** USP #4 — `src/lib/services/insights/cultural-moments-auto-propose.ts`, `src/app/api/intel/cultural-moments/auto-propose/route.ts:22-83`
**Playbook reference:** T2-C / INS-19.5.8 / ARCH-19.8-D
**What this proves:** The auto-propose service is implemented (366 lines, real z-score detection with persistence rules). Its only entry point is the POST route, which a coordinator must trigger manually. There is no entry in `vercel.json:1-103` for cultural moments auto-propose. So unless an org_admin clicks "scope=all" on schedule, no cultural moments are ever auto-proposed; the propose-and-confirm queue sits empty.
**Would experience this as:** A demo of the cultural moments queue is empty unless the coordinator just triggered the manual sweep, even though SerpAPI trends are flowing and the spike detector would otherwise have proposals.

### CRITICAL 4. USP #5 — Sage NLQ data-gather doesn't pull from Phase B or External Context
**USP / surface:** USP #5 — `src/lib/services/intel-brain.ts:192-327`
**Playbook reference:** Part 9.2 USP #5 / cross-limb queries
**What this proves:** `gatherVenueData` in `intel-brain.ts:206-297` runs ten parallel queries: weddings, source_attribution, search_trends, trend_recommendations, weather_data, consultant_metrics, review_language, economic_indicators. It does NOT touch `attribution_events`, `candidate_identities`, `tangential_signals`, `cultural_moments`, `fred_indicators`, or `external_calendar_events`. The system prompt at `intel-brain.ts:130-181` doesn't list any of these data domains either. The "Did Knot conversion drop because of Memorial Day or because of inflation?" cross-limb question literally cannot be answered — the data block Sage reasons over has no Memorial Day signal and no inflation signal beyond the legacy `economic_indicators` table. The numbers-discipline guard at lines 177-181 is correct, but it just prevents fabrication; it doesn't add coverage.
**Would experience this as:** Ask Sage "show me which platforms had pre-inquiry signals before this month's bookings" → Sage hedges or refuses. The Phase B identity-resolution moat (next finding) is invisible to NLQ.

### HIGH 5. Identity-resolution moat — chip exists, never rendered
**USP / Part 9.3 surface:** `src/components/intel/inline-primitives.tsx:139-158`
**Playbook reference:** Part 9.3 — multi-touch attribution as the moat
**What this proves:** `PriorTouchesBadge` is exported from `inline-primitives.tsx:139` and has the negative-result transparency it should have. Grep across `src` for `import.*PriorTouchesBadge` or `<PriorTouchesBadge` returns zero hits. The `prior-touches.ts:39` service is used by `sage-intelligence` in the brain context (good — the AI sees the touches), but the visible coordinator surface is missing. `PriorTouches` data flows into the email draft, never onto the inbox card. The story "this couple liked you on Instagram March 14, was in Knot analytics March 22, then inquired April 23" is computed but not displayed to the human investor watching the demo.
**Would experience this as:** Open the Rixey inbox, look at a fresh inquiry — there is no chip showing prior touchpoints even when prior touches exist. The moat fires for the AI; the demo doesn't show it.

### HIGH 6. USP #2 — `source_provenance` written but never read
**USP / surface:** USP #2 — `supabase/migrations/146_marketing_spend_source_provenance.sql:27-28`, `src/lib/services/marketing-spend.ts:91`, `src/lib/services/insights/pricing-elasticity.ts` (no match)
**Playbook reference:** LIMB-16.2.4-C
**What this proves:** Migration 146 added `marketing_spend.source_provenance` with the correct enum + index. `marketing-spend.ts:91` and `data-import.ts:389` write it. A Grep for `source_provenance|provenance` against `src/lib/services/insights/pricing-elasticity.ts` returns zero matches. The migration comment at line 49-51 explicitly says: "Drives data-quality weighting in source-attribution + pricing-elasticity confound detection." The downstream consumer doesn't exist. The column is dead-letter data — schema discipline without compute.
**Would experience this as:** A pricing-elasticity insight reasoning over `brain_dump_text`-extracted spend numbers treats them with the same weight as Meta-API-integrated spend. The "trustworthy first-party data" filter the deck implies isn't there.

### HIGH 7. USP #2 — Internal Context demo seed is empty
**USP / surface:** USP #2 — `supabase/seed.sql` (no matches for the relevant tables)
**Playbook reference:** T2-B Phase 2 / LIMB-16.2.1-3
**What this proves:** Grep for `marketing_channels|coordinator_absences|venue_operational_state|pricing_history` against `supabase/seed.sql` returns zero matches. The demo venue (Hawthorne Manor) ships zero Internal Context rows. The coordinator UI for those tables is at `/portal/marketing-channels-config`, `/portal/absences-config`, `/portal/property-state-config` — but in demo, the consumer (`anomaly-detection.loadInternalContextForAnomaly`, `anomaly-detection.ts:441-549`) loads empty arrays. The hypothesis prompt at `anomaly-detection.ts:614-650` then has the explicit fallback "Internal context: none logged for this period" (`anomaly-detection.ts:584`). The demo cannot show the Internal Context-driven hypothesis chain because there's no Internal Context.
**Would experience this as:** The investor sees "Bloom uses your team calendar + property state to explain anomalies" in the deck. The demo runs anomaly detection on Hawthorne, the LLM has nothing to weigh, and the explanations default to funnel-shape causes.

### HIGH 8. USP #1 — heat-narration demo will fall back to deterministic template on cold venue
**USP / surface:** USP #1 — `src/lib/services/insights/heat-narration.ts:249-269`
**Playbook reference:** T3-A / INS-19.3.1
**What this proves:** Heat narration is real: classical evidence load (`heat-narration.ts:62-121`), LLM with numbers-guard (`callAI` at `heat-narration.ts:223-231`, allowedNumbers at `heat-narration.ts:114-119`), persistence + cache (`heat-narration.ts:283-298`). Strong implementation. But the deterministic fallback at lines 249-269 fires whenever the LLM call fails or numbers-guard rejects. That fallback produces literal strings like `"Heat score 87 based on 12 engagement events. tour_completed, email_reply_received, contract_viewed drove this score"` — not the venue voice and visibly templated. Nothing in the build surfaces "this narration is the fallback" to the coordinator. On a fresh demo venue with sparse engagement, the cache miss + low-confidence narration + numbers-guard rejection (the guard is strict enough that 1-2 events is hard to narrate without inventing structure) plausibly degrades to template.
**Would experience this as:** Hover a hot lead in demo and see Sage-voice narration. Hover a cool lead and see the fallback shape — investor reads the template, asks why it's different, and the answer is "the AI couldn't ground numbers."

### HIGH 9. USP #3 — Voice DNA has no Gmail-backfill seed path
**USP / surface:** USP #3 — `src/lib/services/onboarding-backfill.ts` (no `voice_preferences` writes), `src/app/api/agent/backfill-senders/route.ts` (sender attribution only)
**Playbook reference:** Part 9.2 USP #3 — "Voice DNA seeded from Gmail backfill"
**What this proves:** Voice DNA composes from `review_language` + `voice_preferences` + `voice_training_sessions` + `phrase_usage` (`/api/intel/voice-dna/route.ts:188-206`). Grep for `voice_preferences|review_language|voice_training_sessions` against `onboarding-backfill.ts` returns no matches. `backfill-senders/route.ts` only patches sender identity on historical interactions — it does not extract voice from outbound coordinator emails. `transcript-voice-learning.ts` mines tour transcripts of booked + 5-star couples (good), but tours seed the venue post-onboarding. The deck implies "we read your sent folder, learn your voice, and Sage sounds like you on day one." The path that does that doesn't exist.
**Would experience this as:** A new venue's day-1 Sage draft is generic-with-personality-sliders, not Isadora-voiced — because the Voice DNA pipeline needs reviews/training/transcripts that don't exist yet.

### HIGH 10. USP #2 — Source quality scorecard runs on a cold demo
**USP / surface:** USP #2 — `src/lib/services/source-quality.ts:68-422`, `supabase/seed.sql` (no `attribution_events`, no `candidate_identities`, no `marketing_spend`)
**Playbook reference:** Phase C / PC.1
**What this proves:** `source-quality.ts:262-411` adds Phase B / PC.1 candidate-funnel + CAC enrichment that depends on `tangential_signals`, `candidate_identities`, `attribution_events`, and `marketing_spend`. The demo seed at `supabase/seed.sql` has none of those tables populated. So Hawthorne's source quality scorecard renders rows from `weddings.source` legacy attribution only — the new Phase C columns (`signalsDelivered`, `candidatesCreated`, `avgFunnelDepth`, `costPerLead`) are all zero / null in demo. The scorecard's primary visual differentiation collapses on the demo venue.
**Would experience this as:** Hawthorne's `/intel/sources` shows the legacy table-of-numbers. The "Quality / Funnel / CAC" view-mode toggle exists but the Funnel and CAC columns are uniformly empty.

### HIGH 11. Multi-tenant — three-level scope is plumbed, three-level dashboards are not
**USP / surface:** Multi-tenant — `src/lib/api/resolve-platform-scope.ts:32-156`, `src/app/(platform)/intel/regions/page.tsx:142-194`, `src/app/(platform)/intel/company/page.tsx`, `src/app/(platform)/intel/portfolio/page.tsx`
**Playbook reference:** Part 9 / Wedgewood story
**What this proves:** The plumbing is good: `bloom_scope` cookie with `level: 'venue' | 'group' | 'company'`, `resolveScopeVenueIds()` expands to a venue list, RLS via `user_visible_venue_ids()` (migration 141) supports cross-venue reads scoped by `org_id`. But `intel/regions/page.tsx:143-150` groups venues by `venues.state` — not by a configurable Wedgewood-style "Northeast Region." There is no `regions` table or admin UI to define them. `intel/company` and `intel/portfolio` exist (610 + 761 lines) but the Wedgewood org-tree (Region → District → Venue) cannot be expressed.
**Would experience this as:** Wedgewood says "we have 8 regions, each with 5-12 venues." Bloom can show org-level rollup and state-grouping, but cannot show "Mid-Atlantic Region performance vs Pacific Region" because regions are not a first-class entity.

### HIGH 12. USP #5 — NLQ system prompt doesn't enumerate the new data limbs
**USP / surface:** USP #5 — `src/lib/services/intel-brain.ts:130-181`
**Playbook reference:** ANTI-19.9-A
**What this proves:** The system prompt enumerates: WEDDINGS, SOURCE ATTRIBUTION, SEARCH TRENDS, TREND RECOMMENDATIONS, WEATHER, ECONOMIC INDICATORS, CONSULTANT METRICS, REVIEW LANGUAGE. Missing: PHASE B (`attribution_events`, `candidate_identities`, `tangential_signals`), CULTURAL MOMENTS, EXTERNAL CALENDAR, INTERNAL CONTEXT (absences, operational state, pricing changes, marketing channels), CORRELATION INSIGHTS. The numbers-discipline ANTI-19.9-A clause IS present at lines 177-181 (good — it's correctly tightened). But Sage genuinely doesn't know about half the build. A coordinator asking "did the Memorial Day weekend hurt our tour conversion?" gets a hedge.
**Would experience this as:** Sage's answer space is meaningfully narrower than the deck implies. The investor asks any cross-limb question and Sage either ignores the limb or admits it doesn't have the data — even though the data exists in tables Sage was never told to query.

### MEDIUM 13. USP #1 — heat narration cache key references occurred_at-day, but score-history isn't included
**USP / surface:** USP #1 — `src/lib/services/insights/heat-narration.ts:156-168`
**Playbook reference:** T3-A
**What this proves:** Cache key includes score, tier, top-event-type@points@day, and totalEvents. It does NOT include `lead_score_history` shape — so two narrations on the same wedding with the same top-events but a markedly different score TRAJECTORY (e.g., a wedding that climbed steadily vs one that just bounced back from negative) collide on the cache. Less severe than the dropped-occurred_at fix it patched, but the cache key still captures static state, not dynamics. The narration's freshness is acceptable; its trajectory-awareness is not.
**Would experience this as:** Narration on a steady-climber and a bounce-back lead with identical current state read identical, even though the appropriate next-action differs.

### MEDIUM 14. USP #4 — Trends 12mo extension exists, but the historical window is gated by the 13-month FRED gap
**USP / surface:** USP #4 — `src/lib/services/trends.ts:166-174`, `src/lib/services/external-context/fred-fetch.ts:117`
**Playbook reference:** ARCH-18.3-D
**What this proves:** `trends.ts` correctly accepts `dateRange='today 12-m'` (line 174) for onboarding backfill — that 12-month extension is real. `fred-fetch.ts:117` defaults to a 13-month start window. But because of finding #1 (no daily FRED writer), the 13-month window is whatever it was when the venue onboarded. Trends grow daily; FRED stays frozen. The two limbs that should both be 12 months deep at any point in time aren't aligned over time.
**Would experience this as:** Correlation engine outputs that look like trends moved while the macro series were flat — because the macro series literally are flat (last sample = onboarding day).

### MEDIUM 15. USP #4 — Correlation engine writes are deduped by dec-of-month label heuristic
**USP / surface:** USP #4 — `src/lib/services/correlation-engine.ts:101-123`
**Playbook reference:** —
**What this proves:** `labelToDay` (correlation-engine.ts:101) maps 'Oct' → first-of-October-of-most-recent-past-year using a "current month vs target month" heuristic at lines 116-120. Marketing_metric labels frequently arrive as 'Oct' (no year). On a leap-year boundary or when the venue imports a January spreadsheet labeled 'Dec', the heuristic chooses 2025-12-01 vs 2024-12-01 by comparing current calendar month, which works for most cases but silently flips for boundary imports. Not a USP killer; it'd skew correlation pairs subtly.
**Would experience this as:** A correlation-engine insight blames a January 2026 marketing metric on December 2025 data — coordinator can't reproduce the math.

### MEDIUM 16. Multi-tenant — `Sage` hardcoded in the brain landing page
**USP / surface:** Multi-tenant — `src/app/(platform)/sage/page.tsx:18-20`
**Playbook reference:** INV-4.4-A
**What this proves:** The `/sage` brain index hardcodes "Sage's Brain" / "how Sage talks" / "what Sage knows" three times. INV-4.4-A says aiName is per-venue resolved. The doctrine-compliance.yaml claims INV-4.4-A is at `enforced` (line 41 of the YAML changelog). But the landing page violates it — and it's the page the coordinator lands on for personality work. White-label is partial.
**Would experience this as:** A Wedgewood demo where Sage is renamed "Hazel" still lands on `/sage` and reads "Sage's Brain" three times in the heading.

### MEDIUM 17. USP #4 — Correlation engine only runs weekly
**USP / surface:** USP #4 — `vercel.json:67-70`
**What this proves:** `correlation_analysis` is scheduled `0 7 * * 2` (Tuesdays @ 07:00 UTC). At a 90-day window, weekly cadence is acceptable for moving averages, but for a "macro signal correlation" surface that the deck pitches as the live moat, weekly delay between insight regenerations means the dashboard always trails the news by ~7 days.
**Would experience this as:** Investor asks "has the latest Fed rate move shown up here yet?" and the answer is "next Tuesday."

### LOW 18. Voice DNA — `daysLearning` counts from voice training, not from venue onboarding
**USP / surface:** USP #3 — `src/app/api/intel/voice-dna/route.ts:227-240`
**What this proves:** `daysLearning` is `min(voice_training_sessions.started_at, voice_preferences.created_at)`. A venue that set personality sliders + emoji + USPs but never ran a training game shows `daysLearning=0` — even at month 3. The metric reads as "Sage hasn't learned anything." It's the right computation for "voice DNA depth" but the wrong UX label.
**Would experience this as:** Hawthorne demo shows `daysLearning=0` if the seed didn't include training rows; investor reads the page as "Voice DNA hasn't started."

### LOW 19. NLQ guard — minimum 10 weddings or refuses
**USP / surface:** USP #5 — `src/app/api/intel/nlq/route.ts:17-85`
**What this proves:** Below 10 weddings, NLQ returns a stub. Smart and honest. But for a brand-new Wedgewood venue, the first 60 days have NLQ effectively muted.
**Would experience this as:** New-venue demo: NLQ refuses because <10 weddings. Investor sees the refusal as a feature limitation, not a guard.

## USP scoring matrix

| USP | Score | Confidence | Reasoning |
|---|---|---|---|
| #1 Pipeline + heat + decay | DEMOABLE TODAY | High | Heat scoring real (`heat-mapping.ts:404-537`), decay with cause classification real (`decay-re-engagement.ts:231-444`, six causes incl. `missing_info`/`waiting_on_partner` per INS-19.3.3), narration grounded in classical evidence + numbers-guard. Caveat per finding 8: deterministic fallback on cold cases. |
| #2 Source quality | DEMOABLE WITH SETUP | Medium | `source-quality.ts:68` Quality+Funnel+CAC views shipped; pricing-elasticity confound check ignores `source_provenance` (finding 6); demo venue has no `marketing_spend`/`attribution_events`/`tangential_signals` (finding 10), so Funnel + CAC columns are empty in demo. Internal Context tables empty in demo (finding 7). |
| #3 Voice DNA | PARTIAL | Medium | `personality-builder.ts` 4-layer assembly is real and used by `sage-brain.ts:16`. Voice DNA endpoint composes phrases + dimensions correctly. No Gmail-backfill seed path (finding 9), so day-1 ≠ day-N differentiation requires existing reviews/transcripts. Hardcoded "Sage" on the brain landing (finding 16). |
| #4 External macro correlation | ASPIRATIONAL | High | FRED daily cron writes the wrong table (finding 1); no LLM-narrated cross-limb surface (finding 2); cultural moments auto-propose has no cron (finding 3); weekly cadence (finding 17). The reader (`fred.ts`), engine (`correlation-engine.ts:208-229`), and stats math (`stats.ts`) are all real, but the limb does not produce a coordinator-readable insight today. |
| #5 NLQ | PARTIAL | High | `intel-brain.ts:130-181` has the ANTI-19.9-A numbers-discipline tightening. Data-gather only pulls from 8 of ~15 relevant tables (finding 4); system prompt doesn't enumerate Phase B / Cultural Moments / FRED / Internal Context (finding 12); 10-wedding floor (finding 19). Sage answers single-limb questions accurately and refuses cross-limb questions instead of hallucinating — that's correct, but it means the cross-limb pitch ("did Memorial Day or inflation hurt us?") is currently un-demoable. |

## Under-marketed strengths

1. **Identity-resolution depth (Part 9.3) is the moat the deck under-sells.** `candidate-resolver.ts` runs five Tier-1 deterministic paths (exact email/phone/username, name+window+uniqueness, full-name+state) before deferring to AI; `candidate-ai-adjudicator.ts:18-28` only fires on the 2-12-candidate ambiguous middle band; per-platform decay windows are coordinator-tunable via `/agent/identity-windows`. This is forensic-grade attribution work that no CRM does. The pitch frames it as "multi-touch attribution"; the build is closer to "evidentiary attribution with auditable adjudication."

2. **`numbers-guard` at `insights/numbers-guard.ts:33-78` is engineering-culture evidence.** Every T3 narration runs through a regex sweep that asserts the LLM only references numbers from the classical evidence allowlist, with month/year/quarter exceptions correctly handled. Pre-fix `\d{1,3}` split "2026" into "202"+"6" — that's a fix logged in the file comment at lines 50-52. Investor signal: Bloom built the LLM-numerical-hallucination guardrail before they had to.

3. **Cost ceiling (`cost-ceiling.ts:1-32`) implements the catastrophic-case guard most agentic startups defer.** $5/day per venue, UTC reset, autonomous-pause + 80%/100% notify, hourly cron (`vercel.json:96-97`), coordinator override via `POST /api/agent/cost-ceiling/resume`. Proactive insights are gated through `filterActiveVenues` (`correlation-engine.ts:472`, `cron/route.ts:706-710`, `cron/route.ts:789-793`). The deck doesn't mention this; it's exactly the answer to the partner question "what stops a runaway loop from burning $1k overnight."

4. **`doctrine-compliance.yaml` (1850 lines) IS the audit discipline.** 150 cells, 5-state enum (`enforced | partial | doctrine-only | at-risk | deprecated`), per-commit changelog at lines 32-60, regression alerts as a stated policy. The first audit response a partner gives is "show me the things you know are broken." Bloom can hand them this file. Most YC startups can't.

5. **Anomaly hypothesis is wired with Internal Context (`anomaly-detection.ts:597-656`).** When an anomaly fires, the LLM is told about coordinator absences, property state changes, pricing changes, and active marketing channels BEFORE being asked to hypothesize. The prompt at lines 619-621 explicitly says "weigh those causes BEFORE generic funnel shape explanations." This is the pattern the macro limb should adopt for finding 2 — half the work is already done.

## Multi-tenant readiness

The Wedgewood story is **buildable from current foundation but not yet built**. RLS via `user_visible_venue_ids()` (migration 141) supports cross-venue reads scoped by `org_id`; `resolvePlatformScope` already has `level: 'venue' | 'group' | 'company'` with cookie-driven scope and `resolveScopeVenueIds()` expansion (`resolve-platform-scope.ts:126-156`); `venue_groups` + `venue_group_members` tables exist. What's missing for Wedgewood specifically: (1) a first-class regions/districts entity with admin UI — `intel/regions/page.tsx:143-150` groups by `venues.state` which is not configurable; (2) per-region performance comparison surfaces; (3) per-region/per-company aggregation of T3 insights (today they're per-venue rows in `intelligence_insights`). The white-label work is done at the AI/prompt layer (per-venue `ai_name` resolved in `heat-narration.ts:185`, `decay-re-engagement.ts:222-229`) but partial at the chrome layer (finding 16). A focused 2-3 week sprint could close the dashboard gap; the auth + scope + RLS plumbing is the hard part and it's done.
