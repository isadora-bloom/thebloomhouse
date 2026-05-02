# T0–T4 Audit Synthesis + Remediation Plan

Date: 2026-05-02
Inputs: `engineer.md`, `first-time-user.md`, `seasoned-user.md`, `yc-partner.md`
Total findings audited: **87** (17 CRITICAL, 37 HIGH, 22 MEDIUM, 11 LOW)

---

## Part 1 — Cross-report finding map

The audit plan said *Findings that appear in multiple reports become Tier 5 work*. Here's the map. A finding showing up in 2+ characters is Tier-5 priority by definition.

### Hits in 4 reports — class-of-bug

**P-1. Hardcoded "Sage" / hardcoded venue branding (white-label leaks).**
- **C1 #15, #23** — `intel/anomalies/page.tsx:491`, `intel/reviews/page.tsx:342`, `intel/matching/page.tsx:197`, `intel/tours/page.tsx:217`, `portal/messages/page.tsx:147`
- **C2 #1, 4, 5, 6, 7, 9, 11, 13, 15, 16, 17, 18, 19, 20, 21** — 60+ instances, plus `DEFAULT_PERSONALITY` constant + `'sage@hawthornemanor.com'` hardcoded in `personality-builder.ts:136-159` + `_couple-pages/layout.tsx:18` `'hawthorne-manor'` fallback + `sage-brain.ts:416` injecting `Sage:` into conversation transcripts
- **C3** — implicit (column-name drift, `self_knowledge_insights_enabled` flag with no UI also leaks brand assumptions)
- **C4 #16** — `/sage` brain landing hardcodes `"Sage's Brain"` three times

This is the largest finding class. Three sub-shapes:
- (a) **Defaults in code** — `DEFAULT_PERSONALITY`, `aiName ?? 'Sage'` fallbacks at 4+ sites in `inquiry-brain.ts`, the couple-portal `'hawthorne-manor'` default
- (b) **Hardcoded UI copy** — h1s, button labels, tab labels, table column headers, empty states across ~30 files
- (c) **Conversation history injection** — `sage-brain.ts:416` puts the literal string `"Sage:"` into the messages array Claude sees, so the model picks up the name regardless of system prompt

### Hits in 3 reports

**P-2. `confidence_flag` (T2-A B-39) stored, never read.**
- **C1 #6, #12** — T3 cohort-match samples backfilled weddings without filtering on it; numbers-guard catches invented numbers but not invented confidence
- **C2 #3** — Day-1 onboarding promises confidence stamping; no UI surfaces it
- **C4 #7** (related) — demo seed has no Internal Context, so the issue compounds

The column lives on 5 tables (`weddings`, `people`, `interactions`, `engagement_events`, `marketing_spend`); zero readers in `src/components/**` or `src/app/**`.

### Hits in 2 reports

**P-3. `PriorTouchesBadge` defined, zero importers.**
- **C3 #7** — identity moat invisible on lead detail
- **C4 #5** — chip exists, never rendered; "the moat fires for the AI; the demo doesn't show it"

The badge is exported from `inline-primitives.tsx:139` with grep returning the definition file only.

**P-4. `inquiry_date` move doesn't propagate (INV-2.5 violation).**
- **C1 #5** — `weddings.heat_score` doesn't recompute; T3 cache_keys don't include inquiry_date
- **C1 #14** — heat-narration cache key omits inquiry_date entirely
- **C3 #3** — heat_score, journey_narrative cache, tour_brief cache, source_attribution all stale

Migration 119 only handles `attribution_events.bucket` + `is_first_touch`. Everything else waits on its respective cron.

**P-5. /pulse doesn't surface autonomous_paused.**
- **C1 #10** — pulse aggregator doesn't read `venue_config`; no live indicator
- **C3 #6** — `cost_ceiling_paused` notification falls through to medium priority indistinguishable from a brain-dump dismissal

**P-6. NLQ context too narrow for the cross-limb pitch.**
- **C3 #5, #9** — only 30 days; ignores `interactions` body, `sage_context_notes`, `tangential_signals`, `attribution_events`, `tours.cancellation_reason`, `friction_tags`, `brain_dump_entries`
- **C4 #4, #12** — doesn't touch `attribution_events`, `candidate_identities`, `cultural_moments`, `fred_indicators`, `external_calendar_events`, Internal Context tables; system prompt doesn't enumerate them

**P-7. Voice DNA cold-start vs day-N gap.**
- **C2 #8** — API returns hardcoded warmth=7/formality=4/etc. defaults; UI implies a learned voice
- **C4 #9** — no Gmail-backfill seed path; deck implies day-1 voice differentiation that the build can't deliver

### Disagreement (the audit plan flagged this as itself a finding worth investigating)

**P-8. HeatBadge consistency.**
- **C1 "What's solid"** — claims HeatBadge is a single primitive used across `/agent/leads`, `/agent/pipeline`, `/intel/clients/[id]`, AP-19 holds
- **C3 #8** — `intel/clients/[id]/page.tsx` defines local `heatColor()`/`heatBg()` helpers (lines 251, 255) and renders heat with bespoke JSX at lines 847, 1103, 1107, 1113, 1131, 1144 — five separate instances bypassing the primitive

Reading the code: C3 is correct. The lead detail uses `styleForTier` directly with bespoke layout, not the `HeatBadge` component. C1 saw the file imports the primitive elsewhere and missed the inline duplications.

---

## Part 2 — Pattern analysis (the user's "look for similar patterns" ask)

Beyond per-finding cross-reference, **eight architectural patterns** show up across the audit set. Each pattern is a class-of-bug; fixing one instance without addressing the pattern leaves the rest waiting to bite.

### Pattern A: Ship-without-consumer (write-only telemetry / dead-letter columns)

Same shape, six instances:
| Writer | Reader | Where the writer lives |
|---|---|---|
| `essentials_action_log` | none | `use-essentials-level.ts:83`, `essentials-preferences/log/route.ts:37` |
| `confidence_flag` (5 tables) | none | `onboarding-project.ts` |
| `marketing_spend.source_provenance` | none | `marketing-spend.ts:91`, `data-import.ts:389` |
| `PriorTouchesBadge` | none | `inline-primitives.tsx:139` |
| `enabledCategories` (digest filter) | none called by daily-digest | `digest-preferences.ts:144` |
| `self_knowledge_insights_enabled` flag | only the generator that's gated by it | migration 148 |

**Why this happens architecturally:** every one of these is the back-half of a feature where the schema/service was shipped before the consumer surface. The doctrine-compliance flow promotes a cell to `enforced` when the writer lands; nothing in the cell's check confirms that a reader exists. The cells are correct; the doctrine grading rule is too generous.

### Pattern B: White-label leaks (hardcoded brand strings, sub-pattern of P-1)

Three sub-mechanisms:
- **Default-constant inheritance** — `DEFAULT_PERSONALITY` spread `{...DEFAULT, ...config}` means missing fields silently use brand defaults. Any field added later (like `ai_email`) inherits "sage@hawthornemanor.com" without a code change requiring a default audit.
- **Belt-and-suspenders fallback chains** — `aiName ?? 'Sage'` repeated at 4+ separate call sites in `inquiry-brain.ts` alone (lines 166, 169, 375, 604). One forgot in a refactor reintroduces the leak.
- **Conversation history string injection** — `sage-brain.ts:416` builds `${role === 'user' ? 'Couple' : 'Sage'}: ${msg.content}`. The system prompt's white-label stance gets contradicted by the message stream itself.

### Pattern C: Derived-field staleness (INV-2.5 violations)

Three concrete instances, all rooted in the same gap:
- `weddings.heat_score` doesn't recompute on inquiry_date change
- T3 narration `cache_key` doesn't include inquiry_date or wedding_date
- `tours.tour_brief_text` has no invalidation hook on `wedding_date` / `guest_count_estimate` / `booking_value` change

The trigger 119 pattern (one trigger covers `bucket` + `is_first_touch` atomic recompute) is exemplary; **the same shape applied to heat_score + cache_key invalidation would close the entire class**. C3 explicitly noted "Migration 119's two-step trigger is exemplary" — the prescription is hidden in the praise.

### Pattern D: Cross-tier gates not enforced post-T3

The cost-ceiling + redactError gates landed on the cron-driven services (intelligence-engine, daily-digest, follow-up-sequences, anomaly-detection, autonomous-sender, OMI webhook) but were not propagated when T3 added 9 new generators + 2 user-facing API routes. Same gap shape:

| Gate | Cron paths cover it | T3 paths bypass |
|---|---|---|
| `isAutonomousPaused` | yes | all 9 T3 generators, `/api/insights/lead`, `/api/insights/venue`, `brain-dump.ts:160`, `post-tour-brief.ts:304/340`, `briefings.ts:391/572` |
| `redactError` on catch | partial (client.ts) | all 9 T3 generators log raw `err.message` |

The pattern is "T3 was added in parallel to cost-ceiling, neither fully knew about the other."

### Pattern E: Cron writes the wrong target / no daily writer

- **FRED**: daily cron writes `economic_indicators` (legacy); engine reads `fred_indicators` (new). The new writer (`fred-fetch.ts`) is cron-less.
- **Cultural moments auto-propose**: implementation shipped, no cron entry in `vercel.json`.
- **`heat_decay` cron** runs at 06:00 UTC daily but doesn't recompute on `inquiry_date` change events — there's no event-driven path; everything waits 24h.

The vercel.json entries weren't audited against "for every USP-bearing service, what writes its primary table?"

### Pattern F: Cross-cutting primitives mounted on one surface

`PriorTouchesBadge`, `RiskFlag`, `HeatBadge`-correctly-as-a-component, `ConfidenceBadge` were all built per T4-B as cross-cutting primitives. They're rendered:
- LeadInsightsPanel (which mounts on lead detail only): `RiskFlag`, `ConfidenceBadge`, `HeatBadge` (composed in panel)
- Inbox: only `PriorTouchesChip` (a different component)
- Leads list: `HeatBadge` (the component) + custom badge logic
- Pipeline: `HeatBadge`
- Lead detail page: bespoke heat rendering at 5 sites bypassing the primitive

The primitives library landed; the migration of legacy renderings to use it didn't happen on the lead detail page.

### Pattern G: Sample-size / data-quality without disclosure

- cohort-match narrates with "High conf" on N=3 (`MIN_COHORT_SIZE=3`)
- cohort-match doesn't filter on `confidence_flag` so backfilled rows count as same-fidelity
- voice-DNA shows hardcoded "Friendly 7/10" defaults even when the venue has zero phrases
- pricing-elasticity ignores `source_provenance` so brain-dump-extracted spend numbers count the same as Meta-API-integrated

The numbers-guard catches *invented numbers*. It doesn't catch *invented confidence*. There's no `confidence_aware_narration` shape.

### Pattern H: Schema/writer drift (the most dangerous, only 1 confirmed instance)

`draft_feedback`:
- Schema (`002_agent_tables.sql:88`): `(action, original_body, edited_body, rejection_reason, coordinator_edits)`
- Writers (`learning.ts:67`, `email-pipeline.ts:2629/2698/2754`): `(feedback_type, original_subject, edited_subject, email_category)`

Either:
- (i) writes silently fail with PostgREST schema-cache errors and 10 months of voice-learning data is missing, OR
- (ii) the column was added out-of-band (`ALTER TABLE` not in any migration) and migration drift exists between the repo and prod

Both readings are bad. **This is the most dangerous finding in the entire audit set** because it's invisible — the rest of the system thinks voice DNA is learning. Until the DB is probed, we don't know which case is true.

---

## Part 3 — Tier-5 Remediation Plan

The audit plan said: *Findings that appear in multiple reports become Tier 5 work. Findings that appear in only one report get judged on severity.*

This plan is structured by phase, each addressing a pattern (not a single finding). Within each phase, sub-tasks address concrete instances. **Each pattern fix is a deep fix — root cause first, then sweep for instances.**

### Phase T5-α — Truth-or-die fixes (do first; cannot ship/demo confidently without)

**T5-α.1. Probe `draft_feedback` schema drift (Pattern H) — 1 day**
- Run `psql` against staging + prod: `\d draft_feedback`. Reconcile against `002_agent_tables.sql:88`.
- Three possible outcomes:
  - Drift fully exists in prod — write migration that names the columns the writers use; backfill old data
  - Schema is canonical; writers fail silently — every `learning.ts` insert is broken; the entire voice loop has been zero-effect for the file's lifetime; rewrite writers
  - Mixed (some env has drift, some doesn't) — the worst case; reconcile + audit
- **Bar:** every existing `draft_feedback` row is queryable by the readers in `voice-dna/route.ts:158` and `coordinator-override-pattern.ts:177`. (C3 #2)

**T5-α.2. Promote at-risk findings actually broken now — 1 day**
- C1 #2 + C1 #3: T3 generators bypass cost-ceiling AND `/api/insights/lead`, `/api/insights/venue` have no rate limit, no pause check, no per-coordinator quota.
- This is one fix, not two: build a `gateForBrainCall(venueId)` helper in `cost-ceiling.ts` that returns `{ ok: false, reason }` if paused, and require every `callAI`/`callAIJson` site outside cron to pass through it. Update the 9 T3 generators + the 2 endpoints + brain-dump + post-tour-brief + briefings.ts to use it.
- **Bar:** `grep "callAI\|callAIJson" src/lib/services/insights/` returns zero non-gated calls.

**T5-α.3. Lock `redactError` on every T3 catch (Pattern D) — 0.5 day**
- 9 T3 services each have a `console.warn('[X] LLM call failed:', err...)` shape. Replace every one with `console.warn('[X] LLM call failed:', redactError(err))`.
- Add an ESLint rule or a CI check that fails when a `console.warn|error` line in `src/lib/services/insights/` references `err.message` or the bare `err` symbol.
- **Bar:** ripgrep audit confirms zero raw-err logs in T3.

### Phase T5-β — White-label sweep (Pattern A + B; the largest finding class)

**T5-β.1. Replace `DEFAULT_PERSONALITY` with field-level required-or-throw — 1 day**
- Today `personality-builder.ts:136-159` ships `{ ai_name: 'Sage', ai_email: 'sage@hawthornemanor.com', ... }` and code spreads `{...DEFAULT, ...config}`. Change shape:
  - Make `ai_name` REQUIRED (no default; throw early if `venue_ai_config` row missing or `ai_name` null)
  - Make `ai_email` REQUIRED for any path that emits outbound (proposal generation, signoff)
  - Defaults that ARE legit (warmth=7, etc., for sliders the venue chose not to set) stay; brand-identity defaults go
- Add migration that backfills `venue_ai_config.ai_name` for any row where it's null (using `venues.name` + suffix as fallback).
- The `setup`/`onboarding` flows must insert the `venue_ai_config` row (C2 #12) — wire that in.
- Find every `?? 'Sage'` in `inquiry-brain.ts`, `client-brain.ts`, `sage-brain.ts`, `post-tour-brief.ts`, etc. — replace with throw or with a typed `aiName` parameter that propagates from a single load site.
- **Bar:** `grep "?? 'Sage'" src/lib/` returns zero hits.

**T5-β.2. Audit-and-remove hardcoded UI copy — 2-3 days**
- ~30 files identified in C2's report. Each needs:
  - Load venue's `ai_name` at top of component (or via a shared `useAiName()` hook)
  - Replace every literal "Sage" with template variable
  - Replace gendered pronouns ("she", "her") with name reference where possible, or with neutral ("it") where not
- Particular attention: `/sage/page.tsx`, `/portal/sage-queue/page.tsx`, `/settings/sage-identity/page.tsx`, `/settings/personality/page.tsx`, `/agent/knowledge-gaps/page.tsx`, `/intel/anomalies/page.tsx`, `/portal/availability/page.tsx`, `/portal/venue-usps-config/page.tsx`, `_couple-pages/contracts/page.tsx`, `_couple-pages/chat/page.tsx`.
- Add a CI check: `node scripts/check-no-hardcoded-sage.mjs` already exists for couple portal — extend its scope to all of `src/components` and `src/app/(platform)`.
- **Bar:** `check-no-hardcoded-sage.mjs` extended scope passes.

**T5-β.3. Fix `sage-brain.ts:416` conversation-history injection — 0.5 day**
- The `Sage:` literal in the conversation history sent to Claude. Use the venue's `ai_name` instead. This is a one-line fix but it's class-defining: any other place that builds a chat message log with literal role labels needs the same audit. Search for `'user'.*'assistant'|messages.map`.
- **Bar:** No literal AI brand string in any prompt sent to Claude or OpenAI.

**T5-β.4. Fix the `'hawthorne-manor'` and `sage@hawthornemanor.com` constants — 0.5 day**
- `_couple-pages/layout.tsx:18` returns `'hawthorne-manor'` when no slug is found. Replace with throw / 404 redirect; don't silently route to a different venue's data.
- `personality-builder.ts:139` literal `'sage@hawthornemanor.com'` — make `ai_email` required (already covered in T5-β.1).
- Setup wizard placeholder `"e.g. Hawthorne Manor"` — fine to keep (it's an example, not a default).

### Phase T5-γ — Pattern A: Wire the unread (ship-without-consumer)

**T5-γ.1. Wire `confidence_flag` into 5 surfaces — 2-3 days**
- `cohort-match.ts:230-247`: filter cohort to `confidence_flag in ('live', 'imported_high')` OR include all but stamp narration with disclosure when N_low > 0
- LeadInsightsPanel cohort card: add a "based on N high-fidelity + M backfilled-low" disclosure
- `/agent/leads` table: optional column "imported" badge for `confidence_flag != 'live'`
- inbox interaction badge for `confidence_flag in ('imported_low', 'manual')`
- Anomaly detector: down-weight low-confidence engagement_events in heat scoring (this changes the heat math; gate behind a flag if it's invasive)
- **Bar:** `grep confidence_flag src/components src/app` returns 5+ files.

**T5-γ.2. Wire `source_provenance` into pricing-elasticity confound check — 0.5 day**
- `pricing-elasticity.ts` already has confound detection (marketing_spend pre/post delta). Extend `loadMarketingSpendChange` to also report the provenance mix; if the marketing_spend in the window is >50% `brain_dump_text` provenance, flag confound and damp confidence.
- **Bar:** the migration 146 comment "drives data-quality weighting" is true.

**T5-γ.3. Wire `essentials_action_log` reader (suggestion engine) — 1-2 days**
- New service `src/lib/services/essentials-suggester.ts` that runs nightly, queries the action log per (user, surface), and inserts a row into `admin_notifications` when the dismissed_at_expanded count over 30d > threshold.
- Add to vercel.json cron.
- **Bar:** Coordinator who has dismissed 5+ Expanded cards on /pulse over 30 days gets a "Want to set /pulse to Recommended?" prompt.

**T5-γ.4. Wire `PriorTouchesBadge` into LeadInsightsPanel — 0.5 day**
- LeadInsightsPanel already loads context for the lead. Add a `priorTouches` query to its parallel fetch + render the badge above the heat narration card. Same on the inbox row (already has `PriorTouchesChip` — confirm parity).
- **Bar:** Lead detail shows "X prior touches across N platforms" or "No prior touches" honestly.

**T5-γ.5. Wire `enabledCategories` into daily-digest builder — 0.5 day**
- `daily-digest.ts:603` (`sendDigestEmail`) currently builds one venue-level digest. Restructure to per-user: for every active preference row in `userPrefs`, call `enabledCategories(prefs)` and build a digest filtered to those categories, send to that user's email (not `venues.briefing_email`).
- Legacy fallback (no preferences row) keeps the venue-level path.
- **Bar:** Two coordinators with different category preferences receive different digests.

**T5-γ.6. Build the `self_knowledge_insights_enabled` toggle UI — 0.5 day**
- Add a checkbox to `/agent/settings` (or `/settings/`) bound to `venues.self_knowledge_insights_enabled`. Audit prompt + transparency copy: "When enabled, Bloom may surface insights about your own draft-editing patterns."
- **Bar:** Coordinator can opt in; T3-I coordinator-override-pattern fires for that venue afterward.

**T5-γ.7. Surface `brain_dump_entries` 30-day audit at /settings/brain-dump-log — 0.5 day**
- Today the page shows only grants. Add a tab or section for `Recent entries (30d)` listing each `brain_dump_entries` row with its parsed intent + routed_to + status.
- **Bar:** Coordinator can audit "what did Sage do with each thing I dropped in over the last month?"

### Phase T5-δ — Pattern C: derived-field recompute (INV-2.5)

**T5-δ.1. Triggers for inquiry_date / wedding_date / guest_count change — 2-3 days**
- New migration `156_temporal_recompute_triggers.sql`:
  - `weddings_inquiry_date_change_recompute` trigger: when `inquiry_date` updates, mark `weddings.heat_recompute_pending = true`. A separate cron (every 5 min) finds pending rows and runs `applyHeatScoreToWedding`. (Don't recompute inline — heat-mapping involves multi-table reads and would block the UPDATE.)
  - Same trigger nulls out `intelligence_insights.last_classical_signature` for any insight with `context_id = NEW.id` so cache invalidates on next read.
  - Same trigger flags `wedding_journey_narratives` and `tours.tour_brief_text` for refresh (set a `stale_since` timestamp).
- Update T3 cache_key construction: include `inquiry_date.toISOString().slice(0,10)` in every classical signature so even without a trigger, a manual refresh produces a new cache miss.
- **Bar:** Move `inquiry_date` on a wedding in staging; within 5 minutes heat_score, narrative, tour brief all show fresh values.

**T5-δ.2. Cron entry for the recompute sweep — 0.5 day**
- Add `*/5 * * * *` cron `recompute_pending_temporal` that walks `weddings.heat_recompute_pending = true` and processes them.
- **Bar:** vercel.json has the entry; `recordEngagementEventsBatch` lookup verifies clean recompute.

### Phase T5-ε — Pattern E: cron audit + missing daily writers

**T5-ε.1. Fix FRED daily writer (USP #4 critical) — 1 day**
- `vercel.json:44-46` currently `economic_indicators` cron calls `fetchAllEconomicIndicators` from `economics.ts`. Either:
  - (i) make `fetchAllEconomicIndicators` write to BOTH tables (legacy compat) and migrate `correlation-engine` to read whichever has the freshest fetched_at, OR
  - (ii) replace the cron handler to call `fetchAllDefaultFredSeries` from `fred-fetch.ts`; deprecate `economics.ts`.
- Option (ii) is cleaner. Memory note: `economic_indicators` table is used by `intel-brain.ts` data-gather — that path needs to switch to `fred_indicators` too.
- **Bar:** Daily 03:00 UTC, `fred_indicators` has rows with `fetched_at = today`.

**T5-ε.2. Cultural moments auto-propose cron — 0.5 day**
- Add `vercel.json` entry: `0 8 * * *` (daily 08:00 UTC) calling the `auto-propose` route with `scope=all` + service-role bearer. Expose a separate `/api/cron/cultural-moments-auto-propose` that bypasses the user-auth check.
- **Bar:** Search trends spike → cultural moment proposed without coordinator clicking.

**T5-ε.3. Audit every USP-bearing primary table for daily writer coverage — 0.5 day (audit) + 1-3 days (fixes)**
- Walk the list: `weddings` (live writes — fine), `engagement_events` (live — fine), `interactions` (live — fine), `attribution_events` (computed via candidate-resolver — verify cadence), `marketing_spend` (manual + brain-dump — fine), `pricing_history` (trigger + manual — fine), `cultural_moments` (T5-ε.2 fix), `fred_indicators` (T5-ε.1 fix), `weather_data` (cron `weather_forecast` exists), `search_trends` (cron `trends_refresh` exists).
- Document coverage in `OPS.md` so future schemas don't drift.
- **Bar:** Every primary table has a documented writer (live / cron / coordinator-only) and the cron entries exist.

### Phase T5-ζ — Pattern F: primitive consolidation

**T5-ζ.1. Migrate `/intel/clients/[id]/page.tsx` to `<HeatBadge>` — 1 day**
- Replace the 5 bespoke heat render sites at lines 847, 1103, 1107, 1113, 1131, 1144 with `<HeatBadge tier={...} score={...} variant={...}>`. Add new variants to the primitive if needed (e.g., `variant="hero-detail"` for the page header).
- Drop `heatColor()` and `heatBg()` local helpers (or keep as wrappers if other callers need them).
- **Bar:** `grep "heatColor\|heatBg" src/app/(platform)/intel` returns zero hits.

**T5-ζ.2. Mount `RiskFlag` on inbox + leads + pipeline cards — 1-2 days**
- Each surface needs to fetch the risk score per lead. Add a batch endpoint `/api/insights/risk-flags` that takes a `weddingIds[]` and returns the latest risk_flag insight per lead. Surface mounts call it once per page render.
- **Bar:** Risk flag visible on inbox row, leads-list row, pipeline card — same component, same colour.

**T5-ζ.3. Mount `PriorTouchesBadge` (covered by T5-γ.4)**

### Phase T5-η — Pattern D, continued: gates + observability

**T5-η.1. /pulse "intelligence paused" header — 0.5 day**
- `pulse-aggregator.ts` should fetch `venue_config.autonomous_paused` separately from notifications and surface it as a top-level pinned banner in the UI (not as a notification item that can be dismissed).
- Banner shows: paused-since timestamp, ceiling reached, "resume early" coordinator action button, what's been skipped (digest skipped Mon, anomaly explanation skipped Mon).
- **Bar:** Coordinator opening /pulse during a paused venue sees a clear banner that does not snooze.

**T5-η.2. Cost-ceiling pause replay queue — 1-2 days**
- New table `paused_period_skipped` with rows for each cron tick that filterActiveVenues silently dropped.
- On 00:05 UTC resume, dispatch a "summary" notification listing what was skipped Monday + offering a one-click backfill.
- **Bar:** Coordinator can see "you missed 3 follow-ups, 1 anomaly explanation, and 2 weekly insights during yesterday's pause."

**T5-η.3. correlation_id propagation to engagement_events / interactions / notifications / intelligence_insights — 1-2 days**
- Migration `157_correlation_id_extension.sql`: add the column to all four tables.
- Update `recordEngagementEventsBatch`, interaction insert path, `createNotification`, and `persistInsight` to accept + persist correlationId.
- LeadInsightsPanel: generate a request-scoped UUID per "Refresh" click and thread it through `/api/insights/lead/[weddingId]?correlationId=X`.
- **Bar:** A single grep query in api_costs+drafts+engagement_events+interactions+notifications+intelligence_insights by correlation_id returns the full lineage of one user click.

**T5-η.4. `persistInsight` honest state telemetry — 0.5 day**
- C1 #8: today returns `state='inserted'` even on update. Replace with the row-id + a separate query-after to determine whether `created_at == updated_at` (proxy for first-write).
- **Bar:** Telemetry queries for "stale invalidations" return real numbers.

### Phase T5-θ — USP gap closures (YC partner findings)

**T5-θ.1. USP #4 — Build the LLM-narrated cross-limb surface — 3-5 days**
- This is the single biggest investor-relevant gap. Pattern: `anomaly-detection.getAIExplanation` already does the right shape for Internal Context. Extend that pattern to External Context.
- New surface: `/intel/macro-correlations` (or as a section on `/intel/dashboard`) that pulls the top-N correlation insights from `intelligence_insights` (where `insight_type='correlation'`) and runs them through a Sonnet narration prompt that has access to FRED + cultural moments + weather + calendar events + search trends.
- The narration gets surface_priority + cache_key like other T3 narrations.
- **Bar:** A coordinator on Rixey can open /intel/macro-correlations and see at least one human-readable LLM-written cross-limb story per week.

**T5-θ.2. USP #5 — Expand `gatherVenueData` — 1-2 days**
- Add to `intel-brain.ts:gatherVenueData`:
  - `attribution_events` (last 90d) with platform breakdown
  - `candidate_identities` summary (count, conversion rate)
  - `cultural_moments` (confirmed, last 90d)
  - `fred_indicators` (last 90d, default panel)
  - `external_calendar_events` (next 90d)
  - Internal Context summaries: `coordinator_absences`, `venue_operational_state`, `pricing_history`, `marketing_channels`
  - `interactions` body excerpts (last 90d, summarised by an extractor pass)
  - `tours.cancellation_reason` aggregates
- Update the system prompt at `intel-brain.ts:130-181` to enumerate the new domains.
- 30-day window → 365-day window for `weddings`.
- **Bar:** Sage can answer "Did Pinterest leads convert better than Knot in Q1?" with grounded numbers, not hedging.

**T5-θ.3. USP #3 — Voice DNA Gmail-backfill seed path — 2-3 days**
- New service `src/lib/services/voice-dna-extract.ts` that runs over a backfilled venue's outbound interactions, extracts coordinator-written phrases (filter to interactions where `direction='outbound'` AND `auto_sent IS NOT TRUE` so it's coordinator-written, not Sage), runs an LLM extraction pass to pull style anchors, writes them to `voice_preferences`/`phrase_usage`/`review_language` (whichever is the right table for each shape).
- Wire as Day-4 onboarding-project step (currently punts to "manual scripts").
- **Bar:** A venue completing backfill on Day 4 has populated `voice_preferences` rows reflecting their coordinator's actual writing.

**T5-θ.4. Demo seed — populate Internal Context (USP #2 demo viability) — 1-2 days**
- `supabase/seed.sql` needs `marketing_channels`, `coordinator_absences`, `venue_operational_state`, `pricing_history`, `attribution_events`, `candidate_identities`, `tangential_signals`, `marketing_spend`, `cultural_moments`, `fred_indicators` rows for Hawthorne Manor + the 3 other Crestwood venues.
- Generate 12 months of synthetic but plausible data; tag with `confidence_flag='manual'` so it's clearly demo.
- **Bar:** A YC partner demo on Hawthorne Manor sees Funnel + CAC columns populated, anomaly hypotheses citing Internal Context, source-quality scorecard with real-looking numbers.

### Phase T5-ι — One-off correctness fixes

**T5-ι.1. fire-once heat events: replace SELECT-then-INSERT with DB unique constraint — 0.5 day** (C1 #21)
- Add a partial unique index `(venue_id, wedding_id, event_type) WHERE event_type IN ('initial_inquiry', 'tour_completed', ...)` for the fire-once event types.
- Drop the in-code `shouldSkipDuplicate` check; let the DB enforce.

**T5-ι.2. audio-capture orchestrator race — 1 day** (C1 #9)
- Replace read-modify-write with single SQL: `UPDATE transcript_orphans SET transcript = COALESCE(transcript, '') || $newText WHERE venue_id = $v AND session_id = $s`. Atomic.

**T5-ι.3. brain-dump URL handler — 1 day** (C3 #10)
- Detect URL-only input. Specific paths: Pinterest (fetch `og:image` + caption), Google Doc (require user auth flow, defer to confirm), generic URL (fetch `og:title` + `og:description`).
- Surface a propose-and-confirm with the URL summary + a "fetch as KB?" prompt.

**T5-ι.4. brain-dump PDF handler — 1 day** (C3 #11)
- Add `application/pdf` to the fast-path handlers. Use a PDF text-extraction service (or pdf-parse npm) to convert to text, then route through the classifier.

**T5-ι.5. per-thread auto-send cap — 0.5 day** (C1 #16)
- `checkAutoSendEligible` accepts threadId already. Add a check: count auto-sent drafts on this thread in last 24h; reject if > N.

**T5-ι.6. cohort-match `MIN_COHORT_SIZE` should be higher OR narration should down-rate confidence — 0.5 day** (C1 #17)
- Bump `MIN_COHORT_SIZE` to 5 and require `MIN_QUALIFYING_BANDS=3` for High confidence. Below that, force "Low conf" badge.

**T5-ι.7. /pulse `sinceDays` for high-priority insights — 0.5 day** (C3 #18)
- Critical-priority insights ignore the `sinceDays` floor; pull them regardless of age until `status='acted_on'` or `dismissed`.

---

## Part 4 — Phasing recommendation

| Phase | Time | Includes | Why this order |
|---|---|---|---|
| **T5-α (truth-or-die)** | 2.5 days | draft_feedback probe, T3 cost-ceiling gates, redactError on T3 catches | Cannot ship/demo confidently without these. Pattern H is invisible-broken; the cost-ceiling + PII gates are CRITICAL by every audit. |
| **T5-β (white-label)** | 4-5 days | DEFAULT_PERSONALITY refactor, hardcoded copy sweep, conversation-history fix, fallbacks | Largest finding class; every demo to a non-Rixey venue is a ticking bomb. |
| **T5-γ (ship-without-consumer)** | 5-7 days | confidence_flag, source_provenance, essentials_action_log reader, PriorTouchesBadge mount, enabledCategories wire-up, self_knowledge UI, brain-dump-log entries | Pattern A is the most embarrassing class — features the system claims to do but doesn't. |
| **T5-δ (temporal recompute)** | 2.5-3.5 days | inquiry_date trigger + cache invalidation + recompute cron | INV-2.5 violation across the forensic record; every coordinator who has corrected an inquiry_date in production has dirty derived state today. |
| **T5-ε (cron audit + missing writers)** | 2-4.5 days | FRED daily writer fix, cultural moments cron, primary-table coverage audit | USP #4 is dead without this. |
| **T5-ζ (primitive consolidation)** | 2-3 days | HeatBadge on lead detail, RiskFlag mounting, PriorTouchesBadge already in T5-γ | Visual consistency + cross-surface coverage. |
| **T5-η (gates + observability)** | 3-4 days | /pulse paused banner, replay queue, correlation_id extension, persistInsight telemetry | Forensic record + coordinator trust. |
| **T5-θ (USP gap closures)** | 6-10 days | USP #4 cross-limb narration, USP #5 NLQ expansion, USP #3 voice backfill, demo seed | Pitch-vs-product gap; biggest single block of investor risk. |
| **T5-ι (one-off correctness)** | 4 days | fire-once unique index, audio race, brain-dump URL/PDF, per-thread cap, cohort confidence, pulse age floor | Smaller fixes; can run in parallel with above. |

**Parallelization note (per memory feedback_ai_parallel_execution):** T5-α must be serial (truth-or-die). T5-β can parallelize across files. T5-γ tasks are independent (each a separate consumer wire-up). T5-δ is a coherent unit. T5-ε.1 and T5-ε.2 can parallelize. T5-ζ tasks parallelize. T5-η.1 + T5-η.2 + T5-η.3 + T5-η.4 are independent. T5-θ items each take a coherent block; T5-θ.4 (demo seed) can run alongside any of the others. T5-ι items are all independent.

A pessimistic serial estimate: 32 days. With parallelization across 3-4 streams: 12-15 days.

---

## Part 5 — Doctrine cell impact

These cells should move when the work above lands:
- **INV-2.5** (currently `enforced` per cell line 39) → **partial** until T5-δ ships, then back to enforced. Audit found the cell is over-graded.
- **INV-4.4-A** (white-label) — partial cell that's been promoted prematurely. Move back to `partial` until T5-β ships.
- **INV-18.5** (B-39 confidence_flag) — `enforced` for the schema; T5-γ.1 makes it actually enforced for the consumer.
- **OPS-21.3.6** (access controls / RLS) — already `partial`; T5-η.3 (correlation_id) closes part of it.
- **OPS-21.4.3** (cost ceiling) — already `partial`; T5-α.2 + T5-η.1 + T5-η.2 close it for T3 paths.
- **ANTI-19.9-A** (LLM-produces-numbers) — `partial`; T5-θ.2 doesn't close it but T3-narration-to-correlation in T5-θ.1 needs the same numbers-guard discipline; specify in the migration.
- **ANTI-19.9-3** (insights buried in dashboards) — close once T5-ζ.2 mounts RiskFlag at inbox/leads/pipeline.
- **INV-20.5.4-A** (always propose, never silently file) — close once T5-ι.3 + T5-ι.4 land brain-dump URL + PDF paths.
- **ARCH-18.2 / 18.3-C / 18.3-D / LIMB-16.3** — onboarding backfill cells; T5-θ.3 + T5-ε.1 close the residual gaps the FRED+voice paths leave open.
- **ARCH-20.2.1** (single primitive consistency) — `enforced` per cell line 1364; lead detail bypass found in audit. Move to `partial` until T5-ζ.1.
- **ARCH-20.2.2** (unified pulse) — `partial`; T5-η.1 closes the paused-banner gap.
- **T4-D essentials slider learning** — currently shipped without engine; T5-γ.3 closes it.
- **T4-E graduation** — partial; T5-γ.7 + T5-ι.3 + T5-ι.4 round it out.
- **T4-H digest** — `partial`; T5-γ.5 closes per-user category honoring.

A clean run of T5-α through T5-θ should drop the at-risk count to 0 (already there) and partial count from 67 toward 30-40, with most of the recovered cells landing as `enforced`.

---

## Part 6 — What's NOT in this plan (deliberate)

- **Tier 5 partner enrichment + network intelligence** (per BUILD-PLAN.md). That's still gated on partnership/network closing.
- **Sage's voice drift insight** (C3 #13). Schema doesn't exist; out of scope until T3-I has its UI gate (T5-γ.6) and self-knowledge venue opt-in is real.
- **Wedgewood three-level region UI** (C4 #11). The plumbing supports it; the UI build is a separate sprint and is conversation-dependent on Wedgewood requirements.
- **NLQ <10 weddings floor** (C4 #19). It's correct behavior; not a bug.
- **Setup placeholder text "Hawthorne Manor"** (C2 #23). Placeholder is fine; real fix is T5-β.4 removing the venue's name as a default in deployable code paths.

---

## Part 7 — Disagreement noted

Per the audit plan: *Disagreement between reports is itself a finding worth investigating.*

**HeatBadge consistency:** C1 says solid; C3 says broken on lead detail. Code-level inspection: C3 is correct (lead detail at `intel/clients/[id]/page.tsx:847-1144` uses 5 bespoke render paths). C1's assertion was based on the file imports, not the renders. **Resolution: C3's finding stands; T5-ζ.1 owns the fix.**

This kind of disagreement is informative: a single audit pass can miss what a different vantage point sees. Future audits should explicitly ask each character to check the others' "what's solid" lists.
