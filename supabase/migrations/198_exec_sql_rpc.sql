-- ---------------------------------------------------------------------------
-- 198_exec_sql_rpc.sql
-- ---------------------------------------------------------------------------
-- Bootstrap RPC for service-role-only ad-hoc SQL execution.
--
-- Why this exists
-- ---------------
-- Bloom House has no Supabase CLI / no psql / no DATABASE_URL exposed in
-- env.local. Every prior migration has been applied by pasting the file
-- into the dashboard SQL editor — which means migrations land later than
-- the code that depends on them, and historically two streams (FFF + GGG)
-- shipped completed but their schema bits sat un-applied for hours,
-- silently degrading every page that read the new columns. See
-- bloom-data-integrity-sweep + the 2026-05-03 wave-11 audit for the
-- specific incident.
--
-- This migration adds ONE function that lets a service-role caller
-- execute arbitrary SQL via PostgREST's `/rest/v1/rpc/exec_sql` endpoint.
-- After this lands, future migrations can be applied via
-- `scripts/run-migration.ts <path>` instead of the dashboard.
--
-- Security posture
-- ----------------
-- This function is essentially a "RUN ANY SQL AS DATABASE OWNER" primitive.
-- The defenses:
--   1. SECURITY DEFINER — runs as the function's owner (the service
--      role's database user, which has full schema access by default in
--      Supabase projects). Necessary for DDL.
--   2. EXECUTE granted ONLY to the `service_role` Postgres role.
--      Explicitly REVOKEd from PUBLIC, anon, authenticated. PostgREST
--      maps the anon JWT to `anon` and the user JWT to `authenticated`
--      — neither can call this. The service role key (used only on
--      backend trusted contexts; never sent to browsers) maps to
--      `service_role` and CAN call it.
--   3. `SET search_path = pg_catalog, public` so a malicious caller
--      can't shadow built-ins by setting their own search path.
--   4. Returns SQL errors as JSON `{ ok: false, error, state }` instead
--      of letting them propagate as PostgREST 4xx — so the runner can
--      report them with full context. Successful executions return
--      `{ ok: true }`.
--   5. STRICT-mode disabled — function runs the body even if input is
--      NULL (in which case EXECUTE NULL is a no-op, returns ok: true).
--
-- What it does NOT do
-- -------------------
-- - Does NOT split multi-statement SQL. PL/pgSQL's EXECUTE accepts a
--   single statement only. The runner script
--   (scripts/run-migration.ts) splits on top-level semicolons with
--   dollar-quote / comment / string-literal awareness before calling.
-- - Does NOT return query results. For SELECTs that need to return
--   rows, use the regular PostgREST query path. This RPC is for DDL
--   + DML side-effects only.
--
-- Idempotent: CREATE OR REPLACE; safe to re-run.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.exec_sql(sql text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $exec_sql$
BEGIN
  IF sql IS NULL OR length(trim(sql)) = 0 THEN
    RETURN json_build_object('ok', true, 'note', 'empty input');
  END IF;
  EXECUTE sql;
  RETURN json_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object(
    'ok', false,
    'error', SQLERRM,
    'state', SQLSTATE,
    'context', CASE
      WHEN length(sql) > 200 THEN substring(sql, 1, 200) || '...'
      ELSE sql
    END
  );
END;
$exec_sql$;

COMMENT ON FUNCTION public.exec_sql(text) IS
  'Service-role-only RPC for executing arbitrary single-statement SQL. '
  'Used by scripts/run-migration.ts to apply migrations without the '
  'Supabase dashboard. Returns {ok, error?, state?, context?} JSON. '
  'NEVER grant to anon/authenticated. Per migration 198 / T5-Rixey.';

-- Lock down: revoke from everyone except service_role.
-- Grants are cumulative in Postgres, so an explicit REVOKE FROM PUBLIC
-- + a single GRANT TO service_role yields the intended ACL.
REVOKE ALL ON FUNCTION public.exec_sql(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.exec_sql(text) FROM anon;
REVOKE ALL ON FUNCTION public.exec_sql(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO service_role;

-- Reload PostgREST so the RPC is callable immediately.
NOTIFY pgrst, 'reload schema';
