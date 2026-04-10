-- P7.1: Seed lost_deals for all four demo venues
-- wedding_id is NULL because these were lost leads, not booked weddings
-- Guarded against duplicates via NOT EXISTS on (venue_id, reason_detail, lost_at)

-- HAWTHORNE MANOR (venue 201)
INSERT INTO public.lost_deals (id, venue_id, wedding_id, lost_at_stage, reason_category, reason_detail, competitor_name, recovery_attempted, recovery_outcome, lost_at, created_at)
SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222201', NULL, 'tour', 'competitor',
       'Went with The Vineyard — preferred outdoor ceremony option', 'The Vineyard', false, NULL,
       '2025-09-14 16:00:00+00', '2025-09-14 16:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.lost_deals
  WHERE venue_id = '22222222-2222-2222-2222-222222222201'
    AND reason_detail = 'Went with The Vineyard — preferred outdoor ceremony option'
    AND lost_at = '2025-09-14 16:00:00+00'
);

INSERT INTO public.lost_deals (id, venue_id, wedding_id, lost_at_stage, reason_category, reason_detail, competitor_name, recovery_attempted, recovery_outcome, lost_at, created_at)
SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222201', NULL, 'inquiry', 'pricing',
       'Our minimum was above their budget', NULL, false, NULL,
       '2025-11-08 10:00:00+00', '2025-11-08 10:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.lost_deals
  WHERE venue_id = '22222222-2222-2222-2222-222222222201'
    AND reason_detail = 'Our minimum was above their budget'
    AND lost_at = '2025-11-08 10:00:00+00'
);

INSERT INTO public.lost_deals (id, venue_id, wedding_id, lost_at_stage, reason_category, reason_detail, competitor_name, recovery_attempted, recovery_outcome, lost_at, created_at)
SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222201', NULL, 'inquiry', 'date_unavailable',
       'Wanted July 4th weekend, fully booked', NULL, false, NULL,
       '2026-01-22 12:00:00+00', '2026-01-22 12:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.lost_deals
  WHERE venue_id = '22222222-2222-2222-2222-222222222201'
    AND reason_detail = 'Wanted July 4th weekend, fully booked'
    AND lost_at = '2026-01-22 12:00:00+00'
);

INSERT INTO public.lost_deals (id, venue_id, wedding_id, lost_at_stage, reason_category, reason_detail, competitor_name, recovery_attempted, recovery_outcome, lost_at, created_at)
SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222201', NULL, 'tour', 'no_response',
       'Went cold after the tour. 3 follow-ups, no reply.', NULL, true, 'no_response',
       '2026-02-15 15:00:00+00', '2026-02-15 15:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.lost_deals
  WHERE venue_id = '22222222-2222-2222-2222-222222222201'
    AND reason_detail = 'Went cold after the tour. 3 follow-ups, no reply.'
    AND lost_at = '2026-02-15 15:00:00+00'
);

-- CRESTWOOD FARM (venue 202)
INSERT INTO public.lost_deals (id, venue_id, wedding_id, lost_at_stage, reason_category, reason_detail, competitor_name, recovery_attempted, recovery_outcome, lost_at, created_at)
SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222202', NULL, 'tour', 'competitor',
       'Chose a barn venue closer to home', NULL, false, NULL,
       '2025-10-20 14:00:00+00', '2025-10-20 14:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.lost_deals
  WHERE venue_id = '22222222-2222-2222-2222-222222222202'
    AND reason_detail = 'Chose a barn venue closer to home'
    AND lost_at = '2025-10-20 14:00:00+00'
);

INSERT INTO public.lost_deals (id, venue_id, wedding_id, lost_at_stage, reason_category, reason_detail, competitor_name, recovery_attempted, recovery_outcome, lost_at, created_at)
SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222202', NULL, 'inquiry', 'pricing',
       'Needed a lower price point', NULL, false, NULL,
       '2026-01-10 09:00:00+00', '2026-01-10 09:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.lost_deals
  WHERE venue_id = '22222222-2222-2222-2222-222222222202'
    AND reason_detail = 'Needed a lower price point'
    AND lost_at = '2026-01-10 09:00:00+00'
);

INSERT INTO public.lost_deals (id, venue_id, wedding_id, lost_at_stage, reason_category, reason_detail, competitor_name, recovery_attempted, recovery_outcome, lost_at, created_at)
SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222202', NULL, 'tour', 'no_response',
       'Toured but never replied to follow-up', NULL, true, 'no_response',
       '2026-03-01 11:30:00+00', '2026-03-01 11:30:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.lost_deals
  WHERE venue_id = '22222222-2222-2222-2222-222222222202'
    AND reason_detail = 'Toured but never replied to follow-up'
    AND lost_at = '2026-03-01 11:30:00+00'
);

-- THE GLASS HOUSE (venue 203)
INSERT INTO public.lost_deals (id, venue_id, wedding_id, lost_at_stage, reason_category, reason_detail, competitor_name, recovery_attempted, recovery_outcome, lost_at, created_at)
SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222203', NULL, 'tour', 'no_response',
       'High-value lead, went cold after receiving proposal', NULL, true, 'no_response',
       '2025-08-30 13:00:00+00', '2025-08-30 13:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.lost_deals
  WHERE venue_id = '22222222-2222-2222-2222-222222222203'
    AND reason_detail = 'High-value lead, went cold after receiving proposal'
    AND lost_at = '2025-08-30 13:00:00+00'
);

INSERT INTO public.lost_deals (id, venue_id, wedding_id, lost_at_stage, reason_category, reason_detail, competitor_name, recovery_attempted, recovery_outcome, lost_at, created_at)
SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222203', NULL, 'tour', 'competitor',
       'Chose a hotel ballroom — wanted more catering control', 'The Atrium', false, NULL,
       '2025-12-05 17:00:00+00', '2025-12-05 17:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.lost_deals
  WHERE venue_id = '22222222-2222-2222-2222-222222222203'
    AND reason_detail = 'Chose a hotel ballroom — wanted more catering control'
    AND lost_at = '2025-12-05 17:00:00+00'
);

INSERT INTO public.lost_deals (id, venue_id, wedding_id, lost_at_stage, reason_category, reason_detail, competitor_name, recovery_attempted, recovery_outcome, lost_at, created_at)
SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222203', NULL, 'inquiry', 'pricing',
       'Loved the venue but couldn''t stretch to our minimum', NULL, false, NULL,
       '2026-02-18 10:00:00+00', '2026-02-18 10:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.lost_deals
  WHERE venue_id = '22222222-2222-2222-2222-222222222203'
    AND reason_detail = 'Loved the venue but couldn''t stretch to our minimum'
    AND lost_at = '2026-02-18 10:00:00+00'
);

-- ROSE HILL GARDENS (venue 204)
INSERT INTO public.lost_deals (id, venue_id, wedding_id, lost_at_stage, reason_category, reason_detail, competitor_name, recovery_attempted, recovery_outcome, lost_at, created_at)
SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222204', NULL, 'inquiry', 'date_unavailable',
       'Wanted September, all booked', NULL, false, NULL,
       '2025-11-25 09:30:00+00', '2025-11-25 09:30:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.lost_deals
  WHERE venue_id = '22222222-2222-2222-2222-222222222204'
    AND reason_detail = 'Wanted September, all booked'
    AND lost_at = '2025-11-25 09:30:00+00'
);

INSERT INTO public.lost_deals (id, venue_id, wedding_id, lost_at_stage, reason_category, reason_detail, competitor_name, recovery_attempted, recovery_outcome, lost_at, created_at)
SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222204', NULL, 'inquiry', 'pricing',
       'Below minimum spend', NULL, false, NULL,
       '2026-02-28 14:00:00+00', '2026-02-28 14:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.lost_deals
  WHERE venue_id = '22222222-2222-2222-2222-222222222204'
    AND reason_detail = 'Below minimum spend'
    AND lost_at = '2026-02-28 14:00:00+00'
);
