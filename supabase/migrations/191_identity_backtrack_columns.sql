-- ---------------------------------------------------------------------------
-- 191_identity_backtrack_columns.sql
-- ---------------------------------------------------------------------------
-- Stream T5-Rixey-CCC (2026-05-02). Candidate-resolver backtrack —
-- retroactively scan unresolved storefront candidate_identities when a
-- new wedding becomes known-email so the orphaned signals (1,704 / 1,951
-- on Rixey per BBB spike) can pick up an attribution link.
--
-- One column per table:
--
-- 1. candidate_identities.backtrack_attempted_at — nullable timestamp.
--    Stamped by runBacktrackForVenue / runBacktrackForWedding after every
--    scan attempt (auto-link, queue-for-review, low-skip, no-match). The
--    daily cron sweep uses this to paginate past recently-evaluated
--    candidates so a never-resolvable cluster doesn't burn cycles every
--    night. Mirrors the lead_source_derivation_attempted_at pattern from
--    migration 182.
--
-- 2. tangential_signals.backtrack_attempted_at — same shape, applied at
--    the signal level for parity with the existing pipeline writes. Not
--    strictly required by the service today (the service stamps the
--    parent candidate, not the child signals), but exposed for future
--    parity should we ever switch the grain. Cheap to add now while we
--    own this migration slot.
--
-- Indexes: partial on (venue_id, backtrack_attempted_at NULLS FIRST) so
-- the daily cron's "WHERE backtrack_attempted_at IS NULL OR < cutoff"
-- query scans the unsweept-first frontier first. Filtered to unresolved
-- candidates only — resolved candidates never need backtrack.
-- ---------------------------------------------------------------------------

ALTER TABLE public.candidate_identities
  ADD COLUMN IF NOT EXISTS backtrack_attempted_at timestamptz;

COMMENT ON COLUMN public.candidate_identities.backtrack_attempted_at IS
  'T5-Rixey-CCC (2026-05-02). Stamped by identity-backtrack service after every scan attempt against this candidate. Daily cron uses this to skip recently-evaluated candidates. NULL = never evaluated by backtrack.';

CREATE INDEX IF NOT EXISTS idx_candidate_identities_backtrack_unresolved
  ON public.candidate_identities (venue_id, backtrack_attempted_at NULLS FIRST)
  WHERE resolved_wedding_id IS NULL AND deleted_at IS NULL;

ALTER TABLE public.tangential_signals
  ADD COLUMN IF NOT EXISTS backtrack_attempted_at timestamptz;

COMMENT ON COLUMN public.tangential_signals.backtrack_attempted_at IS
  'T5-Rixey-CCC (2026-05-02). Reserved for parity with candidate_identities. The current backtrack service stamps the parent candidate, not signals; this column is pre-provisioned in case the grain changes.';

NOTIFY pgrst, 'reload schema';
