# Bloom T0-T4 Audit — Character 3: The Seasoned User (10 months on Rixey)

Date: 2026-05-02
Scope: Accumulated-state respect, regressions, learning loops

## Summary

Bloom collects ten months of coordinator state (slider clicks, dismissals, draft edits, voice training, brain dumps, candidate signals) but treats almost none of it as a closed feedback loop. Many T4 surfaces write telemetry that nothing reads (essentials slider, action log) or read state that nothing reliably writes (draft_feedback column-name mismatch). Several "learning" / "remembers you" claims are doctrinal-only with no engine, and inquiry_date temporal discipline is half-trigger / half-cron — heat scores, narratives, and tour briefs go stale silently.

Severity counts: 4 CRITICAL, 8 HIGH, 5 MEDIUM, 2 LOW.

## Findings

### CRITICAL 1. Slider learning loop is write-only — telemetry collected, suggestion engine does not exist
**Surface:** `/api/settings/essentials-preferences/log` (file: `src/app/api/settings/essentials-preferences/log/route.ts:37`)
**Playbook reference:** Part 20.5 (graduated transparency / suggestion prompt)
**What this proves:** Migration `155_essentials_slider.sql:43` creates `essentials_action_log` with the explicit comment "Powers the suggestion engine: after N dismissals at expanded level on a surface, prompt 'want to set this surface to recommended?'". The hook (`src/lib/hooks/use-essentials-level.ts:83`) fires-and-forgets a row on every change. The API route inserts it. Then a global grep for `essentials_action_log` returns exactly two files — the migration and the writer — and nothing else. There is no reader, no cron, no surface that proposes "set /pulse to recommended". 10 months of dismissals/expansions sits in a table no code path queries.
**Would experience this as:** "I've dismissed every Expanded card on /pulse for two months. Bloom never offers to lower the default. The slider 'learning' was theater."

### CRITICAL 2. draft_feedback column-name drift — every write since launch may be silently failing
**Surface:** `src/lib/services/learning.ts:67` and `src/lib/services/email-pipeline.ts:2629`
**Playbook reference:** Voice loop / T1-E learning examples
**What this proves:** Migration `002_agent_tables.sql:88` defines `draft_feedback` with columns `(action, original_body, edited_body, rejection_reason, coordinator_edits)` — full stop. There are no later migrations adding `feedback_type`, `original_subject`, `edited_subject`, `email_category`. But every writer in `learning.ts` (storeApproval line 71, storeEdit line 103, storeRejection line 136) and `email-pipeline.ts` (lines 2632 / 2698 / 2754) inserts `feedback_type`, `original_subject`, `edited_subject`, `email_category`. The voice-DNA endpoint (`src/app/api/intel/voice-dna/route.ts:158-160`) and the coordinator-override-pattern insight (`src/lib/services/insights/coordinator-override-pattern.ts:177`) all read `feedback_type` (override-pattern reads it as `action`, voice-dna as `feedback_type`). At minimum the column-name divergence means writes silently fail with PostgREST schema-cache errors OR (if the column was added out-of-band) one of the two readers is reading a different column than is being written. Either way, voice-DNA `recentEditPatterns` / `recentRejections` counters and the override-pattern insight do not reflect 10 months of coordinator behavior. (requires DB probe to confirm which side is wrong.)
**Would experience this as:** "Voice DNA timeline shows 38 weeks of training. The 'recent edit patterns' counter says 0. I edited every draft yesterday."

### CRITICAL 3. inquiry_date moves do not recompute heat_score, narrative cache, tour brief, or source_attribution
**Surface:** every code path that updates `weddings.inquiry_date`
**Playbook reference:** INV-2.5 / Part 12.3 (derived fields recompute on input change)
**What this proves:** Only `attribution_events.bucket` and `is_first_touch` recompute when `inquiry_date` moves — via the trigger in `supabase/migrations/119_attribution_first_touch_trigger.sql:74`. Everything else that derives from `inquiry_date` is stale until a downstream cron next runs:
- `weddings.heat_score` / `temperature_tier`: heat-mapping uses `inquiry_date` as the silence floor (`src/lib/services/heat-mapping.ts:659`). When inquiry_date moves, the lead's "days silent" derived metric is wrong until the next `heat_decay` cron at 06:00 UTC.
- `wedding_journey_narratives.narrative_text`: `src/lib/services/journey-narrative.ts:376` keys freshness only on `attribution_events` count drift (`STALENESS_DELTA`). An inquiry_date correction does not invalidate.
- `tours.tour_brief_text`: `src/lib/services/post-tour-brief.ts:200` cached row has no invalidation hook on the wedding's date fields.
- `source_attribution`: window-bounded by `booked_at`, but the days-to-book calculation at `src/lib/services/source-quality.ts:153` reads from snapshot rows that only recompute weekly via `attribution_refresh` cron.
**Would experience this as:** "I corrected an inquiry_date back two months because the original was a Knot resync glitch. The heat tier still says HOT. The journey narrative still says 'inquired today.' The tour brief still references the wrong weekday."

### CRITICAL 4. Self-knowledge insights are gated by `venues.self_knowledge_insights_enabled`, but no UI exists to enable it
**Surface:** `/agent/settings`, `/onboarding/project`, every other admin page
**Playbook reference:** ANTI-19.9 #5 (opt-in for surveillance-flavored self-knowledge)
**What this proves:** Migration `148_self_knowledge_opt_in.sql:25` adds the boolean column with default false. `src/lib/services/insights/coordinator-override-pattern.ts:241` short-circuits with `if (!(await selfKnowledgeOptedIn(...))) return null`. Grep for `self_knowledge_insights_enabled` across `src/app` returns zero hits. The flag has no toggle anywhere — no settings page, no onboarding step, no /agent/settings checkbox. The insight is dead code at every venue. T3-I shipped behind a default-off gate without shipping the gate's UI.
**Would experience this as:** "I read the playbook and asked Sage to enable 'how am I editing drafts.' Sage couldn't find the toggle. I checked /agent/settings — it isn't there."

### HIGH 5. NLQ context is too narrow to answer 10-month historical questions
**Surface:** `/intel/nlq` (file: `src/lib/services/intel-brain.ts:192-326` `gatherVenueData`)
**Playbook reference:** Forensic record / Bloom constitution
**What this proves:** `gatherVenueData` pulls weddings updated in the last 30 days only (line 230 `gte('updated_at', thirtyDaysAgo)`). It does not select `interactions`, `sage_context_notes`, `friction_tags`, `tangential_signals`, `attribution_events`, `source_quality`, `tours.outcome`, or `tour.cancellation_reason`. So:
- "Which couples this year mentioned budget concerns and didn't book?" — Sage cannot read body text from `interactions` (not loaded), only rows whose `lost_reason` happens to mention "budget" AND was updated in the last 30 days.
- "Most common reason for tour cancellations in 2026?" — `tours` table not loaded; cancellation reasons unreachable.
- "Did Pinterest leads convert better than Knot in Q1?" — Q1 leads are 4+ months old; `updated_at` filter excludes them. Multi-touch attribution from `attribution_events` not loaded; Sage falls back to legacy `weddings.source` field guesses.
**Would experience this as:** "Sage hedges every historical question or makes up a number. The NLQ surface is a demo, not a memory."

### HIGH 6. Cost ceiling pause is invisible on /pulse — venue goes silent without warning
**Surface:** `/pulse` (file: `src/lib/services/pulse-aggregator.ts:92-98`)
**Playbook reference:** OPS-21.4.3 + Part 20.2
**What this proves:** When `enforceCeilingsAllVenues` flips `autonomous_paused = true`, it creates a `cost_ceiling_paused` admin_notification (`src/lib/services/cost-ceiling.ts:248`). The pulse aggregator's `notificationPriority` (`pulse-aggregator.ts:92-98`) only special-cases `escalation` (critical), `_confirm` / `auto_send_pending` / `sage_uncertain` (high), and falls through to `medium` for everything else. So `cost_ceiling_paused` lands as a medium-priority gray line indistinguishable from a brain-dump dismissal. There is no "intelligence paused" pulse pill, no header banner, nothing on the inbox or leads page warning that drafts are not being generated. Compare to `cost_ceiling_warning` (80% threshold) — same medium fate. After the cron resumes the venue at 00:05 UTC, no missed insights are queued or backfilled (grep for `queue|backfill|catchup` in `cost-ceiling.ts` returns the doc string only). The skipped insights are gone forever.
**Would experience this as:** "Tuesday morning I open /pulse, see only a Knot brain-dump notification. By Friday I notice no drafts generated all week. Buried in /agent/notifications: 'paused Monday at 100% utilisation.'"

### HIGH 7. PriorTouchesBadge primitive defined but unused; identity moat is invisible on lead detail
**Surface:** `/intel/clients/[id]` (file: `src/app/(platform)/intel/clients/[id]/page.tsx`)
**Playbook reference:** Part 9.3 (identity resolution moat) + T1-D (negative-result transparency)
**What this proves:** `src/components/intel/inline-primitives.tsx:139` defines `PriorTouchesBadge`. Grep across the entire codebase: only `inline-primitives.tsx` references it. The inbox page (`src/app/(platform)/agent/inbox/page.tsx:9`) imports a different component, `PriorTouchesChip`, which fetches `/api/agent/inbox/prior-touches/[personId]` and renders inline on inquiry rows. Lead detail page does NOT render either chip — no `PriorTouchesChip`, no `PriorTouchesBadge`, no tangential rendering (single grep hit on line 953 is documentation text). The "5 platforms touched her before she inquired" identity story exists only on the inbox row, not on the lead's permanent record. After 10 months, the coordinator looking at a wedding cannot see the multi-touch history without leaving the page.
**Would experience this as:** "I open Sarah's lead. The page tells me her heat score and her engagement events. To see that she liked us on Instagram in December, I have to find her in /agent/inbox or read the journey narrative — assuming it regenerated."

### HIGH 8. HeatBadge primitive used inconsistently across surfaces — lead detail forks
**Surface:** `/intel/clients/[id]` (file: `src/app/(platform)/intel/clients/[id]/page.tsx:251-256`, `:847`, `:1103`)
**Playbook reference:** ARCH-20.2.1 (single primitive)
**What this proves:** `/agent/leads/page.tsx:674` and `/agent/pipeline/page.tsx:194` import and use `HeatBadge` from `@/components/intel/heat-badge`. But `/intel/clients/[id]/page.tsx` defines and uses local `heatColor()` and `heatBg()` helpers (lines 251 and 255) that route through `styleForTier`, then renders heat with bespoke JSX at lines 847, 1103, 1107, 1113, 1131, 1144 — five separate instances bypassing the primitive. The comment at line 248 even acknowledges "(HeatBadge primitive uses the same map). Pre-fix this switch drifted from /agent/leads + /agent/pipeline. ARCH-20.2.1." The fix collapsed the map but kept three separate render paths. If `HeatBadge` adds an icon or trend arrow, two surfaces show it and the lead detail does not.
**Would experience this as:** "/agent/leads and /agent/pipeline updated their heat pill rendering this week. /intel/clients/Sarah-B still has the old style. Bloom looks like it forgot the upgrade."

### HIGH 9. Sage NLQ has no access to the brain-dump audit trail
**Surface:** `/intel/nlq`
**Playbook reference:** Bloom constitution (forensic record), brain-dump propose-and-confirm
**What this proves:** `gatherVenueData` does not pull `brain_dump_entries` or `brain_dump_pattern_grants`. Coordinator asks "have I been overriding Sage's classification of vendor invoices?" — Sage has no access to the brain-dump entry log to answer. Coordinator asks "what did I tell you about the Henderson wedding back in February?" — Sage cannot retrieve the historical brain-dump entry that filed the note.
**Would experience this as:** "Sage doesn't remember the things I personally typed into Sage."

### HIGH 10. Brain-dump URL pasting has no special handling — Pinterest / Google Doc URLs blind-routed by classifier
**Surface:** `/api/brain-dump` (file: `src/lib/services/brain-dump.ts`, `src/app/api/brain-dump/route.ts`)
**Playbook reference:** T4-E + INV-20.5.4-A (propose-and-confirm)
**What this proves:** Grep for `pinterest|google.com|http|url` in `brain-dump.ts` returns zero hits. The classifier prompt (`brain-dump.ts:114`) describes intent buckets none of which include URL fetching. A pasted Pinterest URL becomes a one-line `rawText`; Claude classifies it under whichever intent it best fits (almost certainly `operational_note` or `ambiguous`) and then routes accordingly. There is no "looks like a URL — fetch it / extract og:image / OCR the linked PDF" path. The same for a Google Doc URL. After 10 months of dropping inspiration links into the brain dump, those entries sit in `brain_dump_entries` as text-only nothings.
**Would experience this as:** "I paste a Pinterest mood-board URL into the brain dump. Sage either says 'I can't tell what this is' or files it as an operational note in knowledge_gaps. Nothing fetches the page."

### HIGH 11. Brain-dump PDF attachment has no text extraction; vendor invoices are blind
**Surface:** `/api/brain-dump` (file: `src/app/api/brain-dump/route.ts:259-390`)
**Playbook reference:** Part 19.8 (specialized extractors)
**What this proves:** The brain-dump POST handler has fast paths for CSV (line 217) and `image/*` via Claude Vision (line 260). PDFs fall through entirely — no `application/pdf` check, no text extraction. Grep for `pdf|application/pdf` in the route file returns only the `inputType` validator (line 192) and an unrelated string reference in the vision-extraction prompt (line 132). The `extractAttachmentMeta` returns the meta but `runClassifierFallback` only embeds CSV `fileText`, not PDF text. So a coordinator dropping a vendor invoice PDF gets the marker `[Attached file: {...}]` appended to the rawText — Claude classifies blind from filename only.
**Would experience this as:** "I drop the florist's $4,200 invoice PDF in. Sage replies 'I see you attached a file — what should I do with it?'. After ten months I've stopped trying."

### HIGH 12. /settings/brain-dump-log shows GRANTS only, not the 30-day audit trail of all entries
**Surface:** `/settings/brain-dump-log` (file: `src/app/(platform)/settings/brain-dump-log/page.tsx`)
**Playbook reference:** T4-E transparency + Part 20.5
**What this proves:** The page hits `/api/brain-dump/grants` (`page.tsx:44`). It renders `Grant[]` only — pattern signatures the coordinator has graduated. There is no list of `brain_dump_entries`, no view of "everything I told Sage in the last 30 days, what it parsed as, what it routed to". A coordinator who wants to audit "did Sage misclassify any of my notes last month" has to query Supabase directly. Per the audit prompt's own definition, this surface fails its bill.
**Would experience this as:** "I dropped 40 things into the brain dump in April. The brain-dump log page shows three grants. I can't tell what happened to the other 37."

### MEDIUM 13. Voice-DNA drift insight does not exist; voice changes invisible
**Surface:** `/intel/voice-dna` (file: `src/app/api/intel/voice-dna/route.ts`)
**Playbook reference:** T3-I self-knowledge
**What this proves:** Grep for `voice.*drift|voice_consistency_drift` returns zero hits in `src/`. The voice-DNA endpoint computes static aggregates (dimensions, edit pairs, weekly timeline counts) but no diff between the venue's current voice profile and its 90-day-ago profile. There is no insight that says "Sage is drafting more formally than you trained 6 months ago" or "your edits this month rewrite warmth-7 drafts to warmth-9." Heavy rewrites (storeEdit) become future training examples but no signal fires when the rewrite trend itself shifts.
**Would experience this as:** "I've been dialing my drafts warmer since March. Voice DNA shows my warmth slider at 7. There's no insight that I'm now editing every draft to feel warmer than 7."

### MEDIUM 14. Risk flags only render on lead detail, not on inbox or leads list
**Surface:** `/agent/inbox`, `/agent/leads`, `/agent/pipeline`
**Playbook reference:** T3-H risk flags
**What this proves:** Grep for `RiskFlag` in `src/`: only `inline-primitives.tsx` (definition), `lead-insights-panel.tsx`, `risk-flags.ts`, and `intel/insights/page.tsx` (filter label only) and the API route. The inline-renders inside `lead-insights-panel.tsx` only mount on `/intel/clients/[id]`. Every other surface where a coordinator triages a lead — inbox, leads list, pipeline cards — does not show the risk score. Same risk that surfaces a "negotiation hardening" or "decay accelerating" alert on the detail page is invisible on the inbox row that is about to be replied to.
**Would experience this as:** "I reply to Sarah's email from /agent/inbox. I miss the risk flag that's only visible if I detour through /intel/clients/Sarah-B."

### MEDIUM 15. Cost-ceiling resume drops backed-up insights; no replay queue
**Surface:** Cost ceiling reset cron (file: `src/lib/services/cost-ceiling.ts:357-407`)
**Playbook reference:** OPS-21.4.3
**What this proves:** `clearStaleAutonomousPauses` flips the flag to false at the UTC day boundary and creates a `cost_ceiling_resumed` notification. There is no queue of insights/digests/anomaly alerts that should have fired during the pause. `filterActiveVenues` (line 167) just filters the paused venue out of that morning's cron sweep — when paused on Monday and resumed Tuesday morning, Monday's anomaly_detection / weekly_briefing / daily_digest results are gone. Tuesday runs against fresh windows that exclude Monday's missed signal.
**Would experience this as:** "We hit the cost ceiling Monday. Tuesday morning my daily digest is the Tuesday digest only — Monday's tour-cancellation pattern was never narrated."

### MEDIUM 16. Pulse snooze keys cannot match pre-T4 dismissals (no migration backfill)
**Surface:** `/pulse` (file: `supabase/migrations/154_pulse_snoozes.sql`)
**Playbook reference:** Part 20.2 / T4-C
**What this proves:** Migration 154 introduces `pulse_snoozes` keyed by composite `item_key` (e.g., `notif:<uuid>`). Pre-T4 the only way to silence a `/agent/notifications` row was `read=true` (column on `admin_notifications`). The aggregator (`pulse-aggregator.ts:140`) filters notifications to `read=false` only, which mostly handles the pre-T4 backlog correctly. However, the unique constraint at line 38 is `(venue_id, item_key)` — if the coordinator snoozes a notification, then later marks it read elsewhere, then it gets re-created with the same UUID (impossible) — the snooze stays. More practically: a snooze entered with `snoozed_until = forever` (unlimited) past one year still occupies the unique slot. `pulse-aggregator.ts:128` filters on `snoozed_until > nowIso` only, so expired snoozes fall off the filter naturally — but the row remains in the table forever, and any audit of "what is this coordinator hiding" returns a 10-month accumulation.
**Would experience this as:** "I snoozed an anomaly back in November for 30 days. /pulse shows it correctly now. /settings has no surface that lists my snooze history."

### MEDIUM 17. Tour brief never invalidates when wedding_date or guest_count moves
**Surface:** `/intel/clients/[id]` tour card, `/intel/tours` (file: `src/lib/services/post-tour-brief.ts:196-235`)
**Playbook reference:** INV-2.5 (derived recompute)
**What this proves:** `fetchCachedTourBrief` returns the persisted `tour_brief_text` if it exists. There is no freshness check against `weddings.wedding_date`, `guest_count_estimate`, `booking_value`, or `sage_context_notes` updates. If the couple postpones from Sept 12 to Oct 24, or revises guest count from 80 to 140 after the tour, the brief continues to reference the old values until the coordinator manually clicks Regenerate (no such action exists in the page; only the live `generatePostTourBrief` path on a fresh tour invocation rewrites it).
**Would experience this as:** "Maddie's tour brief still says 'Sept 12 wedding for 80.' She moved to Oct 24 last week and guest count is now 130. The brief Sage wrote in March is unchanged."

### LOW 18. Pulse aggregator pulls insights only from last 14 days by default — older insights invisible regardless of priority
**Surface:** `/pulse` (file: `src/lib/services/pulse-aggregator.ts:111-113`)
**Playbook reference:** Part 20.2 (unified pulse)
**What this proves:** `aggregatePulse` defaults `sinceDays=14` and applies it uniformly to notifications, anomalies, and insights. A critical-priority insight from 16 days ago that the coordinator never opened drops off the pulse. The same insight stays in `intelligence_insights` with `status='new'` but is invisible. There is no escalation that says "this critical insight has been sitting un-acted for 14 days."
**Would experience this as:** "An insight Sage flagged as critical 18 days ago about Knot CPI tripling is gone from /pulse. I never saw it."

### LOW 19. Essentials slider has no notion of inheriting org-level defaults
**Surface:** `/api/settings/essentials-preferences` (file: `src/app/api/settings/essentials-preferences/route.ts:32`)
**Playbook reference:** Part 20.4
**What this proves:** `getOrCreate` always inserts `default_level: 'recommended'` for any new user-venue pair. Migration 155 has no reference to org-level or venue-level defaults. After 10 months of Rixey, an org admin who wants every new coordinator to inherit "essentials by default" has no UI and no DB column to express that.
**Would experience this as:** "I onboard a new coordinator. They see Recommended density everywhere. I can't preset their default to Essentials org-wide."

## Regressions (T0-T3 → T4)

- **T1-E voice learning loop is column-name broken.** `learning.ts` writes `feedback_type` / `original_subject` / `email_category` to `draft_feedback`, which has columns `action` / no `original_subject` / no `email_category` per migration `002_agent_tables.sql:88`. Either the writer or the schema diverged and was never reconciled. Voice-DNA + override-pattern readings are unreliable. (Finding 2.)
- **T3-A heat narration is wired on the lead detail page (good) but the page renders heat colour with three different bespoke functions instead of HeatBadge.** Drift snapped on lead detail vs leads/pipeline. (Finding 8.)
- **T3-D cohort match runs from `inquiry_date` window, but offers no recompute if the current row's `inquiry_date` later changes.** Cohort match panel will silently drift on any inquiry_date correction.
- **T4-D Essentials slider** — telemetry without engine. (Finding 1.)
- **T4-E brain-dump** — graduation flow exists; PDF + URL paths regressed because they were never wired to specialized extractors. (Findings 10, 11.)
- **T4-C pulse snooze** — works but does not give pulse a pause/quiet-mode signal when cost ceiling pauses the venue. (Finding 6.)
- **T2-D + T3-I self-knowledge** — `coordinator_override_pattern` is gated behind a flag with no UI to enable. (Finding 4.)

## What's solid

The cost-ceiling enforcement chain itself (cron-driven check + UTC-day reset + per-cron filterActiveVenues) is well constructed: services correctly call `filterActiveVenues` before running expensive AI work and the auto-resume logic guards against the 00:00:01 edge case. Migration 119's two-step trigger (bucket + first_touch atomic recompute on inquiry_date change) is exemplary — short, idempotent, narrowly scoped, and documents the historical bandaid it eliminated. The brain-dump propose-and-confirm policy is conservative and consistent across CSV, vision, KB, operational note, and client note paths. PriorTouchesChip's silent-fail-on-401 negative-result-transparency pattern (per INV-8.5.5) is a lovely small piece of UX honesty.
