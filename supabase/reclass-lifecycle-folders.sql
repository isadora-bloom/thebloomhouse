-- ---------------------------------------------------------------------------
-- reclass-lifecycle-folders.sql
-- ---------------------------------------------------------------------------
-- Re-runs the lifecycle backfill from migration 242 with the corrected
-- new_inquiry rule. The original rule required outbound_count = 0, which
-- meant the moment Sage fired a nurture reply the thread fell into
-- 'other'. The corrected rule keys off inbound_count alone (couple has
-- not replied) so Sage-replied inquiries stay in 'new_inquiry' until
-- the couple actually engages.
--
-- Safe to re-run. Resets lifecycle_folder on every interactions row in
-- the venue and rebuilds it from current data.
--
-- Apply:
--   1. Open https://supabase.com/dashboard/project/jsxxgwprxuqgcauzlxcb/sql/new
--   2. Paste this whole file
--   3. Run
-- ---------------------------------------------------------------------------

BEGIN;

-- Step 1: clear so the priority chain re-evaluates every row.
UPDATE public.interactions
SET lifecycle_folder = NULL
WHERE lifecycle_folder IS NOT NULL;

-- Step 2: rebuild via the corrected priority chain.
WITH thread_counts AS (
  SELECT
    venue_id,
    gmail_thread_id,
    SUM(CASE WHEN direction = 'inbound'  THEN 1 ELSE 0 END) AS inbound_count,
    SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound_count
  FROM public.interactions
  WHERE gmail_thread_id IS NOT NULL
  GROUP BY venue_id, gmail_thread_id
),
tour_threads AS (
  SELECT DISTINCT i.venue_id, i.gmail_thread_id
  FROM public.interactions i
  JOIN public.engagement_events ee
    ON ee.wedding_id = i.wedding_id
   AND ee.venue_id = i.venue_id
  WHERE i.gmail_thread_id IS NOT NULL
    AND ee.event_type IN ('tour_requested', 'tour_scheduled', 'tour_completed')
)
UPDATE public.interactions AS itx
SET lifecycle_folder = CASE
  -- 1) advertiser
  WHEN itx.wedding_id IS NULL AND itx.from_email IS NOT NULL AND (
       itx.from_email ILIKE '%@theknot.com'
    OR itx.from_email ILIKE '%@mail.theknot.com'
    OR itx.from_email ILIKE '%@auth.theknot.com'
    OR itx.from_email ILIKE '%@member.theknot.com'
    OR itx.from_email ILIKE '%@weddingwire.com'
    OR itx.from_email ILIKE '%@mail.weddingwire.com'
    OR itx.from_email ILIKE '%@authsolic.com'
    OR itx.from_email ILIKE '%@zola.com'
    OR itx.from_email ILIKE '%@mail.zola.com'
    OR itx.from_email ILIKE '%@herecomestheguide.com'
    OR itx.from_email ILIKE '%@wedj.com'
    OR itx.from_email ILIKE '%@weddingspot.com'
    OR itx.from_email ILIKE '%@wedsites.com'
    OR itx.from_email ILIKE '%@joinleads.com'
    OR itx.from_email ILIKE '%@hubspot.com'
    OR itx.from_email ILIKE '%@salesforce.com'
    OR itx.from_email ILIKE '%@mailchimp.com'
    OR itx.from_email ILIKE '%@intercom.io'
    OR itx.from_email ILIKE '%@drift.com'
    OR itx.from_email ILIKE '%@outreach.io'
    OR itx.from_email ILIKE '%@apollo.io'
    OR itx.from_email ILIKE '%@zoominfo.com'
    OR itx.from_email ILIKE '%@lusha.com'
    OR itx.from_email ILIKE '%@seamless.ai'
    OR itx.from_email ILIKE '%@reply.io'
    OR itx.from_email ILIKE '%@linkedin.com'
    OR itx.from_email ILIKE '%@indeed.com'
    OR itx.from_email ILIKE '%@glassdoor.com'
    OR itx.from_email ILIKE '%@eventective.com'
    OR itx.from_email ILIKE '%@partyslate.com'
  ) THEN 'advertiser'

  -- 2) vendor
  WHEN EXISTS (
    SELECT 1 FROM public.people p
    WHERE p.id = itx.person_id AND p.role = 'vendor'
  ) THEN 'vendor'

  -- 3) client
  WHEN EXISTS (
    SELECT 1 FROM public.weddings w
    WHERE w.id = itx.wedding_id
      AND (w.status IN ('booked', 'completed') OR w.booked_at IS NOT NULL)
  ) THEN 'client'

  -- 4) potential_client
  WHEN EXISTS (
    SELECT 1 FROM public.weddings w
    WHERE w.id = itx.wedding_id
      AND w.status IN ('tour_scheduled', 'tour_completed', 'proposal_sent')
  ) THEN 'potential_client'
  WHEN EXISTS (
    SELECT 1 FROM tour_threads tt
    WHERE tt.venue_id = itx.venue_id
      AND tt.gmail_thread_id = itx.gmail_thread_id
  ) THEN 'potential_client'
  WHEN EXISTS (
    SELECT 1 FROM thread_counts tc
    WHERE tc.venue_id = itx.venue_id
      AND tc.gmail_thread_id = itx.gmail_thread_id
      AND tc.outbound_count >= 1
      AND tc.inbound_count  >= 2
  ) THEN 'potential_client'

  -- 5) new_inquiry — CORRECTED RULE: ignore outbound_count.
  --    Couple has not replied (inbound <= 1). Sage may have replied
  --    or not — irrelevant.
  WHEN EXISTS (
    SELECT 1 FROM public.weddings w
    WHERE w.id = itx.wedding_id
      AND w.status = 'inquiry'
  ) AND (
    itx.gmail_thread_id IS NULL
    OR EXISTS (
      SELECT 1 FROM thread_counts tc
      WHERE tc.venue_id = itx.venue_id
        AND tc.gmail_thread_id = itx.gmail_thread_id
        AND tc.inbound_count <= 1
    )
  ) THEN 'new_inquiry'

  -- 6) other
  ELSE 'other'
END;

COMMIT;

-- Sanity check: counts per folder so you can see the new distribution
-- before closing the SQL editor.
SELECT lifecycle_folder, COUNT(*) AS rows
FROM public.interactions
WHERE type = 'email'
GROUP BY lifecycle_folder
ORDER BY rows DESC;
