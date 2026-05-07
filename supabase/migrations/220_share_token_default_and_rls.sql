-- ============================================
-- 220_share_token_default_and_rls.sql
-- ============================================
--
-- Two round-4 audit fixes on wedding_website_settings:
--
-- F1 — share_token had no DEFAULT.
--   Mig 218 added share_token NOT NULL and backfilled existing rows,
--   but new INSERTs from src/app/_couple-pages/website/page.tsx upsert
--   without supplying a token. Brand-new couples (who haven't published
--   their wedding website yet) hit a NOT NULL violation on first save,
--   AND the round-3 read-only checklist Share button silently fails
--   because the row doesn't exist with a token. Fix: add a default that
--   mints a fresh 32-char hex (16-byte) token on insert.
--
-- F3 — share_token leaks cross-couple via permissive RLS.
--   Mig 038 created auth_select_wedding_website_settings as
--   USING(true) for authenticated. Any logged-in couple can read any
--   other couple's share_token. Closing this means scoping the SELECT
--   policy to the user's own wedding (via user_profiles.wedding_id).
--
-- Idempotent: ALTER COLUMN SET DEFAULT, DROP POLICY IF EXISTS,
-- CREATE POLICY.
--
-- 2026-05-07 fixup: this migration originally referenced
-- user_profiles.wedding_id in the F3 SELECT policy, but the column was
-- only added later in mig 226 (couple-role RLS pathway). Apply order
-- inverted, so re-running 220 against a fresh schema would fail with
-- "column up.wedding_id does not exist". Added the column-add inline
-- here so 220 is self-contained. Mig 226 then layers helper functions
-- + the broader couple_read/write policy set on top of this column.
-- The IF NOT EXISTS guard makes both migrations idempotent in either
-- order.
-- ============================================

-- ----------------------------------------------------------------------
-- F0: prerequisite — user_profiles.wedding_id (originally mig 226)
-- ----------------------------------------------------------------------

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_user_profiles_wedding ON public.user_profiles(wedding_id);

COMMENT ON COLUMN public.user_profiles.wedding_id IS
  'For role=couple users: the wedding they registered for. NULL for coordinator / org_admin / super_admin / pending-invite rows. Drives the couple_read RLS predicates.';

-- ----------------------------------------------------------------------
-- F1: share_token DEFAULT
-- ----------------------------------------------------------------------

ALTER TABLE public.wedding_website_settings
  ALTER COLUMN share_token SET DEFAULT encode(gen_random_bytes(16), 'hex');

COMMENT ON COLUMN public.wedding_website_settings.share_token IS
  '32-char hex (16-byte) random token for the guest-facing share-link. '
  'Auto-minted on INSERT via the column DEFAULT (mig 220). Required by '
  '/api/public/wedding-website action=search_guest, action=rsvp, and '
  'action=checklist. Public website rendering does NOT require it '
  '(slug-only). Per audit Lens 8 + round-3 follow-up #44.';

-- Belt-and-suspenders: the issued_at column should also auto-stamp on
-- token mint. Existing rows backfilled by 218; new inserts get NOW().
ALTER TABLE public.wedding_website_settings
  ALTER COLUMN share_token_issued_at SET DEFAULT NOW();

-- ----------------------------------------------------------------------
-- F3: tighten authenticated SELECT to wedding-scoped reads
-- ----------------------------------------------------------------------

-- Drop the wide-open authenticated SELECT introduced in 038.
DROP POLICY IF EXISTS "auth_select_wedding_website_settings"
  ON public.wedding_website_settings;
DROP POLICY IF EXISTS "wedding_website_settings_authenticated_select"
  ON public.wedding_website_settings;
DROP POLICY IF EXISTS "venue_isolation"
  ON public.wedding_website_settings;

-- Authenticated couples can read ONLY their own wedding's settings.
-- Coordinators (platform roles) read via the user_visible_venue_ids()
-- function for their venue/org scope. Super_admins bypass via
-- is_super_admin().
CREATE POLICY "wedding_website_settings_authenticated_select"
  ON public.wedding_website_settings
  FOR SELECT TO authenticated
  USING (
    -- Couple users: must match their wedding_id.
    wedding_id IN (
      SELECT up.wedding_id FROM public.user_profiles up
       WHERE up.id = auth.uid() AND up.wedding_id IS NOT NULL
    )
    -- OR coordinators: venue scope via user_visible_venue_ids() (mig 141)
    OR venue_id IN (SELECT public.user_visible_venue_ids())
    -- OR platform team
    OR public.is_super_admin()
  );

-- Authenticated INSERT/UPDATE: same scoping. Couples can only edit
-- their own wedding's settings; coordinators their venue's; admins any.
DROP POLICY IF EXISTS "auth_modify_wedding_website_settings"
  ON public.wedding_website_settings;
DROP POLICY IF EXISTS "wedding_website_settings_authenticated_modify"
  ON public.wedding_website_settings;

CREATE POLICY "wedding_website_settings_authenticated_modify"
  ON public.wedding_website_settings
  FOR ALL TO authenticated
  USING (
    wedding_id IN (
      SELECT up.wedding_id FROM public.user_profiles up
       WHERE up.id = auth.uid() AND up.wedding_id IS NOT NULL
    )
    OR venue_id IN (SELECT public.user_visible_venue_ids())
    OR public.is_super_admin()
  )
  WITH CHECK (
    wedding_id IN (
      SELECT up.wedding_id FROM public.user_profiles up
       WHERE up.id = auth.uid() AND up.wedding_id IS NOT NULL
    )
    OR venue_id IN (SELECT public.user_visible_venue_ids())
    OR public.is_super_admin()
  );

NOTIFY pgrst, 'reload schema';
