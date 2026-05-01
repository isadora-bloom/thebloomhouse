-- Migration 135: consultant_metrics.visibility_config (T2-B Phase 2 / LIMB-16.2.6)
--
-- Per Playbook LIMB-16.2.6: consultant performance metrics
-- (response-time, conversion rate, etc.) are sensitive — they touch
-- compensation, performance reviews, and team dynamics. Defaulting
-- them to org-wide visibility was a privacy violation flagged in
-- the April 2026 audit. T1 / Item 9 closed the most surface
-- (deleted /intel/team-compare, the worst offender). This migration
-- finishes the data-side fix.
--
-- Adds a visibility_config jsonb column to consultant_metrics so
-- per-org visibility rules can be tuned without a code deploy:
--   {
--     "visible_to_org": false,           -- default off (privacy)
--     "visible_to_consultant": true,     -- consultant always sees their own
--     "anonymise_in_aggregate": true,    -- "fastest responder this month"
--                                        -- types of insights anonymise the
--                                        -- person; org sees the metric, not
--                                        -- who hit it
--     "comparable_baseline": "self_30d"  -- 'self_30d' / 'org_p50' /
--                                        -- 'org_anonymised' / 'none'
--   }
--
-- Code defaults live in src/lib/services/consultant-metrics.ts;
-- venues that want to opt their org-wide rules in update this
-- jsonb. Per-consultant overrides could land later via a separate
-- consultant_metric_preferences table.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE public.consultant_metrics
  ADD COLUMN IF NOT EXISTS visibility_config jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.consultant_metrics.visibility_config IS
  'Per-row visibility tuning per Playbook LIMB-16.2.6. Shape: '
  '{visible_to_org, visible_to_consultant, anonymise_in_aggregate, '
  'comparable_baseline}. Defaults live in code (consultant-metrics.ts) '
  'and lean private — org-wide visibility off, consultant always sees '
  'their own, aggregates anonymise the person.';
