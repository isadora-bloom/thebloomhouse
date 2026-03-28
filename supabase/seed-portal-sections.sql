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
