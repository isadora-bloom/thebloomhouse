-- ---------------------------------------------------------------------------
-- 107_journey_narrative_lock.sql
-- ---------------------------------------------------------------------------
-- Phase C / PC.4 fix #5 (2026-04-29). Adds generating_at to
-- wedding_journey_narratives so two concurrent /intel/clients/[id]
-- views on the same wedding don't both call Claude and double-charge.
--
-- Lock contract:
--   * Service sets generating_at = now() before invoking the AI
--   * Concurrent caller sees generating_at recent (< 60s) and waits
--     instead of starting its own gen
--   * Stale lock (generating_at > 60s) is ignored — assumed crashed
--     gen, next caller takes over
--
-- We use a column + 60-second TTL rather than Postgres advisory locks
-- because the gen call crosses an HTTP boundary; advisory locks are
-- session-scoped and don't survive request boundaries cleanly.
-- ---------------------------------------------------------------------------

ALTER TABLE public.wedding_journey_narratives
  ADD COLUMN IF NOT EXISTS generating_at timestamptz;

COMMENT ON COLUMN public.wedding_journey_narratives.generating_at IS
  'Phase C / PC.4. Set to now() when an AI gen starts; cleared (or replaced) on success. Stale values (> 60s old) are ignored. Prevents two concurrent /intel/clients/[id] views from both invoking Claude and double-charging.';

NOTIFY pgrst, 'reload schema';
