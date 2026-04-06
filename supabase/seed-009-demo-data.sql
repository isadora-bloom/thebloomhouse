-- ============================================
-- CRESTWOOD COLLECTION — DEMO SEED (009-011 TABLES)
-- ============================================
-- Run AFTER seed.sql and migrations 009-011.
-- Populates all new tables with rich, realistic demo data.
--
-- Safe to run multiple times — uses ON CONFLICT DO NOTHING.
--
-- Key weddings populated:
--   109 — Chloe & Ryan (Hawthorne Manor, 2026-05-30, booked) — PRIMARY DEMO
--   110 — Hawthorne Manor (2026-06-20, booked)
--   111 — Hawthorne Manor (2026-09-12, booked)
--   209 — Taylor & Jordan (Crestwood Farm, 2026-06-06, booked)
--   313 — Glass House (2026-04-18, booked)
--
-- UUID pattern: dddd____ for this seed file
-- ============================================

-- ============================================
-- 1. BAR PLANNING
-- ============================================
INSERT INTO bar_planning (id, venue_id, wedding_id, bar_type, guest_count, bartender_count, notes) VALUES
  ('dddd0001-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'full', 175, 3, 'BYOB — couple sourcing all alcohol. Mobile Bar Co providing bartenders and setup. Need ice delivery by 2pm.'),
  ('dddd0001-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 'beer_wine', 130, 2, 'Beer and wine only per couple request. Simple setup at the patio bar.'),
  ('dddd0001-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'specialty', 190, 3, 'Two signature cocktails plus beer and wine. Couple wants a bourbon-forward drink and something with elderflower.')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 2. BAR RECIPES
-- ============================================
INSERT INTO bar_recipes (id, venue_id, wedding_id, cocktail_name, ingredients, instructions, servings, scaling_factor) VALUES
  -- Wedding 109: Chloe & Ryan
  ('dddd0002-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'The Hilltop Sunset',
   '[{"name":"bourbon","amount":"2 oz"},{"name":"peach puree","amount":"1 oz"},{"name":"lemon juice","amount":"0.75 oz"},{"name":"simple syrup","amount":"0.5 oz"},{"name":"angostura bitters","amount":"2 dashes"}]',
   'Shake bourbon, peach puree, lemon juice, and simple syrup with ice. Strain into a coupe glass. Add bitters and garnish with a dehydrated peach slice.', 1, 175.0),
  ('dddd0002-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Lavender Lemonade Spritz',
   '[{"name":"vodka","amount":"1.5 oz"},{"name":"lavender syrup","amount":"0.75 oz"},{"name":"lemon juice","amount":"1 oz"},{"name":"prosecco","amount":"2 oz"},{"name":"club soda","amount":"1 oz"}]',
   'Combine vodka, lavender syrup, and lemon juice in a wine glass with ice. Top with prosecco and club soda. Garnish with a sprig of fresh lavender.', 1, 175.0),
  ('dddd0002-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Virginia Mule',
   '[{"name":"ginger beer","amount":"4 oz"},{"name":"bourbon","amount":"2 oz"},{"name":"lime juice","amount":"1 oz"},{"name":"mint","amount":"3 leaves"}]',
   'Muddle mint in copper mug. Add bourbon and lime juice. Fill with ice and top with ginger beer. Stir gently and garnish with mint sprig and lime wheel.', 1, 175.0),
  -- Wedding 111
  ('dddd0002-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Blue Ridge Old Fashioned',
   '[{"name":"bourbon","amount":"2 oz"},{"name":"demerara syrup","amount":"0.25 oz"},{"name":"angostura bitters","amount":"3 dashes"},{"name":"orange peel","amount":"1 twist"}]',
   'Stir bourbon, syrup, and bitters with ice for 30 seconds. Strain over a large ice cube. Express orange peel over the glass and drop in.', 1, 190.0),
  ('dddd0002-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Elderflower Collins',
   '[{"name":"gin","amount":"1.5 oz"},{"name":"St-Germain elderflower liqueur","amount":"1 oz"},{"name":"lemon juice","amount":"0.75 oz"},{"name":"club soda","amount":"3 oz"}]',
   'Shake gin, elderflower, and lemon with ice. Strain into a Collins glass with fresh ice. Top with club soda. Garnish with edible flowers.', 1, 190.0),
  ('dddd0002-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Autumn Apple Cider Sangria',
   '[{"name":"white wine","amount":"1 bottle"},{"name":"apple cider","amount":"2 cups"},{"name":"brandy","amount":"0.5 cup"},{"name":"cinnamon sticks","amount":"3"},{"name":"sliced apples","amount":"2 cups"}]',
   'Combine all ingredients in a large pitcher. Refrigerate for at least 4 hours. Serve over ice with a cinnamon stick garnish.', 8, 24.0)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 3. BAR SHOPPING LIST
-- ============================================
INSERT INTO bar_shopping_list (id, venue_id, wedding_id, item_name, category, quantity, unit, estimated_cost, purchased, notes) VALUES
  -- Wedding 109: Chloe & Ryan (175 guests)
  ('dddd0003-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Maker''s Mark Bourbon', 'spirits', 8, 'bottles', 240.00, true, '750ml each — for Hilltop Sunset and Virginia Mule'),
  ('dddd0003-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Tito''s Vodka', 'spirits', 6, 'bottles', 150.00, true, '750ml — for Lavender Spritz'),
  ('dddd0003-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Prosecco', 'wine', 12, 'bottles', 180.00, true, 'Brut — La Marca or similar'),
  ('dddd0003-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Sauvignon Blanc', 'wine', 8, 'bottles', 120.00, false, 'Kim Crawford or similar NZ style'),
  ('dddd0003-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Pinot Noir', 'wine', 8, 'bottles', 128.00, false, 'Medium body — Meiomi or similar'),
  ('dddd0003-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Blue Moon (keg)', 'beer', 2, 'half barrels', 280.00, false, 'Confirm keg deposit with distributor'),
  ('dddd0003-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Fever-Tree Ginger Beer', 'mixers', 6, 'packs of 4', 48.00, true, 'For Virginia Mules'),
  ('dddd0003-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Lavender Syrup', 'mixers', 4, 'bottles', 40.00, true, 'Monin brand — already ordered'),
  ('dddd0003-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Fresh Lemons', 'garnish', 60, 'lemons', 15.00, false, 'Day-of purchase from Culpeper market'),
  ('dddd0003-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Fresh Mint & Lavender', 'garnish', 10, 'bunches', 25.00, false, 'Check with Valley Blooms — may be able to add to floral order'),
  ('dddd0003-0001-0001-0001-000000000011', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Ice', 'supplies', 300, 'lbs', 60.00, false, 'Order from Culpeper Ice — delivery 2pm day-of')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 4. CEREMONY ORDER
-- ============================================
INSERT INTO ceremony_order (id, venue_id, wedding_id, participant_name, role, side, sort_order, notes) VALUES
  -- Wedding 109: Chloe & Ryan
  ('dddd0004-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Pastor Michael Torres', 'officiant', 'both', 1, 'Arrives 30 min early for mic check'),
  ('dddd0004-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Ryan Brooks', 'groom', 'groom', 2, 'Enters from side with best man'),
  ('dddd0004-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Jake Brooks', 'best_man', 'groom', 3, 'Ryan''s brother'),
  ('dddd0004-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Matt DiNardo', 'groomsman', 'groom', 4, NULL),
  ('dddd0004-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Chris Okafor', 'groomsman', 'groom', 5, NULL),
  ('dddd0004-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Sophia Martinez', 'maid_of_honor', 'bride', 6, 'Chloe''s sister'),
  ('dddd0004-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Hannah Lee', 'bridesmaid', 'bride', 7, NULL),
  ('dddd0004-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Olivia Park', 'bridesmaid', 'bride', 8, NULL),
  ('dddd0004-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Lily Martinez', 'flower_girl', 'bride', 9, 'Chloe''s niece, age 5 — practice walk needed at rehearsal'),
  ('dddd0004-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Ethan Brooks', 'ring_bearer', 'groom', 10, 'Ryan''s nephew, age 7'),
  ('dddd0004-0001-0001-0001-000000000011', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Uncle David Martinez', 'reader', 'bride', 11, 'Reading 1 Corinthians 13'),
  ('dddd0004-0001-0001-0001-000000000012', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Chloe Martinez', 'bride', 'bride', 12, 'Walks with father — Roberto Martinez'),
  -- Wedding 111 (partial)
  ('dddd0004-0001-0001-0001-000000000013', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Rev. Catherine Hale', 'officiant', 'both', 1, NULL),
  ('dddd0004-0001-0001-0001-000000000014', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Groom', 'groom', 'groom', 2, NULL),
  ('dddd0004-0001-0001-0001-000000000015', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Best Man', 'best_man', 'groom', 3, NULL),
  ('dddd0004-0001-0001-0001-000000000016', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Maid of Honor', 'maid_of_honor', 'bride', 4, NULL),
  ('dddd0004-0001-0001-0001-000000000017', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Bride', 'bride', 'bride', 5, NULL)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 5. MAKEUP SCHEDULE
-- ============================================
INSERT INTO makeup_schedule (id, venue_id, wedding_id, person_name, role, hair_time, makeup_time, notes, sort_order) VALUES
  -- Wedding 109: Chloe & Ryan (ceremony at 4:30pm)
  ('dddd0005-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Chloe Martinez', 'Bride', '08:00', '09:15', 'Updo with loose tendrils. Airbrush makeup. Trial completed March 15.', 1),
  ('dddd0005-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Sophia Martinez', 'Maid of Honor', '08:45', '09:45', 'Half-up half-down. Natural makeup.', 2),
  ('dddd0005-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Hannah Lee', 'Bridesmaid', '09:30', '10:30', 'Loose waves. Natural makeup with a rosy lip.', 3),
  ('dddd0005-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Olivia Park', 'Bridesmaid', '10:15', '11:15', 'Soft curls. Skin focus makeup.', 4),
  ('dddd0005-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Elena Martinez', 'Mother of the Bride', '11:00', '12:00', 'Blowout. Classic makeup — she prefers less is more.', 5),
  ('dddd0005-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Diane Brooks', 'Mother of the Groom', '11:45', '12:45', 'Set and style. Soft glam. Arrives at 11:30.', 6)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 6. SHUTTLE SCHEDULE
-- ============================================
INSERT INTO shuttle_schedule (id, venue_id, wedding_id, route_name, pickup_location, dropoff_location, departure_time, capacity, notes) VALUES
  -- Wedding 109
  ('dddd0006-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Hotel to Venue (Ceremony)', 'Hampton Inn Culpeper, 791 Madison Rd', 'Hawthorne Manor, 4200 Hawthorne Estate Dr', '2026-05-30 15:30:00+00', 40, 'Bus arrives at hotel 3:15pm for 3:30pm departure. 15 min drive.'),
  ('dddd0006-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Venue to Hotel (End of Night)', 'Hawthorne Manor, 4200 Hawthorne Estate Dr', 'Hampton Inn Culpeper, 791 Madison Rd', '2026-05-30 22:30:00+00', 40, 'Last shuttle. Second run at 10:45 if needed.'),
  ('dddd0006-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Rehearsal Dinner Shuttle', 'Hampton Inn Culpeper, 791 Madison Rd', 'Foti''s Restaurant, 219 E Davis St, Culpeper', '2026-05-29 17:30:00+00', 30, 'Friday evening — seats for bridal party and immediate family only'),
  -- Wedding 111
  ('dddd0006-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Hotel to Venue', 'Best Western Culpeper, 791 Willis Ln', 'Hawthorne Manor, 4200 Hawthorne Estate Dr', '2026-09-12 14:30:00+00', 45, 'Larger bus for 190 guest wedding')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 7. REHEARSAL DINNER
-- ============================================
INSERT INTO rehearsal_dinner (id, venue_id, wedding_id, location_name, address, date, start_time, end_time, guest_count, menu_notes, special_arrangements) VALUES
  ('dddd0007-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Foti''s Restaurant', '219 E Davis St, Culpeper, VA 22701', '2026-05-29', '18:00', '21:00', 35, 'Family-style Italian dinner. Reserved the back room. Dietary: 2 vegetarian, 1 gluten-free. Wine pairings included.', 'Groom''s parents hosting. Slideshow setup needed — check for HDMI connection. Toast from best man and MOH.'),
  ('dddd0007-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 'The Cameleer', '206 E Davis St, Culpeper, VA 22701', '2026-06-19', '18:30', '21:00', 28, 'Mediterranean small plates. Couple wants a casual, low-key vibe.', NULL),
  ('dddd0007-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Foti''s Restaurant', '219 E Davis St, Culpeper, VA 22701', '2026-09-11', '18:00', '21:30', 42, 'Private buyout of the restaurant. Seated dinner, 3 courses. Bride''s father giving a welcome toast.', 'Need valet parking for 20 cars. Florist delivering small centerpieces.')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 8. DECOR INVENTORY
-- ============================================
INSERT INTO decor_inventory (id, venue_id, wedding_id, item_name, category, quantity, source, vendor_name, notes, leaving_instructions) VALUES
  -- Wedding 109: Chloe & Ryan
  ('dddd0008-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Wooden Ceremony Arch', 'ceremony', 1, 'borrow', NULL, 'Hawthorne Manor arch — draped with greenery by Valley Blooms', 'Leave in barn after reception'),
  ('dddd0008-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Gold Votive Candle Holders', 'tables', 60, 'borrow', NULL, 'From Hawthorne inventory. 4 per table.', 'Return to storage closet'),
  ('dddd0008-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Eucalyptus Garland Runners', 'tables', 15, 'vendor', 'Valley Blooms', 'One per table. Fresh — delivered morning of.', 'Compost after event'),
  ('dddd0008-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Bud Vases with Wildflowers', 'tables', 45, 'vendor', 'Valley Blooms', '3 per table, assorted heights', 'Bride taking home favorites'),
  ('dddd0008-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Custom Welcome Sign', 'entrance', 1, 'personal', NULL, 'Acrylic sign with gold lettering — "The Brooks Wedding"', 'Couple taking home'),
  ('dddd0008-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Card Box (Vintage Suitcase)', 'reception', 1, 'personal', NULL, 'Antique suitcase from grandmother', 'Couple taking home — handle with care'),
  ('dddd0008-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Photo Display Board', 'reception', 1, 'diy', NULL, 'Clothespin photo display with engagement and family photos', 'Couple taking home'),
  ('dddd0008-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Linen Napkins (Dusty Rose)', 'tables', 180, 'vendor', 'Party Rentals VA', 'Matching chair sashes also ordered', 'Vendor picking up Monday'),
  ('dddd0008-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Sparklers (20")', 'other', 200, 'personal', NULL, 'For send-off. Stored in dry location.', 'Used up'),
  ('dddd0008-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'String Lights (additional)', 'reception', 4, 'borrow', NULL, 'Extra strands from Hawthorne inventory for patio area', 'Return to storage'),
  ('dddd0008-0001-0001-0001-000000000011', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Ceremony Aisle Markers', 'ceremony', 12, 'diy', NULL, 'Shepherd hooks with mason jars and wildflowers', 'Couple taking home'),
  ('dddd0008-0001-0001-0001-000000000012', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Cake Table Backdrop (Draped Fabric)', 'reception', 1, 'vendor', 'Party Rentals VA', 'Ivory chiffon backdrop behind cake table', 'Vendor picking up Monday')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 9. STAFFING ASSIGNMENTS
-- ============================================
INSERT INTO staffing_assignments (id, venue_id, wedding_id, role, person_name, count, hourly_rate, hours, tip_amount, notes) VALUES
  -- Wedding 109
  ('dddd0009-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'bartender', 'Mobile Bar Co Team', 3, 35.00, 7, 150.00, 'Setup at 2pm, service 4pm-10pm, breakdown 10-11pm'),
  ('dddd0009-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'server', 'BBQ Company Staff', 4, 28.00, 6, 100.00, 'Arrive at 3pm. Family-style service.'),
  ('dddd0009-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'coordinator', 'Sarah Chen', 1, 0, 12, 0, 'Lead coordinator. On site 8am-11pm.'),
  ('dddd0009-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'runner', 'Alex Thompson', 2, 22.00, 8, 75.00, 'Setup/breakdown crew. Heavy lifting for ceremony move.'),
  ('dddd0009-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'other', 'DJ Marcus', 1, 0, 6, 0, 'Sound check at 3pm. Has own equipment.'),
  -- Wedding 111
  ('dddd0009-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'bartender', NULL, 3, 35.00, 7, NULL, 'TBD — couple still deciding on bar service'),
  ('dddd0009-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'server', NULL, 5, 28.00, 6, NULL, 'Larger wedding — need extra server'),
  ('dddd0009-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'coordinator', 'Sarah Chen', 1, 0, 12, 0, NULL)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 10. BEDROOM ASSIGNMENTS
-- ============================================
INSERT INTO bedroom_assignments (id, venue_id, wedding_id, room_name, room_description, guests, notes) VALUES
  -- Wedding 109
  ('dddd0010-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Bridal Suite', 'Main suite with king bed, clawfoot tub, and mountain views', ARRAY['Chloe Martinez', 'Ryan Brooks'], 'Bride getting ready here starting 7:30am. Breakfast tray ordered.'),
  ('dddd0010-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'The Mountain Room', 'Queen bed with private bath', ARRAY['Roberto & Elena Martinez'], 'Parents of the bride. Early risers — coffee service by 7am.'),
  ('dddd0010-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'The Garden Room', 'Two twin beds, shared bath', ARRAY['Sophia Martinez', 'Hannah Lee'], 'MOH and bridesmaid. Getting ready in bridal suite but sleeping here.'),
  ('dddd0010-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'The Cottage', 'Detached cottage with queen bed', ARRAY['Tom & Diane Brooks'], 'Parents of the groom. Request extra blankets.'),
  -- Wedding 111
  ('dddd0010-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Bridal Suite', 'Main suite with king bed, clawfoot tub, and mountain views', ARRAY['Bride', 'Groom'], NULL),
  ('dddd0010-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'The Mountain Room', 'Queen bed with private bath', ARRAY['Parents of the Bride'], NULL),
  ('dddd0010-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'The Garden Room', 'Two twin beds, shared bath', ARRAY['Maid of Honor', 'Bridesmaid'], NULL)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 11. ALLERGY REGISTRY
-- ============================================
INSERT INTO allergy_registry (id, venue_id, wedding_id, guest_name, allergy_type, severity, notes, is_important) VALUES
  -- Wedding 109
  ('dddd0011-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Sophia Martinez', 'Tree Nuts', 'severe', 'EpiPen carrier. Caterer notified. No pecan or walnut in any dish.', true),
  ('dddd0011-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Tom Brooks', 'Shellfish', 'moderate', 'Avoid shrimp and crab. Can eat fish. Caterer aware.', true),
  ('dddd0011-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Hannah Lee', 'Dairy', 'mild', 'Lactose intolerant — prefers non-dairy options but can handle small amounts. Vegan meal option works.', false),
  ('dddd0011-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Chris Okafor', 'Gluten', 'moderate', 'Celiac disease — needs fully gluten-free meal, not just low-gluten. Separate prep area.', true),
  ('dddd0011-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Abuela Rosa Martinez', 'Soy', 'mild', 'Avoids soy sauce and tofu. Not anaphylactic.', false),
  -- Wedding 111
  ('dddd0011-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Guest TBD', 'Peanuts', 'life_threatening', 'Couple mentioned a guest with severe peanut allergy — details pending. Flag for caterer.', true),
  ('dddd0011-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Guest TBD', 'Gluten', 'moderate', 'At least 3 guests need GF options per couple estimate', false)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 12. GUEST CARE NOTES
-- ============================================
INSERT INTO guest_care_notes (id, venue_id, wedding_id, guest_name, care_type, note) VALUES
  -- Wedding 109
  ('dddd0012-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Abuela Rosa Martinez', 'mobility', 'Uses a walker. Needs a chair near the ceremony arch, not on the lawn. Shuttle priority boarding. Ground floor seating at reception — Table 1 near entrance.'),
  ('dddd0012-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Hannah Lee', 'dietary', 'Vegan — not just vegetarian. Check that appetizers during cocktail hour have a vegan option clearly labeled.'),
  ('dddd0012-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Abuela Rosa Martinez', 'vip', 'Chloe''s grandmother, 87 years old. This is very important to the family — she flew in from Puerto Rico. Make sure she is seated comfortably and has someone checking on her. Warm beverage option available.'),
  ('dddd0012-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Uncle David Martinez', 'medical', 'Type 1 diabetic — needs access to a quiet space if blood sugar drops. Insulin in small cooler — store in bridal suite fridge.'),
  -- Wedding 111
  ('dddd0012-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'TBD Guest', 'mobility', 'Wheelchair user expected — confirm accessible restroom path and seating area'),
  ('dddd0012-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'TBD Guest', 'family', 'Couple mentioned a recently divorced family situation on the groom side. Seat parents at separate tables.')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 13. WEDDING WORKSHEETS
-- ============================================
INSERT INTO wedding_worksheets (id, venue_id, wedding_id, section, content) VALUES
  -- Wedding 109: Chloe & Ryan
  ('dddd0013-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'priorities',
   '{"top_three": ["The food has to be incredible — we are both foodies", "Great music and a packed dance floor", "Making sure Abuela Rosa is comfortable and happy"], "vibe_words": ["warm", "joyful", "relaxed but elegant"], "must_haves": ["Our dog Biscuit in the ceremony", "Sparkler exit", "Late night snack station"]}'),
  ('dddd0013-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'story',
   '{"how_we_met": "We met at a friend''s backyard cookout in Richmond in 2021. Ryan was grilling and Chloe made fun of his technique. They have been inseparable since.", "proposal": "Ryan proposed on the Blue Ridge Parkway overlook near Milepost 20 during a fall hike. He had Biscuit bring the ring in a little backpack.", "why_this_venue": "We drove past Hawthorne Manor on the way back from that hike and both said ''wow'' at the same time. It just felt right — the hilltop, the mountains, the feeling of being away from everything."}'),
  ('dddd0013-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'feelings',
   '{"most_excited_about": "Seeing everyone we love in one place. Our families live far apart and this will be the first time both sides are together.", "most_nervous_about": "The weather — we really want an outdoor ceremony. Also, the first dance (Ryan is not a dancer).", "dream_moment": "Standing at the hilltop during golden hour, just married, looking at the mountains with Ryan"}'),
  -- Wedding 111 (partial)
  ('dddd0013-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'priorities',
   '{"top_three": ["Epic photos — we want the autumn foliage as our backdrop", "Unique cocktails that tell our story", "An intimate ceremony even with 190 guests"], "vibe_words": ["romantic", "autumnal", "sophisticated"], "must_haves": ["Live string quartet during ceremony", "Fireside cocktail hour", "Custom bourbon bar"]}')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 14. WEDDING PARTY
-- ============================================
INSERT INTO wedding_party (id, venue_id, wedding_id, name, role, side, relationship, bio, photo_url, sort_order) VALUES
  -- Wedding 109: Chloe & Ryan
  ('dddd0014-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Sophia Martinez', 'maid_of_honor', 'bride', 'Sister', 'Chloe''s little sister and lifelong best friend. Sophia planned the most epic bachelorette in Savannah and keeps the group chat alive.', NULL, 1),
  ('dddd0014-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Hannah Lee', 'bridesmaid', 'bride', 'College roommate', 'Four years as roommates at UVA, ten years of friendship. Hannah introduced Chloe to the friend group where she met Ryan.', NULL, 2),
  ('dddd0014-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Olivia Park', 'bridesmaid', 'bride', 'Work friend', 'Chloe''s work wife at the marketing agency. They survived three rebrand projects together and that bonds you for life.', NULL, 3),
  ('dddd0014-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Jake Brooks', 'best_man', 'groom', 'Brother', 'Ryan''s older brother and the person who taught him everything — from throwing a football to how to cook a steak. Jake''s toast will definitely make everyone cry.', NULL, 4),
  ('dddd0014-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Matt DiNardo', 'groomsman', 'groom', 'Childhood friend', 'Ryan and Matt have been best friends since T-ball in Fairfax. Matt is the reason Ryan moved to Richmond.', NULL, 5),
  ('dddd0014-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Chris Okafor', 'groomsman', 'groom', 'College friend', 'Engineering buddies at Virginia Tech. Chris was the first person Ryan told about the proposal plan.', NULL, 6),
  ('dddd0014-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Lily Martinez', 'flower_girl', 'bride', 'Niece', 'Sophia''s daughter and Chloe''s favorite little human. Age 5. Obsessed with sparkles and has been practicing her petal toss.', NULL, 7),
  ('dddd0014-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Ethan Brooks', 'ring_bearer', 'groom', 'Nephew', 'Jake''s son. Age 7. Very serious about his ring bearer duties. Has been practicing walking slowly.', NULL, 8)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 15. PHOTO LIBRARY
-- ============================================
INSERT INTO photo_library (id, venue_id, wedding_id, image_url, caption, tags, is_website) VALUES
  -- Wedding 109 engagement photos
  ('dddd0015-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'https://images.unsplash.com/photo-1519741497674-611481863552?w=800', 'Chloe & Ryan engagement shoot at Blue Ridge Parkway', ARRAY['engagement', 'couple', 'mountains'], false),
  ('dddd0015-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'https://images.unsplash.com/photo-1529636798458-92182e662485?w=800', 'Biscuit with the ring backpack', ARRAY['engagement', 'dog', 'proposal'], false),
  ('dddd0015-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'https://images.unsplash.com/photo-1591604466107-ec97de577aff?w=800', 'Venue walkthrough photo — hilltop ceremony site', ARRAY['venue', 'ceremony', 'hilltop'], true),
  ('dddd0015-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?w=800', 'Inspiration — ceremony arch with greenery', ARRAY['inspiration', 'ceremony', 'arch', 'florals'], false),
  ('dddd0015-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?w=800', 'Inspiration — outdoor reception string lights', ARRAY['inspiration', 'reception', 'lighting'], false),
  -- Venue-level photos
  ('dddd0015-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', NULL, 'https://images.unsplash.com/photo-1519167758481-83f550bb49b3?w=800', 'Hawthorne Manor reception hall setup', ARRAY['venue', 'reception', 'interior'], true),
  ('dddd0015-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', NULL, 'https://images.unsplash.com/photo-1470290378698-263fa7ca60ab?w=800', 'Sunset over the Blue Ridge from the hilltop', ARRAY['venue', 'landscape', 'sunset'], true),
  ('dddd0015-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', NULL, 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800', 'Bridal suite morning light', ARRAY['venue', 'bridal-suite', 'interior'], true)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 16. BORROW CATALOG (Hawthorne Manor venue-level inventory)
-- ============================================
INSERT INTO borrow_catalog (id, venue_id, item_name, category, description, image_url, quantity_available, is_active) VALUES
  ('dddd0016-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'Wooden Ceremony Arch (Natural)', 'arbor', 'Handmade white oak arch, 8ft tall x 6ft wide. Can be draped with fabric or greenery.', NULL, 1, true),
  ('dddd0016-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'Wooden Ceremony Arch (White-washed)', 'arbor', 'White-washed pine arch, 7ft tall x 5ft wide. More rustic look.', NULL, 1, true),
  ('dddd0016-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'Iron Candelabra (Tall)', 'candelabra', '5-arm iron candelabra, 5ft tall. Holds taper candles. Perfect for aisle or head table flanking.', NULL, 4, true),
  ('dddd0016-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'Gold Votive Holders', 'votive', 'Mercury glass gold votive holders. Tea light size. Beautiful on tables.', NULL, 80, true),
  ('dddd0016-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'Clear Glass Votive Holders', 'votive', 'Simple clear glass votive holders. Classic and versatile.', NULL, 100, true),
  ('dddd0016-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'Hurricane Lanterns (Large)', 'hurricane', 'Glass hurricane lanterns, 14in tall. Pillar candle included. Great for aisle or mantle.', NULL, 12, true),
  ('dddd0016-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', 'Vintage Cake Stand (3-tier)', 'cake_stand', 'Antique silver 3-tier cake stand. Fits standard wedding cake.', NULL, 1, true),
  ('dddd0016-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', 'Wooden Cake Stand (Rustic)', 'cake_stand', 'Live-edge wood slice cake stand, 16in diameter. Natural bark edge.', NULL, 1, true),
  ('dddd0016-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', 'Vintage Suitcase Card Box', 'card_box', 'Tan leather vintage suitcase with slot cut in top. Perfect for cards.', NULL, 1, true),
  ('dddd0016-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222201', 'Acrylic Card Box', 'card_box', 'Clear acrylic card box with gold trim. Modern option.', NULL, 1, true),
  ('dddd0016-0001-0001-0001-000000000011', '22222222-2222-2222-2222-222222222201', 'Wooden Table Numbers (1-20)', 'table_numbers', 'Hand-lettered wooden table numbers on small stands. Calligraphy style.', NULL, 20, true),
  ('dddd0016-0001-0001-0001-000000000012', '22222222-2222-2222-2222-222222222201', 'Acrylic Table Numbers (1-25)', 'table_numbers', 'Clear acrylic with white lettering. Modern minimalist.', NULL, 25, true),
  ('dddd0016-0001-0001-0001-000000000013', '22222222-2222-2222-2222-222222222201', '"Welcome" Chalkboard Easel', 'signs', 'Large vintage chalkboard on wood easel. Can be customized with chalk markers.', NULL, 1, true),
  ('dddd0016-0001-0001-0001-000000000014', '22222222-2222-2222-2222-222222222201', '"Unplugged Ceremony" Sign', 'signs', 'Wooden sign asking guests to put away phones during ceremony.', NULL, 1, true),
  ('dddd0016-0001-0001-0001-000000000015', '22222222-2222-2222-2222-222222222201', 'Mixed Bud Vases', 'vases', 'Collection of assorted glass bud vases in different heights and shapes. Sold as set of 5.', NULL, 30, true),
  ('dddd0016-0001-0001-0001-000000000016', '22222222-2222-2222-2222-222222222201', 'Burlap Table Runners', 'runners', 'Natural burlap runners, 108in long. Rustic style.', NULL, 20, true),
  ('dddd0016-0001-0001-0001-000000000017', '22222222-2222-2222-2222-222222222201', 'String Light Strands (Extra)', 'other', 'Additional Edison bulb string light strands, 25ft each. For extending beyond the standard setup.', NULL, 8, true),
  ('dddd0016-0001-0001-0001-000000000018', '22222222-2222-2222-2222-222222222201', 'Shepherd Hooks', 'other', 'Iron shepherd hooks for aisle markers. 36in tall.', NULL, 16, true)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 17. BORROW SELECTIONS
-- ============================================
INSERT INTO borrow_selections (id, venue_id, wedding_id, catalog_item_id, quantity, notes) VALUES
  -- Wedding 109: Chloe & Ryan
  ('dddd0017-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'dddd0016-0001-0001-0001-000000000001', 1, 'Natural arch — florist will drape with eucalyptus and roses'),
  ('dddd0017-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'dddd0016-0001-0001-0001-000000000004', 60, 'Gold votives for all tables'),
  ('dddd0017-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'dddd0016-0001-0001-0001-000000000011', 15, 'Wooden table numbers — matches their rustic-elegant vibe'),
  ('dddd0017-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'dddd0016-0001-0001-0001-000000000017', 4, 'Extra string lights for patio'),
  ('dddd0017-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'dddd0016-0001-0001-0001-000000000018', 12, 'Shepherd hooks for aisle markers'),
  ('dddd0017-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'dddd0016-0001-0001-0001-000000000014', 1, 'Unplugged ceremony sign'),
  -- Wedding 111
  ('dddd0017-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'dddd0016-0001-0001-0001-000000000002', 1, 'White-washed arch for autumn ceremony'),
  ('dddd0017-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'dddd0016-0001-0001-0001-000000000003', 4, 'Candelabras flanking the altar'),
  ('dddd0017-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'dddd0016-0001-0001-0001-000000000006', 10, 'Hurricane lanterns along the aisle'),
  ('dddd0017-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'dddd0016-0001-0001-0001-000000000012', 20, 'Acrylic table numbers')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 18. ACCOMMODATIONS (Hawthorne Manor - venue level)
-- ============================================
INSERT INTO accommodations (id, venue_id, name, type, address, website_url, price_per_night, distance_miles, description, is_recommended, sort_order) VALUES
  ('dddd0018-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'Hampton Inn Culpeper', 'hotel', '791 Madison Rd, Culpeper, VA 22701', 'https://www.hilton.com/en/hotels/chochx-hampton-culpeper/', 149.00, 8.2, 'Our most popular hotel for wedding guests. Clean, reliable, and has a pool. Room block available — mention "Hawthorne Manor Wedding" for the group rate.', true, 1),
  ('dddd0018-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'Best Western Culpeper Inn', 'hotel', '791 Willis Ln, Culpeper, VA 22701', 'https://www.bestwestern.com', 119.00, 7.8, 'Budget-friendly option with free breakfast. Good for families.', true, 2),
  ('dddd0018-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'The Cameleer Inn', 'boutique', '206 E Davis St, Culpeper, VA 22701', 'https://www.cameleerinn.com', 195.00, 9.0, 'Charming boutique inn in downtown Culpeper. 6 rooms. Book early — fills up for wedding weekends.', true, 3),
  ('dddd0018-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'Mountain View Farmhouse (Airbnb)', 'airbnb', 'Hawthorne Estate, VA 22737', 'https://airbnb.com', 275.00, 3.5, 'Beautiful farmhouse sleeps 8. Just down the road from Hawthorne Manor. Perfect for the bridal party or a family group.', true, 4),
  ('dddd0018-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'Fountain Hall B&B', 'inn', '609 S East St, Culpeper, VA 22701', 'https://www.fountainhall.com', 165.00, 9.5, 'Historic B&B built in 1859. Lovely gardens. Full breakfast included. A romantic option for couples in the wedding party.', true, 5)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 19. ONBOARDING PROGRESS
-- ============================================
INSERT INTO onboarding_progress (id, venue_id, wedding_id, step, completed, completed_at) VALUES
  -- Wedding 109: Chloe & Ryan (mostly complete)
  ('dddd0019-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'photo', true, '2026-01-20 14:00:00+00'),
  ('dddd0019-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'chat', true, '2026-01-22 10:00:00+00'),
  ('dddd0019-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'vendor', true, '2026-02-05 16:00:00+00'),
  ('dddd0019-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'inspo', true, '2026-02-10 11:00:00+00'),
  ('dddd0019-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'checklist', true, '2026-02-12 09:00:00+00'),
  -- Wedding 110 (partially complete)
  ('dddd0019-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 'photo', true, '2026-01-25 10:00:00+00'),
  ('dddd0019-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 'chat', true, '2026-01-28 14:00:00+00'),
  ('dddd0019-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 'vendor', false, NULL),
  ('dddd0019-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 'inspo', false, NULL),
  ('dddd0019-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 'checklist', false, NULL),
  -- Wedding 111 (just started)
  ('dddd0019-0001-0001-0001-000000000011', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'photo', true, '2026-02-01 12:00:00+00'),
  ('dddd0019-0001-0001-0001-000000000012', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'chat', false, NULL),
  ('dddd0019-0001-0001-0001-000000000013', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'vendor', false, NULL),
  ('dddd0019-0001-0001-0001-000000000014', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'inspo', false, NULL),
  ('dddd0019-0001-0001-0001-000000000015', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'checklist', false, NULL)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 20. SECTION FINALISATIONS
-- ============================================
-- Wedding 109: Deep in planning, most sections couple-signed-off
INSERT INTO section_finalisations (id, venue_id, wedding_id, section_name, couple_signed_off, couple_signed_off_at, staff_signed_off, staff_signed_off_at, staff_signed_off_by) VALUES
  ('dddd0020-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'guest_list', true, '2026-03-15 10:00:00+00', true, '2026-03-16 09:00:00+00', '33333333-3333-3333-3333-333333333301'),
  ('dddd0020-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'timeline', true, '2026-03-20 14:00:00+00', true, '2026-03-20 16:00:00+00', '33333333-3333-3333-3333-333333333301'),
  ('dddd0020-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'vendors', true, '2026-03-10 11:00:00+00', true, '2026-03-11 10:00:00+00', '33333333-3333-3333-3333-333333333301'),
  ('dddd0020-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'budget', true, '2026-03-18 15:00:00+00', false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'ceremony', true, '2026-03-22 10:00:00+00', true, '2026-03-22 14:00:00+00', '33333333-3333-3333-3333-333333333301'),
  ('dddd0020-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'reception', true, '2026-03-22 10:30:00+00', false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'bar', true, '2026-03-25 09:00:00+00', true, '2026-03-25 11:00:00+00', '33333333-3333-3333-3333-333333333301'),
  ('dddd0020-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'decor', true, '2026-03-24 16:00:00+00', false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'seating', false, NULL, false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'transportation', true, '2026-03-20 12:00:00+00', true, '2026-03-21 08:00:00+00', '33333333-3333-3333-3333-333333333301'),
  ('dddd0020-0001-0001-0001-000000000011', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'rehearsal_dinner', true, '2026-03-18 10:00:00+00', true, '2026-03-19 09:00:00+00', '33333333-3333-3333-3333-333333333301'),
  ('dddd0020-0001-0001-0001-000000000012', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'accommodations', true, '2026-02-28 14:00:00+00', true, '2026-03-01 09:00:00+00', '33333333-3333-3333-3333-333333333301'),
  ('dddd0020-0001-0001-0001-000000000013', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'hair_makeup', true, '2026-03-26 10:00:00+00', false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000014', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'photography', true, '2026-02-15 14:00:00+00', true, '2026-02-16 09:00:00+00', '33333333-3333-3333-3333-333333333301'),
  ('dddd0020-0001-0001-0001-000000000015', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'music', false, NULL, false, NULL, NULL),
  -- Wedding 111: Much earlier — fewer finalized
  ('dddd0020-0001-0001-0001-000000000016', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'guest_list', false, NULL, false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000017', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'timeline', false, NULL, false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000018', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'vendors', false, NULL, false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000019', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'budget', false, NULL, false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000020', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'ceremony', false, NULL, false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000021', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'reception', false, NULL, false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000022', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'bar', false, NULL, false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000023', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'decor', false, NULL, false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000024', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'seating', false, NULL, false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000025', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'transportation', false, NULL, false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000026', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'rehearsal_dinner', false, NULL, false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000027', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'accommodations', true, '2026-02-15 10:00:00+00', true, '2026-02-16 09:00:00+00', '33333333-3333-3333-3333-333333333301'),
  ('dddd0020-0001-0001-0001-000000000028', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'hair_makeup', false, NULL, false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000029', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'photography', false, NULL, false, NULL, NULL),
  ('dddd0020-0001-0001-0001-000000000030', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'music', false, NULL, false, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 21. GUEST TAGS
-- ============================================
INSERT INTO guest_tags (id, venue_id, wedding_id, tag_name, color) VALUES
  -- Wedding 109
  ('dddd0021-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Family', '#8B5CF6'),
  ('dddd0021-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'College Friends', '#3B82F6'),
  ('dddd0021-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Work', '#F59E0B'),
  ('dddd0021-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'VIP', '#EF4444'),
  ('dddd0021-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Out of Town', '#10B981'),
  -- Wedding 111
  ('dddd0021-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Family', '#8B5CF6'),
  ('dddd0021-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Bride''s Side', '#EC4899'),
  ('dddd0021-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Groom''s Side', '#6366F1'),
  ('dddd0021-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'VIP', '#EF4444')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 22. GUEST TAG ASSIGNMENTS
-- ============================================
-- Using existing guest_list IDs from seed.sql (c8000001-...-000000000001 through 010)
INSERT INTO guest_tag_assignments (id, guest_id, tag_id) VALUES
  ('dddd0022-0001-0001-0001-000000000001', 'c8000001-0000-0000-0000-000000000001', 'dddd0021-0001-0001-0001-000000000001'),  -- Martinez Family -> Family
  ('dddd0022-0001-0001-0001-000000000002', 'c8000001-0000-0000-0000-000000000002', 'dddd0021-0001-0001-0001-000000000001'),  -- Martinez Family -> Family
  ('dddd0022-0001-0001-0001-000000000003', 'c8000001-0000-0000-0000-000000000003', 'dddd0021-0001-0001-0001-000000000001'),  -- Brooks Family -> Family
  ('dddd0022-0001-0001-0001-000000000004', 'c8000001-0000-0000-0000-000000000004', 'dddd0021-0001-0001-0001-000000000001'),  -- Brooks Family -> Family
  ('dddd0022-0001-0001-0001-000000000005', 'c8000001-0000-0000-0000-000000000005', 'dddd0021-0001-0001-0001-000000000002'),  -- College Friends
  ('dddd0022-0001-0001-0001-000000000006', 'c8000001-0000-0000-0000-000000000006', 'dddd0021-0001-0001-0001-000000000002'),  -- College Friends
  ('dddd0022-0001-0001-0001-000000000007', 'c8000001-0000-0000-0000-000000000007', 'dddd0021-0001-0001-0001-000000000002'),  -- College Friends (declined)
  ('dddd0022-0001-0001-0001-000000000008', 'c8000001-0000-0000-0000-000000000008', 'dddd0021-0001-0001-0001-000000000003'),  -- Work
  ('dddd0022-0001-0001-0001-000000000009', 'c8000001-0000-0000-0000-000000000009', 'dddd0021-0001-0001-0001-000000000003'),  -- Work
  ('dddd0022-0001-0001-0001-000000000010', 'c8000001-0000-0000-0000-000000000001', 'dddd0021-0001-0001-0001-000000000004'),  -- Martinez Family -> VIP
  ('dddd0022-0001-0001-0001-000000000011', 'c8000001-0000-0000-0000-000000000003', 'dddd0021-0001-0001-0001-000000000005'),  -- Brooks Family -> Out of Town
  ('dddd0022-0001-0001-0001-000000000012', 'c8000001-0000-0000-0000-000000000010', 'dddd0021-0001-0001-0001-000000000005')   -- Neighbors -> Out of Town
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 23. GUEST MEAL OPTIONS
-- ============================================
INSERT INTO guest_meal_options (id, venue_id, wedding_id, option_name, description, is_default) VALUES
  -- Wedding 109
  ('dddd0023-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'BBQ Brisket Plate', 'Smoked brisket with mac & cheese, cornbread, and coleslaw', true),
  ('dddd0023-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Herb-Crusted Chicken', 'Grilled chicken breast with roasted vegetables and mashed potatoes', false),
  ('dddd0023-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Grilled Portobello Stack', 'Marinated portobello with roasted peppers, goat cheese, and balsamic glaze (vegetarian)', false),
  ('dddd0023-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Kids Chicken Tenders', 'Crispy chicken tenders with fries and applesauce (ages 10 and under)', false),
  -- Wedding 111
  ('dddd0023-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Filet Mignon', 'Pan-seared filet with truffle butter, asparagus, and au gratin potatoes', true),
  ('dddd0023-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Pan-Seared Salmon', 'Atlantic salmon with lemon-dill sauce, wild rice, and seasonal vegetables', false),
  ('dddd0023-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Mushroom Risotto', 'Wild mushroom risotto with parmesan and truffle oil (vegetarian)', false),
  ('dddd0023-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'Kids Mac & Cheese', 'White cheddar mac and cheese with fruit cup (ages 10 and under)', false)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 24. WEDDING WEBSITE SETTINGS
-- ============================================
INSERT INTO wedding_website_settings (id, venue_id, wedding_id, slug, is_published, theme, accent_color, couple_names, sections_order, sections_enabled, our_story, dress_code, registry_links, faq, things_to_do) VALUES
  -- Wedding 109: Chloe & Ryan — fully built out
  ('dddd0024-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109',
   'chloe-and-ryan-2026', true, 'garden', '#7D8471',
   'Chloe & Ryan',
   ARRAY['home', 'our_story', 'wedding_party', 'details', 'registry', 'faq', 'rsvp', 'things_to_do'],
   '{"home": true, "our_story": true, "wedding_party": true, "details": true, "registry": true, "faq": true, "rsvp": true, "things_to_do": true}',
   'We met at a friend''s backyard cookout in Richmond in 2021. Ryan was manning the grill and Chloe walked over to critique his burger technique. Three hours of laughing later, they exchanged numbers. Fast forward to October 2024 — Ryan proposed on the Blue Ridge Parkway overlook near Milepost 20 during a fall hike, with their dog Biscuit delivering the ring in a tiny backpack. They chose Hawthorne Manor because they drove past it on the way home from that hike and both said "wow" at the same time. It just felt right.',
   'Semi-formal / Cocktail attire. Think garden party — flowy dresses, linen suits welcome. Ceremony is outdoors on grass, so consider your shoe choices!',
   '[{"name": "Crate & Barrel", "url": "https://www.crateandbarrel.com/gift-registry/chloe-martinez-and-ryan-brooks/r123456"}, {"name": "Zola", "url": "https://www.zola.com/registry/chloeandryan2026"}, {"name": "Honeymoon Fund", "url": "https://www.honeyfund.com/site/chloeandryan"}]',
   '[{"question": "What time should I arrive?", "answer": "The ceremony begins at 4:30 PM. We suggest arriving by 4:00 PM to find your seats and enjoy the hilltop view."}, {"question": "Is there parking?", "answer": "Yes! Free parking is available on-site. Shuttle service is also provided from the Hampton Inn Culpeper for guests staying at the hotel block."}, {"question": "Can I bring a plus one?", "answer": "Due to venue capacity, we can only accommodate guests named on the invitation. If you received a plus one, it will be noted on your invite."}, {"question": "What if it rains?", "answer": "Hawthorne Manor has a beautiful indoor ceremony option, so we are covered rain or shine! The party goes on either way."}, {"question": "Will there be food options for dietary restrictions?", "answer": "Absolutely! We have vegetarian, gluten-free, and dairy-free options available. Please note any dietary needs on your RSVP card."}]',
   '{"restaurants": [{"name": "Foti''s Restaurant", "description": "Upscale Italian in downtown Culpeper. Great wine list.", "distance": "9 miles"}, {"name": "Copper Fish", "description": "Fresh seafood and craft cocktails. Lively atmosphere.", "distance": "9 miles"}, {"name": "Far Gohn Brewing", "description": "Local brewery with a great outdoor patio.", "distance": "8 miles"}], "activities": [{"name": "Blue Ridge Parkway", "description": "Scenic drive with breathtaking overlooks. The proposal spot!", "distance": "30 min"}, {"name": "Old Rag Mountain Hike", "description": "Challenging but rewarding hike with 360-degree views at the summit.", "distance": "40 min"}, {"name": "Culpeper Downtown", "description": "Charming small-town Main Street with antique shops, boutiques, and cafes.", "distance": "9 miles"}]}'),
  -- Wedding 111: Published but less detailed
  ('dddd0024-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111',
   'september-wedding-2026', true, 'romantic', '#A6894A',
   'Our September Wedding',
   ARRAY['home', 'details', 'registry', 'rsvp'],
   '{"home": true, "our_story": false, "wedding_party": false, "details": true, "registry": true, "faq": false, "rsvp": true, "things_to_do": false}',
   NULL,
   'Black tie optional. The ceremony will be outdoors followed by a tented reception.',
   '[{"name": "Williams Sonoma", "url": "https://www.williams-sonoma.com/registry/abc123"}]',
   '[{"question": "What time does the event start?", "answer": "Ceremony at 4:00 PM, reception to follow."}]',
   '{}'),
  -- Wedding 110: Draft, not published
  ('dddd0024-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110',
   'june-celebration-2026', false, 'classic', '#5D7A7A',
   'Our June Celebration',
   ARRAY['home', 'details', 'rsvp'],
   '{"home": true, "our_story": false, "wedding_party": false, "details": true, "registry": false, "faq": false, "rsvp": true, "things_to_do": false}',
   NULL,
   'Dressy casual. Come comfortable and ready to celebrate!',
   '[]', '[]', '{}')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 25. TOURS
-- ============================================
INSERT INTO tours (id, venue_id, wedding_id, scheduled_at, tour_type, conducted_by, source, outcome, booking_date, competing_venues, notes) VALUES
  -- Hawthorne Manor tours
  ('dddd0025-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', '2025-11-01 14:00:00+00', 'in_person', '33333333-3333-3333-3333-333333333301', 'the_knot', 'completed', '2026-05-30', ARRAY['Clifton Inn', 'Inn at Willow Grove'], 'Chloe cried when she saw the hilltop. Ryan loved the BYOB policy. Booked on the spot.'),
  ('dddd0025-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', '2025-11-20 11:00:00+00', 'in_person', '33333333-3333-3333-3333-333333333301', 'referral', 'completed', '2026-06-20', ARRAY['Pippin Hill Farm'], 'Referred by the couple from wedding 107. Intimate vibe — 130 guests.'),
  ('dddd0025-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', '2025-12-15 10:00:00+00', 'in_person', '33333333-3333-3333-3333-333333333301', 'google', 'completed', '2026-09-12', ARRAY['Keswick Vineyards', 'The Market at Grelen'], 'Larger wedding, 190 guests. Loved the fall foliage photos. Booked after second visit.'),
  ('dddd0025-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000112', '2026-01-25 14:00:00+00', 'in_person', '33333333-3333-3333-3333-333333333301', 'instagram', 'completed', '2026-10-17', ARRAY['Morais Vineyards'], 'Saw us on Instagram explore page. Very design-focused couple.'),
  ('dddd0025-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000113', '2026-03-05 11:00:00+00', 'in_person', '33333333-3333-3333-3333-333333333301', 'weddingwire', 'completed', NULL, ARRAY['Veritas Vineyard', 'King Family Vineyards'], 'Loved the space. Proposal sent. Waiting on decision — competing with vineyard venues.'),
  ('dddd0025-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000114', '2026-04-01 14:00:00+00', 'in_person', '33333333-3333-3333-3333-333333333301', 'the_knot', NULL, NULL, ARRAY[]::text[], 'Upcoming tour — hot lead, 200 guests. Mentioned outdoor ceremony is a must.'),
  ('dddd0025-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000117', '2024-10-15 11:00:00+00', 'in_person', '33333333-3333-3333-3333-333333333301', 'the_knot', 'completed', NULL, ARRAY['Early Mountain Vineyards'], 'Tour went well but couple ghosted after. Eventually found out they went with Early Mountain.'),
  -- Cancelled/no-show tours
  ('dddd0025-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', NULL, '2026-02-14 10:00:00+00', 'in_person', '33333333-3333-3333-3333-333333333301', 'google', 'cancelled', NULL, ARRAY[]::text[], 'Cancelled day-of — said they found a venue closer to DC.'),
  ('dddd0025-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', NULL, '2026-03-08 14:00:00+00', 'virtual', '33333333-3333-3333-3333-333333333301', 'weddingwire', 'no_show', NULL, ARRAY[]::text[], 'No-show for virtual tour. Follow-up email sent.'),
  ('dddd0025-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222201', NULL, '2026-03-12 11:00:00+00', 'in_person', '33333333-3333-3333-3333-333333333301', 'the_knot', 'rescheduled', NULL, ARRAY[]::text[], 'Rescheduled to April 5 due to weather.')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 26. LOST DEALS
-- ============================================
INSERT INTO lost_deals (id, venue_id, wedding_id, lost_at_stage, reason_category, reason_detail, competitor_name, recovery_attempted, recovery_outcome, lost_at) VALUES
  ('dddd0026-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000117', 'tour', 'competitor', 'Couple loved Hawthorne but ultimately went with Early Mountain Vineyards. Said the vineyard backdrop was more their style.', 'Early Mountain Vineyards', true, 'Sent personal note from Sarah. No response.', '2025-01-05 00:00:00+00'),
  ('dddd0026-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000118', 'hold', 'pricing', 'Couple was on a hold but said our pricing was above their budget after talking to their planner. They ended up at a smaller venue in Charlottesville.', NULL, true, 'Offered a midweek discount. They had already signed elsewhere.', '2025-01-10 00:00:00+00'),
  ('dddd0026-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000215', 'inquiry', 'ghosted', 'Initial inquiry seemed warm but never responded to follow-ups. 3 emails sent over 2 weeks.', NULL, true, 'Entered recovery sequence — no reply to any touchpoint.', '2025-03-01 00:00:00+00'),
  ('dddd0026-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000411', 'tour', 'date_unavailable', 'Couple wanted August 2 but we were already booked. Offered alternative dates but they needed that specific weekend for family travel.', NULL, false, NULL, '2025-01-15 00:00:00+00'),
  ('dddd0026-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000320', 'contract', 'changed_plans', 'Couple was at contract stage but postponed indefinitely. Said they are reconsidering timing due to a job relocation.', NULL, true, 'Offered to hold their date for 60 days. They eventually cancelled.', '2025-02-01 00:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 27. CAMPAIGNS
-- ============================================
INSERT INTO campaigns (id, venue_id, name, channel, start_date, end_date, spend, inquiries_attributed, tours_attributed, bookings_attributed, revenue_attributed, cost_per_inquiry, cost_per_booking, roi_ratio, notes) VALUES
  ('dddd0027-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'The Knot Featured Listing — Q1 2026', 'the_knot', '2026-01-01', '2026-03-31', 1050.00, 8, 5, 3, 42300.00, 131.25, 350.00, 40.29, 'Best performing channel. Featured listing with premium photos. Keep running.'),
  ('dddd0027-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'Instagram Spring Ads 2026', 'instagram', '2026-02-15', '2026-04-15', 750.00, 4, 2, 1, 14800.00, 187.50, 750.00, 19.73, 'Carousel ads featuring spring venue photos. Targeting engaged couples 25-35 in DMV area.'),
  ('dddd0027-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'Google Ads — Wedding Venue Culpeper', 'google', '2026-01-01', '2026-03-31', 1750.00, 6, 4, 2, 33500.00, 291.67, 875.00, 19.14, 'Search ads targeting "wedding venue culpeper VA", "barn wedding virginia", "hilltop wedding venue". Good volume, higher CPI than The Knot.'),
  ('dddd0027-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', 'WeddingWire Boost — Crestwood Farm', 'weddingwire', '2026-01-15', '2026-03-31', 500.00, 3, 2, 1, 8800.00, 166.67, 500.00, 17.60, 'Boosted listing for Crestwood Farm. Moderate results. Evaluating ROI vs The Knot.')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 28. SOCIAL POSTS
-- ============================================
INSERT INTO social_posts (id, venue_id, platform, posted_at, caption, post_url, reach, impressions, saves, shares, comments, likes, website_clicks, profile_visits, engagement_rate, is_viral) VALUES
  -- Hawthorne Manor
  ('dddd0028-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-03-20 15:00:00+00', 'Golden hour never gets old. This hilltop was made for love stories. Book your tour — link in bio.', 'https://instagram.com/p/example1', 12500, 18200, 342, 89, 67, 1450, 45, 280, 11.6, true),
  ('dddd0028-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-03-15 12:00:00+00', 'Spring is here and the dogwoods are starting to bloom. We cannot wait for wedding season.', 'https://instagram.com/p/example2', 4800, 7200, 95, 23, 31, 620, 12, 85, 12.9, false),
  ('dddd0028-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-03-10 18:00:00+00', 'Saturday setup vibes. Every wedding here tells a different story and we love that.', 'https://instagram.com/p/example3', 3200, 4800, 45, 12, 18, 380, 8, 42, 11.9, false),
  ('dddd0028-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'facebook', '2026-03-22 14:00:00+00', 'Congratulations to our March couples! Two beautiful weddings in the books this month. The 2026 season is already feeling magical.', 'https://facebook.com/posts/example1', 2800, 3500, 0, 45, 28, 189, 15, 0, 7.5, false),
  ('dddd0028-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'tiktok', '2026-03-18 20:00:00+00', 'POV: You just got engaged and you are touring the venue of your dreams. Sound on for the reaction.', 'https://tiktok.com/@example/video1', 85000, 120000, 2100, 3400, 890, 18500, 320, 4200, 21.7, true),
  -- Crestwood Farm
  ('dddd0028-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222202', 'instagram', '2026-03-21 16:00:00+00', 'Barn doors open, string lights on, and a whole lot of love in the air. This is what Crestwood Farm is all about.', 'https://instagram.com/p/example4', 3100, 4600, 78, 25, 22, 410, 10, 55, 13.2, false),
  ('dddd0028-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222202', 'instagram', '2026-03-14 13:00:00+00', 'Meadow ceremony with the mountains behind you. This is Crestwood Farm.', 'https://instagram.com/p/example5', 2400, 3600, 56, 18, 15, 290, 6, 38, 12.1, false),
  -- Glass House
  ('dddd0028-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222203', 'instagram', '2026-03-19 17:00:00+00', 'Glass walls, city lights, and a celebration that lasts all night. This is modern love at The Glass House.', 'https://instagram.com/p/example6', 5600, 8400, 125, 42, 38, 720, 22, 95, 12.9, false),
  ('dddd0028-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222203', 'tiktok', '2026-03-16 19:00:00+00', 'When the venue does the talking. The Glass House Richmond might be the most photogenic wedding space in Virginia.', 'https://tiktok.com/@example/video2', 42000, 65000, 980, 1500, 420, 8900, 180, 2100, 13.7, true),
  ('dddd0028-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222203', 'facebook', '2026-03-12 11:00:00+00', 'Spring open house is this Saturday! Come see The Glass House in person and meet our events team. No appointment needed.', 'https://facebook.com/posts/example2', 4200, 5800, 0, 65, 42, 310, 35, 0, 7.2, false)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 29. ANNOTATIONS
-- ============================================
INSERT INTO annotations (id, venue_id, annotation_type, period_start, period_end, title, description, affects_metrics, anomaly_id, created_by, response_category, exclude_from_patterns) VALUES
  ('dddd0029-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'anomaly_response', '2026-03-20', '2026-03-27', 'Spring inquiry surge — expected seasonal peak', 'Inquiry volume doubled this week. This is the annual spring engagement surge — newly engaged couples from the holiday season are now actively venue shopping. Not a true anomaly, but good to document for year-over-year comparison.', ARRAY['inquiry_volume', 'response_time'], 'be000001-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333301', 'noted', false),
  ('dddd0029-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'proactive', '2026-03-01', '2026-03-31', 'Spring listing refresh underway', 'Updating all photos on The Knot and WeddingWire with fresh spring imagery. Previous photos were from fall 2024. Expecting improved click-through rates.', ARRAY['inquiry_volume'], NULL, '33333333-3333-3333-3333-333333333301', NULL, false),
  ('dddd0029-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', 'anomaly_response', '2026-03-01', '2026-03-15', 'Tour conversion dip — investigating', 'Tour-to-booking conversion dropped to 25%. Reviewing feedback from recent tour guests. Maya is adjusting the walkthrough route to lead with the glass wall view.', ARRAY['tour_conversion', 'booking_rate'], 'be000001-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333303', 'action_taken', false),
  ('dddd0029-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'system_detected', '2026-03-26', '2026-03-26', 'Unanswered inquiry — 48 hours', 'The March 26 website inquiry has not received a response in 48 hours. This is above the 2-hour SLA. Flagged for immediate follow-up.', ARRAY['response_time'], NULL, NULL, NULL, true)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 30. VENUE HEALTH
-- ============================================
INSERT INTO venue_health (id, venue_id, calculated_at, overall_score, data_quality_score, pipeline_score, response_time_score, booking_rate_score) VALUES
  ('dddd0030-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '2026-03-27 08:00:00+00', 82.5, 95.0, 78.0, 72.0, 85.0),
  ('dddd0030-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222202', '2026-03-27 08:00:00+00', 71.0, 85.0, 68.0, 65.0, 66.0),
  ('dddd0030-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', '2026-03-27 08:00:00+00', 76.0, 90.0, 72.0, 88.0, 54.0),
  ('dddd0030-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222204', '2026-03-27 08:00:00+00', 58.0, 62.0, 55.0, 70.0, 45.0)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 31. CLIENT MATCH QUEUE
-- ============================================
INSERT INTO client_match_queue (id, venue_id, client_a_id, client_b_id, match_type, confidence, status) VALUES
  ('dddd0031-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '55555555-5555-5555-5555-555555000201', '55555555-5555-5555-5555-555555000202', 'name', 0.35, 'dismissed'),
  ('dddd0031-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '55555555-5555-5555-5555-555555000101', '55555555-5555-5555-5555-555555000301', 'email', 0.82, 'pending'),
  ('dddd0031-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', '55555555-5555-5555-5555-555555000401', '55555555-5555-5555-5555-555555000402', 'phone', 0.91, 'pending')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 32. KNOWLEDGE GAPS
-- ============================================
INSERT INTO knowledge_gaps (id, venue_id, question, category, frequency, status, resolution, resolved_at) VALUES
  -- Open gaps
  ('dddd0032-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'What is the exact rain plan setup for indoor ceremonies?', 'logistics', 4, 'open', NULL, NULL),
  ('dddd0032-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'Can we have a food truck instead of a caterer?', 'catering', 2, 'open', NULL, NULL),
  ('dddd0032-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'Is there a generator for the hilltop ceremony in case of power issues?', 'logistics', 1, 'open', NULL, NULL),
  ('dddd0032-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', 'Do you allow fireworks or sparklers at Crestwood Farm?', 'policies', 3, 'open', NULL, NULL),
  ('dddd0032-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222203', 'What is the noise ordinance cutoff time for The Glass House?', 'policies', 2, 'open', NULL, NULL),
  -- Resolved gaps
  ('dddd0032-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'Are drones allowed for photography?', 'policies', 3, 'resolved', 'Yes, drones are allowed with FAA Part 107 licensed operators. Photographer must coordinate flight path with Sarah to avoid ceremony disruption.', '2026-02-15 00:00:00+00'),
  ('dddd0032-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', 'What is the latest the music can play?', 'policies', 5, 'resolved', 'Music must end by 10:00 PM per county noise ordinance. Last call at 9:45 PM. Sparkler exit typically at 10:00 PM.', '2026-01-20 00:00:00+00'),
  ('dddd0032-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', 'Is there Wi-Fi for guests?', 'amenities', 2, 'resolved', 'Yes — network "HawthorneManor-Guest", password shared at check-in. Note: signal is weak at the hilltop ceremony site.', '2026-01-10 00:00:00+00'),
  ('dddd0032-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222202', 'Can we have a live band in the barn?', 'logistics', 2, 'resolved', 'Yes, the barn has power for a 4-piece band. Larger setups need a generator. Sound check must happen before 4pm.', '2026-02-20 00:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 33. FOLLOW-UP SEQUENCE TEMPLATES
-- ============================================
INSERT INTO follow_up_sequence_templates (id, venue_id, name, trigger, steps, is_active) VALUES
  ('dddd0033-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'New Inquiry — 3 Touch Sequence', 'new_inquiry',
   '[{"step": 1, "delay_hours": 0, "action": "auto_reply", "subject_template": "Welcome! Let''s find your perfect date at Hawthorne Manor", "tone": "warm_enthusiastic", "include_availability": true, "include_pricing": false}, {"step": 2, "delay_hours": 48, "action": "follow_up", "subject_template": "Still thinking about Hawthorne Manor? Here''s what makes us special", "tone": "helpful_not_pushy", "include_availability": false, "include_pricing": true}, {"step": 3, "delay_hours": 168, "action": "final_touch", "subject_template": "One last thing from Sage at Hawthorne Manor", "tone": "gentle_close", "include_availability": true, "include_pricing": false}]',
   true),
  ('dddd0033-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'Post Tour — 2 Touch Follow-Up', 'post_tour',
   '[{"step": 1, "delay_hours": 2, "action": "thank_you", "subject_template": "Thank you for visiting Hawthorne Manor!", "tone": "warm_personal", "include_photos": true, "include_proposal": false}, {"step": 2, "delay_hours": 120, "action": "proposal_nudge", "subject_template": "Your Hawthorne Manor proposal is ready", "tone": "confident_helpful", "include_photos": false, "include_proposal": true}]',
   true),
  ('dddd0033-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', 'New Inquiry — Crestwood Warm Welcome', 'new_inquiry',
   '[{"step": 1, "delay_hours": 0, "action": "auto_reply", "subject_template": "Hey from Crestwood Farm! Let''s chat about your big day", "tone": "playful_warm", "include_availability": true, "include_pricing": false}, {"step": 2, "delay_hours": 72, "action": "follow_up", "subject_template": "Y''all still looking for the perfect barn? 🌻", "tone": "casual_friendly", "include_availability": true, "include_pricing": true}]',
   true)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 34. WEDDING SEQUENCES
-- ============================================
INSERT INTO wedding_sequences (id, venue_id, wedding_id, template_id, status, enrolled_at, paused_at, completed_at, current_step) VALUES
  ('dddd0034-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 'dddd0033-0001-0001-0001-000000000001', 'active', '2026-03-24 14:30:00+00', NULL, NULL, 2),
  ('dddd0034-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000116', 'dddd0033-0001-0001-0001-000000000001', 'active', '2026-03-26 10:15:00+00', NULL, NULL, 1),
  ('dddd0034-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000113', 'dddd0033-0001-0001-0001-000000000002', 'paused', '2026-03-05 16:00:00+00', '2026-03-10 09:00:00+00', NULL, 2),
  ('dddd0034-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000212', 'dddd0033-0001-0001-0001-000000000003', 'active', '2026-03-22 09:00:00+00', NULL, NULL, 1)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 35. RELATIONSHIPS
-- ============================================
INSERT INTO relationships (id, venue_id, person_a_id, person_b_id, relationship_type, notes) VALUES
  -- Chloe & Ryan — partners
  ('dddd0035-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '55555555-5555-5555-5555-555555000301', '55555555-5555-5555-5555-555555000302', 'partner', 'Engaged couple — wedding 109'),
  -- Aisha & Marcus — partners
  ('dddd0035-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '55555555-5555-5555-5555-555555000201', '55555555-5555-5555-5555-555555000202', 'partner', 'Inquiry couple — hot lead'),
  -- Taylor & Jordan — partners
  ('dddd0035-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', '55555555-5555-5555-5555-555555000401', '55555555-5555-5555-5555-555555000402', 'partner', 'Engaged couple — wedding 209'),
  -- Priya & Nico — partners
  ('dddd0035-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222203', '55555555-5555-5555-5555-555555000501', '55555555-5555-5555-5555-555555000502', 'partner', 'Inquiry couple — Glass House'),
  -- Lily & Daniel — partners
  ('dddd0035-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222204', '55555555-5555-5555-5555-555555000601', '55555555-5555-5555-5555-555555000602', 'partner', 'Engaged couple — Rose Hill wedding 407')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 36. CLIENT CODES
-- ============================================
INSERT INTO client_codes (id, venue_id, wedding_id, code, format_template) VALUES
  ('dddd0036-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'HAWTHORNE-2609', 'HAWTHORNE-YYMM'),
  ('dddd0036-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', 'HAWTHORNE-2610', 'HAWTHORNE-YYMM'),
  ('dddd0036-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000111', 'HAWTHORNE-2611', 'HAWTHORNE-YYMM'),
  ('dddd0036-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000112', 'HAWTHORNE-2612', 'HAWTHORNE-YYMM'),
  ('dddd0036-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000209', 'CREST-2601', 'CREST-YYMM'),
  ('dddd0036-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000313', 'GLASS-2601', 'GLASS-YYMM'),
  ('dddd0036-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000407', 'ROSE-2601', 'ROSE-YYMM')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 37. ERROR LOGS
-- ============================================
INSERT INTO error_logs (id, venue_id, error_type, message, stack_trace, context, resolved, resolved_by, resolved_at, created_at) VALUES
  ('dddd0037-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'gmail_auth', 'Gmail API token expired for events@hawthornemanor.com', 'Error: invalid_grant at GoogleAuth.refreshToken (/lib/services/email/gmail.ts:142)', '{"venue_id": "22222222-2222-2222-2222-222222222201", "email": "events@hawthornemanor.com", "last_sync": "2026-03-25T08:00:00Z"}', true, '33333333-3333-3333-3333-333333333301', '2026-03-25 10:30:00+00', '2026-03-25 08:15:00+00'),
  ('dddd0037-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'ai_timeout', 'Claude API request timed out after 30s during weekly briefing generation', 'Error: AbortError: signal timed out at callAI (/lib/ai/client.ts:89)', '{"venue_id": "22222222-2222-2222-2222-222222222201", "context": "weekly_briefing", "model": "claude-sonnet-4-20250514", "timeout_ms": 30000}', true, NULL, '2026-03-27 08:05:00+00', '2026-03-27 08:01:00+00'),
  ('dddd0037-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', 'rate_limit', 'Anthropic API rate limit exceeded — 429 Too Many Requests', 'Error: RateLimitError at callAI (/lib/ai/client.ts:67)', '{"venue_id": "22222222-2222-2222-2222-222222222203", "context": "sage_chat", "retry_after_ms": 5000}', false, NULL, NULL, '2026-03-27 15:30:00+00'),
  ('dddd0037-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', 'webhook_failure', 'WeddingWire webhook delivery failed — 502 Bad Gateway', NULL, '{"venue_id": "22222222-2222-2222-2222-222222222202", "webhook_url": "https://api.weddingwire.com/webhooks/v1/inquiry", "attempt": 3}', false, NULL, NULL, '2026-03-26 22:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 38. VENDOR RECOMMENDATIONS — UPDATE with portal tokens
-- ============================================
UPDATE vendor_recommendations SET
  portal_token = 'vnd_bbq_hawthorne_2026_a1b2c3',
  bio = 'Born and raised in Culpeper, Virginia. We have been smoking brisket for 15 years and catering weddings at Hawthorne Manor since it opened. Our farm-to-table BBQ uses locally sourced meats and seasonal sides. We love what we do and it shows in every plate.',
  instagram_url = 'https://instagram.com/bbqcompanyva',
  portfolio_photos = ARRAY['https://images.unsplash.com/photo-1529193591184-b1d58069ecdd?w=600', 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=600', 'https://images.unsplash.com/photo-1544025162-d76694265947?w=600'],
  last_updated_by_vendor = '2026-03-15 10:00:00+00'
WHERE id = 'd2000001-0000-0000-0000-000000000001';

UPDATE vendor_recommendations SET
  portal_token = 'vnd_lens_hawthorne_2026_d4e5f6',
  bio = 'We are a husband-and-wife photography team based in Charlottesville. Our style is documentary with a fine art touch — we capture real moments, not poses. Hawthorne Manor is one of our favorite venues because the light on that hilltop is unmatched.',
  instagram_url = 'https://instagram.com/lensandlightstudio',
  portfolio_photos = ARRAY['https://images.unsplash.com/photo-1537633552985-df8429e8048b?w=600', 'https://images.unsplash.com/photo-1606216794079-73f85bbd57d5?w=600'],
  last_updated_by_vendor = '2026-03-10 14:00:00+00'
WHERE id = 'd2000001-0000-0000-0000-000000000002';

UPDATE vendor_recommendations SET
  portal_token = 'vnd_valley_hawthorne_2026_g7h8i9',
  bio = 'Floral design rooted in the seasons. We grow 80% of our flowers on our farm in Madison County. Wildflower, garden-style, and organic arrangements are our specialty. We believe flowers should look like they were just gathered from a beautiful garden.',
  instagram_url = 'https://instagram.com/valleybloomsva',
  portfolio_photos = ARRAY['https://images.unsplash.com/photo-1487530811176-3780de880c2d?w=600', 'https://images.unsplash.com/photo-1561128290-006dc4827214?w=600', 'https://images.unsplash.com/photo-1522748906645-95d8adfd52c7?w=600'],
  last_updated_by_vendor = '2026-02-28 09:00:00+00'
WHERE id = 'd2000001-0000-0000-0000-000000000003';

UPDATE vendor_recommendations SET
  portal_token = 'vnd_mobilebar_hawthorne_2026_j1k2l3',
  bio = 'Full-service mobile bar for BYOB venues. We bring the bartenders, the setup, and the craft cocktail expertise — you bring the booze. We have worked over 50 weddings at Hawthorne Manor and know the space like the back of our hand.',
  instagram_url = 'https://instagram.com/mobilebarco',
  portfolio_photos = ARRAY['https://images.unsplash.com/photo-1551024709-8f23befc6f87?w=600'],
  last_updated_by_vendor = '2026-03-20 16:00:00+00'
WHERE id = 'd2000001-0000-0000-0000-000000000004';

-- ============================================
-- 39. ACTIVITY LOG
-- ============================================
INSERT INTO activity_log (id, venue_id, wedding_id, user_id, activity_type, entity_type, entity_id, details, created_at) VALUES
  -- Recent activity for wedding 109 (Chloe & Ryan)
  ('dddd0039-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'timeline_updated', 'timeline', 'cb000001-0000-0000-0000-000000000001', '{"change": "Updated bridal party prep time from 2:00 PM to 3:00 PM", "section": "preparation"}', '2026-03-27 14:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'vendor_added', 'vendor_recommendations', NULL, '{"vendor_name": "Valley Blooms", "vendor_type": "florist", "action": "Selected from recommendations"}', '2026-03-26 10:30:00+00'),
  ('dddd0039-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'checklist_completed', 'checklist_items', 'd0000001-0000-0000-0000-000000000003', '{"item": "Send invitations", "completed_by": "couple"}', '2026-03-25 16:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'guest_added', 'guest_list', NULL, '{"count": 5, "group": "Work colleagues", "total_guests": 175}', '2026-03-24 11:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'budget_updated', 'budget', 'cc000001-0000-0000-0000-000000000003', '{"item": "Mobile Bar Co", "field": "actual_cost", "old_value": null, "new_value": 3100}', '2026-03-23 15:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'message_sent', 'messages', NULL, '{"from": "couple", "preview": "Yes! We went with BBQ Company..."}', '2026-03-22 09:30:00+00'),
  ('dddd0039-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'section_signed_off', 'section_finalisations', NULL, '{"section": "bar", "signed_off_by": "couple"}', '2026-03-25 09:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'bar_recipe_added', 'bar_recipes', NULL, '{"cocktail_name": "The Hilltop Sunset", "action": "created"}', '2026-03-20 20:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'borrow_items_selected', 'borrow_selections', NULL, '{"items_selected": 6, "categories": ["arch", "votives", "table_numbers", "string_lights"]}', '2026-03-18 14:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'website_published', 'wedding_website_settings', NULL, '{"slug": "chloe-and-ryan-2026", "action": "published"}', '2026-03-15 11:00:00+00'),

  -- Staff activity
  ('dddd0039-0001-0001-0001-000000000011', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', '33333333-3333-3333-3333-333333333301', 'section_signed_off', 'section_finalisations', NULL, '{"section": "ceremony", "signed_off_by": "staff", "coordinator": "Sarah Chen"}', '2026-03-22 14:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000012', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', '33333333-3333-3333-3333-333333333301', 'message_sent', 'messages', NULL, '{"from": "coordinator", "preview": "Such a great choice! Their brisket is incredible..."}', '2026-03-22 10:00:00+00'),

  -- Other weddings activity
  ('dddd0039-0001-0001-0001-000000000013', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', NULL, 'inquiry_received', 'interactions', '66666666-6666-6666-6666-666666000101', '{"source": "google", "subject": "Interested in Hawthorne Manor for Fall 2027"}', '2026-03-24 14:30:00+00'),
  ('dddd0039-0001-0001-0001-000000000014', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000116', NULL, 'inquiry_received', 'interactions', '66666666-6666-6666-6666-666666000103', '{"source": "website", "subject": "Pricing info please"}', '2026-03-26 10:15:00+00'),
  ('dddd0039-0001-0001-0001-000000000015', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000113', '33333333-3333-3333-3333-333333333301', 'proposal_sent', 'weddings', '44444444-4444-4444-4444-444444000113', '{"booking_value": 13000, "wedding_date": "2026-11-07"}', '2026-03-10 09:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000016', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000114', '33333333-3333-3333-3333-333333333301', 'tour_scheduled', 'tours', NULL, '{"scheduled_at": "2026-04-01T14:00:00Z", "source": "the_knot"}', '2026-03-15 12:00:00+00'),

  -- Cross-venue activity
  ('dddd0039-0001-0001-0001-000000000017', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000212', NULL, 'inquiry_received', 'interactions', '66666666-6666-6666-6666-666666000104', '{"source": "the_knot", "subject": "Barn venue for intimate wedding?"}', '2026-03-22 09:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000018', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', NULL, 'inquiry_received', 'interactions', '66666666-6666-6666-6666-666666000106', '{"source": "google", "subject": "Large wedding at The Glass House"}', '2026-03-20 11:30:00+00'),
  ('dddd0039-0001-0001-0001-000000000019', '22222222-2222-2222-2222-222222222201', NULL, '33333333-3333-3333-3333-333333333301', 'briefing_generated', 'ai_briefings', 'bd000002-0000-0000-0000-000000000001', '{"briefing_type": "weekly", "generated_at": "2026-03-27T08:00:00Z"}', '2026-03-27 08:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000020', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', NULL, 'onboarding_step_completed', 'onboarding_progress', NULL, '{"step": "chat", "wedding": "wedding 110"}', '2026-01-28 14:00:00+00'),

  -- Older activity for historical depth
  ('dddd0039-0001-0001-0001-000000000021', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'wedding_booked', 'weddings', '44444444-4444-4444-4444-444444000109', '{"booking_value": 16000, "source": "the_knot", "wedding_date": "2026-05-30"}', '2025-11-20 15:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000022', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'sage_chat_started', 'sage_conversations', NULL, '{"first_message": "Hey Sage! Can we bring our dog to the ceremony?"}', '2026-02-01 19:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000023', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'worksheet_completed', 'wedding_worksheets', NULL, '{"section": "priorities", "action": "submitted"}', '2026-02-05 20:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000024', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'allergy_registered', 'allergy_registry', NULL, '{"guest": "Sophia Martinez", "allergy": "Tree Nuts", "severity": "severe"}', '2026-03-10 12:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000025', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'care_note_added', 'guest_care_notes', NULL, '{"guest": "Abuela Rosa Martinez", "care_type": "mobility", "summary": "Walker user, needs ground floor seating"}', '2026-03-10 12:15:00+00'),

  -- More recent activity
  ('dddd0039-0001-0001-0001-000000000026', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'makeup_schedule_updated', 'makeup_schedule', NULL, '{"people_count": 6, "first_time": "08:00", "last_time": "12:45"}', '2026-03-26 11:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000027', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'ceremony_order_finalized', 'ceremony_order', NULL, '{"participant_count": 12, "includes_flower_girl": true, "includes_ring_bearer": true}', '2026-03-22 10:30:00+00'),
  ('dddd0039-0001-0001-0001-000000000028', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'rehearsal_dinner_confirmed', 'rehearsal_dinner', NULL, '{"location": "Foti''s Restaurant", "date": "2026-05-29", "guest_count": 35}', '2026-03-18 10:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000029', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'shuttle_booked', 'shuttle_schedule', NULL, '{"routes": 3, "provider": "Culpeper Shuttle Co", "total_capacity": 110}', '2026-03-20 12:00:00+00'),
  ('dddd0039-0001-0001-0001-000000000030', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', NULL, 'staffing_confirmed', 'staffing_assignments', NULL, '{"roles_filled": 5, "total_staff": 11, "total_hours": 39}', '2026-03-21 09:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 40. ADMIN NOTIFICATIONS
-- ============================================
INSERT INTO admin_notifications (id, venue_id, wedding_id, type, title, body, read, read_at, email_sent, created_at) VALUES
  -- Unread (recent)
  ('dddd0040-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000116', 'new_inquiry', 'New Inquiry — Pricing Request', 'A new inquiry came in from the website asking about pricing for spring 2027. No response has been sent yet.', false, NULL, true, '2026-03-26 10:15:00+00'),
  ('dddd0040-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000116', 'sage_uncertain', 'Sage Low Confidence — Unanswered Inquiry', 'The March 26 inquiry has not been responded to. This lead may go cold. Recommend immediate follow-up.', false, NULL, false, '2026-03-28 08:00:00+00'),
  ('dddd0040-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'client_activity', 'Chloe & Ryan Updated Their Timeline', 'The couple moved bridal party prep from 2:00 PM to 3:00 PM. Review the change to ensure it works with vendor arrival times.', false, NULL, false, '2026-03-27 14:00:00+00'),
  ('dddd0040-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'client_activity', 'Bar Section Signed Off by Chloe & Ryan', 'The couple has signed off on the bar plan. Mobile Bar Co confirmed, 3 signature cocktails finalized, shopping list in progress.', false, NULL, false, '2026-03-25 09:00:00+00'),
  ('dddd0040-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222203', NULL, 'escalation', 'Rate Limit Error — Glass House Sage Chat', 'Anthropic API rate limit was hit during a Sage chat session at The Glass House. The conversation may have been interrupted. Check error logs.', false, NULL, true, '2026-03-27 15:30:00+00'),

  -- Read (older)
  ('dddd0040-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 'new_inquiry', 'New Inquiry — Aisha & Marcus', 'Hot lead from Google. Aisha Johnson inquired about fall 2027, approximately 100 guests. Very enthusiastic tone.', true, '2026-03-24 15:00:00+00', true, '2026-03-24 14:30:00+00'),
  ('dddd0040-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'client_activity', 'Wedding Website Published', 'Chloe & Ryan published their wedding website at chloe-and-ryan-2026. All sections are enabled including RSVP.', true, '2026-03-15 12:00:00+00', false, '2026-03-15 11:00:00+00'),
  ('dddd0040-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', NULL, 'system', 'Weekly Briefing Generated', 'Your weekly intelligence briefing is ready. Key highlights: 2 new inquiries, search trends up 22%, beautiful weather ahead.', true, '2026-03-27 09:00:00+00', true, '2026-03-27 08:00:00+00'),
  ('dddd0040-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'sage_uncertain', 'Sage Flagged Uncertain Answer — Rain Plan', 'Sage answered a question about the indoor ceremony rain plan with only 55% confidence. The answer has been queued for your review.', true, '2026-02-02 10:00:00+00', false, '2026-02-01 19:05:00+00'),
  ('dddd0040-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000113', 'client_activity', 'Proposal Viewed', 'The couple for the November 7 wedding viewed the proposal you sent. They have not responded yet. Consider a gentle follow-up in a few days.', true, '2026-03-12 10:00:00+00', false, '2026-03-11 14:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- DONE! All 009-011 tables populated.
-- 40 table sections covering:
--   - 10 couple day-of tables
--   - 10 couple enhanced feature tables
--   - 3 guest enhancement tables
--   - 1 wedding website table
--   - 7 intelligence tables
--   - 6 agent depth tables
--   - 1 vendor portal update
--   - 2 activity/notification tables
-- ============================================
