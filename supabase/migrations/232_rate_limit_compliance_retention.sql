-- ============================================================================
-- 232_rate_limit_compliance_retention.sql
-- Round 9 audit follow-up (2026-05-08). Tier-C #129/#130/#132 ship-along.
--
-- Bug:
--   prune_rate_limit_buckets() (mig 208) deletes any row whose updated_at <
--   now() - 7 days. The compliance:erase:user:* (90-day window) and
--   compliance:export:* (30-day window) buckets get pruned at day 8, so a
--   user could re-issue an erasure request 8 days later instead of 90.
--
-- Fix:
--   Carve out the `compliance:` key prefix and retain those rows for 91
--   days. Every other bucket continues at the 7-day default. The active
--   non-compliance limiters all have windowSec <= 1h, so 7 days is still
--   a comfortable safety margin for them.
--
-- Idempotent: CREATE OR REPLACE FUNCTION.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.prune_rate_limit_buckets()
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_deleted integer;
  v_compliance_deleted integer;
BEGIN
  -- Standard buckets: 7-day retention.
  DELETE FROM public.rate_limit_buckets
   WHERE updated_at < now() - interval '7 days'
     AND key NOT LIKE 'compliance:%';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- Compliance buckets: 91-day retention so the 30/90-day windows enforced
  -- by the application code are not silently defeated. 91 vs 90 leaves a
  -- one-day buffer against same-day prune-then-request races.
  DELETE FROM public.rate_limit_buckets
   WHERE updated_at < now() - interval '91 days'
     AND key LIKE 'compliance:%';
  GET DIAGNOSTICS v_compliance_deleted = ROW_COUNT;

  RETURN v_deleted + v_compliance_deleted;
END;
$$;

COMMENT ON FUNCTION public.prune_rate_limit_buckets() IS
  'Daily sweep, called by /api/cron?job=prune_rate_limits at 02:30 UTC. '
  'Drops rate_limit_buckets rows whose updated_at < now() - 7 days, except '
  'compliance:* keys which are retained for 91 days so 30/90-day '
  'compliance request limits are not silently defeated. Round 9 fix.';
