-- ============================================================================
-- Migration 062: RLS recursion hotfix + self-healing guard
-- ============================================================================
--
-- CONTEXT
-- On 2026-04-21 two RLS defects combined to make Rixey's inbox appear empty
-- AND then, after an attempted fix, to 500 every authenticated Supabase
-- query:
--
--   1. Migration 056 STEP 1 dropped all policies on every table with
--      venue_id / wedding_id / org_id, including interactions and drafts,
--      while STEP 3 deliberately skipped recreating those two (comment:
--      "handled in 055"). Net effect of running 056 after 055 was zero
--      policies on interactions + drafts. RLS enabled + zero policies =
--      deny-all, so the inbox endpoint returned 200 OK [].
--
--   2. Migration 056 created super_admin_all policies using an inline
--      EXISTS subquery against user_profiles. When that policy evaluates
--      on user_profiles itself it recurses infinitely. Every other table's
--      RLS subqueries user_profiles too, so the recursion cascaded and the
--      REST API 500'd on every request.
--
-- Migration 056 has been edited to (a) exclude interactions + drafts from
-- the drop loop and (b) use public.is_super_admin() instead of the inline
-- EXISTS form. This migration 062 is the hotfix for any production DB
-- that has already been poisoned by the old 056.
--
-- It is fully idempotent and safe to re-run at any time.
--
-- WHAT IT DOES
--   A. Creates / replaces public.is_super_admin() (SECURITY DEFINER).
--   B. Rewrites every policy whose name matches '%super_admin%' to call
--      is_super_admin() instead of inline user_profiles EXISTS.
--   C. If interactions or drafts have zero policies, re-installs the
--      canonical set from migration 055 so the tables are never stuck in
--      deny-all.
--   D. Runs a final audit that RAISES EXCEPTION if any RLS-enabled table
--      in the public schema has zero policies. That turns the worst
--      outcome (silent deny-all) into a loud migration failure.
-- ============================================================================

-- ── A. Ensure the SECURITY DEFINER helper exists ────────────────────────────
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $func$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid() AND role = 'super_admin'
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated, anon;

-- ── B. Rewrite every super_admin policy to use the helper ───────────────────
-- We match any policy whose qual or with_check references user_profiles
-- with role = 'super_admin' inline. We drop and recreate it in place
-- using the same command and the same name, but with USING/WITH CHECK
-- switched to public.is_super_admin().
DO $$
DECLARE rec RECORD;
BEGIN
  FOR rec IN
    SELECT tablename, policyname, cmd
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname LIKE '%super_admin%'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', rec.policyname, rec.tablename);
    IF rec.cmd = 'SELECT' THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_super_admin())',
        rec.policyname, rec.tablename);
    ELSIF rec.cmd = 'INSERT' THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.is_super_admin())',
        rec.policyname, rec.tablename);
    ELSIF rec.cmd = 'UPDATE' THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.is_super_admin()) WITH CHECK (public.is_super_admin())',
        rec.policyname, rec.tablename);
    ELSIF rec.cmd = 'DELETE' THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.is_super_admin())',
        rec.policyname, rec.tablename);
    ELSE
      -- ALL (and any unexpected value falls through here)
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_super_admin()) WITH CHECK (public.is_super_admin())',
        rec.policyname, rec.tablename);
    END IF;
  END LOOP;
END $$;

-- ── C. Self-heal interactions + drafts if they got wiped ────────────────────
-- If the canonical 055 policies are missing (count = 0), reinstall them.
-- We gate on policy count instead of name so this also fixes the case
-- where someone manually renamed or partially dropped them.
DO $$
DECLARE c INT;
BEGIN
  SELECT COUNT(*) INTO c
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'interactions';

  IF c = 0 THEN
    ALTER TABLE public.interactions ENABLE ROW LEVEL SECURITY;

    CREATE POLICY "interactions_select_venue_isolation" ON public.interactions
      FOR SELECT TO authenticated
      USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

    CREATE POLICY "interactions_insert_venue_isolation" ON public.interactions
      FOR INSERT TO authenticated
      WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

    CREATE POLICY "interactions_update_venue_isolation" ON public.interactions
      FOR UPDATE TO authenticated
      USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))
      WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

    CREATE POLICY "interactions_delete_venue_isolation" ON public.interactions
      FOR DELETE TO authenticated
      USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

    CREATE POLICY "interactions_super_admin" ON public.interactions
      FOR ALL TO authenticated
      USING (public.is_super_admin())
      WITH CHECK (public.is_super_admin());
  END IF;

  SELECT COUNT(*) INTO c
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'drafts';

  IF c = 0 THEN
    ALTER TABLE public.drafts ENABLE ROW LEVEL SECURITY;

    CREATE POLICY "drafts_select_venue_isolation" ON public.drafts
      FOR SELECT TO authenticated
      USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

    CREATE POLICY "drafts_insert_venue_isolation" ON public.drafts
      FOR INSERT TO authenticated
      WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

    CREATE POLICY "drafts_update_venue_isolation" ON public.drafts
      FOR UPDATE TO authenticated
      USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))
      WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

    CREATE POLICY "drafts_delete_venue_isolation" ON public.drafts
      FOR DELETE TO authenticated
      USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

    CREATE POLICY "drafts_super_admin" ON public.drafts
      FOR ALL TO authenticated
      USING (public.is_super_admin())
      WITH CHECK (public.is_super_admin());
  END IF;
END $$;

-- ── D. Fail loud if any RLS-enabled table has zero policies ─────────────────
-- Deny-all tables are the silent failure mode that wasted a day. Make
-- future migrations fail here rather than produce an empty inbox.
DO $$
DECLARE
  offender TEXT;
  bad_tables TEXT;
BEGIN
  SELECT string_agg(c.relname, ', ')
  INTO bad_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_policies p
    ON p.schemaname = n.nspname AND p.tablename = c.relname
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relrowsecurity = true
    -- Reference tables legitimately have no per-user policies; list them
    -- explicitly rather than silently skipping all empties.
    AND c.relname NOT IN (
      'schema_migrations'
    )
  GROUP BY c.relname
  HAVING COUNT(p.policyname) = 0;

  IF bad_tables IS NOT NULL THEN
    RAISE EXCEPTION
      'RLS guard failed: the following public tables have RLS enabled but zero policies (deny-all): %. Fix before shipping.',
      bad_tables;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
