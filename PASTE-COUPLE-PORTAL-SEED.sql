
-- ============================================================================
-- ▶ seed-couple-portal.sql
-- ============================================================================
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
-- 7. WEDDING TIMELINE — REMOVED
-- ============================================
-- Migration 076_consolidate_wedding_timeline.sql dropped the
-- wedding_timeline table. ceremony_start / reception_end now live as
-- columns on the parent weddings row, and the per-event list lives in
-- the canonical `timeline` table (seeded above by seed.sql / a
-- subsequent seed file). The previous INSERT here would error on a
-- fresh deploy because the table no longer exists. Leaving the section
-- header for git-blame readability.

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
-- 10. COUPLE BUDGET — REMOVED
-- 11. NOTIFICATIONS — REMOVED
-- ============================================
-- Migration 101 dropped both legacy tables. Their replacements:
--   * couple_budget   → budget_items (already seeded above)
--   * notifications   → admin_notifications (written by services
--                       at runtime — pipeline auto-send prompts,
--                       booking-confirmation prompts, source-
--                       backtrace alerts, etc.)

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

-- ============================================================================
-- ▶ seed-couple-portal-gaps.sql
-- ============================================================================
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

-- ============================================================================
-- ▶ seed-couple-names.sql
-- ============================================================================
-- Backfill realistic couple names for every demo wedding that doesn't have linked
-- people records yet, then point orphaned interactions at the partner1 person.
--
-- Idempotent: skips weddings that already have people, only touches interactions
-- whose person_id is still NULL.

-- ---------------------------------------------------------------------------
-- Task B: Backfill people (partner1 + partner2) for every unnamed demo wedding
-- ---------------------------------------------------------------------------
WITH unnamed_weddings AS (
  SELECT
    w.id,
    w.venue_id,
    ROW_NUMBER() OVER (ORDER BY w.created_at, w.id) AS rn
  FROM weddings w
  WHERE w.venue_id::text LIKE '22222222%'
    AND NOT EXISTS (SELECT 1 FROM people p WHERE p.wedding_id = w.id)
),
name_pool(rn, p1_first, p1_last, p2_first, p2_last) AS (
  VALUES
    (1,  'Sophie',   'Whitfield',  'James',     'Whitfield'),
    (2,  'Amara',    'Osei',       'Daniel',    'Osei'),
    (3,  'Claire',   'Henderson',  'Tom',       'Henderson'),
    (4,  'Priya',    'Mehta',      'Rajan',     'Mehta'),
    (5,  'Lucy',     'Grant',      'Oliver',    'Grant'),
    (6,  'Hannah',   'Webb',       'Marcus',    'Webb'),
    (7,  'Zoe',      'Flynn',      'Patrick',   'Flynn'),
    (8,  'Natalie',  'Sorensen',   'Chris',     'Sorensen'),
    (9,  'Isabel',   'Carver',     'Ben',       'Carver'),
    (10, 'Megan',    'Thornton',   'Jack',      'Thornton'),
    (11, 'Rachel',   'Kim',        'David',     'Kim'),
    (12, 'Emma',     'Foster',     'Liam',      'Foster'),
    (13, 'Chloe',    'Ashford',    'Sam',       'Ashford'),
    (14, 'Grace',    'Bennett',    'Noah',      'Bennett'),
    (15, 'Ava',      'Cole',       'Ethan',     'Cole'),
    (16, 'Lauren',   'Davenport',  'Will',      'Davenport'),
    (17, 'Mia',      'Park',       'Ryan',      'Park'),
    (18, 'Ella',     'Turner',     'Alex',      'Turner'),
    (19, 'Olivia',   'Sinclair',   'Matt',      'Sinclair'),
    (20, 'Sophia',   'Monroe',     'Jake',      'Monroe'),
    (21, 'Aaliyah',  'Brooks',     'Jordan',    'Brooks'),
    (22, 'Maya',     'Russo',      'Nico',      'Russo'),
    (23, 'Bella',    'Voss',       'Theo',      'Voss'),
    (24, 'Ines',     'Ortega',     'Felipe',    'Ortega'),
    (25, 'Hazel',    'Bryant',     'Wyatt',     'Bryant'),
    (26, 'Iris',     'Park',       'Ezra',      'Park'),
    (27, 'Juno',     'Reyes',      'Calvin',    'Reyes'),
    (28, 'Talia',    'Greene',     'Sebastian', 'Greene'),
    (29, 'Mira',     'Klein',      'Adrian',    'Klein'),
    (30, 'Esme',     'Wells',      'Caleb',     'Wells')
)
INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name, email)
SELECT
  gen_random_uuid(),
  uw.venue_id,
  uw.id,
  'partner1',
  np.p1_first,
  np.p1_last,
  lower(np.p1_first || '.' || np.p1_last || '@email.com')
FROM unnamed_weddings uw
JOIN name_pool np ON np.rn = ((uw.rn - 1) % 30) + 1
UNION ALL
SELECT
  gen_random_uuid(),
  uw.venue_id,
  uw.id,
  'partner2',
  np.p2_first,
  np.p2_last,
  lower(np.p2_first || '.' || np.p2_last || '@email.com')
FROM unnamed_weddings uw
JOIN name_pool np ON np.rn = ((uw.rn - 1) % 30) + 1;

-- ---------------------------------------------------------------------------
-- Task C: Wire orphaned interactions to the wedding's partner1
-- ---------------------------------------------------------------------------
UPDATE interactions i
SET person_id = (
  SELECT id FROM people
  WHERE wedding_id = i.wedding_id AND role = 'partner1'
  LIMIT 1
)
WHERE person_id IS NULL
  AND wedding_id IS NOT NULL
  AND venue_id::text LIKE '22222222%';
