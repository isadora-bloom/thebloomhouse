-- ============================================
-- 012: Add 'rule' to voice_preferences preference_type
-- Allows storing venue rules (always/never/when-then) alongside
-- banned phrases, approved phrases, and voice dimensions.
-- ============================================

ALTER TABLE voice_preferences
  DROP CONSTRAINT voice_preferences_preference_type_check;

ALTER TABLE voice_preferences
  ADD CONSTRAINT voice_preferences_preference_type_check
  CHECK (preference_type IN ('banned_phrase', 'approved_phrase', 'dimension', 'rule'));
-- Portal Section Configuration
-- Controls which sections couples can see, which are admin-only, and which are off
CREATE TABLE IF NOT EXISTS portal_section_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  section_key text NOT NULL,
  label text NOT NULL,
  description text,
  visibility text NOT NULL DEFAULT 'both' CHECK (visibility IN ('admin_only', 'both', 'off')),
  sort_order integer DEFAULT 0,
  icon text, -- lucide icon name
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, section_key)
);

CREATE INDEX IF NOT EXISTS idx_portal_section_config_venue ON portal_section_config(venue_id);
-- ============================================
-- PORTAL SECTION CONFIG — DEFAULT SECTIONS
-- ============================================
-- Seeds 32 sections per venue for all 4 Crestwood Collection venues.
-- Uses ON CONFLICT DO NOTHING so re-running is safe.

DO $$
DECLARE
  v_id uuid;
  venue_ids uuid[] := ARRAY[
    '22222222-2222-2222-2222-222222222201'::uuid,
    '22222222-2222-2222-2222-222222222202'::uuid,
    '22222222-2222-2222-2222-222222222203'::uuid,
    '22222222-2222-2222-2222-222222222204'::uuid
  ];
  v_idx integer;
BEGIN
  FOR v_idx IN 1..array_length(venue_ids, 1) LOOP
    v_id := venue_ids[v_idx];

    INSERT INTO portal_section_config (id, venue_id, section_key, label, description, visibility, sort_order, icon) VALUES
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000001', v_id, 'dashboard',        'Dashboard',              'Overview of wedding progress and key dates',          'both',       1,  'LayoutDashboard'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000002', v_id, 'getting-started',   'Getting Started',        'Welcome guide and first steps for your planning',     'both',       2,  'Rocket'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000003', v_id, 'chat',              'Chat with Sage',         'Talk to your AI wedding planning assistant',          'both',       3,  'MessageCircle'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000004', v_id, 'wedding-details',   'Wedding Details',        'Core wedding info — date, colors, theme',             'both',       4,  'Heart'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000005', v_id, 'timeline',          'Timeline',               'Wedding day schedule and planning milestones',        'both',       5,  'Clock'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000006', v_id, 'budget',            'Budget',                 'Track estimated vs actual costs',                     'both',       6,  'DollarSign'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000007', v_id, 'guests',            'Guest List & RSVP',      'Manage guest list, meal choices, and RSVPs',          'both',       7,  'Users'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000008', v_id, 'seating',           'Seating Chart',          'Assign guests to tables and manage layout',           'both',       8,  'Armchair'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000009', v_id, 'checklist',         'Planning Checklist',     'Track tasks and milestones',                          'both',       9,  'CheckSquare'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000010', v_id, 'vendors',           'Vendors & Contracts',    'Preferred vendors, contacts, and contracts',          'both',       10, 'Store'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000011', v_id, 'ceremony',          'Ceremony Order',         'Processional, readings, vows, and recessional',       'both',       11, 'BookOpen'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000012', v_id, 'party',             'Wedding Party',          'Bridal party, groomsmen, and roles',                  'both',       12, 'UsersRound'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000013', v_id, 'beauty',            'Hair & Makeup',          'Beauty appointments and schedule',                    'both',       13, 'Sparkles'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000014', v_id, 'transportation',    'Transportation',         'Shuttles, limos, and parking logistics',              'both',       14, 'Car'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000015', v_id, 'rooms',             'Room Assignments',       'Internal room and space assignments',                 'admin_only', 15, 'DoorOpen'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000016', v_id, 'rehearsal',         'Rehearsal Dinner',       'Rehearsal dinner details and attendees',               'both',       16, 'UtensilsCrossed'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000017', v_id, 'decor',             'Decor Inventory',        'Track decor items, rentals, and setup notes',         'both',       17, 'Flower2'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000018', v_id, 'staffing',          'Staffing',               'Internal staffing assignments and schedules',         'admin_only', 18, 'HardHat'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000019', v_id, 'bar',               'Bar Planning',           'Drink menu, quantities, and bar setup',               'both',       19, 'Wine'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000020', v_id, 'allergies',         'Allergy Registry',       'Dietary restrictions and allergy tracking',           'both',       20, 'ShieldAlert'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000021', v_id, 'guest-care',        'Guest Care Notes',       'Internal notes about guest accommodations and needs', 'admin_only', 21, 'HeartHandshake'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000022', v_id, 'inspo',             'Inspiration Gallery',    'Mood boards and design inspiration',                  'both',       22, 'Lightbulb'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000023', v_id, 'photos',            'Photo Library',          'Upload and organize wedding photos',                  'both',       23, 'Camera'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000024', v_id, 'worksheets',        'Planning Worksheets',    'Printable worksheets and planning templates',         'both',       24, 'FileText'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000025', v_id, 'venue-inventory',   'Venue Inventory',        'What the venue provides — tables, linens, etc.',      'both',       25, 'Package'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000026', v_id, 'stays',             'Accommodations',         'On-site and nearby lodging options',                  'both',       26, 'Bed'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000027', v_id, 'website',           'Wedding Website',        'Build and customize your wedding website',            'both',       27, 'Globe'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000028', v_id, 'final-review',      'Final Review',           'Pre-wedding final walkthrough and confirmations',     'both',       28, 'ClipboardCheck'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000029', v_id, 'messages',          'Direct Messages',        'Message your coordinator directly',                   'both',       29, 'MessagesSquare'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000030', v_id, 'couple-photo',      'Couple Photo',           'Upload your couple photo for the portal',             'both',       30, 'ImagePlus'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000031', v_id, 'resources',         'Resources & Downloads',  'Downloadable guides, checklists, and documents',      'both',       31, 'Download'),
      ('ffff' || lpad(v_idx::text, 4, '0') || '-0000-0000-0000-000000000032', v_id, 'booking',           'Book a Meeting',         'Schedule a call or tour with your coordinator',       'both',       32, 'CalendarPlus')
    ON CONFLICT (venue_id, section_key) DO NOTHING;

  END LOOP;
END $$;
-- ============================================
-- EXPANDED TEAM + 6 MONTHS CONSULTANT METRICS
-- ============================================
-- Adds more team members across venues and fills
-- consultant_metrics with Oct 2025 → Mar 2026 data.
-- Safe to re-run (ON CONFLICT DO NOTHING).
-- ============================================

-- ============================================
-- 1. ADDITIONAL TEAM MEMBERS
-- ============================================
-- We need auth.users entries for RLS (even though RLS is disabled for demo,
-- the FK constraint requires them). Insert into auth.users first.

INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at, instance_id, aud, role)
VALUES
  ('33333333-3333-3333-3333-333333333305', 'grace@rixeymanor.com', '{"first_name":"Grace","last_name":"Kim"}', now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333306', 'ben@rixeymanor.com', '{"first_name":"Ben","last_name":"Torres"}', now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333307', 'lena@crestwoodfarm.com', '{"first_name":"Lena","last_name":"Hart"}', now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333308', 'marcus@theglasshouse.com', '{"first_name":"Marcus","last_name":"Rivera"}', now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333309', 'emma@rosehillgardens.com', '{"first_name":"Emma","last_name":"Walsh"}', now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
ON CONFLICT (id) DO NOTHING;

-- Now add their profiles
INSERT INTO user_profiles (id, venue_id, org_id, role, first_name, last_name) VALUES
  -- Rixey Manor — 2 more staff
  ('33333333-3333-3333-3333-333333333305', '22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Grace', 'Kim'),
  ('33333333-3333-3333-3333-333333333306', '22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Ben', 'Torres'),
  -- Crestwood Farm — 1 more
  ('33333333-3333-3333-3333-333333333307', '22222222-2222-2222-2222-222222222202', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Lena', 'Hart'),
  -- Glass House — 1 more
  ('33333333-3333-3333-3333-333333333308', '22222222-2222-2222-2222-222222222203', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Marcus', 'Rivera'),
  -- Rose Hill — 1 more
  ('33333333-3333-3333-3333-333333333309', '22222222-2222-2222-2222-222222222204', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Emma', 'Walsh')
ON CONFLICT (id) DO NOTHING;


-- ============================================
-- 2. CONSULTANT METRICS — 6 MONTHS PER PERSON
-- ============================================
-- Oct 2025 through Mar 2026 for all 9 team members.
-- Realistic patterns: seasonal dip in winter, ramp in spring.
-- Each person has a distinct performance profile.

INSERT INTO consultant_metrics (id, venue_id, consultant_id, period_start, period_end, inquiries_handled, tours_booked, bookings_closed, conversion_rate, avg_response_time_minutes, avg_booking_value) VALUES

  -- ══════════════════════════════════════════════
  -- RIXEY MANOR — Sarah Chen (venue manager, top performer)
  -- ══════════════════════════════════════════════
  ('c0000002-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', '2025-10-01', '2025-10-31', 8, 6, 4, 0.50, 45, 15200),
  ('c0000002-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', '2025-11-01', '2025-11-30', 6, 4, 3, 0.50, 52, 14800),
  ('c0000002-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', '2025-12-01', '2025-12-31', 3, 2, 1, 0.33, 78, 16000),

  -- ══════════════════════════════════════════════
  -- RIXEY MANOR — Grace Kim (coordinator, newer, still learning)
  -- ══════════════════════════════════════════════
  ('c0000002-0002-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333305', '2025-10-01', '2025-10-31', 4, 2, 1, 0.25, 120, 12500),
  ('c0000002-0002-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333305', '2025-11-01', '2025-11-30', 5, 3, 1, 0.20, 105, 13000),
  ('c0000002-0002-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333305', '2025-12-01', '2025-12-31', 2, 1, 1, 0.50, 95, 11800),
  ('c0000002-0002-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333305', '2026-01-01', '2026-01-31', 6, 4, 2, 0.33, 88, 14200),
  ('c0000002-0002-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333305', '2026-02-01', '2026-02-28', 5, 3, 2, 0.40, 75, 13800),
  ('c0000002-0002-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333305', '2026-03-01', '2026-03-28', 7, 5, 3, 0.43, 62, 14500),

  -- ══════════════════════════════════════════════
  -- RIXEY MANOR — Ben Torres (coordinator, strong on tours, slow on email)
  -- ══════════════════════════════════════════════
  ('c0000002-0003-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333306', '2025-10-01', '2025-10-31', 5, 4, 3, 0.60, 180, 15800),
  ('c0000002-0003-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333306', '2025-11-01', '2025-11-30', 4, 3, 2, 0.50, 165, 14200),
  ('c0000002-0003-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333306', '2025-12-01', '2025-12-31', 2, 2, 1, 0.50, 200, 16500),
  ('c0000002-0003-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333306', '2026-01-01', '2026-01-31', 4, 3, 2, 0.50, 155, 15000),
  ('c0000002-0003-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333306', '2026-02-01', '2026-02-28', 5, 4, 3, 0.60, 140, 14800),
  ('c0000002-0003-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333306', '2026-03-01', '2026-03-28', 6, 5, 2, 0.33, 130, 15500),

  -- ══════════════════════════════════════════════
  -- CRESTWOOD FARM — Jake Williams (coordinator, steady performer)
  -- ══════════════════════════════════════════════
  ('c0000002-0004-0001-0001-000000000001', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333302', '2025-10-01', '2025-10-31', 5, 3, 2, 0.40, 90, 8500),
  ('c0000002-0004-0001-0001-000000000002', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333302', '2025-11-01', '2025-11-30', 4, 2, 2, 0.50, 95, 9200),
  ('c0000002-0004-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333302', '2025-12-01', '2025-12-31', 2, 1, 0, 0.00, 110, 0),
  ('c0000002-0004-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333302', '2026-02-01', '2026-02-28', 4, 3, 2, 0.50, 85, 8900),
  ('c0000002-0004-0001-0001-000000000005', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333302', '2026-03-01', '2026-03-28', 5, 4, 2, 0.40, 78, 9100),

  -- ══════════════════════════════════════════════
  -- CRESTWOOD FARM — Lena Hart (coordinator, high energy, great conversion)
  -- ══════════════════════════════════════════════
  ('c0000002-0005-0001-0001-000000000001', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333307', '2025-10-01', '2025-10-31', 4, 3, 2, 0.50, 55, 9000),
  ('c0000002-0005-0001-0001-000000000002', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333307', '2025-11-01', '2025-11-30', 3, 2, 2, 0.67, 48, 8800),
  ('c0000002-0005-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333307', '2025-12-01', '2025-12-31', 2, 2, 1, 0.50, 60, 9500),
  ('c0000002-0005-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333307', '2026-01-01', '2026-01-31', 5, 4, 3, 0.60, 42, 8200),
  ('c0000002-0005-0001-0001-000000000005', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333307', '2026-02-01', '2026-02-28', 4, 3, 2, 0.50, 38, 9400),
  ('c0000002-0005-0001-0001-000000000006', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333307', '2026-03-01', '2026-03-28', 6, 5, 3, 0.50, 35, 8700),

  -- ══════════════════════════════════════════════
  -- THE GLASS HOUSE — Maya Patel (coordinator, high volume, fast responder)
  -- ══════════════════════════════════════════════
  ('c0000002-0006-0001-0001-000000000001', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333303', '2025-10-01', '2025-10-31', 10, 7, 4, 0.40, 32, 18000),
  ('c0000002-0006-0001-0001-000000000002', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333303', '2025-11-01', '2025-11-30', 8, 5, 3, 0.38, 28, 17500),
  ('c0000002-0006-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333303', '2025-12-01', '2025-12-31', 5, 3, 2, 0.40, 35, 19000),
  ('c0000002-0006-0001-0001-000000000004', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333303', '2026-02-01', '2026-02-28', 9, 6, 4, 0.44, 25, 18200),
  ('c0000002-0006-0001-0001-000000000005', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333303', '2026-03-01', '2026-03-28', 11, 8, 5, 0.45, 22, 17800),

  -- ══════════════════════════════════════════════
  -- THE GLASS HOUSE — Marcus Rivera (coordinator, newer, improving fast)
  -- ══════════════════════════════════════════════
  ('c0000002-0007-0001-0001-000000000001', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333308', '2025-10-01', '2025-10-31', 3, 1, 0, 0.00, 210, 0),
  ('c0000002-0007-0001-0001-000000000002', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333308', '2025-11-01', '2025-11-30', 4, 2, 1, 0.25, 160, 16000),
  ('c0000002-0007-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333308', '2025-12-01', '2025-12-31', 3, 2, 1, 0.33, 130, 17500),
  ('c0000002-0007-0001-0001-000000000004', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333308', '2026-01-01', '2026-01-31', 5, 3, 2, 0.40, 95, 18000),
  ('c0000002-0007-0001-0001-000000000005', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333308', '2026-02-01', '2026-02-28', 6, 4, 3, 0.50, 72, 17200),
  ('c0000002-0007-0001-0001-000000000006', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333308', '2026-03-01', '2026-03-28', 7, 5, 3, 0.43, 55, 18500),

  -- ══════════════════════════════════════════════
  -- ROSE HILL — Olivia Ross (coordinator, small venue, personal touch)
  -- ══════════════════════════════════════════════
  ('c0000002-0008-0001-0001-000000000001', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333304', '2025-10-01', '2025-10-31', 4, 3, 2, 0.50, 65, 10200),
  ('c0000002-0008-0001-0001-000000000002', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333304', '2025-11-01', '2025-11-30', 3, 2, 1, 0.33, 70, 9800),
  ('c0000002-0008-0001-0001-000000000003', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333304', '2025-12-01', '2025-12-31', 2, 1, 1, 0.50, 80, 11000),
  ('c0000002-0008-0001-0001-000000000004', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333304', '2026-01-01', '2026-01-31', 3, 2, 1, 0.33, 72, 9500),
  ('c0000002-0008-0001-0001-000000000005', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333304', '2026-02-01', '2026-02-28', 4, 3, 2, 0.50, 58, 10800),
  ('c0000002-0008-0001-0001-000000000006', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333304', '2026-03-01', '2026-03-28', 5, 4, 3, 0.60, 50, 10500),

  -- ══════════════════════════════════════════════
  -- ROSE HILL — Emma Walsh (coordinator, part-time, weekends only)
  -- ══════════════════════════════════════════════
  ('c0000002-0009-0001-0001-000000000001', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333309', '2025-10-01', '2025-10-31', 2, 1, 1, 0.50, 150, 9800),
  ('c0000002-0009-0001-0001-000000000002', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333309', '2025-11-01', '2025-11-30', 1, 1, 0, 0.00, 180, 0),
  ('c0000002-0009-0001-0001-000000000003', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333309', '2025-12-01', '2025-12-31', 1, 0, 0, 0.00, 200, 0),
  ('c0000002-0009-0001-0001-000000000004', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333309', '2026-01-01', '2026-01-31', 2, 1, 1, 0.50, 140, 10200),
  ('c0000002-0009-0001-0001-000000000005', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333309', '2026-02-01', '2026-02-28', 2, 2, 1, 0.50, 125, 9500),
  ('c0000002-0009-0001-0001-000000000006', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333309', '2026-03-01', '2026-03-28', 3, 2, 1, 0.33, 110, 10000)

ON CONFLICT (id) DO NOTHING;

-- ============================================
-- PERFORMANCE PROFILES SUMMARY:
-- ============================================
-- Sarah Chen (Rixey) — Top performer. Fast responses, high conversion, venue manager.
-- Grace Kim (Rixey) — New hire improving month over month. Response time dropping steadily.
-- Ben Torres (Rixey) — Great at tours/conversion but slow on email (120-200 min response).
-- Jake Williams (Crestwood) — Steady, reliable. No bookings in Dec (seasonal).
-- Lena Hart (Crestwood) — High energy, fastest response times at Crestwood, strong conversion.
-- Maya Patel (Glass House) — Volume leader. 5-11 inquiries/month, fastest company-wide (22-35 min).
-- Marcus Rivera (Glass House) — Started rough (210 min, 0 bookings) but improving dramatically.
-- Olivia Ross (Rose Hill) — Personal touch, solid conversion at smaller venue.
-- Emma Walsh (Rose Hill) — Part-time, lower volume but decent when she's on.
-- ============================================
