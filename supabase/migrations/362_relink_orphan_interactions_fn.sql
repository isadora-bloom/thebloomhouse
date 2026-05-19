-- ---------------------------------------------------------------------------
-- 362_relink_orphan_interactions_fn.sql
-- ---------------------------------------------------------------------------
-- General (multi-venue) fix for orphan email interactions — replaces the
-- one-shot migration 361.
--
-- Problem
-- -------
-- The live email pipeline links each inbound email to a wedding as it
-- arrives. A BULK import (post-wipe re-sync, or simply a venue whose
-- Gmail history is imported before its CRM weddings exist) bypasses
-- that per-email step, so a backlog of `interactions` lands with
-- `wedding_id` NULL. Most orphans are genuinely non-client (vendor /
-- platform / automated) and correctly stay unlinked; this recovers the
-- subset that IS client mail.
--
-- This migration ships the recovery as a reusable function so it can
-- run after EVERY bulk import (wired into persistAndEnqueueAfterAdapter
-- Commit), not as a one-time patch. It never mints a wedding — it only
-- attaches to weddings that already exist — so it cannot duplicate a
-- CRM import. Idempotent: guarded on `wedding_id IS NULL`.
--
-- Strategies (in order)
--   S2  person_id      -> that person's wedding
--   S3  from_email     -> a people.email already on a wedding
--                         (venue-own gmail_connections addresses excluded)
--   S1  gmail_thread_id -> a wedding any sibling email in the thread
--                          already carries; run last + twice so a
--                          thread anchored only by an S2/S3 link also
--                          propagates.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.relink_orphan_interactions(p_venue_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before integer;
  v_after  integer;
  v_pass   integer;
BEGIN
  SELECT count(*) INTO v_before
  FROM public.interactions
  WHERE venue_id = p_venue_id AND type = 'email' AND wedding_id IS NULL;

  -- S2: the interaction's resolved person is already on a wedding.
  UPDATE public.interactions o
  SET wedding_id = p.wedding_id
  FROM public.people p
  WHERE o.venue_id = p_venue_id
    AND o.wedding_id IS NULL
    AND o.type = 'email'
    AND o.person_id = p.id
    AND p.wedding_id IS NOT NULL;

  -- S3: the sender address matches a person already on a wedding.
  UPDATE public.interactions o
  SET wedding_id = pm.wedding_id
  FROM (
    SELECT DISTINCT ON (lower(email)) lower(email) AS em, wedding_id
    FROM public.people
    WHERE venue_id = p_venue_id
      AND wedding_id IS NOT NULL
      AND email IS NOT NULL
      AND btrim(email) <> ''
    ORDER BY lower(email), wedding_id
  ) pm
  WHERE o.venue_id = p_venue_id
    AND o.wedding_id IS NULL
    AND o.type = 'email'
    AND o.from_email IS NOT NULL
    AND lower(o.from_email) = pm.em
    AND NOT EXISTS (
      SELECT 1 FROM public.gmail_connections gc
      WHERE gc.venue_id = p_venue_id
        AND lower(gc.email_address) = lower(o.from_email)
    );

  -- S1 (x2): propagate a wedding link across a Gmail thread.
  FOR v_pass IN 1..2 LOOP
    UPDATE public.interactions o
    SET wedding_id = t.wedding_id
    FROM (
      SELECT DISTINCT ON (gmail_thread_id) gmail_thread_id, wedding_id
      FROM public.interactions
      WHERE venue_id = p_venue_id
        AND wedding_id IS NOT NULL
        AND gmail_thread_id IS NOT NULL
      ORDER BY gmail_thread_id, timestamp ASC
    ) t
    WHERE o.venue_id = p_venue_id
      AND o.wedding_id IS NULL
      AND o.type = 'email'
      AND o.gmail_thread_id IS NOT NULL
      AND o.gmail_thread_id = t.gmail_thread_id;
  END LOOP;

  SELECT count(*) INTO v_after
  FROM public.interactions
  WHERE venue_id = p_venue_id AND type = 'email' AND wedding_id IS NULL;

  RETURN jsonb_build_object(
    'orphans_before', v_before,
    'orphans_after',  v_after,
    'relinked',       v_before - v_after
  );
END;
$$;

COMMENT ON FUNCTION public.relink_orphan_interactions(uuid) IS
  'Re-links orphan email interactions (wedding_id NULL) to existing weddings '
  'via person_id, sender-email, and Gmail-thread propagation. Never mints a '
  'wedding. Idempotent. Called after every bulk import + once per venue below.';

REVOKE ALL ON FUNCTION public.relink_orphan_interactions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.relink_orphan_interactions(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.relink_orphan_interactions(uuid) TO service_role;

-- One-time drain of the existing backlog across every venue (this is
-- what migration 361 did inline; now it runs through the function).
DO $$
DECLARE v record;
BEGIN
  FOR v IN SELECT id FROM public.venues LOOP
    PERFORM public.relink_orphan_interactions(v.id);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
