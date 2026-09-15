-- 415_policies_reading_auth_users
--
-- Three tables carried RLS policies whose predicate selects from
-- auth.users to find the caller's email:
--
--   ceremony_chair_plans   030   couples_read/write/update_own_ceremony_plan
--   table_map_layouts      031   couples_read/write/update_own_table_map
--   brand_assets           243   couple_read_brand_assets
--
-- The authenticated role has no SELECT on auth.users, so the predicate
-- itself raises "permission denied for table users" and PostgREST answers
-- 403. Permissive policies are OR-ed, and an erroring branch fails the
-- whole check, so EVERY authenticated query on those tables was refused:
-- the couple's own ceremony-chair and table-map pages, the coordinator's
-- table-map editor (table_map_layouts never had a staff policy at all),
-- and the couple sidebar count that found it (§27 journey, 2026-09-15; a
-- live pg_policies read showed exactly these seven policies mention
-- auth.users).
--
-- Replacement: the 411 helpers. can_access_wedding(wedding_id) is true for
-- the couple on that wedding (via couple_user_wedding_id, migration 226)
-- and for staff of its venue, so one policy per command covers both.
-- brand_assets keeps its couple read, scoped through the couple's own
-- wedding rather than an email join. scripts/check-live-policies.mjs now
-- reports any policy that mentions auth.users.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- table_map_layouts
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "couples_read_own_table_map"   ON public.table_map_layouts;
DROP POLICY IF EXISTS "couples_write_own_table_map"  ON public.table_map_layouts;
DROP POLICY IF EXISTS "couples_update_own_table_map" ON public.table_map_layouts;
DROP POLICY IF EXISTS "couple_read"                  ON public.table_map_layouts;
DROP POLICY IF EXISTS "wedding_access_select"        ON public.table_map_layouts;
DROP POLICY IF EXISTS "wedding_access_insert"        ON public.table_map_layouts;
DROP POLICY IF EXISTS "wedding_access_update"        ON public.table_map_layouts;
DROP POLICY IF EXISTS "wedding_access_delete"        ON public.table_map_layouts;

CREATE POLICY "wedding_access_select" ON public.table_map_layouts
  FOR SELECT TO authenticated
  USING (public.can_access_wedding(wedding_id));
CREATE POLICY "wedding_access_insert" ON public.table_map_layouts
  FOR INSERT TO authenticated
  WITH CHECK (public.can_access_wedding(wedding_id));
CREATE POLICY "wedding_access_update" ON public.table_map_layouts
  FOR UPDATE TO authenticated
  USING (public.can_access_wedding(wedding_id))
  WITH CHECK (public.can_access_wedding(wedding_id));
CREATE POLICY "wedding_access_delete" ON public.table_map_layouts
  FOR DELETE TO authenticated
  USING (public.can_access_wedding(wedding_id));

-- ---------------------------------------------------------------------------
-- ceremony_chair_plans
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "couples_read_own_ceremony_plan"   ON public.ceremony_chair_plans;
DROP POLICY IF EXISTS "couples_write_own_ceremony_plan"  ON public.ceremony_chair_plans;
DROP POLICY IF EXISTS "couples_update_own_ceremony_plan" ON public.ceremony_chair_plans;
DROP POLICY IF EXISTS "wedding_access_select"            ON public.ceremony_chair_plans;
DROP POLICY IF EXISTS "wedding_access_insert"            ON public.ceremony_chair_plans;
DROP POLICY IF EXISTS "wedding_access_update"            ON public.ceremony_chair_plans;
DROP POLICY IF EXISTS "wedding_access_delete"            ON public.ceremony_chair_plans;

CREATE POLICY "wedding_access_select" ON public.ceremony_chair_plans
  FOR SELECT TO authenticated
  USING (public.can_access_wedding(wedding_id));
CREATE POLICY "wedding_access_insert" ON public.ceremony_chair_plans
  FOR INSERT TO authenticated
  WITH CHECK (public.can_access_wedding(wedding_id));
CREATE POLICY "wedding_access_update" ON public.ceremony_chair_plans
  FOR UPDATE TO authenticated
  USING (public.can_access_wedding(wedding_id))
  WITH CHECK (public.can_access_wedding(wedding_id));
CREATE POLICY "wedding_access_delete" ON public.ceremony_chair_plans
  FOR DELETE TO authenticated
  USING (public.can_access_wedding(wedding_id));

-- ---------------------------------------------------------------------------
-- brand_assets: the couple read, scoped through the couple's wedding
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "couple_read_brand_assets" ON public.brand_assets;

CREATE POLICY "couple_read_brand_assets" ON public.brand_assets
  FOR SELECT TO authenticated
  USING (
    couple_facing = true
    AND venue_id = (
      SELECT w.venue_id FROM public.weddings w
       WHERE w.id = public.couple_user_wedding_id()
    )
  );
