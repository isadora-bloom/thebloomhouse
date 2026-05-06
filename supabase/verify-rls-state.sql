-- ============================================
-- RLS state verification for production
-- Run all four blocks in the Supabase SQL editor.
-- All read-only.
-- ============================================

-- ----------------------------------------------------------------------
-- Block 1: Are migration 147's helper functions present?
-- Expected: two rows (is_demo_venue, is_demo_wedding).
-- If empty: migration 147 was never applied. CRITICAL.
-- ----------------------------------------------------------------------
SELECT
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS args,
  CASE p.provolatile
    WHEN 's' THEN 'STABLE'
    WHEN 'i' THEN 'IMMUTABLE'
    WHEN 'v' THEN 'VOLATILE'
  END AS volatility,
  p.prosecdef AS is_security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('is_demo_venue', 'is_demo_wedding')
ORDER BY p.proname;

-- ----------------------------------------------------------------------
-- Block 2: Is RLS actually ENABLED on every venue/wedding-scoped table?
-- Expected: every row has rls_enabled = true.
-- If any row has rls_enabled = false: disable-rls-for-demo.sql was run
-- against this database. CATASTROPHIC. Migration 147's policies are
-- inert on tables where RLS is off.
-- ----------------------------------------------------------------------
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced,
  (SELECT COUNT(*) FROM pg_policies pp
    WHERE pp.schemaname = 'public' AND pp.tablename = c.relname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    -- Tables explicitly listed in disable-rls-for-demo.sql.
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
  )
ORDER BY (NOT c.relrowsecurity) DESC, c.relname;

-- ----------------------------------------------------------------------
-- Block 3: Wide-open anon write policies still alive?
-- Expected: zero rows.
-- Any row here = a table where anon (the public anon key) can
-- INSERT/UPDATE/DELETE ANYTHING with no scope check.
-- ----------------------------------------------------------------------
SELECT
  schemaname,
  tablename,
  policyname,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND 'anon' = ANY(roles)
  AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
  AND (qual = 'true' OR qual IS NULL)
  AND (with_check = 'true' OR with_check IS NULL)
ORDER BY tablename, cmd;

-- ----------------------------------------------------------------------
-- Block 4: Every venue/wedding-scoped table inventory.
-- Lists every public table that has venue_id or wedding_id, with its
-- RLS status and policy count. Use this to spot tables added AFTER
-- migration 147 that are venue/wedding-scoped but have no anon-write
-- predicate covering them.
-- ----------------------------------------------------------------------
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = c.relname AND column_name = 'venue_id'
  ) AS has_venue_id,
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = c.relname AND column_name = 'wedding_id'
  ) AS has_wedding_id,
  (SELECT COUNT(*) FROM pg_policies pp
    WHERE pp.schemaname = 'public' AND pp.tablename = c.relname AND 'anon' = ANY(pp.roles)
   ) AS anon_policy_count,
  (SELECT COUNT(*) FROM pg_policies pp
    WHERE pp.schemaname = 'public' AND pp.tablename = c.relname AND 'authenticated' = ANY(pp.roles)
   ) AS auth_policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND (
    EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = c.relname AND column_name = 'venue_id'
    )
    OR EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = c.relname AND column_name = 'wedding_id'
    )
  )
ORDER BY c.relname;
