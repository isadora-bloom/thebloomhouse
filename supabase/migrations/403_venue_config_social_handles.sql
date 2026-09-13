-- 403: the venue's own social handles live on venue_config
--
-- Wave 5, W36 (NOVEMBER-PLAN.md). Follow-up from wave 4: "a venue's own
-- social handle can stamp a couple if a prospect pastes the venue's link
-- above the quote line" (an email signature, a "follow us" line quoted
-- back, a screenshot that happens to catch the venue's own comment).
-- Nothing on the spine has ever recorded what the venue's own handles
-- ARE, so nothing could exclude them.
--
-- Shape matches couples.handles (migration 398): a jsonb map keyed by
-- HandlePlatform, normalised by normalizeHandle() before it is written.
-- `stripVenueHandles()` (src/lib/services/identity/handles.ts) reads this
-- column to drop the venue's own handle out of a signal derived from free
-- text before it ever reaches linkSignal.
--
-- platform_configs.venue_handle (migration 324) already holds the venue's
-- Instagram handle for the social-integration capture modal, and predates
-- this column. It is now the legacy source: venue_config.social_handles
-- is preferred everywhere, and getVenueSocialHandles() copies a legacy
-- platform_configs value across, once, the first time it finds
-- venue_config empty for that platform. platform_configs.venue_handle
-- itself is untouched — the capture modal still reads it directly and
-- this migration does not change that table.
--
-- Schema-qualified because scripts/run-migration.ts drives
-- public.exec_sql with search_path = pg_catalog, public. Idempotent, no
-- BEGIN/COMMIT (the exec_sql RPC rejects transaction blocks).

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS social_handles jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.venue_config.social_handles IS
  'The venue''s own handle map, e.g. {"instagram":"rixeymanor"}. Same shape as couples.handles: keys are HandlePlatform, values normalised by normalizeHandle(). Read by stripVenueHandles() so the venue''s own handle in a signature or a screenshot never stamps a couple. Legacy source: platform_configs.venue_handle (migration 324), copied across once by getVenueSocialHandles() when this column is empty for that platform. Written by Settings -> Venue Info -> Your social handles. Migration 403.';
