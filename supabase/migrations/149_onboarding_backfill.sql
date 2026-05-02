-- Migration 149: 12-month historical backfill tracking + paid-venue
-- enforcement (ARCH-18.2 / ARCH-18.3-C / ARCH-18.3-D / LIMB-16.3).
--
-- Per Playbook Part 18.2: paid venues require ≥12 months of historical
-- Internal + External Context loaded BEFORE Go Live. Without it the
-- macro-correlation USP (LIMB-17.4) can't fire on Day 1; the venue
-- sees a blank intel layer for the first 6-12 months and the source-
-- quality scorecard has no signal to compute against. Pre-fix:
--   - 5-day onboarding-project allowed Go Live with 90 days of email
--     and zero historical Internal/External context.
--   - No category-by-category tracking → coordinators couldn't see
--     what's missing.
--   - No paid-venue gate → free demo and paid plans both Go-Live'd
--     identically.
--
-- This migration adds:
--   1. venues.requires_backfill (bool) — true for paid plans, false
--      for demo / free / starter. activateLive checks this gate.
--   2. onboarding_backfill_progress — per-venue, per-category row
--      tracking which categories have ≥12mo coverage. Status check
--      computed from canonical-table date ranges + recorded here for
--      auditability.
--
-- Idempotent.

-- =====================================================================
-- 1. venues.requires_backfill
-- =====================================================================

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS requires_backfill boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.venues.requires_backfill IS
  'True for paid-plan venues (intelligence + above) — Go Live blocked '
  'until onboarding_backfill_progress shows >=80% category coverage of '
  '12-month Internal + External Context. Set true at plan-tier upgrade. '
  'Per Playbook ARCH-18.2.';

-- Backfill: any venue currently on intelligence-tier or above gets
-- requires_backfill=true. Demo + starter stay false. Looks up
-- plan_tier from venues row directly.
UPDATE public.venues
   SET requires_backfill = true
 WHERE plan_tier IS NOT NULL
   AND plan_tier IN ('intelligence', 'pro', 'enterprise')
   AND requires_backfill = false;

-- =====================================================================
-- 2. onboarding_backfill_progress
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.onboarding_backfill_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Category being tracked. Each is computed independently against
  -- a different canonical table:
  --   email_history     → interactions.timestamp coverage
  --   marketing_spend   → marketing_spend.month coverage (per source)
  --   pricing_history   → pricing_history.changed_at coverage
  --   absences          → coordinator_absences.start_at coverage
  --   property_state    → venue_operational_state.start_at coverage
  --   marketing_channels → marketing_channels.activated_at presence
  --   weather           → weather_data.date coverage
  --   search_trends     → search_trends.week coverage
  --   fred              → fred_observations.date coverage (when present)
  --   cultural_moments  → cultural_moments.start_at coverage (>= 1 confirmed)
  category text NOT NULL CHECK (category IN (
    'email_history',
    'marketing_spend',
    'pricing_history',
    'absences',
    'property_state',
    'marketing_channels',
    'weather',
    'search_trends',
    'fred',
    'cultural_moments'
  )),

  -- Coverage status the backfill orchestrator computes:
  --   not_started — zero rows in canonical table
  --   partial      — some rows, but < 12 months of coverage
  --   complete     — >= 12 months of coverage
  --   skipped      — coordinator explicitly opted out (e.g., venue
  --                  has no historical pricing — brand-new venue)
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN (
    'not_started', 'partial', 'complete', 'skipped'
  )),

  -- Earliest + latest date the orchestrator found in the canonical
  -- table. Both null for not_started. Used to render the coordinator
  -- a "you have data from X to Y" line.
  oldest_at timestamptz,
  newest_at timestamptz,

  -- Number of canonical rows the orchestrator counted. Sanity check
  -- for dashboards (5 weather rows in 365 days suggests fetch failed
  -- even if oldest_at says 12mo back).
  row_count integer NOT NULL DEFAULT 0,

  -- When status='skipped': the coordinator's reason (free text).
  -- Audit trail so a future audit can see what was waived.
  skipped_reason text,
  skipped_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,

  -- Last time the orchestrator recomputed coverage for this
  -- (venue, category). Drives staleness — categories not refreshed
  -- in >24h get re-evaluated on next backfill-status check.
  last_evaluated_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_onboarding_backfill_progress_venue_category
  ON public.onboarding_backfill_progress (venue_id, category);

CREATE INDEX IF NOT EXISTS idx_onboarding_backfill_progress_venue_status
  ON public.onboarding_backfill_progress (venue_id, status);

COMMENT ON TABLE public.onboarding_backfill_progress IS
  'Per-venue, per-category 12-month historical backfill coverage. '
  'Driven by the backfill-status orchestrator (lib/services/onboarding-'
  'backfill.ts) which recomputes coverage from canonical tables. '
  'Powers the /onboarding/project Day 5 readiness checklist + '
  'the paid-venue Go Live gate. Per Playbook ARCH-18.3-C / 18.3-D / '
  'LIMB-16.3.';

ALTER TABLE public.onboarding_backfill_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "obp_select" ON public.onboarding_backfill_progress;
CREATE POLICY "obp_select" ON public.onboarding_backfill_progress
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid() AND up.role IN ('org_admin', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "obp_service" ON public.onboarding_backfill_progress;
CREATE POLICY "obp_service" ON public.onboarding_backfill_progress
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.onboarding_backfill_progress_touch()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_onboarding_backfill_progress_touch
  ON public.onboarding_backfill_progress;
CREATE TRIGGER trg_onboarding_backfill_progress_touch
  BEFORE UPDATE ON public.onboarding_backfill_progress
  FOR EACH ROW
  EXECUTE FUNCTION public.onboarding_backfill_progress_touch();
