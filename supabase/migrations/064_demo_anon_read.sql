-- ============================================
-- 064: DEMO ANON READ ACCESS
-- ============================================
--
-- WHY THIS EXISTS
-- Migrations 055-062 closed a real RLS leak by rewriting every scoped-table
-- policy as `TO authenticated` with strict `user_profiles.venue_id` matching.
-- That tightening was correct for real tenants, but it also killed the
-- anon-read path the demo depends on.
--
-- The demo runs entirely on the anon role. Middleware (src/middleware.ts)
-- explicitly bypasses auth when `bloom_demo=true`:
--
--   if (isDemo) { return response }   // line 74-77
--
-- which means both the couple portal at /couple/hawthorne-manor AND the full
-- platform shell at /, /agent/*, /intel/*, /portal/* are rendered without a
-- Supabase session. Every client-side query goes through the anon role.
-- Post-056 that role sees zero rows, so both portals appear blank.
--
-- THE FIX
-- Add an additive `demo_anon_select` policy to every tenancy-scoped table. It
-- only grants SELECT TO anon, and only when the row belongs to a venue flagged
-- `is_demo = true`. Migration 048 set that flag on exactly the four Crestwood
-- demo venues (22222222-2222-2222-2222-22222222220[1-4]); it is false for every
-- real venue, and real onboarding never creates rows with those UUIDs.
--
-- Because Postgres combines permissive policies with OR, this policy has zero
-- effect on authenticated reads and zero effect on any venue where is_demo is
-- false. It is surgical to the demo dataset and does not touch any of the
-- work in migrations 055-063.
--
-- SCOPE
-- Read-only. Demo users cannot INSERT/UPDATE/DELETE via anon. If the demo ever
-- needs interactive write actions, route them through API routes that use the
-- service client rather than opening up anon writes here.
--
-- INTELLIGENCE LAYER (the primary USP to demo)
-- The intel pages read ai_briefings, search_trends, trend_recommendations,
-- weather_data, economic_indicators, anomaly_alerts, engagement_events,
-- source_attributions, lead_score_history, venue_health, venue_health_history,
-- review_*, campaigns, tours, lost_deals, nlq_queries, capacity_*, and
-- api_costs. All of these carry venue_id and are covered by STEP 1 below.
--
-- AGENT LAYER
-- Agent pages read interactions (inbox), drafts, people, sequences,
-- knowledge_base, client_codes, relationships, error_logs. All venue_id or
-- wedding_id scoped; covered by STEP 1 or STEP 2.
--
-- EXCLUSIONS (kept out even for the demo venues)
--   gmail_connections, gmail_tokens   OAuth tokens, defense in depth. The demo
--                                     venues should not have real tokens, but
--                                     never expose an OAuth token table to
--                                     anon regardless.
--   team_invitations                  invitation tokens; not read by any
--                                     demo-reachable page.
--   user_profiles                     handled by its own policy in 055/057.
--   organisations                     not read by the demo UI; scope cookie
--                                     supplies company name directly.
--   venue_groups, venue_group_members platform-level grouping, not exercised
--                                     by the single-venue demo view.
--
-- IDEMPOTENCY
-- Each CREATE is preceded by a DROP IF EXISTS of the same policy name.
-- Safe to rerun.
--
-- APPLICATION
-- Run in the Supabase SQL editor against the production project. No
-- DATABASE_URL is configured for CLI push from this workstation.
-- ============================================

-- ============================================
-- STEP 1: venue_id-scoped tables
-- Grant anon SELECT where the row belongs to a demo venue.
-- ============================================
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT DISTINCT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'venue_id'
      AND c.table_name NOT IN (
        'gmail_connections',
        'gmail_tokens',
        'team_invitations',
        'venue_groups',
        'venue_group_members',
        'user_profiles',
        'organisations'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "demo_anon_select" ON public.%I', t.table_name);
    EXECUTE format($p$CREATE POLICY "demo_anon_select" ON public.%I
      FOR SELECT TO anon
      USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true))$p$, t.table_name);
  END LOOP;
END $$;

-- ============================================
-- STEP 2: wedding_id-only tables (no venue_id)
-- Resolve venue via weddings.venue_id, gated on is_demo.
-- ============================================
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT DISTINCT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'wedding_id'
      AND c.table_name NOT IN ('weddings')
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns c2
        WHERE c2.table_schema = 'public'
          AND c2.table_name = c.table_name
          AND c2.column_name = 'venue_id'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "demo_anon_select" ON public.%I', t.table_name);
    EXECUTE format($p$CREATE POLICY "demo_anon_select" ON public.%I
      FOR SELECT TO anon
      USING (wedding_id IN (
        SELECT id FROM public.weddings
        WHERE venue_id IN (SELECT id FROM public.venues WHERE is_demo = true)
      ))$p$, t.table_name);
  END LOOP;
END $$;

-- ============================================
-- STEP 3: venues - allow anon to read the demo venues themselves.
-- The couple portal layout uses the service client so this is belt-and-braces,
-- but the scope-selector and portfolio pages do query venues directly.
-- ============================================
DROP POLICY IF EXISTS "venues_demo_anon_select" ON public.venues;
CREATE POLICY "venues_demo_anon_select" ON public.venues
  FOR SELECT TO anon
  USING (is_demo = true);

-- ============================================
-- STEP 4: weddings - allow anon to read demo weddings.
-- ============================================
DROP POLICY IF EXISTS "weddings_demo_anon_select" ON public.weddings;
CREATE POLICY "weddings_demo_anon_select" ON public.weddings
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- ============================================
-- STEP 5: organisations - allow anon to read the demo organisation.
-- The scope selector and portfolio pages read the org name.
-- ============================================
DROP POLICY IF EXISTS "organisations_demo_anon_select" ON public.organisations;
CREATE POLICY "organisations_demo_anon_select" ON public.organisations
  FOR SELECT TO anon
  USING (is_demo = true);

-- ============================================
-- STEP 6: venue_groups - allow anon to read demo org's groups.
-- Portfolio and scope selector read these for multi-venue demos.
-- ============================================
DROP POLICY IF EXISTS "venue_groups_demo_anon_select" ON public.venue_groups;
CREATE POLICY "venue_groups_demo_anon_select" ON public.venue_groups
  FOR SELECT TO anon
  USING (org_id IN (SELECT id FROM public.organisations WHERE is_demo = true));

-- ============================================
-- STEP 7: Reference tables with no tenancy column
-- market_intelligence and industry_benchmarks are read by intel pages and
-- have no venue_id. The existing authenticated-only policy blocks anon.
-- These tables contain non-sensitive reference data (market benchmarks and
-- aggregated public-source intelligence), so grant anon read-all.
-- ============================================
DROP POLICY IF EXISTS "market_intelligence_anon_read" ON public.market_intelligence;
CREATE POLICY "market_intelligence_anon_read" ON public.market_intelligence
  FOR SELECT TO anon
  USING (true);

DROP POLICY IF EXISTS "industry_benchmarks_anon_read" ON public.industry_benchmarks;
CREATE POLICY "industry_benchmarks_anon_read" ON public.industry_benchmarks
  FOR SELECT TO anon
  USING (true);

-- ============================================
-- POST-MIGRATION VERIFICATION
-- 1. Visit /demo → click Couple Portal → /couple/hawthorne-manor.
--    Budget, timeline, guests, checklist, vendors should all show data.
-- 2. Visit /demo → click Platform → /. Walk through Agent (inbox, drafts,
--    heat map, pipeline, analytics, learning) and Intelligence (dashboard,
--    market pulse, briefings, reviews, tours, lost deals, portfolio). Every
--    page should populate with Crestwood seed data.
-- 3. Log in as a real tenant on a non-demo venue. Confirm no cross-leak:
--    the authenticated policies from 055-062 are unchanged, and is_demo is
--    false on their venues so the new anon predicate never fires for them.
-- 4. Spot-check that gmail_connections, gmail_tokens, team_invitations remain
--    invisible to the anon role even for demo venues.
-- ============================================
