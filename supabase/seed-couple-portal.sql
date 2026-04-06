-- ============================================
-- COUPLE PORTAL SEED — Chloe & Ryan (Wedding 109)
-- ============================================
-- Run AFTER seed.sql and migrations 014-021.
-- Seeds all couple portal tables for demo/testing.
--
-- Venue: Hawthorne Manor (222...201)
-- Wedding: 444...000109 (May 30, 2026, booked)
-- ============================================

-- Reusable constants
-- VENUE_ID:   22222222-2222-2222-2222-222222222201
-- WEDDING_ID: 44444444-4444-4444-4444-444444000109

-- ============================================
-- 1. WEDDING DETAILS
-- ============================================
INSERT INTO wedding_details (
  id, venue_id, wedding_id,
  wedding_colors, partner1_social, partner2_social,
  dogs_coming, dogs_description,
  ceremony_location, arbor_choice, unity_table, ceremony_notes,
  seating_method, providing_table_numbers, providing_charger_plates,
  providing_champagne_glasses, providing_cake_cutter, providing_cake_topper,
  favors_description, reception_notes,
  send_off_type, send_off_notes
) VALUES (
  'e1000001-0000-0000-0000-000000000001',
  '22222222-2222-2222-2222-222222222201',
  '44444444-4444-4444-4444-444444000109',
  'Dusty rose, sage green, ivory',
  '@chloe.martinez',
  '@ryanbrooks_',
  true,
  'Golden retriever "Biscuit" — will be in ceremony only, friend picking up after',
  'outside',
  'Wooden arch with floral swag',
  true,
  'Unity candle ceremony. Grandma''s lace around the candle.',
  'Escort cards on a mirror with calligraphy',
  true,
  false,
  true,
  true,
  false,
  'Honey jars with custom labels ("Meant to Bee")',
  'Want to do a shoe game during dinner. DJ is aware.',
  'sparklers',
  'Grand sparkler exit — need 200 sparklers. DJ will announce.'
) ON CONFLICT (venue_id, wedding_id) DO NOTHING;

-- ============================================
-- 2. WEDDING TABLES (table layout + linens)
-- ============================================
INSERT INTO wedding_tables (
  id, venue_id, wedding_id,
  guest_count, table_shape, guests_per_table, rect_table_count,
  sweetheart_table, head_table, head_table_people, head_table_sided,
  kids_table, kids_count, cocktail_tables,
  linen_color, napkin_color, linen_venue_choice,
  runner_style, chargers,
  checkered_dance_floor, lounge_area,
  centerpiece_notes, layout_notes, linen_notes
) VALUES (
  'e2000001-0000-0000-0000-000000000001',
  '22222222-2222-2222-2222-222222222201',
  '44444444-4444-4444-4444-444444000109',
  148, 'round', 8, 0,
  true, false, 0, 'one',
  true, 6, 4,
  'Ivory', 'Dusty Rose', false,
  'greenery', true,
  false, true,
  'Low arrangements — roses, eucalyptus, and pampas grass. Bud vases on cocktail tables.',
  'Lounge area near cocktail tables with vintage furniture. Photo booth near bar.',
  'Floor-length ivory tablecloths. Dusty rose napkins folded in wine glass.'
) ON CONFLICT (venue_id, wedding_id) DO NOTHING;

-- ============================================
-- 3. BOOKED VENDORS
-- ============================================
INSERT INTO booked_vendors (id, venue_id, wedding_id, vendor_name, category, contact_name, contact_email, contact_phone, price, deposit_paid, deposit_amount, notes, sort_order) VALUES
  ('e3000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Hannah Kate Photography', 'Photographer', 'Hannah Siegel', 'hannah@hannahkate.com', '540-555-8801', 4200, true, 1000, '8 hours + second shooter. Engagement shoot completed.', 1),
  ('e3000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Ridge Run Films', 'Videographer', 'Marcus Lee', 'marcus@ridgerun.co', '540-555-8802', 3500, true, 800, 'Highlight reel + full ceremony edit. Drone shots.', 2),
  ('e3000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Blue Ridge Beats', 'DJ', 'Jamal Carter', 'jamal@blueridgebeats.com', '434-555-8803', 1800, true, 500, 'Ceremony + cocktail hour + reception. Has our timeline.', 3),
  ('e3000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Wildflower Catering', 'Caterer', 'Priya Sharma', 'priya@wildflowercatering.com', '540-555-8804', 8500, true, 2000, 'Plated dinner. Tasting scheduled April 15.', 4),
  ('e3000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Stems & Soil', 'Florist', 'Lily Chen', 'lily@stemsandsoil.com', '571-555-8805', 3200, true, 800, 'Bridal bouquet, 6 bridesmaid bouquets, ceremony arch, centerpieces, bouts.', 5),
  ('e3000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Sugar & Bloom Bakery', 'Cake', 'Amelia Torres', 'amelia@sugarbloom.com', '540-555-8806', 650, false, 0, '3-tier buttercream with fresh flowers. Vanilla + lemon layers.', 6),
  ('e3000001-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Glow Beauty Studio', 'Hair & Makeup', 'Tanya Rivera', 'tanya@glowbeauty.com', '202-555-8807', 1400, true, 350, 'Bride + 6 bridesmaids + MOB + MOG. Trial completed.', 7);

-- ============================================
-- 4. BUDGET ITEMS
-- ============================================
INSERT INTO budget_items (id, venue_id, wedding_id, category, item_name, budgeted, committed, paid, vendor_name, notes, sort_order) VALUES
  ('e4000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Venue', 'Venue rental', 8500, 8500, 4250, 'Hawthorne Manor', 'Balance due 2 weeks before', 1),
  ('e4000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Photography', 'Photography package', 4200, 4200, 1000, 'Hannah Kate Photography', '8hr + second shooter', 2),
  ('e4000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Videography', 'Videography package', 3500, 3500, 800, 'Ridge Run Films', 'Highlight + full ceremony', 3),
  ('e4000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Music', 'DJ services', 1800, 1800, 500, 'Blue Ridge Beats', 'Full day', 4),
  ('e4000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Catering', 'Dinner + cocktail hour', 8500, 8500, 2000, 'Wildflower Catering', 'Plated, 148 guests', 5),
  ('e4000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Flowers', 'Floral package', 3200, 3200, 800, 'Stems & Soil', 'Ceremony + reception', 6),
  ('e4000001-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Cake', 'Wedding cake', 650, 650, 0, 'Sugar & Bloom Bakery', '3-tier buttercream', 7),
  ('e4000001-0000-0000-0000-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Beauty', 'Hair & makeup', 1400, 1400, 350, 'Glow Beauty Studio', 'Bride + 8 people', 8),
  ('e4000001-0000-0000-0000-000000000009', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Attire', 'Wedding dress', 2800, 2800, 2800, NULL, 'Maggie Sottero, alterations done', 9),
  ('e4000001-0000-0000-0000-000000000010', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Attire', 'Groom suit + groomsmen', 1200, 1200, 600, NULL, 'Generation Tux rentals', 10),
  ('e4000001-0000-0000-0000-000000000011', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Stationery', 'Invitations + signage', 600, 600, 600, NULL, 'Minted.com', 11),
  ('e4000001-0000-0000-0000-000000000012', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Rentals', 'Lounge furniture + extras', 900, 900, 0, 'Paisley & Jade', 'Vintage couch set + side tables', 12),
  ('e4000001-0000-0000-0000-000000000013', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Favors', 'Honey jar favors', 250, 250, 250, NULL, '200 jars + custom labels', 13),
  ('e4000001-0000-0000-0000-000000000014', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'Other', 'Tips & gratuities', 1500, 0, 0, NULL, 'Cash envelopes day-of', 14);

-- ============================================
-- 5. BUDGET PAYMENTS
-- ============================================
INSERT INTO budget_payments (id, budget_item_id, venue_id, wedding_id, amount, payment_date, payment_method, notes) VALUES
  ('e5000001-0000-0000-0000-000000000001', 'e4000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 4250, '2025-12-01', 'check', 'Deposit — 50%'),
  ('e5000001-0000-0000-0000-000000000002', 'e4000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 1000, '2025-11-15', 'credit_card', 'Retainer'),
  ('e5000001-0000-0000-0000-000000000003', 'e4000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 2000, '2026-01-10', 'credit_card', 'Deposit'),
  ('e5000001-0000-0000-0000-000000000004', 'e4000001-0000-0000-0000-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 350, '2026-02-01', 'venmo', 'Deposit'),
  ('e5000001-0000-0000-0000-000000000005', 'e4000001-0000-0000-0000-000000000009', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 2800, '2026-01-20', 'credit_card', 'Paid in full'),
  ('e5000001-0000-0000-0000-000000000006', 'e4000001-0000-0000-0000-000000000011', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 600, '2026-02-15', 'credit_card', 'Paid in full'),
  ('e5000001-0000-0000-0000-000000000007', 'e4000001-0000-0000-0000-000000000013', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 250, '2026-03-01', 'credit_card', 'Paid in full');

-- ============================================
-- 6. WEDDING CONFIG
-- ============================================
INSERT INTO wedding_config (
  id, venue_id, wedding_id,
  total_budget, budget_shared, plated_meal, custom_categories
) VALUES (
  'e6000001-0000-0000-0000-000000000001',
  '22222222-2222-2222-2222-222222222201',
  '44444444-4444-4444-4444-444444000109',
  40000, true, true,
  '["Favors", "Rentals", "Stationery"]'::jsonb
) ON CONFLICT (venue_id, wedding_id) DO NOTHING;

-- ============================================
-- 7. WEDDING TIMELINE
-- ============================================
INSERT INTO wedding_timeline (
  id, venue_id, wedding_id,
  ceremony_start, reception_end, notes,
  timeline_data
) VALUES (
  'e7000001-0000-0000-0000-000000000001',
  '22222222-2222-2222-2222-222222222201',
  '44444444-4444-4444-4444-444444000109',
  '16:30', '23:00',
  'First look at 3:00 PM by the garden gazebo. Sunset is ~8:15 PM.',
  '{
    "events": [
      {"time": "12:00", "title": "Hair & Makeup begins", "category": "prep", "notes": "Bridal suite"},
      {"time": "14:00", "title": "Photographer arrives", "category": "vendor", "notes": "Detail shots first"},
      {"time": "15:00", "title": "First Look", "category": "ceremony", "notes": "Garden gazebo"},
      {"time": "15:30", "title": "Wedding party photos", "category": "photos", "notes": "30 min"},
      {"time": "16:00", "title": "Family photos", "category": "photos", "notes": "Both families, 20 min"},
      {"time": "16:15", "title": "Guests arrive", "category": "guests", "notes": "Ushers in place"},
      {"time": "16:30", "title": "Ceremony begins", "category": "ceremony", "notes": "Processional music starts"},
      {"time": "17:00", "title": "Ceremony ends", "category": "ceremony", "notes": "Recessional"},
      {"time": "17:15", "title": "Cocktail hour", "category": "reception", "notes": "Lawn games available"},
      {"time": "18:15", "title": "Grand entrance", "category": "reception", "notes": "DJ announces couple"},
      {"time": "18:30", "title": "First dance", "category": "reception", "notes": "\"At Last\" by Etta James"},
      {"time": "18:40", "title": "Toasts", "category": "reception", "notes": "MOH then Best Man"},
      {"time": "19:00", "title": "Dinner served", "category": "reception", "notes": "Plated, 3 courses"},
      {"time": "19:15", "title": "Parent dances", "category": "reception", "notes": "During dinner service"},
      {"time": "20:00", "title": "Cake cutting", "category": "reception", "notes": "Sugar & Bloom 3-tier"},
      {"time": "20:15", "title": "Open dancing", "category": "reception", "notes": "Shoe game at 20:45"},
      {"time": "22:30", "title": "Last dance", "category": "reception", "notes": "\"Forever Young\""},
      {"time": "22:45", "title": "Sparkler exit", "category": "send_off", "notes": "200 sparklers ready"},
      {"time": "23:00", "title": "Event ends", "category": "logistics", "notes": "Vendors out by midnight"}
    ]
  }'::jsonb
) ON CONFLICT (venue_id, wedding_id) DO NOTHING;

-- ============================================
-- 8. RSVP CONFIG
-- ============================================
INSERT INTO rsvp_config (
  id, venue_id, wedding_id,
  rsvp_deadline, meal_selection, dietary_field,
  plus_one_field, song_request_field,
  custom_questions
) VALUES (
  'e8000001-0000-0000-0000-000000000001',
  '22222222-2222-2222-2222-222222222201',
  '44444444-4444-4444-4444-444444000109',
  '2026-04-30',
  true,
  true,
  true,
  true,
  '[{"question": "Will you be joining us for the Friday rehearsal dinner?", "type": "yes_no"}, {"question": "Any accessibility needs we should know about?", "type": "text"}]'::jsonb
) ON CONFLICT (venue_id, wedding_id) DO NOTHING;

-- ============================================
-- 9. RSVP RESPONSES (sample)
-- ============================================
INSERT INTO rsvp_responses (id, venue_id, wedding_id, guest_id, attending, meal_choice, dietary_notes, plus_one_attending, plus_one_name, plus_one_meal, song_request, custom_answers, submitted_at) VALUES
  ('e9000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'c8000001-0000-0000-0000-000000000001', true, 'Beef tenderloin', NULL, true, 'Jordan Ellis', 'Herb chicken', 'Don''t Stop Believin''', '{"rehearsal_dinner": "yes", "accessibility": ""}'::jsonb, '2026-03-15 14:22:00+00'),
  ('e9000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'c8000001-0000-0000-0000-000000000002', true, 'Herb chicken', 'Gluten-free', false, NULL, NULL, NULL, '{"rehearsal_dinner": "no", "accessibility": ""}'::jsonb, '2026-03-18 09:45:00+00'),
  ('e9000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'c8000001-0000-0000-0000-000000000003', false, NULL, NULL, false, NULL, NULL, NULL, '{}'::jsonb, '2026-03-20 17:30:00+00'),
  ('e9000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'c8000001-0000-0000-0000-000000000004', true, 'Vegetarian risotto', 'Vegetarian', true, 'Sam Park', 'Beef tenderloin', 'September by Earth Wind & Fire', '{"rehearsal_dinner": "yes", "accessibility": ""}'::jsonb, '2026-03-22 11:00:00+00');

-- ============================================
-- 10. COUPLE BUDGET (summary)
-- ============================================
INSERT INTO couple_budget (
  id, venue_id, wedding_id,
  total_budget, total_committed, total_paid,
  categories
) VALUES (
  'ea000001-0000-0000-0000-000000000001',
  '22222222-2222-2222-2222-222222222201',
  '44444444-4444-4444-4444-444444000109',
  40000, 39000, 14200,
  '{
    "Venue": {"budgeted": 8500, "committed": 8500, "paid": 4250},
    "Photography": {"budgeted": 4200, "committed": 4200, "paid": 1000},
    "Videography": {"budgeted": 3500, "committed": 3500, "paid": 800},
    "Music": {"budgeted": 1800, "committed": 1800, "paid": 500},
    "Catering": {"budgeted": 8500, "committed": 8500, "paid": 2000},
    "Flowers": {"budgeted": 3200, "committed": 3200, "paid": 800},
    "Cake": {"budgeted": 650, "committed": 650, "paid": 0},
    "Beauty": {"budgeted": 1400, "committed": 1400, "paid": 350},
    "Attire": {"budgeted": 4000, "committed": 4000, "paid": 3400},
    "Stationery": {"budgeted": 600, "committed": 600, "paid": 600},
    "Rentals": {"budgeted": 900, "committed": 900, "paid": 0},
    "Favors": {"budgeted": 250, "committed": 250, "paid": 250},
    "Other": {"budgeted": 2500, "committed": 0, "paid": 0}
  }'::jsonb
) ON CONFLICT (venue_id, wedding_id) DO NOTHING;

-- ============================================
-- 11. NOTIFICATIONS (sample coordinator notifications)
-- ============================================
INSERT INTO notifications (id, venue_id, user_id, type, title, body, read, created_at) VALUES
  ('eb000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', 'rsvp', 'New RSVP received', 'Guest #1 (c8000001) RSVPed yes with +1', false, '2026-03-15 14:22:00+00'),
  ('eb000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', 'rsvp', 'New RSVP received', 'Guest #2 (c8000002) RSVPed yes, gluten-free', false, '2026-03-18 09:45:00+00'),
  ('eb000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', 'rsvp', 'RSVP decline', 'Guest #3 (c8000003) RSVPed no', true, '2026-03-20 17:30:00+00'),
  ('eb000001-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', 'contract', 'Contract uploaded', 'Wildflower Catering contract uploaded by Chloe', true, '2026-02-20 10:00:00+00'),
  ('eb000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', 'timeline', 'Timeline updated', 'Chloe updated the day-of timeline (added sparkler exit)', false, '2026-03-28 16:00:00+00'),
  ('eb000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', 'budget', 'Payment recorded', 'Chloe recorded $2,000 payment to Wildflower Catering', true, '2026-01-10 12:00:00+00');

-- ============================================
-- 12. VENUE CONFIG — add feature_flags for couple portal testing
-- ============================================
UPDATE venue_config SET feature_flags = jsonb_set(
  COALESCE(feature_flags, '{}'),
  '{checklist_template}',
  '{
    "tasks": [
      {"id": "t1", "task_text": "Set your budget", "category": "Venue", "due_offset": "12m", "description": "", "is_custom": false, "included": true},
      {"id": "t2", "task_text": "Complete alignment worksheets", "category": "Venue", "due_offset": "11m", "description": "", "is_custom": false, "included": true},
      {"id": "t3", "task_text": "Book photographer", "category": "Vendors", "due_offset": "10m", "description": "", "is_custom": false, "included": true},
      {"id": "t4", "task_text": "Book videographer", "category": "Vendors", "due_offset": "10m", "description": "", "is_custom": false, "included": true},
      {"id": "t5", "task_text": "Book DJ or band", "category": "Vendors", "due_offset": "9m", "description": "", "is_custom": false, "included": true},
      {"id": "t6", "task_text": "Book hair & makeup", "category": "Vendors", "due_offset": "8m", "description": "", "is_custom": false, "included": true},
      {"id": "t7", "task_text": "Book officiant", "category": "Vendors", "due_offset": "8m", "description": "", "is_custom": false, "included": true},
      {"id": "t8", "task_text": "Choose caterer and finalize menu", "category": "Vendors", "due_offset": "7m", "description": "Hawthorne Manor is BYOB — your caterer handles everything food.", "is_custom": false, "included": true},
      {"id": "t9", "task_text": "Hire florist", "category": "Vendors", "due_offset": "8m", "description": "", "is_custom": false, "included": true},
      {"id": "t10", "task_text": "Schedule engagement photos", "category": "Vendors", "due_offset": "7m", "description": "", "is_custom": false, "included": true},
      {"id": "t11", "task_text": "Submit proof of insurance for caterer", "category": "Venue", "due_offset": "2m", "description": "Required by Hawthorne Manor for all outside vendors.", "is_custom": true, "included": true},
      {"id": "t12", "task_text": "Find wedding dress/attire", "category": "Attire & Beauty", "due_offset": "9m", "description": "", "is_custom": false, "included": true},
      {"id": "t13", "task_text": "Send save-the-dates", "category": "Guests", "due_offset": "8m", "description": "", "is_custom": false, "included": true},
      {"id": "t14", "task_text": "Send invitations", "category": "Guests", "due_offset": "2m", "description": "", "is_custom": false, "included": true},
      {"id": "t15", "task_text": "Build day-of timeline", "category": "Timeline", "due_offset": "2m", "description": "", "is_custom": false, "included": true},
      {"id": "t16", "task_text": "Confirm all vendor arrival times", "category": "Vendors", "due_offset": "2w", "description": "", "is_custom": false, "included": true},
      {"id": "t17", "task_text": "Finalize seating chart", "category": "Guests", "due_offset": "2w", "description": "", "is_custom": false, "included": true},
      {"id": "t18", "task_text": "Prepare day-of emergency kit", "category": "Other", "due_offset": "1w", "description": "", "is_custom": false, "included": true},
      {"id": "t19", "task_text": "Write vows", "category": "Other", "due_offset": "1w", "description": "", "is_custom": false, "included": true},
      {"id": "t20", "task_text": "Schedule final walkthrough at Hawthorne Manor", "category": "Venue", "due_offset": "2w", "description": "Walk the ceremony + reception spaces with Sarah.", "is_custom": true, "included": true}
    ],
    "custom_categories": []
  }'::jsonb
)
WHERE venue_id = '22222222-2222-2222-2222-222222222201';

-- Also add decor_config with venue spaces
UPDATE venue_config SET feature_flags = jsonb_set(
  COALESCE(feature_flags, '{}'),
  '{decor_config}',
  '{
    "venue_spaces": ["Round Guest Tables", "Long Farm Tables", "Head Table", "Sweetheart Table", "Cocktail Tables", "Ceremony Arch", "Card & Gift Table", "Cake Table", "Dessert Table", "Bar Area", "Photo Booth", "Lounge Area", "Porch & Steps"],
    "venue_provides": ["Ceremony chairs (200)", "Reception tables (20 round)", "Farm tables (4)", "Cocktail tables (6)", "Basic linens"],
    "restrictions": {
      "no_confetti": true,
      "no_glitter": true,
      "no_open_flame": false,
      "no_nails_walls": true,
      "no_rice": true,
      "no_tape_on_walls": true
    },
    "custom_restrictions": ["No hanging anything from the chandeliers", "Candles must be in hurricane glass"],
    "decor_notes": "We love creative couples! Just check with Sarah before hanging anything or attaching to walls. Battery-operated candles are always welcome."
  }'::jsonb
)
WHERE venue_id = '22222222-2222-2222-2222-222222222201';

-- Add bar_config
UPDATE venue_config SET feature_flags = jsonb_set(
  COALESCE(feature_flags, '{}'),
  '{bar_config}',
  '{
    "default_bar_type": "beer-wine",
    "default_guest_count": 150,
    "notes": "Hawthorne Manor is BYOB. We provide the bar setup, glassware, and ice. You supply all beverages. ABC license required for anything over beer & wine."
  }'::jsonb
)
WHERE venue_id = '22222222-2222-2222-2222-222222222201';
