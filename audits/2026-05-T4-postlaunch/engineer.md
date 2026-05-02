# Bloom T0-T4 Audit — Character 1: The Elite Software Engineer

Date: 2026-05-02
Scope: Connectivity, invariants, race conditions, AP regressions

## Summary

The lineage thread is broken on at least four hops past the brain layer:
correlation_id is minted at the pipeline entry and threaded through router-brain /
inquiry-brain / client-brain / api_costs / drafts, but it stops dead at
engagement_events, interactions, notifications, and intelligence_insights — exactly
the rows a coordinator would chase when "what happened with this email" turns into
"what happened with this lead". Cost-ceiling is enforced on the cron-driven
intelligence-engine + autonomous-sender + daily-digest + follow-up-sequences +
anomaly-detection paths, but every T3 named-insight generator and the user-facing
`/api/insights/lead/[weddingId]` + `/api/insights/venue` endpoints bypass the gate
entirely; a coordinator hammering Refresh on a paused venue's lead detail still
spends LLM tokens. PII redaction landed in `lib/ai/client.ts` and a few tier-1
service catch sites, but every single T3 service (9 of them) logs raw `err.message`
on LLM failure — and the prompts contain couple PII. The slider/Pulse/digest UI
shipped clean of AP-6/AP-7/AP-12/AP-13/AP-19 but several pre-existing
intel surfaces still hardcode "Sage" in cross-venue contexts.

CRITICAL count: 6
HIGH count: 9
MEDIUM count: 6
LOW count: 4

## Findings

### [CRITICAL] 1. correlation_id is dropped at engagement_events / interactions / notifications

**File/surface:** `src/lib/services/heat-mapping.ts:284-313` (recordEngagementEvent) and `:327-389` (recordEngagementEventsBatch); `supabase/migrations/128_correlation_id_columns.sql:17-21`
**Playbook reference:** OPS-21.2.1 / T1-G / Part 22.x
**What this proves:** Migration 128 only added `correlation_id` to `api_costs` and `drafts`. The pipeline mints a correlation_id at `email-pipeline.ts:581` and threads it carefully through every callAI call (see `inquiry-brain.ts:558`, `client-brain.ts:398`, `router-brain.ts:292`), but `recordEngagementEventsBatch(...)` at `email-pipeline.ts:1336` and `recordEngagementEvent(...)` paths take no correlationId argument and the column doesn't exist on `engagement_events`. The same is true for `interactions` and `admin_notifications`. Migration 128's own header comment promises the lineage `interactions <- engagement_events <- drafts <- api_costs <- notifications`; only two tables in that chain actually carry the column. The promise is broken at the rows the coordinator most often chases.
**Would experience this as:** When you ask "what happened with this email" you can find the cost row and the draft, but the engagement_events that drove the heat score, the contact insertion, and the notifications fired are not joinable on a single ID — you have to walk timestamps and venue scoping again.

### [CRITICAL] 2. No T3 insight generator checks isAutonomousPaused / cost-ceiling before LLM

**File/surface:** `src/lib/services/insights/heat-narration.ts:223`, `decay-re-engagement.ts:342`, `negotiation-state.ts:248`, `risk-flags.ts:336` and `:456`, `cohort-match.ts:471`, `pricing-elasticity.ts:517`, `source-mix-counterfactual.ts:393`, `coordinator-override-pattern.ts:350`, `strength-area-cohort.ts:290`. None of them import `cost-ceiling`. Confirmed via `grep cost-ceiling src/lib/services/insights/` returns zero matches.
**Playbook reference:** OPS-21.4.3 / Part 19.8 / AP-17
**What this proves:** Playbook 21.4.3 says "When 100% is reached, autonomous behavior pauses (drafts queue for coordinator approval; no auto-sends; no proactive insights) until next day or coordinator override." `cost-ceiling.ts:147-160` describes itself as "the second line: cron services that consume LLM cost (anomaly hypothesis, weekly briefings, daily digests, intelligence engine, follow-up draft generation, re-engagement composition) skip paused venues so the ceiling isn't a softener." The T3 generators are exactly that kind of service — they spend Sonnet tokens per invocation — but none of them are gated.
**Would experience this as:** Venue hits its $5/day ceiling at 11am. Auto-send pauses. A coordinator opens a lead detail page; `/api/insights/lead/[weddingId]` runs five T3 generators each of which hits Claude. The "ceiling" becomes a notification, not a budget cap.

### [CRITICAL] 3. /api/insights/lead and /api/insights/venue are direct LLM endpoints with no rate limit

**File/surface:** `src/app/api/insights/lead/[weddingId]/route.ts:69-75` (5 generators in Promise.allSettled, `?refresh=1` honoured); `src/app/api/insights/venue/route.ts:42-47` (4 generators, same pattern).
**Playbook reference:** OPS-21.4.3 / AP-17 / Part 19.8
**What this proves:** These endpoints invoke the T3 generators directly from the user click path. `force=true` (when the coordinator clicks "Refresh") bypasses cache and forces every generator to call Claude. There is no rate limit, no per-coordinator quota, no isAutonomousPaused gate. A frustrated coordinator hammering Refresh on /intel/clients/[id] generates 5 Sonnet calls per click. There is no detection that the venue is at 100% ceiling.
**Would experience this as:** Coordinator finds insight stale, clicks Refresh seven times. Spends real money, possibly trips the ceiling, and the next venue's autonomous behavior pauses.

### [CRITICAL] 4. T3 services bypass redactError on every catch path; raw err.message hits stdout

**File/surface:** `src/lib/services/insights/heat-narration.ts:244` (`console.warn('[heat-narration] LLM call failed:', err instanceof Error ? err.message : err)`), and the same shape at `negotiation-state.ts:266`, `risk-flags.ts:348` and `:474`, `cohort-match.ts:492`, `pricing-elasticity.ts:536`, `source-mix-counterfactual.ts:411`, `coordinator-override-pattern.ts:368`, `strength-area-cohort.ts:308`, `decay-re-engagement.ts:361`. `persist.ts:145` logs `error.message` similarly.
**Playbook reference:** OPS-21.3.3 / T0-8
**What this proves:** `lib/observability/redact.ts:90` is the wrapper. `lib/ai/client.ts:379, :431` use it on the Anthropic + OpenAI catches. None of the T3 services do. The prompts threaded into Claude here include couple PII (names, emails, interaction body fragments, sage_context_notes), and Anthropic 4xx errors echo the prompt content into `err.message`. Every one of these `console.warn` lines is a potential PII leak to Vercel logs. The constitution-level instruction was that tier-1 content NEVER appears in logs; T3 narration over couple PII is tier-1 by definition.
**Would experience this as:** A `400 input length exceeded: 'Hi I'm Alice and my fiancé Bob'` error from Claude on a long-history wedding lands in Vercel logs verbatim with the names attached.

### [CRITICAL] 5. Heat score and intelligence_insights cache do not recompute when inquiry_date moves

**File/surface:** `supabase/migrations/119_attribution_first_touch_trigger.sql:23-67` only updates `attribution_events.bucket` and `attribution_events.is_first_touch`. `src/lib/services/heat-mapping.ts:659` reads `wedding.inquiry_date` as the silence-floor anchor for the daily decay job. `src/lib/services/insights/heat-narration.ts:156-168` builds a cache_key over `score + tier + top_events + total_events` — inquiry_date is NOT in the key. There is no UPDATE-OF-inquiry_date trigger that touches `weddings.heat_score` or `intelligence_insights.cache_key` / `last_classical_signature`.
**Playbook reference:** INV-2.5 / Part 12.3 / Anti-pattern 14 #16 ("derived fields must update when their inputs change")
**What this proves:** When inquiry_date moves backwards, `silentDays` jumps (impacts the auto-lost branch) but `heat_score` is only updated by the heat-decay cron — so for up to 24h heat is stale. The T3 cache doesn't notice at all because inquiry_date isn't in its fingerprint. The trigger 119 fixed bucket + first_touch but explicitly left the rest.
**Would experience this as:** Coordinator corrects an inquiry_date back two weeks; the heat narration card keeps repeating the old "10 days silent" story until either the heat-decay cron runs or someone clicks Refresh.

### [CRITICAL] 6. T2-A confidence_flag has zero readers in T3

**File/surface:** Migration `137_confidence_flags.sql` adds `confidence_flag` to `weddings`, `people`, `interactions`, `engagement_events`, `marketing_spend`. Only writer is `src/lib/services/onboarding-project.ts`. `grep confidence_flag src/lib/services/insights/` returns no matches. `cohort-match.ts:237-247` selects candidate weddings (`status in ('booked','completed','lost')`, last 3 years) without filtering on `confidence_flag`.
**Playbook reference:** INV-18.5 / ARCH-18.4 / ANTI-19.9 (transparency)
**What this proves:** During the 5-day onboarding project a venue's history is backfilled from CRM exports. Those rows land with `confidence_flag='backfilled'` (or partial). Then a coordinator opens a lead and the cohort generator pulls 50+ "comparable" weddings — most of them backfilled with low-fidelity data — and confidently produces a "look-alike cohort: 12/15 booked, median value $24k" narration. The numbers-guard passes (the numbers are real). The result is wrong because it's cohorting against partial data without disclosure.
**Would experience this as:** A booked-rate quoted to the coordinator that drives a "push to contract" recommendation, computed on a sample that's two-thirds incomplete-history backfill.

### [HIGH] 7. callAI accepts correlationId but lead-insights-panel never sends one

**File/surface:** `src/components/intel/lead-insights-panel.tsx:123-126` (fetch with no correlation header, no requestId); same at `pulse/page.tsx:113`. `lib/ai/client.ts:144` accepts the field; `inquiry-brain.ts:558` propagates it. Once you cross from server pipeline into client UI, the lineage starts again from scratch.
**Playbook reference:** OPS-21.2.1 / T1-G
**What this proves:** A coordinator clicks "Refresh insights" on a lead. Five Claude calls fire, each gets a fresh correlation_id (or none), and there is no way to ask later "show me every Claude call that came from THIS coordinator clicking THIS Refresh button." The lineage is forensically complete only on inbound paths; coordinator-driven paths are anonymous.
**Would experience this as:** "Why did Sage burn $0.40 between 2:14pm and 2:15pm?" is unanswerable from the api_costs table.

### [HIGH] 8. persistInsight returns hardcoded state='inserted' even on update

**File/surface:** `src/lib/services/insights/persist.ts:154`
**Playbook reference:** OPS-22.x telemetry
**What this proves:** The comment at line 149-153 says they used a SELECT-then-upsert race-prone pattern to derive 'inserted' vs 'updated', and gave it up for atomic upsert. Fine. But the function still returns `{ ok: true, state: 'inserted', insightId: ... }` — always. Every audit query that filters on `state='updated'` gets zero rows by definition. This is dishonest telemetry, not absent telemetry.
**Would experience this as:** Asking "how often does the cache stale invalidate vs first-write?" gives the wrong shape because the data shape lies.

### [HIGH] 9. Audio-capture orchestrator has a read-modify-write race that loses transcript text

**File/surface:** `src/lib/services/audio-capture/orchestrator.ts:131-157`
**Playbook reference:** Anti-pattern 11 / INV-5.4 (audio-capture invariant) / T2-E
**What this proves:** Two webhook deliveries for the same session_id arriving within milliseconds: both pass the bound-tour check (no row), both pass the auto-match window (no candidate), both reach the orphan-upsert. The upsert is idempotent on `(venue_id, session_id)` so only ONE row exists, but `currentOrphanText` and `currentCount` are read BEFORE the upsert. Caller A reads `transcript=''`, computes `nextOrphanText='HELLO'`, writes. Caller B reads `transcript=''` (same instant), computes `nextOrphanText='WORLD'`, writes after A. Final orphan: `transcript='WORLD'`. Both callers' `writeSegments` calls succeed against `transcript_segments`, so the per-segment forensic record is intact, but the rolled-up transcript text on the orphan / tour aggregate has lost half the audio. `tours.transcript` (line 76) has the same problem on the bound-tour branch.
**Would experience this as:** A 30-minute tour conducted with two devices uploads two halves; the coordinator-facing `tours.transcript` field shows only one half; the segment audit trail shows both. Post-tour brief reads from the rolled-up text.

### [HIGH] 10. /pulse does not surface cost-ceiling pause state

**File/surface:** `src/lib/services/pulse-aggregator.ts` (240 lines, no `autonomous_paused` lookup); `src/app/(platform)/pulse/page.tsx` (no banner / status block).
**Playbook reference:** ARCH-20.2.2 / OPS-21.4.3
**What this proves:** When a venue is paused, a `cost_ceiling_paused` notification fires once on the transition (`cost-ceiling.ts:248`). The notification appears in pulse. Coordinator clicks dismiss. Venue is still paused — but pulse no longer shows that. The aggregator pulls from notifications + anomalies + insights and reads no venue_config; there's no live indicator.
**Would experience this as:** Coordinator dismisses the alert, doesn't realize autonomous behavior is still off, reopens 12 hours later expecting drafts and finds queue.

### [HIGH] 11. Daily digest is venue-scoped but preferences are user-scoped

**File/surface:** `src/lib/services/digest-preferences.ts:19-35` (per-user row), `:144-164` (`enabledCategories(prefs)` exported but never imported elsewhere). `src/lib/services/daily-digest.ts:603` (`sendDigestEmail(venueId)` — sends to `venues.briefing_email`). `src/lib/services/digest-dispatch.ts:35` filters venue eligibility on user preferences but the actual `sendDigestEmail` builds one digest per venue.
**Playbook reference:** ANTI-19.9-5 / Part 20.3
**What this proves:** Two coordinators on the same venue, one wants self_knowledge, the other doesn't. Both get the SAME digest via the venue-level briefing_email. `enabledCategories` is dead code — exported, tested, never called by daily-digest. `include_self_knowledge` opt-out is silently ignored once the digest fires.
**Would experience this as:** Coordinator unchecks "self knowledge — surveillance-flavoured insights about your own behaviour" in their preferences. Tomorrow morning the digest still includes coordinator_override_pattern insights. Trust dies.

### [HIGH] 12. cohort-match samples backfilled weddings with no fidelity disclosure

**File/surface:** `src/lib/services/insights/cohort-match.ts:230-247` (selects `weddings` filter on status only), `:296-309` (computes conversion %, median values), `:309+` builds narration with no confidence_flag awareness.
**Playbook reference:** INV-18.5 / ANTI-19.9 (transparency)
**What this proves:** See Finding 6 — cohort-match doesn't filter on confidence_flag. The narration prompt at `:402-465` says "the venue's small look-alike sample suggests" but doesn't distinguish backfilled-low-fidelity from organic-high-fidelity sample. The numbers-guard catches invented numbers, not invented confidence.
**Would experience this as:** First 90 days post-onboarding, every cohort insight is grounded in CRM-export data the coordinator hasn't validated yet, but the UI shows "High conf".

### [HIGH] 13. /agent/notifications-style intel pages query agent tables directly (AP-11)

**File/surface:** `src/app/(platform)/intel/clients/[id]/page.tsx:622-640`, `intel/health/page.tsx:219`, `intel/roi/page.tsx:154,162,172,184,250,256`, `intel/portfolio/page.tsx:343` — all `supabase.from('interactions'|'engagement_events'|'drafts')` directly.
**Playbook reference:** AP-11 / ARCH-20.2.x (shared service rule)
**What this proves:** intel/* shouldn't reach into agent/* tables; the right pattern is a shared service. /intel/roi alone has 6 cross-subtree direct queries. Schema migrations to those agent tables can break intel pages with no compile-time signal.
**Would experience this as:** Add a NOT NULL column to interactions, deploy, and three intel pages return 500 the next morning because they aren't selecting it but RLS or trigger logic touched the row shape.

### [HIGH] 14. Insight cache key never references inquiry_date but narration uses it implicitly

**File/surface:** `src/lib/services/insights/heat-narration.ts:156-168` cacheKey omits inquiry_date; the LLM prompt at `:209-219` includes the events window which is bounded by it (top_events.occurred_at). Decay-re-engagement, negotiation-state, risk-flags, cohort-match all build their own cacheKeys via `buildCacheKey({...})` and none include the wedding's inquiry_date.
**Playbook reference:** INV-2.5
**What this proves:** When inquiry_date moves, the classical evidence shape may shift (different events fall inside the silence window) but the cache_key doesn't, so a cache hit serves stale narration.
**Would experience this as:** Same as Finding 5 from the cache angle.

### [HIGH] 15. Hardcoded "Sage" string in cross-venue intel page (AP-6)

**File/surface:** `src/app/(platform)/intel/anomalies/page.tsx:491` (`<span className="font-medium">Sage suggests:</span>`); `intel/reviews/page.tsx:342` (`'Sage Approved' : 'Approve for Sage'`).
**Playbook reference:** AP-6 / AP-18 / ARCH-19.5 (white-label discipline)
**What this proves:** AP-6 forbids hardcoded venue brand strings. AP-18 specifically says cross-venue contexts must not refer to the AI as "Sage" — Oakwood's coordinator opens /intel/anomalies for their own venue and sees "Sage suggests" even though their AI is named Iris. The white-label audit (`bloom-whitelabel-audit.md`) called this out for couple-portal already; the same shape leaked into the intel surfaces.
**Would experience this as:** Multi-tenant venue rolls out, sees "Sage" in their anomaly detail panel, requests a fix as a P0 launch blocker.

### [MEDIUM] 16. No per-thread cap on auto-send beyond venue-wide daily cap

**File/surface:** `src/lib/services/email-pipeline.ts:2202-2211` (`checkAutoSendEligible` accepts threadId but its current implementation in autonomous-sender.ts checks venue daily cap only — confirmed via Apr 2026 audit doc bloom-auto-send-cap-audit.md still active).
**Playbook reference:** AP-13 / Part 10.2 / ANTI-2.6.x
**What this proves:** Per the existing audit memory `bloom-auto-send-cap-audit.md` from 2026-04-22, the per-thread cap and rolling-24h window were never wired even though the function signature accepts threadId. Doctrine compliance for INV-7.3 was upgraded but the per-thread quality is still partial. T0-T4 didn't close it.
**Would experience this as:** A weird-format reply triggers Sage to auto-respond 4-5 times in the same thread within an hour.

### [MEDIUM] 17. cohort-match candidate sample size threshold is too low for confident narration

**File/surface:** `src/lib/services/insights/cohort-match.ts:41` (`MIN_COHORT_SIZE = 3`), `:290-294` (top-K with K=10 — but if only 3 are >=MIN_COHORT_SIZE, narration goes ahead).
**Playbook reference:** Part 19.6 / numbers-guard / confidence-aware narration
**What this proves:** A cohort of 3 leads, 2 booked = "67% conversion", "High conf" via `confidenceFor`. The narration at `:560-561` does soften with "Limited look-alike sample" but the body still leads with "2/3 booked, 67%". Three is not a sample size that justifies the precision shown.
**Would experience this as:** Coordinator follows a recommendation grounded in a 3-lead "cohort" they didn't realize was that small.

### [MEDIUM] 18. Pulse aggregator misses anomaly_alerts that have severity='info'

**File/surface:** `src/lib/services/pulse-aggregator.ts:101` — `anomalyPriority` returns 'low' for info, but the SELECT at `:158-165` filters `acknowledged=false` only, no severity floor. Then the page at `pulse/page.tsx:127` filters on source. Behavior: severity='info' anomalies show up as 'low' with no styling distinction.
**Playbook reference:** ARCH-20.2.2
**What this proves:** /pulse claims to be the unified attention surface. An info-severity anomaly that the coordinator never acknowledged stays in the feed indefinitely as "Low" but with no decay, drowning out actually critical items over time. There is no auto-snooze on age and no severity floor on the SELECT.
**Would experience this as:** Coordinator's Pulse feed grows to 80 stale info-anomalies after 60 days; critical items get harder to find.

### [MEDIUM] 19. Brain-dump LLM calls don't carry correlationId or check autonomous_paused

**File/surface:** `src/lib/services/brain-dump.ts:160` (callAIJson with no correlationId, no isAutonomousPaused check beforehand).
**Playbook reference:** OPS-21.4.3 / T1-G
**What this proves:** Brain-dump is coordinator-initiated. Per the cost-ceiling rules at the top of `cost-ceiling.ts:23`, coordinator calls "still work" — fine. But the LLM cost still hits api_costs and counts toward today's spend. So a coordinator brain-dumping repeatedly can drive the venue past the ceiling, and once past, every autonomous behavior pauses. Also: brain-dump captures family context (tier-1) so its lineage thread should absolutely be traceable through correlation_id, and isn't.
**Would experience this as:** Coordinator hammers Cmd+K with twelve quick brain-dumps before bed; next morning autonomous behaviors are paused. They blame Sage.

### [MEDIUM] 20. post-tour-brief and briefings.ts make Sonnet calls without cost-ceiling check

**File/surface:** `src/lib/services/post-tour-brief.ts:304, :340` (two callAI sites); `src/lib/services/briefings.ts:391, :572` (two callAIJson sites). None call `isAutonomousPaused`.
**Playbook reference:** OPS-21.4.3 (second-line gate scope)
**What this proves:** post-tour-brief is triggered from the audio-capture / orchestrator path on a per-tour basis. briefings.ts runs from cron. Neither is gated. The cost-ceiling doctrine mentions briefings explicitly (`cost-ceiling.ts:159`) but the only check inserted was at `intelligence-engine.runAllVenueIntelligence`. Briefings run from the weekly_briefing / monthly_briefing cron paths separately.
**Would experience this as:** Cost-ceiling fires; weekly briefing still runs on Monday morning because nobody told briefings.ts to check.

### [MEDIUM] 21. heat-mapping recordEngagementEventsBatch dedups on (eventType, occurredAt) collisions but inserts non-atomically

**File/surface:** `src/lib/services/heat-mapping.ts:344-389` reads existing events via `shouldSkipDuplicate` (a SELECT) then `supabase.from('engagement_events').insert(toInsert)` — there's no uniqueness constraint on `(venue_id, wedding_id, event_type)` for the ONE_PER_WEDDING types other than the read-side dedup. Two parallel callers (cron + webhook delivering same email twice via multi-Gmail) both pass the dedup gate.
**Playbook reference:** INV-15 / fire-once-per-wedding doctrine
**What this proves:** Migration `143_engagement_events_fire_once_index.sql` adds an index but the dedup logic in heat-mapping is read-modify-write. The fire-once invariant is enforced by code, not by a unique constraint, so racy paths can still double-fire.
**Would experience this as:** Multi-connection Gmail venue gets two `tour_requested` events from the same email arriving on two threads; heat lifts +30 instead of +15.

### [LOW] 22. clearStaleAutonomousPauses is O(N venues × 1 read) per run but called hourly via cost_ceiling_reset cron

**File/surface:** `src/lib/services/cost-ceiling.ts:357-407` and `vercel.json:99-102` (cron `5 0 * * *` — daily). Inside the loop, getCostCeilingStatus runs per venue.
**Playbook reference:** OPS-21.4.3 (note: this is fine for current scale; flag for Wedgewood-scale rollout)
**What this proves:** Daily reset cron — fine today. At 80+ venues this becomes 80+ getCostCeilingStatus reads serially each running its own SELECT cost ROWS query. The header comment at `cost-ceiling.ts:11-13` notes 80+ scale is target.
**Would experience this as:** As the platform grows, the 00:05 UTC reset gets slower; not blocking yet.

### [LOW] 23. Hardcoded fallback `'Sage'` defaults still appear in the matching/tours/messages pages

**File/surface:** `src/app/(platform)/intel/matching/page.tsx:197`, `intel/tours/page.tsx:217`, `portal/messages/page.tsx:147` (`label: 'Sage AI'`).
**Playbook reference:** AP-6 / AP-18
**What this proves:** Compared to Finding 15, these are fallbacks that *eventually* get overwritten by the actual venue's ai_name on async fetch. But there's a flicker where the wrong name is rendered, and on slow networks a coordinator at Oakwood can briefly see "Sage" in their UI before Iris loads. Lower severity than 15 but the same anti-pattern shape.
**Would experience this as:** Brief "Sage" flash on page load even at a renamed-AI venue.

### [LOW] 24. Pulse dismiss is forever; no expiry

**File/surface:** `src/lib/services/pulse-aggregator.ts:124-130` — `dismissed` items are added to hiddenKeys with no TTL.
**Playbook reference:** ARCH-20.2.2 (snooze + dismiss semantics)
**What this proves:** Once a coordinator dismisses, it's gone forever even if the underlying state CHANGES. e.g. a `cost_ceiling_paused` notification dismissed in the morning hides forever; if the venue gets paused AGAIN tomorrow the SAME admin_notification id won't reappear (it'd be a different id), but if cost_ceiling_warned_at logic only stamps once per day and the notification dedups internally, the second event might not fire at all. Edge case but worth flagging.
**Would experience this as:** Coordinator dismisses today's pause notification, gets paused again tomorrow, notification doesn't surface because dedup says "already exists" or stamp says "already warned today" — but they dismissed the prior visibility forever.

### [LOW] 25. cost_ceiling_reset cron runs daily but pause notification has no idempotent unpause companion

**File/surface:** `cost-ceiling.ts:393-401` fires `cost_ceiling_resumed` notification on auto-resume. `pulse-aggregator.ts:84-90` routes notifications to /agent/notifications. There's no surface that shows "you were paused yesterday, here's why, here's what got skipped."
**Playbook reference:** Part 22.4 (telemetry / observability)
**What this proves:** Forensic record of paused-period exists in `venue_config.autonomous_paused_at` but it's cleared on resume — the daily-digest doesn't summarize what got dropped during pause. The coordinator doesn't see "yesterday we skipped 3 follow-ups, 1 anomaly explanation, and 2 weekly insights because you were paused."
**Would experience this as:** Coordinator wonders why this week's anomaly digest is thin and never connects it to the cost-ceiling event from Tuesday.

## What's solid

HeatBadge is genuinely a single primitive (`src/components/intel/heat-badge.tsx` + `src/lib/heat/tier-colors.ts`) used consistently from /agent/leads, /agent/pipeline, and /intel/clients/[id]; AP-19 holds. EssentialsSlider defaults to 'recommended' density not 'everything', and persists per-coordinator + per-surface, so AP-12 is clean. Digest preferences default `include_self_knowledge=false` and `cadence=weekly` rather than daily, honouring the opt-in / conservative defaults rule. The 5-minute auto-send delay is correctly enforced at `email-pipeline.ts:2215` with both a forward time gate and a coordinator-cancel notification path; AP-13 is closed. Cost-ceiling enforcement landed cleanly on the cron-driven LLM-heavy paths (intelligence-engine, daily-digest, follow-up-sequences, anomaly-detection, autonomous-sender, OMI webhook), and clearStaleAutonomousPauses runs daily via vercel.json cron — the gate works for what it covers.
