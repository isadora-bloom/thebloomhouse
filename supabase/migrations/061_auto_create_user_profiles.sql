-- ============================================================================
-- Migration 061: Auto-create user_profiles for every auth.users row
-- ============================================================================
--
-- Every authenticated user MUST have a user_profiles row. Without one:
--   * middleware.ts redirects them to /login (the role lookup returns null,
--     which fails the allowed-role check)
--   * RLS policies keyed on `(SELECT venue_id FROM user_profiles WHERE id =
--     auth.uid())` return NULL, so interactions/etc. appear empty
--   * UserMenu shows "No role" with no way to recover in-app
--
-- We hit this for isadora@rixeymanor.com (auth id a2ab53b8…) who existed in
-- auth.users but had no profile row, so every page 403'd after login.
--
-- Fix: a SECURITY DEFINER trigger that inserts a readonly profile on every
-- auth.users insert, plus a one-time backfill for existing orphans. Team
-- invitations and explicit admin provisioning can upgrade the role/org/venue
-- afterwards — those flows already use INSERT … ON CONFLICT (id) DO UPDATE
-- or UPDATE statements, so they still work.
--
-- Default role is 'readonly' (security-conservative). An unauthorised
-- readonly user sees the dashboard shell but no data — safer than defaulting
-- to 'coordinator' with a guessed venue_id.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_profiles (id, role, first_name, last_name)
  VALUES (
    NEW.id,
    'readonly',
    NULLIF(NEW.raw_user_meta_data->>'first_name', ''),
    NULLIF(NEW.raw_user_meta_data->>'last_name', '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- ── Backfill orphans ────────────────────────────────────────────────────────
-- Any auth.users row without a matching user_profiles row gets a readonly
-- profile. Admins can upgrade via the Settings → Team UI.
INSERT INTO public.user_profiles (id, role)
SELECT u.id, 'readonly'
FROM auth.users u
LEFT JOIN public.user_profiles p ON p.id = u.id
WHERE p.id IS NULL
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
