-- 411, the storage half only, for the Supabase SQL editor.
-- The migration runner (exec_sql) is not the owner of storage.objects, so
-- STEP 1 (bucket flags and mime types) and STEP 2 (storage.objects policies)
-- raise a WARNING there and do nothing. Paste this whole file into the SQL
-- editor of the project you are bringing up to date (production was done on
-- 2026-09-15 via the bundle; the e2e test project ciwqxwohczzthvzqqgjx needs
-- it too). Idempotent. STEP 0's helpers are included because the policies
-- reference them.
--
-- Verify after: node scripts/check-live-policies.mjs [--env .env.test]
-- ============================================================================

-- STEP 0 - helpers
-- ===========================================================================
-- Storage paths are text. The venue or wedding id sits in a path segment,
-- and a segment that is not a uuid must not raise 22P02 inside a policy
-- predicate (an error there is a 500, not a denial). try_uuid turns a bad
-- segment into NULL, and both access helpers return false on NULL.

CREATE OR REPLACE FUNCTION public.try_uuid(p_text text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
AS $try_uuid$
BEGIN
  RETURN p_text::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$try_uuid$;

COMMENT ON FUNCTION public.try_uuid(text) IS
  'Migration 411. Cast to uuid or NULL. Used by the storage.objects '
  'policies so a path segment that is not a uuid denies rather than '
  'raising 22P02 from inside a policy predicate.';

-- The venue predicate every scoped policy in this repo writes out
-- longhand (own venue, or any venue in the caller's org, or super
-- admin). SECURITY DEFINER so a policy on a storage object can read
-- user_profiles and venues without tripping their own RLS.

CREATE OR REPLACE FUNCTION public.can_access_venue(p_venue_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $can_access_venue$
  SELECT p_venue_id IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM public.user_profiles up
          WHERE up.id = auth.uid() AND up.venue_id = p_venue_id
       )
       OR EXISTS (
         SELECT 1 FROM public.venues v
           JOIN public.user_profiles up ON up.org_id = v.org_id
          WHERE up.id = auth.uid() AND v.id = p_venue_id
       )
       OR public.is_super_admin()
     )
$can_access_venue$;

COMMENT ON FUNCTION public.can_access_venue(uuid) IS
  'Migration 411. True when the calling authenticated user may act on '
  'this venue: it is their own venue, or it belongs to their org, or '
  'they are a super admin. The same predicate migrations 401 and 407 '
  'write inline; factored out so the storage policies can use it.';

CREATE OR REPLACE FUNCTION public.can_access_wedding(p_wedding_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $can_access_wedding$
  SELECT p_wedding_id IS NOT NULL
     AND (
       p_wedding_id = public.couple_user_wedding_id()
       OR EXISTS (
         SELECT 1 FROM public.weddings w
          WHERE w.id = p_wedding_id
            AND public.can_access_venue(w.venue_id)
       )
     )
$can_access_wedding$;

COMMENT ON FUNCTION public.can_access_wedding(uuid) IS
  'Migration 411. True when the calling authenticated user may act on '
  'this wedding: they are the couple on it (migration 226 helper), or '
  'they can access its venue. Used by the couple-photos, inspo-gallery, '
  'contracts, vendor-contracts and day-of-media storage policies.';

REVOKE ALL ON FUNCTION public.try_uuid(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_access_venue(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_access_wedding(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.try_uuid(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_venue(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_wedding(uuid) TO authenticated, service_role;

-- Phone normalisation for STEP 6. Digits only, then an E.164-ish form.
-- A bare 10-digit string is treated as North American, which is what
-- every number in this database is today; anything else keeps whatever
-- country code it arrived with. Deliberately dumb: its only job is to
-- make "+1 (540) 555-0101" and "15405550101" collide.

CREATE OR REPLACE FUNCTION public.normalise_e164(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $normalise_e164$
  SELECT CASE
    WHEN p_raw IS NULL THEN NULL
    WHEN regexp_replace(p_raw, '[^0-9]', '', 'g') = '' THEN NULL
    WHEN length(regexp_replace(p_raw, '[^0-9]', '', 'g')) = 10
      THEN '+1' || regexp_replace(p_raw, '[^0-9]', '', 'g')
    ELSE '+' || regexp_replace(p_raw, '[^0-9]', '', 'g')
  END
$normalise_e164$;

COMMENT ON FUNCTION public.normalise_e164(text) IS
  'Migration 411. Crude E.164 normaliser for the twilio number claims '
  'table. Strips everything but digits; a 10-digit string is assumed '
  'North American. Its only job is to make two spellings of one number '
  'collide on a unique index.';


-- ===========================================================================
-- STEP 1 - storage bucket flags and mime types
-- ===========================================================================
-- Migration 028 created five buckets with public = true and did not set
-- allowed_mime_types on any of them. Migration 225 dropped the table-level
-- anon policies but never touched storage, so the buckets stayed as 028
-- left them.
--
-- WHAT FLIPS TO PRIVATE, AND WHY
--   contracts         private. Every reader already asks for a signed URL
--                     (src/lib/services/contracts/generate.ts ~323,
--                     src/components/couple/contract-library.tsx ~694), so
--                     nothing in tree depends on the public object route.
--   vendor-contracts  private. Same: src/app/_couple-pages/vendors/page.tsx
--                     ~512 signs its URLs.
--   day-of-media      private. This is the bucket the coordinator asked
--                     for by name. See the note under STEP 2 about the one
--                     reader that still builds a public URL.
--
-- WHAT STAYS PUBLIC, AND WHY
--   couple-photos     the couple's own wedding website renders these to
--                     logged-out guests (src/app/_couple-pages/website/
--                     page.tsx ~233 stores a getPublicUrl result in the
--                     saved site settings). That is a genuine public read
--                     path, so the flag stays and the fix is the policy
--                     work in STEP 2: dropping the anon SELECT policy ends
--                     anonymous LISTING of the bucket, which is what let
--                     one couple walk another couple's folder. Fetching an
--                     exact known path stays possible, as it must for the
--                     public site to work.
--   inspo-gallery     public URLs are persisted into inspo_gallery.image_url
--                     (src/app/_couple-pages/inspo/page.tsx ~197). Flipping
--                     the flag would blank every existing image, and the
--                     swap to signed URLs is a src/ change this workstream
--                     does not own. Flag stays; anon listing and anon write
--                     both go in STEP 2. Flagged for follow-up.
--   venue-assets      logos and floor plans are rendered by email and by
--                     the public site through getPublicUrl (settings/
--                     page.tsx ~212, portal/seating-config/page.tsx ~352).
--                     Flag stays; SVG is excluded below because an SVG is a
--                     script that the browser will run from our origin.
--   brain-dump        already private (migration 084).
--   crm-imports       already private (migration 270).

DO $bucket_flags$
BEGIN
  UPDATE storage.buckets
     SET public = false
   WHERE id IN ('contracts', 'vendor-contracts', 'day-of-media');

  UPDATE storage.buckets
     SET public = true
   WHERE id IN ('couple-photos', 'inspo-gallery', 'venue-assets');

  UPDATE storage.buckets
     SET public = false
   WHERE id IN ('brain-dump', 'crm-imports');

  -- No SVG. Everything else here is what the three venue-asset upload
  -- surfaces actually send: images for logos and floor plans, documents
  -- for the couple-facing resources list.
  UPDATE storage.buckets
     SET allowed_mime_types = ARRAY[
       'image/png',
       'image/jpeg',
       'image/webp',
       'image/gif',
       'image/avif',
       'image/heic',
       'application/pdf',
       'application/msword',
       'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
       'text/plain',
       'text/csv'
     ]
   WHERE id = 'venue-assets';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING
    '411 STEP 1 skipped: the runner is not the owner of storage.buckets. '
    'Paste STEP 1 into the Supabase SQL editor, then re-run '
    'scripts/check-live-policies.mjs.';
END
$bucket_flags$;


-- ===========================================================================
-- STEP 2 - storage.objects policies
-- ===========================================================================
-- Before: migration 028 gave anon SELECT / INSERT / UPDATE / DELETE on
-- couple-photos, inspo-gallery, vendor-contracts, contracts and
-- venue-assets with `bucket_id = '<name>'` as the entire predicate.
-- Anyone holding the anon key (it ships to every browser) could list,
-- overwrite or delete any venue's contracts. Migrations 084 and 270 did
-- the authenticated equivalent for brain-dump and crm-imports: any signed-
-- in user of any venue could read every venue's uploads. 097 gave
-- day-of-media a public flag and an anon SELECT policy.
--
-- After: no anon policy on any of these buckets, and every authenticated
-- policy carries a `(storage.foldername(name))[1]` predicate resolving to
-- a venue or wedding the caller may access. The service role bypasses RLS
-- and is unchanged, so every server-side path keeps working.
--
-- PATH SHAPES, read out of src/ rather than assumed:
--   couple-photos     {weddingId}/...        _couple-pages/couple-photo ~210,
--                                            photos ~215, website ~231,
--                                            components/couple/couple-photo-prompt ~73
--   inspo-gallery     {weddingId}/...        _couple-pages/inspo ~195
--   vendor-contracts  {weddingId}/...        _couple-pages/vendors ~508
--   contracts         {weddingId}/...        lib/services/contracts/generate.ts ~308,
--                                            components/couple/contract-library ~684
--   venue-assets      TWO shapes, both live:
--                       {venueId}/...              settings ~468,
--                                                  portal/venue-assets-config ~100
--                       venue-assets/{venueId}/... settings ~205 (logo),
--                                                  portal/seating-config ~335 (floor plan)
--                     The predicate accepts either. Narrowing to one would
--                     break a working upload, and src/ belongs to other
--                     workstreams this week.
--   brain-dump        {venueId}/...          components/shell/floating-brain-dump ~471
--   crm-imports       {venueId}/...          migration 270 header
--   day-of-media      {venueId}/{weddingId}/...
--                                            portal/weddings/[id]/_components/
--                                            day-of-memories-tab ~98
--
-- KNOWN CONSEQUENCE, day-of-media: that tab builds its image src by hand
-- as /storage/v1/object/public/day-of-media/<path> (day-of-memories-tab.tsx
-- ~42-47). Once the bucket is private those URLs 404 and the tab needs
-- createSignedUrl. That is a src/ change and is called out in the S3
-- handoff; the isolation fix is not held back for it.

DO $storage_policies$
DECLARE
  v_sql text;
  v_stmts text[] := ARRAY[
    -- --- sweep: every policy on storage.objects that mentions one of the
    -- --- nine buckets in scope, whatever it is called. Named drops would
    -- --- miss a policy added by hand in the dashboard, and a single
    -- --- surviving bucket-id-only policy re-opens the whole bucket
    -- --- because permissive policies are OR-ed.
    $s$DO $sweep$
      DECLARE p record;
      BEGIN
        FOR p IN
          SELECT policyname
            FROM pg_policies
           WHERE schemaname = 'storage'
             AND tablename = 'objects'
             AND (
               coalesce(qual, '') || ' ' || coalesce(with_check, '')
             ) ~ '(couple-photos|inspo-gallery|vendor-contracts|contracts|venue-assets|brain-dump|crm-imports|day-of-media)'
        LOOP
          EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', p.policyname);
        END LOOP;
      END
    $sweep$$s$,

    -- --- couple-photos: wedding folder ---------------------------------
    $s$CREATE POLICY "auth_couple_photos_select" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'couple-photos'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_couple_photos_insert" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'couple-photos'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_couple_photos_update" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'couple-photos'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))
        WITH CHECK (bucket_id = 'couple-photos'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_couple_photos_delete" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'couple-photos'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,

    -- --- inspo-gallery: wedding folder ---------------------------------
    $s$CREATE POLICY "auth_inspo_gallery_select" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'inspo-gallery'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_inspo_gallery_insert" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'inspo-gallery'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_inspo_gallery_update" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'inspo-gallery'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))
        WITH CHECK (bucket_id = 'inspo-gallery'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_inspo_gallery_delete" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'inspo-gallery'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,

    -- --- vendor-contracts: wedding folder, private bucket --------------
    $s$CREATE POLICY "auth_vendor_contracts_select" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'vendor-contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_vendor_contracts_insert" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'vendor-contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_vendor_contracts_update" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'vendor-contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))
        WITH CHECK (bucket_id = 'vendor-contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_vendor_contracts_delete" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'vendor-contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,

    -- --- contracts: wedding folder, private bucket ---------------------
    $s$CREATE POLICY "auth_contracts_select" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_contracts_insert" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_contracts_update" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))
        WITH CHECK (bucket_id = 'contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_contracts_delete" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,

    -- --- venue-assets: venue folder, either path shape ------------------
    $s$CREATE POLICY "auth_venue_assets_select" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'venue-assets'
               AND (
                 public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
                 OR ((storage.foldername(name))[1] = 'venue-assets'
                     AND public.can_access_venue(public.try_uuid((storage.foldername(name))[2])))
               ))$s$,
    $s$CREATE POLICY "auth_venue_assets_insert" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'venue-assets'
               AND (
                 public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
                 OR ((storage.foldername(name))[1] = 'venue-assets'
                     AND public.can_access_venue(public.try_uuid((storage.foldername(name))[2])))
               ))$s$,
    $s$CREATE POLICY "auth_venue_assets_update" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'venue-assets'
               AND (
                 public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
                 OR ((storage.foldername(name))[1] = 'venue-assets'
                     AND public.can_access_venue(public.try_uuid((storage.foldername(name))[2])))
               ))
        WITH CHECK (bucket_id = 'venue-assets'
               AND (
                 public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
                 OR ((storage.foldername(name))[1] = 'venue-assets'
                     AND public.can_access_venue(public.try_uuid((storage.foldername(name))[2])))
               ))$s$,
    $s$CREATE POLICY "auth_venue_assets_delete" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'venue-assets'
               AND (
                 public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
                 OR ((storage.foldername(name))[1] = 'venue-assets'
                     AND public.can_access_venue(public.try_uuid((storage.foldername(name))[2])))
               ))$s$,

    -- --- brain-dump: venue folder (084 scoped on bucket id alone) -------
    $s$CREATE POLICY "auth_select_brain_dump" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'brain-dump'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_insert_brain_dump" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'brain-dump'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_update_brain_dump" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'brain-dump'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))
        WITH CHECK (bucket_id = 'brain-dump'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_delete_brain_dump" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'brain-dump'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,

    -- --- crm-imports: venue folder (270 scoped on bucket id alone) ------
    $s$CREATE POLICY "auth_select_crm_imports" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'crm-imports'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_insert_crm_imports" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'crm-imports'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_update_crm_imports" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'crm-imports'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))
        WITH CHECK (bucket_id = 'crm-imports'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_delete_crm_imports" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'crm-imports'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,

    -- --- day-of-media: venue folder then wedding folder -----------------
    $s$CREATE POLICY "auth_day_of_media_select" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'day-of-media'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[2])))$s$,
    $s$CREATE POLICY "auth_day_of_media_insert" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'day-of-media'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[2])))$s$,
    $s$CREATE POLICY "auth_day_of_media_update" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'day-of-media'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[2])))
        WITH CHECK (bucket_id = 'day-of-media'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[2])))$s$,
    $s$CREATE POLICY "auth_day_of_media_delete" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'day-of-media'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[2])))$s$
  ];
BEGIN
  FOREACH v_sql IN ARRAY v_stmts LOOP
    EXECUTE v_sql;
  END LOOP;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING
    '411 STEP 2 skipped: the runner is not the owner of storage.objects '
    '(the same reason migration 308 is not in apply-pending-migrations). '
    'Paste STEP 2 into the Supabase SQL editor, then re-run '
    'scripts/check-live-policies.mjs.';
END
$storage_policies$;


-- ===========================================================================
