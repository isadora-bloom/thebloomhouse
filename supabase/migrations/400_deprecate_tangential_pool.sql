-- 400: the tangential identity pool is deprecated
--
-- Wave 3, W24 (NOVEMBER-PLAN.md, HANDLE-IDENTITY-SPEC.md §4 and §5).
--
-- There were two identity systems. The spine is couples, touchpoints,
-- fragments and candidate_matches, written only by linkSignal. Beside it
-- sat an older one: vision read a screenshot of comments or tags,
-- `tangential_signals` held the candidates, `candidate_identities`
-- clustered them, and `client_match_queue` asked the coordinator to
-- resolve them against `people`. It never touched a couple, so the same
-- question had two answers depending on which surface you opened.
--
-- From wave 3 the vision path builds a NormalizedSignal and calls
-- linkSignal. Below threshold the signal becomes a fragment, and a
-- fragment carrying a handle is promoted deterministically the moment
-- that handle turns up on a couple. Medium and low tier verdicts queue a
-- `candidate_matches` row, which is the one review queue.
--
-- This migration only marks. It drops nothing, revokes nothing and
-- changes no grant, because the historical rows are still read by the
-- correlation engine, the journey narrative and several intel surfaces,
-- and because a wipe-and-reimport is the wrong moment to lose evidence.
-- Idempotent, schema-qualified: scripts/run-migration.ts drives
-- public.exec_sql with search_path = pg_catalog, public.

COMMENT ON TABLE public.tangential_signals IS
  'DEPRECATED 2026-09-09 (wave 3, W24). Historical read-only pool of vision-extracted '
  'identity candidates. No new rows: the vision path now builds a NormalizedSignal and '
  'calls linkSignal, so a below-threshold candidate lands in public.fragments instead. '
  'Fragments carry handles and are promoted onto a couple by exact (platform, handle). '
  'See HANDLE-IDENTITY-SPEC.md section 4 and src/lib/services/ingestion/tangential-signals.ts.';

COMMENT ON TABLE public.client_match_queue IS
  'DEPRECATED 2026-09-09 (wave 3, W24). Historical review queue for person-to-person and '
  'signal-to-signal match proposals. No new rows: medium and low tier verdicts are queued '
  'as public.candidate_matches by linkSignal and adjudicated at /intel/identity-review. '
  'The old surface /intel/matching now redirects there. Kept for the audit trail only.';

COMMENT ON TABLE public.candidate_identities IS
  'LEGACY (wave 3, 2026-09-09). Clusters of tangential_signals, still written by '
  'candidate-clusterer.ts for the CSV and storefront import paths and resolved by '
  'candidate-resolver.ts. The handle a resolution confirms is now emitted through '
  'linkSignal onto public.couples.handles, not people.platform_handles. Phasing out '
  'behind the spine, do not build new readers.';

COMMENT ON COLUMN public.people.platform_handles IS
  'LEGACY (wave 3, 2026-09-09). Read-only. public.couples.handles is the identifier the '
  'cascade matches on, written only through linkSignal. Nothing new may read this column; '
  'scripts/check-no-platform-handles-reads.mjs holds the baseline.';
