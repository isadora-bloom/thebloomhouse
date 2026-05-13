-- ---------------------------------------------------------------------------
-- 334_list_wedding_fk_columns.sql
-- ---------------------------------------------------------------------------
-- Step 8 / G7 (2026-05-13, bloom-identity-resolution-doctrine.md).
--
-- Why this exists
-- ---------------
-- `mergeWeddings()` in src/lib/services/identity/resolver.ts reassigns
-- every `wedding_id`-keyed FK column from the duplicate to the canonical
-- wedding. That cascade list is hand-maintained — every new migration
-- that adds a `wedding_id` column requires a human to remember to add
-- the table to the hand-list, or merges silently drop rows.
--
-- Empirical: the file already has 35+ tables; mistakes have happened
-- (e.g., notifications was assumed to have wedding_id but doesn't, and
-- earlier sweeps caught at least one table missed at migration time).
--
-- This function exposes pg_constraint as a JSON list so a CI guard
-- script can diff "what the schema says" against "what mergeWeddings
-- knows about" and fail the build on drift.
--
-- Returns
-- -------
-- json[] of { table_name, column_name } for every FK in schema 'public'
-- that targets weddings.id. Sorted by table_name, column_name.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._list_wedding_fk_columns()
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.table_name, t.column_name), '[]'::json)
  FROM (
    SELECT
      cl.relname  AS table_name,
      att.attname AS column_name
    FROM pg_constraint con
    JOIN pg_class    cl    ON cl.oid    = con.conrelid
    JOIN pg_class    refcl ON refcl.oid = con.confrelid
    JOIN pg_namespace ns   ON ns.oid    = cl.relnamespace
    JOIN pg_attribute att  ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
    WHERE con.contype = 'f'
      AND refcl.relname = 'weddings'
      AND ns.nspname    = 'public'
  ) t;
$$;

COMMENT ON FUNCTION public._list_wedding_fk_columns() IS
  'Returns every public.* FK column pointing at weddings.id. Used by '
  'scripts/check-merge-weddings-cascade.mjs to verify the hand-list in '
  'mergeWeddings stays in sync with the schema. Step 8 / G7.';

REVOKE ALL ON FUNCTION public._list_wedding_fk_columns() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._list_wedding_fk_columns() FROM anon;
REVOKE ALL ON FUNCTION public._list_wedding_fk_columns() FROM authenticated;
GRANT EXECUTE ON FUNCTION public._list_wedding_fk_columns() TO service_role;

NOTIFY pgrst, 'reload schema';
