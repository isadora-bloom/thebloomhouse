-- 398: handles become a first-class identifier on the spine; first_seen_at
--
-- Wave 3 (NOVEMBER-PLAN.md, HANDLE-IDENTITY-SPEC.md). Until now a social
-- handle could not exist on the identity spine: the normalised signal had
-- no handle field, the cascade had no handle stage, and people.platform_
-- handles (migration 255) lived on the legacy table and was written only
-- by the old candidate resolver. Followers, story viewers and DM senders
-- were matched against people by trigram name similarity or "email local
-- part contains the handle", outside every guard the spine has.
--
-- This adds:
--   couples.handles       jsonb map {platform: handle}, normalised lower
--                         case, no @, no URL (normalizeHandle). Platform
--                         scoped: the same string on two platforms is two
--                         facts, not one.
--   couples.first_seen_at the earliest touchpoint on the couple, whatever
--                         it carried. A handle-only signal can set it.
--                         Point-Zero is unchanged: the first moment the
--                         couple is known by name AND a reachable address.
--                         first_seen_at <= point_zero_at always.
--   fragments.handles     same map on the pre-identity side, so a later
--                         signal carrying the handle can promote the
--                         fragment deterministically.
--
-- Schema-qualified on purpose: scripts/run-migration.ts drives public.exec_sql
-- with search_path = pg_catalog, public. Idempotent.

ALTER TABLE public.couples
  ADD COLUMN IF NOT EXISTS handles jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.couples
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz;

ALTER TABLE public.fragments
  ADD COLUMN IF NOT EXISTS handles jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.couples.handles IS
  'Platform handle map, e.g. {"instagram":"rosie.hoyle"}. Normalised by normalizeHandle(). Written only through linkSignal and merge_couples. Platform-scoped exact match is a high-tier cascade stage.';

COMMENT ON COLUMN public.couples.first_seen_at IS
  'Earliest touchpoint on this couple, any channel, any identity strength. Set once by the linker, moved earlier only by a replay that finds an older touchpoint. Always <= point_zero_at.';

COMMENT ON COLUMN public.fragments.handles IS
  'Handles a pre-identity fragment carries. A later signal with the same platform handle promotes the fragment onto the couple it landed on.';

-- Lookup: which couple owns this handle on this platform. GIN over the
-- whole map serves the containment query {"instagram":"x"} <@ handles.
CREATE INDEX IF NOT EXISTS idx_couples_handles_gin
  ON public.couples USING gin (handles jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_fragments_handles_gin
  ON public.fragments USING gin (handles jsonb_path_ops);

-- Backfill first_seen_at from the ribbon where it is known. Safe to rerun.
UPDATE public.couples c
SET first_seen_at = t.first_at
FROM (
  SELECT couple_id, MIN(occurred_at) AS first_at
  FROM public.touchpoints
  WHERE couple_id IS NOT NULL
  GROUP BY couple_id
) t
WHERE t.couple_id = c.id
  AND (c.first_seen_at IS NULL OR t.first_at < c.first_seen_at);
