-- ---------------------------------------------------------------------------
-- 104_tangential_signals_platform_cols.sql
-- ---------------------------------------------------------------------------
-- Phase A of the platform-signals build (2026-04-28). Extends
-- tangential_signals with two columns the new universal importer
-- needs:
--
--   * source_platform — canonical platform key (the_knot,
--     wedding_wire, instagram, pinterest, google_business, facebook,
--     website, calendly, acuity, honeybook, dubsado, referral,
--     other). Required for per-platform ROI rollups in Phase D and
--     for filtering at match time so a Knot signal doesn't try to
--     match an Instagram username column.
--
--   * action_class — what the user did on that platform:
--     'view' | 'save' | 'message' | 'follow' | 'like' | 'comment'
--     | 'mention' | 'review' | 'click' | 'visit' | 'inquiry' |
--     'unmark' | 'call' | 'other'. Different actions carry
--     different conversion weight (a 'message' is a much stronger
--     signal than a 'view') — Phase B's matcher uses this for tier
--     thresholds. Free text rather than CHECK so new platforms can
--     introduce action types without a schema change every time.
--
-- The existing signal_type column with its tight CHECK enum stays
-- around for backward compat and migration-period queries. New
-- writes set both source_platform + action_class; signal_type gets
-- a derived value when it can.
--
-- Index supports the per-platform ROI rollup at /intel/sources and
-- the time-window scan in the new bidirectional matcher.
-- ---------------------------------------------------------------------------

ALTER TABLE public.tangential_signals
  ADD COLUMN IF NOT EXISTS source_platform text;

ALTER TABLE public.tangential_signals
  ADD COLUMN IF NOT EXISTS action_class text;

CREATE INDEX IF NOT EXISTS idx_tangential_signals_platform_date
  ON public.tangential_signals (venue_id, source_platform, signal_date DESC NULLS LAST)
  WHERE source_platform IS NOT NULL;

-- Index for name-based cross-match (Phase B). Search "Sarah P." against
-- existing signals fuzzy on extracted_identity.first_name. We keep this
-- on a generated expression so it indexes the parsed first_name from
-- the jsonb without a stored column.
CREATE INDEX IF NOT EXISTS idx_tangential_signals_first_name
  ON public.tangential_signals (venue_id, ((extracted_identity->>'first_name')))
  WHERE extracted_identity ? 'first_name';

NOTIFY pgrst, 'reload schema';
