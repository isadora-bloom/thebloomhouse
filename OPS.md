# Bloom House — Ops notes

Short notes on things you do operationally (outside of writing features).

## Primary table coverage matrix (T5-ε.3)

The motivation: Stream C found that the FRED daily writer had been
silently writing to the WRONG table (`economic_indicators`) for months
while every reader looked at `fred_indicators`. The macro channels in
the correlation engine sat permanently empty as a result. This matrix
documents who writes every USP-bearing primary table so future schemas
don't drift the same way.

**Writer-class taxonomy:**
- **live** — written inline by user-facing flow (email pipeline, API
  route, coordinator UI submit). Freshness is real-time.
- **cron** — written by a Vercel cron at the cadence noted. Freshness
  is bounded by the cadence + cost-ceiling pause windows.
- **trigger** — populated by a Postgres trigger on a parent table.
- **coordinator-config** — manual coordinator UI; no automatic writer.
  Freshness is whenever the coordinator updates it.
- **import-only** — only written by `data-import` / `brain-dump-imports`
  / one-shot scripts.

| table | writer_class | writer_path | read_freshness_target | observability |
|---|---|---|---|---|
| `weddings` | live + import | `email-pipeline.ts` (live), `data-import.ts` / `brain-dump-imports.ts` (bulk), `portal/weddings/page.tsx` (manual) | real-time | `cron_runs.email_poll`, structured logs `wedding_created` |
| `interactions` | live | `email-pipeline.ts` (inbound + outbound), `agent/send` + `agent/reply` routes | real-time | structured logs |
| `drafts` | live + cron | `email-pipeline.ts` + `post-tour-brief.ts` (cron-driven via `tour_brief`) | real-time | `cron_runs` (tour_brief side-effect of `phase_b_sweep`) |
| `engagement_events` | live + import | `heat-mapping.ts` after-action triggers, `storefront-analytics-import.ts`, `brain-dump-imports.ts` | real-time | logs |
| `lead_score_history` | live | `heat-mapping.ts` (every recompute) + `recompute_pending_temporal` cron | real-time | `cron_runs.recompute_pending_temporal` (every 5 min) |
| `attribution_events` | live + cron | `candidate-resolver.ts` (live), `phase_b_sweep` cron, `intel/candidates/link` route | bounded by cron 04:45 | `cron_runs.phase_b_sweep` |
| `candidate_identities` | live + cron | `email-pipeline.ts` + `candidate-clusterer.ts`, `phase_b_sweep` cron | bounded by cron 04:45 | `cron_runs.phase_b_sweep` |
| `tangential_signals` | import + live | `platform-signals-import.ts`, `tangential-signals-import.ts`, `identity-enqueue.ts` | per-import | logs |
| `marketing_spend` | live + import | `marketing-spend.ts` route + `data-import.ts` + brain-dump | real-time on coordinator save | none — manual entry |
| `marketing_channels` | coordinator-config | `portal/marketing-channels-config/page.tsx` | on save | none |
| `coordinator_absences` | coordinator-config | `portal/absences-config/page.tsx` | on save | none |
| `venue_operational_state` | coordinator-config | `portal/property-state-config/page.tsx` | on save | none |
| `pricing_history` | live | `pricing-history.ts` (called from places where price fields change) | real-time | logs |
| `cultural_moments` | cron + manual | `cultural_moments_auto_propose` cron writes proposed rows; coordinator confirms via `intel/cultural-moments/page.tsx` | daily 08:15 UTC | `cron_runs.cultural_moments_auto_propose` |
| `venue_cultural_moment_state` | coordinator-config | `intel/cultural-moments/page.tsx` per-venue confirm | on confirm | none |
| `fred_indicators` | cron | `fred_daily_refresh` → `fred-fetch.ts:144` upsert | daily 03:00 UTC | `cron_runs.fred_daily_refresh` + sanity-count freshness alert in handler |
| `weather_data` | cron | `weather_forecast` → `weather.ts:371` upsert | daily 05:00 UTC | `cron_runs.weather_forecast` |
| `search_trends` | cron | `trends_refresh` → `trends.ts:227` upsert | weekly Mon 03:00 UTC | `cron_runs.trends_refresh` |
| `external_calendar_events` | cron | `external_calendar_refresh` → `external-context/calendar-writer.ts:populateUSCalendarEvents` upsert (federal + religious + sporting + industry + cultural) | daily 04:00 UTC, rolling 365-day window | `cron_runs.external_calendar_refresh` + structured `external_calendar_refresh` log lines with by-category counts |
| `intelligence_insights` | live + cron | `quality-signals.ts`, `correlation-engine.ts`, `data-integrity.ts`, `insights/persist.ts`, all `insights/*.ts` generators | varies — per insight type | `cron_runs.{anomaly_detection,correlation_analysis,data_integrity_sweep,quality_signals_refresh,intelligence_analysis}` |
| `wedding_journey_narratives` | cron | written by `journey-narrative.ts` triggered by intelligence pipelines | varies | logs |
| `tour_brief_*` (on `tours`) | cron | `post-tour-brief.ts` triggered after tour completes | within 24h of tour | logs |
| `re_engagement_actions` | live + cron | `intel/reengagement/draft` route + `re-engagement.ts` sweeper called by `re_engagement_attribution` cron | daily 05:30 UTC | `cron_runs.re_engagement_attribution` |
| `api_costs` | live | `lib/ai/client.ts:184`, `lib/ai/cost-tracker.ts`, `bar-recipe-extract.ts` | every callAI invocation | self — its own telemetry |
| `cron_runs` | cron-meta | `lib/observability/metrics.ts:trackCronRun` (wraps every job) | every cron tick | self |
| `metered_events` | live | `lib/observability/metrics.ts` counter ingest | real-time | self |
| `paused_period_skipped` | live + cron | `cost-ceiling.ts:286` insert + `replay-paused-skipped` cron expire | real-time + daily 00:05 UTC | `cron_runs.replay_paused_skipped` |
| `ai_briefings` | cron | `briefings.ts` from `weekly_briefing` (Mon 08:00 UTC) + `monthly_briefing` (1st 08:00 UTC) | weekly/monthly | `cron_runs.{weekly,monthly}_briefing` |
| `anomaly_alerts` | cron | `anomaly-detection.ts:832` from `anomaly_detection` cron | daily 04:00 UTC | `cron_runs.anomaly_detection` |
| `admin_notifications` | live + cron | every cron that needs to nudge a coordinator (cost ceiling, weekly digest, backtrace, etc.) | as fired | logs |
| `notifications` | **NONE (gap)** | intelligence-engine.ts referenced once in a string but no INSERT exists | n/a | n/a |
| `tours` | live + import | `webhooks/calendly` route, `intel/tours/page.tsx` manual, `data-import.ts` bulk | real-time | logs |
| `lost_deals` | live + import | `heat-mapping.ts:1195` (auto-mark-lost path), `intel/lost-deals/page.tsx`, `data-import.ts` | real-time | logs |
| `event_feedback` | live | `portal/weddings/[id]/page.tsx` coordinator submit | on submit | nudged by `post_event_feedback_check` (currently un-scheduled) |
| `insight_outcomes` | cron | `insight-tracking.ts` from `outcome_measurement` (currently un-scheduled) | varies | n/a |
| `voice_preferences` | coordinator-config + onboarding | `settings/voice/page.tsx`, `agent/learning/page.tsx`, Day-4 onboarding wizard | on save | none |
| `phrase_usage` | live | `lib/ai/phrase-selector.ts:125` per draft | real-time | logs |
| `consultant_metrics` | live | `consultant-tracking.ts` per draft accept/reject | real-time | logs |
| `review_language` | cron + import | `transcript_voice_mining` cron, `data-import.ts` (review imports) | weekly Tue 06:00 UTC | `cron_runs.transcript_voice_mining` |
| `market_intelligence` | cron | `census-ingest.ts:172` from `census_refresh` | monthly 1st 03:00 UTC | `cron_runs.census_refresh` |
| `venue_health` / `venue_health_history` | cron | `venue-health-compute.ts` from `venue_health_compute` | weekly Tue 04:00 UTC | `cron_runs.venue_health_compute` |
| `source_attribution` | cron | `attribution_refresh` cron (route.ts:882 upsert) | weekly Mon 02:00 UTC | `cron_runs.attribution_refresh` |
| `wedding_touchpoints` | live | `candidate-resolver.ts:572` insert | real-time | logs |
| `transcript_segments` | live | `audio-capture/orchestrator.ts:218` per Omi/Zoom transcript | real-time | logs |
| `tour_transcript_orphans` | live | `omi/webhook` + `audio-capture/orchestrator.ts` orphan path | real-time | logs |
| `processed_zoom_meetings` | cron | `zoom_poll` cron | daily 10:00 UTC | `cron_runs.zoom_poll` |
| `processed_sms_messages` | cron | `openphone_poll` cron | every 15 min | `cron_runs.openphone_poll` |
| `brain_dump_entries` | live | `api/brain-dump/route.ts` | real-time | logs |
| `brain_dump_pattern_grants` | cron | `brain-dump-graduation.ts` (reads action log + grants patterns) — currently no cron entry; ad-hoc | n/a | n/a |
| `essentials_action_log` | live | `api/settings/essentials-preferences/log/route.ts` | real-time | logs |
| `cron-fired suggestion notifications via essentials_action_log` | cron | `essentials_suggest` cron writes to `admin_notifications` | daily 08:30 UTC | `cron_runs.essentials_suggest` |

## Cron schedule (mirrored from `vercel.json`)

| schedule (UTC) | job | tables touched | what it does |
|---|---|---|---|
| `*/5 * * * *` | `email_poll` | `interactions`, `weddings`, `candidate_identities`, `attribution_events`, `engagement_events`, `drafts`, `intelligence_extractions` | poll every connected Gmail and run the inquiry pipeline. Drives the inbox, heat scores, attribution, drafts. |
| `*/5 * * * *` | `recompute_pending_temporal` | `weddings.heat_recompute_pending`, `lead_score_history` | drains the temporal-trigger backlog when coordinators correct dates / guest count. |
| `*/15 * * * *` | `openphone_poll` | `processed_sms_messages`, `interactions` | OpenPhone (Quo) SMS / voicemail / call-summary sync. |
| `15 * * * *` | `cost_ceiling_check` | `venue_config.autonomous_paused`, `admin_notifications`, `paused_period_skipped` | hourly enforce of the cost ceiling. 80% notify, 100% pause. |
| `0 * * * *` | `follow_up_sequences` | `drafts`, `interactions`, `wedding_sequences` | enqueue follow-up sequence steps that came due this hour. |
| `5 0 * * *` | `cost_ceiling_reset` | `venue_config.autonomous_paused` | clear yesterday's pauses if spend is back under ceiling. |
| `5 0 * * *` | `replay_paused_skipped` | `paused_period_skipped`, `admin_notifications` | expire stale skipped rows + emit a per-venue recap notification when pause clears. |
| `0 2 * * 1` | `attribution_refresh` | `source_attribution` | weekly source × outcome ROI rollup from `weddings` + `marketing_spend`. |
| `0 3 * * 1` | `trends_refresh` | `search_trends` | weekly SerpAPI google-trends pull per venue metro × wedding-term. |
| `0 3 * * *` | `fred_daily_refresh` | `fred_indicators` | daily FRED macro indicators (CPI, mortgage, S&P 500, unemployment, sentiment). Sanity-asserts rows landed. |
| `0 3 1 * *` | `census_refresh` | `market_intelligence` | monthly Census ACS5 county/state/national rollup. |
| `30 4 * * *` | `backtrace_scan` | `admin_notifications` (writes), reads `interactions` + `weddings` | daily re-scan for newly-discoverable scheduling-tool relays after Gmail catches up. |
| `45 4 * * *` | `phase_b_sweep` | `tangential_signals`, `candidate_identities`, `attribution_events`, `wedding_touchpoints` | daily catch-up resolver: re-cluster orphan signals, re-resolve unmatched candidates. AI-skip mode. |
| `0 4 * * *` | `anomaly_detection` | `anomaly_alerts`, `intelligence_insights` (data_anomaly type) | daily anomaly hypothesis sweep across inquiries / bookings / sources / drop-offs. |
| `0 4 * * *` | `external_calendar_refresh` | `external_calendar_events` | populate US-nationwide federal / religious / sporting / industry / cultural calendar events for the next 365 days. Idempotent UPSERT. |
| `0 4 * * 2` | `venue_health_compute` | `venue_health`, `venue_health_history` | weekly venue-health snapshot. |
| `0 5 * * *` | `data_integrity_sweep` | `intelligence_insights` (data_anomaly + self_healed) | run the 8 invariants on every venue. |
| `0 5 * * 2` | `quality_signals_refresh` | `intelligence_insights` | weekly two-email-drop-off insights per venue. |
| `30 5 * * *` | `re_engagement_attribution` | `re_engagement_actions`, `attribution_events` | daily 60-day window match: did our outreach convert? |
| `0 5 * * *` | `weather_forecast` | `weather_data` | daily NOAA forecast pull per venue lat/lng. |
| `0 6 * * *` | `heat_decay` | `weddings.heat_score`, `engagement_events`, `lead_score_history`, `lost_deals` | daily decay + cooling warnings + auto-mark-lost. |
| `0 6 * * 2` | `transcript_voice_mining` | `review_language`, `voice_preferences` (mined patterns) | weekly tour-transcript-vs-review mining for booked + 5-star couples. |
| `0 7 * * *` | `daily_digest` | `admin_notifications` (fan-out), reads `weddings` + `tours` + `intelligence_insights` | per-user daily digest email + push. |
| `0 7 * * 2` | `correlation_analysis` | `intelligence_insights` (correlation type) | weekly Pearson correlation across internal channels + FRED + cultural moments + calendar. |
| `0 8 1 * *` | `monthly_briefing` | `ai_briefings` | LLM-narrated monthly business brief. |
| `0 8 * * 1` | `weekly_briefing` | `ai_briefings`, `admin_notifications` | LLM-narrated weekly business brief. |
| `15 8 * * *` | `cultural_moments_auto_propose` | `cultural_moments` | nightly trend-spike → propose cultural moment per venue with `google_trends_metro`. |
| `30 8 * * *` | `essentials_suggest` | `admin_notifications` | daily nudge when coordinator dismissed 5+ high-density essentials cards in last 30 days. |
| `0 9 * * *` | `inbox_filter_learning` | `venue_email_filters` | learn per-venue false-positive filters from triage history. |
| `0 10 * * *` | `zoom_poll` | `processed_zoom_meetings`, `transcript_segments` | daily Zoom-cloud-recording sync per active connection. |

## VALID_JOBS without a vercel.json schedule

The cron route accepts these job names but vercel.json doesn't fire
them on a schedule. They can be hand-fired through the route, used for
ad-hoc debugging, or simply unscheduled by intent:

- `economic_indicators` — kept as alias of `fred_daily_refresh` for the
  transition; do NOT add to vercel.json (would write the dead
  `economic_indicators` table). Drop the alias once nobody calls it.
- `intelligence_analysis` — generators run inline from other crons or
  user actions; no schedule needed.
- `weekly_digest` — superseded by per-user `daily_digest` (which runs
  the weekly section once a week internally).
- `outcome_measurement` — measures pending insight outcomes once their
  measurement window elapses. Should probably be on a daily schedule;
  P2 follow-up.
- `post_event_feedback_check` — checks weddings 3 days post-event for
  missing feedback. Should probably be on a daily schedule; P2 follow-up.

## P1 follow-ups (call-outs from this audit)

### ~~`external_calendar_events` has zero writers~~ — closed by Stream V (T5-followup)
Daily cron `external_calendar_refresh` at 04:00 UTC writes US-nationwide
federal + religious + sporting + industry + cultural events for a
rolling 365-day window via `populateUSCalendarEvents` in
`lib/services/external-context/calendar-writer.ts`. Migration 169 added
the unique index `uq_ece_scope_title_start` and the `created_by_writer`
provenance column. State-level (`us_<STATE>`) rollout + coordinator-curated
local events (regional bridal expos, town festivals) remain follow-ups.
Religious / lunar drift table is hardcoded for 2024-2030 — extend before
2029.

### `notifications` has zero writers
Migration 017 created the table for the couple-portal notification fan-out.
Only references are string literals in `intelligence-engine.ts`; no
`.from('notifications').insert(...)` anywhere. Couple-side notifications
are de-facto handled via `admin_notifications` today. Either drop the table
or wire the couple-side write path.

### Empty cron object in vercel.json (line 7-8)
`vercel.json` contains an empty `{}` cron entry. Vercel will likely either
ignore it silently or fail validation on next deploy. Should be removed.

### FRED dual-key alias risk
`VALID_JOBS` keeps `economic_indicators` as an alias of
`fred_daily_refresh`. As long as nothing schedules `economic_indicators`
the pre-fix behaviour cannot recur — but a future engineer following
the muscle-memory of "the old name" could re-add it to vercel.json and
silently re-introduce the bug. Drop the alias once we're confident no
external caller uses it.

### Smoke-test against staging — NOT RUN in this stream
This audit was static. Recommend running the following in production
console (or via `scripts/data-integrity-check.ts`) to confirm cadence
freshness:

```sql
-- Each row should have a non-null max(fetched_at) within the last 7 days
SELECT 'fred_indicators' AS t, max(fetched_at), count(*) FROM fred_indicators WHERE fetched_at >= now() - interval '7 days'
UNION ALL
SELECT 'weather_data',     max(created_at),  count(*) FROM weather_data     WHERE created_at >= now() - interval '7 days'
UNION ALL
SELECT 'search_trends',    max(created_at),  count(*) FROM search_trends    WHERE created_at >= now() - interval '14 days'
UNION ALL
SELECT 'cultural_moments', max(created_at),  count(*) FROM cultural_moments WHERE created_at >= now() - interval '14 days'
UNION ALL
SELECT 'attribution_events', max(created_at), count(*) FROM attribution_events WHERE created_at >= now() - interval '7 days';
```

```sql
-- Confirm cron_runs telemetry shows every scheduled job firing in
-- the last 24h (or last 7 days for weekly jobs)
SELECT job_name, max(started_at), count(*) FILTER (WHERE status='ok')
FROM cron_runs
WHERE started_at >= now() - interval '7 days'
GROUP BY job_name
ORDER BY job_name;
```

If any cron-driven table has stale `max(...)` > expected cadence, treat
it as P1 like Stream C found for FRED.

## Coverage gap checklist (for future migrations)

If you add a new primary table (anything that drives an Intel surface,
Agent draft, or USP claim), you MUST:

1. **Add a writer.** Live (in a service / route), cron (in
   `src/app/api/cron/route.ts` + `vercel.json`), trigger, or a
   coordinator-config UI. Pure-read tables are not allowed unless
   explicitly seeded — and seeded tables cannot be the basis of a USP
   claim.
2. **Document it in the matrix above.** Add a row with writer_class +
   writer_path + freshness target + observability source.
3. **If cron-driven:** add to the cron schedule table with the cadence
   and a one-line semantic.
4. **Add a smoke-test fixture.** Either:
   - extend `scripts/data-integrity-check.ts` with an invariant that
     fails when the table has no rows in its expected freshness window,
     OR
   - add a fixture-seeded test in `e2e/sections/*.spec.ts` that exercises
     the UI surface dependent on the table.
5. **Run `npx tsx scripts/audit-table-writers.ts` before merging** —
   the tool flags ORPHAN tables and is the canonical mechanical check
   for this rule. CI doesn't run it yet (P3 follow-up: add to
   `.github/workflows/ci.yml`).

## Secrets rotation

### CRON_SECRET

Protects `/api/cron` (Vercel cron schedule in `vercel.json`).

- **Rotate:** when a developer leaves, or if `vercel env` output
  might have been viewed by an unauthorized party, or quarterly as
  hygiene.
- **How:** `vercel env pull` to see current. Set new value with
  `vercel env add CRON_SECRET production`. Re-deploy. Delete the
  old value with `vercel env rm CRON_SECRET production` after
  confirming the new one works.
- **Blast radius if leaked:** attacker can manually trigger cron
  jobs (heat decay, email poll, digests). Can cause noise
  (extra email polls) but not destructive state changes on their
  own — crons operate on venue data but each job is idempotent.

### TEST_HARNESS_SECRET

Protects `/api/admin/test-harness` — destructive actions (apply_daily_decay,
record_engagement_event, process_incoming_email). Intentionally
SEPARATE from CRON_SECRET because the harness should default OFF
in prod.

- **Production default:** UNSET. Endpoint returns 501.
- **If you need it temporarily (prod ops):**
  1. `vercel env add TEST_HARNESS_SECRET production` (use a fresh
     random value, not CRON_SECRET)
  2. Redeploy
  3. Run the action
  4. `vercel env rm TEST_HARNESS_SECRET production`
  5. Redeploy again
- **Dev default:** falls back to `CRON_SECRET` when
  `NODE_ENV !== 'production'`. Just make sure `CRON_SECRET` is in
  `.env.local` and everything works.

## Migrations

### Normal flow (new migrations going forward)

1. Write `supabase/migrations/NNN_description.sql`
2. `node scripts/apply-migrations.mjs` — report mode, lists what's
   pending vs already applied
3. `node scripts/apply-migrations.mjs --apply` — interactive
   confirmation + apply in order + re-probe after
4. Commit the migration file
5. If the migration has a probe-worthy CHECK / policy that
   `CREATE TABLE` / `ADD COLUMN` parsing can't see, add a
   `-- @probe: insert_accepts table.col=value` directive so the
   script can verify it on future runs

### Historical gap: 3 duplicate-prefix files

030/031/032 each have TWO files with the same prefix (e.g.
`030_ceremony_chair_plans.sql` and `030_guest_tags.sql`). Supabase
CLI's `schema_migrations` tracking table uses the prefix as primary
key, so it can only record one of each pair. `supabase db push`
will always list those three as pending. Ignore — `apply-migrations.mjs`
probes actual artifacts instead of trusting the tracking table.

## Demo data hygiene

The 4 demo venues (Crestwood Collection) are meant to be
frozen-in-time. Set `venue_config.lost_auto_mark_days = 0` on all
demo venues so the daily 06:00 UTC heat_decay cron doesn't auto-lose
demo inquiries as they age past 30 days silent.

When running decay probes against prod, scope them to a test wedding
in a non-demo venue OR restore demo state immediately after. See
`scripts/e2e-data-flow-test.mjs --cleanup` for the test-data pattern.

## CI

GitHub Actions workflow at `.github/workflows/ci.yml`:
- `tsc --noEmit` — type check
- `npx tsx scripts/test-normalize-source.ts` — 44 cases
- `npx tsx scripts/test-booking-signal.ts` — 31 cases

Runs on push to master + PRs. Vercel runs `next build` on deploy
which catches TypeScript errors independently, but the unit tests
above are NOT part of the Vercel build — the Actions workflow is
the only gate for those.

### Not yet in CI

- Playwright e2e suite (`e2e/sections/*.spec.ts`) — needs Supabase
  anon/service keys as Actions secrets + a running dev server on
  port 3100. Runs manually.
- `scripts/e2e-data-flow-test.mjs` — runs against live prod Supabase
  via `TEST_HARNESS_SECRET`. Explicitly kept manual so it doesn't
  hit Claude + mutate prod on every push.
- `scripts/audit-table-writers.ts` — the ORPHAN-detection tool that
  found `external_calendar_events` and `notifications` in T5-ε.3.
  Should run on every PR; tracked as P3 follow-up.
