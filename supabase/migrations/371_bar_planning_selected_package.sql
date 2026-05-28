-- ============================================================================
-- 371: BAR_PLANNING (selected_package_id)
--
-- R2#6 feedback (2026-03-31). Some venues run pre-approved bar packages
-- and don't want couples touching the calculator. Others want the full
-- planning experience. The mode itself is already on
-- venue_config.feature_flags.bar_config.bar_mode ('calculator' |
-- 'package' | 'hybrid'). What was missing: when the venue picks
-- 'package' mode, the couple needs somewhere to persist their choice.
--
-- selected_package_id is a free-text key matching BarPackage.id in the
-- venue's feature_flags.bar_config.packages array. We keep it text
-- rather than an FK because:
--   1. Packages live inside a JSONB feature flag, not their own table,
--      so there's no PK to reference.
--   2. Venues will rename / reorder / replace packages over time. A
--      stale id keeps the audit trail rather than breaking foreign-key
--      integrity.
--
-- Null = no selection (still under decision OR venue isn't in package
-- mode).
-- ============================================================================

ALTER TABLE public.bar_planning
  ADD COLUMN IF NOT EXISTS selected_package_id text;

COMMENT ON COLUMN public.bar_planning.selected_package_id IS
  'When the venue runs in bar_mode=package, this is the BarPackage.id the couple chose from venue_config.feature_flags.bar_config.packages. Free text; not an FK because packages live in a JSONB flag. Null = no selection yet.';

NOTIFY pgrst, 'reload schema';
