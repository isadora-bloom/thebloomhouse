-- P1.1: Seed messages threads for demo
-- Uses public.messages (venue-scoped couple/coordinator chat)

-- Clean any prior seed rows in these threads (idempotent)
DELETE FROM public.messages
WHERE venue_id IN (
  '22222222-2222-2222-2222-222222222201',
  '22222222-2222-2222-2222-222222222202'
)
  AND wedding_id IN (
    '44444444-4444-4444-4444-444444000102',
    '44444444-4444-4444-4444-444444000201'
  )
  AND created_at >= '2026-03-10'
  AND created_at <  '2026-03-20';

-- THREAD 1 (Hawthorne) — Planning check-in, Sophie & James Whitfield
INSERT INTO public.messages (id, venue_id, wedding_id, sender_id, sender_role, content, created_at)
VALUES
  (
    gen_random_uuid(),
    '22222222-2222-2222-2222-222222222201',
    '44444444-4444-4444-4444-444444000102',
    '33333333-3333-3333-3333-333333333310',
    'coordinator',
    'Hi Sophie and James! Just checking in — you''re about 5 months out now. Have you had a chance to finalise your guest list? We''ll need final numbers by the end of next month for catering.',
    '2026-03-10 09:14:00+00'
  ),
  (
    gen_random_uuid(),
    '22222222-2222-2222-2222-222222222201',
    '44444444-4444-4444-4444-444444000102',
    NULL,
    'couple',
    'Hi Jordan! Yes we''re getting close — we think around 145 guests. James''s side keeps growing! We''ll have a firm number to you by April 15th.',
    '2026-03-10 14:32:00+00'
  ),
  (
    gen_random_uuid(),
    '22222222-2222-2222-2222-222222222201',
    '44444444-4444-4444-4444-444444000102',
    '33333333-3333-3333-3333-333333333310',
    'coordinator',
    'Perfect, 145 is well within capacity. No rush — April 15th works great. Let me know if you have any questions in the meantime!',
    '2026-03-11 08:55:00+00'
  );

-- THREAD 2 (Hawthorne) — Catering kitchen access question
INSERT INTO public.messages (id, venue_id, wedding_id, sender_id, sender_role, content, created_at)
VALUES
  (
    gen_random_uuid(),
    '22222222-2222-2222-2222-222222222201',
    '44444444-4444-4444-4444-444444000102',
    NULL,
    'couple',
    'Quick question — our caterer mentioned they need access to the kitchen from 11am. Is that okay?',
    '2026-03-18 11:02:00+00'
  ),
  (
    gen_random_uuid(),
    '22222222-2222-2222-2222-222222222201',
    '44444444-4444-4444-4444-444444000102',
    '33333333-3333-3333-3333-333333333310',
    'coordinator',
    'Absolutely — kitchen access from 11am is no problem at all. I''ll make a note and include it in your day-of timeline.',
    '2026-03-18 11:45:00+00'
  );

-- THREAD 3 (Crestwood) — Sofia Patel & Noah Kim, ceremony start time
INSERT INTO public.messages (id, venue_id, wedding_id, sender_id, sender_role, content, created_at)
VALUES
  (
    gen_random_uuid(),
    '22222222-2222-2222-2222-222222222202',
    '44444444-4444-4444-4444-444444000201',
    NULL,
    'couple',
    'Hi! We''re thinking of pushing our ceremony start time to 4:30pm instead of 4:00pm so guests have a bit more buffer. Does that still work with the timeline?',
    '2026-03-14 10:20:00+00'
  ),
  (
    gen_random_uuid(),
    '22222222-2222-2222-2222-222222222202',
    '44444444-4444-4444-4444-444444000201',
    NULL,
    'coordinator',
    'Hi Sofia and Noah — 4:30pm works beautifully. Golden hour will still hit perfectly for your portraits and it gives everyone a bit more breathing room. I''ll update the timeline and send a revised draft over this week.',
    '2026-03-14 13:08:00+00'
  );
