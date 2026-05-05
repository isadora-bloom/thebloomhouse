-- ---------------------------------------------------------------------------
-- 213_brain_dump_indexes.sql
-- ---------------------------------------------------------------------------
-- Phase 6 brain-dump infrastructure gap.
--
-- 1. updated_at column on brain_dump_entries — needed by the nightly
--    prune_brain_dump_stale job (merged into prune_maintenance) to
--    stamp the transition time when a row is moved to 'abandoned'.
--    migration 078 omitted this column; migration 152 added it only
--    to brain_dump_pattern_grants.
--
-- 2. Graduation lookups: evaluateGraduation() filters on
--    (venue_id, pattern_signature). Migration 152 added
--    idx_brain_dump_entries_signature at (venue_id, pattern_signature,
--    parse_status). This two-column variant handles queries that don't
--    filter on parse_status and avoids the third-column overhead for
--    those scans.
--
-- 3. Stale-clarification cleanup: the prune_brain_dump_stale job
--    (merged into prune_maintenance) updates rows older than 30 days
--    in parse_status='needs_clarification'. This partial index lets
--    that scan stay cheap even at large table sizes.
-- ---------------------------------------------------------------------------

-- 0. Extend parse_status to include 'abandoned' — entries stuck in
--    needs_clarification for > 30 days are transitioned to this terminal
--    state by the prune_brain_dump_stale job. The existing CHECK constraint
--    (migration 078) only allows the original 5 values. Drop and recreate
--    it with 'abandoned' added.
ALTER TABLE public.brain_dump_entries
  DROP CONSTRAINT IF EXISTS brain_dump_entries_parse_status_check;

ALTER TABLE public.brain_dump_entries
  ADD CONSTRAINT brain_dump_entries_parse_status_check
  CHECK (parse_status IN (
    'pending',
    'parsed',
    'needs_clarification',
    'confirmed',
    'dismissed',
    'abandoned'
  ));

-- 1. updated_at column
ALTER TABLE public.brain_dump_entries
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.brain_dump_entries.updated_at IS
  'Last-modified timestamp. Updated by any service that writes to the row '
  '(parse_status transitions, routed_to writes, stale-clarification prune).';

-- 2. Index for graduation lookups (venue_id + pattern_signature)
CREATE INDEX IF NOT EXISTS brain_dump_entries_pattern_sig_idx
  ON brain_dump_entries(venue_id, pattern_signature)
  WHERE pattern_signature IS NOT NULL;

-- 3. Index for stale clarification cleanup (venue_id + parse_status + created_at)
CREATE INDEX IF NOT EXISTS brain_dump_entries_cleanup_idx
  ON brain_dump_entries(venue_id, parse_status, created_at)
  WHERE parse_status = 'needs_clarification';

NOTIFY pgrst, 'reload schema';
