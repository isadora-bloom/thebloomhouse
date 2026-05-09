-- ---------------------------------------------------------------------------
-- Combined apply: brand_assets RLS fix + lifecycle folder reclass
-- ---------------------------------------------------------------------------
-- Paste this whole file into:
--   https://supabase.com/dashboard/project/jsxxgwprxuqgcauzlxcb/sql/new
-- Idempotent. Safe to re-run.

-- ============================================
-- PART 1: migration 245 - brand_assets RLS
-- ============================================
-- ---------------------------------------------------------------------------
-- 245_brand_assets_auth_policies.sql
-- ---------------------------------------------------------------------------
-- brand_assets was created in migration 024 with two policies:
--
--   venue_isolation   FOR ALL USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()))
--   super_admin_bypass FOR ALL USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
--
-- Both rely on user_profiles having venue_id (single-venue model) or
-- role='super_admin'. Migration 038 introduced a permissive
-- TO authenticated baseline that every other coordinator-table inherits,
-- but brand_assets was missed. Result: when a coordinator's user_profiles
-- row does not exactly match (e.g. their venue_id is null or set to a
-- different venue under multi-venue), the INSERT to brand_assets is
-- silently denied by RLS - the modal looked frozen because no error
-- was thrown back through PostgREST in the form the client surfaced.
--
-- This migration aligns brand_assets with the same permissive
-- TO authenticated baseline used by venue_assets, venue_resources,
-- decor_inventory, etc. The legacy venue_isolation + super_admin_bypass
-- policies stay (no harm, RLS is OR-combined across permissive
-- policies), and the new explicit FOR INSERT WITH CHECK policy ensures
-- the write path is unblocked.
--
-- Idempotent: drops + recreates each named policy.
-- ---------------------------------------------------------------------------

BEGIN;

DROP POLICY IF EXISTS "auth_select_brand_assets" ON public.brand_assets;
CREATE POLICY "auth_select_brand_assets" ON public.brand_assets
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_brand_assets" ON public.brand_assets;
CREATE POLICY "auth_insert_brand_assets" ON public.brand_assets
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_brand_assets" ON public.brand_assets;
CREATE POLICY "auth_update_brand_assets" ON public.brand_assets
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_delete_brand_assets" ON public.brand_assets;
CREATE POLICY "auth_delete_brand_assets" ON public.brand_assets
  FOR DELETE TO authenticated USING (true);

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================
-- PART 2: reclass lifecycle folders
-- ============================================
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
