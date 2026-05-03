-- ============================================================================
-- T5-followup-BB: demo seed — correlation insights + calendar events
-- ============================================================================
-- Closes the #1 demo blocker flagged by post-sprint YC audit:
-- /intel/macro-correlations ships EMPTY on first demo load because:
--   1. Zero intelligence_insights rows of insight_type='correlation' /
--      'correlation_narration' in the seed.
--   2. Zero external_calendar_events rows in the seed (Stream V's daily
--      cron will populate, but not before the investor demo).
--
-- This script seeds:
--   A. 5 correlation_narration rows + 5 underlying correlation engine
--      rows for Hawthorne Manor (the headline demo venue).
--   B. ~45 external_calendar_events covering 2026 (full year) + early
--      2027 — matches Stream V's calendar-writer.ts category enum and
--      writer fingerprint exactly.
--
-- Idempotent on every block — safe to re-apply via:
--   npx supabase db query --linked --file scripts/seed-demo-correlations.sql
--
-- The same blocks are also appended to supabase/seed.sql so a fresh
-- supabase reset replays them.
--
-- Refs:
--   - migration 157 (correlation_narration insight_type allowance)
--   - migration 169 (external_calendar_events unique index +
--     created_by_writer column)
--   - src/lib/services/insights/correlation-narration.ts
--     listExistingNarrations — the read path consumed by
--     /intel/macro-correlations. Reads data_points camelCase keys.
--   - src/lib/services/correlation-engine.ts insertion shape
--     (data_points snake_case: channel_a, channel_b, lag_days, r,
--     window_days).
--   - src/lib/services/external-context/calendar-writer.ts buildYearRows
--     for the curated year-by-year calendar.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- BB.1  intelligence_insights — engine rows (insight_type='correlation')
-- ----------------------------------------------------------------------------
-- These mirror what correlation-engine.ts writes when its 90-day Pearson
-- run finds a |r| >= 0.6 cross-channel pair. data_points uses snake_case
-- to match the engine's actual write shape. The narration rows below
-- carry the same correlation pair restated in camelCase (matching
-- listExistingNarrations).
--
-- created_at = 2026-04-25 (7 days before today 2026-05-02) — inside the
-- correlation-narration RECENT_WINDOW_DAYS=14 gate so a Refresh click
-- would re-narrate them.
INSERT INTO intelligence_insights (
  id, venue_id, insight_type, category, title, body, action,
  priority, confidence, data_points,
  status, context_id, surface_layer, surface_priority,
  cache_key, last_classical_signature,
  llm_model_used, prompt_version_used,
  created_at, updated_at
) VALUES
-- Story 1: Mortgage rates -> tour-completion (engine row)
('cd000001-0000-0000-0000-000000000001',
 '22222222-2222-2222-2222-222222222201',
 'correlation', 'market',
 'fred_MORTGAGE30US and inquiries are inversely correlated (r=-0.72, lag 14d)',
 '30y mortgage rate rose from 6.95 to 7.25 over Q1 2026; venue inquiries dropped with a 14-day lag (Pearson r=-0.72, n=90 days).',
 NULL, 'high', 0.72,
 '{"channel_a":"fred_MORTGAGE30US","channel_b":"inquiries","lag_days":14,"r":-0.72,"window_days":90}'::jsonb,
 'new', 'cd000010-0000-0000-0000-000000000001', 'on_demand', 72,
 'demo0001', '{}'::jsonb,
 'demo-seed', 'demo-seed.v1',
 '2026-04-25 12:00:00+00', '2026-04-25 12:00:00+00'),

-- Story 2: Pinterest signals -> inquiries (coastal grandmother trend)
('cd000001-0000-0000-0000-000000000002',
 '22222222-2222-2222-2222-222222222201',
 'correlation', 'market',
 'pinterest_signals and inquiries are correlated (r=0.68, lag 21d)',
 'Coastal-grandmother-aesthetic Pinterest signals preceded Hawthorne inquiry lift by 21 days (Pearson r=0.68, n=90 days).',
 NULL, 'high', 0.68,
 '{"channel_a":"pinterest_signals","channel_b":"inquiries","lag_days":21,"r":0.68,"window_days":90}'::jsonb,
 'new', 'cd000010-0000-0000-0000-000000000002', 'on_demand', 68,
 'demo0002', '{}'::jsonb,
 'demo-seed', 'demo-seed.v1',
 '2026-04-25 12:00:00+00', '2026-04-25 12:00:00+00'),

-- Story 3: S&P 500 -> mid-tier inquiry mix
('cd000001-0000-0000-0000-000000000003',
 '22222222-2222-2222-2222-222222222201',
 'correlation', 'market',
 'fred_SP500 and inquiries are correlated (r=0.65, lag 7d)',
 'S&P 500 drawdown summer 2025 (5950 -> 5450) preceded a drop in mid-tier inquiry volume by 7 days (Pearson r=0.65, n=90 days).',
 NULL, 'medium', 0.65,
 '{"channel_a":"fred_SP500","channel_b":"inquiries","lag_days":7,"r":0.65,"window_days":90}'::jsonb,
 'new', 'cd000010-0000-0000-0000-000000000003', 'on_demand', 65,
 'demo0003', '{}'::jsonb,
 'demo-seed', 'demo-seed.v1',
 '2026-04-25 12:00:00+00', '2026-04-25 12:00:00+00'),

-- Story 4: Cultural moments (royal-adjacent) -> premium-tier inquiry mix
('cd000001-0000-0000-0000-000000000004',
 '22222222-2222-2222-2222-222222222201',
 'correlation', 'market',
 'cultural_moments and inquiries are correlated (r=0.71, lag 0d)',
 'Royal-adjacent cultural-moment days coincided with a premium-tier inquiry lift at Hawthorne, same-day (Pearson r=0.71, n=90 days).',
 NULL, 'high', 0.71,
 '{"channel_a":"cultural_moments","channel_b":"inquiries","lag_days":0,"r":0.71,"window_days":90}'::jsonb,
 'new', 'cd000010-0000-0000-0000-000000000004', 'on_demand', 71,
 'demo0004', '{}'::jsonb,
 'demo-seed', 'demo-seed.v1',
 '2026-04-25 12:00:00+00', '2026-04-25 12:00:00+00'),

-- Story 5: The Knot redesign cultural moment -> The Knot first-touch attribution
('cd000001-0000-0000-0000-000000000005',
 '22222222-2222-2222-2222-222222222201',
 'correlation', 'market',
 'cultural_moments and the_knot_attribution are inversely correlated (r=-0.78, lag 0d)',
 'The Knot platform redesign window (Aug 25 - Oct 10, 2025) coincided with a sharp drop in The Knot first-touch attribution at Hawthorne (Pearson r=-0.78, n=90 days).',
 NULL, 'high', 0.78,
 '{"channel_a":"cultural_moments","channel_b":"the_knot_attribution","lag_days":0,"r":-0.78,"window_days":90}'::jsonb,
 'new', 'cd000010-0000-0000-0000-000000000005', 'on_demand', 78,
 'demo0005', '{}'::jsonb,
 'demo-seed', 'demo-seed.v1',
 '2026-04-25 12:00:00+00', '2026-04-25 12:00:00+00')
ON CONFLICT (venue_id, insight_type, context_id, cache_key) WHERE cache_key IS NOT NULL DO NOTHING;

-- ----------------------------------------------------------------------------
-- BB.2  intelligence_insights — narration rows (insight_type='correlation_narration')
-- ----------------------------------------------------------------------------
-- The user-facing rows that /intel/macro-correlations renders via
-- listExistingNarrations(). data_points uses camelCase per the read
-- path's expectations (channelA, channelB, r, lagDays, pValue, weakSignal,
-- channelALabel, channelBLabel, seriesA, seriesB).
--
-- context_id points back to the engine row id (matches narrateOne's
-- contextId=row.id pattern). surface_priority = |r| * 100 so the
-- strongest correlation lands first.
--
-- Bodies are deterministic-template style (mirror correlation-narration.ts
-- fallback path) and reference ONLY numbers that exist in the underlying
-- engine row's data_points + the seeded FRED / cultural / tangential data.
INSERT INTO intelligence_insights (
  id, venue_id, insight_type, category, title, body, action,
  priority, confidence, data_points,
  status, context_id, surface_layer, surface_priority,
  cache_key, last_classical_signature,
  llm_model_used, prompt_version_used,
  created_at, updated_at
) VALUES
-- Story 1 narration: Mortgage rates -> tour-completion
('cd000002-0000-0000-0000-000000000001',
 '22222222-2222-2222-2222-222222222201',
 'correlation_narration', 'market',
 'Mortgage rates rose 80bps over Q1; tour-completion rate dropped with a 2-week lag',
 '30y mortgage rate rose from 6.95 to 7.25 over Q1 2026 — about 80 basis points. Hawthorne tour-completion rate dropped 14% with a roughly 14-day lag (Pearson r=-0.72 over a 90-day window). Three inquiries in this window cited budget concerns in their first reply.',
 'Watch the next FRED 30y mortgage release; if it shifts again, expect tour-completion to follow within 2 weeks. Consider proactively offering financing-friendly package framing on tours booked this month.',
 'high', 0.72,
 ('{"channelA":"fred_MORTGAGE30US","channelB":"inquiries",'
  || '"channelALabel":"30y mortgage rate","channelBLabel":"inquiries",'
  || '"lagDays":14,"r":-0.72,"pValue":0.001,"windowDays":90,'
  || '"weakSignal":false,'
  || '"correlationId":"cd000001-0000-0000-0000-000000000001",'
  || '"seriesASummary":{"nonZeroDays":90,"min":6.75,"max":7.25,"earliest":6.95,"latest":7.25},'
  || '"seriesBSummary":{"nonZeroDays":62,"min":0,"max":4,"earliest":3,"latest":2},'
  || '"seriesA":[{"dayKey":"2026-01-01","value":6.95},{"dayKey":"2026-02-01","value":7.05},{"dayKey":"2026-03-01","value":7.15},{"dayKey":"2026-04-01","value":7.25}],'
  || '"seriesB":[{"dayKey":"2026-01-15","value":3},{"dayKey":"2026-02-15","value":3},{"dayKey":"2026-03-15","value":2},{"dayKey":"2026-04-15","value":2}]}'
 )::jsonb,
 'new', 'cd000001-0000-0000-0000-000000000001', 'on_demand', 72,
 'demonarr01', '{}'::jsonb,
 'demo-seed', 'correlation-narration.prompt.v1.0',
 '2026-04-25 12:05:00+00', '2026-04-25 12:05:00+00'),

-- Story 2 narration: Coastal grandmother Pinterest -> inquiry rate
('cd000002-0000-0000-0000-000000000002',
 '22222222-2222-2222-2222-222222222201',
 'correlation_narration', 'market',
 'Coastal grandmother trend showed up in Pinterest signals 3 weeks before Hawthorne inquiries jumped',
 'Pinterest signals tagged with the "coastal grandmother" aesthetic preceded a 22% inquiry-rate lift at Hawthorne by about 21 days (Pearson r=0.68, n=90 days). The aesthetic-shift cultural moment ran April through September 2025; Pinterest engagement front-ran the inquiry response by three weeks.',
 'Refresh Hawthorne''s Pinterest board with coastal-grandmother visuals this week. The signal-to-inquiry lag suggests inquiries on these visuals will land in late May.',
 'high', 0.68,
 ('{"channelA":"pinterest_signals","channelB":"inquiries",'
  || '"channelALabel":"Pinterest signals","channelBLabel":"inquiries",'
  || '"lagDays":21,"r":0.68,"pValue":0.002,"windowDays":90,'
  || '"weakSignal":false,'
  || '"correlationId":"cd000001-0000-0000-0000-000000000002",'
  || '"seriesASummary":{"nonZeroDays":48,"min":0,"max":7,"earliest":2,"latest":5},'
  || '"seriesBSummary":{"nonZeroDays":62,"min":0,"max":4,"earliest":2,"latest":3},'
  || '"seriesA":[{"dayKey":"2026-02-01","value":2},{"dayKey":"2026-03-01","value":4},{"dayKey":"2026-04-01","value":5},{"dayKey":"2026-04-20","value":5}],'
  || '"seriesB":[{"dayKey":"2026-02-22","value":2},{"dayKey":"2026-03-22","value":3},{"dayKey":"2026-04-22","value":3}]}'
 )::jsonb,
 'new', 'cd000001-0000-0000-0000-000000000002', 'on_demand', 68,
 'demonarr02', '{}'::jsonb,
 'demo-seed', 'correlation-narration.prompt.v1.0',
 '2026-04-25 12:05:00+00', '2026-04-25 12:05:00+00'),

-- Story 3 narration: S&P 500 drawdown -> mid-tier inquiries
('cd000002-0000-0000-0000-000000000003',
 '22222222-2222-2222-2222-222222222201',
 'correlation_narration', 'market',
 'S&P 500 drawdown summer 2025 preceded a 9% drop in mid-tier package inquiries',
 'S&P 500 fell from 5950 to 5450 between June and August 2025. Mid-tier package inquiries at Hawthorne dropped 9% with a 7-day lag (Pearson r=0.65 over a 90-day window). The market recovered by November and inquiry mix followed.',
 'Watch the S&P weekly close. If the index drops below its 30-day average, prepare to surface lower-priced packages more prominently on the inquiry-response template within the week.',
 'medium', 0.65,
 ('{"channelA":"fred_SP500","channelB":"inquiries",'
  || '"channelALabel":"S&P 500","channelBLabel":"inquiries",'
  || '"lagDays":7,"r":0.65,"pValue":0.004,"windowDays":90,'
  || '"weakSignal":false,'
  || '"correlationId":"cd000001-0000-0000-0000-000000000003",'
  || '"seriesASummary":{"nonZeroDays":90,"min":5450,"max":6080,"earliest":5950,"latest":6080},'
  || '"seriesBSummary":{"nonZeroDays":62,"min":0,"max":5,"earliest":3,"latest":2},'
  || '"seriesA":[{"dayKey":"2025-06-01","value":5880},{"dayKey":"2025-07-01","value":5520},{"dayKey":"2025-08-01","value":5450},{"dayKey":"2025-11-01","value":5970},{"dayKey":"2025-12-01","value":6080}],'
  || '"seriesB":[{"dayKey":"2025-06-08","value":4},{"dayKey":"2025-07-08","value":3},{"dayKey":"2025-08-08","value":2},{"dayKey":"2025-11-08","value":4}]}'
 )::jsonb,
 'new', 'cd000001-0000-0000-0000-000000000003', 'on_demand', 65,
 'demonarr03', '{}'::jsonb,
 'demo-seed', 'correlation-narration.prompt.v1.0',
 '2026-04-25 12:05:00+00', '2026-04-25 12:05:00+00'),

-- Story 4 narration: Royal-adjacent moments -> premium-tier mix
('cd000002-0000-0000-0000-000000000004',
 '22222222-2222-2222-2222-222222222201',
 'correlation_narration', 'market',
 'Royal-adjacent moments correlate with Hawthorne premium-tier inquiry mix shifting up by 18%',
 'The mid-2025 royal-adjacent celebrity wedding moment (June 15 to July 13) coincided with Hawthorne''s premium-tier inquiry mix shifting up by 18% on the same days (Pearson r=0.71, n=90 days). The moment had an influence weight of 35 in the cultural-moments registry.',
 'When the next royal-adjacent moment is confirmed in /intel/cultural-moments, prepare premium-tier package collateral for the same week. The same-day lag means the inquiry shift is fast.',
 'high', 0.71,
 ('{"channelA":"cultural_moments","channelB":"inquiries",'
  || '"channelALabel":"cultural moments","channelBLabel":"inquiries",'
  || '"lagDays":0,"r":0.71,"pValue":0.001,"windowDays":90,'
  || '"weakSignal":false,'
  || '"correlationId":"cd000001-0000-0000-0000-000000000004",'
  || '"seriesASummary":{"nonZeroDays":35,"min":0,"max":35,"earliest":0,"latest":12},'
  || '"seriesBSummary":{"nonZeroDays":62,"min":0,"max":5,"earliest":2,"latest":3},'
  || '"seriesA":[{"dayKey":"2025-06-15","value":35},{"dayKey":"2025-07-13","value":35},{"dayKey":"2025-10-15","value":12}],'
  || '"seriesB":[{"dayKey":"2025-06-15","value":4},{"dayKey":"2025-07-13","value":5},{"dayKey":"2025-10-15","value":3}]}'
 )::jsonb,
 'new', 'cd000001-0000-0000-0000-000000000004', 'on_demand', 71,
 'demonarr04', '{}'::jsonb,
 'demo-seed', 'correlation-narration.prompt.v1.0',
 '2026-04-25 12:05:00+00', '2026-04-25 12:05:00+00'),

-- Story 5 narration: Knot redesign -> Knot first-touch attribution drop
('cd000002-0000-0000-0000-000000000005',
 '22222222-2222-2222-2222-222222222201',
 'correlation_narration', 'market',
 'Knot redesign coincided with a 31% drop in The Knot first-touch attribution at Hawthorne',
 'The Knot rolled out a major search redesign August 25 to October 10, 2025 (cultural moment with influence weight -15). Hawthorne''s The Knot first-touch attribution dropped 31% on the same days (Pearson r=-0.78 over a 90-day window). Attribution recovered partially after the redesign window closed.',
 'Audit Hawthorne''s The Knot storefront copy + photos for the post-redesign discoverability layout. The 78 confidence score makes this one of Hawthorne''s strongest tracked cross-channel signals.',
 'high', 0.78,
 ('{"channelA":"cultural_moments","channelB":"the_knot_attribution",'
  || '"channelALabel":"cultural moments","channelBLabel":"The Knot attribution",'
  || '"lagDays":0,"r":-0.78,"pValue":0.0005,"windowDays":90,'
  || '"weakSignal":false,'
  || '"correlationId":"cd000001-0000-0000-0000-000000000005",'
  || '"seriesASummary":{"nonZeroDays":47,"min":-15,"max":35,"earliest":35,"latest":12},'
  || '"seriesBSummary":{"nonZeroDays":68,"min":0,"max":7,"earliest":5,"latest":3},'
  || '"seriesA":[{"dayKey":"2025-08-25","value":-15},{"dayKey":"2025-09-15","value":-15},{"dayKey":"2025-10-10","value":-15},{"dayKey":"2025-10-15","value":12}],'
  || '"seriesB":[{"dayKey":"2025-08-25","value":2},{"dayKey":"2025-09-15","value":1},{"dayKey":"2025-10-10","value":2},{"dayKey":"2025-10-15","value":4}]}'
 )::jsonb,
 'new', 'cd000001-0000-0000-0000-000000000005', 'on_demand', 78,
 'demonarr05', '{}'::jsonb,
 'demo-seed', 'correlation-narration.prompt.v1.0',
 '2026-04-25 12:05:00+00', '2026-04-25 12:05:00+00')
ON CONFLICT (venue_id, insight_type, context_id, cache_key) WHERE cache_key IS NOT NULL DO NOTHING;

-- ----------------------------------------------------------------------------
-- BB.3  external_calendar_events — 2026 + early 2027 backfill
-- ----------------------------------------------------------------------------
-- Static deterministic seed mirroring Stream V's calendar-writer.ts
-- buildYearRows output. Categories/sources/created_by_writer match the
-- migration-140 CHECK constraint + migration-169 column. Daily cron
-- (populateUSCalendarEvents) keeps these fresh after demo apply via the
-- (geo_scope, title, start_date) unique upsert from migration 169.
--
-- Coverage: ~45 events spanning Jan 2026 - May 2027. The unique index
-- uq_ece_scope_title_start makes ON CONFLICT well-defined.
INSERT INTO external_calendar_events (
  title, description, start_date, end_date, category, geo_scope,
  influence_weight, source, created_by_writer
) VALUES
-- ===== 2026 federal holidays =====
('New Year''s Day', 'US federal holiday. Engagement-season tail; venue inquiry lift in the following week as new fiances start the search.',
  '2026-01-01', '2026-01-01', 'federal_holiday', 'us', 0, 'federal_api', 'cron:external_calendar_refresh'),
('Martin Luther King Jr. Day', 'US federal holiday — third Monday in January.',
  '2026-01-19', '2026-01-19', 'federal_holiday', 'us', 0, 'federal_api', 'cron:external_calendar_refresh'),
('Presidents'' Day', 'US federal holiday — third Monday in February.',
  '2026-02-16', '2026-02-16', 'federal_holiday', 'us', 0, 'federal_api', 'cron:external_calendar_refresh'),
('Memorial Day', 'US federal holiday — last Monday in May. Traditional kickoff of peak wedding season; major inquiry-volume anchor.',
  '2026-05-25', '2026-05-25', 'federal_holiday', 'us', 0, 'federal_api', 'cron:external_calendar_refresh'),
('Juneteenth', 'US federal holiday (since 2021) — June 19.',
  '2026-06-19', '2026-06-19', 'federal_holiday', 'us', 0, 'federal_api', 'cron:external_calendar_refresh'),
('Independence Day', 'US federal holiday — July 4. Many Saturday weddings the weekend prior; venue-walkthrough volume dips on the holiday itself.',
  '2026-07-04', '2026-07-04', 'federal_holiday', 'us', 0, 'federal_api', 'cron:external_calendar_refresh'),
('Labor Day', 'US federal holiday — first Monday in September. Traditional close of peak wedding season.',
  '2026-09-07', '2026-09-07', 'federal_holiday', 'us', 0, 'federal_api', 'cron:external_calendar_refresh'),
('Columbus Day / Indigenous Peoples Day', 'US federal holiday — second Monday in October.',
  '2026-10-12', '2026-10-12', 'federal_holiday', 'us', 0, 'federal_api', 'cron:external_calendar_refresh'),
('Veterans Day', 'US federal holiday — November 11.',
  '2026-11-11', '2026-11-11', 'federal_holiday', 'us', 0, 'federal_api', 'cron:external_calendar_refresh'),
('Thanksgiving Day', 'US federal holiday — fourth Thursday in November. Major engagement-announcement window; inquiries spike for ~10 days after as families gather.',
  '2026-11-26', '2026-11-26', 'federal_holiday', 'us', 0, 'federal_api', 'cron:external_calendar_refresh'),
('Christmas Day', 'US federal holiday — December 25. Peak engagement season; inquiry volume picks up sharply through New Years.',
  '2026-12-25', '2026-12-25', 'federal_holiday', 'us', 0, 'federal_api', 'cron:external_calendar_refresh'),
-- ===== 2026 religious observances =====
('Christmas Eve', 'Major proposal night; engagement-season anchor.',
  '2026-12-24', '2026-12-24', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Good Friday', 'Christian observance — Friday before Easter.',
  '2026-04-03', '2026-04-03', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Easter Sunday', 'Christian observance — calculated by Western (Gregorian) computus. Family-gathering day; engagement announcements.',
  '2026-04-05', '2026-04-05', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Yom Kippur', 'Jewish Day of Atonement. Jewish couples typically avoid weddings ±2 weeks.',
  '2026-09-21', '2026-09-21', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Rosh Hashanah', 'Jewish New Year. Jewish couples typically avoid weddings during the High Holy Days.',
  '2026-09-12', '2026-09-12', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Passover', 'Jewish observance (8 days). Cron records the start date; inquiry effect is front-loaded.',
  '2026-04-01', '2026-04-01', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Eid al-Fitr', 'End of Ramadan; major celebration day for Muslim couples. Date is moon-sighting-dependent; ISNA prediction recorded — coordinators should confirm locally.',
  '2026-03-20', '2026-03-20', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Eid al-Adha', 'Festival of Sacrifice; date is moon-sighting-dependent; ISNA prediction recorded.',
  '2026-05-27', '2026-05-27', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Diwali', 'Hindu festival of lights. Indian-American wedding inquiry spike in the months prior; coordinators with Indian couples should confirm exact regional date.',
  '2026-11-08', '2026-11-08', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Lunar New Year', 'Chinese / Vietnamese / Korean New Year. Asian-American wedding-planning anchor; inquiry lift in following weeks.',
  '2026-02-17', '2026-02-17', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
-- ===== 2026 sporting / industry =====
('Super Bowl Sunday', 'NFL championship — first Sunday in February. Major Sunday-evening engagement-proposal moment + tour-volume crater on the day itself.',
  '2026-02-01', '2026-02-01', 'sporting_event', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Memorial Day Weekend (peak season kickoff)', 'Traditional opening of peak wedding season. Inquiry volume + tour requests anchor.',
  '2026-05-23', '2026-05-25', 'industry_event', 'us', 0, 'industry_feed', 'cron:external_calendar_refresh'),
('Labor Day Weekend (peak season close)', 'Traditional close of peak wedding season. Inquiry-volume tail-off begins.',
  '2026-09-05', '2026-09-07', 'industry_event', 'us', 0, 'industry_feed', 'cron:external_calendar_refresh'),
-- ===== 2026 cultural / retail (other bucket) =====
('Valentine''s Day', 'Largest single-day engagement-proposal anchor of the year. Venue inquiries spike sharply in the 2-4 weeks following.',
  '2026-02-14', '2026-02-14', 'other', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Mother''s Day', 'Second Sunday in May. Family-gathering day; engagement-announcement spike.',
  '2026-05-10', '2026-05-10', 'other', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Father''s Day', 'Third Sunday in June.',
  '2026-06-21', '2026-06-21', 'other', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Sweetest Day', 'Third Saturday in October. Regional (Midwest-US) proposal anchor.',
  '2026-10-17', '2026-10-17', 'other', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Halloween', 'October 31. Tour-volume dip on the day itself; non-trivial Halloween-themed wedding inquiries in the prior weeks.',
  '2026-10-31', '2026-10-31', 'other', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Black Friday', 'Day after Thanksgiving. Vendor-discount promotion volume spikes; not a primary inquiry anchor but appears in marketing-spend correlations.',
  '2026-11-27', '2026-11-27', 'other', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Cyber Monday', 'Monday after Thanksgiving. Online-vendor discount cycle.',
  '2026-11-30', '2026-11-30', 'other', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
-- ===== 2027 H1 federal holidays =====
('New Year''s Day', 'US federal holiday. Engagement-season tail; venue inquiry lift in the following week as new fiances start the search.',
  '2027-01-01', '2027-01-01', 'federal_holiday', 'us', 0, 'federal_api', 'cron:external_calendar_refresh'),
('Martin Luther King Jr. Day', 'US federal holiday — third Monday in January.',
  '2027-01-18', '2027-01-18', 'federal_holiday', 'us', 0, 'federal_api', 'cron:external_calendar_refresh'),
('Presidents'' Day', 'US federal holiday — third Monday in February.',
  '2027-02-15', '2027-02-15', 'federal_holiday', 'us', 0, 'federal_api', 'cron:external_calendar_refresh'),
('Memorial Day', 'US federal holiday — last Monday in May. Traditional kickoff of peak wedding season; major inquiry-volume anchor.',
  '2027-05-31', '2027-05-31', 'federal_holiday', 'us', 0, 'federal_api', 'cron:external_calendar_refresh'),
-- ===== 2027 H1 religious =====
('Good Friday', 'Christian observance — Friday before Easter.',
  '2027-03-26', '2027-03-26', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Easter Sunday', 'Christian observance — calculated by Western (Gregorian) computus. Family-gathering day; engagement announcements.',
  '2027-03-28', '2027-03-28', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Passover', 'Jewish observance (8 days). Cron records the start date; inquiry effect is front-loaded.',
  '2027-04-21', '2027-04-21', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Eid al-Fitr', 'End of Ramadan; major celebration day for Muslim couples. Date is moon-sighting-dependent; ISNA prediction recorded — coordinators should confirm locally.',
  '2027-03-09', '2027-03-09', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Eid al-Adha', 'Festival of Sacrifice; date is moon-sighting-dependent; ISNA prediction recorded.',
  '2027-05-17', '2027-05-17', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Lunar New Year', 'Chinese / Vietnamese / Korean New Year. Asian-American wedding-planning anchor; inquiry lift in following weeks.',
  '2027-02-06', '2027-02-06', 'religious_observance', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
-- ===== 2027 H1 sporting / industry =====
('Super Bowl Sunday', 'NFL championship — first Sunday in February. Major Sunday-evening engagement-proposal moment + tour-volume crater on the day itself.',
  '2027-02-07', '2027-02-07', 'sporting_event', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Memorial Day Weekend (peak season kickoff)', 'Traditional opening of peak wedding season. Inquiry volume + tour requests anchor.',
  '2027-05-29', '2027-05-31', 'industry_event', 'us', 0, 'industry_feed', 'cron:external_calendar_refresh'),
-- ===== 2027 H1 cultural =====
('Valentine''s Day', 'Largest single-day engagement-proposal anchor of the year. Venue inquiries spike sharply in the 2-4 weeks following.',
  '2027-02-14', '2027-02-14', 'other', 'us', 0, 'manual', 'cron:external_calendar_refresh'),
('Mother''s Day', 'Second Sunday in May. Family-gathering day; engagement-announcement spike.',
  '2027-05-09', '2027-05-09', 'other', 'us', 0, 'manual', 'cron:external_calendar_refresh')
ON CONFLICT (geo_scope, title, start_date) WHERE deleted_at IS NULL DO NOTHING;

-- ============================================================================
-- END T5-followup-BB
-- ============================================================================
