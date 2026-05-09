-- Migration 248: brain_dump_pattern_grants.is_active flag.
--
-- Pre-fix: the only marker for "this grant is currently active" was
-- `revoked_at IS NULL`. Code paths in graduation.ts encoded that filter
-- everywhere (consumeGrantIfActive, evaluateGraduation, listing endpoints).
-- This works but couples "deleted from auditing" semantics with the
-- active-rule semantic — there's no way to *pause* a grant without
-- losing the audit trail of when it was granted, who used it, etc.
--
-- This migration adds is_active boolean (default true). Revoke now
-- flips is_active=false AND stamps revoked_at + revoked_by. Listing
-- endpoints filter on is_active. Audit queries (history of all
-- grants ever) read everything regardless.
--
-- A trigger keeps the two in sync: setting revoked_at also forces
-- is_active=false. This way old code paths that set revoked_at
-- continue to work without surprise. Setting is_active=false on its
-- own is a soft-pause (no revoked_at), reserved for future "pause
-- this rule for 30 days" UX without losing the lineage.
--
-- Idempotent.

ALTER TABLE public.brain_dump_pattern_grants
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- Backfill: any row already revoked at migration time flips is_active=false.
UPDATE public.brain_dump_pattern_grants
   SET is_active = false
 WHERE revoked_at IS NOT NULL
   AND is_active = true;

COMMENT ON COLUMN public.brain_dump_pattern_grants.is_active IS
  'True when this grant currently auto-routes matching brain-dump entries. '
  'Flipped to false when a coordinator revokes (also stamps revoked_at) or '
  'soft-pauses (no revoked_at). Listing endpoints filter on is_active; '
  'audit queries read everything. Per migration 248.';

-- Trigger: setting revoked_at also forces is_active=false. Keeps
-- the legacy revoke-via-revoked_at path consistent without code
-- audit. Coordinator-driven revoke via the API will set both
-- explicitly; this is a belt-and-suspenders guard.
CREATE OR REPLACE FUNCTION public.brain_dump_pattern_grants_sync_active()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL AND NEW.is_active = true THEN
    NEW.is_active := false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_brain_dump_pattern_grants_sync_active
  ON public.brain_dump_pattern_grants;
CREATE TRIGGER trg_brain_dump_pattern_grants_sync_active
  BEFORE INSERT OR UPDATE ON public.brain_dump_pattern_grants
  FOR EACH ROW
  EXECUTE FUNCTION public.brain_dump_pattern_grants_sync_active();

-- Refresh the active-grants index to filter on is_active. The unique
-- constraint stays keyed on revoked_at IS NULL (legacy callers may
-- still set only revoked_at on insert paths; trigger keeps things
-- consistent), but the lookup index becomes is_active so future
-- queries can skip the soft-paused rows efficiently.
DROP INDEX IF EXISTS idx_brain_dump_grants_venue_active;
CREATE INDEX IF NOT EXISTS idx_brain_dump_grants_venue_active
  ON public.brain_dump_pattern_grants (venue_id, pattern_signature)
  WHERE is_active = true;
