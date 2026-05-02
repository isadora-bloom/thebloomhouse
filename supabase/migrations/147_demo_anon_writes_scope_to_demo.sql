-- Migration 147: scope demo anon UPDATE/INSERT/DELETE to demo venues only
-- (OPS-21.3.6 / Playbook 21.3 access controls).
--
-- Pre-fix: migration 027 added permissive `USING(true) WITH CHECK(true)`
-- anon policies for INSERT + UPDATE on ~50 couple-portal tables so the
-- demo could mutate data without auth. The anon key is PUBLIC — anyone
-- with it (any visitor to thebloomhouse.ai) can open a JS console and
-- issue an UPDATE that touches every row in those tables across every
-- tenant. Multi-tenant write breach hidden behind "demo support".
--
-- Migration 064 already tightened the SELECT side to is_demo venues.
-- This migration does the same for UPDATE/INSERT/DELETE: drops the
-- wide-open policies and replaces with predicates that gate writes to
-- venues where venues.is_demo = true. Authenticated couple sessions
-- (real, paid customers) keep working via the migration 006
-- venue_isolation policies — those are unchanged and not anon.
--
-- Helper functions: STABLE SECURITY DEFINER so the policy predicates
-- don't trigger RLS recursion checking venues from inside venues' own
-- check.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY for each. Drops
-- both the 027 names AND any prior re-creation.

-- =====================================================================
-- Helpers.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.is_demo_venue(p_venue_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT COALESCE(v.is_demo, false)
    FROM public.venues v
   WHERE v.id = p_venue_id
$$;

COMMENT ON FUNCTION public.is_demo_venue(uuid) IS
  'Helper for anon RLS predicates (migration 147 / OPS-21.3.6). '
  'STABLE SECURITY DEFINER so the policy predicate evaluates against '
  'venues without triggering RLS recursion. Returns false on missing '
  'venue (anon writes denied by default).';

CREATE OR REPLACE FUNCTION public.is_demo_wedding(p_wedding_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT COALESCE(v.is_demo, false)
    FROM public.weddings w
    JOIN public.venues v ON v.id = w.venue_id
   WHERE w.id = p_wedding_id
$$;

COMMENT ON FUNCTION public.is_demo_wedding(uuid) IS
  'Resolves a wedding_id to its venue.is_demo flag. Used by anon '
  'RLS predicates on tables that carry wedding_id but not venue_id.';

-- =====================================================================
-- Helper: rewrite a venue_id-scoped table's anon write policies.
-- Uses dynamic SQL so we don't have to repeat 30 nearly-identical blocks.
-- =====================================================================

DO $$
DECLARE
  -- Tables with venue_id column. Anon writes go through is_demo_venue.
  v_venue_tables text[] := ARRAY[
    'venue_config',
    'venue_ai_config',
    'venue_detail_config',  -- alias seen in some migrations; safe-noop if missing
    'wedding_detail_config',
    'venue_assets',
    'venue_resources',
    'storefront',
    'portal_section_config',
    'vendor_recommendations',  -- venue-scoped, not wedding-scoped
    'inspo_gallery',           -- venue-scoped per 004
    'borrow_catalog',          -- venue-scoped catalog (selections are wedding-scoped)
    'bar_recipes'              -- venue-scoped recipe library
  ];
  -- Tables with wedding_id column (and possibly venue_id but easier
  -- to scope via wedding). Anon writes go through is_demo_wedding.
  v_wedding_tables text[] := ARRAY[
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
  v_table text;
  v_has_venue boolean;
  v_has_wedding boolean;
  v_scope_col text;
  v_scope_fn text;
BEGIN
  -- Walk both lists. For each, discover which scope column actually
  -- exists on the table (handles schema drift — some 'wedding_*' tables
  -- only carry an indirect scope via guest_id, in which case we DON'T
  -- create an anon write policy at all and log a notice for follow-up
  -- rather than ship a broken predicate).
  FOREACH v_table IN ARRAY (v_venue_tables || v_wedding_tables) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = v_table
    ) THEN
      RAISE NOTICE 'Skipping non-existent table: %', v_table;
      CONTINUE;
    END IF;

    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = v_table AND column_name = 'venue_id'
    ) INTO v_has_venue;
    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = v_table AND column_name = 'wedding_id'
    ) INTO v_has_wedding;

    -- Always drop the old wide-open anon write policies — even if we
    -- can't resolve a scope, the wide-open ones MUST go (this is the
    -- security fix). Then add the scoped versions if a key exists.
    EXECUTE format('DROP POLICY IF EXISTS "anon_insert_%I" ON public.%I', v_table, v_table);
    EXECUTE format('DROP POLICY IF EXISTS "anon_update_%I" ON public.%I', v_table, v_table);
    EXECUTE format('DROP POLICY IF EXISTS "anon_delete_%I" ON public.%I', v_table, v_table);

    -- Prefer venue_id when present (cheaper predicate; one-hop via
    -- venues). Fall back to wedding_id (two-hop via weddings →
    -- venues). If neither exists, log and skip — anon write stays
    -- denied (default-deny under RLS once the wide-open policy is
    -- dropped).
    IF v_has_venue THEN
      v_scope_col := 'venue_id'; v_scope_fn := 'public.is_demo_venue';
    ELSIF v_has_wedding THEN
      v_scope_col := 'wedding_id'; v_scope_fn := 'public.is_demo_wedding';
    ELSE
      RAISE NOTICE 'Table % has no venue_id or wedding_id — anon writes denied; needs custom policy', v_table;
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE POLICY "anon_insert_%I" ON public.%I '
      'FOR INSERT TO anon WITH CHECK (%s(%I))',
      v_table, v_table, v_scope_fn, v_scope_col
    );
    EXECUTE format(
      'CREATE POLICY "anon_update_%I" ON public.%I '
      'FOR UPDATE TO anon USING (%s(%I)) WITH CHECK (%s(%I))',
      v_table, v_table, v_scope_fn, v_scope_col, v_scope_fn, v_scope_col
    );
    EXECUTE format(
      'CREATE POLICY "anon_delete_%I" ON public.%I '
      'FOR DELETE TO anon USING (%s(%I))',
      v_table, v_table, v_scope_fn, v_scope_col
    );
  END LOOP;
END $$;

-- =====================================================================
-- Sanity verification: log how many anon policies are still wide-open.
-- After this migration, the count should be 0 across the targeted tables.
-- =====================================================================

DO $$
DECLARE
  v_open_count int;
BEGIN
  SELECT COUNT(*) INTO v_open_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND 'anon' = ANY(roles)
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
     AND qual = 'true'
     AND with_check = 'true';
  RAISE NOTICE 'Wide-open anon write policies remaining: %', v_open_count;
END $$;
