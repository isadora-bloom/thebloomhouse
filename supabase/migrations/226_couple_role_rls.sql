-- ============================================================================
-- 226: COUPLE-ROLE RLS PATHWAY (Tier-A #2b)
--
-- Closes the gap that round-6 audit surfaced and the user confirmed needs
-- to land BEFORE the first non-demo couple is onboarded:
--
--   Today: a couple registers via /api/couple/register, which creates a
--   user_profiles row with role='couple' and venue_id=<their wedding's
--   venue>. They sign in. Their browser supabase client has a real
--   authenticated session. But every existing RLS policy is built
--   around "user_profiles.venue_id = row.venue_id" — so a couple at
--   venue X can read EVERY wedding at venue X, not just their own.
--
-- This migration adds wedding-level scoping for the couple role. The
-- shape mirrors mig 064 (demo path) so the two paths read symmetrically.
--
-- Layers:
--   1. user_profiles gets a `wedding_id` column (nullable FK).
--   2. Helper SQL functions that resolve the auth user's wedding_id /
--      venue_id (couple role only). SECURITY DEFINER so they bypass
--      the calling user's policies on user_profiles itself.
--   3. couple_read SELECT policies on every wedding_id-scoped table.
--   4. couple_read SELECT policies on the small set of venue_id-scoped
--      tables couples need (venue_config for branding, venue_ai_config
--      for owner_name, packages for catalog).
--   5. couple_write UPDATE/INSERT/DELETE policies on the explicit set
--      of tables couples are expected to write (checklist_items,
--      budget_items, guest_list, sage_conversations, etc.). Writes are
--      gated by both `wedding_id = couple_user_wedding_id()` and an
--      assertion that role='couple' (so a misconfigured user_profiles
--      row can't escalate).
--
-- Out of scope (intentional):
--   - Couples writing to venues, venue_config, venue_ai_config, packages.
--     Read-only for couples; coordinator role retains write via mig 058.
--   - Couples reading interactions, drafts, gmail_*, weddings_journal_*,
--     anything coordinator-internal. Hard NO; their wedding row gives
--     them the "their wedding" view, not the agent timeline.
--   - Cross-wedding data (anonymised industry stats / anomalies). Couples
--     never need that surface; coordinator scope only.
--
-- Idempotent: column add uses IF NOT EXISTS, function uses CREATE OR REPLACE,
-- policy adds DROP IF EXISTS first. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. user_profiles.wedding_id
--
-- Nullable: coordinator / org_admin / super_admin rows have wedding_id NULL
-- (they're venue-scoped). Couple rows have wedding_id set at registration.
-- FK with ON DELETE SET NULL so deleting a wedding doesn't cascade-delete
-- the auth user (the auth user is a real Supabase auth.users row that
-- shouldn't disappear because their wedding was deleted; admin can
-- re-link or hard-delete via auth.admin.deleteUser).
-- ----------------------------------------------------------------------------

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_user_profiles_wedding ON public.user_profiles(wedding_id);

COMMENT ON COLUMN public.user_profiles.wedding_id IS
  'For role=''couple'' users: the wedding they registered for. NULL for coordinator / org_admin / super_admin / pending-invite rows. Drives the couple_read RLS predicates.';

-- ----------------------------------------------------------------------------
-- 2. Helper functions
--
-- SECURITY DEFINER + STABLE means the function runs as the function owner
-- (the postgres / supabase_admin role) and is cacheable per query. This
-- bypasses any RLS on user_profiles when resolving the lookup, so even a
-- restrictive user_profiles policy doesn't break the helpers.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.couple_user_wedding_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT wedding_id
    FROM public.user_profiles
   WHERE id = auth.uid()
     AND role = 'couple'
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.couple_user_venue_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT venue_id
    FROM public.user_profiles
   WHERE id = auth.uid()
     AND role = 'couple'
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.couple_user_wedding_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.couple_user_wedding_id() TO authenticated;

REVOKE ALL ON FUNCTION public.couple_user_venue_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.couple_user_venue_id() TO authenticated;

COMMENT ON FUNCTION public.couple_user_wedding_id() IS
  'Resolves the calling auth user''s wedding_id when role=couple. Returns NULL for non-couple users. Used in couple_read RLS predicates.';

-- ----------------------------------------------------------------------------
-- 3. couple_read policies on wedding_id-scoped tables
--
-- Walks every public table that has a wedding_id column and adds (or
-- replaces) a `couple_read` policy gating SELECT to authenticated couples
-- whose user_profile.wedding_id matches the row.
-- ----------------------------------------------------------------------------

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT DISTINCT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'wedding_id'
      AND c.table_name NOT IN (
        -- Coordinator-internal: do NOT expose to couples.
        -- 2026-05-07 (round-7 audit): added attribution_parity_log,
        -- booked_data_recovery_log, event_feedback*, after they were
        -- caught leaking via the original list. Long-term direction is
        -- to invert this to an opt-in allowlist; for now the list is
        -- maintained additively. Mig 228 dropped the leaked policies
        -- on already-applied schemas.
        'gmail_connections',
        'gmail_tokens',
        'team_invitations',
        'drafts',                  -- AI draft outbox; coordinator surface
        'interactions',            -- email/SMS audit trail; coordinator
        'engagement_events',       -- behavioural signals; coordinator
        'lead_score_history',      -- internal scoring; coordinator
        'lost_deals',              -- internal pipeline; coordinator
        'admin_notifications',     -- coordinator notifs
        'planning_notes',          -- AI-extracted notes; coordinator
        'activity_log',            -- audit log; coordinator
        'wedding_journey_narratives', -- internal narrative
        'attribution_events',      -- internal attribution
        'attribution_parity_log',  -- internal attribution scoring (round-7)
        'candidate_identities',    -- internal identity resolution
        'wedding_touchpoints',     -- internal multi-touch
        'voice_training_responses', -- internal voice DNA
        're_engagement_actions',   -- internal winback
        'follow_up_sequences',     -- internal cron sequences
        'identity_reconciliation_log',
        'web_form_submissions',
        'storefront_analytics',
        'booked_data_recovery_log', -- internal recovery audit (round-7)
        'event_feedback',          -- internal post-event feedback (round-7)
        'event_feedback_vendors'   -- internal vendor scoring (round-7)
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "couple_read" ON public.%I', t.table_name);
    EXECUTE format($p$CREATE POLICY "couple_read" ON public.%I
      FOR SELECT TO authenticated
      USING (wedding_id = public.couple_user_wedding_id())$p$, t.table_name);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 4. couple_read policies on the venue_id-scoped tables couples need
--
-- These are the venue-scoped tables that couple-portal pages legitimately
-- read for branding / Sage persona / package catalog. Anything else stays
-- coordinator-only.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "couple_read" ON public.venue_config;
CREATE POLICY "couple_read" ON public.venue_config
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.venue_ai_config;
CREATE POLICY "couple_read" ON public.venue_ai_config
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.packages;
CREATE POLICY "couple_read" ON public.packages
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.venues;
CREATE POLICY "couple_read" ON public.venues
  FOR SELECT TO authenticated
  USING (id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.weddings;
CREATE POLICY "couple_read" ON public.weddings
  FOR SELECT TO authenticated
  USING (id = public.couple_user_wedding_id());

-- knowledge_base is venue-scoped and couples need to read it for Sage
-- to surface answers + for the resources page.
DROP POLICY IF EXISTS "couple_read" ON public.knowledge_base;
CREATE POLICY "couple_read" ON public.knowledge_base
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

-- vendor_recommendations: venue-scoped catalog the couple-portal
-- preferred-vendors page surfaces.
DROP POLICY IF EXISTS "couple_read" ON public.vendor_recommendations;
CREATE POLICY "couple_read" ON public.vendor_recommendations
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

-- inspo_gallery / borrow_catalog / venue_assets / venue_resources:
-- venue-scoped, couple-portal pages display.
DROP POLICY IF EXISTS "couple_read" ON public.inspo_gallery;
CREATE POLICY "couple_read" ON public.inspo_gallery
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.borrow_catalog;
CREATE POLICY "couple_read" ON public.borrow_catalog
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.venue_assets;
CREATE POLICY "couple_read" ON public.venue_assets
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.venue_resources;
CREATE POLICY "couple_read" ON public.venue_resources
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.bar_recipes;
CREATE POLICY "couple_read" ON public.bar_recipes
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.portal_section_config;
CREATE POLICY "couple_read" ON public.portal_section_config
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

-- ----------------------------------------------------------------------------
-- 5. couple_write policies
--
-- Couples can write to a curated subset of wedding-scoped tables. Each
-- gate enforces TWO predicates: wedding_id matches their user_profile,
-- AND the calling user's role is 'couple' (defense-in-depth — a future
-- bug that lets a coordinator user_profile pick up a wedding_id field
-- shouldn't accidentally let them write through couple paths).
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_table text;
  v_has_wedding boolean;
  v_tables text[] := ARRAY[
    -- The wedding_id-scoped tables couples are expected to write.
    -- Mirror the surface area mig 147 grants to demo anon, minus
    -- coordinator-internal tables.
    --
    -- 2026-05-07 fixup: not every table in this list actually has
    -- wedding_id. guest_tag_assignments uses guest_id → guest_list.
    -- The DO block now checks information_schema before writing the
    -- policy and skips tables without wedding_id (handled below the
    -- loop with explicit per-table policies).
    'checklist_items',
    'guest_list',
    'seating_tables',
    'seating_assignments',
    'sage_conversations',
    'contracts',
    'messages',
    'timeline',
    'onboarding_progress',
    'wedding_website_settings',
    'budget_items',
    'budget_payments',
    'wedding_config',
    'couple_budget',
    'guest_meal_options',
    'guest_tags',
    'guest_tag_assignments',
    'bar_planning',
    'bar_shopping_list',
    'decor_inventory',
    'bedroom_assignments',
    'shuttle_schedule',
    'guest_care_notes',
    'staffing_assignments',
    'wedding_details',
    'wedding_tables',
    'wedding_party',
    'ceremony_order',
    'makeup_schedule',
    'rehearsal_dinner',
    'wedding_worksheets',
    'photo_library',
    'borrow_selections',
    'accommodations',
    'allergy_registry',
    'rsvp_config',
    'rsvp_responses',
    'section_finalisations',
    'booked_vendors'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = v_table
    ) THEN
      RAISE NOTICE '[226] Skipping non-existent table: %', v_table;
      CONTINUE;
    END IF;

    -- 2026-05-07 fix: column-existence check. Tables that join via a
    -- different FK (guest_tag_assignments → guest_list, etc.) can't
    -- use the simple wedding_id predicate; they get an explicit
    -- policy block below the loop.
    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = v_table
         AND column_name = 'wedding_id'
    ) INTO v_has_wedding;

    IF NOT v_has_wedding THEN
      RAISE NOTICE '[226] Skipping % (no wedding_id column; needs custom policy)', v_table;
      CONTINUE;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS "couple_insert" ON public.%I', v_table);
    EXECUTE format($p$CREATE POLICY "couple_insert" ON public.%I
      FOR INSERT TO authenticated
      WITH CHECK (
        wedding_id = public.couple_user_wedding_id()
        AND EXISTS (
          SELECT 1 FROM public.user_profiles
           WHERE id = auth.uid() AND role = 'couple'
        )
      )$p$, v_table);

    EXECUTE format('DROP POLICY IF EXISTS "couple_update" ON public.%I', v_table);
    EXECUTE format($p$CREATE POLICY "couple_update" ON public.%I
      FOR UPDATE TO authenticated
      USING (
        wedding_id = public.couple_user_wedding_id()
        AND EXISTS (
          SELECT 1 FROM public.user_profiles
           WHERE id = auth.uid() AND role = 'couple'
        )
      )
      WITH CHECK (
        wedding_id = public.couple_user_wedding_id()
        AND EXISTS (
          SELECT 1 FROM public.user_profiles
           WHERE id = auth.uid() AND role = 'couple'
        )
      )$p$, v_table);

    EXECUTE format('DROP POLICY IF EXISTS "couple_delete" ON public.%I', v_table);
    EXECUTE format($p$CREATE POLICY "couple_delete" ON public.%I
      FOR DELETE TO authenticated
      USING (
        wedding_id = public.couple_user_wedding_id()
        AND EXISTS (
          SELECT 1 FROM public.user_profiles
           WHERE id = auth.uid() AND role = 'couple'
        )
      )$p$, v_table);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 5b. Tables without wedding_id — explicit policies via FK join.
--
-- guest_tag_assignments: many-to-many join between guest_list (which
-- carries wedding_id) and guest_tags. Couples write to this table when
-- they tag guests; gate on guest_id → guest_list.wedding_id.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "couple_read" ON public.guest_tag_assignments;
CREATE POLICY "couple_read" ON public.guest_tag_assignments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.guest_list g
       WHERE g.id = guest_tag_assignments.guest_id
         AND g.wedding_id = public.couple_user_wedding_id()
    )
  );

DROP POLICY IF EXISTS "couple_insert" ON public.guest_tag_assignments;
CREATE POLICY "couple_insert" ON public.guest_tag_assignments
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.guest_list g
       WHERE g.id = guest_tag_assignments.guest_id
         AND g.wedding_id = public.couple_user_wedding_id()
    )
    AND EXISTS (
      SELECT 1 FROM public.user_profiles
       WHERE id = auth.uid() AND role = 'couple'
    )
  );

DROP POLICY IF EXISTS "couple_delete" ON public.guest_tag_assignments;
CREATE POLICY "couple_delete" ON public.guest_tag_assignments
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.guest_list g
       WHERE g.id = guest_tag_assignments.guest_id
         AND g.wedding_id = public.couple_user_wedding_id()
    )
    AND EXISTS (
      SELECT 1 FROM public.user_profiles
       WHERE id = auth.uid() AND role = 'couple'
    )
  );

-- ----------------------------------------------------------------------------
-- 6. people table — wedding-scoped, but couples need to read AND update
-- (their own contact info, partner names, etc.).
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "couple_read" ON public.people;
CREATE POLICY "couple_read" ON public.people
  FOR SELECT TO authenticated
  USING (wedding_id = public.couple_user_wedding_id());

DROP POLICY IF EXISTS "couple_update" ON public.people;
CREATE POLICY "couple_update" ON public.people
  FOR UPDATE TO authenticated
  USING (
    wedding_id = public.couple_user_wedding_id()
    AND EXISTS (
      SELECT 1 FROM public.user_profiles
       WHERE id = auth.uid() AND role = 'couple'
    )
  )
  WITH CHECK (
    wedding_id = public.couple_user_wedding_id()
    AND EXISTS (
      SELECT 1 FROM public.user_profiles
       WHERE id = auth.uid() AND role = 'couple'
    )
  );

-- ----------------------------------------------------------------------------
-- 7. Verification: list the couple_read / couple_write policies created.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_read_count int;
  v_write_count int;
BEGIN
  SELECT COUNT(*) INTO v_read_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname = 'couple_read';

  SELECT COUNT(*) INTO v_write_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname IN ('couple_insert', 'couple_update', 'couple_delete');

  RAISE NOTICE '[226] couple_read policies: %', v_read_count;
  RAISE NOTICE '[226] couple_insert/update/delete policies: %', v_write_count;
END $$;

NOTIFY pgrst, 'reload schema';
