-- Migration 136: onboarding_projects (T2-A / Subsystem E NEW BUILD)
--
-- Per Playbook Part 18 + ARCH-18.x: Wedgewood-scale onboarding needs
-- a structured first-week project, not a 15-minute wizard. The
-- existing /(platform)/onboarding/page.tsx (15-min wizard) is kept
-- for friend-of-Isadora venues; the 5-day project flow is the
-- enterprise / paid-plan path.
--
-- onboarding_projects rows track the project lifecycle:
--   - When the project started + target go-live date
--   - Which day they're on (1-5) and which step within the day
--   - Per-day completion timestamps (Day 1 OAuth + email backfill;
--     Day 2-3 marketing channels + pricing reconstruction; Day 3-4
--     CRM ingestion; Day 4-5 voice DNA + KB; End of week intelligence
--     live)
--   - Readiness gate state — must hit minimum data-volume thresholds
--     in each limb (Internal / External / Forensic) before Go Live
--   - Confidence-flag summary (B-39) — every imported row stamps
--     a confidence_flag; the project tracks the aggregate
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, RLS DROP/CREATE.

CREATE TABLE IF NOT EXISTS public.onboarding_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Lifecycle.
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'paused', 'go_live_pending', 'live', 'archived')),
  started_at timestamptz NOT NULL DEFAULT now(),
  target_go_live timestamptz,
  completed_at timestamptz,

  -- Day-by-day progress. current_day is 1-5 while in_progress, then
  -- 5 once Day 5 finishes (status flips to go_live_pending until the
  -- readiness gate passes + coordinator clicks Go Live).
  current_day integer NOT NULL DEFAULT 1 CHECK (current_day >= 1 AND current_day <= 5),
  current_step_key text,

  -- Per-day completion timestamps. NULL = not yet completed. Once a
  -- day completes the orchestrator sets the corresponding column.
  day_1_completed_at timestamptz,  -- OAuth + email backfill
  day_2_completed_at timestamptz,  -- marketing channels seeded
  day_3_completed_at timestamptz,  -- pricing reconstruction + CRM exports queued
  day_4_completed_at timestamptz,  -- voice DNA seeded from imports
  day_5_completed_at timestamptz,  -- KB seeded; readiness gate evaluated

  -- Readiness gate state (data-volume thresholds per limb). Updated
  -- by onboarding-readiness.ts on every gate evaluation.
  readiness_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  readiness_passed_at timestamptz,
  readiness_failures jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Audit trail. Coordinator notes per step ("Catered email backfill
  -- done — note 23 false-positive new_inquiry rows the auto-cleanup
  -- caught"). Free-form. JSON shape allows the UI to namespace per
  -- step / per day.
  coordinator_notes jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One active project per venue. Coordinator can only have one
-- in_progress / paused / go_live_pending project at a time. After
-- live or archived, a new project can start (e.g. major venue
-- relaunch, ownership change).
CREATE UNIQUE INDEX IF NOT EXISTS uq_onboarding_projects_active
  ON public.onboarding_projects (venue_id)
  WHERE status IN ('in_progress', 'paused', 'go_live_pending');

CREATE INDEX IF NOT EXISTS idx_onboarding_projects_venue_status
  ON public.onboarding_projects (venue_id, status);

COMMENT ON TABLE public.onboarding_projects IS
  '5-day onboarding project orchestration row. Per-venue, one active '
  'project at a time. Tracks day-by-day completion + readiness gate '
  'state. Sits beside the existing 15-min wizard at /onboarding for '
  'enterprise paid-plan venues. Per Playbook Part 18 / T2-A.';

ALTER TABLE public.onboarding_projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "onboarding_projects_select" ON public.onboarding_projects;
CREATE POLICY "onboarding_projects_select" ON public.onboarding_projects
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "onboarding_projects_modify" ON public.onboarding_projects;
CREATE POLICY "onboarding_projects_modify" ON public.onboarding_projects
  FOR ALL TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "onboarding_projects_service" ON public.onboarding_projects;
CREATE POLICY "onboarding_projects_service" ON public.onboarding_projects
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.onboarding_projects_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_onboarding_projects_updated_at ON public.onboarding_projects;
CREATE TRIGGER trg_onboarding_projects_updated_at
  BEFORE UPDATE ON public.onboarding_projects
  FOR EACH ROW
  EXECUTE FUNCTION public.onboarding_projects_touch_updated_at();
