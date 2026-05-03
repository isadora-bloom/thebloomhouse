-- ---------------------------------------------------------------------------
-- 182_weddings_lead_source_attempted_at.sql  (T5-Rixey-OO bug #6)
-- ---------------------------------------------------------------------------
-- Adds `weddings.lead_source_derivation_attempted_at timestamptz` so the
-- lead-source derivation cron (Stream KK / src/lib/services/lead-source-
-- derivation.ts) can paginate past a never-resolvable no_signal backlog.
--
-- Why this exists
-- ---------------
-- Stream MM Rixey real-data load found:
--   `deriveLeadSourceForVenue` selected `WHERE lead_source IS NULL LIMIT
--   500`. Rows that derived to no_signal at priority 6 stayed NULL —
--   so the next cron call re-processed exactly the same 500 rows and
--   never advanced to the rest of the backlog. With 685 NULL leads at
--   Rixey post-load, this meant ~185 rows never even got a first
--   derivation attempt.
--
-- The fix
-- -------
-- We picked the column-stamp approach over a __no_signal__ sentinel:
--   * NULL keeps meaning "we don't know" in app reads (no special-case
--     coordinator UI handling, no risk of a sentinel leaking through
--     downstream).
--   * lead_source_derivation_attempted_at = "we tried at this time".
--   * The cron's SELECT excludes rows attempted within the last 30
--     days, so the backlog gets walked AND each row gets re-tried
--     weekly-ish as new signals (interactions, attribution events,
--     etc.) arrive in the meantime.
--   * Coordinator override (recordCoordinatorOverride) does NOT set
--     this column — it sets lead_source directly so the row exits the
--     candidate pool via the IS NULL filter.
--
-- Index supports the cron's compound filter:
--   WHERE merged_into_id IS NULL
--     AND lead_source IS NULL
--     AND (lead_source_derivation_attempted_at IS NULL
--          OR lead_source_derivation_attempted_at < now() - interval '30 days')
--   ORDER BY inquiry_date DESC NULLS LAST
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS lead_source_derivation_attempted_at timestamptz NULL;

COMMENT ON COLUMN public.weddings.lead_source_derivation_attempted_at IS
  'Last time the lead-source derivation cron ran the priority chain on '
  'this wedding (success OR no_signal). NULL = never attempted. The cron '
  '(src/lib/services/lead-source-derivation.ts deriveLeadSourceForVenue) '
  'excludes rows attempted within the last 30 days so the backlog '
  'paginates and each row re-tries weekly as new signals land. Set on '
  'every attempt, regardless of outcome. Coordinator overrides bypass '
  'the cron entirely and do not stamp this column.';

-- Compound index supporting the cron filter. Partial because the cron
-- only ever queries rows with lead_source IS NULL; non-NULL leads
-- never re-enter the candidate pool.
CREATE INDEX IF NOT EXISTS idx_weddings_lead_source_pending
  ON public.weddings (venue_id, lead_source_derivation_attempted_at NULLS FIRST, inquiry_date DESC NULLS LAST)
  WHERE lead_source IS NULL AND merged_into_id IS NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
