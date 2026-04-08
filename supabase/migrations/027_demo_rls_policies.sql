-- ============================================
-- 027: DEMO MODE RLS POLICIES
-- ============================================
-- The demo couple portal uses the Supabase anon key without an
-- authenticated user.  Existing RLS policies require auth.uid(),
-- which returns NULL for anon → 406 / silent empty results.
--
-- This migration adds permissive SELECT, INSERT and UPDATE policies
-- for the `anon` role on every couple-portal table so the demo
-- works out of the box.
--
-- For tables that already have RLS enabled (from 006 or 016),
-- we only add the anon policies.
-- For tables created in later migrations without RLS, we also
-- enable RLS first.
-- ============================================

-- ============================================
-- HELPER: idempotent "IF NOT EXISTS" isn't available for
-- CREATE POLICY in all PG versions, so we use DO blocks.
-- ============================================

-- ============================================
-- A) Tables that ALREADY have RLS enabled (from 006_rls_policies)
--    Just add anon SELECT + INSERT + UPDATE policies.
-- ============================================

-- checklist_items
CREATE POLICY "anon_select_checklist_items" ON checklist_items FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_checklist_items" ON checklist_items FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_checklist_items" ON checklist_items FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- guest_list
CREATE POLICY "anon_select_guest_list" ON guest_list FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_guest_list" ON guest_list FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_guest_list" ON guest_list FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- seating_tables
CREATE POLICY "anon_select_seating_tables" ON seating_tables FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_seating_tables" ON seating_tables FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_seating_tables" ON seating_tables FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- seating_assignments
CREATE POLICY "anon_select_seating_assignments" ON seating_assignments FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_seating_assignments" ON seating_assignments FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_seating_assignments" ON seating_assignments FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- sage_conversations
CREATE POLICY "anon_select_sage_conversations" ON sage_conversations FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_sage_conversations" ON sage_conversations FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_sage_conversations" ON sage_conversations FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- contracts
CREATE POLICY "anon_select_contracts" ON contracts FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_contracts" ON contracts FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_contracts" ON contracts FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- messages
CREATE POLICY "anon_select_messages" ON messages FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_messages" ON messages FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_messages" ON messages FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- vendor_recommendations
CREATE POLICY "anon_select_vendor_recommendations" ON vendor_recommendations FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_vendor_recommendations" ON vendor_recommendations FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_vendor_recommendations" ON vendor_recommendations FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- inspo_gallery
CREATE POLICY "anon_select_inspo_gallery" ON inspo_gallery FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_inspo_gallery" ON inspo_gallery FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_inspo_gallery" ON inspo_gallery FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- timeline
CREATE POLICY "anon_select_timeline" ON timeline FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_timeline" ON timeline FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_timeline" ON timeline FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- venue_config
CREATE POLICY "anon_select_venue_config" ON venue_config FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_venue_config" ON venue_config FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_venue_config" ON venue_config FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- venue_ai_config
CREATE POLICY "anon_select_venue_ai_config" ON venue_ai_config FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_venue_ai_config" ON venue_ai_config FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_venue_ai_config" ON venue_ai_config FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- ============================================
-- B) wedding_detail_config — RLS enabled in 016
-- ============================================

CREATE POLICY "anon_select_wedding_detail_config" ON wedding_detail_config FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_wedding_detail_config" ON wedding_detail_config FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_wedding_detail_config" ON wedding_detail_config FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- ============================================
-- C) Tables created in later migrations WITHOUT RLS.
--    Enable RLS first, then add anon policies.
-- ============================================

-- onboarding_progress (009)
ALTER TABLE onboarding_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_onboarding_progress" ON onboarding_progress FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_onboarding_progress" ON onboarding_progress FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_onboarding_progress" ON onboarding_progress FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- wedding_website_settings (009)
ALTER TABLE wedding_website_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_wedding_website_settings" ON wedding_website_settings FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_wedding_website_settings" ON wedding_website_settings FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_wedding_website_settings" ON wedding_website_settings FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- budget_items (017)
ALTER TABLE budget_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_budget_items" ON budget_items FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_budget_items" ON budget_items FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_budget_items" ON budget_items FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- budget_payments (017)
ALTER TABLE budget_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_budget_payments" ON budget_payments FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_budget_payments" ON budget_payments FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_budget_payments" ON budget_payments FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- wedding_config (017)
ALTER TABLE wedding_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_wedding_config" ON wedding_config FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_wedding_config" ON wedding_config FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_wedding_config" ON wedding_config FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- couple_budget (017)
ALTER TABLE couple_budget ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_couple_budget" ON couple_budget FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_couple_budget" ON couple_budget FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_couple_budget" ON couple_budget FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- guest_meal_options (009)
ALTER TABLE guest_meal_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_guest_meal_options" ON guest_meal_options FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_guest_meal_options" ON guest_meal_options FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_guest_meal_options" ON guest_meal_options FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- guest_tags (009/019)
ALTER TABLE guest_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_guest_tags" ON guest_tags FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_guest_tags" ON guest_tags FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_guest_tags" ON guest_tags FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- guest_tag_assignments (009/019)
ALTER TABLE guest_tag_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_guest_tag_assignments" ON guest_tag_assignments FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_guest_tag_assignments" ON guest_tag_assignments FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_guest_tag_assignments" ON guest_tag_assignments FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- bar_planning (009)
ALTER TABLE bar_planning ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_bar_planning" ON bar_planning FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_bar_planning" ON bar_planning FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_bar_planning" ON bar_planning FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- bar_recipes (009)
ALTER TABLE bar_recipes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_bar_recipes" ON bar_recipes FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_bar_recipes" ON bar_recipes FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_bar_recipes" ON bar_recipes FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- bar_shopping_list (009)
ALTER TABLE bar_shopping_list ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_bar_shopping_list" ON bar_shopping_list FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_bar_shopping_list" ON bar_shopping_list FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_bar_shopping_list" ON bar_shopping_list FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- decor_inventory (009)
ALTER TABLE decor_inventory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_decor_inventory" ON decor_inventory FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_decor_inventory" ON decor_inventory FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_decor_inventory" ON decor_inventory FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- bedroom_assignments (009)
ALTER TABLE bedroom_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_bedroom_assignments" ON bedroom_assignments FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_bedroom_assignments" ON bedroom_assignments FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_bedroom_assignments" ON bedroom_assignments FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- shuttle_schedule (009)
ALTER TABLE shuttle_schedule ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_shuttle_schedule" ON shuttle_schedule FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_shuttle_schedule" ON shuttle_schedule FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_shuttle_schedule" ON shuttle_schedule FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- guest_care_notes (009)
ALTER TABLE guest_care_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_guest_care_notes" ON guest_care_notes FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_guest_care_notes" ON guest_care_notes FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_guest_care_notes" ON guest_care_notes FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- staffing_assignments (009)
ALTER TABLE staffing_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_staffing_assignments" ON staffing_assignments FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_staffing_assignments" ON staffing_assignments FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_staffing_assignments" ON staffing_assignments FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- portal_section_config (013)
ALTER TABLE portal_section_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_portal_section_config" ON portal_section_config FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_portal_section_config" ON portal_section_config FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_portal_section_config" ON portal_section_config FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- wedding_details (014)
ALTER TABLE wedding_details ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_wedding_details" ON wedding_details FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_wedding_details" ON wedding_details FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_wedding_details" ON wedding_details FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- wedding_tables (014)
ALTER TABLE wedding_tables ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_wedding_tables" ON wedding_tables FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_wedding_tables" ON wedding_tables FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_wedding_tables" ON wedding_tables FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- wedding_party (009)
ALTER TABLE wedding_party ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_wedding_party" ON wedding_party FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_wedding_party" ON wedding_party FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_wedding_party" ON wedding_party FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- ceremony_order (009)
ALTER TABLE ceremony_order ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_ceremony_order" ON ceremony_order FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_ceremony_order" ON ceremony_order FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_ceremony_order" ON ceremony_order FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- makeup_schedule (009)
ALTER TABLE makeup_schedule ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_makeup_schedule" ON makeup_schedule FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_makeup_schedule" ON makeup_schedule FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_makeup_schedule" ON makeup_schedule FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- rehearsal_dinner (009)
ALTER TABLE rehearsal_dinner ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_rehearsal_dinner" ON rehearsal_dinner FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_rehearsal_dinner" ON rehearsal_dinner FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_rehearsal_dinner" ON rehearsal_dinner FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- wedding_worksheets (009)
ALTER TABLE wedding_worksheets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_wedding_worksheets" ON wedding_worksheets FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_wedding_worksheets" ON wedding_worksheets FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_wedding_worksheets" ON wedding_worksheets FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- photo_library (009)
ALTER TABLE photo_library ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_photo_library" ON photo_library FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_photo_library" ON photo_library FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_photo_library" ON photo_library FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- borrow_catalog (009)
ALTER TABLE borrow_catalog ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_borrow_catalog" ON borrow_catalog FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_borrow_catalog" ON borrow_catalog FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_borrow_catalog" ON borrow_catalog FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- borrow_selections (009)
ALTER TABLE borrow_selections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_borrow_selections" ON borrow_selections FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_borrow_selections" ON borrow_selections FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_borrow_selections" ON borrow_selections FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- accommodations (009)
ALTER TABLE accommodations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_accommodations" ON accommodations FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_accommodations" ON accommodations FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_accommodations" ON accommodations FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- allergy_registry (009)
ALTER TABLE allergy_registry ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_allergy_registry" ON allergy_registry FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_allergy_registry" ON allergy_registry FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_allergy_registry" ON allergy_registry FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- rsvp_config (019)
ALTER TABLE rsvp_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_rsvp_config" ON rsvp_config FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_rsvp_config" ON rsvp_config FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_rsvp_config" ON rsvp_config FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- rsvp_responses (019)
ALTER TABLE rsvp_responses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_rsvp_responses" ON rsvp_responses FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_rsvp_responses" ON rsvp_responses FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_rsvp_responses" ON rsvp_responses FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- section_finalisations (009)
ALTER TABLE section_finalisations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_section_finalisations" ON section_finalisations FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_section_finalisations" ON section_finalisations FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_section_finalisations" ON section_finalisations FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- booked_vendors (015)
ALTER TABLE booked_vendors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_booked_vendors" ON booked_vendors FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_booked_vendors" ON booked_vendors FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_booked_vendors" ON booked_vendors FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- storefront (014)
ALTER TABLE storefront ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_storefront" ON storefront FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_storefront" ON storefront FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_storefront" ON storefront FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- venue_assets (014)
ALTER TABLE venue_assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_venue_assets" ON venue_assets FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_venue_assets" ON venue_assets FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_venue_assets" ON venue_assets FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- venue_resources (014)
ALTER TABLE venue_resources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select_venue_resources" ON venue_resources FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_venue_resources" ON venue_resources FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_venue_resources" ON venue_resources FOR UPDATE TO anon USING (true) WITH CHECK (true);
