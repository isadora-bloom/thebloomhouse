-- 397: venue_ai_config.ai_name no longer defaults to 'Sage'
--
-- W16 (NOVEMBER-PLAN.md wave 2) found the root cause of the recurring
-- "Sage" leaks on white-label venues: migration 001 set
-- venue_ai_config.ai_name DEFAULT 'Sage', so a venue whose coordinator skipped
-- the assistant-name field got Rixey's name persisted as a real value, and
-- every app-layer neutral fallback was bypassed because the column was not
-- blank. The default is now NULL and the app supplies the neutral wording.
--
-- Rows are not touched: Rixey's assistant really is called Sage, and a venue
-- that chose the name keeps it. A venue that never chose one can clear it in
-- Settings.
--
-- Schema-qualified on purpose: scripts/run-migration.ts drives public.exec_sql
-- with search_path = pg_catalog, public.

ALTER TABLE public.venue_ai_config ALTER COLUMN ai_name DROP DEFAULT;
