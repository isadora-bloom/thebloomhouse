-- 410: cross-venue benchmark participation is opt-in, default off
--
-- Wave 8 follow-up to W56 (NOVEMBER-PLAN.md). Doctrine INV-24.1-A in
-- doctrine-compliance.yaml asks that a venue's numbers only ever enter
-- another venue's benchmark when the venue said yes. W56 used
-- venue_config.onboarding_completed as the only condition because it wrote
-- no migrations; this column is the real switch. benchmarkPeerSet() reads
-- it, so a venue that has not opted in is never a peer and never sees
-- peers. The demo venues are opted in by the seed so the demo shows the
-- page working.

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS benchmark_participation boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.venue_config.benchmark_participation IS
  'Opt-in to cross-venue benchmarks (doctrine INV-24.1-A). Default false. When true this venue contributes anonymised aggregates to other venues'' benchmarks and may read its own. Set from Settings by the venue, never by the platform.';
