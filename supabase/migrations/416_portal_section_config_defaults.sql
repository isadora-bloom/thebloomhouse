-- 416_portal_section_config_defaults
--
-- Every venue with no portal_section_config rows gets the default set.
--
-- portal_section_config (013) drives /portal/section-settings and the
-- wedding portal preview, and neither has a fallback. Nothing in the
-- application ever inserted a row: the only writer was
-- supabase/seed-portal-sections.sql, for the four demo venues. Every real
-- venue opened both surfaces to an empty state, and could not configure
-- sections because there were none to configure (§26 on a fresh venue,
-- 2026-09-15). The same 32 rows now live in code as
-- src/lib/services/portal/section-defaults.ts, which the section-config
-- route applies on first read for venues created after this migration.
--
-- Idempotent: ON CONFLICT (venue_id, section_key) DO NOTHING, and the
-- WHERE NOT EXISTS keeps a venue that has ever chosen its own set alone.

INSERT INTO public.portal_section_config (venue_id, section_key, label, description, visibility, sort_order, icon)
SELECT v.id, d.section_key, d.label, d.description, d.visibility, d.sort_order, d.icon
  FROM public.venues v
 CROSS JOIN (VALUES
   ('dashboard',        'Dashboard',              'Overview of wedding progress and key dates',          'both',       1,  'LayoutDashboard'),
   ('getting-started',  'Getting Started',        'Welcome guide and first steps for your planning',     'both',       2,  'Rocket'),
   ('chat',             'Chat with Sage',         'Talk to your AI wedding planning assistant',          'both',       3,  'MessageCircle'),
   ('wedding-details',  'Wedding Details',        'Core wedding info — date, colors, theme',             'both',       4,  'Heart'),
   ('timeline',         'Timeline',               'Wedding day schedule and planning milestones',        'both',       5,  'Clock'),
   ('budget',           'Budget',                 'Track estimated vs actual costs',                     'both',       6,  'DollarSign'),
   ('guests',           'Guest List & RSVP',      'Manage guest list, meal choices, and RSVPs',          'both',       7,  'Users'),
   ('seating',          'Seating Chart',          'Assign guests to tables and manage layout',           'both',       8,  'Armchair'),
   ('checklist',        'Planning Checklist',     'Track tasks and milestones',                          'both',       9,  'CheckSquare'),
   ('vendors',          'Vendors & Contracts',    'Preferred vendors, contacts, and contracts',          'both',       10, 'Store'),
   ('ceremony',         'Ceremony Order',         'Processional, readings, vows, and recessional',       'both',       11, 'BookOpen'),
   ('party',            'Wedding Party',          'Bridal party, groomsmen, and roles',                  'both',       12, 'UsersRound'),
   ('beauty',           'Hair & Makeup',          'Beauty appointments and schedule',                    'both',       13, 'Sparkles'),
   ('transportation',   'Transportation',         'Shuttles, limos, and parking logistics',              'both',       14, 'Car'),
   ('rooms',            'Room Assignments',       'Internal room and space assignments',                 'admin_only', 15, 'DoorOpen'),
   ('rehearsal',        'Rehearsal Dinner',       'Rehearsal dinner details and attendees',              'both',       16, 'UtensilsCrossed'),
   ('decor',            'Decor Inventory',        'Track decor items, rentals, and setup notes',         'both',       17, 'Flower2'),
   ('staffing',         'Staffing',               'Internal staffing assignments and schedules',         'admin_only', 18, 'HardHat'),
   ('bar',              'Bar Planning',           'Drink menu, quantities, and bar setup',               'both',       19, 'Wine'),
   ('allergies',        'Allergy Registry',       'Dietary restrictions and allergy tracking',           'both',       20, 'ShieldAlert'),
   ('guest-care',       'Guest Care Notes',       'Internal notes about guest needs',                    'admin_only', 21, 'HeartHandshake'),
   ('inspo',            'Inspiration Gallery',    'Mood boards and design inspiration',                  'both',       22, 'Lightbulb'),
   ('photos',           'Photo Library',          'Upload and organize wedding photos',                  'both',       23, 'Camera'),
   ('worksheets',       'Planning Worksheets',    'Printable worksheets and planning templates',         'both',       24, 'FileText'),
   ('venue-inventory',  'Venue Inventory',        'What the venue provides — tables, linens, etc.',      'both',       25, 'Package'),
   ('stays',            'Accommodations',         'On-site and nearby lodging options',                  'both',       26, 'Bed'),
   ('website',          'Wedding Website',        'Build and customize your wedding website',            'both',       27, 'Globe'),
   ('final-review',     'Final Review',           'Pre-wedding final walkthrough and confirmations',     'both',       28, 'ClipboardCheck'),
   ('messages',         'Direct Messages',        'Message your coordinator directly',                   'both',       29, 'MessagesSquare'),
   ('couple-photo',     'Couple Photo',           'Upload your couple photo for the portal',             'both',       30, 'ImagePlus'),
   ('resources',        'Resources & Downloads',  'Downloadable guides, checklists, and documents',      'both',       31, 'Download'),
   ('booking',          'Book a Meeting',         'Schedule a call or tour with your coordinator',       'both',       32, 'CalendarPlus')
 ) AS d(section_key, label, description, visibility, sort_order, icon)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.portal_section_config c WHERE c.venue_id = v.id
 )
ON CONFLICT (venue_id, section_key) DO NOTHING;
