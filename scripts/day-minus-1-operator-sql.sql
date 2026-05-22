-- ============================================================================
-- DAY -1 OPERATOR SQL — Bloom Consolidation Plan
-- ============================================================================
-- Run in the Supabase SQL editor against the Bloom project
-- (https://supabase.com/dashboard/project/jsxxgwprxuqgcauzlxcb).
--
-- Venue ID for Rixey is BAKED IN BELOW — no manual substitution needed.
-- Just paste the whole file and click Run, or run each block separately.
--
-- Source: CONSOLIDATION-PLAN-25-DAY-ANCHORED.md § C
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Q1.  [ALREADY ANSWERED 2026-05-21]
--   Result: complete, cursor=65, phase=booked, 8183 emails ingested,
--           last updated 2026-05-16. Venue ID = f3d10226-4c5c-47ad-b89b-98ad63842492.
--   No need to re-run unless the row may have changed.
-- ----------------------------------------------------------------------------

SELECT
  id,
  name,
  slug,
  gmail_backfill_status,
  gmail_backfill_phase,
  gmail_backfill_cursor,
  gmail_backfill_emails,
  gmail_backfill_updated_at
FROM venues
WHERE slug = 'rixey-manor';


-- ----------------------------------------------------------------------------
-- Q2.  Of the 63 Untracked bookings, how many have ANY interactions?
-- ----------------------------------------------------------------------------
-- Tells us where the failure sits:
--   most have ZERO interactions    → backfill still missed them somehow
--                                     (binding never connected the emails)
--   most have SEVERAL interactions → backfill worked; backtrace / source
--                                     attribution is the broken link

SELECT
  w.id,
  w.source,
  w.inquiry_date,
  w.booked_at,
  count(i.id) AS interaction_count
FROM weddings w
LEFT JOIN interactions i ON i.wedding_id = w.id
WHERE w.venue_id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  AND w.status = 'booked'
  AND (w.source IS NULL OR w.source IN ('honeybook','untracked'))
  AND w.merged_into_id IS NULL
GROUP BY w.id, w.source, w.inquiry_date, w.booked_at
ORDER BY interaction_count DESC;


-- ----------------------------------------------------------------------------
-- Q2 summary — counts only (if Q2 returns hundreds of rows, run this instead):
-- ----------------------------------------------------------------------------

SELECT
  CASE
    WHEN count(i.id) = 0       THEN '0 interactions (binding gap)'
    WHEN count(i.id) BETWEEN 1 AND 4   THEN '1-4 interactions'
    WHEN count(i.id) BETWEEN 5 AND 20  THEN '5-20 interactions'
    ELSE                                    '21+ interactions'
  END AS bucket,
  count(DISTINCT w.id) AS booked_count
FROM weddings w
LEFT JOIN interactions i ON i.wedding_id = w.id
WHERE w.venue_id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  AND w.status = 'booked'
  AND (w.source IS NULL OR w.source IN ('honeybook','untracked'))
  AND w.merged_into_id IS NULL
GROUP BY 1
ORDER BY 1;


-- ----------------------------------------------------------------------------
-- Q3.  Scope of the Liam-Hunt-shaped duplicate-partner2 bug
-- ----------------------------------------------------------------------------
-- Booked weddings with MORE THAN 2 active people rows = candidate for the
-- duplicate-partner2 failure shape diagnosed in bloom-may21-session Part 3.
--
--   <5  affected → fix during writer migration Days 7-9 (no special pass)
--   5-50         → one-shot maintenance script after Day 13
--   >50          → dedicated Day 13.5 reconcile pass before reimport

SELECT
  w.id              AS wedding_id,
  w.status,
  count(p.id)       AS people_count,
  array_agg(
    p.first_name || ' ' || COALESCE(p.last_name,'(null)')
    ORDER BY p.created_at
  )                 AS names,
  array_agg(p.email ORDER BY p.created_at) AS emails
FROM weddings w
JOIN people p ON p.wedding_id = w.id
WHERE w.venue_id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  AND w.status = 'booked'
  AND p.merged_into_id IS NULL
GROUP BY w.id, w.status
HAVING count(p.id) > 2
ORDER BY count(p.id) DESC;


-- ----------------------------------------------------------------------------
-- Q3 summary — total count of affected weddings:
-- ----------------------------------------------------------------------------

SELECT count(*) AS weddings_with_more_than_2_people
FROM (
  SELECT w.id
  FROM weddings w
  JOIN people p ON p.wedding_id = w.id
  WHERE w.venue_id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
    AND w.status = 'booked'
    AND p.merged_into_id IS NULL
  GROUP BY w.id
  HAVING count(p.id) > 2
) t;


-- ----------------------------------------------------------------------------
-- Bonus — shape diagnostic. Only run if Q3 returns rows.
-- Identifies which pipeline.ts insert site (line 2211 / 2907 / 3062)
-- likely produced each duplicate, by looking at email + last_name presence.
-- ----------------------------------------------------------------------------

SELECT
  w.id AS wedding_id,
  p.id AS person_id,
  p.first_name,
  p.last_name,
  p.email,
  p.created_at,
  p.role,
  CASE
    WHEN p.email IS NOT NULL AND p.last_name IS NOT NULL THEN 'has_email_and_lastname (likely real)'
    WHEN p.email IS NOT NULL AND p.last_name IS NULL     THEN 'has_email_no_lastname (Calendly extras path — pipeline.ts:3062)'
    WHEN p.email IS NULL     AND p.last_name IS NULL     THEN 'no_email_no_lastname (body-extraction path — pipeline.ts:2211)'
    ELSE 'other'
  END AS shape_guess
FROM weddings w
JOIN people p ON p.wedding_id = w.id
WHERE w.venue_id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  AND w.status = 'booked'
  AND p.merged_into_id IS NULL
  AND w.id IN (
    SELECT w.id
    FROM weddings w
    JOIN people p ON p.wedding_id = w.id
    WHERE w.venue_id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
      AND w.status = 'booked'
      AND p.merged_into_id IS NULL
    GROUP BY w.id
    HAVING count(p.id) > 2
  )
ORDER BY w.id, p.created_at;
