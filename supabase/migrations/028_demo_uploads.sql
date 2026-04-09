-- ============================================
-- 028: DEMO UPLOADS — photo_library + Storage RLS
-- ============================================
-- Fixes "new row violates row-level security policy" errors when
-- the demo couple portal (anon role) uploads photos, inspo images,
-- couple photos, vendor contracts, or venue assets.
--
-- This migration:
--   1. Adds missing columns to photo_library (is_hero, people_tags)
--      that the app was writing but the schema didn't have.
--   2. Ensures anon SELECT/INSERT/UPDATE/DELETE policies on
--      photo_library (idempotent — drops existing first).
--   3. Adds anon SELECT/INSERT/UPDATE/DELETE policies on
--      storage.objects for every bucket the couple portal uses:
--        - couple-photos     (couple-photo page)
--        - inspo-gallery     (inspo page)
--        - vendor-contracts  (vendors page)
--        - contracts         (contracts page)
--        - venue-assets      (seating-config / floor plans)
--   4. Creates the buckets if they don't exist (public read).
-- ============================================

-- ============================================
-- 1) photo_library missing columns
-- ============================================

ALTER TABLE photo_library
  ADD COLUMN IF NOT EXISTS is_hero boolean DEFAULT false;

ALTER TABLE photo_library
  ADD COLUMN IF NOT EXISTS people_tags text[] DEFAULT '{}';

-- ============================================
-- 2) photo_library RLS — idempotent anon policies
-- ============================================

ALTER TABLE photo_library ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_photo_library"   ON photo_library;
DROP POLICY IF EXISTS "anon_insert_photo_library"   ON photo_library;
DROP POLICY IF EXISTS "anon_update_photo_library"   ON photo_library;
DROP POLICY IF EXISTS "anon_delete_photo_library"   ON photo_library;

CREATE POLICY "anon_select_photo_library" ON photo_library
  FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_photo_library" ON photo_library
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_photo_library" ON photo_library
  FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_photo_library" ON photo_library
  FOR DELETE TO anon USING (true);

-- ============================================
-- 3) Ensure storage buckets exist (public read)
-- ============================================

INSERT INTO storage.buckets (id, name, public)
VALUES
  ('couple-photos',    'couple-photos',    true),
  ('inspo-gallery',    'inspo-gallery',    true),
  ('vendor-contracts', 'vendor-contracts', true),
  ('contracts',        'contracts',        true),
  ('venue-assets',     'venue-assets',     true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- ============================================
-- 4) storage.objects — anon policies per bucket
-- ============================================
-- storage.objects has RLS on by default in Supabase.
-- Each CREATE POLICY must be per-bucket because the check
-- references bucket_id.  We drop existing ones first so this
-- migration is idempotent.

-- couple-photos
DROP POLICY IF EXISTS "anon_storage_couple_photos_select" ON storage.objects;
DROP POLICY IF EXISTS "anon_storage_couple_photos_insert" ON storage.objects;
DROP POLICY IF EXISTS "anon_storage_couple_photos_update" ON storage.objects;
DROP POLICY IF EXISTS "anon_storage_couple_photos_delete" ON storage.objects;

CREATE POLICY "anon_storage_couple_photos_select" ON storage.objects
  FOR SELECT TO anon USING (bucket_id = 'couple-photos');
CREATE POLICY "anon_storage_couple_photos_insert" ON storage.objects
  FOR INSERT TO anon WITH CHECK (bucket_id = 'couple-photos');
CREATE POLICY "anon_storage_couple_photos_update" ON storage.objects
  FOR UPDATE TO anon USING (bucket_id = 'couple-photos')
  WITH CHECK (bucket_id = 'couple-photos');
CREATE POLICY "anon_storage_couple_photos_delete" ON storage.objects
  FOR DELETE TO anon USING (bucket_id = 'couple-photos');

-- inspo-gallery
DROP POLICY IF EXISTS "anon_storage_inspo_gallery_select" ON storage.objects;
DROP POLICY IF EXISTS "anon_storage_inspo_gallery_insert" ON storage.objects;
DROP POLICY IF EXISTS "anon_storage_inspo_gallery_update" ON storage.objects;
DROP POLICY IF EXISTS "anon_storage_inspo_gallery_delete" ON storage.objects;

CREATE POLICY "anon_storage_inspo_gallery_select" ON storage.objects
  FOR SELECT TO anon USING (bucket_id = 'inspo-gallery');
CREATE POLICY "anon_storage_inspo_gallery_insert" ON storage.objects
  FOR INSERT TO anon WITH CHECK (bucket_id = 'inspo-gallery');
CREATE POLICY "anon_storage_inspo_gallery_update" ON storage.objects
  FOR UPDATE TO anon USING (bucket_id = 'inspo-gallery')
  WITH CHECK (bucket_id = 'inspo-gallery');
CREATE POLICY "anon_storage_inspo_gallery_delete" ON storage.objects
  FOR DELETE TO anon USING (bucket_id = 'inspo-gallery');

-- vendor-contracts
DROP POLICY IF EXISTS "anon_storage_vendor_contracts_select" ON storage.objects;
DROP POLICY IF EXISTS "anon_storage_vendor_contracts_insert" ON storage.objects;
DROP POLICY IF EXISTS "anon_storage_vendor_contracts_update" ON storage.objects;
DROP POLICY IF EXISTS "anon_storage_vendor_contracts_delete" ON storage.objects;

CREATE POLICY "anon_storage_vendor_contracts_select" ON storage.objects
  FOR SELECT TO anon USING (bucket_id = 'vendor-contracts');
CREATE POLICY "anon_storage_vendor_contracts_insert" ON storage.objects
  FOR INSERT TO anon WITH CHECK (bucket_id = 'vendor-contracts');
CREATE POLICY "anon_storage_vendor_contracts_update" ON storage.objects
  FOR UPDATE TO anon USING (bucket_id = 'vendor-contracts')
  WITH CHECK (bucket_id = 'vendor-contracts');
CREATE POLICY "anon_storage_vendor_contracts_delete" ON storage.objects
  FOR DELETE TO anon USING (bucket_id = 'vendor-contracts');

-- contracts
DROP POLICY IF EXISTS "anon_storage_contracts_select" ON storage.objects;
DROP POLICY IF EXISTS "anon_storage_contracts_insert" ON storage.objects;
DROP POLICY IF EXISTS "anon_storage_contracts_update" ON storage.objects;
DROP POLICY IF EXISTS "anon_storage_contracts_delete" ON storage.objects;

CREATE POLICY "anon_storage_contracts_select" ON storage.objects
  FOR SELECT TO anon USING (bucket_id = 'contracts');
CREATE POLICY "anon_storage_contracts_insert" ON storage.objects
  FOR INSERT TO anon WITH CHECK (bucket_id = 'contracts');
CREATE POLICY "anon_storage_contracts_update" ON storage.objects
  FOR UPDATE TO anon USING (bucket_id = 'contracts')
  WITH CHECK (bucket_id = 'contracts');
CREATE POLICY "anon_storage_contracts_delete" ON storage.objects
  FOR DELETE TO anon USING (bucket_id = 'contracts');

-- venue-assets
DROP POLICY IF EXISTS "anon_storage_venue_assets_select" ON storage.objects;
DROP POLICY IF EXISTS "anon_storage_venue_assets_insert" ON storage.objects;
DROP POLICY IF EXISTS "anon_storage_venue_assets_update" ON storage.objects;
DROP POLICY IF EXISTS "anon_storage_venue_assets_delete" ON storage.objects;

CREATE POLICY "anon_storage_venue_assets_select" ON storage.objects
  FOR SELECT TO anon USING (bucket_id = 'venue-assets');
CREATE POLICY "anon_storage_venue_assets_insert" ON storage.objects
  FOR INSERT TO anon WITH CHECK (bucket_id = 'venue-assets');
CREATE POLICY "anon_storage_venue_assets_update" ON storage.objects
  FOR UPDATE TO anon USING (bucket_id = 'venue-assets')
  WITH CHECK (bucket_id = 'venue-assets');
CREATE POLICY "anon_storage_venue_assets_delete" ON storage.objects
  FOR DELETE TO anon USING (bucket_id = 'venue-assets');
