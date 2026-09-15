-- ---------------------------------------------------------------------------
-- 411_security_policies.sql  (S3, 2026-09-14 security audit remediation)
-- ---------------------------------------------------------------------------
-- One migration, ten findings. Every one of them is the same shape: a
-- policy or a grant that was written when the demo was the only thing
-- reachable, and that nobody narrowed once real tenants arrived. None of
-- this is new capability. It takes away access that was never meant to be
-- there.
--
-- WHAT IS IN HERE
-- ---------------
--   STEP 0  helpers: try_uuid, can_access_venue, can_access_wedding,
--           normalise_e164
--   STEP 1  storage buckets: public flags and allowed_mime_types
--   STEP 2  storage.objects: drop every anon policy and every
--           bucket-id-only authenticated policy on the nine buckets in
--           scope; replace with folder-scoped authenticated policies
--   STEP 3  column grants on the three connection tables that had none
--           (google_ads_connections, zoom_connections,
--           openphone_connections)
--   STEP 4  demo-anon: drop the gmail_connections read, drop venue_config
--           from the demo write set, revoke anon SELECT on venue_config's
--           secret columns
--   STEP 5  env-var-name indirection: narrow the INSERT/UPDATE grants on
--           meta_ads_connections / tiktok_ads_connections /
--           instagram_connections and CHECK the env-key names
--   STEP 6  twilio_phone_numbers uniqueness across venues
--   STEP 7  team_invitations.token_hash, plus the invitation policy set
--           that let any signed-in user invite themselves as org_admin
--   STEP 8  venue_config writes gated on role
--   STEP 9  knot_template_patterns anon read
--   STEP 10 booked_vendors.portal_token_hash
--
-- OPERATOR NOTE, READ BEFORE APPLYING
-- -----------------------------------
-- STEP 1 and STEP 2 touch the `storage` schema. `public.exec_sql` runs as
-- the function owner, which is not the owner of `storage.objects`, so
-- CREATE POLICY there can come back as
-- "42501: must be owner of table objects" — the same reason migration 308
-- is absent from scripts/apply-pending-migrations.ts. Both steps are
-- therefore wrapped in a DO block with an `insufficient_privilege`
-- handler: if the runner cannot do it, the block raises a WARNING naming
-- the step and the rest of the migration still applies. Run
-- `node scripts/check-live-policies.mjs` afterwards; if the storage rows
-- still read `NEEDS 411`, paste STEP 1 and STEP 2 into the Supabase SQL
-- editor, which runs as the project owner, and re-run the script.
--
-- Idempotent throughout: IF EXISTS / IF NOT EXISTS / DROP-then-CREATE /
-- CREATE OR REPLACE. Safe to re-run. No BEGIN/COMMIT wrapper (Wave 23
-- doctrine). Schema-qualified throughout.
-- ---------------------------------------------------------------------------


-- ===========================================================================
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
-- STEP 3 - column grants on the three connection tables that had none
-- ===========================================================================
-- google_ads_connections (310), zoom_connections and openphone_connections
-- (097) all have venue-scoped SELECT policies and no column grants. RLS
-- decides which ROWS come back; without a column grant the token comes
-- back with the row, to any authenticated user of that venue. Migrations
-- 401 and 407 already do this correctly; this is the same block.
--
-- Consequence, documented in 401 and worth repeating: with a column-level
-- SELECT grant a `select('*')` from an authenticated client fails with
-- "permission denied for column access_token" rather than returning a
-- partial row. Every reader in tree names its columns, and these three
-- tables are read server-side. A new reader that reaches for * will fail
-- loudly, which is the behaviour we want on a table holding a credential.
--
-- Each block is guarded on the table existing (310 has never been applied
-- to production; it sits in the legacy list in
-- scripts/apply-pending-migrations.ts).
--
-- The column list is a DENY list resolved against information_schema at
-- apply time, not an allow list copied out of the migration. That choice
-- came from reading production rather than the files: zoom_connections
-- carries a last_synced_at that appears in no migration in this repo, and
-- an allow list transcribed from 097 would have quietly dropped it. A
-- deny list cannot drop a working column. What it can do is miss a NEW
-- secret column added later, so the name patterns below are deliberately
-- broad and scripts/check-live-policies.mjs re-reads the live grants.
--
-- `anon` is revoked too. Production has anon holding SELECT, INSERT and
-- UPDATE grants on every column of zoom_connections and
-- openphone_connections, api_key included. Only RLS stands between the
-- public anon key and an OpenPhone API key, and neither table has any
-- anon policy, so nothing is lost by taking the grant away as well.

DO $connection_grants$
DECLARE
  v_tbl text;
  v_cols text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'google_ads_connections', 'zoom_connections', 'openphone_connections'
  ] LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      RAISE NOTICE '411 STEP 3: % not present, skipping', v_tbl;
      CONTINUE;
    END IF;

    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
      INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = v_tbl
       -- The secrets themselves, not every column with "token" in the
       -- name: access_token_expires_at and token_type are metadata the
       -- settings pages read, and 401 and 407 grant their equivalents.
       AND column_name NOT IN (
         'access_token', 'refresh_token', 'api_key',
         'page_access_token', 'token_env_key', 'page_token_env_key'
       )
       AND column_name !~ '(secret|password|_api_key$)';

    IF v_cols IS NULL THEN
      RAISE WARNING '411 STEP 3: % has no grantable columns, skipping', v_tbl;
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE ALL ON public.%I FROM anon', v_tbl);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', v_tbl);
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO authenticated', v_cols, v_tbl);
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON public.%I TO authenticated', v_tbl);
  END LOOP;
END
$connection_grants$;

DO $connection_comments$
BEGIN
  IF to_regclass('public.zoom_connections') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON COLUMN public.zoom_connections.access_token IS
      'Service-role only. Migration 411 revoked the authenticated SELECT grant on this column.'$c$;
    EXECUTE $c$COMMENT ON COLUMN public.zoom_connections.refresh_token IS
      'Service-role only. Migration 411 revoked the authenticated SELECT grant on this column.'$c$;
  END IF;
  IF to_regclass('public.openphone_connections') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON COLUMN public.openphone_connections.api_key IS
      'Service-role only. Migration 411 revoked the authenticated SELECT grant on this column.'$c$;
  END IF;
  IF to_regclass('public.google_ads_connections') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON COLUMN public.google_ads_connections.refresh_token IS
      'Service-role only. Migration 411 revoked the authenticated SELECT grant on this column.'$c$;
  END IF;
END
$connection_comments$;


-- ===========================================================================
-- STEP 4 - demo-anon policies that reach credentials
-- ===========================================================================
-- 4a. gmail_connections. Migration 064 listed this table in its exclusions
-- with the reason spelled out: "OAuth tokens, defense in depth. The demo
-- venues should not have real tokens, but never expose an OAuth token
-- table to anon regardless." Migration 383 then re-added
-- demo_anon_select_gmail_connections while sweeping 65 tables. Take it
-- back off; 064's reasoning did not change.

DROP POLICY IF EXISTS "demo_anon_select_gmail_connections" ON public.gmail_connections;

-- 4b. venue_config writes. Migration 027 gave anon INSERT and UPDATE with
-- USING (true); migration 147 narrowed those to demo venues but kept
-- venue_config in the write set. A demo venue's config row holds
-- gmail_tokens, calendly_tokens and omi_webhook_token, and an anon writer
-- can overwrite omi_webhook_token to point the Omi webhook at itself.
-- Nothing in the demo needs to write venue_config: the demo is a read
-- surface, and 064 said so ("Demo users cannot INSERT/UPDATE/DELETE via
-- anon. If the demo ever needs interactive write actions, route them
-- through API routes that use the service client").

DROP POLICY IF EXISTS "anon_insert_venue_config" ON public.venue_config;
DROP POLICY IF EXISTS "anon_update_venue_config" ON public.venue_config;
DROP POLICY IF EXISTS "anon_delete_venue_config" ON public.venue_config;
DROP POLICY IF EXISTS "anon_select_venue_config" ON public.venue_config;

-- 4c. venue_config reads. The demo genuinely reads this table (business
-- name, brand colours, portal copy), so the row-level demo policy from
-- 392 stays. What goes is anon's access to the secret COLUMNS.
--
-- Column-level revoke, not a view: every demo reader queries
-- `venue_config` by name from the browser (40-odd call sites under src/app),
-- so a view under another name would need all of them changed, and src/
-- belongs to other workstreams this week. The revoke lands in place and
-- costs nothing to a reader that names its columns.
--
-- Deny-list is by name pattern plus the three known ones, so a secret
-- added to this table before 411 lands is covered without an edit here.
-- A column added AFTER 411 is not granted to anon at all, which is the
-- right default.
--
-- KNOWN CONSEQUENCE: src/app/(platform)/settings/page.tsx ~349 does
-- select('*') on venue_config. As `authenticated` that is unaffected.
-- In demo mode the platform shell runs on `anon`, so the demo settings
-- page will get "permission denied for column gmail_tokens" until that
-- one call names its columns. Flagged in the S3 handoff.

DO $venue_config_anon_cols$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'venue_config'
     AND column_name NOT IN ('gmail_tokens', 'calendly_tokens', 'omi_webhook_token')
     AND column_name !~ '(token|secret|password|api_key)';

  IF v_cols IS NULL THEN
    RAISE WARNING '411 STEP 4c: venue_config has no grantable columns, skipping';
    RETURN;
  END IF;

  EXECUTE 'REVOKE ALL ON public.venue_config FROM anon';
  EXECUTE format('GRANT SELECT (%s) ON public.venue_config TO anon', v_cols);
END
$venue_config_anon_cols$;


-- ===========================================================================
-- STEP 5 - env-var-name indirection on the three ad / social connections
-- ===========================================================================
-- Migrations 401 and 407 got the SELECT side right and then granted
-- INSERT, UPDATE, DELETE at table level. Table-level DML means a venue
-- user can write any column on their own row, and two of those columns
-- are not data:
--
--   token_env_key / page_token_env_key name an environment variable. The
--   connector reads process.env[<that name>]. A venue user who sets it to
--   any other variable name makes the server hand them, or use on their
--   behalf, a secret they were never given.
--
--   ig_business_id is the webhook routing key, with a unique index on it.
--   A venue user who writes another venue's Instagram business id into
--   their own row claims that venue's inbound DMs. status is the same
--   shape of problem one step down: flip it to 'connected' and the
--   connector starts trying.
--
-- These columns are written by the OAuth callback under the service role.
-- The grants below say so. DELETE stays at table level: it is row-shaped,
-- and RLS already confines it to the caller's own venue.

-- Deny list, same reasoning as STEP 3: a column added to one of these
-- tables after 407 must keep working, and only the named six are the
-- problem. `status` is in the list because flipping it to 'connected'
-- starts the connector; `ig_business_id` because it is the webhook
-- routing key and has a unique index, so writing another venue's id
-- claims their inbound DMs.

DO $connection_dml_grants$
DECLARE
  v_tbl text;
  v_cols text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'meta_ads_connections', 'tiktok_ads_connections', 'instagram_connections'
  ] LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      RAISE NOTICE '411 STEP 5: % not present, skipping', v_tbl;
      CONTINUE;
    END IF;

    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
      INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = v_tbl
       AND column_name NOT IN (
         'token_env_key', 'page_token_env_key',
         'access_token', 'refresh_token', 'page_access_token',
         'status', 'ig_business_id'
       );

    IF v_cols IS NULL THEN
      RAISE WARNING '411 STEP 5: % has no grantable columns, skipping', v_tbl;
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE ALL ON public.%I FROM anon', v_tbl);
    EXECUTE format('REVOKE INSERT, UPDATE ON public.%I FROM authenticated', v_tbl);
    EXECUTE format('GRANT INSERT (%s) ON public.%I TO authenticated', v_cols, v_tbl);
    EXECUTE format('GRANT UPDATE (%s) ON public.%I TO authenticated', v_cols, v_tbl);
    EXECUTE format('GRANT DELETE ON public.%I TO authenticated', v_tbl);
  END LOOP;
END
$connection_dml_grants$;

-- The shape an env-var name is allowed to take. Belt to the grants'
-- braces: even a service-role write, or a future widening of the grants,
-- cannot point the connector at ANTHROPIC_API_KEY.
--
-- NOT VALID so the ALTER never scans and never blocks. The VALIDATE
-- afterwards is attempted separately and downgraded to a warning if an
-- existing row does not match, so a badly-shaped value already in the
-- table stops the constraint being trusted without stopping the
-- migration. NULL passes a CHECK, so a row with no env key is fine.

DO $env_key_checks$
DECLARE
  v_target record;
BEGIN
  FOR v_target IN
    SELECT *
      FROM (VALUES
        ('meta_ads_connections',   'token_env_key',      'meta_ads_connections_token_env_key_shape'),
        ('tiktok_ads_connections', 'token_env_key',      'tiktok_ads_connections_token_env_key_shape'),
        ('instagram_connections',  'page_token_env_key', 'instagram_connections_page_token_env_key_shape')
      ) AS t(tbl, col, conname)
  LOOP
    IF to_regclass('public.' || v_target.tbl) IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = v_target.tbl
         AND column_name = v_target.col
    ) THEN CONTINUE; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = v_target.conname
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I '
        'CHECK (%I IS NULL OR %I ~ %L) NOT VALID',
        v_target.tbl, v_target.conname, v_target.col, v_target.col,
        '^(META_ADS|TIKTOK_ADS|INSTAGRAM)_VENUE_[A-Z0-9_]+$'
      );
    END IF;

    BEGIN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
                     v_target.tbl, v_target.conname);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING
        '411 STEP 5: %.% holds a value that is not a %%_VENUE_%% env-var '
        'name, so % stays NOT VALID. Fix the row, then run '
        'ALTER TABLE public.% VALIDATE CONSTRAINT %.',
        v_target.tbl, v_target.col, v_target.conname, v_target.tbl, v_target.conname;
    END;
  END LOOP;
END
$env_key_checks$;


-- ===========================================================================
-- STEP 6 - one phone number, one venue
-- ===========================================================================
-- multi_channel_inbox_settings.twilio_phone_numbers (migration 295) is a
-- text[] with no constraint of any kind. Two venues can both list
-- +15405550101, and the Twilio webhook resolves an inbound message to a
-- venue by looking the number up. Whichever row the lookup happens to
-- return gets the other venue's couple's message.
--
-- WHY A CLAIMS TABLE RATHER THAN AN EXCLUSION CONSTRAINT
-- An EXCLUDE constraint with the array-overlap operator needs a GiST
-- opclass for text[], which core Postgres does not ship (intarray covers
-- int[] only). btree_gist does not help either. That leaves a helper
-- table, which is the better answer anyway: a plain unique index on one
-- normalised number per row, a visible record of which venue owns which
-- number, and a clean 23505 at write time instead of a silent misroute at
-- read time. The trigger keeps it in step with the array, so nothing in
-- src/ has to change for the constraint to hold.

CREATE TABLE IF NOT EXISTS public.twilio_number_claims (
  phone_e164 text PRIMARY KEY,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.twilio_number_claims IS
  'owner:agent. Migration 411. One row per Twilio number, keyed on the '
  'normalised E.164 form, so two venues cannot both claim a number. '
  'Maintained by a trigger on multi_channel_inbox_settings; never write '
  'it by hand. A collision surfaces as 23505 on the settings write.';

CREATE INDEX IF NOT EXISTS idx_twilio_number_claims_venue
  ON public.twilio_number_claims (venue_id);

ALTER TABLE public.twilio_number_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "twilio_number_claims_select" ON public.twilio_number_claims;
CREATE POLICY "twilio_number_claims_select" ON public.twilio_number_claims
  FOR SELECT TO authenticated
  USING (public.can_access_venue(venue_id));

DROP POLICY IF EXISTS "twilio_number_claims_service" ON public.twilio_number_claims;
CREATE POLICY "twilio_number_claims_service" ON public.twilio_number_claims
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.twilio_number_claims FROM anon;
REVOKE ALL ON public.twilio_number_claims FROM authenticated;
GRANT SELECT ON public.twilio_number_claims TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_twilio_number_claims()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $sync_twilio_number_claims$
DECLARE
  v_n text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.twilio_number_claims WHERE venue_id = OLD.venue_id;
    RETURN OLD;
  END IF;

  -- Release everything this venue used to hold, then re-claim what it
  -- now lists. A number moved from venue A to venue B works as long as
  -- A gives it up first, which is the honest constraint.
  DELETE FROM public.twilio_number_claims WHERE venue_id = NEW.venue_id;

  IF NEW.twilio_phone_numbers IS NOT NULL THEN
    FOREACH v_n IN ARRAY NEW.twilio_phone_numbers LOOP
      IF public.normalise_e164(v_n) IS NOT NULL THEN
        INSERT INTO public.twilio_number_claims (phone_e164, venue_id)
        VALUES (public.normalise_e164(v_n), NEW.venue_id);
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$sync_twilio_number_claims$;

COMMENT ON FUNCTION public.sync_twilio_number_claims() IS
  'Migration 411. Keeps twilio_number_claims in step with '
  'multi_channel_inbox_settings.twilio_phone_numbers. A number already '
  'claimed by another venue raises 23505, which is the point.';

DO $twilio_trigger$
BEGIN
  IF to_regclass('public.multi_channel_inbox_settings') IS NULL THEN
    RAISE NOTICE '411 STEP 6: multi_channel_inbox_settings not present, skipping trigger';
    RETURN;
  END IF;

  DROP TRIGGER IF EXISTS trg_sync_twilio_number_claims
    ON public.multi_channel_inbox_settings;
  CREATE TRIGGER trg_sync_twilio_number_claims
    AFTER INSERT OR UPDATE OR DELETE ON public.multi_channel_inbox_settings
    FOR EACH ROW EXECUTE FUNCTION public.sync_twilio_number_claims();
END
$twilio_trigger$;

-- Backfill. Report a collision rather than picking a winner: whichever
-- venue is meant to own the number, this migration is not the place to
-- decide it.
DO $twilio_backfill$
DECLARE
  v_dup record;
  v_row record;
  v_n text;
BEGIN
  IF to_regclass('public.multi_channel_inbox_settings') IS NULL THEN RETURN; END IF;

  FOR v_dup IN
    SELECT public.normalise_e164(n) AS phone, count(DISTINCT venue_id) AS venues
      FROM public.multi_channel_inbox_settings s,
           unnest(coalesce(s.twilio_phone_numbers, '{}'::text[])) AS n
     WHERE public.normalise_e164(n) IS NOT NULL
     GROUP BY 1
    HAVING count(DISTINCT venue_id) > 1
  LOOP
    RAISE WARNING
      '411 STEP 6: % is listed by % venues. Only the first claim is '
      'recorded; decide the owner and remove the number from the others.',
      v_dup.phone, v_dup.venues;
  END LOOP;

  FOR v_row IN SELECT venue_id, twilio_phone_numbers
                 FROM public.multi_channel_inbox_settings
  LOOP
    IF v_row.twilio_phone_numbers IS NULL THEN CONTINUE; END IF;
    FOREACH v_n IN ARRAY v_row.twilio_phone_numbers LOOP
      IF public.normalise_e164(v_n) IS NOT NULL THEN
        INSERT INTO public.twilio_number_claims (phone_e164, venue_id)
        VALUES (public.normalise_e164(v_n), v_row.venue_id)
        ON CONFLICT (phone_e164) DO NOTHING;
      END IF;
    END LOOP;
  END LOOP;
END
$twilio_backfill$;


-- ===========================================================================
-- STEP 7 - team_invitations
-- ===========================================================================
-- 7a. token_hash. The invite link carries a token that is stored in
-- plaintext and indexed. Anyone who can read a row can accept the invite
-- and become an org_admin. S1 changes /api/team/invite to write the hash
-- and /api/team/accept to look up by hash; the plaintext column stays for
-- the transition so an invite sent before the swap still works.

ALTER TABLE public.team_invitations
  ADD COLUMN IF NOT EXISTS token_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_team_invitations_token_hash
  ON public.team_invitations (token_hash)
  WHERE token_hash IS NOT NULL;

COMMENT ON COLUMN public.team_invitations.token_hash IS
  'Migration 411. SHA-256 of the invite token, hex. The column the accept '
  'route looks up once S1 lands. Unique where present.';

COMMENT ON COLUMN public.team_invitations.token IS
  'DEPRECATED (migration 411). Plaintext invite token, kept only so links '
  'sent before the hash swap still resolve. Stop writing it once every '
  'outstanding invitation has expired, then drop the column.';

-- 7b. the policy set. Migration 049 shipped `anon_select_invitations`
-- (FOR SELECT TO anon USING (true)) and `auth_all_invitations` (FOR ALL
-- TO authenticated USING (true)). Neither is live any more, but reading
-- production rather than the migration files turned up the same hole
-- wearing different names:
--
--   demo_anon_select_team_invitations   anon SELECT on every demo venue's
--                                       invitations. Migration 064 named
--                                       team_invitations in its exclusion
--                                       list, with the reason ("invitation
--                                       tokens"); the 383 / 392 sweeps
--                                       re-added it anyway.
--   team_invitations_modify             FOR ALL TO authenticated, venue or
--                                       org scoped, NO role gate.
--   team_invitations_org_insert/update/delete
--                                       org scoped, no role gate either.
--
-- Together those mean any signed-in coordinator can insert an invitation
-- with role = 'org_admin' and accept it. That is a one-step privilege
-- escalation, and it is why the whole set is replaced here rather than
-- one policy narrowed: permissive policies are OR-ed, so leaving any of
-- them standing leaves the escalation standing.
--
-- Nothing in tree reads this table as anon: /api/team/accept and
-- /api/team/invite both use the service client, which bypasses RLS. The
-- one browser read is the team settings page listing and revoking its own
-- org's invitations, which the two policies below still allow for the
-- roles that are supposed to be doing it.

DROP POLICY IF EXISTS "anon_select_invitations" ON public.team_invitations;
DROP POLICY IF EXISTS "auth_all_invitations" ON public.team_invitations;
DROP POLICY IF EXISTS "demo_anon_select_team_invitations" ON public.team_invitations;
DROP POLICY IF EXISTS "demo_anon_select" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_modify" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_select" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_super_admin_all" ON public.team_invitations;
DROP POLICY IF EXISTS "super_admin_all" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_org_insert" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_org_update" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_org_delete" ON public.team_invitations;

DROP POLICY IF EXISTS "team_invitations_org_select" ON public.team_invitations;
CREATE POLICY "team_invitations_org_select" ON public.team_invitations
  FOR SELECT TO authenticated
  USING (
    org_id = (SELECT up.org_id FROM public.user_profiles up WHERE up.id = auth.uid())
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "team_invitations_admin_write" ON public.team_invitations;
CREATE POLICY "team_invitations_admin_write" ON public.team_invitations
  FOR ALL TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
       WHERE up.id = auth.uid()
         AND up.org_id = team_invitations.org_id
         AND up.role IN ('org_admin', 'venue_manager')
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
       WHERE up.id = auth.uid()
         AND up.org_id = team_invitations.org_id
         AND up.role IN ('org_admin', 'venue_manager')
    )
  );

DROP POLICY IF EXISTS "team_invitations_service" ON public.team_invitations;
CREATE POLICY "team_invitations_service" ON public.team_invitations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.team_invitations FROM anon;


-- ===========================================================================
-- STEP 8 - venue_config UPDATE gated on role
-- ===========================================================================
-- Migration 058 gave every member of an org UPDATE on every venue_config
-- row in that org. venue_config.feature_flags is what turns paid
-- capability on and off, so a coordinator could grant their own venue
-- anything. The roles are the ones user_profiles actually allows
-- (migration 001 / 049 / 051: super_admin, org_admin, venue_manager,
-- coordinator, couple, readonly); the write set is the three at the top.
--
-- WHY THIS REPLACES THE WHOLE POLICY SET AND NOT JUST 058'S UPDATE
-- Permissive policies are OR-ed, so narrowing one of several is the same
-- as narrowing none. Production carries FOUR authenticated write routes
-- into this table, and only one of them is 058's:
--
--   venue_config_org_update / _insert / _delete   058, org scoped
--   venue_scope_update / _insert / _delete        the 056-062 RLS sweep
--                                                 rewrote migration 006's
--                                                 `venue_isolation` under
--                                                 this name; own venue,
--                                                 no role gate
--   super_admin_all                               is_super_admin()
--
-- Narrowing 058's UPDATE alone would have changed nothing: every
-- coordinator would still write through venue_scope_update. So the
-- authenticated set is replaced here as one coherent thing, read split
-- from write. Migration 226's `couple_read` and the demo-anon read
-- policies are left alone; neither grants a write.
--
-- INSERT and DELETE are gated on the same roles, not only UPDATE.
-- Leaving DELETE open would leave the door it closes: delete the row,
-- insert a new one, set the flags on the way in.
--
-- KNOWN CONSEQUENCE, and it is not small: RLS gates rows and not
-- columns, so this covers every column of venue_config, not just
-- feature_flags. A coordinator saving anything on the settings page
-- through the browser client (src/app/(platform)/settings/page.tsx ~382)
-- now gets nothing written back. S5 is already routing the
-- contract-template write through an API route; the rest of that page
-- needs the same treatment, or the venue hands its coordinators
-- venue_manager. Called out in the S3 handoff rather than fixed here:
-- src/ belongs to other workstreams.

DROP POLICY IF EXISTS "venue_isolation" ON public.venue_config;
DROP POLICY IF EXISTS "super_admin_bypass" ON public.venue_config;
DROP POLICY IF EXISTS "super_admin_all" ON public.venue_config;
DROP POLICY IF EXISTS "venue_scope_select" ON public.venue_config;
DROP POLICY IF EXISTS "venue_scope_insert" ON public.venue_config;
DROP POLICY IF EXISTS "venue_scope_update" ON public.venue_config;
DROP POLICY IF EXISTS "venue_scope_delete" ON public.venue_config;
DROP POLICY IF EXISTS "venue_config_org_select" ON public.venue_config;
DROP POLICY IF EXISTS "venue_config_org_insert" ON public.venue_config;
DROP POLICY IF EXISTS "venue_config_org_update" ON public.venue_config;
DROP POLICY IF EXISTS "venue_config_org_delete" ON public.venue_config;

DROP POLICY IF EXISTS "venue_config_read" ON public.venue_config;

CREATE POLICY "venue_config_read" ON public.venue_config
  FOR SELECT TO authenticated
  USING (public.can_access_venue(venue_id));

DROP POLICY IF EXISTS "venue_config_org_insert" ON public.venue_config;

CREATE POLICY "venue_config_org_insert" ON public.venue_config
  FOR INSERT TO authenticated
  WITH CHECK (
    public.can_access_venue(venue_id)
    AND EXISTS (
      SELECT 1 FROM public.user_profiles up
       WHERE up.id = auth.uid()
         AND up.role IN ('org_admin', 'venue_manager', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "venue_config_org_update" ON public.venue_config;

CREATE POLICY "venue_config_org_update" ON public.venue_config
  FOR UPDATE TO authenticated
  USING (
    public.can_access_venue(venue_id)
    AND EXISTS (
      SELECT 1 FROM public.user_profiles up
       WHERE up.id = auth.uid()
         AND up.role IN ('org_admin', 'venue_manager', 'super_admin')
    )
  )
  WITH CHECK (
    public.can_access_venue(venue_id)
    AND EXISTS (
      SELECT 1 FROM public.user_profiles up
       WHERE up.id = auth.uid()
         AND up.role IN ('org_admin', 'venue_manager', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "venue_config_org_delete" ON public.venue_config;

CREATE POLICY "venue_config_org_delete" ON public.venue_config
  FOR DELETE TO authenticated
  USING (
    public.can_access_venue(venue_id)
    AND EXISTS (
      SELECT 1 FROM public.user_profiles up
       WHERE up.id = auth.uid()
         AND up.role IN ('org_admin', 'venue_manager', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "venue_config_service" ON public.venue_config;
CREATE POLICY "venue_config_service" ON public.venue_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON COLUMN public.venue_config.feature_flags IS
  'Paid-capability switches. Migration 411 narrowed the venue_config '
  'UPDATE policy to org_admin / venue_manager / super_admin so a '
  'coordinator cannot grant their own venue a tier. Writes that a '
  'coordinator must be able to make belong in an API route running the '
  'service client.';


-- ===========================================================================
-- STEP 9 - knot_template_patterns anon read
-- ===========================================================================
-- Migration 283 added demo_anon_select_patterns as FOR SELECT TO anon
-- USING (true). The table already has a venue-scoped authenticated policy
-- in the same migration, and migration 392 re-asserts a demo policy under
-- the conventional name (demo_anon_select_knot_template_patterns) scoped
-- to is_demo venues. The USING (true) one is the leak, and it is the only
-- one that has to go.
--
-- Guarded: as of 2026-09-14 this table does not exist in production, so
-- 283 has not been applied there. `DROP POLICY IF EXISTS` still errors on
-- a missing table, which would take the rest of this migration down with
-- it. When 283 lands, replaying 411 drops the policy.

DO $knot_patterns$
BEGIN
  IF to_regclass('public.knot_template_patterns') IS NULL THEN
    RAISE NOTICE '411 STEP 9: knot_template_patterns not present (283 unapplied), skipping';
    RETURN;
  END IF;
  EXECUTE 'DROP POLICY IF EXISTS "demo_anon_select_patterns" ON public.knot_template_patterns';
END
$knot_patterns$;


-- ===========================================================================
-- STEP 10 - booked_vendors.portal_token
-- ===========================================================================
-- Migration 032 gave every booked vendor a plaintext portal token,
-- backfilled from gen_random_bytes, and a unique index on it. Same shape
-- as team_invitations: a readable row is a usable credential. Same
-- treatment, hash alongside for the transition; the code migration is a
-- later step and is not in this workstream.

ALTER TABLE public.booked_vendors
  ADD COLUMN IF NOT EXISTS portal_token_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_booked_vendors_portal_token_hash
  ON public.booked_vendors (portal_token_hash)
  WHERE portal_token_hash IS NOT NULL;

COMMENT ON COLUMN public.booked_vendors.portal_token_hash IS
  'Migration 411. SHA-256 of the vendor portal token, hex. The column the '
  'vendor portal looks up once the code migration lands. Unique where present.';

COMMENT ON COLUMN public.booked_vendors.portal_token IS
  'DEPRECATED (migration 411). Plaintext vendor portal token, kept only '
  'so links already sent still resolve. Stop writing it once the portal '
  'reads portal_token_hash, then drop the column.';


NOTIFY pgrst, 'reload schema';
