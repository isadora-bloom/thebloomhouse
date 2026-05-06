-- ============================================
-- 216_seal_rls_post_147_gaps.sql
-- ============================================
--
-- WHY THIS EXISTS
-- A 2026-05-06 codebase audit (audits/2026-05-06-eight-lens/Lens-1.md
-- and Lens-8.md) surfaced two classes of RLS gap that 147's wide
-- anon-write fix did not cover.
--
-- CLASS 1 — RLS-disabled tables in prod (UNKNOWN STATE).
-- supabase/disable-rls-for-demo.sql exists in the repo and explicitly
-- disables RLS on every venue/wedding-scoped table for "demo mode."
-- It is a standalone script (not a tracked migration). We cannot
-- determine from code whether it was ever applied to production. If it
-- was applied, every named table is currently writable by anon
-- regardless of any policy — RLS-disabled tables ignore policies
-- entirely. This migration defensively ENABLES RLS on every table the
-- disable script names. ALTER TABLE ... ENABLE ROW LEVEL SECURITY is
-- a no-op when RLS is already enabled, so this section is safe even if
-- the disable script was never run.
--
-- CLASS 2 — Tables created in migrations 053, 054, 201, 215 that never
-- enable RLS. Confirmed gaps:
--   rate_limits (053) — never enables RLS. Anon can read rate-limit
--     keys (which leak per-user / per-venue activity patterns) and
--     write to corrupt counters.
--   stripe_events (054) — never enables RLS. Anon can read full Stripe
--     webhook payloads (subscription IDs, customer IDs, plan changes,
--     prices). Cited in 056's exclusion list as "platform-level, no
--     tenancy. Skipped." but skipping the policies also skipped the
--     ENABLE statement.
--   booked_data_recovery_log (201) — never enables RLS. Holds wedding-
--     scoped financial recovery data (recovered_value_cents, evidence
--     blobs from contract/calculator extraction). Anon can read or
--     write freely.
--   founding_member_counter (215) — never enables RLS. Singleton
--     counter (1 row, capped at 25 founding venues). Anon could read
--     (mild marketing-info leak) and write (corrupt the count, lock
--     out signups, claim founding status).
--
-- WHAT THIS MIGRATION DOES
-- 1. Defensively ENABLE RLS on every table touched by disable-rls-
--    for-demo.sql. Idempotent. No-op if already enabled.
-- 2. ENABLE RLS on the four Class-2 gap tables and add the right
--    policies for each (default-deny vs scoped-read vs platform-only).
-- 3. Sanity-verify at the end: log any table from the union list that
--    still has RLS off after this migration.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- - Does not drop or modify existing policies. 147's anon-write
--   policies stay; 056's authenticated venue-isolation policies stay;
--   the super-admin bypass stays. This migration only adds.
-- - Does not address the audit's broader Lens-8 findings (SSRF, prompt
--   injection, demo/prod project segregation). Those have separate
--   PRs.
-- - Does not deploy any application code. After this migration ships,
--   nothing in src/ should observe behavior change EXCEPT that
--   bypass-via-anon-key reads on rate_limits / stripe_events /
--   booked_data_recovery_log / founding_member_counter will now be
--   denied. The application uses createServiceClient() for all writes
--   to those tables, which bypasses RLS naturally.
--
-- IDEMPOTENCY
-- Safe to rerun. ENABLE ROW LEVEL SECURITY is no-op-when-on. CREATE
-- POLICY uses DROP POLICY IF EXISTS first.
--
-- VERIFICATION AFTER APPLY
-- Run supabase/verify-rls-state.sql and confirm:
--   - Block 1 returns 2 rows (is_demo_venue, is_demo_wedding).
--   - Block 2 has rls_enabled = true on every row.
--   - Block 3 returns 0 rows.
--   - Block 4 every row with has_venue_id or has_wedding_id has
--     rls_enabled = true.
-- ============================================

BEGIN;

-- ----------------------------------------------------------------------
-- STEP 1: Defensive RLS re-enable on every table touched by
-- disable-rls-for-demo.sql. Idempotent. The DO block silently skips
-- tables that don't exist in this schema (the disable script lists a
-- couple of tables that may have been renamed or never created in
-- some lineages — `budget` for instance is split into budget_items /
-- budget_payments in some migration paths).
-- ----------------------------------------------------------------------
DO $$
DECLARE
  v_tables text[] := ARRAY[
    'organisations','venues','venue_config','venue_ai_config','user_profiles',
    'weddings','people','contacts','booked_dates','interactions','drafts',
    'draft_feedback','engagement_events','lead_score_history','heat_score_config',
    'auto_send_rules','phrase_usage','email_sync_state','search_trends',
    'weather_data','economic_indicators','anomaly_alerts','ai_briefings',
    'natural_language_queries','review_language','guest_list','timeline','budget',
    'seating_tables','seating_assignments','sage_conversations','sage_uncertain_queue',
    'planning_notes','contracts','checklist_items','messages','vendor_recommendations',
    'inspo_gallery','knowledge_base','venue_usps','venue_seasonal_content',
    'voice_preferences','voice_training_sessions','voice_training_responses',
    'learned_preferences','api_costs','trend_recommendations','source_attribution',
    'consultant_metrics','marketing_spend','intelligence_extractions',
    'bar_planning','bar_recipes','bar_shopping_list','ceremony_order',
    'makeup_schedule','shuttle_schedule','rehearsal_dinner','decor_inventory',
    'staffing_assignments','bedroom_assignments','allergy_registry','guest_care_notes',
    'wedding_worksheets','wedding_party','photo_library','borrow_catalog',
    'borrow_selections','accommodations','onboarding_progress','section_finalisations',
    'guest_tags','guest_tag_assignments','guest_meal_options','wedding_website_settings',
    'tours','lost_deals','campaigns','social_posts','annotations','venue_health',
    'client_match_queue','knowledge_gaps','follow_up_sequence_templates',
    'wedding_sequences','relationships','client_codes','error_logs',
    'notification_tokens','activity_log','admin_notifications'
  ];
  v_table text;
  v_re_enabled int := 0;
  v_skipped int := 0;
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = v_table
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
      v_re_enabled := v_re_enabled + 1;
    ELSE
      v_skipped := v_skipped + 1;
      RAISE NOTICE 'Step 1: skipping non-existent table %', v_table;
    END IF;
  END LOOP;
  RAISE NOTICE 'Step 1 complete: re-enabled RLS on % tables (skipped % missing)', v_re_enabled, v_skipped;
END $$;

-- ----------------------------------------------------------------------
-- STEP 2A: rate_limits (053). Platform-level. Service-role only.
-- check_rate_limit is plpgsql (not SECURITY DEFINER) but is called
-- exclusively via createServiceClient() in src/lib/rate-limit.ts:168
-- and src/app/api/cron/route.ts:614, both of which bypass RLS. Default-
-- deny is correct. IF EXISTS guard handles the case where a future
-- migration renames or drops the table.
-- ----------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'rate_limits'
  ) THEN
    EXECUTE 'ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY';
    RAISE NOTICE 'Step 2A: RLS enabled on rate_limits';
  ELSE
    RAISE NOTICE 'Step 2A: skipping rate_limits (table not present)';
  END IF;
END $$;

-- ----------------------------------------------------------------------
-- STEP 2B: stripe_events (054). Platform-level. Service-role only.
-- Webhook handler at src/app/api/webhooks/stripe/route.ts uses
-- createServiceClient() (mig 209 hardening confirmed). Coordinators
-- have no use case for raw Stripe payload access.
-- ----------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'stripe_events'
  ) THEN
    EXECUTE 'ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY';
    RAISE NOTICE 'Step 2B: RLS enabled on stripe_events';
  ELSE
    RAISE NOTICE 'Step 2B: skipping stripe_events (table not present)';
  END IF;
END $$;

-- ----------------------------------------------------------------------
-- STEP 2C: booked_data_recovery_log (201). Wedding-scoped audit log.
-- Cron writer is service-role. Coordinator readers go through the
-- onboarding readiness page; that page calls /api/* routes that use
-- createServiceClient() (per the codebase pattern), so the practical
-- access is service-role-only today.
--
-- Defensive: if a future page attempts a direct browser-side read via
-- createClient() (anon-key supabase-js), the policy below scopes via
-- the canonical post-141 pattern: user_visible_venue_ids() handles
-- both single-venue (user_profiles.venue_id) and org-wide (org_id)
-- visibility, plus super_admin bypass. user_profiles.id IS the
-- auth.users(id) FK (mig 001), so user_visible_venue_ids() does the
-- correct lookup internally.
-- ----------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'booked_data_recovery_log'
  ) THEN
    EXECUTE 'ALTER TABLE public.booked_data_recovery_log ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "booked_data_recovery_log_authenticated_select" ON public.booked_data_recovery_log';
    EXECUTE $p$
      CREATE POLICY "booked_data_recovery_log_authenticated_select"
        ON public.booked_data_recovery_log
        FOR SELECT TO authenticated
        USING (
          venue_id IN (SELECT public.user_visible_venue_ids())
          OR public.is_super_admin()
        )
    $p$;
    RAISE NOTICE 'Step 2C: RLS enabled + auth-select policy on booked_data_recovery_log';
  ELSE
    RAISE NOTICE 'Step 2C: skipping booked_data_recovery_log (table not present)';
  END IF;
END $$;

-- No INSERT/UPDATE/DELETE policies for authenticated. Writes are
-- service-role only (the recovery cron). Audit logs are immutable
-- from the application's perspective; if a coordinator-supplied
-- override workflow lands later, that PR adds the right write policy.

-- ----------------------------------------------------------------------
-- STEP 2D: founding_member_counter (215). Global singleton.
-- Default-deny everything. The marketing site (thebloomhouse-website)
-- is a separate repo and will read this counter via createServiceClient
-- in a server component if/when the /pricing page surfaces "X of 25
-- spots remaining." No anon access needed today.
--
-- IF EXISTS guard: as of 2026-05-06 verification, mig 215 is in the
-- repo working tree but not yet applied to prod. This block becomes
-- a no-op until 215 is applied. After 215 lands in prod, re-run 216
-- (idempotent) to seal the table. Or include this guard in 215 itself.
--
-- If a future requirement makes anon read necessary, add:
--   CREATE POLICY "founding_member_counter_anon_select"
--     ON public.founding_member_counter
--     FOR SELECT TO anon USING (true);
-- and document why on the change.
-- ----------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'founding_member_counter'
  ) THEN
    EXECUTE 'ALTER TABLE public.founding_member_counter ENABLE ROW LEVEL SECURITY';
    RAISE NOTICE 'Step 2D: RLS enabled on founding_member_counter';
  ELSE
    RAISE NOTICE 'Step 2D: skipping founding_member_counter (table not present — mig 215 not yet applied)';
  END IF;
END $$;

-- ----------------------------------------------------------------------
-- STEP 3: Sanity verification. Logs any of the tables in scope that
-- still report rls_enabled = false. Expected output: 0.
--
-- We cannot RAISE EXCEPTION here without breaking idempotency on
-- environments where one of the listed tables was renamed in a later
-- migration we don't see. RAISE NOTICE is safer.
-- ----------------------------------------------------------------------
DO $$
DECLARE
  v_unsealed int;
  v_table text;
BEGIN
  SELECT COUNT(*) INTO v_unsealed
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND NOT c.relrowsecurity
    AND c.relname IN (
      'rate_limits','stripe_events','booked_data_recovery_log',
      'founding_member_counter','organisations','venues','user_profiles',
      'weddings','people','contacts','interactions','drafts','guest_list',
      'allergy_registry','contracts','sage_conversations'
    );
  RAISE NOTICE 'Step 3 verification: % critical tables still have RLS DISABLED', v_unsealed;
  IF v_unsealed > 0 THEN
    FOR v_table IN
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND NOT c.relrowsecurity
        AND c.relname IN (
          'rate_limits','stripe_events','booked_data_recovery_log',
          'founding_member_counter','organisations','venues','user_profiles',
          'weddings','people','contacts','interactions','drafts','guest_list',
          'allergy_registry','contracts','sage_conversations'
        )
    LOOP
      RAISE WARNING '  RLS still off on: %', v_table;
    END LOOP;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
