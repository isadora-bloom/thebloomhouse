-- Migration 150: marketing_channels.activated_at — historical
-- effective-date for channel records (LIMB-16.3).
--
-- Backfill orchestrator can't tell whether a marketing channel was
-- 'always on' vs 'turned on 6 weeks ago' without an effective date.
-- That distinction matters for source-attribution: a wedding inquired
-- 8 months ago via 'instagram' shouldn't be attributed to that channel
-- if the venue only enabled the Instagram channel record 2 weeks ago
-- (it was previously rolled into 'social_other').
--
-- The column defaults to created_at so existing rows get the
-- conservative "always on since record creation" stamp. Coordinator
-- can adjust on the marketing-channels-config page when filling in
-- historical context.
--
-- Idempotent.

ALTER TABLE public.marketing_channels
  ADD COLUMN IF NOT EXISTS activated_at timestamptz;

-- Backfill: existing rows get activated_at = created_at (the
-- conservative "we don't actually know the historical activation
-- date but it's at least as old as the record"). Coordinators can
-- correct via the admin UI.
UPDATE public.marketing_channels
   SET activated_at = created_at
 WHERE activated_at IS NULL;

ALTER TABLE public.marketing_channels
  ALTER COLUMN activated_at SET NOT NULL,
  ALTER COLUMN activated_at SET DEFAULT now();

COMMENT ON COLUMN public.marketing_channels.activated_at IS
  'Effective date the channel went live for the venue. Coordinator-'
  'editable on /portal/marketing-channels-config so historical '
  'backfill can stamp "Instagram started 2024-Q3, podcast started '
  '2025-Q1" etc. Drives source-attribution windowing — pre-activation '
  'inquiries attributed to channel are flagged as suspect. Per LIMB-16.3.';
