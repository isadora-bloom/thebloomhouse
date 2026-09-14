-- 412: correct migration 400's tangential_signals comment
--
-- Wave 9, W68 (NOVEMBER-PLAN.md; HANDLE-IDENTITY-SPEC.md §4 and §5).
--
-- Migration 400 stamped "DEPRECATED ... No new rows" on
-- public.tangential_signals on 2026-09-09. That was true of the vision
-- path W24 converted and of nothing else. A verification pass on
-- 2026-09-14 found four live writers still filling the table:
--
--   src/lib/services/crm-import/site-visitors.ts      (website pixel)
--   src/lib/services/crm-import/storefront-activity.ts (Knot / WW funnel)
--   src/lib/services/crm-import/web-form.ts            (form submissions)
--   src/lib/services/ingestion/platform-signals.ts     (every platform CSV)
--
-- So the schema was telling readers one thing and the code was doing
-- another, which is worse than a table nobody had got round to retiring:
-- a comment that lies is read as fact by whoever arrives next.
--
-- W68 routed all four through linkSignal. The website pixel's anonymous
-- visitors, the storefront's partial names and the platform CSVs' handles
-- and display names all now land as fragments, which get promoted onto a
-- couple by exact (platform, handle) the moment a real identity arrives.
-- The web-form row was simply redundant: W35 already hands every committed
-- CSV row to linkSignal, so that adapter was recording one submission
-- twice in two identity systems. `scripts/check-no-tangential-writes.mjs`
-- fails CI on any insert or upsert into this table under src/, so the
-- comment below is now enforced rather than asserted.
--
-- COMMENT ONLY. No DDL, no grant change, no data change. The historical
-- rows stay exactly where they are: the correlation engine, the journey
-- narrative, the erasure sweep and several intel surfaces read them, and
-- a wipe-and-reimport is the wrong moment to lose evidence.
--
-- Idempotent, schema-qualified: scripts/run-migration.ts drives
-- public.exec_sql with search_path = pg_catalog, public.

COMMENT ON TABLE public.tangential_signals IS
  'DEPRECATED. Historical read-only pool of partial-identity signals: vision-extracted '
  'candidates (retired wave 3 W24, 2026-09-09) plus website-pixel visits, storefront funnel '
  'rows, web-form submissions and platform CSV engagement (retired wave 9 W68, 2026-09-14). '
  'No new rows from any path: every one of them now builds a NormalizedSignal and calls '
  'linkSignal, so a below-threshold signal lands in public.fragments instead. Fragments carry '
  'handles and are promoted onto a couple by exact (platform, handle), which is the promotion '
  'this pool never had. Enforced by scripts/check-no-tangential-writes.mjs. See '
  'HANDLE-IDENTITY-SPEC.md sections 4 and 5, src/lib/services/ingestion/tangential-signals.ts '
  'for the reference conversion, and migration 400 for the original deprecation.';
