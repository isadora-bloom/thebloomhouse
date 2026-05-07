
-- ============================================================================
-- ▶ seed-chloe-ryan-fill.sql
-- ============================================================================
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

-- ============================================================================
-- ▶ seed-demo-venues-fill.sql
-- ============================================================================
-- ============================================================================
-- DEMO VENUES — venue-level catalog fill for Crestwood, Glass House, Rose Hill
-- ============================================================================
-- Hawthorne Manor is the canonical couple-portal demo (Chloe & Ryan filled
-- via seed-chloe-ryan-fill.sql). The other 3 demo venues have weddings +
-- people for coordinator-side analytics, but their venue-scoped catalogs
-- (knowledge_base, vendor_recommendations, accommodations) were empty. This
-- fills those so any coordinator drilling into a non-Hawthorne demo venue
-- sees populated lists instead of "0 entries" placeholders.
--
-- Each venue gets a personality-matched seed (per the venue_ai_config voices
-- in seed.sql): Crestwood = rustic / playful, Glass House = modern /
-- professional, Rose Hill = garden romantic / enthusiastic.
--
-- Schema-verified against current migrations. Idempotent: every insert is
-- guarded by NOT EXISTS so re-runs are no-ops.
--
-- Venue IDs:
--   Crestwood Farm    : 22222222-2222-2222-2222-222222222202
--   The Glass House   : 22222222-2222-2222-2222-222222222203
--   Rose Hill Gardens : 22222222-2222-2222-2222-222222222204
-- ============================================================================

-- ============================================================================
-- 1. KNOWLEDGE BASE
-- ============================================================================

INSERT INTO knowledge_base (venue_id, category, question, answer, keywords, priority, is_active)
SELECT * FROM (VALUES
  -- ---- Crestwood Farm (rustic, playful) ----
  ('22222222-2222-2222-2222-222222222202'::uuid, 'venue',     'How many guests can Crestwood hold?',                'Up to 150 seated for dinner, 200 for cocktail-style. The big barn is the main reception space; the meadow handles ceremonies up to 200.',                ARRAY['capacity','guests','barn','meadow'],          5, true),
  ('22222222-2222-2222-2222-222222222202'::uuid, 'venue',     'Is the venue rain-friendly?',                        'Yep. The barn is fully enclosed and heated. We pull the trigger on rain plan 24 hours out — coordinator calls you.',                                       ARRAY['rain','weather','backup'],                    5, true),
  ('22222222-2222-2222-2222-222222222202'::uuid, 'catering',  'Do we have to use a preferred caterer?',             'Nope, you can pick anyone. We have a hybrid model so caterers we know well are easier, but bring your own and we''ll handle the kitchen briefing.',         ARRAY['caterer','catering','hybrid'],                5, true),
  ('22222222-2222-2222-2222-222222222202'::uuid, 'pets',      'Can our dog come?',                                  'Absolutely. Most weeks we have a dog at a wedding. Just give us a heads-up so we can prep the meadow.',                                                     ARRAY['dog','pet','animals'],                        4, true),
  ('22222222-2222-2222-2222-222222222202'::uuid, 'parking',   'Where do guests park?',                              'Gravel lot for 80 cars right next to the barn. Overflow on the south meadow if you''re over 120 guests.',                                                  ARRAY['parking','overflow'],                         4, true),
  ('22222222-2222-2222-2222-222222222202'::uuid, 'timeline',  'When can we start setup?',                           'Friday 2pm for full-weekend bookings. Saturday-only is 10am sharp.',                                                                                       ARRAY['setup','timing','schedule'],                  4, true),
  ('22222222-2222-2222-2222-222222222202'::uuid, 'pricing',   'What''s included in the base rate?',                 'Tables, chairs, basic linens, mason jar centerpieces, string lights, and the cleanup. Catering, alcohol, and DJ are separate.',                            ARRAY['included','price','base'],                    5, true),
  ('22222222-2222-2222-2222-222222222202'::uuid, 'logistics', 'Do you have lodging on site?',                       'A 4-bedroom farmhouse on the property sleeps 8. Most couples stay there Friday + Saturday.',                                                                ARRAY['lodging','farmhouse','sleep'],                3, true),

  -- ---- The Glass House (modern, professional) ----
  ('22222222-2222-2222-2222-222222222203'::uuid, 'venue',     'What is the maximum capacity?',                       'The Glass House comfortably hosts 250 guests for a seated dinner. The atrium can flex to 320 for cocktail receptions.',                                       ARRAY['capacity','maximum','atrium'],               5, true),
  ('22222222-2222-2222-2222-222222222203'::uuid, 'venue',     'Is the venue accessible?',                            'Yes — fully ADA compliant. Step-free access throughout, accessible restrooms on every floor, and elevator service to the rooftop terrace.',                  ARRAY['accessible','ada','wheelchair'],             5, true),
  ('22222222-2222-2222-2222-222222222203'::uuid, 'catering',  'Do you provide in-house catering?',                   'We do. Our chef-driven menus rotate seasonally; tasting appointments are part of the booking package.',                                                     ARRAY['catering','in_house','chef','menu'],         5, true),
  ('22222222-2222-2222-2222-222222222203'::uuid, 'pricing',   'What''s the pricing structure?',                      'Saturdays in peak season (May-Oct) start at $12,000 venue fee. Off-peak and weekday rates available; speak with our planning team for a tailored proposal.', ARRAY['pricing','rates','peak'],                    5, true),
  ('22222222-2222-2222-2222-222222222203'::uuid, 'parking',   'How does parking work?',                              'Underground garage with valet service for events over 100 guests. 80 self-park spots are available for smaller events.',                                    ARRAY['parking','valet','garage'],                  4, true),
  ('22222222-2222-2222-2222-222222222203'::uuid, 'timeline',  'When is venue access available?',                     'Day-of access at 9am for vendor load-in. Earlier setup can be arranged for an additional fee — please ask your coordinator.',                              ARRAY['access','setup','load_in'],                  4, true),
  ('22222222-2222-2222-2222-222222222203'::uuid, 'logistics', 'Is there a bridal suite?',                            'Two private suites — one on the second floor (north light, full mirror wall) and one rooftop-adjacent (west light, terrace access).',                       ARRAY['bridal_suite','suite','getting_ready'],      4, true),

  -- ---- Rose Hill Gardens (garden romantic, enthusiastic) ----
  ('22222222-2222-2222-2222-222222222204'::uuid, 'venue',     'How big is Rose Hill?',                               'We can host 180 guests for a seated dinner. The rose garden does ceremonies up to 200 — it''s magical.',                                                    ARRAY['capacity','garden','rose'],                  5, true),
  ('22222222-2222-2222-2222-222222222204'::uuid, 'venue',     'Are pets allowed?',                                   'Of course! Dogs love it here. We have water bowls and a shaded waiting area for ceremony day.',                                                              ARRAY['pets','dog','animals'],                      4, true),
  ('22222222-2222-2222-2222-222222222204'::uuid, 'catering',  'Do you have preferred caterers?',                     'A small list of caterers who know the kitchen well, but you''re welcome to bring your own. BYOB across the board for alcohol.',                              ARRAY['caterer','byob','preferred'],                5, true),
  ('22222222-2222-2222-2222-222222222204'::uuid, 'venue',     'Can we use the gardens for photos?',                  'Yes — every inch. The rose garden in late spring, the wisteria walk in early summer, the orchard in fall, the stone arches year-round.',                    ARRAY['photos','garden','photography'],            5, true),
  ('22222222-2222-2222-2222-222222222204'::uuid, 'pricing',   'What''s the base price?',                             'Saturday peak season is $9,500 venue fee. Friday/Sunday and off-peak are 25% less.',                                                                       ARRAY['pricing','rates'],                          5, true),
  ('22222222-2222-2222-2222-222222222204'::uuid, 'parking',   'Where do guests park?',                                'Grass lot for 60 cars near the entrance. Overflow available across the lane — coordinator will direct.',                                                    ARRAY['parking'],                                  3, true),
  ('22222222-2222-2222-2222-222222222204'::uuid, 'timeline',  'How early can vendors arrive?',                       'Vendors get access from 9am day-of. The full weekend rental adds Friday 3pm onwards.',                                                                      ARRAY['setup','timing','vendor'],                  3, true),
  ('22222222-2222-2222-2222-222222222204'::uuid, 'logistics', 'Is there a place to get ready?',                      'Yes — the Rose Cottage on the property has two suites. One opens onto the rose garden, the other onto the orchard.',                                       ARRAY['getting_ready','cottage','suite'],          4, true)
) AS v(venue_id, category, question, answer, keywords, priority, is_active)
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_base
   WHERE venue_id = v.venue_id AND question = v.question
);

-- ============================================================================
-- 2. PREFERRED VENDOR LIST
-- ============================================================================

INSERT INTO vendor_recommendations (venue_id, vendor_name, vendor_type, contact_email, contact_phone, website_url, description, is_preferred, sort_order)
SELECT * FROM (VALUES
  -- ---- Crestwood Farm ----
  ('22222222-2222-2222-2222-222222222202'::uuid, 'Hayloft Catering Co.',     'catering',     'hello@hayloftcatering.com',   '434-555-0287', 'https://hayloftcatering.com',     'Farm-to-table catering. Run by Sam, knows the Crestwood barn kitchen inside and out.',         true, 1),
  ('22222222-2222-2222-2222-222222222202'::uuid, 'Three Pines Florals',      'florals',      'amy@threepinesflorals.com',   '434-555-0312', 'https://threepinesflorals.com',   'Wildflower-leaning. Sources from local Charlottesville growers.',                              true, 2),
  ('22222222-2222-2222-2222-222222222202'::uuid, 'Sam DJ Co.',               'dj',           'bookings@samdjco.com',         '434-555-0145', 'https://samdjco.com',             'High-energy DJ who plays for the dancefloor. Brings own lighting.',                            true, 3),
  ('22222222-2222-2222-2222-222222222202'::uuid, 'Daisy Lane Photo',         'photography',  'hi@daisylanephoto.com',        '434-555-0188', 'https://daisylanephoto.com',      'Documentary-style. Half-day to full-weekend packages.',                                        true, 4),
  ('22222222-2222-2222-2222-222222222202'::uuid, 'Blue Ridge Transport',     'transportation','book@blueridgetransport.com','434-555-0277', 'https://blueridgetransport.com',  'Shuttles + classic cars. Knows the rural addresses around Charlottesville.',                   true, 5),

  -- ---- The Glass House ----
  ('22222222-2222-2222-2222-222222222203'::uuid, 'Atrium Florals',          'florals',      'info@atriumflorals.com',       '804-555-0344', 'https://atriumflorals.com',       'Modern, structural floral design. Specializes in installations for the atrium architecture.', true, 1),
  ('22222222-2222-2222-2222-222222222203'::uuid, 'Lumen DJ',                'dj',           'hello@lumendj.co',             '804-555-0298', 'https://lumendj.co',              'Curated, low-volume sets. Glass House recommends them for design-forward couples.',          true, 2),
  ('22222222-2222-2222-2222-222222222203'::uuid, 'Gareth Cole Photography',  'photography',  'gareth@garethcolephoto.com',  '804-555-0411', 'https://garethcolephoto.com',     'Editorial style. Fashion + architectural backgrounds work well at the Glass House.',          true, 3),
  ('22222222-2222-2222-2222-222222222203'::uuid, 'Cinematic Story Films',    'videography',  'info@cinematicstoryfilms.com','804-555-0152', 'https://cinematicstoryfilms.com', '8-minute highlight films. Knows the Glass House lighting setups.',                            true, 4),
  ('22222222-2222-2222-2222-222222222203'::uuid, 'Grand Touring Limos',      'transportation','book@grandtouringlimos.com','804-555-0177', 'https://grandtouringlimos.com',   'Black sedan + Sprinter van fleet. Reliable for Richmond venue logistics.',                    true, 5),

  -- ---- Rose Hill Gardens ----
  ('22222222-2222-2222-2222-222222222204'::uuid, 'Garden Lane Catering',     'catering',     'cook@gardenlanecatering.com',  '703-555-0322', 'https://gardenlanecatering.com',  'Seasonal menus. Big believers in herbs from the Rose Hill kitchen garden.',                   true, 1),
  ('22222222-2222-2222-2222-222222222204'::uuid, 'Wisteria & Vine',         'florals',      'orders@wisteriavine.com',      '703-555-0299', 'https://wisteriavine.com',        'English-garden style florals. Multiple Rose Hill weddings under their belt.',                 true, 2),
  ('22222222-2222-2222-2222-222222222204'::uuid, 'The Quartet',             'music',        'bookings@thequartet.live',     '703-555-0144', 'https://thequartet.live',         'String quartet for ceremonies + cocktail hour. Acoustic, garden-friendly setup.',             true, 3),
  ('22222222-2222-2222-2222-222222222204'::uuid, 'Honeycomb DJ',            'dj',           'hello@honeycombdj.com',        '703-555-0233', 'https://honeycombdj.com',         'Reception DJ with subtle lighting. Pairs well with The Quartet for ceremony+reception combo.', true, 4),
  ('22222222-2222-2222-2222-222222222204'::uuid, 'Rosa Bell Photography',    'photography',  'studio@rosabellphoto.com',     '703-555-0188', 'https://rosabellphoto.com',       'Soft natural-light style. Books the Rose Hill orchards regularly.',                            true, 5)
) AS v(venue_id, vendor_name, vendor_type, contact_email, contact_phone, website_url, description, is_preferred, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM vendor_recommendations
   WHERE venue_id = v.venue_id AND vendor_name = v.vendor_name
);

-- ============================================================================
-- 3. ACCOMMODATIONS (venue-scoped — recommended places to stay)
-- ============================================================================

INSERT INTO accommodations (venue_id, name, type, address, website_url, price_per_night, distance_miles, description, is_recommended, sort_order)
SELECT * FROM (VALUES
  -- ---- Crestwood Farm ----
  ('22222222-2222-2222-2222-222222222202'::uuid, 'The Farmhouse at Crestwood', 'inn',     'Crestwood Estate, on-site',     NULL,                                  395.00, 0.0,  '4 bedrooms on the property. First booking gets it.',                            true, 1),
  ('22222222-2222-2222-2222-222222222202'::uuid, 'Charlottesville Bayard Inn', 'boutique','410 Bayard St, Charlottesville', 'https://bayardinn.com',              225.00, 5.5,  'Small boutique inn. Block of 12 rooms held under "Crestwood weddings".',        true, 2),
  ('22222222-2222-2222-2222-222222222202'::uuid, 'Hampton Inn Charlottesville','hotel',   '900 W Main St, Charlottesville','https://hilton.com/en/hampton',     159.00, 6.2,  'Reliable, free breakfast, shuttle-friendly.',                                   true, 3),
  ('22222222-2222-2222-2222-222222222202'::uuid, 'Vineyard Cottage (Airbnb)', 'airbnb',   'Crestwood Vineyard',             'https://airbnb.com',                 285.00, 2.0,  'Sleeps 6. Wedding-party favourite for the Crestwood couples.',                  true, 4),

  -- ---- The Glass House ----
  ('22222222-2222-2222-2222-222222222203'::uuid, 'Quirk Hotel Richmond',       'boutique','201 W Broad St, Richmond',      'https://destinationhotels.com/quirk', 245.00, 0.4, 'Walk-able from the Glass House. Block of 30 rooms typically held.',             true, 1),
  ('22222222-2222-2222-2222-222222222203'::uuid, 'The Jefferson Hotel',        'hotel',   '101 W Franklin St, Richmond',  'https://jeffersonhotel.com',          425.00, 1.2, 'Five-star, historic. Splurge tier; great for parents-of-the-couple stays.',     true, 2),
  ('22222222-2222-2222-2222-222222222203'::uuid, 'Linden Row Inn',             'inn',     '100 E Franklin St, Richmond',  'https://lindenrowinn.com',            199.00, 0.9, 'Boutique. Smaller block, fills fast — book early.',                             true, 3),
  ('22222222-2222-2222-2222-222222222203'::uuid, 'Hilton Garden Inn Downtown', 'hotel',   '501 E Broad St, Richmond',     'https://hilton.com/en/hilton-garden', 179.00, 0.3, 'Closest budget-friendly option. Reliable.',                                     true, 4),

  -- ---- Rose Hill Gardens ----
  ('22222222-2222-2222-2222-222222222204'::uuid, 'Rose Cottage (on-site)',     'inn',     'Rose Hill Gardens, on-site',    NULL,                                  295.00, 0.0,  '2 suites in the on-site cottage. First wedding-party stays here.',              true, 1),
  ('22222222-2222-2222-2222-222222222204'::uuid, 'The Lansdowne Resort',       'hotel',   '44065 Woodridge Pkwy, Leesburg','https://lansdowneresort.com',         225.00, 4.8,  'Full-service resort. Block of 25 rooms typically held under Rose Hill events.', true, 2),
  ('22222222-2222-2222-2222-222222222204'::uuid, 'Goodstone Inn',              'boutique','36205 Snake Hill Rd, Middleburg','https://goodstone.com',              345.00, 8.5,  'Country-estate boutique. Splurge for parents, anniversary stays.',              true, 3),
  ('22222222-2222-2222-2222-222222222204'::uuid, 'Hampton Inn Leesburg',       'hotel',   '117 Fort Evans Rd NE, Leesburg','https://hilton.com/en/hampton',      149.00, 6.5,  'Budget-friendly. Free breakfast, shuttle works.',                              true, 4)
) AS v(venue_id, name, type, address, website_url, price_per_night, distance_miles, description, is_recommended, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM accommodations
   WHERE venue_id = v.venue_id AND name = v.name
);

-- ============================================================================
-- VERIFICATION
-- ============================================================================
DO $$
DECLARE
  v_id uuid;
  v_name text;
  c_kb int;
  c_vendors int;
  c_accom int;
BEGIN
  FOR v_id, v_name IN
    SELECT id, name FROM venues
     WHERE id IN (
       '22222222-2222-2222-2222-222222222202',
       '22222222-2222-2222-2222-222222222203',
       '22222222-2222-2222-2222-222222222204'
     )
  LOOP
    SELECT COUNT(*) INTO c_kb      FROM knowledge_base          WHERE venue_id = v_id;
    SELECT COUNT(*) INTO c_vendors FROM vendor_recommendations  WHERE venue_id = v_id;
    SELECT COUNT(*) INTO c_accom   FROM accommodations          WHERE venue_id = v_id;
    RAISE NOTICE '[demo-venues-fill] % — kb=% vendors=% accom=%', v_name, c_kb, c_vendors, c_accom;
  END LOOP;
END $$;
