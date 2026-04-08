-- ============================================
-- SEED: Fill audit-identified data gaps
-- Demo venue: Hawthorne Manor (22222222-2222-2222-2222-222222222201)
-- Demo wedding: Chloe & Ryan (ab000000-0000-0000-0000-000000000001)
-- ============================================

-- ============================================
-- P5: GUEST LIST (~30 guests)
-- ============================================
INSERT INTO guest_list (id, venue_id, wedding_id, first_name, last_name, email, group_name, rsvp_status, meal_preference, dietary_restrictions, plus_one, has_plus_one, staying_overnight, needs_shuttle, invitation_sent) VALUES
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Sofia', 'Martinez', 'sofia.m@email.com', 'Bride Family', 'attending', 'chicken', NULL, false, false, true, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Miguel', 'Martinez', 'miguel.m@email.com', 'Bride Family', 'attending', 'beef', NULL, true, true, true, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Elena', 'Martinez', 'elena.m@email.com', 'Bride Family', 'attending', 'fish', NULL, false, false, true, false, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'David', 'Brooks', 'david.b@email.com', 'Groom Family', 'attending', 'beef', NULL, false, false, true, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Karen', 'Brooks', 'karen.b@email.com', 'Groom Family', 'attending', 'chicken', NULL, true, true, true, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'James', 'Brooks', 'james.b@email.com', 'Groom Family', 'attending', 'beef', NULL, false, false, false, false, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Emma', 'Chen', 'emma.chen@email.com', 'College Friends', 'attending', 'vegetarian', 'Vegetarian', true, true, false, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Liam', 'O''Brien', 'liam.ob@email.com', 'College Friends', 'attending', 'beef', NULL, false, false, false, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Ava', 'Patel', 'ava.p@email.com', 'College Friends', 'attending', 'vegetarian', 'Vegan', false, false, false, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Noah', 'Kim', 'noah.k@email.com', 'College Friends', 'attending', 'chicken', NULL, true, true, false, false, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Olivia', 'Taylor', 'olivia.t@email.com', 'Work Friends', 'attending', 'fish', 'Gluten-free', false, false, false, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Mason', 'Garcia', 'mason.g@email.com', 'Work Friends', 'attending', 'beef', NULL, true, true, false, false, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Isabella', 'Wong', 'isabella.w@email.com', 'Work Friends', 'declined', 'chicken', NULL, false, false, false, false, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Ethan', 'Lopez', 'ethan.l@email.com', 'Work Friends', 'pending', 'beef', NULL, true, true, false, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Sophia', 'Nguyen', 'sophia.n@email.com', 'Bride Friends', 'attending', 'chicken', NULL, false, false, true, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Jackson', 'Davis', 'jackson.d@email.com', 'Groom Friends', 'attending', 'beef', NULL, false, false, false, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Mia', 'Wilson', 'mia.w@email.com', 'Groom Friends', 'attending', 'vegetarian', 'Dairy-free', true, true, false, false, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Lucas', 'Anderson', 'lucas.a@email.com', 'Groom Friends', 'maybe', 'chicken', NULL, false, false, false, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Harper', 'Thomas', 'harper.t@email.com', 'Bride Family', 'attending', 'fish', NULL, true, true, true, false, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Aiden', 'Jackson', 'aiden.j@email.com', 'Neighbors', 'attending', 'beef', NULL, true, true, false, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Charlotte', 'White', 'charlotte.w@email.com', 'Neighbors', 'pending', 'chicken', NULL, false, false, false, false, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Daniel', 'Harris', 'daniel.h@email.com', 'Bride Family', 'attending', 'beef', 'Nut allergy', false, false, true, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Grace', 'Martin', 'grace.m@email.com', 'College Friends', 'attending', 'chicken', NULL, false, false, false, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Henry', 'Rodriguez', 'henry.r@email.com', 'Groom Family', 'attending', 'beef', NULL, true, true, true, false, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Zoe', 'Lee', 'zoe.l@email.com', 'Bride Friends', 'declined', 'vegetarian', NULL, false, false, false, false, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Alexander', 'Clark', 'alex.c@email.com', 'Work Friends', 'attending', 'chicken', NULL, false, false, false, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Lily', 'Lewis', 'lily.l@email.com', 'Bride Friends', 'attending', 'fish', 'Shellfish allergy', false, false, false, true, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Sebastian', 'Walker', 'seb.w@email.com', 'Groom Friends', 'pending', 'beef', NULL, true, true, false, false, false)
ON CONFLICT DO NOTHING;

-- ============================================
-- P9: WEDDING PARTY (6 members)
-- ============================================
INSERT INTO wedding_party (id, venue_id, wedding_id, name, role, side, relationship, sort_order) VALUES
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Sophia Nguyen', 'maid_of_honor', 'bride', 'College roommate and best friend since freshman year', 1),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Jackson Davis', 'best_man', 'groom', 'Childhood best friend — grew up next door', 2),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Emma Chen', 'bridesmaid', 'bride', 'College sorority sister', 3),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Zoe Lee', 'bridesmaid', 'bride', 'Work friend turned soul sister', 4),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Liam O''Brien', 'groomsman', 'groom', 'College lacrosse teammate', 5),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'Noah Kim', 'groomsman', 'groom', 'MBA study partner and close friend', 6)
ON CONFLICT DO NOTHING;

-- ============================================
-- TIMELINE (12 day-of events)
-- ============================================
INSERT INTO timeline (id, venue_id, wedding_id, time, duration_minutes, title, description, category, location, sort_order) VALUES
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', '09:00', 60, 'Hair & Makeup Begins', 'Bridal party arrives for styling', 'prep', 'Bridal Suite', 1),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', '11:00', 30, 'Florist Delivery', 'Bouquets, boutonnieres, and centerpieces arrive', 'vendor', 'Main Entrance', 2),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', '12:00', 60, 'First Look & Couple Photos', 'Private first look at the garden terrace, followed by couple portraits', 'photos', 'Garden Terrace', 3),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', '13:00', 30, 'Wedding Party Photos', 'Group photos with bridesmaids, groomsmen, and family', 'photos', 'Front Lawn', 4),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', '14:00', 30, 'Guest Shuttle Arrives', 'First shuttle from hotel block', 'logistics', 'Main Gate', 5),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', '14:30', 30, 'Cocktail Hour', 'Lawn games, passed appetizers, and signature cocktails', 'reception', 'West Lawn', 6),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', '15:00', 30, 'Ceremony', 'Outdoor ceremony under the arbor', 'ceremony', 'Hilltop Garden', 7),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', '15:30', 60, 'Cocktail Hour', 'Drinks and appetizers while the space flips', 'reception', 'Terrace', 8),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', '16:30', 15, 'Grand Entrance & First Dance', 'Introduction of the newlyweds', 'reception', 'Great Hall', 9),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', '16:45', 75, 'Dinner Service', 'Three-course plated dinner', 'reception', 'Great Hall', 10),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', '18:00', 15, 'Toasts & Cake Cutting', 'Maid of honor and best man speeches', 'reception', 'Great Hall', 11),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', '18:15', 105, 'Dancing & Open Bar', 'DJ takes over, photo booth opens', 'reception', 'Great Hall', 12),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', '20:00', 15, 'Sparkler Send-Off', 'Grand exit with sparklers', 'departure', 'Front Drive', 13)
ON CONFLICT DO NOTHING;

-- ============================================
-- P8: INSPO GALLERY (6 images for demo wedding)
-- ============================================
INSERT INTO inspo_gallery (id, venue_id, wedding_id, image_url, caption, tags) VALUES
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'https://images.unsplash.com/photo-1591604466107-ec97de577aff?w=800', 'Garden ceremony with arbor', ARRAY['ceremony', 'outdoor', 'garden']),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'https://images.unsplash.com/photo-1519167758481-83f550bb49b3?w=800', 'Elegant reception hall setup', ARRAY['reception', 'tablescape', 'indoor']),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800', 'Bridal suite getting ready', ARRAY['prep', 'bridal', 'suite']),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?w=800', 'Romantic golden hour portraits', ARRAY['photos', 'golden hour', 'couple']),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'https://images.unsplash.com/photo-1478146059778-26028b07395a?w=800', 'Floral centerpiece inspiration', ARRAY['decor', 'flowers', 'centerpiece']),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?w=800', 'Sparkler send-off', ARRAY['send-off', 'sparklers', 'night'])
ON CONFLICT DO NOTHING;

-- ============================================
-- P10: STOREFRONT / PICKS (8 items)
-- ============================================
INSERT INTO storefront (id, venue_id, pick_name, category, product_type, description, pick_type, is_active, sort_order) VALUES
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'The Black Tux', 'Attire', 'Rental', 'Premium suit and tux rentals with free home try-on', 'Best Save', true, 1),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'Artifact Uprising', 'Stationery', 'Invitations', 'Letterpress and foil-stamped invitations with matching suites', 'Best Splurge', true, 2),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'Zola Registry', 'Registry', 'Service', 'Universal wedding registry with cash funds and group gifting', 'Best Practical', true, 3),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'Minted', 'Stationery', 'Save the Dates', 'Artist-designed save the dates with matching wedding websites', 'Spring/Summer', true, 4),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'Rent the Runway', 'Attire', 'Rental', 'Designer dress rentals for rehearsal dinner and bridal shower', 'Best Save', true, 5),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'FiftyFlowers', 'Decor', 'Flowers', 'Wholesale fresh flowers direct — DIY arrangements at 60% off retail', 'Best Save', true, 6),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'Azazie', 'Attire', 'Bridesmaid Dresses', 'Try-at-home bridesmaid dresses in 60+ colors', 'Best Practical', true, 7),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'Shutterfly', 'Keepsakes', 'Photo Book', 'Premium lay-flat photo books from your wedding day', 'Best Custom', true, 8)
ON CONFLICT DO NOTHING;

-- ============================================
-- FIX: Lost deals with null reasons → real reasons
-- ============================================
UPDATE lost_deals
SET reason_category = 'pricing', reason_detail = 'Budget constraints after venue comparison'
WHERE venue_id = '22222222-2222-2222-2222-222222222201'
  AND reason_category IS NULL
  AND id = (SELECT id FROM lost_deals WHERE venue_id = '22222222-2222-2222-2222-222222222201' AND reason_category IS NULL LIMIT 1);

UPDATE lost_deals
SET reason_category = 'competitor', reason_detail = 'Chose a venue closer to hometown', competitor_name = 'Riverview Estate'
WHERE venue_id = '22222222-2222-2222-2222-222222222201'
  AND reason_category IS NULL
  AND id = (SELECT id FROM lost_deals WHERE venue_id = '22222222-2222-2222-2222-222222222201' AND reason_category IS NULL LIMIT 1);

-- ============================================
-- P7: ACTIVATE AGENT RULES (4 presets)
-- ============================================
INSERT INTO auto_send_rules (id, venue_id, context, source, enabled, confidence_threshold, daily_limit, require_new_contact) VALUES
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'inquiry', 'website_form', true, 0.85, 10, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'inquiry', 'the_knot', true, 0.80, 5, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'inquiry', 'weddingwire', true, 0.80, 5, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'client', 'follow_up', true, 0.90, 3, false)
ON CONFLICT DO NOTHING;
