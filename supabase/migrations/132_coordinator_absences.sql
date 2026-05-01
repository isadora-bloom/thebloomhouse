-- Migration 132: coordinator_absences (T2-B Phase 2 / LIMB-16.2.1)
--
-- Per Playbook Part 16.2.1: when anomaly detection sees a drop in
-- inquiry response time or auto-send volume, the FIRST hypothesis
-- should be "is the coordinator out?" — not "is the funnel broken?"
-- Pre-T2-B Phase 2 there was zero schema for absences, so the AI
-- hypothesis prompt always defaulted to funnel-shape causes when
-- the actual cause was a 3-day off-site.
--
-- coordinator_absences captures:
--   - WHO is out (assigned_consultant_id, optional — a venue-wide
--     "everyone closed for holiday week" leaves consultant_id NULL)
--   - WHEN they're out (start_at / end_at)
--   - WHY (free text — vacation, illness, conference, family leave,
--     "Memorial Day weekend closed")
--   - HOW the venue is covered during the absence (handoff_notes)
--
-- anomaly-detection.ts reads these into the hypothesis prompt so the
-- AI can rule out "coordinator absence" before chasing harder
-- explanations. /intel/anomalies surface clarifies hypothesis chain.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, RLS DROP/CREATE.

CREATE TABLE IF NOT EXISTS public.coordinator_absences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Optional consultant scoping. NULL = venue-wide absence (holiday
  -- closure, weather event, all-hands offsite). When set, anomaly
  -- detection scopes "drop in this consultant's leads" hypotheses.
  assigned_consultant_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,

  -- Window. Both required so anomaly detection can correlate by
  -- date range. End date is exclusive at the day boundary by
  -- convention (matches the rest of the codebase).
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,

  -- Reason taxonomy. Free text but suggested values surface in the
  -- admin UI. Used as a feature in the AI hypothesis prompt — a
  -- 'conference' absence pattern differs from 'illness'.
  reason text NOT NULL CHECK (length(trim(reason)) > 0),

  -- Where leads should route during the window. Free text — could be
  -- a name ('Mark is covering'), a system rule ('all auto-send paused'),
  -- or a coordinator note ('Jen handles tier-1 inquiries; complex ones
  -- wait until Mon').
  handoff_notes text,

  -- Soft delete (the historical record matters for retroactive anomaly
  -- analysis even after the absence is over).
  deleted_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT coordinator_absences_window CHECK (end_at > start_at)
);

CREATE INDEX IF NOT EXISTS idx_coordinator_absences_venue_window
  ON public.coordinator_absences (venue_id, start_at, end_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_coordinator_absences_consultant
  ON public.coordinator_absences (assigned_consultant_id)
  WHERE assigned_consultant_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON TABLE public.coordinator_absences IS
  'Coordinator absence windows. anomaly-detection.ts reads these so '
  '"coordinator was out" is the FIRST hypothesis when response-time '
  'or auto-send drops are detected. Admin UI at '
  '/portal/absences-config. Per Playbook LIMB-16.2.1.';

ALTER TABLE public.coordinator_absences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coordinator_absences_select" ON public.coordinator_absences;
CREATE POLICY "coordinator_absences_select" ON public.coordinator_absences
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

DROP POLICY IF EXISTS "coordinator_absences_modify" ON public.coordinator_absences;
CREATE POLICY "coordinator_absences_modify" ON public.coordinator_absences
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

DROP POLICY IF EXISTS "coordinator_absences_service" ON public.coordinator_absences;
CREATE POLICY "coordinator_absences_service" ON public.coordinator_absences
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.coordinator_absences_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_coordinator_absences_updated_at ON public.coordinator_absences;
CREATE TRIGGER trg_coordinator_absences_updated_at
  BEFORE UPDATE ON public.coordinator_absences
  FOR EACH ROW
  EXECUTE FUNCTION public.coordinator_absences_touch_updated_at();
