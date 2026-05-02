-- Migration 173: T5-followup-Z — org-level Essentials defaults.
--
-- Closes the multi-venue org pain point: a coordinator with three
-- venues had to set the Essentials slider per-venue per-surface, even
-- when their density preference was the same across the whole org.
--
-- Resolution chain (post-migration):
--   per-(user, venue, surface) override   — essentials_preferences.surface_overrides
--   per-(user, venue) default             — essentials_preferences.default_level
--   per-(user, org) default               — org_essentials_preferences.default_level [NEW]
--   platform default ('recommended')      — hardcoded in lib/hooks/use-essentials-level
--
-- We chose a separate table over adding org_id to essentials_preferences
-- because the org-level row has no surface_overrides column (org-level
-- per-surface tweaking is over-engineering — coordinators who want
-- per-surface tweaks can do it at the venue level).
--
-- RLS: a user reads any row whose org_id matches their user_profiles.org_id
-- (so coordinators see what their org-admin set). Only org-admins write,
-- enforced at the API layer for now until role-management lands; until
-- then this table is gated by service_role + the API checks coordinator
-- role on the user.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.org_essentials_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE UNIQUE,

  -- Default density level for everyone in this org (unless they have
  -- their own venue-level or surface-level override).
  default_level text NOT NULL DEFAULT 'recommended'
    CHECK (default_level IN ('essentials', 'recommended', 'expanded', 'everything')),

  -- Audit: who set it last.
  updated_by uuid REFERENCES public.user_profiles(id),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.org_essentials_preferences IS
  'Org-level Essentials slider defaults. Inherited by every user in the ' ||
  'org unless they have a per-(user, venue) override in essentials_preferences. ' ||
  'Per T5-followup-Z / yc LOW 19.';

ALTER TABLE public.org_essentials_preferences ENABLE ROW LEVEL SECURITY;

-- Read: anyone whose user_profiles.org_id matches.
DROP POLICY IF EXISTS "oep_select_org" ON public.org_essentials_preferences;
CREATE POLICY "oep_select_org" ON public.org_essentials_preferences
  FOR SELECT TO authenticated
  USING (
    org_id IN (
      SELECT up.org_id FROM public.user_profiles up
       WHERE up.id = auth.uid() AND up.org_id IS NOT NULL
    )
  );

-- Write: service_role only for now. Role-management will tighten this
-- when it lands; until then the API gates by coordinator role.
DROP POLICY IF EXISTS "oep_service" ON public.org_essentials_preferences;
CREATE POLICY "oep_service" ON public.org_essentials_preferences
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.org_essentials_preferences_touch()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_org_essentials_preferences_touch
  ON public.org_essentials_preferences;
CREATE TRIGGER trg_org_essentials_preferences_touch
  BEFORE UPDATE ON public.org_essentials_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.org_essentials_preferences_touch();
