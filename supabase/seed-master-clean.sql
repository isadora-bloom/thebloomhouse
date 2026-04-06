-- ============================================
-- MASTER CLEAN SEED — April 3, 2026
-- Run in Supabase SQL Editor
-- All column orders verified against migration schemas
-- Uses ON CONFLICT DO NOTHING for safety
-- ============================================

-- Venue IDs:
--   Hawthorne:     22222222-2222-2222-2222-222222222201
--   Crestwood: 22222222-2222-2222-2222-222222222202
--   Glass:     22222222-2222-2222-2222-222222222203
--   Rose Hill: 22222222-2222-2222-2222-222222222204

-- ============================================
-- 1. VENDOR RECOMMENDATIONS
-- Schema: id, venue_id, vendor_name, vendor_type, contact_email,
--         contact_phone, website_url, description, logo_url,
--         is_preferred, sort_order, click_count, created_at
-- ============================================

INSERT INTO vendor_recommendations (id, venue_id, vendor_name, vendor_type, contact_email, contact_phone, website_url, description, is_preferred, click_count) VALUES
('ff000001-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'Sarah Jones Photography', 'Photographer', 'sarah@sarahjonesphotography.com', '(540) 555-0101', 'https://sarahjonesphotography.com', 'Fine art wedding photographer specializing in outdoor ceremonies. 10+ years at Hawthorne.', true, 34),
('ff000001-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'Blue Ridge Films', 'Videographer', 'hello@blueridgefilms.com', '(540) 555-0102', 'https://blueridgefilms.com', 'Cinematic wedding films with same-day edits available.', true, 22),
('ff000001-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'Wildflower & Vine', 'Florist', 'orders@wildflowerandvine.com', '(540) 555-0103', 'https://wildflowerandvine.com', 'Locally sourced, seasonal arrangements. Garden-style and romantic designs.', true, 45),
('ff000001-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'DJ Marcus Cole', 'DJ', 'marcus@djmarcuscole.com', '(804) 555-0104', NULL, 'High energy DJ who reads the room. Ceremony + reception packages.', true, 18),
('ff000001-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'Sweet Layers Bakery', 'Baker', 'info@sweetlayers.com', '(540) 555-0105', 'https://sweetlayers.com', 'Custom wedding cakes and dessert tables. Tastings available.', false, 12),
('ff000001-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'Reverend James Walsh', 'Officiant', 'rev.walsh@gmail.com', '(540) 555-0106', NULL, 'Non-denominational officiant. Warm, personal ceremonies.', true, 8),
('ff000001-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', 'Luxe Mobile Bar Co.', 'Rentals', 'bookings@luxemobilebar.com', '(804) 555-0107', 'https://luxemobilebar.com', 'Mobile bar service with craft cocktails. Full bar packages.', false, 15),
('ff000001-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', 'Glam Squad RVA', 'Hair & Makeup', 'book@glamsquadrva.com', '(804) 555-0108', 'https://glamsquadrva.com', 'On-site bridal beauty team. 6+ artists available.', true, 28),
('ff000001-0001-0001-0002-000000000001', '22222222-2222-2222-2222-222222222202', 'Rustic Lens Photography', 'Photographer', 'hello@rusticlens.com', '(434) 555-0201', 'https://rusticlens.com', 'Documentary-style photographer who loves barn weddings.', true, 19),
('ff000001-0001-0001-0002-000000000002', '22222222-2222-2222-2222-222222222202', 'Blue Ridge Bar Co.', 'Rentals', 'info@blueridgebar.com', '(434) 555-0202', 'https://blueridgebar.com', 'Craft cocktail bar service. They know our space really well.', true, 31),
('ff000001-0001-0001-0002-000000000003', '22222222-2222-2222-2222-222222222202', 'Meadow Blooms', 'Florist', 'flowers@meadowblooms.com', '(434) 555-0203', NULL, 'Wildflower specialists. Free-form and meadow-inspired designs.', true, 25),
('ff000001-0001-0001-0002-000000000004', '22222222-2222-2222-2222-222222222202', 'Smoky Mountain Catering', 'Caterer', 'events@smokymtncatering.com', '(434) 555-0204', 'https://smokymtncatering.com', 'Farm-to-table catering with BBQ and Southern comfort menus.', true, 40),
('ff000001-0001-0001-0002-000000000005', '22222222-2222-2222-2222-222222222202', 'The String Quartet VA', 'Band', 'book@stringquartetva.com', '(434) 555-0205', NULL, 'Live ceremony music. Strings, acoustic, and cocktail hour sets.', false, 7)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 2. SOCIAL POSTS
-- Schema: id, venue_id, platform, posted_at, caption, post_url,
--         reach, impressions, saves, shares, comments, likes,
--         website_clicks, profile_visits, engagement_rate, is_viral, created_at
-- ============================================

INSERT INTO social_posts (id, venue_id, platform, posted_at, caption, reach, impressions, saves, shares, comments, likes, website_clicks, engagement_rate, is_viral) VALUES
('ff000002-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-01-05 14:00:00+00', 'Winter magic at Hawthorne Manor. Fresh snow on the ceremony meadow.', 4200, 5100, 89, 34, 67, 312, 23, 4.8, false),
('ff000002-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-01-12 16:00:00+00', 'Behind the scenes: Our team prepping for a stunning January wedding.', 3800, 4500, 56, 28, 45, 278, 18, 4.2, false),
('ff000002-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'facebook', '2026-01-18 12:00:00+00', 'Engagement season is HERE! Book your tour before spring fills up.', 6200, 7800, 0, 89, 34, 156, 67, 3.1, false),
('ff000002-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-01-25 15:00:00+00', 'This couple said YES to the venue after their sunset tour!', 8900, 11200, 234, 112, 156, 890, 45, 7.2, true),
('ff000002-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-02-02 13:00:00+00', 'Valentine vibes at the manor. Love is literally in the air.', 5100, 6300, 78, 45, 89, 456, 34, 5.6, false),
('ff000002-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-02-10 17:00:00+00', 'Real wedding feature: Emily & James, October garden ceremony', 7200, 8900, 167, 78, 123, 678, 56, 6.1, false),
('ff000002-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', 'facebook', '2026-02-16 11:00:00+00', 'Spring open house announcement! March 15th - tours, tastings, vendors.', 9800, 12400, 0, 156, 67, 234, 123, 4.5, false),
('ff000002-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-02-22 14:30:00+00', 'New ceremony spot alert: The Willow Arch is ready for spring!', 6700, 8100, 145, 67, 98, 567, 42, 5.9, false),
('ff000002-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-03-01 15:00:00+00', 'March at the Manor: cherry blossoms starting to bloom on the ceremony path', 5400, 6800, 98, 56, 78, 412, 28, 5.3, false),
('ff000002-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-03-08 16:00:00+00', 'Tour day! 6 couples falling in love with the space today.', 4100, 5200, 67, 34, 56, 345, 45, 5.1, false),
('ff000002-0001-0001-0001-000000000011', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-03-15 12:00:00+00', 'Open house RECAP: 42 couples toured, 8 booked on the spot!', 12300, 15600, 312, 189, 234, 1230, 89, 8.4, true),
('ff000002-0001-0001-0001-000000000012', '22222222-2222-2222-2222-222222222201', 'facebook', '2026-03-22 14:00:00+00', 'Wedding season is officially here! First March wedding this weekend.', 7800, 9600, 0, 112, 56, 345, 67, 4.8, false),
('ff000002-0001-0001-0002-000000000001', '22222222-2222-2222-2222-222222222202', 'instagram', '2026-01-08 13:00:00+00', 'Fresh hay, fairy lights, and a whole lotta love at the barn.', 3200, 4100, 67, 28, 45, 234, 15, 4.5, false),
('ff000002-0001-0001-0002-000000000002', '22222222-2222-2222-2222-222222222202', 'instagram', '2026-01-20 15:00:00+00', 'Cozy winter wedding alert! Hot cocoa bar was a HIT.', 4500, 5800, 123, 56, 89, 378, 23, 5.8, false),
('ff000002-0001-0001-0002-000000000003', '22222222-2222-2222-2222-222222222202', 'instagram', '2026-02-05 14:00:00+00', 'Fields are waking up! Spring wedding season loading...', 3800, 4900, 78, 34, 56, 289, 18, 4.7, false),
('ff000002-0001-0001-0002-000000000004', '22222222-2222-2222-2222-222222222202', 'instagram', '2026-02-18 16:00:00+00', 'Vendor spotlight: Blue Ridge Bar Co. makes the BEST craft cocktails.', 2900, 3700, 45, 23, 34, 198, 34, 4.2, false),
('ff000002-0001-0001-0002-000000000005', '22222222-2222-2222-2222-222222222202', 'instagram', '2026-03-02 13:00:00+00', 'Wildflower season is coming and we cannot WAIT.', 4100, 5300, 89, 45, 67, 312, 21, 5.1, false),
('ff000002-0001-0001-0002-000000000006', '22222222-2222-2222-2222-222222222202', 'instagram', '2026-03-18 15:00:00+00', 'Another barn tour, another couple in love. Spring bookings filling fast!', 3600, 4600, 78, 34, 56, 267, 28, 4.8, false)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 3. VENUE HEALTH (weekly scores, 3 months)
-- Schema: id, venue_id, calculated_at, overall_score,
--         data_quality_score, pipeline_score,
--         response_time_score, booking_rate_score, created_at
-- ============================================

INSERT INTO venue_health (id, venue_id, calculated_at, overall_score, data_quality_score, pipeline_score, response_time_score, booking_rate_score) VALUES
('ff000003-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '2026-01-06', 72, 85, 65, 78, 60),
('ff000003-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '2026-01-13', 74, 85, 68, 80, 63),
('ff000003-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '2026-01-20', 76, 87, 70, 82, 65),
('ff000003-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '2026-01-27', 73, 87, 66, 75, 64),
('ff000003-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '2026-02-03', 78, 88, 72, 84, 68),
('ff000003-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '2026-02-10', 80, 88, 75, 85, 72),
('ff000003-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '2026-02-17', 82, 90, 78, 86, 74),
('ff000003-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', '2026-02-24', 79, 90, 74, 80, 72),
('ff000003-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', '2026-03-03', 84, 91, 80, 88, 77),
('ff000003-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222201', '2026-03-10', 86, 92, 82, 89, 81),
('ff000003-0001-0001-0001-000000000011', '22222222-2222-2222-2222-222222222201', '2026-03-17', 85, 92, 81, 87, 80),
('ff000003-0001-0001-0001-000000000012', '22222222-2222-2222-2222-222222222201', '2026-03-24', 87, 93, 84, 90, 81),
('ff000003-0001-0001-0002-000000000001', '22222222-2222-2222-2222-222222222202', '2026-01-06', 65, 70, 58, 72, 60),
('ff000003-0001-0001-0002-000000000002', '22222222-2222-2222-2222-222222222202', '2026-01-20', 68, 72, 62, 74, 64),
('ff000003-0001-0001-0002-000000000003', '22222222-2222-2222-2222-222222222202', '2026-02-03', 71, 75, 66, 76, 67),
('ff000003-0001-0001-0002-000000000004', '22222222-2222-2222-2222-222222222202', '2026-02-17', 74, 78, 70, 78, 70),
('ff000003-0001-0001-0002-000000000005', '22222222-2222-2222-2222-222222222202', '2026-03-03', 76, 80, 72, 80, 72),
('ff000003-0001-0001-0002-000000000006', '22222222-2222-2222-2222-222222222202', '2026-03-17', 78, 82, 74, 82, 74),
('ff000003-0001-0001-0003-000000000001', '22222222-2222-2222-2222-222222222203', '2026-01-06', 80, 90, 75, 82, 73),
('ff000003-0001-0001-0003-000000000002', '22222222-2222-2222-2222-222222222203', '2026-02-03', 83, 91, 78, 85, 78),
('ff000003-0001-0001-0003-000000000003', '22222222-2222-2222-2222-222222222203', '2026-03-03', 85, 92, 80, 87, 81),
('ff000003-0001-0001-0004-000000000001', '22222222-2222-2222-2222-222222222204', '2026-01-06', 45, 50, 35, 55, 40),
('ff000003-0001-0001-0004-000000000002', '22222222-2222-2222-2222-222222222204', '2026-02-03', 52, 58, 42, 60, 48),
('ff000003-0001-0001-0004-000000000003', '22222222-2222-2222-2222-222222222204', '2026-03-03', 58, 65, 48, 65, 54)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 4. ADMIN NOTIFICATIONS
-- Schema: id, venue_id, wedding_id, type, title, body,
--         read, read_at, email_sent, created_at
-- ============================================

INSERT INTO admin_notifications (id, venue_id, wedding_id, type, title, body, read, created_at) VALUES
('ff000004-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', NULL, 'system', 'Weekly briefing ready', 'Your March Week 4 intelligence briefing is ready to review.', true, '2026-03-24 08:00:00+00'),
('ff000004-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'sage_uncertain', 'Sage flagged a question (needs confirmation)', '"Can we bring sparklers for the send-off?" -- Confidence: 65%. Check the Sage Queue.', true, '2026-03-22 14:30:00+00'),
('ff000004-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', NULL, 'anomaly', 'Inquiry volume spike detected', 'Inquiries are up 40% week-over-week. Spring engagement season driving traffic.', true, '2026-03-15 09:00:00+00'),
('ff000004-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 'pipeline', 'Lead going cold: Nguyen wedding', 'No response in 10 days after tour. Consider a follow-up.', false, '2026-03-28 10:00:00+00'),
('ff000004-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', NULL, 'system', 'New review on The Knot', '5-star review: "Absolutely magical venue." Review language extracted for AI training.', false, '2026-03-30 16:00:00+00'),
('ff000004-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000118', 'sage_uncertain', 'Sage flagged a question (low confidence)', '"What is the corkage fee for outside wine?" -- Confidence: 42%. Check the Sage Queue.', false, '2026-04-01 11:00:00+00'),
('ff000004-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', NULL, 'pipeline', 'Booking milestone: 20 weddings booked for 2026', 'You have hit 20 confirmed bookings for the 2026 season.', true, '2026-03-18 09:00:00+00'),
('ff000004-0001-0001-0002-000000000001', '22222222-2222-2222-2222-222222222202', NULL, 'system', 'Weekly briefing ready', 'Your March Week 4 briefing for Crestwood Farm is ready.', false, '2026-03-24 08:00:00+00'),
('ff000004-0001-0001-0002-000000000002', '22222222-2222-2222-2222-222222222202', NULL, 'anomaly', 'Response time increasing', 'Average first response time has increased to 4.2 hours, up from 2.1 hours last week.', false, '2026-03-26 09:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 5. FOLLOW-UP SEQUENCES
-- Schema: id, venue_id, name, description, trigger_type,
--         trigger_config, is_active, created_at
-- ============================================

INSERT INTO follow_up_sequences (id, venue_id, name, description, trigger_type, trigger_config, is_active) VALUES
('ff000005-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'Post-Tour Follow-Up', 'Nurture leads after they complete a venue tour', 'post_tour', '{"days_after": 1, "stage": "tour_completed"}', true),
('ff000005-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'Ghosted Re-engagement', 'Re-engage leads who have gone silent', 'ghosted', '{"days_no_response": 7}', true),
('ff000005-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'Post-Booking Nurture', 'Welcome and onboard newly booked couples', 'post_booking', '{"trigger_on_status": "booked"}', true),
('ff000005-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'Pre-Event Check-In', 'Countdown communications before the wedding', 'pre_event', '{"days_before_event": 30}', true)
ON CONFLICT (id) DO NOTHING;

-- Schema: id, sequence_id, step_order, delay_days, action_type,
--         email_subject_template, email_body_template, is_active, created_at
INSERT INTO sequence_steps (id, sequence_id, step_order, delay_days, action_type, email_subject_template, email_body_template, is_active) VALUES
('ff000006-0001-0001-0001-000000000001', 'ff000005-0001-0001-0001-000000000001', 1, 1, 'email', 'So great meeting you at {venue_name}!', 'Thank them for touring, reference something specific they loved, mention next steps', true),
('ff000006-0001-0001-0001-000000000002', 'ff000005-0001-0001-0001-000000000001', 2, 4, 'email', 'A few things I forgot to mention about {venue_name}', 'Share one new detail they did not see on tour, seasonal note, soft CTA', true),
('ff000006-0001-0001-0001-000000000003', 'ff000005-0001-0001-0001-000000000001', 3, 7, 'task', NULL, 'Create task: Follow up with {couple_name} - 1 week post-tour', true),
('ff000006-0001-0001-0002-000000000001', 'ff000005-0001-0001-0001-000000000002', 1, 7, 'email', 'Still thinking about {venue_name}?', 'Friendly check-in, share one new thing (seasonal update, new photos)', true),
('ff000006-0001-0001-0002-000000000002', 'ff000005-0001-0001-0001-000000000002', 2, 14, 'email', 'Quick question about your wedding plans', 'Simple yes/no question, mention availability is filling', true),
('ff000006-0001-0001-0002-000000000003', 'ff000005-0001-0001-0001-000000000002', 3, 21, 'alert', NULL, 'Alert: {couple_name} has not responded in 21 days. Consider a personal call.', true),
('ff000006-0001-0001-0002-000000000004', 'ff000005-0001-0001-0001-000000000002', 4, 30, 'email', 'We would love to stay in touch', 'Final gentle outreach, no pressure, leave door open', true),
('ff000006-0001-0001-0003-000000000001', 'ff000005-0001-0001-0001-000000000003', 1, 0, 'email', 'Welcome to the {venue_name} family!', 'Congratulations, here is what happens next, introduce coordinator, link to portal', true),
('ff000006-0001-0001-0003-000000000002', 'ff000005-0001-0001-0001-000000000003', 2, 3, 'email', 'Your planning portal is ready', 'Walk through portal features, timeline, budget tool, vendor recs', true),
('ff000006-0001-0001-0003-000000000003', 'ff000005-0001-0001-0001-000000000003', 3, 7, 'email', 'Meet your preferred vendors', 'Curated vendor list, booking tips, seasonal notes', true),
('ff000006-0001-0001-0003-000000000004', 'ff000005-0001-0001-0001-000000000003', 4, 14, 'task', NULL, 'Create task: Schedule first planning call with {couple_name}', true),
('ff000006-0001-0001-0004-000000000001', 'ff000005-0001-0001-0001-000000000004', 1, 0, 'email', '30 days until your wedding at {venue_name}!', 'Countdown excitement, checklist reminder, timeline review request', true),
('ff000006-0001-0001-0004-000000000002', 'ff000005-0001-0001-0001-000000000004', 2, 14, 'email', '2 weeks to go! Final details for your big day', 'Final headcount deadline, vendor confirmations, rain plan reminder', true),
('ff000006-0001-0001-0004-000000000003', 'ff000005-0001-0001-0001-000000000004', 3, 23, 'email', '1 week countdown!', 'Day-of timeline, arrival instructions, emergency contacts, weather forecast', true),
('ff000006-0001-0001-0004-000000000004', 'ff000005-0001-0001-0001-000000000004', 4, 27, 'task', NULL, 'Create task: Final venue walkthrough with {couple_name} - 3 days before', true)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 6. SAGE UNCERTAIN QUEUE
-- Schema: id, venue_id, wedding_id, conversation_id, question,
--         sage_answer, confidence_score, coordinator_response,
--         resolved_by, resolved_at, added_to_kb, created_at
-- ============================================

INSERT INTO sage_uncertain_queue (id, venue_id, wedding_id, question, sage_answer, confidence_score, coordinator_response, resolved_at, added_to_kb, created_at) VALUES
('ff000007-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Can we bring sparklers for the send-off?', 'I believe sparklers are allowed in the outdoor areas, but I want to make sure I give you the right answer on this! I have flagged this for your coordinator to confirm.', 65, NULL, NULL, false, '2026-03-22 14:30:00+00'),
('ff000007-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000118', 'What is your corkage fee for outside wine?', 'Great question! I want to make sure I give you the right answer, so let me check with your coordinator and get back to you on this.', 42, NULL, NULL, false, '2026-04-01 11:00:00+00'),
('ff000007-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Do you allow fog machines for the first dance?', 'That is a great question! I want to make sure I give you the right answer, so let me check with your coordinator.', 38, NULL, NULL, false, '2026-03-28 16:00:00+00'),
('ff000007-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Is there a backup rain plan for outdoor ceremonies?', 'Yes! We have a beautiful covered pavilion that seats up to 200 guests.', 72, 'Yes, the covered pavilion is our rain plan. Included at no extra cost. We monitor weather 48 hours out.', '2026-03-20 10:00:00+00', true, '2026-03-19 15:00:00+00'),
('ff000007-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 'Can our dog be in the ceremony?', 'I believe pets are welcome but let me confirm the details with your coordinator!', 68, 'Absolutely! Dogs are welcome at outdoor ceremonies. Just have a handler who can take them after. We have a water station!', '2026-03-15 11:00:00+00', true, '2026-03-14 16:30:00+00'),
('ff000007-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000112', 'What time does the music have to stop?', 'I want to make sure I give you the exact details on this. Let me flag it for your coordinator!', 55, 'Music must end by 10:30 PM per county noise ordinance. Last call 10:00 PM, venue closes 11:00 PM.', '2026-03-10 09:00:00+00', true, '2026-03-09 20:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 7. KNOWLEDGE BASE (additional entries)
-- Schema: id, venue_id, category, question, answer,
--         keywords, priority, is_active
-- ============================================

INSERT INTO knowledge_base (id, venue_id, category, question, answer, keywords, priority, is_active) VALUES
('ff000008-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'logistics', 'What time can vendors arrive for setup?', 'Vendors can begin setup at 10:00 AM for evening events, or 8:00 AM for daytime events. The venue provides 6 hours of setup time.', ARRAY['setup', 'vendors', 'arrival', 'time'], 2, true),
('ff000008-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'logistics', 'Is there a bridal suite for getting ready?', 'Yes! Beautiful bridal suite with natural light, full-length mirrors, space for 8. Separate groomsmen lounge with pool table and mini fridge.', ARRAY['bridal suite', 'getting ready', 'rooms'], 2, true),
('ff000008-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'pricing', 'Is there a minimum spend requirement?', 'Base venue rental starts at $8,500 for Saturday evenings. Includes ceremony site, reception hall, bridal suite, groomsmen lounge, and 8 hours of exclusive access.', ARRAY['pricing', 'cost', 'minimum', 'rental'], 1, true),
('ff000008-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'availability', 'Do you host multiple weddings per day?', 'Never! We are a one-wedding-per-day venue. Your day is exclusively yours from setup through cleanup.', ARRAY['exclusive', 'multiple', 'same day'], 1, true),
('ff000008-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'general', 'What is the noise ordinance?', 'Outdoor amplified music must end by 10:30 PM per county ordinance. Indoor music until 11:00 PM. Last call 10:00 PM, venue closes 11:00 PM.', ARRAY['noise', 'music', 'time', 'curfew'], 1, true),
('ff000008-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'general', 'Are pets allowed?', 'Dogs are welcome at outdoor ceremonies! Have a designated handler. We provide a water station for four-legged guests.', ARRAY['pets', 'dogs', 'animals'], 2, true),
('ff000008-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', 'logistics', 'What is the rain plan?', 'Covered pavilion seats 200 with the same mountain views. Included at no extra charge. We monitor weather together 48 hours out.', ARRAY['rain', 'weather', 'backup', 'indoor'], 1, true),
('ff000008-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', 'pricing', 'What does the catering package include?', 'In-house catering starts at $85 per person: cocktail hour with 4 passed apps, salad, choice of 2 entrees, sides, dessert bar. Plated and family-style available.', ARRAY['catering', 'food', 'menu', 'per person'], 1, true),
('ff000008-0001-0001-0002-000000000001', '22222222-2222-2222-2222-222222222202', 'general', 'Is the barn heated and air-conditioned?', 'Yes! Climate control with industrial ceiling fans for summer and radiant heat for cooler months. Comfortable year-round.', ARRAY['barn', 'heat', 'ac', 'temperature'], 1, true),
('ff000008-0001-0001-0002-000000000002', '22222222-2222-2222-2222-222222222202', 'logistics', 'Can we have a bonfire?', 'Absolutely! Fire pit area seats about 40 guests. We provide firewood. S''mores supplies available as an add-on.', ARRAY['bonfire', 'fire pit', 'smores'], 2, true),
('ff000008-0001-0001-0002-000000000003', '22222222-2222-2222-2222-222222222202', 'pricing', 'What is the venue rental fee?', 'Crestwood Farm starts at $6,500 for Friday and Saturday. Includes barn, ceremony meadow, getting-ready cottage, and bonfire area. Sundays start at $5,000.', ARRAY['pricing', 'cost', 'rental', 'fee'], 1, true)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 8. ENGAGEMENT EVENTS
-- Schema: id, venue_id, wedding_id, event_type,
--         points, metadata, created_at
-- ============================================

INSERT INTO engagement_events (id, venue_id, wedding_id, event_type, points, metadata, created_at) VALUES
('ff000009-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'initial_inquiry', 40, '{"source": "the_knot"}', '2026-01-08 10:00:00+00'),
('ff000009-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'email_reply', 5, '{}', '2026-01-08 14:00:00+00'),
('ff000009-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'tour_booked', 15, '{}', '2026-01-10 11:00:00+00'),
('ff000009-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'tour_completed', 25, '{}', '2026-01-15 16:00:00+00'),
('ff000009-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'proposal_viewed', 10, '{}', '2026-01-17 09:00:00+00'),
('ff000009-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'contract_signed', 50, '{}', '2026-01-20 14:00:00+00'),
('ff000009-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'portal_login', 3, '{}', '2026-01-22 10:00:00+00'),
('ff000009-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'portal_login', 3, '{}', '2026-02-05 19:00:00+00'),
('ff000009-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'email_reply', 5, '{}', '2026-02-12 11:00:00+00'),
('ff000009-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'portal_login', 3, '{}', '2026-03-01 20:00:00+00'),
('ff000009-0001-0001-0002-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 'initial_inquiry', 40, '{"source": "google"}', '2026-02-01 09:00:00+00'),
('ff000009-0001-0001-0002-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 'email_reply', 5, '{}', '2026-02-02 10:00:00+00'),
('ff000009-0001-0001-0002-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 'tour_booked', 15, '{}', '2026-02-05 14:00:00+00'),
('ff000009-0001-0001-0002-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 'tour_completed', 25, '{}', '2026-02-12 15:00:00+00'),
('ff000009-0001-0001-0002-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 'email_reply', 5, '{}', '2026-02-15 11:00:00+00'),
('ff000009-0001-0001-0003-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 'initial_inquiry', 40, '{"source": "weddingwire"}', '2026-03-05 11:00:00+00'),
('ff000009-0001-0001-0003-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 'email_opened', 2, '{}', '2026-03-06 08:00:00+00'),
('ff000009-0001-0001-0004-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000118', 'initial_inquiry', 40, '{"source": "instagram"}', '2026-03-25 10:00:00+00'),
('ff000009-0001-0001-0004-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000118', 'email_reply', 5, '{}', '2026-03-26 09:00:00+00'),
('ff000009-0001-0001-0004-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000118', 'email_reply', 5, '{}', '2026-03-30 14:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 9. LEAD SCORE HISTORY
-- Schema: id, venue_id, wedding_id, score,
--         temperature_tier, calculated_at
-- ============================================

INSERT INTO lead_score_history (id, venue_id, wedding_id, score, temperature_tier, calculated_at) VALUES
('ff00000a-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 40, 'cool', '2026-01-08'),
('ff00000a-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 55, 'cool', '2026-01-12'),
('ff00000a-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 80, 'hot', '2026-01-15'),
('ff00000a-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 90, 'hot', '2026-01-20'),
('ff00000a-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 95, 'hot', '2026-02-01'),
('ff00000a-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 92, 'hot', '2026-03-01'),
('ff00000a-0001-0001-0002-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 40, 'cool', '2026-02-01'),
('ff00000a-0001-0001-0002-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 55, 'cool', '2026-02-05'),
('ff00000a-0001-0001-0002-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 72, 'warm', '2026-02-12'),
('ff00000a-0001-0001-0002-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 68, 'warm', '2026-03-01'),
('ff00000a-0001-0001-0002-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 65, 'warm', '2026-03-15'),
('ff00000a-0001-0001-0003-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 40, 'cool', '2026-03-05'),
('ff00000a-0001-0001-0003-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 35, 'cold', '2026-03-12'),
('ff00000a-0001-0001-0003-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 28, 'cold', '2026-03-20'),
('ff00000a-0001-0001-0003-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 22, 'cold', '2026-03-28'),
('ff00000a-0001-0001-0004-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000118', 40, 'cool', '2026-03-25'),
('ff00000a-0001-0001-0004-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000118', 48, 'cool', '2026-03-28'),
('ff00000a-0001-0001-0004-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000118', 55, 'cool', '2026-04-01')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 10. CLIENT DEDUP QUEUE
-- Schema: id, venue_id, client_a_id, client_b_id,
--         match_type (email|phone|name), confidence,
--         status (pending|merged|dismissed),
--         resolved_by, resolved_at, created_at
-- ============================================

INSERT INTO client_match_queue (id, venue_id, client_a_id, client_b_id, match_type, confidence, status, created_at) VALUES
('ff00000b-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', '44444444-4444-4444-4444-444444000118', 'email', 0.85, 'pending', '2026-03-28 08:00:00+00'),
('ff00000b-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000103', '44444444-4444-4444-4444-444444000107', 'name', 0.72, 'dismissed', '2026-02-15 10:00:00+00'),
('ff00000b-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000112', '44444444-4444-4444-4444-444444000116', 'phone', 0.91, 'merged', '2026-01-20 14:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 11. RELATIONSHIPS
-- Schema: id, venue_id, person_a_id, person_b_id,
--         relationship_type (partner|parent|sibling|friend|vendor|planner),
--         notes, created_at
-- ============================================

INSERT INTO relationships (id, venue_id, person_a_id, person_b_id, relationship_type, notes, created_at) VALUES
('ff00000c-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '55555555-5555-5555-5555-555555000301', '55555555-5555-5555-5555-555555000201', 'friend', 'Chloe referred Aisha after booking. College friends.', '2026-03-05 10:00:00+00'),
('ff00000c-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '55555555-5555-5555-5555-555555000101', '55555555-5555-5555-5555-555555000301', 'sibling', 'Emma (wedding 101, completed 2024) is Chloe''s older sister.', '2026-01-08 10:00:00+00'),
('ff00000c-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '55555555-5555-5555-5555-555555000301', '55555555-5555-5555-5555-555555000302', 'partner', NULL, '2026-01-08 10:00:00+00'),
('ff00000c-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '55555555-5555-5555-5555-555555000201', '55555555-5555-5555-5555-555555000202', 'partner', NULL, '2026-03-05 10:00:00+00'),
('ff00000c-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '55555555-5555-5555-5555-555555000101', '55555555-5555-5555-5555-555555000102', 'partner', NULL, '2024-05-01 10:00:00+00'),
('ff00000c-0001-0001-0002-000000000001', '22222222-2222-2222-2222-222222222202', '55555555-5555-5555-5555-555555000401', '55555555-5555-5555-5555-555555000402', 'partner', NULL, '2026-01-15 10:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 12. KNOWLEDGE GAPS
-- Schema: id, venue_id, question, category, frequency,
--         status (open|resolved), resolution,
--         resolved_at, created_at
-- ============================================

INSERT INTO knowledge_gaps (id, venue_id, question, category, frequency, status, resolution, resolved_at, created_at) VALUES
('ff00000d-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'What is the corkage fee for outside wine?', 'pricing', 4, 'open', NULL, NULL, '2026-03-15 10:00:00+00'),
('ff00000d-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'Can we use sparklers for the send-off?', 'logistics', 3, 'open', NULL, NULL, '2026-03-20 14:00:00+00'),
('ff00000d-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'Do you allow fog machines or dry ice for the first dance?', 'logistics', 2, 'open', NULL, NULL, '2026-03-28 11:00:00+00'),
('ff00000d-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'What is the policy on food trucks as an alternative to catering?', 'pricing', 1, 'open', NULL, NULL, '2026-04-01 09:00:00+00'),
('ff00000d-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'Is there a discount for off-season weekday weddings?', 'pricing', 2, 'open', NULL, NULL, '2026-02-10 15:00:00+00'),
('ff00000d-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'Are pets allowed at the ceremony?', 'general', 6, 'resolved', 'Dogs welcome at outdoor ceremonies with a handler. Water station provided. Added to KB.', '2026-03-15 11:00:00+00', '2026-01-20 10:00:00+00'),
('ff00000d-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', 'What is the rain plan for outdoor ceremonies?', 'logistics', 8, 'resolved', 'Covered pavilion seats 200, same views, no extra charge. Added to KB.', '2026-02-01 09:00:00+00', '2026-01-10 14:00:00+00'),
('ff00000d-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', 'What time does music have to stop?', 'logistics', 5, 'resolved', '10:30 PM outdoor, 11 PM indoor. Last call 10 PM. Added to KB.', '2026-03-10 09:00:00+00', '2026-02-15 16:00:00+00'),
('ff00000d-0001-0001-0002-000000000001', '22222222-2222-2222-2222-222222222202', 'Can we do a tractor ride for the wedding party?', 'logistics', 2, 'open', NULL, NULL, '2026-03-10 10:00:00+00'),
('ff00000d-0001-0001-0002-000000000002', '22222222-2222-2222-2222-222222222202', 'Do you have a generator for the meadow ceremony area?', 'logistics', 3, 'resolved', 'Yes, silent generator for ceremony meadow. Included in rental.', '2026-02-20 10:00:00+00', '2026-01-25 14:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- DONE — 12 tables seeded
-- ============================================
