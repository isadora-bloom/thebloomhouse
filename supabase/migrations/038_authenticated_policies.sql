-- Migration 038: Add authenticated role RLS policies
-- Background: Migrations 027, 028, 030 added permissive `TO anon` policies for demo mode
-- but did not add equivalent `TO authenticated` policies. Real authenticated users were
-- blocked from reading/writing ~36 tables and 5 storage buckets.
--
-- This migration adds permissive `TO authenticated` policies (USING true / WITH CHECK true)
-- as a v1 baseline. Tighten later via venue_isolation when auth model is finalized.

-- ============================================================================
-- Tables enabled by migration 027 (demo_rls_policies)
-- ============================================================================
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'onboarding_progress', 'wedding_website_settings', 'budget_items',
    'budget_payments', 'wedding_config', 'couple_budget',
    'guest_meal_options', 'bar_planning', 'bar_recipes',
    'bar_shopping_list', 'decor_inventory', 'bedroom_assignments',
    'shuttle_schedule', 'guest_care_notes', 'staffing_assignments',
    'portal_section_config', 'wedding_details', 'wedding_tables',
    'wedding_party', 'ceremony_order', 'makeup_schedule',
    'rehearsal_dinner', 'wedding_worksheets', 'photo_library',
    'borrow_catalog', 'borrow_selections', 'accommodations',
    'allergy_registry', 'rsvp_config', 'rsvp_responses',
    'section_finalisations', 'booked_vendors', 'storefront',
    'venue_assets', 'venue_resources'
  ];
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    -- SELECT
    EXECUTE format('DROP POLICY IF EXISTS "auth_select_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "auth_select_%s" ON %I FOR SELECT TO authenticated USING (true)', t, t);
    -- INSERT
    EXECUTE format('DROP POLICY IF EXISTS "auth_insert_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "auth_insert_%s" ON %I FOR INSERT TO authenticated WITH CHECK (true)', t, t);
    -- UPDATE
    EXECUTE format('DROP POLICY IF EXISTS "auth_update_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "auth_update_%s" ON %I FOR UPDATE TO authenticated USING (true) WITH CHECK (true)', t, t);
    -- DELETE
    EXECUTE format('DROP POLICY IF EXISTS "auth_delete_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "auth_delete_%s" ON %I FOR DELETE TO authenticated USING (true)', t, t);
  END LOOP;
END $$;

-- ============================================================================
-- Tables from migration 030 (guest_tags)
-- ============================================================================

-- guest_tags
DROP POLICY IF EXISTS "auth_select_guest_tags" ON guest_tags;
CREATE POLICY "auth_select_guest_tags" ON guest_tags FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "auth_insert_guest_tags" ON guest_tags;
CREATE POLICY "auth_insert_guest_tags" ON guest_tags FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "auth_update_guest_tags" ON guest_tags;
CREATE POLICY "auth_update_guest_tags" ON guest_tags FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "auth_delete_guest_tags" ON guest_tags;
CREATE POLICY "auth_delete_guest_tags" ON guest_tags FOR DELETE TO authenticated USING (true);

-- guest_tag_assignments
DROP POLICY IF EXISTS "auth_select_guest_tag_assignments" ON guest_tag_assignments;
CREATE POLICY "auth_select_guest_tag_assignments" ON guest_tag_assignments FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "auth_insert_guest_tag_assignments" ON guest_tag_assignments;
CREATE POLICY "auth_insert_guest_tag_assignments" ON guest_tag_assignments FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "auth_update_guest_tag_assignments" ON guest_tag_assignments;
CREATE POLICY "auth_update_guest_tag_assignments" ON guest_tag_assignments FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "auth_delete_guest_tag_assignments" ON guest_tag_assignments;
CREATE POLICY "auth_delete_guest_tag_assignments" ON guest_tag_assignments FOR DELETE TO authenticated USING (true);

-- ============================================================================
-- Storage bucket policies (from migration 028)
-- ============================================================================

-- couple-photos bucket
DROP POLICY IF EXISTS "auth_select_couple_photos" ON storage.objects;
CREATE POLICY "auth_select_couple_photos" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'couple-photos');
DROP POLICY IF EXISTS "auth_insert_couple_photos" ON storage.objects;
CREATE POLICY "auth_insert_couple_photos" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'couple-photos');
DROP POLICY IF EXISTS "auth_update_couple_photos" ON storage.objects;
CREATE POLICY "auth_update_couple_photos" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'couple-photos') WITH CHECK (bucket_id = 'couple-photos');
DROP POLICY IF EXISTS "auth_delete_couple_photos" ON storage.objects;
CREATE POLICY "auth_delete_couple_photos" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'couple-photos');

-- inspo-gallery bucket
DROP POLICY IF EXISTS "auth_select_inspo_gallery" ON storage.objects;
CREATE POLICY "auth_select_inspo_gallery" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'inspo-gallery');
DROP POLICY IF EXISTS "auth_insert_inspo_gallery" ON storage.objects;
CREATE POLICY "auth_insert_inspo_gallery" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'inspo-gallery');
DROP POLICY IF EXISTS "auth_update_inspo_gallery" ON storage.objects;
CREATE POLICY "auth_update_inspo_gallery" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'inspo-gallery') WITH CHECK (bucket_id = 'inspo-gallery');
DROP POLICY IF EXISTS "auth_delete_inspo_gallery" ON storage.objects;
CREATE POLICY "auth_delete_inspo_gallery" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'inspo-gallery');

-- vendor-contracts bucket
DROP POLICY IF EXISTS "auth_select_vendor_contracts" ON storage.objects;
CREATE POLICY "auth_select_vendor_contracts" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'vendor-contracts');
DROP POLICY IF EXISTS "auth_insert_vendor_contracts" ON storage.objects;
CREATE POLICY "auth_insert_vendor_contracts" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'vendor-contracts');
DROP POLICY IF EXISTS "auth_update_vendor_contracts" ON storage.objects;
CREATE POLICY "auth_update_vendor_contracts" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'vendor-contracts') WITH CHECK (bucket_id = 'vendor-contracts');
DROP POLICY IF EXISTS "auth_delete_vendor_contracts" ON storage.objects;
CREATE POLICY "auth_delete_vendor_contracts" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'vendor-contracts');

-- contracts bucket
DROP POLICY IF EXISTS "auth_select_contracts" ON storage.objects;
CREATE POLICY "auth_select_contracts" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'contracts');
DROP POLICY IF EXISTS "auth_insert_contracts" ON storage.objects;
CREATE POLICY "auth_insert_contracts" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'contracts');
DROP POLICY IF EXISTS "auth_update_contracts" ON storage.objects;
CREATE POLICY "auth_update_contracts" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'contracts') WITH CHECK (bucket_id = 'contracts');
DROP POLICY IF EXISTS "auth_delete_contracts" ON storage.objects;
CREATE POLICY "auth_delete_contracts" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'contracts');

-- venue-assets bucket
DROP POLICY IF EXISTS "auth_select_venue_assets_bucket" ON storage.objects;
CREATE POLICY "auth_select_venue_assets_bucket" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'venue-assets');
DROP POLICY IF EXISTS "auth_insert_venue_assets_bucket" ON storage.objects;
CREATE POLICY "auth_insert_venue_assets_bucket" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'venue-assets');
DROP POLICY IF EXISTS "auth_update_venue_assets_bucket" ON storage.objects;
CREATE POLICY "auth_update_venue_assets_bucket" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'venue-assets') WITH CHECK (bucket_id = 'venue-assets');
DROP POLICY IF EXISTS "auth_delete_venue_assets_bucket" ON storage.objects;
CREATE POLICY "auth_delete_venue_assets_bucket" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'venue-assets');
