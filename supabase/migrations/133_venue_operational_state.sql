-- Migration 133: venue_operational_state (T2-B Phase 2 / LIMB-16.2.2)
--
-- Per Playbook Part 16.2.2: anomaly-detection.ts should know about
-- property-level state changes that affect tour bookings + couple
-- behaviour. Pre-T2-B Phase 2 there was no schema for this — when
-- inquiry volume dropped during a renovation period, the AI
-- hypothesis prompt had no way to learn "the barn was under
-- construction May 12 to June 18" and would chase funnel causes.
--
-- venue_operational_state captures discrete state changes:
--   - Renovation / construction periods (whole venue or specific space)
--   - Seasonal closures (off-season, holiday breaks)
--   - Capacity changes (new addition opens, existing space taken offline)
--   - Vendor changes (caterer switch, exclusive partnership added/dropped)
--   - Policy changes (price tier adjustment, weekday booking opens)
--   - Force majeure (weather damage, power outage, fire / flood remediation)
--
-- Each row is a state-window. anomaly-detection.ts intersects current
-- detection windows with these to surface "did this anomaly start
-- when the renovation began?" before chasing harder hypotheses.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, RLS DROP/CREATE.

CREATE TABLE IF NOT EXISTS public.venue_operational_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- State category. Free-form 'other' for long tail; the suggested
  -- values are what the AI hypothesis prompt is calibrated for.
  state_type text NOT NULL CHECK (state_type IN (
    'renovation',
    'closure',           -- seasonal, holiday, scheduled downtime
    'capacity_change',   -- new addition, space offline
    'vendor_change',     -- caterer / staffing / partnership
    'policy_change',     -- price tier, weekday opens, capacity policy
    'force_majeure',     -- weather, fire, flood, power
    'other'
  )),

  -- Window. start_at required; end_at NULL = ongoing. anomaly-detection
  -- treats NULL end_at as "active right now" for current-window
  -- intersection.
  start_at timestamptz NOT NULL,
  end_at timestamptz,

  -- Short title. Coordinator-readable. Surfaces in admin UI + the
  -- anomaly hypothesis prompt.
  title text NOT NULL CHECK (length(trim(title)) > 0),

  -- Free-form description. Anomaly hypothesis prompt reads this so
  -- richer context flows into the AI's reasoning.
  description text,

  -- Optional: which space is affected. NULL = whole venue.
  affected_space text,

  -- Soft delete. State history matters for retroactive anomaly
  -- analysis ("we had this same drop last year during the same
  -- renovation period").
  deleted_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT venue_operational_state_window CHECK (
    end_at IS NULL OR end_at > start_at
  )
);

CREATE INDEX IF NOT EXISTS idx_venue_operational_state_venue_window
  ON public.venue_operational_state (venue_id, start_at, end_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_venue_operational_state_active
  ON public.venue_operational_state (venue_id, end_at)
  WHERE end_at IS NULL AND deleted_at IS NULL;

COMMENT ON TABLE public.venue_operational_state IS
  'Property-level state windows (renovation, closure, vendor change, '
  'policy change, force majeure). anomaly-detection.ts reads these so '
  '"venue was in renovation" is in the hypothesis chain when inquiry / '
  'booking metrics drop. Admin UI at /portal/property-state-config. '
  'Per Playbook LIMB-16.2.2.';

ALTER TABLE public.venue_operational_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_operational_state_select" ON public.venue_operational_state;
CREATE POLICY "venue_operational_state_select" ON public.venue_operational_state
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

DROP POLICY IF EXISTS "venue_operational_state_modify" ON public.venue_operational_state;
CREATE POLICY "venue_operational_state_modify" ON public.venue_operational_state
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

DROP POLICY IF EXISTS "venue_operational_state_service" ON public.venue_operational_state;
CREATE POLICY "venue_operational_state_service" ON public.venue_operational_state
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.venue_operational_state_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_venue_operational_state_updated_at ON public.venue_operational_state;
CREATE TRIGGER trg_venue_operational_state_updated_at
  BEFORE UPDATE ON public.venue_operational_state
  FOR EACH ROW
  EXECUTE FUNCTION public.venue_operational_state_touch_updated_at();
