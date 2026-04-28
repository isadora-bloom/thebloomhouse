-- ============================================================================
-- Seed: Deduplication scenarios + Email sequences
-- ============================================================================
-- Schema constraints discovered:
--   client_match_queue.match_type: 'email' | 'phone' | 'name'
--   client_match_queue.status:     'pending' | 'merged' | 'dismissed'
--   follow_up_sequences.trigger_type: 'post_tour' | 'ghosted' | 'post_booking' | 'pre_event' | 'custom'
--   sequence_steps.action_type:    'email' | 'task' | 'alert'
--   wedding_sequences.status:      'active' | 'paused' | 'completed' | 'cancelled'
--   people.role: 'partner1' | 'partner2' | 'guest' | 'wedding_party' | 'vendor' | 'family'
-- Notes:
--   - 'name+email' collapses to 'name' (no composite in constraint)
--   - 'cross_venue' collapses to 'email' (same email across venues)
--   - 'new_inquiry' not in trigger_type; using 'custom'
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- P4: DEDUPLICATION SCENARIOS
-- ---------------------------------------------------------------------------

-- Clean re-runs
DELETE FROM client_match_queue
 WHERE id IN (
   'dddddddd-0000-0000-0000-000000000a01',
   'dddddddd-0000-0000-0000-000000000b01',
   'dddddddd-0000-0000-0000-000000000c01',
   'dddddddd-0000-0000-0000-000000000d01'
 );

DELETE FROM people
 WHERE id IN (
   -- Scenario A
   'eeeeeeee-0000-0000-0000-00000000a001',
   'eeeeeeee-0000-0000-0000-00000000a002',
   -- Scenario B
   'eeeeeeee-0000-0000-0000-00000000b001',
   'eeeeeeee-0000-0000-0000-00000000b002',
   -- Scenario C
   'eeeeeeee-0000-0000-0000-00000000c001',
   'eeeeeeee-0000-0000-0000-00000000c002',
   -- Scenario D
   'eeeeeeee-0000-0000-0000-00000000d001',
   'eeeeeeee-0000-0000-0000-00000000d002'
 );

DELETE FROM weddings
 WHERE id IN (
   -- Scenario B (new Crestwood inquiry)
   'abcdef00-0000-0000-0000-0000000000b2',
   -- Scenario C (two new Glass House inquiries)
   'abcdef00-0000-0000-0000-0000000000c1',
   'abcdef00-0000-0000-0000-0000000000c2',
   -- Scenario D (two new inquiries — Glass House + Hawthorne)
   'abcdef00-0000-0000-0000-0000000000d1',
   'abcdef00-0000-0000-0000-0000000000d2'
 );

-- ========================= SCENARIO A =====================================
-- Same couple, two inquiry forms (Hawthorne)
-- Use existing Hawthorne inquiry wedding ab000000-0000-0000-0000-000000000006
INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name, email, phone, created_at)
VALUES
  ('eeeeeeee-0000-0000-0000-00000000a001',
   '22222222-2222-2222-2222-222222222201',
   'ab000000-0000-0000-0000-000000000006',
   'partner1', 'Sophie', 'Whitfield', 'sophie.whitfield@gmail.com', NULL,
   NOW() - INTERVAL '9 days'),
  ('eeeeeeee-0000-0000-0000-00000000a002',
   '22222222-2222-2222-2222-222222222201',
   'ab000000-0000-0000-0000-000000000006',
   'partner1', 'Sophie M', 'Whitfield', 'sophiewhitfield@gmail.com', NULL,
   NOW() - INTERVAL '7 days');

INSERT INTO client_match_queue
  (id, venue_id, client_a_id, client_b_id, match_type, confidence, status, created_at)
VALUES
  ('dddddddd-0000-0000-0000-000000000a01',
   '22222222-2222-2222-2222-222222222201',
   'eeeeeeee-0000-0000-0000-00000000a001',
   'eeeeeeee-0000-0000-0000-00000000a002',
   'name',           -- was 'name+email'; constraint allows name|email|phone
   0.92,
   'pending',
   NOW() - INTERVAL '6 days');

-- ========================= SCENARIO B =====================================
-- Phone vs web form (Crestwood) — two different weddings
-- Existing inquiry: 44444444-4444-4444-4444-444444000212
-- New inquiry: abcdef00-0000-0000-0000-0000000000b2
INSERT INTO weddings (id, venue_id, status, source, source_detail, wedding_date,
                      inquiry_date, created_at, updated_at)
VALUES
  ('abcdef00-0000-0000-0000-0000000000b2',
   '22222222-2222-2222-2222-222222222202',
   'inquiry', 'website', 'web form', '2026-11-14',
   NOW() - INTERVAL '4 days',
   NOW() - INTERVAL '4 days',
   NOW() - INTERVAL '4 days');

INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name, email, phone, created_at)
VALUES
  ('eeeeeeee-0000-0000-0000-00000000b001',
   '22222222-2222-2222-2222-222222222202',
   '44444444-4444-4444-4444-444444000212',
   'partner1', 'James', 'Osei', 'jamesosei@outlook.com', '+1-555-208-4411',
   NOW() - INTERVAL '12 days'),
  ('eeeeeeee-0000-0000-0000-00000000b002',
   '22222222-2222-2222-2222-222222222202',
   'abcdef00-0000-0000-0000-0000000000b2',
   'partner1', 'James', 'O', 'james.osei@outlook.com', NULL,
   NOW() - INTERVAL '4 days');

INSERT INTO client_match_queue
  (id, venue_id, client_a_id, client_b_id, match_type, confidence, status, created_at)
VALUES
  ('dddddddd-0000-0000-0000-000000000b01',
   '22222222-2222-2222-2222-222222222202',
   'eeeeeeee-0000-0000-0000-00000000b001',
   'eeeeeeee-0000-0000-0000-00000000b002',
   'email',
   0.78,
   'pending',
   NOW() - INTERVAL '3 days');

-- ========================= SCENARIO C =====================================
-- Genuinely different (Glass House) — LOW confidence
-- Two brand new Glass House inquiry weddings
INSERT INTO weddings (id, venue_id, status, source, source_detail, wedding_date,
                      inquiry_date, created_at, updated_at)
VALUES
  ('abcdef00-0000-0000-0000-0000000000c1',
   '22222222-2222-2222-2222-222222222203',
   'inquiry', 'website', 'inquiry form', '2026-05-30',
   NOW() - INTERVAL '14 days',
   NOW() - INTERVAL '14 days',
   NOW() - INTERVAL '14 days'),
  ('abcdef00-0000-0000-0000-0000000000c2',
   '22222222-2222-2222-2222-222222222203',
   'inquiry', 'website', 'inquiry form', '2026-09-12',
   NOW() - INTERVAL '10 days',
   NOW() - INTERVAL '10 days',
   NOW() - INTERVAL '10 days');

INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name, email, phone, created_at)
VALUES
  ('eeeeeeee-0000-0000-0000-00000000c001',
   '22222222-2222-2222-2222-222222222203',
   'abcdef00-0000-0000-0000-0000000000c1',
   'partner1', 'Emma', 'Foster', 'emmafoster@gmail.com', NULL,
   NOW() - INTERVAL '14 days'),
  ('eeeeeeee-0000-0000-0000-00000000c002',
   '22222222-2222-2222-2222-222222222203',
   'abcdef00-0000-0000-0000-0000000000c2',
   'partner1', 'Emma', 'Foster-Hughes', 'emma.foster@yahoo.com', NULL,
   NOW() - INTERVAL '10 days');

INSERT INTO client_match_queue
  (id, venue_id, client_a_id, client_b_id, match_type, confidence, status, created_at)
VALUES
  ('dddddddd-0000-0000-0000-000000000c01',
   '22222222-2222-2222-2222-222222222203',
   'eeeeeeee-0000-0000-0000-00000000c001',
   'eeeeeeee-0000-0000-0000-00000000c002',
   'name',
   0.35,
   'pending',
   NOW() - INTERVAL '9 days');

-- ========================= SCENARIO D =====================================
-- Cross-venue same person (Glass House + Hawthorne)
INSERT INTO weddings (id, venue_id, status, source, source_detail, wedding_date,
                      inquiry_date, created_at, updated_at)
VALUES
  ('abcdef00-0000-0000-0000-0000000000d1',
   '22222222-2222-2222-2222-222222222203',
   'inquiry', 'website', 'inquiry form', '2026-10-17',
   NOW() - INTERVAL '8 days',
   NOW() - INTERVAL '8 days',
   NOW() - INTERVAL '8 days'),
  ('abcdef00-0000-0000-0000-0000000000d2',
   '22222222-2222-2222-2222-222222222201',
   'inquiry', 'website', 'inquiry form', '2026-10-17',
   NOW() - INTERVAL '5 days',
   NOW() - INTERVAL '5 days',
   NOW() - INTERVAL '5 days');

INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name, email, phone, created_at)
VALUES
  ('eeeeeeee-0000-0000-0000-00000000d001',
   '22222222-2222-2222-2222-222222222203',
   'abcdef00-0000-0000-0000-0000000000d1',
   'partner1', 'Chloe', 'Ashford', 'chloe.ashford@gmail.com', NULL,
   NOW() - INTERVAL '8 days'),
  ('eeeeeeee-0000-0000-0000-00000000d002',
   '22222222-2222-2222-2222-222222222201',
   'abcdef00-0000-0000-0000-0000000000d2',
   'partner1', 'Chloe', 'Ashford', 'chloe.ashford@gmail.com', NULL,
   NOW() - INTERVAL '5 days');

-- Note: cross-venue flagged with match_type='email' (constraint only allows
-- name|phone|email; the shared email is the strongest signal)
INSERT INTO client_match_queue
  (id, venue_id, client_a_id, client_b_id, match_type, confidence, status, created_at)
VALUES
  ('dddddddd-0000-0000-0000-000000000d01',
   '22222222-2222-2222-2222-222222222203',
   'eeeeeeee-0000-0000-0000-00000000d001',
   'eeeeeeee-0000-0000-0000-00000000d002',
   'email',
   0.95,
   'pending',
   NOW() - INTERVAL '4 days');


-- ---------------------------------------------------------------------------
-- P5: EMAIL SEQUENCES (Hawthorne Manor)
-- ---------------------------------------------------------------------------

-- Clean re-runs.
-- Migration 040 dropped wedding_sequences + follow_up_sequence_templates
-- (renamed to _archived_*); the canonical sequence-tracking system is now
-- follow_up_sequences + sequence_steps with no per-wedding enrollment table
-- (the cron service walks weddings dynamically). Only delete from the
-- still-existing tables.
DELETE FROM sequence_steps
 WHERE sequence_id IN (
   'f0000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000002',
   'f0000000-0000-0000-0000-000000000003'
 );

DELETE FROM follow_up_sequences
 WHERE id IN (
   'f0000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000002',
   'f0000000-0000-0000-0000-000000000003'
 );

-- follow_up_sequence_templates was the parallel template table dropped
-- by migration 040 (renamed to _archived_*). All template content now
-- lives in follow_up_sequences + sequence_steps below.

-- ========================= SEQUENCE 1: Post-Inquiry Nurture ===============
INSERT INTO follow_up_sequences
  (id, venue_id, name, description, trigger_type, trigger_config, is_active, created_at)
VALUES
  ('f0000000-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222201',
   'Post-Inquiry Nurture',
   'Initial outreach to fresh leads',
   'custom',
   '{"intent": "new_inquiry"}'::jsonb,
   true,
   NOW() - INTERVAL '45 days');

INSERT INTO sequence_steps
  (id, sequence_id, step_order, delay_days, action_type,
   email_subject_template, email_body_template, is_active, created_at)
VALUES
  ('f1000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000001', 1, 0, 'email',
   'Hi {{first_name}} — thanks for reaching out to {{venue_name}}',
   'Thanks for your interest in hosting your wedding at {{venue_name}}. We''d love to learn more about what you''re envisioning. Could you share your date, guest count, and a bit about your vision?',
   true, NOW() - INTERVAL '45 days'),
  ('f1000000-0000-0000-0000-000000000002',
   'f0000000-0000-0000-0000-000000000001', 2, 2, 'email',
   'Did you get a chance to look through our info?',
   'Hi {{first_name}}, just checking in to see if our pricing guide and venue details answered your initial questions. Happy to jump on a quick call if that''s easier.',
   true, NOW() - INTERVAL '45 days'),
  ('f1000000-0000-0000-0000-000000000003',
   'f0000000-0000-0000-0000-000000000001', 3, 5, 'email',
   'Would you like to schedule a tour?',
   'Hi {{first_name}}, the best way to get a feel for {{venue_name}} is in person. We have a few openings next week — would a Saturday morning tour work for you?',
   true, NOW() - INTERVAL '45 days'),
  ('f1000000-0000-0000-0000-000000000004',
   'f0000000-0000-0000-0000-000000000001', 4, 10, 'email',
   'Still thinking it over?',
   'Hi {{first_name}}, I know planning takes time. Just wanted to check in one more time and see if {{venue_name}} is still on your shortlist. If your priorities have shifted, I''d love to hear about it either way.',
   true, NOW() - INTERVAL '45 days');

-- ========================= SEQUENCE 2: Post-Tour Follow-Up ================
INSERT INTO follow_up_sequences
  (id, venue_id, name, description, trigger_type, trigger_config, is_active, created_at)
VALUES
  ('f0000000-0000-0000-0000-000000000002',
   '22222222-2222-2222-2222-222222222201',
   'Post-Tour Follow-Up',
   'Structured check-ins after a venue tour',
   'post_tour',
   '{}'::jsonb,
   true,
   NOW() - INTERVAL '60 days');

INSERT INTO sequence_steps
  (id, sequence_id, step_order, delay_days, action_type,
   email_subject_template, email_body_template, is_active, created_at)
VALUES
  ('f2000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000002', 1, 1, 'email',
   'It was so nice meeting you, {{first_name}}',
   'Thanks for visiting {{venue_name}} yesterday — it was lovely getting to know you and hearing about your plans. I''ve attached the pricing sheet we discussed. Let me know if any questions come up as you think it over.',
   true, NOW() - INTERVAL '60 days'),
  ('f2000000-0000-0000-0000-000000000002',
   'f0000000-0000-0000-0000-000000000002', 2, 3, 'email',
   'Any questions bubbling up after your visit?',
   'Hi {{first_name}}, now that you''ve had a few days to sit with the tour, I wanted to check in. Sometimes the questions don''t land until later — happy to hop on a quick call whenever works for you.',
   true, NOW() - INTERVAL '60 days'),
  ('f2000000-0000-0000-0000-000000000003',
   'f0000000-0000-0000-0000-000000000002', 3, 7, 'email',
   'Where are you landing on {{venue_name}}?',
   'Hi {{first_name}}, I wanted to reach out one more time to see where you''re leaning. Your date is still open, but I want to be transparent — we''ve had a couple of inquiries for that weekend. No pressure, just wanted you to know.',
   true, NOW() - INTERVAL '60 days');

-- ========================= SEQUENCE 3: Ghosted Re-Engagement ==============
INSERT INTO follow_up_sequences
  (id, venue_id, name, description, trigger_type, trigger_config, is_active, created_at)
VALUES
  ('f0000000-0000-0000-0000-000000000003',
   '22222222-2222-2222-2222-222222222201',
   'Ghosted Re-Engagement',
   'Gentle reactivation for leads who went quiet',
   'ghosted',
   '{"days_since_contact": 21}'::jsonb,
   true,
   NOW() - INTERVAL '30 days');

INSERT INTO sequence_steps
  (id, sequence_id, step_order, delay_days, action_type,
   email_subject_template, email_body_template, is_active, created_at)
VALUES
  ('f3000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000003', 1, 0, 'email',
   'Hi {{first_name}} — still there?',
   'Hey {{first_name}}, I haven''t heard from you in a bit and wanted to circle back. Life gets busy, I totally get it. If {{venue_name}} is still on your list, just reply and I''ll pick things up where we left off.',
   true, NOW() - INTERVAL '30 days'),
  ('f3000000-0000-0000-0000-000000000002',
   'f0000000-0000-0000-0000-000000000003', 2, 7, 'email',
   'One last check-in',
   'Hi {{first_name}}, this will be my last note unless I hear back. If you''ve chosen another venue or pushed your plans, no worries at all — I''d just love to know so I can stop cluttering your inbox. Wishing you the best either way.',
   true, NOW() - INTERVAL '30 days');

-- ---------------------------------------------------------------------------
-- ENROLL WEDDINGS — REMOVED
-- ---------------------------------------------------------------------------
-- Migration 040 dropped wedding_sequences (renamed to
-- _archived_wedding_sequences). The current cron-driven follow-up
-- system in src/lib/services/follow-up-sequences.ts walks weddings
-- dynamically against the sequences seeded above; no per-wedding
-- enrollment table is required. Demo data for "this wedding is
-- enrolled" is now derivable from wedding status + heat score, so
-- the explicit INSERTs are removed.

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
SELECT 'client_match_queue' AS t, COUNT(*) AS n FROM client_match_queue WHERE status = 'pending'
UNION ALL SELECT 'follow_up_sequences', COUNT(*) FROM follow_up_sequences
  WHERE venue_id = '22222222-2222-2222-2222-222222222201'
UNION ALL SELECT 'sequence_steps', COUNT(*) FROM sequence_steps
  WHERE sequence_id IN (
    SELECT id FROM follow_up_sequences WHERE venue_id = '22222222-2222-2222-2222-222222222201'
  );
-- wedding_sequences COUNT removed: table dropped by migration 040.
