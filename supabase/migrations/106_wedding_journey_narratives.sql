-- ---------------------------------------------------------------------------
-- 106_wedding_journey_narratives.sql
-- ---------------------------------------------------------------------------
-- Phase C / PC.3 (2026-04-29). AI-generated journey narrative per
-- wedding, surfaced at the top of the lead detail page. Reads from
-- Phase B's candidate_identities + tangential_signals + the existing
-- wedding_touchpoints + interactions, asks Claude to produce a one-
-- to-two-sentence narrative of how the couple discovered + engaged.
--
-- Why a separate table instead of a column on weddings:
--   * Cache invalidation has its own logic (regenerate when signal
--     count or attribution count drifts), not tied to weddings rows.
--   * AI cost is non-trivial at scale; we want explicit metadata
--     (generated_at, signal_count_at_generation, attribution_count_at_generation,
--     model) so we can audit and re-batch if a model changes.
--   * `weddings.notes` is human-edited; we don't want AI overwriting
--     coordinator notes or vice versa.
--
-- Cache contract: lazy generation. First /intel/clients/[id] view
-- triggers gen if no row exists. Subsequent views return cached.
-- Stale detection: when current candidate signal_count for the
-- wedding's resolved candidates exceeds signal_count_at_generation
-- by more than 2, OR attribution_count drifts, the narrative is
-- considered stale and regenerated on next view. Tracking the
-- counts at generation lets us decide cheaply without re-fetching
-- every signal.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.wedding_journey_narratives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL UNIQUE REFERENCES public.weddings(id) ON DELETE CASCADE,
  narrative_text text NOT NULL,
  -- Counts captured at generation time so cache staleness is cheap
  -- to detect.
  signal_count_at_generation integer NOT NULL DEFAULT 0,
  attribution_count_at_generation integer NOT NULL DEFAULT 0,
  model text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by text DEFAULT 'auto',
  -- Coordinator can pin a narrative they like so re-generation
  -- doesn't overwrite a hand-curated one. Pin overrides staleness.
  pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.wedding_journey_narratives IS
  'Phase C / PC.3 (2026-04-29). One AI-generated journey paragraph per wedding. Cached lazily; regenerated when Phase B signal/attribution counts drift past the snapshot. Coordinator can pin to lock in a curated narrative.';

CREATE INDEX IF NOT EXISTS idx_journey_narratives_venue
  ON public.wedding_journey_narratives (venue_id);

ALTER TABLE public.wedding_journey_narratives ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "journey_narratives_select" ON public.wedding_journey_narratives;
CREATE POLICY "journey_narratives_select" ON public.wedding_journey_narratives
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

DROP POLICY IF EXISTS "journey_narratives_update" ON public.wedding_journey_narratives;
CREATE POLICY "journey_narratives_update" ON public.wedding_journey_narratives
  FOR UPDATE TO authenticated
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

DROP POLICY IF EXISTS "demo_anon_select" ON public.wedding_journey_narratives;
CREATE POLICY "demo_anon_select" ON public.wedding_journey_narratives
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

CREATE OR REPLACE FUNCTION public.journey_narratives_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journey_narratives_updated_at ON public.wedding_journey_narratives;
CREATE TRIGGER trg_journey_narratives_updated_at
  BEFORE UPDATE ON public.wedding_journey_narratives
  FOR EACH ROW
  EXECUTE FUNCTION public.journey_narratives_touch_updated_at();

NOTIFY pgrst, 'reload schema';
