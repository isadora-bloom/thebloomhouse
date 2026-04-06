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
-- Static UUIDs to avoid PL/pgSQL type casting issues.

-- Hawthorne Manor
INSERT INTO portal_section_config (id, venue_id, section_key, label, description, visibility, sort_order, icon) VALUES
  ('ffff0001-0000-0000-0000-000000000001'::uuid, '22222222-2222-2222-2222-222222222201', 'dashboard',        'Dashboard',              'Overview of wedding progress and key dates',          'both',       1,  'LayoutDashboard'),
  ('ffff0001-0000-0000-0000-000000000002'::uuid, '22222222-2222-2222-2222-222222222201', 'getting-started',   'Getting Started',        'Welcome guide and first steps for your planning',     'both',       2,  'Rocket'),
  ('ffff0001-0000-0000-0000-000000000003'::uuid, '22222222-2222-2222-2222-222222222201', 'chat',              'Chat with Sage',         'Talk to your AI wedding planning assistant',          'both',       3,  'MessageCircle'),
  ('ffff0001-0000-0000-0000-000000000004'::uuid, '22222222-2222-2222-2222-222222222201', 'wedding-details',   'Wedding Details',        'Core wedding info — date, colors, theme',             'both',       4,  'Heart'),
  ('ffff0001-0000-0000-0000-000000000005'::uuid, '22222222-2222-2222-2222-222222222201', 'timeline',          'Timeline',               'Wedding day schedule and planning milestones',        'both',       5,  'Clock'),
  ('ffff0001-0000-0000-0000-000000000006'::uuid, '22222222-2222-2222-2222-222222222201', 'budget',            'Budget',                 'Track estimated vs actual costs',                     'both',       6,  'DollarSign'),
  ('ffff0001-0000-0000-0000-000000000007'::uuid, '22222222-2222-2222-2222-222222222201', 'guests',            'Guest List & RSVP',      'Manage guest list, meal choices, and RSVPs',          'both',       7,  'Users'),
  ('ffff0001-0000-0000-0000-000000000008'::uuid, '22222222-2222-2222-2222-222222222201', 'seating',           'Seating Chart',          'Assign guests to tables and manage layout',           'both',       8,  'Armchair'),
  ('ffff0001-0000-0000-0000-000000000009'::uuid, '22222222-2222-2222-2222-222222222201', 'checklist',         'Planning Checklist',     'Track tasks and milestones',                          'both',       9,  'CheckSquare'),
  ('ffff0001-0000-0000-0000-000000000010'::uuid, '22222222-2222-2222-2222-222222222201', 'vendors',           'Vendors & Contracts',    'Preferred vendors, contacts, and contracts',          'both',       10, 'Store'),
  ('ffff0001-0000-0000-0000-000000000011'::uuid, '22222222-2222-2222-2222-222222222201', 'ceremony',          'Ceremony Order',         'Processional, readings, vows, and recessional',       'both',       11, 'BookOpen'),
  ('ffff0001-0000-0000-0000-000000000012'::uuid, '22222222-2222-2222-2222-222222222201', 'party',             'Wedding Party',          'Bridal party, groomsmen, and roles',                  'both',       12, 'UsersRound'),
  ('ffff0001-0000-0000-0000-000000000013'::uuid, '22222222-2222-2222-2222-222222222201', 'beauty',            'Hair & Makeup',          'Beauty appointments and schedule',                    'both',       13, 'Sparkles'),
  ('ffff0001-0000-0000-0000-000000000014'::uuid, '22222222-2222-2222-2222-222222222201', 'transportation',    'Transportation',         'Shuttles, limos, and parking logistics',              'both',       14, 'Car'),
  ('ffff0001-0000-0000-0000-000000000015'::uuid, '22222222-2222-2222-2222-222222222201', 'rooms',             'Room Assignments',       'Internal room and space assignments',                 'admin_only', 15, 'DoorOpen'),
  ('ffff0001-0000-0000-0000-000000000016'::uuid, '22222222-2222-2222-2222-222222222201', 'rehearsal',         'Rehearsal Dinner',       'Rehearsal dinner details and attendees',               'both',       16, 'UtensilsCrossed'),
  ('ffff0001-0000-0000-0000-000000000017'::uuid, '22222222-2222-2222-2222-222222222201', 'decor',             'Decor Inventory',        'Track decor items, rentals, and setup notes',         'both',       17, 'Flower2'),
  ('ffff0001-0000-0000-0000-000000000018'::uuid, '22222222-2222-2222-2222-222222222201', 'staffing',          'Staffing',               'Internal staffing assignments and schedules',         'admin_only', 18, 'HardHat'),
  ('ffff0001-0000-0000-0000-000000000019'::uuid, '22222222-2222-2222-2222-222222222201', 'bar',               'Bar Planning',           'Drink menu, quantities, and bar setup',               'both',       19, 'Wine'),
  ('ffff0001-0000-0000-0000-000000000020'::uuid, '22222222-2222-2222-2222-222222222201', 'allergies',         'Allergy Registry',       'Dietary restrictions and allergy tracking',           'both',       20, 'ShieldAlert'),
  ('ffff0001-0000-0000-0000-000000000021'::uuid, '22222222-2222-2222-2222-222222222201', 'guest-care',        'Guest Care Notes',       'Internal notes about guest needs',                    'admin_only', 21, 'HeartHandshake'),
  ('ffff0001-0000-0000-0000-000000000022'::uuid, '22222222-2222-2222-2222-222222222201', 'inspo',             'Inspiration Gallery',    'Mood boards and design inspiration',                  'both',       22, 'Lightbulb'),
  ('ffff0001-0000-0000-0000-000000000023'::uuid, '22222222-2222-2222-2222-222222222201', 'photos',            'Photo Library',          'Upload and organize wedding photos',                  'both',       23, 'Camera'),
  ('ffff0001-0000-0000-0000-000000000024'::uuid, '22222222-2222-2222-2222-222222222201', 'worksheets',        'Planning Worksheets',    'Printable worksheets and planning templates',         'both',       24, 'FileText'),
  ('ffff0001-0000-0000-0000-000000000025'::uuid, '22222222-2222-2222-2222-222222222201', 'venue-inventory',   'Venue Inventory',        'What the venue provides — tables, linens, etc.',      'both',       25, 'Package'),
  ('ffff0001-0000-0000-0000-000000000026'::uuid, '22222222-2222-2222-2222-222222222201', 'stays',             'Accommodations',         'On-site and nearby lodging options',                  'both',       26, 'Bed'),
  ('ffff0001-0000-0000-0000-000000000027'::uuid, '22222222-2222-2222-2222-222222222201', 'website',           'Wedding Website',        'Build and customize your wedding website',            'both',       27, 'Globe'),
  ('ffff0001-0000-0000-0000-000000000028'::uuid, '22222222-2222-2222-2222-222222222201', 'final-review',      'Final Review',           'Pre-wedding final walkthrough and confirmations',     'both',       28, 'ClipboardCheck'),
  ('ffff0001-0000-0000-0000-000000000029'::uuid, '22222222-2222-2222-2222-222222222201', 'messages',          'Direct Messages',        'Message your coordinator directly',                   'both',       29, 'MessagesSquare'),
  ('ffff0001-0000-0000-0000-000000000030'::uuid, '22222222-2222-2222-2222-222222222201', 'couple-photo',      'Couple Photo',           'Upload your couple photo for the portal',             'both',       30, 'ImagePlus'),
  ('ffff0001-0000-0000-0000-000000000031'::uuid, '22222222-2222-2222-2222-222222222201', 'resources',         'Resources & Downloads',  'Downloadable guides, checklists, and documents',      'both',       31, 'Download'),
  ('ffff0001-0000-0000-0000-000000000032'::uuid, '22222222-2222-2222-2222-222222222201', 'booking',           'Book a Meeting',         'Schedule a call or tour with your coordinator',       'both',       32, 'CalendarPlus')
ON CONFLICT (venue_id, section_key) DO NOTHING;

-- Crestwood Farm
INSERT INTO portal_section_config (id, venue_id, section_key, label, description, visibility, sort_order, icon) VALUES
  ('ffff0002-0000-0000-0000-000000000001'::uuid, '22222222-2222-2222-2222-222222222202', 'dashboard',        'Dashboard',              'Overview of wedding progress and key dates',          'both',       1,  'LayoutDashboard'),
  ('ffff0002-0000-0000-0000-000000000002'::uuid, '22222222-2222-2222-2222-222222222202', 'getting-started',   'Getting Started',        'Welcome guide and first steps for your planning',     'both',       2,  'Rocket'),
  ('ffff0002-0000-0000-0000-000000000003'::uuid, '22222222-2222-2222-2222-222222222202', 'chat',              'Chat with Sage',         'Talk to your AI wedding planning assistant',          'both',       3,  'MessageCircle'),
  ('ffff0002-0000-0000-0000-000000000004'::uuid, '22222222-2222-2222-2222-222222222202', 'wedding-details',   'Wedding Details',        'Core wedding info — date, colors, theme',             'both',       4,  'Heart'),
  ('ffff0002-0000-0000-0000-000000000005'::uuid, '22222222-2222-2222-2222-222222222202', 'timeline',          'Timeline',               'Wedding day schedule and planning milestones',        'both',       5,  'Clock'),
  ('ffff0002-0000-0000-0000-000000000006'::uuid, '22222222-2222-2222-2222-222222222202', 'budget',            'Budget',                 'Track estimated vs actual costs',                     'both',       6,  'DollarSign'),
  ('ffff0002-0000-0000-0000-000000000007'::uuid, '22222222-2222-2222-2222-222222222202', 'guests',            'Guest List & RSVP',      'Manage guest list, meal choices, and RSVPs',          'both',       7,  'Users'),
  ('ffff0002-0000-0000-0000-000000000008'::uuid, '22222222-2222-2222-2222-222222222202', 'seating',           'Seating Chart',          'Assign guests to tables and manage layout',           'both',       8,  'Armchair'),
  ('ffff0002-0000-0000-0000-000000000009'::uuid, '22222222-2222-2222-2222-222222222202', 'checklist',         'Planning Checklist',     'Track tasks and milestones',                          'both',       9,  'CheckSquare'),
  ('ffff0002-0000-0000-0000-000000000010'::uuid, '22222222-2222-2222-2222-222222222202', 'vendors',           'Vendors & Contracts',    'Preferred vendors, contacts, and contracts',          'both',       10, 'Store'),
  ('ffff0002-0000-0000-0000-000000000011'::uuid, '22222222-2222-2222-2222-222222222202', 'ceremony',          'Ceremony Order',         'Processional, readings, vows, and recessional',       'both',       11, 'BookOpen'),
  ('ffff0002-0000-0000-0000-000000000012'::uuid, '22222222-2222-2222-2222-222222222202', 'party',             'Wedding Party',          'Bridal party, groomsmen, and roles',                  'both',       12, 'UsersRound'),
  ('ffff0002-0000-0000-0000-000000000013'::uuid, '22222222-2222-2222-2222-222222222202', 'beauty',            'Hair & Makeup',          'Beauty appointments and schedule',                    'both',       13, 'Sparkles'),
  ('ffff0002-0000-0000-0000-000000000014'::uuid, '22222222-2222-2222-2222-222222222202', 'transportation',    'Transportation',         'Shuttles, limos, and parking logistics',              'both',       14, 'Car'),
  ('ffff0002-0000-0000-0000-000000000015'::uuid, '22222222-2222-2222-2222-222222222202', 'rooms',             'Room Assignments',       'Internal room and space assignments',                 'admin_only', 15, 'DoorOpen'),
  ('ffff0002-0000-0000-0000-000000000016'::uuid, '22222222-2222-2222-2222-222222222202', 'rehearsal',         'Rehearsal Dinner',       'Rehearsal dinner details and attendees',               'both',       16, 'UtensilsCrossed'),
  ('ffff0002-0000-0000-0000-000000000017'::uuid, '22222222-2222-2222-2222-222222222202', 'decor',             'Decor Inventory',        'Track decor items, rentals, and setup notes',         'both',       17, 'Flower2'),
  ('ffff0002-0000-0000-0000-000000000018'::uuid, '22222222-2222-2222-2222-222222222202', 'staffing',          'Staffing',               'Internal staffing assignments and schedules',         'admin_only', 18, 'HardHat'),
  ('ffff0002-0000-0000-0000-000000000019'::uuid, '22222222-2222-2222-2222-222222222202', 'bar',               'Bar Planning',           'Drink menu, quantities, and bar setup',               'both',       19, 'Wine'),
  ('ffff0002-0000-0000-0000-000000000020'::uuid, '22222222-2222-2222-2222-222222222202', 'allergies',         'Allergy Registry',       'Dietary restrictions and allergy tracking',           'both',       20, 'ShieldAlert'),
  ('ffff0002-0000-0000-0000-000000000021'::uuid, '22222222-2222-2222-2222-222222222202', 'guest-care',        'Guest Care Notes',       'Internal notes about guest needs',                    'admin_only', 21, 'HeartHandshake'),
  ('ffff0002-0000-0000-0000-000000000022'::uuid, '22222222-2222-2222-2222-222222222202', 'inspo',             'Inspiration Gallery',    'Mood boards and design inspiration',                  'both',       22, 'Lightbulb'),
  ('ffff0002-0000-0000-0000-000000000023'::uuid, '22222222-2222-2222-2222-222222222202', 'photos',            'Photo Library',          'Upload and organize wedding photos',                  'both',       23, 'Camera'),
  ('ffff0002-0000-0000-0000-000000000024'::uuid, '22222222-2222-2222-2222-222222222202', 'worksheets',        'Planning Worksheets',    'Printable worksheets and planning templates',         'both',       24, 'FileText'),
  ('ffff0002-0000-0000-0000-000000000025'::uuid, '22222222-2222-2222-2222-222222222202', 'venue-inventory',   'Venue Inventory',        'What the venue provides — tables, linens, etc.',      'both',       25, 'Package'),
  ('ffff0002-0000-0000-0000-000000000026'::uuid, '22222222-2222-2222-2222-222222222202', 'stays',             'Accommodations',         'On-site and nearby lodging options',                  'both',       26, 'Bed'),
  ('ffff0002-0000-0000-0000-000000000027'::uuid, '22222222-2222-2222-2222-222222222202', 'website',           'Wedding Website',        'Build and customize your wedding website',            'both',       27, 'Globe'),
  ('ffff0002-0000-0000-0000-000000000028'::uuid, '22222222-2222-2222-2222-222222222202', 'final-review',      'Final Review',           'Pre-wedding final walkthrough and confirmations',     'both',       28, 'ClipboardCheck'),
  ('ffff0002-0000-0000-0000-000000000029'::uuid, '22222222-2222-2222-2222-222222222202', 'messages',          'Direct Messages',        'Message your coordinator directly',                   'both',       29, 'MessagesSquare'),
  ('ffff0002-0000-0000-0000-000000000030'::uuid, '22222222-2222-2222-2222-222222222202', 'couple-photo',      'Couple Photo',           'Upload your couple photo for the portal',             'both',       30, 'ImagePlus'),
  ('ffff0002-0000-0000-0000-000000000031'::uuid, '22222222-2222-2222-2222-222222222202', 'resources',         'Resources & Downloads',  'Downloadable guides, checklists, and documents',      'both',       31, 'Download'),
  ('ffff0002-0000-0000-0000-000000000032'::uuid, '22222222-2222-2222-2222-222222222202', 'booking',           'Book a Meeting',         'Schedule a call or tour with your coordinator',       'both',       32, 'CalendarPlus')
ON CONFLICT (venue_id, section_key) DO NOTHING;

-- The Glass House
INSERT INTO portal_section_config (id, venue_id, section_key, label, description, visibility, sort_order, icon) VALUES
  ('ffff0003-0000-0000-0000-000000000001'::uuid, '22222222-2222-2222-2222-222222222203', 'dashboard',        'Dashboard',              'Overview of wedding progress and key dates',          'both',       1,  'LayoutDashboard'),
  ('ffff0003-0000-0000-0000-000000000002'::uuid, '22222222-2222-2222-2222-222222222203', 'getting-started',   'Getting Started',        'Welcome guide and first steps for your planning',     'both',       2,  'Rocket'),
  ('ffff0003-0000-0000-0000-000000000003'::uuid, '22222222-2222-2222-2222-222222222203', 'chat',              'Chat with Sage',         'Talk to your AI wedding planning assistant',          'both',       3,  'MessageCircle'),
  ('ffff0003-0000-0000-0000-000000000004'::uuid, '22222222-2222-2222-2222-222222222203', 'wedding-details',   'Wedding Details',        'Core wedding info — date, colors, theme',             'both',       4,  'Heart'),
  ('ffff0003-0000-0000-0000-000000000005'::uuid, '22222222-2222-2222-2222-222222222203', 'timeline',          'Timeline',               'Wedding day schedule and planning milestones',        'both',       5,  'Clock'),
  ('ffff0003-0000-0000-0000-000000000006'::uuid, '22222222-2222-2222-2222-222222222203', 'budget',            'Budget',                 'Track estimated vs actual costs',                     'both',       6,  'DollarSign'),
  ('ffff0003-0000-0000-0000-000000000007'::uuid, '22222222-2222-2222-2222-222222222203', 'guests',            'Guest List & RSVP',      'Manage guest list, meal choices, and RSVPs',          'both',       7,  'Users'),
  ('ffff0003-0000-0000-0000-000000000008'::uuid, '22222222-2222-2222-2222-222222222203', 'seating',           'Seating Chart',          'Assign guests to tables and manage layout',           'both',       8,  'Armchair'),
  ('ffff0003-0000-0000-0000-000000000009'::uuid, '22222222-2222-2222-2222-222222222203', 'checklist',         'Planning Checklist',     'Track tasks and milestones',                          'both',       9,  'CheckSquare'),
  ('ffff0003-0000-0000-0000-000000000010'::uuid, '22222222-2222-2222-2222-222222222203', 'vendors',           'Vendors & Contracts',    'Preferred vendors, contacts, and contracts',          'both',       10, 'Store'),
  ('ffff0003-0000-0000-0000-000000000011'::uuid, '22222222-2222-2222-2222-222222222203', 'ceremony',          'Ceremony Order',         'Processional, readings, vows, and recessional',       'both',       11, 'BookOpen'),
  ('ffff0003-0000-0000-0000-000000000012'::uuid, '22222222-2222-2222-2222-222222222203', 'party',             'Wedding Party',          'Bridal party, groomsmen, and roles',                  'both',       12, 'UsersRound'),
  ('ffff0003-0000-0000-0000-000000000013'::uuid, '22222222-2222-2222-2222-222222222203', 'beauty',            'Hair & Makeup',          'Beauty appointments and schedule',                    'both',       13, 'Sparkles'),
  ('ffff0003-0000-0000-0000-000000000014'::uuid, '22222222-2222-2222-2222-222222222203', 'transportation',    'Transportation',         'Shuttles, limos, and parking logistics',              'both',       14, 'Car'),
  ('ffff0003-0000-0000-0000-000000000015'::uuid, '22222222-2222-2222-2222-222222222203', 'rooms',             'Room Assignments',       'Internal room and space assignments',                 'admin_only', 15, 'DoorOpen'),
  ('ffff0003-0000-0000-0000-000000000016'::uuid, '22222222-2222-2222-2222-222222222203', 'rehearsal',         'Rehearsal Dinner',       'Rehearsal dinner details and attendees',               'both',       16, 'UtensilsCrossed'),
  ('ffff0003-0000-0000-0000-000000000017'::uuid, '22222222-2222-2222-2222-222222222203', 'decor',             'Decor Inventory',        'Track decor items, rentals, and setup notes',         'both',       17, 'Flower2'),
  ('ffff0003-0000-0000-0000-000000000018'::uuid, '22222222-2222-2222-2222-222222222203', 'staffing',          'Staffing',               'Internal staffing assignments and schedules',         'admin_only', 18, 'HardHat'),
  ('ffff0003-0000-0000-0000-000000000019'::uuid, '22222222-2222-2222-2222-222222222203', 'bar',               'Bar Planning',           'Drink menu, quantities, and bar setup',               'both',       19, 'Wine'),
  ('ffff0003-0000-0000-0000-000000000020'::uuid, '22222222-2222-2222-2222-222222222203', 'allergies',         'Allergy Registry',       'Dietary restrictions and allergy tracking',           'both',       20, 'ShieldAlert'),
  ('ffff0003-0000-0000-0000-000000000021'::uuid, '22222222-2222-2222-2222-222222222203', 'guest-care',        'Guest Care Notes',       'Internal notes about guest needs',                    'admin_only', 21, 'HeartHandshake'),
  ('ffff0003-0000-0000-0000-000000000022'::uuid, '22222222-2222-2222-2222-222222222203', 'inspo',             'Inspiration Gallery',    'Mood boards and design inspiration',                  'both',       22, 'Lightbulb'),
  ('ffff0003-0000-0000-0000-000000000023'::uuid, '22222222-2222-2222-2222-222222222203', 'photos',            'Photo Library',          'Upload and organize wedding photos',                  'both',       23, 'Camera'),
  ('ffff0003-0000-0000-0000-000000000024'::uuid, '22222222-2222-2222-2222-222222222203', 'worksheets',        'Planning Worksheets',    'Printable worksheets and planning templates',         'both',       24, 'FileText'),
  ('ffff0003-0000-0000-0000-000000000025'::uuid, '22222222-2222-2222-2222-222222222203', 'venue-inventory',   'Venue Inventory',        'What the venue provides — tables, linens, etc.',      'both',       25, 'Package'),
  ('ffff0003-0000-0000-0000-000000000026'::uuid, '22222222-2222-2222-2222-222222222203', 'stays',             'Accommodations',         'On-site and nearby lodging options',                  'both',       26, 'Bed'),
  ('ffff0003-0000-0000-0000-000000000027'::uuid, '22222222-2222-2222-2222-222222222203', 'website',           'Wedding Website',        'Build and customize your wedding website',            'both',       27, 'Globe'),
  ('ffff0003-0000-0000-0000-000000000028'::uuid, '22222222-2222-2222-2222-222222222203', 'final-review',      'Final Review',           'Pre-wedding final walkthrough and confirmations',     'both',       28, 'ClipboardCheck'),
  ('ffff0003-0000-0000-0000-000000000029'::uuid, '22222222-2222-2222-2222-222222222203', 'messages',          'Direct Messages',        'Message your coordinator directly',                   'both',       29, 'MessagesSquare'),
  ('ffff0003-0000-0000-0000-000000000030'::uuid, '22222222-2222-2222-2222-222222222203', 'couple-photo',      'Couple Photo',           'Upload your couple photo for the portal',             'both',       30, 'ImagePlus'),
  ('ffff0003-0000-0000-0000-000000000031'::uuid, '22222222-2222-2222-2222-222222222203', 'resources',         'Resources & Downloads',  'Downloadable guides, checklists, and documents',      'both',       31, 'Download'),
  ('ffff0003-0000-0000-0000-000000000032'::uuid, '22222222-2222-2222-2222-222222222203', 'booking',           'Book a Meeting',         'Schedule a call or tour with your coordinator',       'both',       32, 'CalendarPlus')
ON CONFLICT (venue_id, section_key) DO NOTHING;

-- Rose Hill Gardens
INSERT INTO portal_section_config (id, venue_id, section_key, label, description, visibility, sort_order, icon) VALUES
  ('ffff0004-0000-0000-0000-000000000001'::uuid, '22222222-2222-2222-2222-222222222204', 'dashboard',        'Dashboard',              'Overview of wedding progress and key dates',          'both',       1,  'LayoutDashboard'),
  ('ffff0004-0000-0000-0000-000000000002'::uuid, '22222222-2222-2222-2222-222222222204', 'getting-started',   'Getting Started',        'Welcome guide and first steps for your planning',     'both',       2,  'Rocket'),
  ('ffff0004-0000-0000-0000-000000000003'::uuid, '22222222-2222-2222-2222-222222222204', 'chat',              'Chat with Sage',         'Talk to your AI wedding planning assistant',          'both',       3,  'MessageCircle'),
  ('ffff0004-0000-0000-0000-000000000004'::uuid, '22222222-2222-2222-2222-222222222204', 'wedding-details',   'Wedding Details',        'Core wedding info — date, colors, theme',             'both',       4,  'Heart'),
  ('ffff0004-0000-0000-0000-000000000005'::uuid, '22222222-2222-2222-2222-222222222204', 'timeline',          'Timeline',               'Wedding day schedule and planning milestones',        'both',       5,  'Clock'),
  ('ffff0004-0000-0000-0000-000000000006'::uuid, '22222222-2222-2222-2222-222222222204', 'budget',            'Budget',                 'Track estimated vs actual costs',                     'both',       6,  'DollarSign'),
  ('ffff0004-0000-0000-0000-000000000007'::uuid, '22222222-2222-2222-2222-222222222204', 'guests',            'Guest List & RSVP',      'Manage guest list, meal choices, and RSVPs',          'both',       7,  'Users'),
  ('ffff0004-0000-0000-0000-000000000008'::uuid, '22222222-2222-2222-2222-222222222204', 'seating',           'Seating Chart',          'Assign guests to tables and manage layout',           'both',       8,  'Armchair'),
  ('ffff0004-0000-0000-0000-000000000009'::uuid, '22222222-2222-2222-2222-222222222204', 'checklist',         'Planning Checklist',     'Track tasks and milestones',                          'both',       9,  'CheckSquare'),
  ('ffff0004-0000-0000-0000-000000000010'::uuid, '22222222-2222-2222-2222-222222222204', 'vendors',           'Vendors & Contracts',    'Preferred vendors, contacts, and contracts',          'both',       10, 'Store'),
  ('ffff0004-0000-0000-0000-000000000011'::uuid, '22222222-2222-2222-2222-222222222204', 'ceremony',          'Ceremony Order',         'Processional, readings, vows, and recessional',       'both',       11, 'BookOpen'),
  ('ffff0004-0000-0000-0000-000000000012'::uuid, '22222222-2222-2222-2222-222222222204', 'party',             'Wedding Party',          'Bridal party, groomsmen, and roles',                  'both',       12, 'UsersRound'),
  ('ffff0004-0000-0000-0000-000000000013'::uuid, '22222222-2222-2222-2222-222222222204', 'beauty',            'Hair & Makeup',          'Beauty appointments and schedule',                    'both',       13, 'Sparkles'),
  ('ffff0004-0000-0000-0000-000000000014'::uuid, '22222222-2222-2222-2222-222222222204', 'transportation',    'Transportation',         'Shuttles, limos, and parking logistics',              'both',       14, 'Car'),
  ('ffff0004-0000-0000-0000-000000000015'::uuid, '22222222-2222-2222-2222-222222222204', 'rooms',             'Room Assignments',       'Internal room and space assignments',                 'admin_only', 15, 'DoorOpen'),
  ('ffff0004-0000-0000-0000-000000000016'::uuid, '22222222-2222-2222-2222-222222222204', 'rehearsal',         'Rehearsal Dinner',       'Rehearsal dinner details and attendees',               'both',       16, 'UtensilsCrossed'),
  ('ffff0004-0000-0000-0000-000000000017'::uuid, '22222222-2222-2222-2222-222222222204', 'decor',             'Decor Inventory',        'Track decor items, rentals, and setup notes',         'both',       17, 'Flower2'),
  ('ffff0004-0000-0000-0000-000000000018'::uuid, '22222222-2222-2222-2222-222222222204', 'staffing',          'Staffing',               'Internal staffing assignments and schedules',         'admin_only', 18, 'HardHat'),
  ('ffff0004-0000-0000-0000-000000000019'::uuid, '22222222-2222-2222-2222-222222222204', 'bar',               'Bar Planning',           'Drink menu, quantities, and bar setup',               'both',       19, 'Wine'),
  ('ffff0004-0000-0000-0000-000000000020'::uuid, '22222222-2222-2222-2222-222222222204', 'allergies',         'Allergy Registry',       'Dietary restrictions and allergy tracking',           'both',       20, 'ShieldAlert'),
  ('ffff0004-0000-0000-0000-000000000021'::uuid, '22222222-2222-2222-2222-222222222204', 'guest-care',        'Guest Care Notes',       'Internal notes about guest needs',                    'admin_only', 21, 'HeartHandshake'),
  ('ffff0004-0000-0000-0000-000000000022'::uuid, '22222222-2222-2222-2222-222222222204', 'inspo',             'Inspiration Gallery',    'Mood boards and design inspiration',                  'both',       22, 'Lightbulb'),
  ('ffff0004-0000-0000-0000-000000000023'::uuid, '22222222-2222-2222-2222-222222222204', 'photos',            'Photo Library',          'Upload and organize wedding photos',                  'both',       23, 'Camera'),
  ('ffff0004-0000-0000-0000-000000000024'::uuid, '22222222-2222-2222-2222-222222222204', 'worksheets',        'Planning Worksheets',    'Printable worksheets and planning templates',         'both',       24, 'FileText'),
  ('ffff0004-0000-0000-0000-000000000025'::uuid, '22222222-2222-2222-2222-222222222204', 'venue-inventory',   'Venue Inventory',        'What the venue provides — tables, linens, etc.',      'both',       25, 'Package'),
  ('ffff0004-0000-0000-0000-000000000026'::uuid, '22222222-2222-2222-2222-222222222204', 'stays',             'Accommodations',         'On-site and nearby lodging options',                  'both',       26, 'Bed'),
  ('ffff0004-0000-0000-0000-000000000027'::uuid, '22222222-2222-2222-2222-222222222204', 'website',           'Wedding Website',        'Build and customize your wedding website',            'both',       27, 'Globe'),
  ('ffff0004-0000-0000-0000-000000000028'::uuid, '22222222-2222-2222-2222-222222222204', 'final-review',      'Final Review',           'Pre-wedding final walkthrough and confirmations',     'both',       28, 'ClipboardCheck'),
  ('ffff0004-0000-0000-0000-000000000029'::uuid, '22222222-2222-2222-2222-222222222204', 'messages',          'Direct Messages',        'Message your coordinator directly',                   'both',       29, 'MessagesSquare'),
  ('ffff0004-0000-0000-0000-000000000030'::uuid, '22222222-2222-2222-2222-222222222204', 'couple-photo',      'Couple Photo',           'Upload your couple photo for the portal',             'both',       30, 'ImagePlus'),
  ('ffff0004-0000-0000-0000-000000000031'::uuid, '22222222-2222-2222-2222-222222222204', 'resources',         'Resources & Downloads',  'Downloadable guides, checklists, and documents',      'both',       31, 'Download'),
  ('ffff0004-0000-0000-0000-000000000032'::uuid, '22222222-2222-2222-2222-222222222204', 'booking',           'Book a Meeting',         'Schedule a call or tour with your coordinator',       'both',       32, 'CalendarPlus')
ON CONFLICT (venue_id, section_key) DO NOTHING;
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
  ('33333333-3333-3333-3333-333333333305', 'grace@hawthornemanor.com', '{"first_name":"Grace","last_name":"Kim"}', now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333306', 'ben@hawthornemanor.com', '{"first_name":"Ben","last_name":"Torres"}', now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333307', 'lena@crestwoodfarm.com', '{"first_name":"Lena","last_name":"Hart"}', now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333308', 'marcus@theglasshouse.com', '{"first_name":"Marcus","last_name":"Rivera"}', now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333309', 'emma@rosehillgardens.com', '{"first_name":"Emma","last_name":"Walsh"}', now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
ON CONFLICT (id) DO NOTHING;

-- Now add their profiles
INSERT INTO user_profiles (id, venue_id, org_id, role, first_name, last_name) VALUES
  -- Hawthorne Manor — 2 more staff
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
  -- HAWTHORNE MANOR — Sarah Chen (venue manager, top performer)
  -- ══════════════════════════════════════════════
  ('c0000002-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', '2025-10-01', '2025-10-31', 8, 6, 4, 0.50, 45, 15200),
  ('c0000002-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', '2025-11-01', '2025-11-30', 6, 4, 3, 0.50, 52, 14800),
  ('c0000002-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', '2025-12-01', '2025-12-31', 3, 2, 1, 0.33, 78, 16000),

  -- ══════════════════════════════════════════════
  -- HAWTHORNE MANOR — Grace Kim (coordinator, newer, still learning)
  -- ══════════════════════════════════════════════
  ('c0000002-0002-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333305', '2025-10-01', '2025-10-31', 4, 2, 1, 0.25, 120, 12500),
  ('c0000002-0002-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333305', '2025-11-01', '2025-11-30', 5, 3, 1, 0.20, 105, 13000),
  ('c0000002-0002-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333305', '2025-12-01', '2025-12-31', 2, 1, 1, 0.50, 95, 11800),
  ('c0000002-0002-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333305', '2026-01-01', '2026-01-31', 6, 4, 2, 0.33, 88, 14200),
  ('c0000002-0002-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333305', '2026-02-01', '2026-02-28', 5, 3, 2, 0.40, 75, 13800),
  ('c0000002-0002-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333305', '2026-03-01', '2026-03-28', 7, 5, 3, 0.43, 62, 14500),

  -- ══════════════════════════════════════════════
  -- HAWTHORNE MANOR — Ben Torres (coordinator, strong on tours, slow on email)
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
-- Sarah Chen (Hawthorne) — Top performer. Fast responses, high conversion, venue manager.
-- Grace Kim (Hawthorne) — New hire improving month over month. Response time dropping steadily.
-- Ben Torres (Hawthorne) — Great at tours/conversion but slow on email (120-200 min response).
-- Jake Williams (Crestwood) — Steady, reliable. No bookings in Dec (seasonal).
-- Lena Hart (Crestwood) — High energy, fastest response times at Crestwood, strong conversion.
-- Maya Patel (Glass House) — Volume leader. 5-11 inquiries/month, fastest company-wide (22-35 min).
-- Marcus Rivera (Glass House) — Started rough (210 min, 0 bookings) but improving dramatically.
-- Olivia Ross (Rose Hill) — Personal touch, solid conversion at smaller venue.
-- Emma Walsh (Rose Hill) — Part-time, lower volume but decent when she's on.
-- ============================================
