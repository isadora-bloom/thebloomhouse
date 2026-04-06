-- ============================================
-- CRESTWOOD COLLECTION — DEMO SEED
-- ============================================
-- Run AFTER all migrations (001-008) in Supabase SQL Editor.
-- This exercises every table and FK in the schema.
--
-- The Story: The Crestwood Collection is a Virginia-based
-- family of 4 wedding venues, each with distinct personality
-- and branding. 24 months of realistic data.
-- ============================================

-- ============================================
-- 1. ORGANISATION
-- ============================================
INSERT INTO organisations (id, name, plan_tier) VALUES
  ('11111111-1111-1111-1111-111111111111', 'The Crestwood Collection', 'enterprise');

-- ============================================
-- 2. VENUES
-- ============================================
INSERT INTO venues (id, name, slug, org_id, plan_tier, status, google_trends_metro, noaa_station_id, briefing_email, address_line1, city, state, zip, latitude, longitude) VALUES
  ('22222222-2222-2222-2222-222222222201', 'Rixey Manor', 'rixey-manor', '11111111-1111-1111-1111-111111111111', 'enterprise', 'active', 'US-VA-584', 'USW00093738', 'events@rixeymanor.com', '3186 Rixeyville Rd', 'Culpeper', 'VA', '22701', 38.4735, -77.9966);
INSERT INTO venues (id, name, slug, org_id, plan_tier, status, google_trends_metro, noaa_station_id, briefing_email, address_line1, city, state, zip, latitude, longitude) VALUES
  ('22222222-2222-2222-2222-222222222202', 'Crestwood Farm', 'crestwood-farm', '11111111-1111-1111-1111-111111111111', 'intelligence', 'active', 'US-VA-584', 'USW00093738', 'hello@crestwoodfarm.com', '1200 Ivy Creek Ln', 'Charlottesville', 'VA', '22902', 38.0293, -78.4767);
INSERT INTO venues (id, name, slug, org_id, plan_tier, status, google_trends_metro, noaa_station_id, briefing_email, address_line1, city, state, zip, latitude, longitude) VALUES
  ('22222222-2222-2222-2222-222222222203', 'The Glass House', 'the-glass-house', '11111111-1111-1111-1111-111111111111', 'enterprise', 'active', 'US-VA-556', 'USW00013740', 'info@theglasshouse.com', '500 E Broad St', 'Richmond', 'VA', '23219', 37.5407, -77.4360);
INSERT INTO venues (id, name, slug, org_id, plan_tier, status, google_trends_metro, noaa_station_id, briefing_email, address_line1, city, state, zip, latitude, longitude) VALUES
  ('22222222-2222-2222-2222-222222222204', 'Rose Hill Gardens', 'rose-hill-gardens', '11111111-1111-1111-1111-111111111111', 'starter', 'trial', 'US-DC-511', 'USW00013743', NULL, '44 Rose Hill Dr', 'Leesburg', 'VA', '20176', 39.1157, -77.5636);

-- ============================================
-- 3. VENUE CONFIG (branding per venue)
-- ============================================
INSERT INTO venue_config (id, venue_id, business_name, primary_color, secondary_color, accent_color, font_pair, timezone, catering_model, bar_model, capacity, base_price, coordinator_name, coordinator_email, coordinator_phone, portal_tagline) VALUES
  ('cccc0001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'Rixey Manor', '#7D8471', '#5D7A7A', '#A6894A', 'playfair_inter', 'America/New_York', 'byob', 'byob', 200, 8500, 'Sarah Chen', 'sarah@rixeymanor.com', '540-555-0101', 'Where your love story unfolds');
INSERT INTO venue_config (id, venue_id, business_name, primary_color, secondary_color, accent_color, font_pair, timezone, catering_model, bar_model, capacity, base_price, coordinator_name, coordinator_email, coordinator_phone, portal_tagline) VALUES
  ('cccc0001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222202', 'Crestwood Farm', '#8B7355', '#6B8E6B', '#CD853F', 'dm_nunito', 'America/New_York', 'preferred_list', 'hybrid', 150, 6500, 'Jake Williams', 'jake@crestwoodfarm.com', '434-555-0201', 'Good people. Great parties.');
INSERT INTO venue_config (id, venue_id, business_name, primary_color, secondary_color, accent_color, font_pair, timezone, catering_model, bar_model, capacity, base_price, coordinator_name, coordinator_email, coordinator_phone, portal_tagline) VALUES
  ('cccc0001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222203', 'The Glass House', '#3C3C3C', '#708090', '#C0C0C0', 'josefin_open', 'America/New_York', 'in_house', 'in_house', 250, 12000, 'Maya Patel', 'maya@theglasshouse.com', '804-555-0301', 'Modern love deserves a modern venue');
INSERT INTO venue_config (id, venue_id, business_name, primary_color, secondary_color, accent_color, font_pair, timezone, catering_model, bar_model, capacity, base_price, coordinator_name, coordinator_email, coordinator_phone, portal_tagline) VALUES
  ('cccc0001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222204', 'Rose Hill Gardens', '#B8908A', '#8FBC8F', '#DAA520', 'lora_raleway', 'America/New_York', 'byob', 'byob', 180, 9500, 'Olivia Ross', 'olivia@rosehillgardens.com', '703-555-0401', 'Bloom where you''re planted');

-- ============================================
-- 4. VENUE AI CONFIG (personalities)
-- ============================================
INSERT INTO venue_ai_config (id, venue_id, ai_name, ai_emoji, warmth_level, formality_level, playfulness_level, brevity_level, enthusiasm_level, phrase_style, vibe, follow_up_style, sales_approach, signature_greeting, signature_closer, signature_expressions) VALUES
  ('aaaa0001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'Sage', '🌿', 8, 4, 5, 6, 7, 'warm', 'romantic_timeless', 'moderate', 'consultative', 'Hi there!', 'Warmly,', '["How exciting!", "I''d love to help", "Let me know if you have any questions"]');
INSERT INTO venue_ai_config (id, venue_id, ai_name, ai_emoji, warmth_level, formality_level, playfulness_level, brevity_level, enthusiasm_level, phrase_style, vibe, follow_up_style, sales_approach, signature_greeting, signature_closer, signature_expressions) VALUES
  ('aaaa0001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222202', 'Sage', '🌿', 9, 3, 7, 5, 8, 'playful', 'rustic_charm', 'moderate', 'experience_first', 'Hey!', 'Can''t wait to meet y''all!', '["Y''all are gonna love this", "How fun!", "Let''s make some magic"]');
INSERT INTO venue_ai_config (id, venue_id, ai_name, ai_emoji, warmth_level, formality_level, playfulness_level, brevity_level, enthusiasm_level, phrase_style, vibe, follow_up_style, sales_approach, signature_greeting, signature_closer, signature_expressions) VALUES
  ('aaaa0001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222203', 'Nova', '✨', 5, 7, 3, 8, 5, 'professional', 'modern_minimal', 'light', 'direct', 'Hello,', 'Best regards,', '["I''d be happy to assist", "Please don''t hesitate to reach out", "Looking forward to connecting"]');
INSERT INTO venue_ai_config (id, venue_id, ai_name, ai_emoji, warmth_level, formality_level, playfulness_level, brevity_level, enthusiasm_level, phrase_style, vibe, follow_up_style, sales_approach, signature_greeting, signature_closer, signature_expressions) VALUES
  ('aaaa0001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222204', 'Bloom', '🌸', 8, 5, 6, 5, 7, 'enthusiastic', 'garden_romantic', 'moderate', 'consultative', 'Hello lovely!', 'With joy,', '["How beautiful!", "I can already picture it", "This is going to be wonderful"]');

-- ============================================
-- 5. AUTH USERS + USER PROFILES (4 coordinators)
-- ============================================
INSERT INTO auth.users (id, email, role, instance_id, aud, created_at, updated_at, confirmation_token, email_confirmed_at) VALUES
  ('33333333-3333-3333-3333-333333333301', 'sarah@rixeymanor.com', 'authenticated', '00000000-0000-0000-0000-000000000000', 'authenticated', now(), now(), '', now());
INSERT INTO auth.users (id, email, role, instance_id, aud, created_at, updated_at, confirmation_token, email_confirmed_at) VALUES
  ('33333333-3333-3333-3333-333333333302', 'jake@crestwoodfarm.com', 'authenticated', '00000000-0000-0000-0000-000000000000', 'authenticated', now(), now(), '', now());
INSERT INTO auth.users (id, email, role, instance_id, aud, created_at, updated_at, confirmation_token, email_confirmed_at) VALUES
  ('33333333-3333-3333-3333-333333333303', 'maya@theglasshouse.com', 'authenticated', '00000000-0000-0000-0000-000000000000', 'authenticated', now(), now(), '', now());
INSERT INTO auth.users (id, email, role, instance_id, aud, created_at, updated_at, confirmation_token, email_confirmed_at) VALUES
  ('33333333-3333-3333-3333-333333333304', 'olivia@rosehillgardens.com', 'authenticated', '00000000-0000-0000-0000-000000000000', 'authenticated', now(), now(), '', now());

INSERT INTO user_profiles (id, venue_id, org_id, role, first_name, last_name) VALUES
  ('33333333-3333-3333-3333-333333333301', '22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111111', 'venue_manager', 'Sarah', 'Chen');
INSERT INTO user_profiles (id, venue_id, org_id, role, first_name, last_name) VALUES
  ('33333333-3333-3333-3333-333333333302', '22222222-2222-2222-2222-222222222202', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Jake', 'Williams');
INSERT INTO user_profiles (id, venue_id, org_id, role, first_name, last_name) VALUES
  ('33333333-3333-3333-3333-333333333303', '22222222-2222-2222-2222-222222222203', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Maya', 'Patel');
INSERT INTO user_profiles (id, venue_id, org_id, role, first_name, last_name) VALUES
  ('33333333-3333-3333-3333-333333333304', '22222222-2222-2222-2222-222222222204', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Olivia', 'Ross');

-- ============================================
-- 6. WEDDINGS (72 across all venues, 24 months)
-- ============================================
-- Rixey Manor — 20 weddings
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000101', '22222222-2222-2222-2222-222222222201', 'completed', 'the_knot', '2024-05-18', 150, 12500, '33333333-3333-3333-3333-333333333301', '2023-11-01', '2023-11-01 02:15:00+00', '2023-11-15', '2023-12-01', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000102', '22222222-2222-2222-2222-222222222201', 'completed', 'weddingwire', '2024-06-22', 120, 9800, '33333333-3333-3333-3333-333333333301', '2023-12-15', '2023-12-15 01:30:00+00', '2024-01-10', '2024-01-25', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000103', '22222222-2222-2222-2222-222222222201', 'completed', 'google', '2024-07-13', 180, 15200, '33333333-3333-3333-3333-333333333301', '2024-01-08', '2024-01-08 03:45:00+00', '2024-01-22', '2024-02-10', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000104', '22222222-2222-2222-2222-222222222201', 'completed', 'referral', '2024-09-07', 200, 18000, '33333333-3333-3333-3333-333333333301', '2024-02-14', '2024-02-14 01:00:00+00', '2024-03-01', '2024-03-15', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000105', '22222222-2222-2222-2222-222222222201', 'completed', 'instagram', '2024-10-12', 90, 8500, '33333333-3333-3333-3333-333333333301', '2024-03-20', '2024-03-20 04:30:00+00', '2024-04-05', '2024-04-20', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000106', '22222222-2222-2222-2222-222222222201', 'completed', 'the_knot', '2024-11-02', 165, 14200, '33333333-3333-3333-3333-333333333301', '2024-04-10', '2024-04-10 02:00:00+00', '2024-04-25', '2024-05-10', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000107', '22222222-2222-2222-2222-222222222201', 'completed', 'website', '2025-03-15', 110, 10500, '33333333-3333-3333-3333-333333333301', '2024-07-20', '2024-07-20 01:15:00+00', '2024-08-05', '2024-08-20', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000108', '22222222-2222-2222-2222-222222222201', 'completed', 'weddingwire', '2025-04-26', 140, 11800, '33333333-3333-3333-3333-333333333301', '2024-09-01', '2024-09-01 02:30:00+00', '2024-09-15', '2024-10-01', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000109', '22222222-2222-2222-2222-222222222201', 'booked', 'the_knot', '2026-05-30', 175, 16000, '33333333-3333-3333-3333-333333333301', '2025-10-15', '2025-10-15 01:45:00+00', '2025-11-01', '2025-11-20', 72, 'warm');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000110', '22222222-2222-2222-2222-222222222201', 'booked', 'referral', '2026-06-20', 130, 11500, '33333333-3333-3333-3333-333333333301', '2025-11-05', '2025-11-05 00:45:00+00', '2025-11-20', '2025-12-10', 68, 'warm');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000111', '22222222-2222-2222-2222-222222222201', 'booked', 'google', '2026-09-12', 190, 17500, '33333333-3333-3333-3333-333333333301', '2025-12-01', '2025-12-01 02:00:00+00', '2025-12-15', '2026-01-05', 65, 'warm');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000112', '22222222-2222-2222-2222-222222222201', 'booked', 'instagram', '2026-10-17', 160, 14800, '33333333-3333-3333-3333-333333333301', '2026-01-10', '2026-01-10 01:30:00+00', '2026-01-25', '2026-02-10', 60, 'warm');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000113', '22222222-2222-2222-2222-222222222201', 'proposal_sent', 'weddingwire', '2026-11-07', 145, 13000, '33333333-3333-3333-3333-333333333301', '2026-02-20', '2026-02-20 03:15:00+00', '2026-03-05', NULL, 78, 'warm');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000114', '22222222-2222-2222-2222-222222222201', 'tour_scheduled', 'the_knot', NULL, 200, NULL, '33333333-3333-3333-3333-333333333301', '2026-03-15', '2026-03-15 01:00:00+00', '2026-04-01', NULL, 85, 'hot');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000115', '22222222-2222-2222-2222-222222222201', 'inquiry', 'google', NULL, 100, NULL, '33333333-3333-3333-3333-333333333301', '2026-03-24', '2026-03-24 02:30:00+00', NULL, NULL, 90, 'hot');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000116', '22222222-2222-2222-2222-222222222201', 'inquiry', 'website', NULL, 80, NULL, '33333333-3333-3333-3333-333333333301', '2026-03-26', NULL, NULL, NULL, 95, 'hot');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000117', '22222222-2222-2222-2222-222222222201', 'lost', 'the_knot', '2025-06-14', 170, NULL, '33333333-3333-3333-3333-333333333301', '2024-10-01', '2024-10-01 05:30:00+00', '2024-10-15', NULL, 0, 'frozen');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier, lost_at, lost_reason) VALUES
  ('44444444-4444-4444-4444-444444000118', '22222222-2222-2222-2222-222222222201', 'lost', 'weddingwire', '2025-08-23', 120, NULL, '33333333-3333-3333-3333-333333333301', '2024-11-15', '2024-11-15 08:00:00+00', '2024-12-01', NULL, 0, 'frozen', '2025-01-10', 'Chose another venue — budget');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000119', '22222222-2222-2222-2222-222222222201', 'completed', 'referral', '2025-05-10', 155, 13500, '33333333-3333-3333-3333-333333333301', '2024-08-15', '2024-08-15 01:00:00+00', '2024-09-01', '2024-09-15', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000120', '22222222-2222-2222-2222-222222222201', 'completed', 'google', '2025-06-28', 185, 16500, '33333333-3333-3333-3333-333333333301', '2024-10-20', '2024-10-20 01:30:00+00', '2024-11-05', '2024-11-20', 0, 'cold');

-- Crestwood Farm — 16 weddings
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000201', '22222222-2222-2222-2222-222222222202', 'completed', 'the_knot', '2024-05-04', 100, 7200, '33333333-3333-3333-3333-333333333302', '2023-10-20', '2023-10-20 03:00:00+00', '2023-11-05', '2023-11-20', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000202', '22222222-2222-2222-2222-222222222202', 'completed', 'instagram', '2024-06-15', 80, 6500, '33333333-3333-3333-3333-333333333302', '2023-12-01', '2023-12-01 02:15:00+00', '2023-12-15', '2024-01-05', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000203', '22222222-2222-2222-2222-222222222202', 'completed', 'referral', '2024-08-24', 130, 9800, '33333333-3333-3333-3333-333333333302', '2024-01-15', '2024-01-15 01:30:00+00', '2024-02-01', '2024-02-15', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000204', '22222222-2222-2222-2222-222222222202', 'completed', 'google', '2024-09-21', 110, 8200, '33333333-3333-3333-3333-333333333302', '2024-02-10', '2024-02-10 04:00:00+00', '2024-03-01', '2024-03-15', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000205', '22222222-2222-2222-2222-222222222202', 'completed', 'website', '2024-10-05', 145, 11000, '33333333-3333-3333-3333-333333333302', '2024-03-05', '2024-03-05 01:45:00+00', '2024-03-20', '2024-04-05', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000206', '22222222-2222-2222-2222-222222222202', 'completed', 'the_knot', '2024-11-16', 95, 7500, '33333333-3333-3333-3333-333333333302', '2024-04-20', '2024-04-20 02:00:00+00', '2024-05-05', '2024-05-20', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000207', '22222222-2222-2222-2222-222222222202', 'completed', 'weddingwire', '2025-04-12', 120, 9200, '33333333-3333-3333-3333-333333333302', '2024-08-01', '2024-08-01 01:30:00+00', '2024-08-15', '2024-09-01', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000208', '22222222-2222-2222-2222-222222222202', 'completed', 'referral', '2025-05-31', 140, 10500, '33333333-3333-3333-3333-333333333302', '2024-09-15', '2024-09-15 02:15:00+00', '2024-10-01', '2024-10-15', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000209', '22222222-2222-2222-2222-222222222202', 'booked', 'the_knot', '2026-06-06', 115, 8800, '33333333-3333-3333-3333-333333333302', '2025-10-01', '2025-10-01 01:00:00+00', '2025-10-15', '2025-11-01', 55, 'warm');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000210', '22222222-2222-2222-2222-222222222202', 'booked', 'instagram', '2026-09-19', 135, 10200, '33333333-3333-3333-3333-333333333302', '2025-12-15', '2025-12-15 02:30:00+00', '2026-01-05', '2026-01-20', 50, 'cool');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000211', '22222222-2222-2222-2222-222222222202', 'tour_completed', 'google', NULL, 100, NULL, '33333333-3333-3333-3333-333333333302', '2026-03-01', '2026-03-01 01:45:00+00', '2026-03-15', NULL, 70, 'warm');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000212', '22222222-2222-2222-2222-222222222202', 'inquiry', 'the_knot', NULL, 90, NULL, '33333333-3333-3333-3333-333333333302', '2026-03-22', '2026-03-22 03:00:00+00', NULL, NULL, 88, 'hot');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000213', '22222222-2222-2222-2222-222222222202', 'completed', 'google', '2025-07-19', 105, 8000, '33333333-3333-3333-3333-333333333302', '2024-11-01', '2024-11-01 02:00:00+00', '2024-11-15', '2024-12-01', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000214', '22222222-2222-2222-2222-222222222202', 'completed', 'website', '2025-09-06', 125, 9500, '33333333-3333-3333-3333-333333333302', '2024-12-10', '2024-12-10 01:15:00+00', '2025-01-05', '2025-01-20', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000215', '22222222-2222-2222-2222-222222222202', 'lost', 'weddingwire', '2025-10-11', 80, NULL, '33333333-3333-3333-3333-333333333302', '2025-01-15', '2025-01-15 06:00:00+00', '2025-02-01', NULL, 0, 'frozen');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000216', '22222222-2222-2222-2222-222222222202', 'completed', 'referral', '2025-10-25', 110, 8500, '33333333-3333-3333-3333-333333333302', '2025-02-10', '2025-02-10 01:30:00+00', '2025-02-25', '2025-03-10', 0, 'cold');

-- The Glass House — 24 weddings (highest volume)
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000301', '22222222-2222-2222-2222-222222222203', 'completed', 'google', '2024-04-20', 220, 18500, '33333333-3333-3333-3333-333333333303', '2023-09-15', '2023-09-15 01:00:00+00', '2023-10-01', '2023-10-15', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000302', '22222222-2222-2222-2222-222222222203', 'completed', 'the_knot', '2024-05-11', 180, 15800, '33333333-3333-3333-3333-333333333303', '2023-10-10', '2023-10-10 02:30:00+00', '2023-10-25', '2023-11-10', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000303', '22222222-2222-2222-2222-222222222203', 'completed', 'instagram', '2024-06-08', 250, 22000, '33333333-3333-3333-3333-333333333303', '2023-11-20', '2023-11-20 01:15:00+00', '2023-12-05', '2023-12-20', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000304', '22222222-2222-2222-2222-222222222203', 'completed', 'referral', '2024-07-27', 195, 17200, '33333333-3333-3333-3333-333333333303', '2024-01-05', '2024-01-05 02:00:00+00', '2024-01-20', '2024-02-05', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000305', '22222222-2222-2222-2222-222222222203', 'completed', 'weddingwire', '2024-08-17', 210, 19500, '33333333-3333-3333-3333-333333333303', '2024-02-01', '2024-02-01 01:30:00+00', '2024-02-15', '2024-03-01', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000306', '22222222-2222-2222-2222-222222222203', 'completed', 'google', '2024-09-14', 175, 16000, '33333333-3333-3333-3333-333333333303', '2024-02-20', '2024-02-20 03:45:00+00', '2024-03-05', '2024-03-20', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000307', '22222222-2222-2222-2222-222222222203', 'completed', 'the_knot', '2024-10-19', 240, 21000, '33333333-3333-3333-3333-333333333303', '2024-03-15', '2024-03-15 01:00:00+00', '2024-04-01', '2024-04-15', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000308', '22222222-2222-2222-2222-222222222203', 'completed', 'website', '2024-11-09', 160, 14500, '33333333-3333-3333-3333-333333333303', '2024-04-10', '2024-04-10 02:30:00+00', '2024-04-25', '2024-05-10', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000309', '22222222-2222-2222-2222-222222222203', 'completed', 'referral', '2024-12-07', 200, 18000, '33333333-3333-3333-3333-333333333303', '2024-05-20', '2024-05-20 01:15:00+00', '2024-06-05', '2024-06-20', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000310', '22222222-2222-2222-2222-222222222203', 'completed', 'instagram', '2025-02-14', 230, 20500, '33333333-3333-3333-3333-333333333303', '2024-06-15', '2024-06-15 02:00:00+00', '2024-07-01', '2024-07-15', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000311', '22222222-2222-2222-2222-222222222203', 'completed', 'google', '2025-03-29', 185, 16800, '33333333-3333-3333-3333-333333333303', '2024-07-20', '2024-07-20 01:30:00+00', '2024-08-05', '2024-08-20', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000312', '22222222-2222-2222-2222-222222222203', 'completed', 'the_knot', '2025-05-17', 205, 18200, '33333333-3333-3333-3333-333333333303', '2024-09-01', '2024-09-01 02:45:00+00', '2024-09-15', '2024-10-01', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000313', '22222222-2222-2222-2222-222222222203', 'booked', 'weddingwire', '2026-04-18', 190, 17500, '33333333-3333-3333-3333-333333333303', '2025-08-01', '2025-08-01 01:00:00+00', '2025-08-15', '2025-09-01', 60, 'warm');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000314', '22222222-2222-2222-2222-222222222203', 'booked', 'google', '2026-06-13', 225, 20000, '33333333-3333-3333-3333-333333333303', '2025-10-15', '2025-10-15 02:15:00+00', '2025-11-01', '2025-11-15', 55, 'warm');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000315', '22222222-2222-2222-2222-222222222203', 'booked', 'referral', '2026-08-22', 170, 15800, '33333333-3333-3333-3333-333333333303', '2025-12-01', '2025-12-01 01:45:00+00', '2025-12-15', '2026-01-05', 48, 'cool');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000316', '22222222-2222-2222-2222-222222222203', 'booked', 'the_knot', '2026-10-03', 245, 22500, '33333333-3333-3333-3333-333333333303', '2026-01-10', '2026-01-10 01:30:00+00', '2026-01-25', '2026-02-10', 45, 'cool');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000317', '22222222-2222-2222-2222-222222222203', 'booked', 'instagram', '2026-11-14', 200, 18500, '33333333-3333-3333-3333-333333333303', '2026-02-01', '2026-02-01 02:00:00+00', '2026-02-15', '2026-03-01', 42, 'cool');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000318', '22222222-2222-2222-2222-222222222203', 'proposal_sent', 'website', '2026-12-05', 180, 16500, '33333333-3333-3333-3333-333333333303', '2026-03-01', '2026-03-01 01:15:00+00', '2026-03-15', NULL, 75, 'warm');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000319', '22222222-2222-2222-2222-222222222203', 'inquiry', 'google', NULL, 210, NULL, '33333333-3333-3333-3333-333333333303', '2026-03-20', '2026-03-20 02:30:00+00', NULL, NULL, 92, 'hot');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000320', '22222222-2222-2222-2222-222222222203', 'lost', 'weddingwire', '2025-07-12', 190, NULL, '33333333-3333-3333-3333-333333333303', '2024-10-15', '2024-10-15 04:00:00+00', '2024-11-01', NULL, 0, 'frozen');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000321', '22222222-2222-2222-2222-222222222203', 'completed', 'weddingwire', '2025-06-21', 215, 19200, '33333333-3333-3333-3333-333333333303', '2024-10-01', '2024-10-01 01:30:00+00', '2024-10-15', '2024-11-01', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000322', '22222222-2222-2222-2222-222222222203', 'completed', 'referral', '2025-08-09', 170, 15500, '33333333-3333-3333-3333-333333333303', '2024-11-15', '2024-11-15 02:00:00+00', '2024-12-01', '2024-12-15', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000323', '22222222-2222-2222-2222-222222222203', 'completed', 'the_knot', '2025-09-27', 235, 21000, '33333333-3333-3333-3333-333333333303', '2025-01-10', '2025-01-10 01:15:00+00', '2025-01-25', '2025-02-10', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000324', '22222222-2222-2222-2222-222222222203', 'completed', 'google', '2025-11-08', 195, 17800, '33333333-3333-3333-3333-333333333303', '2025-03-15', '2025-03-15 02:30:00+00', '2025-04-01', '2025-04-15', 0, 'cold');

-- Rose Hill Gardens — 12 weddings (newer venue, trial)
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000401', '22222222-2222-2222-2222-222222222204', 'completed', 'the_knot', '2024-09-14', 130, 10500, '33333333-3333-3333-3333-333333333304', '2024-02-01', '2024-02-01 02:00:00+00', '2024-02-15', '2024-03-01', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000402', '22222222-2222-2222-2222-222222222204', 'completed', 'instagram', '2024-10-26', 100, 9500, '33333333-3333-3333-3333-333333333304', '2024-03-15', '2024-03-15 01:30:00+00', '2024-04-01', '2024-04-15', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000403', '22222222-2222-2222-2222-222222222204', 'completed', 'referral', '2025-04-05', 160, 13500, '33333333-3333-3333-3333-333333333304', '2024-07-20', '2024-07-20 02:15:00+00', '2024-08-05', '2024-08-20', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000404', '22222222-2222-2222-2222-222222222204', 'completed', 'google', '2025-05-24', 140, 12000, '33333333-3333-3333-3333-333333333304', '2024-09-01', '2024-09-01 01:45:00+00', '2024-09-15', '2024-10-01', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000405', '22222222-2222-2222-2222-222222222204', 'completed', 'weddingwire', '2025-06-07', 120, 11000, '33333333-3333-3333-3333-333333333304', '2024-10-10', '2024-10-10 02:30:00+00', '2024-10-25', '2024-11-10', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000406', '22222222-2222-2222-2222-222222222204', 'completed', 'website', '2025-09-20', 150, 13000, '33333333-3333-3333-3333-333333333304', '2025-01-05', '2025-01-05 01:00:00+00', '2025-01-20', '2025-02-05', 0, 'cold');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000407', '22222222-2222-2222-2222-222222222204', 'booked', 'the_knot', '2026-05-16', 170, 14500, '33333333-3333-3333-3333-333333333304', '2025-09-15', '2025-09-15 02:00:00+00', '2025-10-01', '2025-10-15', 58, 'warm');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000408', '22222222-2222-2222-2222-222222222204', 'booked', 'referral', '2026-09-05', 135, 11800, '33333333-3333-3333-3333-333333333304', '2025-12-20', '2025-12-20 01:30:00+00', '2026-01-05', '2026-01-20', 52, 'warm');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000409', '22222222-2222-2222-2222-222222222204', 'tour_scheduled', 'instagram', NULL, 110, NULL, '33333333-3333-3333-3333-333333333304', '2026-03-10', '2026-03-10 03:00:00+00', '2026-03-28', NULL, 80, 'warm');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000410', '22222222-2222-2222-2222-222222222204', 'inquiry', 'google', NULL, 90, NULL, '33333333-3333-3333-3333-333333333304', '2026-03-25', NULL, NULL, NULL, 93, 'hot');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000411', '22222222-2222-2222-2222-222222222204', 'lost', 'weddingwire', '2025-08-02', 145, NULL, '33333333-3333-3333-3333-333333333304', '2024-12-01', '2024-12-01 07:00:00+00', '2024-12-15', NULL, 0, 'frozen');
INSERT INTO weddings (id, venue_id, status, source, wedding_date, guest_count_estimate, booking_value, assigned_consultant_id, inquiry_date, first_response_at, tour_date, booked_at, heat_score, temperature_tier) VALUES
  ('44444444-4444-4444-4444-444444000412', '22222222-2222-2222-2222-222222222204', 'completed', 'the_knot', '2025-10-18', 125, 10800, '33333333-3333-3333-3333-333333333304', '2025-02-15', '2025-02-15 01:45:00+00', '2025-03-01', '2025-03-15', 0, 'cold');

-- ============================================
-- 7. PEOPLE + CONTACTS (2 partners per wedding, first 10 weddings get contacts)
-- ============================================
-- Rixey Manor wedding 101 — Emma & Liam
INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name, email) VALUES
  ('55555555-5555-5555-5555-555555000101', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000101', 'partner1', 'Emma', 'Rodriguez', 'emma.rodriguez@gmail.com');
INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name) VALUES
  ('55555555-5555-5555-5555-555555000102', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000101', 'partner2', 'Liam', 'Chen');
INSERT INTO contacts (id, person_id, type, value, is_primary) VALUES
  ('56565656-5656-5656-5656-565656000101', '55555555-5555-5555-5555-555555000101', 'email', 'emma.rodriguez@gmail.com', true);

-- Rixey Manor wedding 115 (hot inquiry) — Aisha & Marcus
INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name, email) VALUES
  ('55555555-5555-5555-5555-555555000201', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 'partner1', 'Aisha', 'Johnson', 'aisha.j@outlook.com');
INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name) VALUES
  ('55555555-5555-5555-5555-555555000202', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 'partner2', 'Marcus', 'Davis');
INSERT INTO contacts (id, person_id, type, value, is_primary) VALUES
  ('56565656-5656-5656-5656-565656000201', '55555555-5555-5555-5555-555555000201', 'email', 'aisha.j@outlook.com', true);

-- Rixey Manor wedding 109 (booked) — Chloe & Ryan
INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name, email) VALUES
  ('55555555-5555-5555-5555-555555000301', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'partner1', 'Chloe', 'Martinez', 'chloe.m@gmail.com');
INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name) VALUES
  ('55555555-5555-5555-5555-555555000302', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'partner2', 'Ryan', 'Brooks');
INSERT INTO contacts (id, person_id, type, value, is_primary) VALUES
  ('56565656-5656-5656-5656-565656000301', '55555555-5555-5555-5555-555555000301', 'email', 'chloe.m@gmail.com', true);

-- Crestwood Farm wedding 209 (booked) — Taylor & Jordan
INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name, email) VALUES
  ('55555555-5555-5555-5555-555555000401', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000209', 'partner1', 'Taylor', 'Kim', 'taylor.kim@gmail.com');
INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name) VALUES
  ('55555555-5555-5555-5555-555555000402', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000209', 'partner2', 'Jordan', 'Park');
INSERT INTO contacts (id, person_id, type, value, is_primary) VALUES
  ('56565656-5656-5656-5656-565656000401', '55555555-5555-5555-5555-555555000401', 'email', 'taylor.kim@gmail.com', true);

-- Glass House wedding 319 (hot inquiry) — Priya & Nico
INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name, email) VALUES
  ('55555555-5555-5555-5555-555555000501', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', 'partner1', 'Priya', 'Sharma', 'priya.sharma@gmail.com');
INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name) VALUES
  ('55555555-5555-5555-5555-555555000502', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', 'partner2', 'Nico', 'Fernandez');
INSERT INTO contacts (id, person_id, type, value, is_primary) VALUES
  ('56565656-5656-5656-5656-565656000501', '55555555-5555-5555-5555-555555000501', 'email', 'priya.sharma@gmail.com', true);

-- Rose Hill wedding 407 (booked) — Lily & Daniel
INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name, email) VALUES
  ('55555555-5555-5555-5555-555555000601', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000407', 'partner1', 'Lily', 'Nguyen', 'lily.nguyen@gmail.com');
INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name) VALUES
  ('55555555-5555-5555-5555-555555000602', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000407', 'partner2', 'Daniel', 'O''Brien');
INSERT INTO contacts (id, person_id, type, value, is_primary) VALUES
  ('56565656-5656-5656-5656-565656000601', '55555555-5555-5555-5555-555555000601', 'email', 'lily.nguyen@gmail.com', true);

-- ============================================
-- 8. INTERACTIONS (emails)
-- ============================================
INSERT INTO interactions (id, venue_id, wedding_id, person_id, type, direction, subject, body_preview, timestamp) VALUES
  ('66666666-6666-6666-6666-666666000101', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', '55555555-5555-5555-5555-555555000201', 'email', 'inbound', 'Interested in Rixey Manor for Fall 2027', 'Hi! My fiance Marcus and I just got engaged and we are absolutely in love with Rixey Manor...', '2026-03-24 14:30:00+00');
INSERT INTO interactions (id, venue_id, wedding_id, person_id, type, direction, subject, body_preview, timestamp) VALUES
  ('66666666-6666-6666-6666-666666000102', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', '55555555-5555-5555-5555-555555000201', 'email', 'outbound', 'Re: Interested in Rixey Manor for Fall 2027', 'Hi Aisha! Congratulations on your engagement — how exciting! We would love to show you around...', '2026-03-24 17:00:00+00');
INSERT INTO interactions (id, venue_id, wedding_id, person_id, type, direction, subject, body_preview, timestamp) VALUES
  ('66666666-6666-6666-6666-666666000103', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000116', NULL, 'email', 'inbound', 'Pricing info please', 'Hello, I saw your venue on The Knot and wanted to get pricing information for a wedding in spring 2027...', '2026-03-26 10:15:00+00');
INSERT INTO interactions (id, venue_id, wedding_id, person_id, type, direction, subject, body_preview, timestamp) VALUES
  ('66666666-6666-6666-6666-666666000104', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000212', NULL, 'email', 'inbound', 'Barn venue for intimate wedding?', 'Hi there! We are looking for a cozy barn venue for about 90 guests this fall...', '2026-03-22 09:00:00+00');
INSERT INTO interactions (id, venue_id, wedding_id, person_id, type, direction, subject, body_preview, timestamp) VALUES
  ('66666666-6666-6666-6666-666666000105', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000212', NULL, 'email', 'outbound', 'Re: Barn venue for intimate wedding?', 'Hey! Y''all are gonna love Crestwood Farm — it''s the perfect spot for an intimate gathering...', '2026-03-22 12:00:00+00');
INSERT INTO interactions (id, venue_id, wedding_id, person_id, type, direction, subject, body_preview, timestamp) VALUES
  ('66666666-6666-6666-6666-666666000106', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', '55555555-5555-5555-5555-555555000501', 'email', 'inbound', 'Large wedding at The Glass House', 'Hello, we are interested in hosting our wedding at The Glass House for approximately 210 guests...', '2026-03-20 11:30:00+00');
INSERT INTO interactions (id, venue_id, wedding_id, person_id, type, direction, subject, body_preview, timestamp) VALUES
  ('66666666-6666-6666-6666-666666000107', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', '55555555-5555-5555-5555-555555000501', 'email', 'outbound', 'Re: Large wedding at The Glass House', 'Hello Priya, Thank you for your interest in The Glass House. We would be happy to accommodate your guest count...', '2026-03-20 14:00:00+00');

-- ============================================
-- 9. DRAFTS
-- ============================================
INSERT INTO drafts (id, venue_id, wedding_id, interaction_id, to_email, subject, draft_body, status, context_type, brain_used, model_used, tokens_used, cost, confidence_score, auto_sent) VALUES
  ('77777777-7777-7777-7777-777777000101', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', '66666666-6666-6666-6666-666666000101', 'aisha.j@outlook.com', 'Re: Interested in Rixey Manor for Fall 2027', 'Hi Aisha! Congratulations on your engagement — how exciting! Marcus is a lucky guy. We would absolutely love to show you both around Rixey Manor. The hilltop views in autumn are truly magical, and 100 guests is a wonderful size for our space. Would you be available for a tour this weekend? We have Saturday at 11am or Sunday at 2pm open. Warmly, Sage', 'approved', 'inquiry', 'inquiry_brain', 'claude-sonnet-4-20250514', 1250, 0.0045, 92, false);
INSERT INTO drafts (id, venue_id, wedding_id, interaction_id, to_email, subject, draft_body, status, context_type, brain_used, model_used, tokens_used, cost, confidence_score, auto_sent) VALUES
  ('77777777-7777-7777-7777-777777000102', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000116', '66666666-6666-6666-6666-666666000103', NULL, 'Re: Pricing info please', 'Hi there! Thank you for reaching out about Rixey Manor. We would love to share our pricing details and learn more about your vision for your spring 2027 celebration! Our venue rental starts at $8,500 and includes exclusive use of the entire property. The best way to get a feel for the space is to come visit — would you be interested in scheduling a tour? Warmly, Sage', 'pending', 'inquiry', 'inquiry_brain', 'claude-sonnet-4-20250514', 1180, 0.0042, 88, false);
INSERT INTO drafts (id, venue_id, wedding_id, interaction_id, to_email, subject, draft_body, status, context_type, brain_used, model_used, tokens_used, cost, confidence_score) VALUES
  ('77777777-7777-7777-7777-777777000103', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000212', '66666666-6666-6666-6666-666666000104', NULL, 'Re: Barn venue for intimate wedding?', 'Hey! Y''all are gonna love Crestwood Farm — it''s the perfect spot for an intimate gathering! 90 guests fits beautifully in our restored barn. We''d love to have you out for a visit so you can see the string lights and the meadow view. How does next weekend work for y''all? Can''t wait to meet y''all! Daisy', 'sent', 'inquiry', 'inquiry_brain', 'claude-sonnet-4-20250514', 1100, 0.0038, 95);
INSERT INTO drafts (id, venue_id, wedding_id, interaction_id, to_email, subject, draft_body, status, context_type, brain_used, model_used, tokens_used, cost, confidence_score) VALUES
  ('77777777-7777-7777-7777-777777000104', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', '66666666-6666-6666-6666-666666000106', 'priya.sharma@gmail.com', 'Re: Large wedding at The Glass House', 'Hello Priya, Thank you for your interest in The Glass House. We accommodate up to 250 guests and your guest count of 210 would be an excellent fit. I would be happy to schedule a walkthrough at your convenience. Please let me know your preferred date and time. Best regards, Nova', 'approved', 'inquiry', 'inquiry_brain', 'claude-sonnet-4-20250514', 1050, 0.0036, 90);

-- ============================================
-- 10. ENGAGEMENT EVENTS
-- ============================================
INSERT INTO engagement_events (id, venue_id, wedding_id, event_type, points, metadata) VALUES
  ('88888888-8888-8888-8888-888888000101', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 'email_opened', 5, '{"subject": "Interested in Rixey Manor"}');
INSERT INTO engagement_events (id, venue_id, wedding_id, event_type, points, metadata) VALUES
  ('88888888-8888-8888-8888-888888000102', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 'replied_quickly', 15, '{"response_time_minutes": 150}');
INSERT INTO engagement_events (id, venue_id, wedding_id, event_type, points, metadata) VALUES
  ('88888888-8888-8888-8888-888888000103', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000114', 'tour_booked', 25, '{"tour_date": "2026-04-01"}');
INSERT INTO engagement_events (id, venue_id, wedding_id, event_type, points, metadata) VALUES
  ('88888888-8888-8888-8888-888888000104', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000113', 'proposal_viewed', 20, '{}');
INSERT INTO engagement_events (id, venue_id, wedding_id, event_type, points, metadata) VALUES
  ('88888888-8888-8888-8888-888888000105', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', 'email_opened', 5, '{}');
INSERT INTO engagement_events (id, venue_id, wedding_id, event_type, points, metadata) VALUES
  ('88888888-8888-8888-8888-888888000106', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', 'replied_quickly', 15, '{"response_time_minutes": 90}');

-- ============================================
-- 11. LEAD SCORE HISTORY
-- ============================================
INSERT INTO lead_score_history (id, venue_id, wedding_id, score, temperature_tier, calculated_at) VALUES
  ('99990001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 80, 'warm', '2026-03-24 14:30:00+00');
INSERT INTO lead_score_history (id, venue_id, wedding_id, score, temperature_tier, calculated_at) VALUES
  ('99990001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 90, 'hot', '2026-03-24 17:00:00+00');
INSERT INTO lead_score_history (id, venue_id, wedding_id, score, temperature_tier, calculated_at) VALUES
  ('99990001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000114', 85, 'hot', '2026-03-15 12:00:00+00');
INSERT INTO lead_score_history (id, venue_id, wedding_id, score, temperature_tier, calculated_at) VALUES
  ('99990001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', 92, 'hot', '2026-03-20 14:00:00+00');

-- ============================================
-- 12. HEAT SCORE CONFIG
-- ============================================
INSERT INTO heat_score_config (id, venue_id, event_type, points, decay_rate) VALUES
  ('b0000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'email_opened', 5, 0.95);
INSERT INTO heat_score_config (id, venue_id, event_type, points, decay_rate) VALUES
  ('b0000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', 'replied_quickly', 15, 0.90);
INSERT INTO heat_score_config (id, venue_id, event_type, points, decay_rate) VALUES
  ('b0000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', 'tour_booked', 25, 0.85);
INSERT INTO heat_score_config (id, venue_id, event_type, points, decay_rate) VALUES
  ('b0000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', 'proposal_viewed', 20, 0.90);

-- ============================================
-- 13. DRAFT FEEDBACK
-- ============================================
INSERT INTO draft_feedback (id, venue_id, draft_id, action, original_body, edited_body) VALUES
  ('b1000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '77777777-7777-7777-7777-777777000101', 'approved', NULL, NULL);
INSERT INTO draft_feedback (id, venue_id, draft_id, action, original_body, edited_body, coordinator_edits) VALUES
  ('b1000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222202', '77777777-7777-7777-7777-777777000103', 'edited', 'Hey! Y''all are gonna love it!', 'Hey! Y''all are gonna love Crestwood Farm!', 'Added venue name to opening');
INSERT INTO draft_feedback (id, venue_id, draft_id, action, original_body, coordinator_edits) VALUES
  ('b1000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222203', '77777777-7777-7777-7777-777777000104', 'approved', NULL, 'Good tone, professional');

-- ============================================
-- 14. LEARNED PREFERENCES
-- ============================================
INSERT INTO learned_preferences (id, venue_id, preference_type, pattern, confidence) VALUES
  ('b2000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'greeting_style', 'Start with congratulations when engagement is mentioned', 0.92);
INSERT INTO learned_preferences (id, venue_id, preference_type, pattern, confidence) VALUES
  ('b2000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', 'tour_offer', 'Always offer specific time slots, not open-ended availability', 0.88);
INSERT INTO learned_preferences (id, venue_id, preference_type, pattern, confidence) VALUES
  ('b2000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222202', 'dialect', 'Use y''all naturally but don''t overdo it', 0.85);
INSERT INTO learned_preferences (id, venue_id, preference_type, pattern, confidence) VALUES
  ('b2000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222203', 'brevity', 'Keep responses under 4 sentences for initial inquiries', 0.90);

-- ============================================
-- 15. AUTO SEND RULES
-- ============================================
INSERT INTO auto_send_rules (id, venue_id, context, source, enabled, confidence_threshold, daily_limit) VALUES
  ('b3000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'inquiry', 'the_knot', true, 0.90, 3);
INSERT INTO auto_send_rules (id, venue_id, context, source, enabled, confidence_threshold, daily_limit) VALUES
  ('b3000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222202', 'inquiry', NULL, true, 0.85, 5);
INSERT INTO auto_send_rules (id, venue_id, context, source, enabled, confidence_threshold, daily_limit) VALUES
  ('b3000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222203', 'inquiry', NULL, false, 0.95, 2);
INSERT INTO auto_send_rules (id, venue_id, context, enabled) VALUES
  ('b3000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222204', 'inquiry', false);

-- ============================================
-- 16. INTELLIGENCE EXTRACTIONS
-- ============================================
INSERT INTO intelligence_extractions (id, venue_id, wedding_id, interaction_id, extraction_type, value, confidence) VALUES
  ('b4000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', '66666666-6666-6666-6666-666666000101', 'guest_count', '100', 0.90);
INSERT INTO intelligence_extractions (id, venue_id, wedding_id, interaction_id, extraction_type, value, confidence) VALUES
  ('b4000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', '66666666-6666-6666-6666-666666000101', 'season_preference', 'fall 2027', 0.95);
INSERT INTO intelligence_extractions (id, venue_id, wedding_id, interaction_id, extraction_type, value, confidence) VALUES
  ('b4000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', '66666666-6666-6666-6666-666666000101', 'excitement_signal', 'absolutely in love with', 0.88);

-- ============================================
-- 17. EMAIL SYNC STATE
-- ============================================
INSERT INTO email_sync_state (id, venue_id, last_history_id, last_sync_at, status) VALUES
  ('b5000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '18472635', '2026-03-27 08:00:00+00', 'ok');
INSERT INTO email_sync_state (id, venue_id, last_history_id, last_sync_at, status) VALUES
  ('b5000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222202', '12839475', '2026-03-27 08:00:00+00', 'ok');

-- ============================================
-- 18. KNOWLEDGE BASE
-- ============================================
INSERT INTO knowledge_base (id, venue_id, category, question, answer, keywords, priority, is_active) VALUES
  ('b6000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'pricing', 'How much does Rixey Manor cost?', 'Rixey Manor''s venue rental starts at $8,500 for exclusive use of the entire property. This includes the ceremony site, reception space, bridal suite, and grounds. Pricing varies by season and day of the week.', ARRAY['price', 'cost', 'how much', 'rental fee', 'rate'], 10, true);
INSERT INTO knowledge_base (id, venue_id, category, question, answer, keywords, priority, is_active) VALUES
  ('b6000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', 'catering', 'What is the catering policy?', 'Rixey Manor is BYOB for both food and beverage. You choose your own caterer and bartending service, giving you complete flexibility over your menu and budget.', ARRAY['catering', 'food', 'byob', 'caterer', 'kitchen', 'bar'], 9, true);
INSERT INTO knowledge_base (id, venue_id, category, question, answer, keywords, priority, is_active) VALUES
  ('b6000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', 'capacity', 'How many guests can Rixey Manor hold?', 'Rixey Manor comfortably accommodates up to 200 guests for a seated dinner and up to 250 for a cocktail-style reception.', ARRAY['capacity', 'guests', 'how many', 'size', 'max'], 8, true);
INSERT INTO knowledge_base (id, venue_id, category, question, answer, keywords, priority, is_active) VALUES
  ('b6000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', 'accommodation', 'Are there rooms on site?', 'Yes! Rixey Manor has 5 guest rooms that can accommodate the wedding party. The bridal suite is included with every booking.', ARRAY['rooms', 'stay', 'overnight', 'accommodation', 'sleep', 'bridal suite'], 7, true);
INSERT INTO knowledge_base (id, venue_id, category, question, answer, keywords, priority, is_active) VALUES
  ('b6000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', 'pets', 'Are pets allowed?', 'Absolutely! We are very pet-friendly. Many of our couples include their dogs in the ceremony. We just ask that you designate a pet handler for the reception.', ARRAY['pets', 'dogs', 'animals', 'pet-friendly'], 6, true);
INSERT INTO knowledge_base (id, venue_id, category, question, answer, keywords, priority, is_active) VALUES
  ('b6000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222202', 'capacity', 'How many guests can the barn hold?', 'Crestwood Farm''s restored barn seats up to 150 guests comfortably. For larger groups, we can extend into the meadow with tent coverage.', ARRAY['capacity', 'guests', 'barn', 'how many'], 10, true);
INSERT INTO knowledge_base (id, venue_id, category, question, answer, keywords, priority, is_active) VALUES
  ('b6000001-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222203', 'pricing', 'What are The Glass House rates?', 'The Glass House venue rental starts at $12,000 and includes full in-house catering, bar service, and event coordination. Package pricing is available.', ARRAY['price', 'cost', 'rate', 'package'], 10, true);

-- ============================================
-- 19. SEARCH TRENDS (4 weeks, 2 metros)
-- ============================================
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'wedding venue', '2026-03-02', 78);
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'wedding venue', '2026-03-09', 82);
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'wedding venue', '2026-03-16', 91);
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'wedding venue', '2026-03-23', 95);
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'barn wedding venue', '2026-03-02', 45);
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'barn wedding venue', '2026-03-09', 48);
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'barn wedding venue', '2026-03-16', 52);
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000008', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'barn wedding venue', '2026-03-23', 55);
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000009', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'engagement ring', '2026-03-02', 65);
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000010', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'engagement ring', '2026-03-09', 68);
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000011', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'engagement ring', '2026-03-16', 72);
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000012', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'engagement ring', '2026-03-23', 70);
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000013', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding venue', '2026-03-02', 72);
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000014', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding venue', '2026-03-09', 75);
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000015', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding venue', '2026-03-16', 80);
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('b7000001-0000-0000-0000-000000000016', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding venue', '2026-03-23', 85);

-- ============================================
-- 20. WEATHER DATA (recent 14 days, Rixey Manor)
-- ============================================
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('b8000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '2026-03-14', 62, 38, 0, 'Sunny', 'open_meteo');
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('b8000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '2026-03-15', 58, 35, 0.1, 'Partly Cloudy', 'open_meteo');
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('b8000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '2026-03-16', 55, 33, 0.8, 'Rain', 'open_meteo');
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('b8000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', '2026-03-17', 60, 40, 0, 'Sunny', 'open_meteo');
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('b8000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', '2026-03-18', 64, 42, 0, 'Clear', 'open_meteo');
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('b8000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222201', '2026-03-19', 68, 45, 0, 'Sunny', 'open_meteo');
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('b8000001-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222201', '2026-03-20', 70, 48, 0.2, 'Partly Cloudy', 'open_meteo');
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('b8000001-0000-0000-0000-000000000008', '22222222-2222-2222-2222-222222222201', '2026-03-21', 65, 43, 1.2, 'Rain', 'open_meteo');
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('b8000001-0000-0000-0000-000000000009', '22222222-2222-2222-2222-222222222201', '2026-03-22', 58, 36, 0.5, 'Overcast', 'open_meteo');
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('b8000001-0000-0000-0000-000000000010', '22222222-2222-2222-2222-222222222201', '2026-03-23', 62, 40, 0, 'Clear', 'open_meteo');
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('b8000001-0000-0000-0000-000000000011', '22222222-2222-2222-2222-222222222201', '2026-03-24', 66, 44, 0, 'Sunny', 'open_meteo');
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('b8000001-0000-0000-0000-000000000012', '22222222-2222-2222-2222-222222222201', '2026-03-25', 71, 47, 0, 'Clear', 'open_meteo');
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('b8000001-0000-0000-0000-000000000013', '22222222-2222-2222-2222-222222222201', '2026-03-26', 73, 50, 0, 'Sunny', 'open_meteo');
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('b8000001-0000-0000-0000-000000000014', '22222222-2222-2222-2222-222222222201', '2026-03-27', 69, 46, 0.3, 'Partly Cloudy', 'open_meteo');

-- ============================================
-- 21. ECONOMIC INDICATORS (latest 6 months)
-- ============================================
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000001', 'consumer_sentiment', '2025-10-01', 69.4, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000002', 'consumer_sentiment', '2025-11-01', 71.8, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000003', 'consumer_sentiment', '2025-12-01', 73.2, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000004', 'consumer_sentiment', '2026-01-01', 72.0, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000005', 'consumer_sentiment', '2026-02-01', 74.1, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000006', 'consumer_sentiment', '2026-03-01', 75.3, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000007', 'personal_savings_rate', '2025-10-01', 4.8, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000008', 'personal_savings_rate', '2025-11-01', 4.5, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000009', 'personal_savings_rate', '2025-12-01', 3.9, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000010', 'personal_savings_rate', '2026-01-01', 4.2, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000011', 'personal_savings_rate', '2026-02-01', 4.0, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000012', 'personal_savings_rate', '2026-03-01', 3.8, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000013', 'consumer_confidence', '2025-10-01', 102.5, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000014', 'consumer_confidence', '2026-01-01', 105.3, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000015', 'consumer_confidence', '2026-03-01', 108.1, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000016', 'disposable_income_real', '2026-01-01', 48250, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000017', 'disposable_income_real', '2026-03-01', 48800, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000018', 'housing_starts', '2026-01-01', 1420, 'fred');
INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  ('b9000001-0000-0000-0000-000000000019', 'housing_starts', '2026-03-01', 1480, 'fred');

-- ============================================
-- 22. MARKETING SPEND
-- ============================================
INSERT INTO marketing_spend (id, venue_id, source, month, amount) VALUES
  ('ba000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'the_knot', '2026-01-01', 350);
INSERT INTO marketing_spend (id, venue_id, source, month, amount) VALUES
  ('ba000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', 'the_knot', '2026-02-01', 350);
INSERT INTO marketing_spend (id, venue_id, source, month, amount) VALUES
  ('ba000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', 'the_knot', '2026-03-01', 350);
INSERT INTO marketing_spend (id, venue_id, source, month, amount) VALUES
  ('ba000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', 'google', '2026-01-01', 500);
INSERT INTO marketing_spend (id, venue_id, source, month, amount) VALUES
  ('ba000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', 'google', '2026-02-01', 600);
INSERT INTO marketing_spend (id, venue_id, source, month, amount) VALUES
  ('ba000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222201', 'google', '2026-03-01', 650);
INSERT INTO marketing_spend (id, venue_id, source, month, amount) VALUES
  ('ba000001-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-01-01', 200);
INSERT INTO marketing_spend (id, venue_id, source, month, amount) VALUES
  ('ba000001-0000-0000-0000-000000000008', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-02-01', 250);
INSERT INTO marketing_spend (id, venue_id, source, month, amount) VALUES
  ('ba000001-0000-0000-0000-000000000009', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-03-01', 300);
INSERT INTO marketing_spend (id, venue_id, source, month, amount) VALUES
  ('ba000001-0000-0000-0000-000000000010', '22222222-2222-2222-2222-222222222202', 'the_knot', '2026-01-01', 250);
INSERT INTO marketing_spend (id, venue_id, source, month, amount) VALUES
  ('ba000001-0000-0000-0000-000000000011', '22222222-2222-2222-2222-222222222202', 'the_knot', '2026-02-01', 250);
INSERT INTO marketing_spend (id, venue_id, source, month, amount) VALUES
  ('ba000001-0000-0000-0000-000000000012', '22222222-2222-2222-2222-222222222202', 'the_knot', '2026-03-01', 250);

-- ============================================
-- 23. SOURCE ATTRIBUTION
-- ============================================
INSERT INTO source_attribution (id, venue_id, source, period_start, period_end, spend, inquiries, tours, bookings, revenue, cost_per_inquiry, cost_per_booking, conversion_rate, roi) VALUES
  ('bb000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'the_knot', '2026-01-01', '2026-03-31', 1050, 8, 5, 3, 42300, 131.25, 350, 0.375, 39.29);
INSERT INTO source_attribution (id, venue_id, source, period_start, period_end, spend, inquiries, tours, bookings, revenue, cost_per_inquiry, cost_per_booking, conversion_rate, roi) VALUES
  ('bb000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', 'google', '2026-01-01', '2026-03-31', 1750, 6, 4, 2, 33500, 291.67, 875, 0.333, 18.14);
INSERT INTO source_attribution (id, venue_id, source, period_start, period_end, spend, inquiries, tours, bookings, revenue, cost_per_inquiry, cost_per_booking, conversion_rate, roi) VALUES
  ('bb000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-01-01', '2026-03-31', 750, 4, 2, 1, 14800, 187.50, 750, 0.250, 18.73);

-- ============================================
-- 24. TREND RECOMMENDATIONS
-- ============================================
INSERT INTO trend_recommendations (id, venue_id, recommendation_type, title, body, data_source, supporting_data, priority, status) VALUES
  ('bc000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'content', 'Wedding venue searches surging — update listing photos', '"Wedding venue" searches in your metro jumped 22% in the last 2 weeks. This is prime browsing season. Consider refreshing your The Knot and WeddingWire gallery with spring photos.', 'google_trends', '{"term": "wedding venue", "change_pct": 22, "recent_avg": 93, "prior_avg": 76}', 'high', 'pending');
INSERT INTO trend_recommendations (id, venue_id, recommendation_type, title, body, data_source, supporting_data, priority, status) VALUES
  ('bc000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', 'engagement', 'Engagement ring searches rising — future inquiries incoming', 'Engagement ring searches are up 11% — expect a wave of newly engaged couples reaching out in 3-6 months. Start planning your fall marketing push now.', 'google_trends', '{"term": "engagement ring", "change_pct": 11, "recent_avg": 71, "prior_avg": 64}', 'medium', 'pending');
INSERT INTO trend_recommendations (id, venue_id, recommendation_type, title, body, data_source, supporting_data, priority, status) VALUES
  ('bc000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222202', 'content', 'Barn venue interest climbing — highlight rustic features', '"Barn wedding venue" searches up 18% in your area. Make sure your listing leads with barn imagery and mentions the meadow, string lights, and rustic charm.', 'google_trends', '{"term": "barn wedding venue", "change_pct": 18, "recent_avg": 53.5, "prior_avg": 45.3}', 'high', 'pending');

-- ============================================
-- 25. AI BRIEFINGS (1 weekly per venue)
-- ============================================
INSERT INTO ai_briefings (id, venue_id, briefing_type, content, created_at) VALUES
  ('bd000002-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'weekly', '{"summary": "Strong week for Rixey Manor. 2 new inquiries came in (both hot), and the proposal for the November wedding is still pending. Wedding venue searches in your metro are up 22% — this is peak browsing season.", "metrics": {"new_inquiries": 2, "tours_scheduled": 1, "bookings": 0, "lost_deals": 0, "revenue_booked": 0}, "demand_outlook": {"score": 62, "outlook": "positive"}, "trend_highlights": ["Wedding venue searches up 22% in Culpeper/Charlottesville metro", "Engagement ring searches rising — expect inquiries in 3-6 months", "Barn venue interest up 18% (benefits Crestwood Farm more directly)"], "weather_outlook": "Beautiful week ahead — highs in the upper 60s to low 70s through the weekend. Perfect touring weather. One chance of rain on Wednesday.", "anomaly_summary": ["Inquiry volume up 40% vs prior week — likely seasonal spring surge"], "recommendations": ["Follow up with the March 26 inquiry (no response yet — don''t let this one go cold)", "Offer weekend tour slots to both hot leads while weather is perfect", "Refresh spring photos on The Knot — searches are peaking now", "Send the November proposal couple a gentle check-in"], "generated_at": "2026-03-27T08:00:00Z"}', '2026-03-27 08:00:00+00');
INSERT INTO ai_briefings (id, venue_id, briefing_type, content, created_at) VALUES
  ('bd000002-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222202', 'weekly', '{"summary": "Crestwood Farm had 1 new inquiry this week and a completed tour. Barn venue searches are trending up 18% in your metro — great timing for spring marketing.", "metrics": {"new_inquiries": 1, "tours_scheduled": 0, "bookings": 0, "lost_deals": 0, "revenue_booked": 0}, "demand_outlook": {"score": 58, "outlook": "neutral"}, "trend_highlights": ["Barn wedding venue searches up 18%", "General wedding venue searches up 22%"], "weather_outlook": "Mild spring weather expected. Great conditions for outdoor tours.", "anomaly_summary": [], "recommendations": ["Follow up with the March 22 inquiry — they responded well to Daisy''s tone", "Update barn photos for spring — fresh greenery sells"], "generated_at": "2026-03-27T08:00:00Z"}', '2026-03-27 08:00:00+00');

-- ============================================
-- 26. ANOMALY ALERTS
-- ============================================
INSERT INTO anomaly_alerts (id, venue_id, alert_type, metric_name, current_value, baseline_value, change_percent, severity, ai_explanation, causes) VALUES
  ('be000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'surge', 'inquiry_volume', 4, 2, 100, 'warning', 'Inquiry volume doubled this week compared to the prior week. This is a positive signal — spring is peak browsing season and your search visibility appears strong.', '[{"cause": "Seasonal spring engagement surge", "likelihood": "high", "action": "Ensure all inquiries get a response within 2 hours"}, {"cause": "Increased search visibility from trending terms", "likelihood": "medium", "action": "Monitor The Knot and Google listing performance"}]');
INSERT INTO anomaly_alerts (id, venue_id, alert_type, metric_name, current_value, baseline_value, change_percent, severity, ai_explanation, causes) VALUES
  ('be000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222203', 'decline', 'tour_conversion', 0.25, 0.50, -50, 'critical', 'Tour conversion rate dropped from 50% to 25% this period. 3 out of 4 toured couples did not book. This warrants investigation.', '[{"cause": "Pricing may be above market for current leads", "likelihood": "medium", "action": "Review proposal pricing vs competitor rates"}, {"cause": "Tour experience may need refreshing", "likelihood": "medium", "action": "Shadow next tour and check for gaps in the walkthrough"}, {"cause": "Lead quality from source may have shifted", "likelihood": "low", "action": "Check which sources the non-converting leads came from"}]');

-- ============================================
-- 27. REVIEW LANGUAGE
-- ============================================
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing) VALUES
  ('bf000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'the coordinators made us feel so at ease from day one', 'coordinator', 0.95, 4, true, true);
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing) VALUES
  ('bf000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', 'the hilltop views during golden hour were breathtaking', 'space', 0.98, 6, true, true);
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing) VALUES
  ('bf000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', 'loved being able to bring our own caterer and bar', 'flexibility', 0.85, 5, true, false);
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing) VALUES
  ('bf000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', 'incredible value for what you get', 'value', 0.88, 3, true, true);
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing) VALUES
  ('bf000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', 'our dog walked down the aisle and everyone loved it', 'pets', 0.92, 2, true, true);
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing) VALUES
  ('bf000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222201', 'felt like we had the whole mountain to ourselves', 'exclusivity', 0.96, 4, true, true);
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing) VALUES
  ('bf000001-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222201', 'the bridal suite was so spacious and beautifully decorated', 'accommodation', 0.90, 3, true, false);
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing) VALUES
  ('bf000001-0000-0000-0000-000000000008', '22222222-2222-2222-2222-222222222201', 'the whole planning process was seamless', 'process', 0.87, 5, true, false);
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing) VALUES
  ('bf000001-0000-0000-0000-000000000009', '22222222-2222-2222-2222-222222222202', 'the barn was absolutely magical with the string lights', 'space', 0.94, 4, true, true);
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing) VALUES
  ('bf000001-0000-0000-0000-000000000010', '22222222-2222-2222-2222-222222222202', 'the meadow ceremony with the mountains behind us', 'ceremony', 0.97, 3, true, true);
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing) VALUES
  ('bf000001-0000-0000-0000-000000000011', '22222222-2222-2222-2222-222222222203', 'sleek modern design made for incredible photos', 'space', 0.91, 5, true, true);
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing) VALUES
  ('bf000001-0000-0000-0000-000000000012', '22222222-2222-2222-2222-222222222203', 'in-house catering was restaurant quality', 'food_catering', 0.93, 4, true, true);

-- ============================================
-- 28. CONSULTANT METRICS
-- ============================================
INSERT INTO consultant_metrics (id, venue_id, consultant_id, period_start, period_end, inquiries_handled, tours_booked, bookings_closed, conversion_rate, avg_response_time_minutes, avg_booking_value) VALUES
  ('c0000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', '2026-01-01', '2026-01-31', 5, 3, 2, 0.40, 95, 14250);
INSERT INTO consultant_metrics (id, venue_id, consultant_id, period_start, period_end, inquiries_handled, tours_booked, bookings_closed, conversion_rate, avg_response_time_minutes, avg_booking_value) VALUES
  ('c0000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', '2026-02-01', '2026-02-28', 4, 3, 1, 0.25, 82, 14800);
INSERT INTO consultant_metrics (id, venue_id, consultant_id, period_start, period_end, inquiries_handled, tours_booked, bookings_closed, conversion_rate, avg_response_time_minutes, avg_booking_value) VALUES
  ('c0000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', '2026-03-01', '2026-03-27', 6, 2, 0, 0.00, 120, 0);
INSERT INTO consultant_metrics (id, venue_id, consultant_id, period_start, period_end, inquiries_handled, tours_booked, bookings_closed, conversion_rate, avg_response_time_minutes, avg_booking_value) VALUES
  ('c0000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333302', '2026-01-01', '2026-01-31', 3, 2, 1, 0.33, 105, 8800);
INSERT INTO consultant_metrics (id, venue_id, consultant_id, period_start, period_end, inquiries_handled, tours_booked, bookings_closed, conversion_rate, avg_response_time_minutes, avg_booking_value) VALUES
  ('c0000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333303', '2026-01-01', '2026-01-31', 7, 5, 3, 0.43, 68, 18500);

-- ============================================
-- 29. VENUE USPs
-- ============================================
INSERT INTO venue_usps (id, venue_id, usp_text, sort_order) VALUES
  ('c1000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'Exclusive hilltop estate with panoramic Blue Ridge views', 1);
INSERT INTO venue_usps (id, venue_id, usp_text, sort_order) VALUES
  ('c1000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', 'Full BYOB flexibility — bring your own caterer and bar', 2);
INSERT INTO venue_usps (id, venue_id, usp_text, sort_order) VALUES
  ('c1000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', 'Pet-friendly — dogs welcome at ceremony and reception', 3);
INSERT INTO venue_usps (id, venue_id, usp_text, sort_order) VALUES
  ('c1000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', 'On-site bridal suite and 5 guest rooms', 4);
INSERT INTO venue_usps (id, venue_id, usp_text, sort_order) VALUES
  ('c1000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222202', 'Restored 1890s barn with original stone walls', 1);
INSERT INTO venue_usps (id, venue_id, usp_text, sort_order) VALUES
  ('c1000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222202', 'Meadow ceremony site with mountain backdrop', 2);
INSERT INTO venue_usps (id, venue_id, usp_text, sort_order) VALUES
  ('c1000001-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222202', 'String lights and rustic charm included', 3);
INSERT INTO venue_usps (id, venue_id, usp_text, sort_order) VALUES
  ('c1000001-0000-0000-0000-000000000008', '22222222-2222-2222-2222-222222222203', 'Floor-to-ceiling glass walls with natural light', 1);
INSERT INTO venue_usps (id, venue_id, usp_text, sort_order) VALUES
  ('c1000001-0000-0000-0000-000000000009', '22222222-2222-2222-2222-222222222203', 'Full in-house catering and bar by award-winning chef', 2);
INSERT INTO venue_usps (id, venue_id, usp_text, sort_order) VALUES
  ('c1000001-0000-0000-0000-000000000010', '22222222-2222-2222-2222-222222222203', 'Capacity for 250 guests — largest modern venue in Richmond', 3);
INSERT INTO venue_usps (id, venue_id, usp_text, sort_order) VALUES
  ('c1000001-0000-0000-0000-000000000011', '22222222-2222-2222-2222-222222222204', 'Three acres of manicured gardens and rose arbors', 1);
INSERT INTO venue_usps (id, venue_id, usp_text, sort_order) VALUES
  ('c1000001-0000-0000-0000-000000000012', '22222222-2222-2222-2222-222222222204', 'Garden ceremony with fountain backdrop', 2);

-- ============================================
-- 30. VENUE SEASONAL CONTENT
-- ============================================
INSERT INTO venue_seasonal_content (id, venue_id, season, imagery, phrases) VALUES
  ('c2000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'spring', 'Blooming dogwoods lining the drive, soft morning mist over the hills', ARRAY['spring awakening on the hilltop', 'dogwood blossoms framing your ceremony', 'fresh mountain air and new beginnings']);
INSERT INTO venue_seasonal_content (id, venue_id, season, imagery, phrases) VALUES
  ('c2000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', 'summer', 'Golden hour on the hilltop, fireflies in the meadow, starlit reception', ARRAY['summer sunsets that paint the sky', 'firefly-lit evenings', 'warm nights under the stars']);
INSERT INTO venue_seasonal_content (id, venue_id, season, imagery, phrases) VALUES
  ('c2000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', 'fall', 'Vibrant autumn leaves, mountain views in amber and gold, crisp air', ARRAY['fall foliage at its peak', 'amber and gold mountain views', 'crisp autumn air and warm celebration']);
INSERT INTO venue_seasonal_content (id, venue_id, season, imagery, phrases) VALUES
  ('c2000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', 'winter', 'Cozy fireside reception, bare branches against moody skies, warm candlelight', ARRAY['intimate winter gathering by the fire', 'candlelit celebration', 'cozy mountain retreat']);
INSERT INTO venue_seasonal_content (id, venue_id, season, imagery, phrases) VALUES
  ('c2000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222202', 'spring', 'Green meadow, wildflowers, baby animals on the farm', ARRAY['wildflower meadow in bloom', 'spring on the farm', 'new life all around']);
INSERT INTO venue_seasonal_content (id, venue_id, season, imagery, phrases) VALUES
  ('c2000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222202', 'summer', 'Sunset behind the barn, open doors with warm breeze', ARRAY['barn doors open to summer', 'golden light through the loft', 'summer nights in the meadow']);
INSERT INTO venue_seasonal_content (id, venue_id, season, imagery, phrases) VALUES
  ('c2000001-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222202', 'fall', 'Harvest vibes, pumpkins, warm tones in the barn', ARRAY['harvest celebration', 'autumn in the barn', 'warm tones and good people']);
INSERT INTO venue_seasonal_content (id, venue_id, season, imagery, phrases) VALUES
  ('c2000001-0000-0000-0000-000000000008', '22222222-2222-2222-2222-222222222202', 'winter', 'Cozy barn with string lights, hot cider, warm blankets', ARRAY['winter barn magic', 'string lights and hot cider', 'cozy and warm inside']);

-- ============================================
-- 31. VOICE PREFERENCES
-- ============================================
INSERT INTO voice_preferences (id, venue_id, preference_type, content, score, sample_count) VALUES
  ('c3000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'banned_phrase', 'I totally get it', -1.0, 3);
INSERT INTO voice_preferences (id, venue_id, preference_type, content, score, sample_count) VALUES
  ('c3000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', 'banned_phrase', 'Touch base', -1.0, 2);
INSERT INTO voice_preferences (id, venue_id, preference_type, content, score, sample_count) VALUES
  ('c3000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', 'approved_phrase', 'How exciting!', 1.0, 5);
INSERT INTO voice_preferences (id, venue_id, preference_type, content, score, sample_count) VALUES
  ('c3000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', 'dimension', 'warmth:high', 0.85, 8);
INSERT INTO voice_preferences (id, venue_id, preference_type, content, score, sample_count) VALUES
  ('c3000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222202', 'approved_phrase', 'Y''all are gonna love this', 1.0, 4);
INSERT INTO voice_preferences (id, venue_id, preference_type, content, score, sample_count) VALUES
  ('c3000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222202', 'banned_phrase', 'Per my last email', -1.0, 2);
INSERT INTO voice_preferences (id, venue_id, preference_type, content, score, sample_count) VALUES
  ('c3000001-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222203', 'dimension', 'formality:high', 0.90, 6);

-- ============================================
-- 32. VOICE TRAINING SESSIONS + RESPONSES
-- ============================================
INSERT INTO voice_training_sessions (id, venue_id, game_type, completed_rounds, total_rounds, staff_email, started_at, completed_at) VALUES
  ('c4000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'would_you_send', 20, 20, 'sarah@rixeymanor.com', '2026-03-20 10:00:00+00', '2026-03-20 10:25:00+00');
INSERT INTO voice_training_sessions (id, venue_id, game_type, completed_rounds, total_rounds, staff_email, started_at, completed_at) VALUES
  ('c4000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', 'cringe_or_fine', 15, 15, 'sarah@rixeymanor.com', '2026-03-20 10:30:00+00', '2026-03-20 10:45:00+00');
INSERT INTO voice_training_sessions (id, venue_id, game_type, completed_rounds, total_rounds, staff_email, started_at) VALUES
  ('c4000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222202', 'would_you_send', 12, 20, 'jake@crestwoodfarm.com', '2026-03-22 14:00:00+00');

INSERT INTO voice_training_responses (id, session_id, round_number, content_type, response, response_reason) VALUES
  ('c5000001-0000-0000-0000-000000000001', 'c4000001-0000-0000-0000-000000000001', 1, 'inquiry_greeting', 'send', 'Warm and personal, mentions their name');
INSERT INTO voice_training_responses (id, session_id, round_number, content_type, response, response_reason) VALUES
  ('c5000001-0000-0000-0000-000000000002', 'c4000001-0000-0000-0000-000000000001', 2, 'follow_up', 'edit', 'Too pushy — we never pressure');
INSERT INTO voice_training_responses (id, session_id, round_number, content_type, response, response_reason) VALUES
  ('c5000001-0000-0000-0000-000000000003', 'c4000001-0000-0000-0000-000000000001', 3, 'pricing_response', 'send', 'Good balance of info and invitation to tour');
INSERT INTO voice_training_responses (id, session_id, round_number, content_type, response, response_reason) VALUES
  ('c5000001-0000-0000-0000-000000000004', 'c4000001-0000-0000-0000-000000000002', 1, 'exclamation_usage', 'fine', 'One exclamation point is fine, three is cringe');

-- ============================================
-- 33. PHRASE USAGE (anti-duplication tracking)
-- ============================================
INSERT INTO phrase_usage (id, venue_id, contact_email, phrase_category, phrase_text) VALUES
  ('c6000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'aisha.j@outlook.com', 'greeting', 'How exciting!');
INSERT INTO phrase_usage (id, venue_id, contact_email, phrase_category, phrase_text) VALUES
  ('c6000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', 'aisha.j@outlook.com', 'tour_invite', 'We would absolutely love to show you both around');
INSERT INTO phrase_usage (id, venue_id, contact_email, phrase_category, phrase_text) VALUES
  ('c6000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', 'emma.rodriguez@gmail.com', 'greeting', 'Congratulations on your engagement!');

-- ============================================
-- 34. BOOKED DATES
-- ============================================
INSERT INTO booked_dates (id, venue_id, date, wedding_id, block_type) VALUES
  ('c7000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '2026-05-30', '44444444-4444-4444-4444-444444000109', 'wedding');
INSERT INTO booked_dates (id, venue_id, date, wedding_id, block_type) VALUES
  ('c7000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '2026-06-20', '44444444-4444-4444-4444-444444000110', 'wedding');
INSERT INTO booked_dates (id, venue_id, date, wedding_id, block_type) VALUES
  ('c7000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '2026-09-12', '44444444-4444-4444-4444-444444000111', 'wedding');
INSERT INTO booked_dates (id, venue_id, date, wedding_id, block_type) VALUES
  ('c7000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', '2026-10-17', '44444444-4444-4444-4444-444444000112', 'wedding');
INSERT INTO booked_dates (id, venue_id, date, wedding_id, block_type, notes) VALUES
  ('c7000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', '2026-07-04', NULL, 'maintenance', 'Annual deep clean and maintenance');

-- ============================================
-- 35. GUEST LIST (for Chloe & Ryan wedding 109)
-- ============================================
INSERT INTO guest_list (id, venue_id, wedding_id, group_name, rsvp_status, meal_preference, plus_one) VALUES
  ('c8000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Martinez Family', 'attending', 'chicken', false);
INSERT INTO guest_list (id, venue_id, wedding_id, group_name, rsvp_status, meal_preference, plus_one) VALUES
  ('c8000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Martinez Family', 'attending', 'vegetarian', false);
INSERT INTO guest_list (id, venue_id, wedding_id, group_name, rsvp_status, meal_preference, plus_one, plus_one_name) VALUES
  ('c8000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Brooks Family', 'attending', 'beef', true, 'Jennifer Brooks');
INSERT INTO guest_list (id, venue_id, wedding_id, group_name, rsvp_status, meal_preference) VALUES
  ('c8000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Brooks Family', 'attending', 'fish');
INSERT INTO guest_list (id, venue_id, wedding_id, group_name, rsvp_status) VALUES
  ('c8000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'College Friends', 'attending');
INSERT INTO guest_list (id, venue_id, wedding_id, group_name, rsvp_status) VALUES
  ('c8000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'College Friends', 'attending');
INSERT INTO guest_list (id, venue_id, wedding_id, group_name, rsvp_status) VALUES
  ('c8000001-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'College Friends', 'declined');
INSERT INTO guest_list (id, venue_id, wedding_id, group_name, rsvp_status) VALUES
  ('c8000001-0000-0000-0000-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Work', 'pending');
INSERT INTO guest_list (id, venue_id, wedding_id, group_name, rsvp_status, dietary_restrictions) VALUES
  ('c8000001-0000-0000-0000-000000000009', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Work', 'attending', 'gluten-free');
INSERT INTO guest_list (id, venue_id, wedding_id, group_name, rsvp_status) VALUES
  ('c8000001-0000-0000-0000-000000000010', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Neighbors', 'maybe');

-- ============================================
-- 36. SEATING TABLES + ASSIGNMENTS
-- ============================================
INSERT INTO seating_tables (id, venue_id, wedding_id, table_name, table_type, capacity, x_position, y_position) VALUES
  ('c9000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Head Table', 'head', 8, 400, 100);
INSERT INTO seating_tables (id, venue_id, wedding_id, table_name, table_type, capacity, x_position, y_position) VALUES
  ('c9000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Table 1', 'round', 10, 200, 300);
INSERT INTO seating_tables (id, venue_id, wedding_id, table_name, table_type, capacity, x_position, y_position) VALUES
  ('c9000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Table 2', 'round', 10, 600, 300);

INSERT INTO seating_assignments (id, venue_id, wedding_id, guest_id, table_id, seat_number) VALUES
  ('ca000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'c8000001-0000-0000-0000-000000000001', 'c9000001-0000-0000-0000-000000000001', 1);
INSERT INTO seating_assignments (id, venue_id, wedding_id, guest_id, table_id, seat_number) VALUES
  ('ca000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'c8000001-0000-0000-0000-000000000002', 'c9000001-0000-0000-0000-000000000001', 2);
INSERT INTO seating_assignments (id, venue_id, wedding_id, guest_id, table_id, seat_number) VALUES
  ('ca000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'c8000001-0000-0000-0000-000000000005', 'c9000001-0000-0000-0000-000000000002', 1);
INSERT INTO seating_assignments (id, venue_id, wedding_id, guest_id, table_id, seat_number) VALUES
  ('ca000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'c8000001-0000-0000-0000-000000000006', 'c9000001-0000-0000-0000-000000000002', 2);

-- ============================================
-- 37. TIMELINE (for wedding 109)
-- ============================================
INSERT INTO timeline (id, venue_id, wedding_id, time, duration_minutes, title, category, location, sort_order) VALUES
  ('cb000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', '15:00', 60, 'Bridal Party Gets Ready', 'preparation', 'Bridal Suite', 1);
INSERT INTO timeline (id, venue_id, wedding_id, time, duration_minutes, title, category, location, sort_order) VALUES
  ('cb000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', '16:30', 30, 'Ceremony', 'ceremony', 'Hilltop Lawn', 2);
INSERT INTO timeline (id, venue_id, wedding_id, time, duration_minutes, title, category, location, sort_order) VALUES
  ('cb000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', '17:00', 60, 'Cocktail Hour', 'reception', 'Patio', 3);
INSERT INTO timeline (id, venue_id, wedding_id, time, duration_minutes, title, category, location, sort_order) VALUES
  ('cb000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', '18:00', 90, 'Dinner', 'reception', 'Main Hall', 4);
INSERT INTO timeline (id, venue_id, wedding_id, time, duration_minutes, title, category, location, sort_order) VALUES
  ('cb000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', '19:30', 15, 'First Dance & Toasts', 'reception', 'Main Hall', 5);
INSERT INTO timeline (id, venue_id, wedding_id, time, duration_minutes, title, category, location, sort_order) VALUES
  ('cb000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', '19:45', 135, 'Dancing', 'reception', 'Main Hall', 6);
INSERT INTO timeline (id, venue_id, wedding_id, time, duration_minutes, title, category, location, sort_order) VALUES
  ('cb000001-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', '22:00', 15, 'Sparkler Send-Off', 'departure', 'Front Drive', 7);

-- ============================================
-- 38. BUDGET (for wedding 109)
-- ============================================
INSERT INTO budget (id, venue_id, wedding_id, category, item_name, estimated_cost, actual_cost, paid_amount) VALUES
  ('cc000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'venue', 'Rixey Manor Venue Rental', 8500, 8500, 8500);
INSERT INTO budget (id, venue_id, wedding_id, category, item_name, estimated_cost, actual_cost, paid_amount) VALUES
  ('cc000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'catering', 'BBQ Company Catering', 5200, 5400, 5400);
INSERT INTO budget (id, venue_id, wedding_id, category, item_name, estimated_cost, actual_cost, paid_amount) VALUES
  ('cc000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'bar', 'Mobile Bar Co', 2800, 3100, 3100);
INSERT INTO budget (id, venue_id, wedding_id, category, item_name, estimated_cost, actual_cost, paid_amount) VALUES
  ('cc000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'photography', 'Lens & Light Studio', 4500, 4500, 2250);
INSERT INTO budget (id, venue_id, wedding_id, category, item_name, estimated_cost, actual_cost) VALUES
  ('cc000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'florals', 'Valley Blooms', 3500, NULL);
INSERT INTO budget (id, venue_id, wedding_id, category, item_name, estimated_cost) VALUES
  ('cc000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'music', 'DJ Marcus', 1500);

-- ============================================
-- 39. SAGE CONVERSATIONS (for wedding 109)
-- ============================================
INSERT INTO sage_conversations (id, venue_id, wedding_id, role, content, confidence_score) VALUES
  ('cd000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'user', 'Hey Sage! Can we bring our dog to the ceremony?', NULL);
INSERT INTO sage_conversations (id, venue_id, wedding_id, role, content, model_used, tokens_used, cost, confidence_score) VALUES
  ('cd000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'assistant', 'Absolutely! Rixey Manor is very pet-friendly. Many of our couples include their dogs in the ceremony — it always makes for adorable photos! We just ask that you designate a pet handler for the reception so your pup has someone looking out for them while you''re dancing the night away. 🌿', 'claude-sonnet-4-20250514', 450, 0.0015, 95);
INSERT INTO sage_conversations (id, venue_id, wedding_id, role, content, confidence_score) VALUES
  ('cd000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'user', 'Perfect! Also, is there a backup plan if it rains on the ceremony?', NULL);
INSERT INTO sage_conversations (id, venue_id, wedding_id, role, content, model_used, tokens_used, cost, confidence_score, flagged_uncertain) VALUES
  ('cd000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'assistant', 'Great question! Rixey Manor does have a beautiful indoor option for ceremonies. That said, I want to make sure I give you the most up-to-date details on the rain plan setup — let me have Sarah confirm the specifics and get back to you. She''ll know exactly how the indoor transition works! 🌿', 'claude-sonnet-4-20250514', 480, 0.0016, 55, true);

-- ============================================
-- 40. SAGE UNCERTAIN QUEUE
-- ============================================
INSERT INTO sage_uncertain_queue (id, venue_id, wedding_id, conversation_id, question, sage_answer, confidence_score) VALUES
  ('ce000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'cd000001-0000-0000-0000-000000000004', 'Is there a backup plan if it rains on the ceremony?', 'Rixey Manor does have a beautiful indoor option for ceremonies...', 55);

-- ============================================
-- 41. PLANNING NOTES
-- ============================================
INSERT INTO planning_notes (id, venue_id, wedding_id, category, content, source_message) VALUES
  ('cf000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'vendor', 'BBQ Company confirmed for catering, needs access at 2pm', 'Chat message about catering setup');
INSERT INTO planning_notes (id, venue_id, wedding_id, category, content, source_message) VALUES
  ('cf000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'guest_count', 'Final count: 130 guests (5 pending RSVPs)', 'Updated from Sage chat');

-- ============================================
-- 42. CHECKLIST ITEMS
-- ============================================
INSERT INTO checklist_items (id, venue_id, wedding_id, title, description, due_date, category, is_completed, completed_at, sort_order) VALUES
  ('d0000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Book caterer', 'BBQ Company — confirmed', '2026-02-01', 'vendor', true, '2026-01-15 10:00:00+00', 1);
INSERT INTO checklist_items (id, venue_id, wedding_id, title, description, due_date, category, is_completed, completed_at, sort_order) VALUES
  ('d0000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Book photographer', 'Lens & Light Studio — deposit paid', '2026-02-15', 'vendor', true, '2026-02-10 14:00:00+00', 2);
INSERT INTO checklist_items (id, venue_id, wedding_id, title, description, due_date, category, is_completed, sort_order) VALUES
  ('d0000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Send invitations', NULL, '2026-03-01', 'logistics', true, 3);
INSERT INTO checklist_items (id, venue_id, wedding_id, title, due_date, category, is_completed, sort_order) VALUES
  ('d0000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Finalize seating chart', '2026-05-15', 'logistics', false, 4);
INSERT INTO checklist_items (id, venue_id, wedding_id, title, due_date, category, is_completed, sort_order) VALUES
  ('d0000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Confirm florist selections', '2026-04-30', 'vendor', false, 5);
INSERT INTO checklist_items (id, venue_id, wedding_id, title, due_date, category, is_completed, sort_order) VALUES
  ('d0000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Schedule hair and makeup trial', '2026-04-15', 'personal', false, 6);

-- ============================================
-- 43. MESSAGES (coordinator-couple)
-- ============================================
INSERT INTO messages (id, venue_id, wedding_id, sender_id, sender_role, content) VALUES
  ('d1000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', '33333333-3333-3333-3333-333333333301', 'venue_manager', 'Hi Chloe! Just checking in — have you finalized your caterer? Happy to share some recommendations if you need them!');
INSERT INTO messages (id, venue_id, wedding_id, sender_role, content) VALUES
  ('d1000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'couple', 'Yes! We went with BBQ Company — they were amazing at the tasting. Thanks for the rec!');
INSERT INTO messages (id, venue_id, wedding_id, sender_id, sender_role, content) VALUES
  ('d1000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', '33333333-3333-3333-3333-333333333301', 'venue_manager', 'Such a great choice! Their brisket is incredible. Let me know when you''re ready to do the walkthrough for setup logistics.');

-- ============================================
-- 44. VENDOR RECOMMENDATIONS
-- ============================================
INSERT INTO vendor_recommendations (id, venue_id, vendor_name, vendor_type, contact_email, website_url, description, is_preferred, sort_order) VALUES
  ('d2000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'BBQ Company', 'caterer', 'hello@bbqcompany.com', 'https://bbqcompany.com', 'Farm-to-table BBQ and Southern cuisine. Our most booked caterer.', true, 1);
INSERT INTO vendor_recommendations (id, venue_id, vendor_name, vendor_type, contact_email, website_url, description, is_preferred, sort_order) VALUES
  ('d2000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', 'Lens & Light Studio', 'photographer', 'info@lensandlight.com', 'https://lensandlight.com', 'Documentary-style wedding photography. Knows our venue inside and out.', true, 2);
INSERT INTO vendor_recommendations (id, venue_id, vendor_name, vendor_type, contact_email, description, sort_order) VALUES
  ('d2000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', 'Valley Blooms', 'florist', 'sarah@valleyblooms.com', 'Local florist specializing in garden-style and wildflower arrangements.', 3);
INSERT INTO vendor_recommendations (id, venue_id, vendor_name, vendor_type, contact_email, description, sort_order) VALUES
  ('d2000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', 'Mobile Bar Co', 'bartender', 'book@mobilebarco.com', 'Full-service mobile bar with craft cocktails. BYOB bar service.', 4);
INSERT INTO vendor_recommendations (id, venue_id, vendor_name, vendor_type, description, sort_order) VALUES
  ('d2000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', 'DJ Marcus', 'dj', 'High energy but reads the room. Great with timelines.', 5);

-- ============================================
-- 45. CONTRACTS
-- ============================================
INSERT INTO contracts (id, venue_id, wedding_id, filename, file_type, storage_path) VALUES
  ('d3000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'BBQ_Company_Contract.pdf', 'application/pdf', 'contracts/109/bbq-company.pdf');

-- ============================================
-- 46. INSPO GALLERY
-- ============================================
INSERT INTO inspo_gallery (id, venue_id, image_url, caption, tags) VALUES
  ('d4000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '/placeholder/hilltop-ceremony.jpg', 'Golden hour ceremony on the hilltop', ARRAY['ceremony', 'outdoor', 'golden-hour']);
INSERT INTO inspo_gallery (id, venue_id, image_url, caption, tags) VALUES
  ('d4000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '/placeholder/reception-hall.jpg', 'String lights and farm tables in the reception hall', ARRAY['reception', 'indoor', 'rustic']);
INSERT INTO inspo_gallery (id, venue_id, image_url, caption, tags) VALUES
  ('d4000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '/placeholder/bridal-suite.jpg', 'Getting ready in the bridal suite', ARRAY['bridal-suite', 'preparation']);

-- ============================================
-- 47. API COSTS
-- ============================================
INSERT INTO api_costs (id, venue_id, service, model, input_tokens, output_tokens, cost, context) VALUES
  ('d5000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', 'anthropic', 'claude-sonnet-4-20250514', 1250, 450, 0.0045, 'inquiry_brain');
INSERT INTO api_costs (id, venue_id, service, model, input_tokens, output_tokens, cost, context) VALUES
  ('d5000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', 'anthropic', 'claude-sonnet-4-20250514', 1180, 420, 0.0042, 'inquiry_brain');
INSERT INTO api_costs (id, venue_id, service, model, input_tokens, output_tokens, cost, context) VALUES
  ('d5000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222202', 'anthropic', 'claude-sonnet-4-20250514', 1100, 380, 0.0038, 'inquiry_brain');
INSERT INTO api_costs (id, venue_id, service, model, input_tokens, output_tokens, cost, context) VALUES
  ('d5000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', 'anthropic', 'claude-sonnet-4-20250514', 2500, 800, 0.0195, 'weekly_briefing');
INSERT INTO api_costs (id, venue_id, service, model, input_tokens, output_tokens, cost, context) VALUES
  ('d5000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', 'anthropic', 'claude-sonnet-4-20250514', 450, 180, 0.0015, 'sage_chat');
INSERT INTO api_costs (id, venue_id, service, model, input_tokens, output_tokens, cost, context) VALUES
  ('d5000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222201', 'anthropic', 'claude-sonnet-4-20250514', 1800, 600, 0.0144, 'anomaly_explanation');

-- ============================================
-- 48. NATURAL LANGUAGE QUERIES
-- ============================================
INSERT INTO natural_language_queries (id, venue_id, user_id, query_text, response_text, model_used, tokens_used, cost, helpful) VALUES
  ('d6000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', 'How are we doing compared to last month?', 'March is looking strong! You''ve received 6 inquiries so far (up from 4 in February). Your response time has been averaging 120 minutes, which is a bit higher than last month''s 82 minutes — worth watching. The big win: The Knot continues to be your top source with 3 of the 6 inquiries. No bookings yet this month, but you have 2 hot leads and a pending proposal.', 'claude-sonnet-4-20250514', 3200, 0.0195, true);
INSERT INTO natural_language_queries (id, venue_id, user_id, query_text, response_text, model_used, tokens_used, cost) VALUES
  ('d6000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', 'Which source gives us the best ROI?', 'Based on Q1 2026 data: The Knot is your best performer with an ROI of 39.3x ($1,050 spend → $42,300 revenue from 3 bookings). Instagram comes second at 18.7x, and Google Ads at 18.1x. The Knot also has your highest conversion rate at 37.5%. One thing to note: referrals have zero ad spend but generated significant bookings — your word of mouth is working.', 'claude-sonnet-4-20250514', 2800, 0.0165);

-- ============================================
-- DONE! 47 tables seeded across all three product areas.
-- ============================================
