-- Migration 155: Essentials slider preferences (T4-D / Playbook
-- Part 20.4 + 20.5).
--
-- Per-coordinator default density + per-surface override. Coordinator
-- can dial information density up/down on each work surface and the
-- system remembers. Slider learning loop: track dismiss/expand actions
-- so the system can suggest a tighter / looser default after enough
-- evidence.
--
-- 4 positions: 'essentials' | 'recommended' | 'expanded' | 'everything'.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.essentials_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Default density level for this user at this venue.
  default_level text NOT NULL DEFAULT 'recommended'
    CHECK (default_level IN ('essentials', 'recommended', 'expanded', 'everything')),

  -- Per-surface overrides. Surface keys: '/agent/leads', '/agent/pipeline',
  -- '/intel/clients', '/intel/insights', '/pulse', etc.
  -- Shape: { "/agent/leads": "essentials", "/intel/insights": "expanded" }
  surface_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_essentials_preferences_user_venue
  ON public.essentials_preferences (user_id, venue_id);

COMMENT ON TABLE public.essentials_preferences IS
  'Per-coordinator information-density preferences. default_level + '
  'per-surface overrides. Drives the Essentials slider on every '
  'platform surface. Per Playbook Part 20.4 / T4-D.';

-- Slider learning events — coordinator action telemetry that feeds
-- the suggestion engine ("you dismiss every expanded card on /pulse;
-- want to set /pulse to recommended?").
CREATE TABLE IF NOT EXISTS public.essentials_action_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Surface where the action happened.
  surface text NOT NULL,
  -- Level the surface was rendering at the time of the action.
  level_at_action text NOT NULL
    CHECK (level_at_action IN ('essentials', 'recommended', 'expanded', 'everything')),

  -- What the coordinator did:
  --   'dismissed_card'   — closed a card without acting
  --   'expanded_card'    — clicked into a "show more" detail
  --   'changed_level'    — moved the slider (delta encoded in metadata)
  --   'reset_to_default' — surface override removed
  action text NOT NULL CHECK (action IN (
    'dismissed_card', 'expanded_card', 'changed_level', 'reset_to_default'
  )),

  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_essentials_action_log_user_surface
  ON public.essentials_action_log (user_id, surface, created_at DESC);

COMMENT ON TABLE public.essentials_action_log IS
  'Coordinator slider-action telemetry. Powers the suggestion engine: '
  'after N dismissals at expanded level on a surface, prompt '
  '"want to set this surface to recommended?". Per Part 20.5 transparency.';

-- RLS: users see + write their own only.
ALTER TABLE public.essentials_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.essentials_action_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ep_select_own" ON public.essentials_preferences;
CREATE POLICY "ep_select_own" ON public.essentials_preferences
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "ep_upsert_own" ON public.essentials_preferences;
CREATE POLICY "ep_upsert_own" ON public.essentials_preferences
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "ep_service" ON public.essentials_preferences;
CREATE POLICY "ep_service" ON public.essentials_preferences
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "eal_insert_own" ON public.essentials_action_log;
CREATE POLICY "eal_insert_own" ON public.essentials_action_log
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "eal_select_own" ON public.essentials_action_log;
CREATE POLICY "eal_select_own" ON public.essentials_action_log
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "eal_service" ON public.essentials_action_log;
CREATE POLICY "eal_service" ON public.essentials_action_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.essentials_preferences_touch()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_essentials_preferences_touch
  ON public.essentials_preferences;
CREATE TRIGGER trg_essentials_preferences_touch
  BEFORE UPDATE ON public.essentials_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.essentials_preferences_touch();
