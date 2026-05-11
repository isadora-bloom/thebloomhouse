-- ===========================================================================
-- CLEANUP-SMS-DIRECTION.sql  (one-shot data fix, 2026-05-11)
-- ===========================================================================
-- Pre-fix: Quo (OpenPhone) returns direction='outgoing' for outbound SMS,
-- but the Bloom ingestor only recognised 'outbound'|'sent'. Every outbound
-- SMS got tagged direction='inbound'. The venue's own phone became the
-- externalNumber, the identity resolver minted synthetic wedding rows for
-- "couples with phone = venue line", and 17 outbound messages all
-- collapsed under one fake wedding.
--
-- Going forward (committed 2026-05-11): the code now recognises
-- 'incoming' / 'outgoing' so new syncs land correctly. This SQL repairs
-- the historical residue. Safe to re-run — every step filters to the
-- specific symptoms; once clean the WHERE clauses match nothing.
--
-- Steps:
--   1. Build a list of venue-owned OpenPhone numbers from
--      openphone_connections.phone_numbers (jsonb array).
--   2. For each SMS interaction whose from_email matches one of those
--      numbers AND direction='inbound', flip direction to 'outbound'
--      and clear wedding_id + person_id (they were linked to a fake
--      wedding; operator can re-attach if needed).
--   3. Delete weddings whose only linked person has phone = a venue
--      number (these were minted by the resolver for the venue itself).
-- ===========================================================================

-- Step 1+2 in one shot: build the inline set of venue phones and flip
-- the bad-direction rows.
WITH venue_phones AS (
  SELECT
    c.venue_id,
    lower(regexp_replace(p->>'phoneNumber', '\D', '', 'g')) AS digits10
  FROM openphone_connections c
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.phone_numbers, '[]'::jsonb)) AS p
  WHERE c.is_active = true
    AND (p->>'phoneNumber') IS NOT NULL
),
matching_interactions AS (
  SELECT i.id, i.venue_id, i.wedding_id, i.person_id
  FROM interactions i
  JOIN venue_phones vp
    ON vp.venue_id = i.venue_id
   AND right(regexp_replace(coalesce(i.from_email, ''), '\D', '', 'g'), 10) = right(vp.digits10, 10)
  WHERE i.type = 'sms'
    AND i.direction = 'inbound'
    AND i.from_email IS NOT NULL
)
UPDATE interactions i
SET
  direction = 'outbound',
  author_class = 'operator',
  -- Clear the bad linkage. The recipient's real phone is in to_email
  -- when the new ingestor writes the row; legacy mis-direction rows
  -- don't have it captured cleanly, so we leave the SMS unmatched
  -- and the operator decides.
  wedding_id = NULL,
  person_id = NULL
FROM matching_interactions mi
WHERE i.id = mi.id;

-- Step 3: delete the synthetic weddings whose only person carries the
-- venue's own phone. These are leftover from the same bug — the
-- resolver minted them when it thought the venue's number was a couple.
-- Idempotent: only deletes weddings where EVERY person has the venue
-- phone, so a real couple who happens to share a number doesn't get
-- swept up.
WITH venue_phones AS (
  SELECT
    c.venue_id,
    right(regexp_replace(p->>'phoneNumber', '\D', '', 'g'), 10) AS digits10
  FROM openphone_connections c
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.phone_numbers, '[]'::jsonb)) AS p
  WHERE c.is_active = true
    AND (p->>'phoneNumber') IS NOT NULL
),
people_on_venue_phones AS (
  SELECT pe.id, pe.wedding_id, pe.venue_id
  FROM people pe
  JOIN venue_phones vp
    ON vp.venue_id = pe.venue_id
   AND right(regexp_replace(coalesce(pe.phone, ''), '\D', '', 'g'), 10) = vp.digits10
  WHERE pe.phone IS NOT NULL
),
weddings_to_delete AS (
  SELECT w.id
  FROM weddings w
  JOIN people_on_venue_phones pvp ON pvp.wedding_id = w.id
  WHERE w.id IN (
    -- Only delete weddings where ALL linked people are on a venue
    -- phone (so a real couple plus a venue-stamped record we missed
    -- doesn't get wiped).
    SELECT wedding_id FROM people_on_venue_phones
  )
  GROUP BY w.id
  HAVING COUNT(*) = (
    SELECT COUNT(*) FROM people p2
    WHERE p2.wedding_id = w.id
  )
)
DELETE FROM weddings WHERE id IN (SELECT id FROM weddings_to_delete);

-- Summary notice.
DO $$
DECLARE
  flipped_count integer;
BEGIN
  -- We can't easily count what we just did inside the same statement,
  -- so just emit a generic notice. Operators see real counts in
  -- /agent/audio-inbox after re-loading.
  RAISE NOTICE 'SMS direction cleanup complete. Re-load /agent/audio-inbox to verify outbound messages now appear as Unmatched (operator can attach manually).';
END $$;

NOTIFY pgrst, 'reload schema';
