-- Migration 087: add venue_config.lost_auto_mark_days so each venue can
-- configure when a silent inquiry rolls to status='lost'. Default 30 days
-- matches the prior hardcoded threshold.
--
-- heat-mapping.applyDailyDecay now owns cooling warnings (14/21/27 days)
-- and auto-mark-lost in a single pass, so there's one cron and no drift
-- risk between two separate services each reading different timestamps.

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS lost_auto_mark_days integer DEFAULT 30;

COMMENT ON COLUMN public.venue_config.lost_auto_mark_days IS
  'Days of inbound silence before an inquiry auto-rolls to status=lost. Default 30. Coordinator can raise to 45 for long-consideration venues or 0 to disable auto-lost entirely. Graduated warnings fire at 14/21/27 days regardless.';

NOTIFY pgrst, 'reload schema';
