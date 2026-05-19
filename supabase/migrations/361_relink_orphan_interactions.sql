-- ---------------------------------------------------------------------------
-- 361_relink_orphan_interactions.sql
-- ---------------------------------------------------------------------------
-- Tier 8 gate repair (2026-05-18). Re-link orphan email interactions to
-- the weddings they belong to.
--
-- Background
-- ----------
-- After the 2026-05-14 Rixey wipe + bulk Gmail re-sync, 3,653 of 4,754
-- email `interactions` rows have `wedding_id` NULL. The live pipeline
-- links each email to a wedding as it arrives; a bulk historical
-- re-sync bypasses that step, so the backlog landed unlinked.
--
-- Investigation (2026-05-18) found most orphans are genuinely NOT client
-- mail — vendor threads, platform notifications (Zola/Knot/WeddingWire),
-- Google automated mail, the venue's own outbound, Bloom digest emails.
-- Those correctly stay orphan and become Fragments (aggregate noise).
-- This migration recovers only the subset that IS client mail, by three
-- structural strategies — and NEVER mints a wedding. It attaches solely
-- to weddings that already exist, so it cannot duplicate the HoneyBook
-- import.
--
-- Idempotent: every UPDATE is guarded by `wedding_id IS NULL`, so a
-- re-run touches nothing already linked. Runs across all venues; demo
-- venues have no interactions and no-op.
--
-- Strategies
-- ----------
--   S2  person_id      -> that person's wedding
--   S3  from_email     -> a people.email already on a wedding
--   S1  gmail_thread_id -> a wedding any sibling email in the same
--       thread already carries. Run last and twice, so a thread
--       anchored only by a link S2/S3 just created also propagates.
-- ---------------------------------------------------------------------------

-- S2: the interaction's resolved person is already attached to a wedding.
UPDATE public.interactions o
SET wedding_id = p.wedding_id
FROM public.people p
WHERE o.wedding_id IS NULL
  AND o.type = 'email'
  AND o.person_id = p.id
  AND p.wedding_id IS NOT NULL;

-- S3: the sender address matches a person already on a wedding.
-- Venue-own addresses (gmail_connections) are excluded — the venue
-- talking is not a client signal.
UPDATE public.interactions o
SET wedding_id = pm.wedding_id
FROM (
  SELECT DISTINCT ON (venue_id, lower(email))
         venue_id, lower(email) AS em, wedding_id
  FROM public.people
  WHERE wedding_id IS NOT NULL
    AND email IS NOT NULL
    AND btrim(email) <> ''
  ORDER BY venue_id, lower(email), wedding_id
) pm
WHERE o.wedding_id IS NULL
  AND o.type = 'email'
  AND o.from_email IS NOT NULL
  AND o.venue_id = pm.venue_id
  AND lower(o.from_email) = pm.em
  AND NOT EXISTS (
    SELECT 1 FROM public.gmail_connections gc
    WHERE gc.venue_id = o.venue_id
      AND lower(gc.email_address) = lower(o.from_email)
  );

-- S1 (x2): propagate a wedding link across a Gmail thread. Two passes —
-- the second catches threads anchored only by an S2/S3 link from above.
DO $$
DECLARE pass int;
BEGIN
  FOR pass IN 1..2 LOOP
    UPDATE public.interactions o
    SET wedding_id = t.wedding_id
    FROM (
      SELECT DISTINCT ON (venue_id, gmail_thread_id)
             venue_id, gmail_thread_id, wedding_id
      FROM public.interactions
      WHERE wedding_id IS NOT NULL
        AND gmail_thread_id IS NOT NULL
      ORDER BY venue_id, gmail_thread_id, timestamp ASC
    ) t
    WHERE o.wedding_id IS NULL
      AND o.type = 'email'
      AND o.gmail_thread_id IS NOT NULL
      AND o.venue_id = t.venue_id
      AND o.gmail_thread_id = t.gmail_thread_id;
  END LOOP;
END $$;

-- Report: linked vs still-orphan email interactions after the re-link.
SELECT
  count(*) FILTER (WHERE wedding_id IS NOT NULL) AS linked,
  count(*) FILTER (WHERE wedding_id IS NULL)     AS still_orphan,
  count(*)                                       AS total_email
FROM public.interactions
WHERE type = 'email';
