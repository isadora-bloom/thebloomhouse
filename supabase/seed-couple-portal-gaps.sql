-- ============================================
-- SEED: Couple Portal Gaps
-- venue_id:   22222222-2222-2222-2222-222222222201
-- wedding_id: ab000000-0000-0000-0000-000000000001
-- Idempotent: safe to re-run
-- ============================================

BEGIN;

-- ---------------------------------------------------------------------------
-- SEED 5.1: Budget items
-- ---------------------------------------------------------------------------
-- Deduplicated by (venue_id, wedding_id, item_name). Photography row is
-- skipped here because an existing "Photography" item already exists for the
-- demo couple.
INSERT INTO budget_items (venue_id, wedding_id, category, item_name, budgeted, committed, paid, payment_source, vendor_name, notes, sort_order)
SELECT * FROM (VALUES
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Venue',          'Hawthorne Manor',      12500, 12500, 12500, NULL::text, 'Hawthorne Manor',       NULL::text, 1),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Catering',       'The Oak Table',        18000, 18000,  5000, NULL::text, 'The Oak Table',         NULL::text, 2),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Videography',    'Story Studios',         2800,  2800,     0, NULL::text, 'Story Studios',         NULL::text, 3),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Flowers',        'Wildflower & Co.',      3500,  3500,  1000, NULL::text, 'Wildflower & Co.',      NULL::text, 4),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Hair & Makeup',  'Blush & Brush',         1800,  1800,     0, NULL::text, 'Blush & Brush',         NULL::text, 5),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Music & DJ',     'Beats & Beats',         2200,  2200,   500, NULL::text, 'Beats & Beats',         NULL::text, 6),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Wedding Cake',   'The Sweet Occasion',     800,   800,     0, NULL::text, 'The Sweet Occasion',    NULL::text, 7),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Stationery',     'Minted',                 400,   400,     0, NULL::text, 'Minted',                NULL::text, 8),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Transportation', 'Blue Ridge Shuttle',     650,   650,     0, NULL::text, 'Blue Ridge Shuttle',    NULL::text, 9)
) AS v(venue_id, wedding_id, category, item_name, budgeted, committed, paid, payment_source, vendor_name, notes, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM budget_items b
  WHERE b.venue_id = v.venue_id
    AND b.wedding_id = v.wedding_id
    AND b.item_name = v.item_name
);

-- wedding_config: set total_budget = 50000
INSERT INTO wedding_config (venue_id, wedding_id, total_budget)
VALUES ('22222222-2222-2222-2222-222222222201', 'ab000000-0000-0000-0000-000000000001', 50000)
ON CONFLICT (venue_id, wedding_id)
DO UPDATE SET total_budget = EXCLUDED.total_budget, updated_at = now();

-- ---------------------------------------------------------------------------
-- SEED 5.2: Preferred vendors (vendor_recommendations)
-- ---------------------------------------------------------------------------
INSERT INTO vendor_recommendations (venue_id, vendor_name, vendor_type, contact_email, website_url, description, is_preferred, sort_order)
SELECT * FROM (VALUES
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Emma Clarke Photography',  'photography',    'emma@clarkephoto.com',            'clarkephoto.com'::text,     'Award-winning Charlottesville wedding photographer', true, 1),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Wildflower & Co.',         'florist',        'hello@wildflowerco.com',          'wildflowerco.com'::text,    'Garden-style florals and full-service installations', true, 2),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'The Oak Table Catering',   'caterer',        'info@oaktablecatering.com',       NULL::text,                  'Farm-to-table seasonal catering', true, 3),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Beats & Beats DJ',         'dj',             'bookings@beatsandbeatsdj.com',    NULL::text,                  'Wedding DJs with custom playlists', true, 4),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Blush & Brush Hair Studio','hair_makeup',    'blush@brushhair.com',             NULL::text,                  'Bridal hair and airbrush makeup', true, 5),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Rev. James Hartley',       'officiant',      'james@hartleyceremonies.com',     NULL::text,                  'Personalized ceremony officiant', true, 6),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Blue Ridge Shuttle Co.',   'transportation', 'dispatch@blueridgeshuttle.com',   NULL::text,                  'Wedding shuttle service', true, 7),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'The Sweet Occasion',       'cake',           'hello@thesweetoccasion.com',      NULL::text,                  'Custom wedding cakes and dessert tables', true, 8)
) AS v(venue_id, vendor_name, vendor_type, contact_email, website_url, description, is_preferred, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM vendor_recommendations vr
  WHERE vr.venue_id = v.venue_id
    AND vr.vendor_name = v.vendor_name
);

-- ---------------------------------------------------------------------------
-- SEED 5.3: Booked vendor for the demo couple
-- ---------------------------------------------------------------------------
INSERT INTO booked_vendors (venue_id, wedding_id, vendor_type, vendor_name, vendor_contact, notes, is_booked)
SELECT '22222222-2222-2222-2222-222222222201'::uuid,
       'ab000000-0000-0000-0000-000000000001'::uuid,
       'photography',
       'Emma Clarke Photography',
       'emma@clarkephoto.com 434-555-0192',
       'Second shooter included. Getting ready shots from 1pm.',
       true
WHERE NOT EXISTS (
  SELECT 1 FROM booked_vendors
  WHERE venue_id = '22222222-2222-2222-2222-222222222201'
    AND wedding_id = 'ab000000-0000-0000-0000-000000000001'
    AND vendor_name = 'Emma Clarke Photography'
);

-- ---------------------------------------------------------------------------
-- SEED 5.4: Sample contracts
-- ---------------------------------------------------------------------------
INSERT INTO contracts (venue_id, wedding_id, filename, file_url, status, vendor_name, created_at)
SELECT * FROM (VALUES
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Hawthorne Manor Venue Contract',  ''::text, 'signed',  'Hawthorne Manor'::text,        '2025-10-15'::timestamptz),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Emma Clarke Photography Contract',''::text, 'signed',  'Emma Clarke Photography'::text,'2025-11-02'::timestamptz),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'The Oak Table Catering Proposal', ''::text, 'pending', 'The Oak Table'::text,          '2026-01-20'::timestamptz)
) AS v(venue_id, wedding_id, filename, file_url, status, vendor_name, created_at)
WHERE NOT EXISTS (
  SELECT 1 FROM contracts c
  WHERE c.venue_id = v.venue_id
    AND c.wedding_id = v.wedding_id
    AND c.filename = v.filename
);

-- ---------------------------------------------------------------------------
-- SEED 5.5: Bedroom assignments
-- ---------------------------------------------------------------------------
INSERT INTO bedroom_assignments (venue_id, wedding_id, room_name, room_description, guests, notes)
SELECT * FROM (VALUES
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Bridal Suite',    'Private suite available from 10am',        ARRAY['Chloe Martinez'],                 NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Groom''s Suite',  'Adjacent to bridal suite',                 ARRAY['Ryan Brooks'],                    NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Garden Cottage',  'Standalone cottage with garden view',      ARRAY['Sophia Nguyen', 'Emma Chen'],     NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Oak Room',        'Main house, second floor',                 ARRAY['Sofia Martinez', 'Miguel Martinez'], NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Meadow Room',     'Main house, first floor',                  ARRAY['David Brooks', 'Karen Brooks'],   NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Loft Suite',      'Top floor with skylight',                  ARRAY['Jackson Davis'],                  NULL::text)
) AS v(venue_id, wedding_id, room_name, room_description, guests, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM bedroom_assignments b
  WHERE b.venue_id = v.venue_id
    AND b.wedding_id = v.wedding_id
    AND b.room_name = v.room_name
);

-- ---------------------------------------------------------------------------
-- SEED 5.6: Decor inventory
-- ---------------------------------------------------------------------------
-- category constraint: ('ceremony', 'reception', 'tables', 'entrance', 'other')
-- source   constraint: ('borrow', 'personal', 'vendor', 'diy')
INSERT INTO decor_inventory (venue_id, wedding_id, item_name, category, quantity, source, vendor_name, notes)
SELECT * FROM (VALUES
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Ceremony arch',               'ceremony',  1,   'vendor', NULL::text, NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Farm tables, 8ft',            'reception', 12,  'vendor', NULL::text, NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Cross-back chairs',           'reception', 200, 'vendor', NULL::text, NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'White linen napkins',         'reception', 200, 'vendor', NULL::text, NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Candelabras, tall',           'ceremony',  8,   'vendor', NULL::text, NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Bud vases, clear',            'reception', 40,  'vendor', NULL::text, NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Lanterns, black iron',        'other',     20,  'vendor', NULL::text, NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'String lights, 50ft strands', 'other',     10,  'vendor', NULL::text, NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Card box, wooden',            'reception', 1,   'vendor', NULL::text, NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Welcome sign frame, 36x48',   'entrance',  1,   'vendor', NULL::text, NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Cake table',                  'reception', 1,   'vendor', NULL::text, NULL::text),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'ab000000-0000-0000-0000-000000000001'::uuid, 'Sweetheart table',            'reception', 1,   'vendor', NULL::text, NULL::text)
) AS v(venue_id, wedding_id, item_name, category, quantity, source, vendor_name, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM decor_inventory d
  WHERE d.venue_id = v.venue_id
    AND d.wedding_id = v.wedding_id
    AND d.item_name = v.item_name
);

-- ---------------------------------------------------------------------------
-- SEED 5.7: Knowledge base entries for Sage
-- ---------------------------------------------------------------------------
INSERT INTO knowledge_base (venue_id, category, question, answer, keywords, priority, is_active)
SELECT * FROM (VALUES
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Capacity',       'What is the venue capacity?',                    'Hawthorne Manor accommodates up to 200 guests for a seated reception.',              ARRAY['capacity','guests','seated','max','size'],             10, true),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Logistics',      'Is there parking on site?',                      'Yes — free parking for up to 150 vehicles in the main lot plus overflow.',           ARRAY['parking','cars','lot','overflow'],                     9,  true),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Vendor Setup',   'What time can vendors arrive for setup?',         'Vendors may access the property from 9am on the wedding day.',                       ARRAY['vendor','setup','arrival','load-in','time'],           9,  true),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Catering',       'Do you have an in-house caterer?',                'We work with a preferred caterer list. Outside caterers are welcome with approval.', ARRAY['catering','caterer','food','preferred'],               8,  true),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Accessibility',  'Is the venue wheelchair accessible?',             'Yes — the ceremony lawn, reception barn, and restrooms are all accessible.',         ARRAY['accessible','wheelchair','ada','ramp'],                7,  true),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Weather',        'What happens if it rains?',                       'We have a full indoor ceremony backup space that accommodates the same guest count.',ARRAY['rain','weather','backup','indoor'],                    8,  true),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Bar',            'Can we bring our own alcohol?',                   'Yes, BYOB is permitted. We provide bartenders and glassware.',                       ARRAY['byob','alcohol','bar','drinks','bartender'],           8,  true),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Schedule',       'What time does the event need to end?',           'Music must end at 10pm. Guests depart by 11pm.',                                     ARRAY['end','time','curfew','music','departure'],             7,  true),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Bridal Suite',   'Is there a bridal suite?',                        'Yes — a private bridal suite is included in all bookings, available from 10am.',     ARRAY['bridal','suite','getting ready','bride'],              8,  true),
  ('22222222-2222-2222-2222-222222222201'::uuid, 'Rehearsal',      'Can we have a rehearsal at the venue?',           'Rehearsal is included the day before your wedding, typically 5-7pm.',                ARRAY['rehearsal','practice','day before','run-through'],     7,  true)
) AS v(venue_id, category, question, answer, keywords, priority, is_active)
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_base k
  WHERE k.venue_id = v.venue_id
    AND k.question = v.question
);

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification counts
-- ---------------------------------------------------------------------------
SELECT 'budget_items' AS table_name, count(*) AS n FROM budget_items WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001'
UNION ALL SELECT 'wedding_config',          count(*) FROM wedding_config          WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001'
UNION ALL SELECT 'vendor_recommendations',  count(*) FROM vendor_recommendations  WHERE venue_id   = '22222222-2222-2222-2222-222222222201'
UNION ALL SELECT 'booked_vendors',          count(*) FROM booked_vendors          WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001'
UNION ALL SELECT 'contracts',               count(*) FROM contracts               WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001'
UNION ALL SELECT 'bedroom_assignments',     count(*) FROM bedroom_assignments     WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001'
UNION ALL SELECT 'decor_inventory',         count(*) FROM decor_inventory         WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001'
UNION ALL SELECT 'knowledge_base',          count(*) FROM knowledge_base          WHERE venue_id   = '22222222-2222-2222-2222-222222222201';
