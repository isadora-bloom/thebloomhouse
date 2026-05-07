-- ============================================================================
-- CHLOE & RYAN — fill seed for empty couple-portal tables
-- ============================================================================
-- Existing data: people (2), wedding_details, wedding_tables, wedding_config,
--   budget_items (21), guest_list (10), rsvp_responses (3), timeline (7),
--   checklist_items (6), booked_vendors (7), contracts, bedroom_assignments,
--   sage_conversations.
-- This fill targets the EMPTY tables that drive visible portal pages:
--   wedding_party, decor_inventory, bar_planning, allergy_registry, plus
--   adds family/extended people and venue-level accommodations.
--
-- Schema-verified against migrations as of 2026-05-08. Idempotent: each
-- INSERT uses NOT EXISTS guard or ON CONFLICT so re-running is a no-op.
-- ============================================================================

-- Reusable constants (Hawthorne Manor + Chloe & Ryan)
-- VENUE_ID:   22222222-2222-2222-2222-222222222201
-- WEDDING_ID: 44444444-4444-4444-4444-444444000109

-- ============================================================================
-- 1. WEDDING_PARTY — bridesmaids, groomsmen, etc.
-- ============================================================================
INSERT INTO wedding_party (venue_id, wedding_id, name, role, side, relationship, sort_order)
SELECT * FROM (VALUES
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Mia Martinez',     'maid_of_honor', 'bride', 'Sister',         1),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Jess Thompson',    'bridesmaid',    'bride', 'College roommate',2),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Sara Patel',       'bridesmaid',    'bride', 'Cousin',         3),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Olivia Brooks',    'bridesmaid',    'bride', 'Ryan''s sister', 4),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Nathan Brooks',    'best_man',      'groom', 'Brother',        1),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Marcus Lin',       'groomsman',     'groom', 'College friend', 2),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Daniel Reyes',     'groomsman',     'groom', 'Childhood friend', 3),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Tom Brooks',       'groomsman',     'groom', 'Chloe''s brother', 4),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Lily Martinez',    'flower_girl',   'bride', 'Niece',          5),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Henry Brooks',     'ring_bearer',   'groom', 'Nephew',         5)
) AS v(venue_id, wedding_id, name, role, side, relationship, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM wedding_party
   WHERE wedding_id = v.wedding_id AND name = v.name
);

-- ============================================================================
-- 2. DECOR_INVENTORY — what they're bringing / borrowing / making
-- ============================================================================
INSERT INTO decor_inventory (venue_id, wedding_id, item_name, category, quantity, source, vendor_name, notes, leaving_instructions)
SELECT * FROM (VALUES
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Wooden ceremony arch',           'ceremony',  1,  'borrow',  'Hawthorne Manor', 'From the borrow catalog. Florist will install swag.', 'Leaving for venue to break down'),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Bud vases (assorted)',           'tables',    24, 'borrow',  'Hawthorne Manor', 'Mix of clear and amber from the borrow catalog.',     'Returning to catalog after'),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Card box (vintage suitcase)',    'entrance',  1,  'personal', NULL,             'Chloe''s grandmother''s. Sentimental.',                'Mom is taking home Sunday'),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Calligraphed escort mirror',     'entrance',  1,  'diy',     NULL,              'Olivia is doing the calligraphy in white paint.',    'Saving for our home'),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Honey jar favors',               'tables',    140,'diy',     NULL,              'Custom labels printed at home (Meant to Bee).',    'Guests take home'),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Sparklers (36-inch wedding)',    'other',     200,'personal', NULL,             'For grand exit. DJ will announce.',                  'Whatever is left, leave with venue'),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Welcome sign',                   'entrance',  1,  'diy',     NULL,              'Chalkboard easel from Target.',                      'Saving'),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Hurricane vases',                'tables',    14, 'borrow',  'Hawthorne Manor', 'For taper candles on long tables.',                  'Returning to catalog'),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Cheesecloth runners (sage)',     'tables',    14, 'borrow',  'Hawthorne Manor', 'Already pre-pressed. Florist will style with greenery.', 'Returning'),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Cake cutter & server',           'reception', 1,  'personal', NULL,             'Wedding gift from Chloe''s parents.',                 'Taking home')
) AS v(venue_id, wedding_id, item_name, category, quantity, source, vendor_name, notes, leaving_instructions)
WHERE NOT EXISTS (
  SELECT 1 FROM decor_inventory
   WHERE wedding_id = v.wedding_id AND item_name = v.item_name
);

-- ============================================================================
-- 3. BAR_PLANNING — single row per wedding
-- ============================================================================
INSERT INTO bar_planning (venue_id, wedding_id, bar_type, guest_count, bartender_count, notes)
SELECT
  '22222222-2222-2222-2222-222222222201'::uuid,
  '44444444-4444-4444-4444-444444000109'::uuid,
  'beer_wine',
  140,
  3,
  'Beer, wine, and one signature cocktail (lavender French 75). 3 bartenders for 140 guests including the satellite bar at the rooftop welcome reception.'
WHERE NOT EXISTS (
  SELECT 1 FROM bar_planning WHERE wedding_id = '44444444-4444-4444-4444-444444000109'::uuid
);

-- ============================================================================
-- 4. ALLERGY_REGISTRY — guest dietary alerts
-- ============================================================================
INSERT INTO allergy_registry (venue_id, wedding_id, guest_name, allergy_type, severity, notes, is_important)
SELECT * FROM (VALUES
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Aunt Pat',    'Tree nuts (almonds, cashews)', 'severe',          'Carries an EpiPen. Caterer notified for both ceremony snacks and dinner.', true),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Tom Brooks',  'Shellfish',                    'moderate',        'Listed on RSVP. Avoid passed apps with shrimp.',                            true),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Mia Martinez','Gluten',                       'mild',            'Celiac. Caterer has a separate meal plan.',                                 false),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Henry (4)',   'Peanuts',                      'life_threatening','EpiPen with parents. No peanut products in any kid plate or favor.',         true),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'Daniel Reyes','Dairy',                        'moderate',        'Lactose intolerant — has DiyAir. Note for cake serving.',                   false)
) AS v(venue_id, wedding_id, guest_name, allergy_type, severity, notes, is_important)
WHERE NOT EXISTS (
  SELECT 1 FROM allergy_registry
   WHERE wedding_id = v.wedding_id AND guest_name = v.guest_name AND allergy_type = v.allergy_type
);

-- ============================================================================
-- 5. ACCOMMODATIONS — venue-level recommended places to stay (NOT wedding-scoped)
-- Hawthorne couples share this list. If already populated by another seed,
-- the NOT EXISTS guard makes this a no-op.
-- ============================================================================
INSERT INTO accommodations (venue_id, name, type, address, website_url, price_per_night, distance_miles, description, is_recommended, sort_order)
SELECT * FROM (VALUES
  ('22222222-2222-2222-2222-222222222201'::uuid, 'The Inn at Hawthorne Hill',    'inn',     '142 Hawthorne Lane',                'https://innathawthornehill.com',     245.00, 1.2,  'Closest to the venue. Walk-able for guests staying late.',           true,  1),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Cedar Brook Lodge',            'boutique','55 Cedar Brook Rd',                  'https://cedarbrooklodge.com',        189.00, 4.5,  'Block of 20 rooms held under "Brooks-Martinez Wedding".',            true,  2),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Hampton Inn Hawthorne',        'hotel',   '1200 Main St, Hawthorne',           'https://www.hilton.com/en/hampton',  149.00, 6.8,  'Budget-friendly. Free breakfast. Shuttle reaches in 15 minutes.',    true,  3),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'The Riverbend Cottage (Airbnb)','airbnb', 'Riverbend Estates',                  'https://www.airbnb.com',             325.00, 3.1,  'Sleeps 6. Ideal for a wedding-party stay.',                          true,  4),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Holiday Inn Express',          'hotel',   '405 Highway 7',                     'https://www.ihg.com',                119.00, 8.2,  'Furthest of the recommended set. Reliable, no surprises.',           false, 5)
) AS v(venue_id, name, type, address, website_url, price_per_night, distance_miles, description, is_recommended, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM accommodations
   WHERE venue_id = v.venue_id AND name = v.name
);

-- ============================================================================
-- 6. EXTENDED PEOPLE — family members beyond the partners
-- ============================================================================
INSERT INTO people (venue_id, wedding_id, role, first_name, last_name, email)
SELECT * FROM (VALUES
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'family',          'Maria',    'Martinez',  'maria.martinez@example.com'),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'family',          'Carlos',   'Martinez',  'carlos.martinez@example.com'),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'family',          'Linda',    'Brooks',    'linda.brooks@example.com'),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'family',          'David',    'Brooks',    'david.brooks@example.com'),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'wedding_party',   'Mia',      'Martinez',  'mia.m@example.com'),
  ('22222222-2222-2222-2222-222222222201'::uuid, '44444444-4444-4444-4444-444444000109'::uuid, 'wedding_party',   'Nathan',   'Brooks',    'nathan.brooks@example.com')
) AS v(venue_id, wedding_id, role, first_name, last_name, email)
WHERE NOT EXISTS (
  SELECT 1 FROM people
   WHERE wedding_id = v.wedding_id AND first_name = v.first_name AND last_name = v.last_name
);

-- ============================================================================
-- VERIFICATION
-- ============================================================================
DO $$
DECLARE
  c_party    int; c_decor    int; c_bar      int;
  c_allergy  int; c_accom    int; c_people   int;
BEGIN
  SELECT COUNT(*) INTO c_party    FROM wedding_party    WHERE wedding_id = '44444444-4444-4444-4444-444444000109';
  SELECT COUNT(*) INTO c_decor    FROM decor_inventory  WHERE wedding_id = '44444444-4444-4444-4444-444444000109';
  SELECT COUNT(*) INTO c_bar      FROM bar_planning     WHERE wedding_id = '44444444-4444-4444-4444-444444000109';
  SELECT COUNT(*) INTO c_allergy  FROM allergy_registry WHERE wedding_id = '44444444-4444-4444-4444-444444000109';
  SELECT COUNT(*) INTO c_accom    FROM accommodations   WHERE venue_id   = '22222222-2222-2222-2222-222222222201';
  SELECT COUNT(*) INTO c_people   FROM people           WHERE wedding_id = '44444444-4444-4444-4444-444444000109';
  RAISE NOTICE '[chloe-ryan-fill] wedding_party=% decor=% bar=% allergy=% accommodations=% people=%',
    c_party, c_decor, c_bar, c_allergy, c_accom, c_people;
END $$;
