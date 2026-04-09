-- =================================================================
-- SEED: Team members, consultant metrics, response times, and tours
-- for the 4 demo venues (Crestwood Collection).
-- =================================================================
-- Adds six additional coordinators (Jordan, Bex, Sam, Nia, Max, Dee),
-- their 30-day consultant metrics, a per-venue avg_response_time_minutes
-- flag, and 5 tours per venue with mixed outcomes.
--
-- Idempotent: safe to rerun via
--   cat supabase/seed-team-tours-response.sql \
--     | npx supabase db query --linked
-- =================================================================

-- -----------------------------------------------------------------
-- TASK 2.2 — Team members
-- -----------------------------------------------------------------
-- user_profiles.id has a FK to auth.users(id), so we must create
-- shadow auth rows first (same pattern as seed-team-data.sql).

INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at, instance_id, aud, role)
VALUES
  -- HAWTHORNE MANOR
  ('33333333-3333-3333-3333-333333333310', 'jordan@hawthornemanor.com', '{"first_name":"Jordan","last_name":"Ellis"}',  now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333311', 'bex@hawthornemanor.com',    '{"first_name":"Bex","last_name":"Hollis"}',    now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  -- CRESTWOOD FARM
  ('33333333-3333-3333-3333-333333333312', 'sam@crestwoodfarm.com',     '{"first_name":"Sam","last_name":"Wyatt"}',     now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  -- THE GLASS HOUSE
  ('33333333-3333-3333-3333-333333333313', 'nia@theglasshouse.com',     '{"first_name":"Nia","last_name":"Adeyemi"}',   now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333314', 'max@theglasshouse.com',     '{"first_name":"Max","last_name":"Pearce"}',    now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  -- ROSE HILL GARDENS
  ('33333333-3333-3333-3333-333333333315', 'dee@rosehillgardens.com',   '{"first_name":"Dee","last_name":"Langford"}',  now(), now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (id, venue_id, org_id, role, first_name, last_name) VALUES
  ('33333333-3333-3333-3333-333333333310', '22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Jordan', 'Ellis'),
  ('33333333-3333-3333-3333-333333333311', '22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Bex',    'Hollis'),
  ('33333333-3333-3333-3333-333333333312', '22222222-2222-2222-2222-222222222202', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Sam',    'Wyatt'),
  ('33333333-3333-3333-3333-333333333313', '22222222-2222-2222-2222-222222222203', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Nia',    'Adeyemi'),
  ('33333333-3333-3333-3333-333333333314', '22222222-2222-2222-2222-222222222203', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Max',    'Pearce'),
  ('33333333-3333-3333-3333-333333333315', '22222222-2222-2222-2222-222222222204', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Dee',    'Langford')
ON CONFLICT (id) DO NOTHING;


-- -----------------------------------------------------------------
-- TASK 2.2 (cont) — Consultant metrics (last 30 days)
-- -----------------------------------------------------------------
-- One row per new team member, period = today-30 → today.
INSERT INTO consultant_metrics (
  id, venue_id, consultant_id, period_start, period_end,
  inquiries_handled, tours_booked, bookings_closed,
  conversion_rate, avg_response_time_minutes, avg_booking_value
) VALUES
  -- Jordan Ellis — Hawthorne, solid all-around coordinator
  ('c0000003-0010-0001-0001-000000000001',
   '22222222-2222-2222-2222-222222222201',
   '33333333-3333-3333-3333-333333333310',
   (CURRENT_DATE - INTERVAL '30 days')::date, CURRENT_DATE,
   18, 12, 7, 0.3889, 28, 15400),

  -- Bex Hollis — Hawthorne, newer, learning
  ('c0000003-0011-0001-0001-000000000001',
   '22222222-2222-2222-2222-222222222201',
   '33333333-3333-3333-3333-333333333311',
   (CURRENT_DATE - INTERVAL '30 days')::date, CURRENT_DATE,
   11, 6, 3, 0.2727, 52, 14200),

  -- Sam Wyatt — Crestwood, high volume rural venue
  ('c0000003-0012-0001-0001-000000000001',
   '22222222-2222-2222-2222-222222222202',
   '33333333-3333-3333-3333-333333333312',
   (CURRENT_DATE - INTERVAL '30 days')::date, CURRENT_DATE,
   24, 14, 9, 0.3750, 42, 9200),

  -- Nia Adeyemi — Glass House, top performer, very fast
  ('c0000003-0013-0001-0001-000000000001',
   '22222222-2222-2222-2222-222222222203',
   '33333333-3333-3333-3333-333333333313',
   (CURRENT_DATE - INTERVAL '30 days')::date, CURRENT_DATE,
   21, 15, 12, 0.5714, 18, 18500),

  -- Max Pearce — Glass House, slower on email, strong conversion
  ('c0000003-0014-0001-0001-000000000001',
   '22222222-2222-2222-2222-222222222203',
   '33333333-3333-3333-3333-333333333314',
   (CURRENT_DATE - INTERVAL '30 days')::date, CURRENT_DATE,
   14, 9, 6, 0.4286, 78, 17900),

  -- Dee Langford — Rose Hill, part-time, boutique
  ('c0000003-0015-0001-0001-000000000001',
   '22222222-2222-2222-2222-222222222204',
   '33333333-3333-3333-3333-333333333315',
   (CURRENT_DATE - INTERVAL '30 days')::date, CURRENT_DATE,
   8, 5, 3, 0.3750, 95, 10600)
ON CONFLICT (id) DO NOTHING;


-- -----------------------------------------------------------------
-- TASK 2.3 — Per-venue avg response time (feature_flags JSONB)
-- -----------------------------------------------------------------
UPDATE venue_config SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || '{"avg_response_time_minutes": 32}'::jsonb WHERE venue_id = '22222222-2222-2222-2222-222222222201';
UPDATE venue_config SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || '{"avg_response_time_minutes": 58}'::jsonb WHERE venue_id = '22222222-2222-2222-2222-222222222202';
UPDATE venue_config SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || '{"avg_response_time_minutes": 24}'::jsonb WHERE venue_id = '22222222-2222-2222-2222-222222222203';
UPDATE venue_config SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || '{"avg_response_time_minutes": 71}'::jsonb WHERE venue_id = '22222222-2222-2222-2222-222222222204';


-- -----------------------------------------------------------------
-- TASK 2.6 — Tours (5 per venue, mixed outcomes)
-- -----------------------------------------------------------------
-- Columns: id, venue_id, wedding_id, scheduled_at, tour_type,
--          conducted_by, source, outcome, booking_date,
--          competing_venues, notes
--
-- NOTE: tours_outcome_check only allows
--   ('completed','cancelled','no_show','rescheduled').
-- Mapping the requested spec onto those values:
--   booked         → completed (+ booking_date set; linked to booked wedding)
--   no-show        → no_show
--   follow-up-sent → completed (tour happened; follow-up state lives elsewhere)
--   pending        → outcome = NULL (future tour, not yet held)
INSERT INTO tours (id, venue_id, wedding_id, scheduled_at, tour_type, conducted_by, source, outcome, booking_date, competing_venues, notes) VALUES

  -- ═══════════════════════════════════════════════════════════
  -- HAWTHORNE MANOR — venue 201, led by Jordan Ellis / Bex Hollis
  -- ═══════════════════════════════════════════════════════════
  ('70707070-0000-0001-0201-000000000001',
   '22222222-2222-2222-2222-222222222201',
   '44444444-4444-4444-4444-444444000101',
   (now() - INTERVAL '42 days'), 'in_person',
   '33333333-3333-3333-3333-333333333310', 'the_knot', 'completed',
   (CURRENT_DATE - INTERVAL '38 days'), ARRAY['Crestwood Farm','Oakhaven Estate'],
   'Loved the orangery. Signed contract four days after tour.'),

  ('70707070-0000-0001-0201-000000000002',
   '22222222-2222-2222-2222-222222222201',
   '44444444-4444-4444-4444-444444000102',
   (now() - INTERVAL '70 days'), 'in_person',
   '33333333-3333-3333-3333-333333333311', 'wedding_wire', 'completed',
   (CURRENT_DATE - INTERVAL '61 days'), ARRAY['The Glass House'],
   'Family tour, grandmother came too. Strong emotional connection.'),

  ('70707070-0000-0001-0201-000000000003',
   '22222222-2222-2222-2222-222222222201',
   NULL,
   (now() - INTERVAL '21 days'), 'in_person',
   '33333333-3333-3333-3333-333333333310', 'instagram', 'no_show',
   NULL, ARRAY['Rose Hill Gardens'],
   'Couple did not show. Two follow-up emails sent, no reply.'),

  ('70707070-0000-0001-0201-000000000004',
   '22222222-2222-2222-2222-222222222201',
   NULL,
   (now() - INTERVAL '9 days'), 'virtual',
   '33333333-3333-3333-3333-333333333311', 'referral', 'completed',
   NULL, ARRAY['Crestwood Farm'],
   'Virtual tour — bride is out-of-state. Proposal follow-up sent yesterday.'),

  ('70707070-0000-0001-0201-000000000005',
   '22222222-2222-2222-2222-222222222201',
   NULL,
   (now() + INTERVAL '6 days'), 'in_person',
   '33333333-3333-3333-3333-333333333310', 'the_knot', NULL,
   NULL, ARRAY['The Glass House','Oakhaven Estate'],
   'Saturday 2pm tour. Couple comparing three venues this weekend.'),

  -- ═══════════════════════════════════════════════════════════
  -- CRESTWOOD FARM — venue 202, led by Sam Wyatt
  -- ═══════════════════════════════════════════════════════════
  ('70707070-0000-0001-0202-000000000001',
   '22222222-2222-2222-2222-222222222202',
   '44444444-4444-4444-4444-444444000209',
   (now() - INTERVAL '55 days'), 'in_person',
   '33333333-3333-3333-3333-333333333312', 'the_knot', 'completed',
   (CURRENT_DATE - INTERVAL '48 days'), ARRAY['Hawthorne Manor'],
   'Rustic dream. Loved the barn lofts and the creek.'),

  ('70707070-0000-0001-0202-000000000002',
   '22222222-2222-2222-2222-222222222202',
   '44444444-4444-4444-4444-444444000210',
   (now() - INTERVAL '88 days'), 'in_person',
   '33333333-3333-3333-3333-333333333312', 'referral', 'completed',
   (CURRENT_DATE - INTERVAL '80 days'), ARRAY[]::text[],
   'Referred by 2024 bride. Only toured one venue — knew immediately.'),

  ('70707070-0000-0001-0202-000000000003',
   '22222222-2222-2222-2222-222222222202',
   NULL,
   (now() - INTERVAL '17 days'), 'in_person',
   '33333333-3333-3333-3333-333333333312', 'wedding_wire', 'no_show',
   NULL, ARRAY['Rose Hill Gardens'],
   'No-show. Texted day-of saying stuck in traffic but never arrived.'),

  ('70707070-0000-0001-0202-000000000004',
   '22222222-2222-2222-2222-222222222202',
   NULL,
   (now() - INTERVAL '5 days'), 'in_person',
   '33333333-3333-3333-3333-333333333312', 'instagram', 'completed',
   NULL, ARRAY['Hawthorne Manor','Rose Hill Gardens'],
   'Great tour, mother concerned about parking. Sent logistics follow-up.'),

  ('70707070-0000-0001-0202-000000000005',
   '22222222-2222-2222-2222-222222222202',
   NULL,
   (now() + INTERVAL '11 days'), 'in_person',
   '33333333-3333-3333-3333-333333333312', 'the_knot', NULL,
   NULL, ARRAY['Hawthorne Manor'],
   'Sunday morning tour scheduled. Couple is price-sensitive.'),

  -- ═══════════════════════════════════════════════════════════
  -- THE GLASS HOUSE — venue 203, led by Nia Adeyemi / Max Pearce
  -- ═══════════════════════════════════════════════════════════
  ('70707070-0000-0001-0203-000000000001',
   '22222222-2222-2222-2222-222222222203',
   '44444444-4444-4444-4444-444444000313',
   (now() - INTERVAL '49 days'), 'in_person',
   '33333333-3333-3333-3333-333333333313', 'instagram', 'completed',
   (CURRENT_DATE - INTERVAL '44 days'), ARRAY['Hawthorne Manor'],
   'Instagram ad → tour → booked in 5 days. Golden hour tour won them over.'),

  ('70707070-0000-0001-0203-000000000002',
   '22222222-2222-2222-2222-222222222203',
   '44444444-4444-4444-4444-444444000314',
   (now() - INTERVAL '74 days'), 'in_person',
   '33333333-3333-3333-3333-333333333314', 'the_knot', 'completed',
   (CURRENT_DATE - INTERVAL '66 days'), ARRAY['Oakhaven Estate','Rose Hill Gardens'],
   'Architecture couple — loved the modernist design. Premium package.'),

  ('70707070-0000-0001-0203-000000000003',
   '22222222-2222-2222-2222-222222222203',
   NULL,
   (now() - INTERVAL '26 days'), 'in_person',
   '33333333-3333-3333-3333-333333333313', 'wedding_wire', 'no_show',
   NULL, ARRAY['Hawthorne Manor'],
   'Couple cancelled morning-of via email. Offered to reschedule, no reply.'),

  ('70707070-0000-0001-0203-000000000004',
   '22222222-2222-2222-2222-222222222203',
   NULL,
   (now() - INTERVAL '12 days'), 'virtual',
   '33333333-3333-3333-3333-333333333314', 'referral', 'completed',
   NULL, ARRAY['Crestwood Farm'],
   'Virtual tour via Zoom. Sent pricing sheet and custom proposal afterward.'),

  ('70707070-0000-0001-0203-000000000005',
   '22222222-2222-2222-2222-222222222203',
   NULL,
   (now() + INTERVAL '4 days'), 'in_person',
   '33333333-3333-3333-3333-333333333313', 'instagram', NULL,
   NULL, ARRAY['Hawthorne Manor','Oakhaven Estate'],
   'Tour planned for next Thursday evening. Guest count ~140.'),

  -- ═══════════════════════════════════════════════════════════
  -- ROSE HILL GARDENS — venue 204, led by Dee Langford
  -- ═══════════════════════════════════════════════════════════
  ('70707070-0000-0001-0204-000000000001',
   '22222222-2222-2222-2222-222222222204',
   '44444444-4444-4444-4444-444444000407',
   (now() - INTERVAL '63 days'), 'in_person',
   '33333333-3333-3333-3333-333333333315', 'the_knot', 'completed',
   (CURRENT_DATE - INTERVAL '54 days'), ARRAY['Crestwood Farm'],
   'Garden ceremony lovers. Booked the rose arbor package.'),

  ('70707070-0000-0001-0204-000000000002',
   '22222222-2222-2222-2222-222222222204',
   '44444444-4444-4444-4444-444444000408',
   (now() - INTERVAL '95 days'), 'in_person',
   '33333333-3333-3333-3333-333333333315', 'referral', 'completed',
   (CURRENT_DATE - INTERVAL '86 days'), ARRAY[]::text[],
   'Former guest referral. Boutique micro-wedding, intimate feel.'),

  ('70707070-0000-0001-0204-000000000003',
   '22222222-2222-2222-2222-222222222204',
   NULL,
   (now() - INTERVAL '19 days'), 'in_person',
   '33333333-3333-3333-3333-333333333315', 'wedding_wire', 'no_show',
   NULL, ARRAY['Hawthorne Manor','The Glass House'],
   'No-show. Suspected they went with larger venue — budget mismatch.'),

  ('70707070-0000-0001-0204-000000000004',
   '22222222-2222-2222-2222-222222222204',
   NULL,
   (now() - INTERVAL '7 days'), 'in_person',
   '33333333-3333-3333-3333-333333333315', 'instagram', 'completed',
   NULL, ARRAY['Crestwood Farm'],
   'Loved the gardens. Waiting on parents to visit before deciding.'),

  ('70707070-0000-0001-0204-000000000005',
   '22222222-2222-2222-2222-222222222204',
   NULL,
   (now() + INTERVAL '14 days'), 'in_person',
   '33333333-3333-3333-3333-333333333315', 'the_knot', NULL,
   NULL, ARRAY['Crestwood Farm','The Glass House'],
   'Tour scheduled with couple and both sets of parents. Guest count ~85.')

ON CONFLICT (id) DO NOTHING;


-- =================================================================
-- VERIFICATION
-- =================================================================
SELECT 'user_profiles_total' as metric, COUNT(*)::text as value FROM user_profiles WHERE venue_id::text LIKE '22222222%'
UNION ALL SELECT 'user_profiles_new',   COUNT(*)::text FROM user_profiles WHERE id IN (
  '33333333-3333-3333-3333-333333333310','33333333-3333-3333-3333-333333333311',
  '33333333-3333-3333-3333-333333333312','33333333-3333-3333-3333-333333333313',
  '33333333-3333-3333-3333-333333333314','33333333-3333-3333-3333-333333333315')
UNION ALL SELECT 'consultant_metrics_new', COUNT(*)::text FROM consultant_metrics WHERE id::text LIKE 'c0000003-%'
UNION ALL SELECT 'tours_total',  COUNT(*)::text FROM tours WHERE venue_id::text LIKE '22222222%'
UNION ALL SELECT 'tours_new',    COUNT(*)::text FROM tours WHERE id::text LIKE '70707070-0000-0001-%'
UNION ALL SELECT 'venue_config_response_times', COUNT(*)::text FROM venue_config WHERE feature_flags ? 'avg_response_time_minutes' AND venue_id::text LIKE '22222222%';
