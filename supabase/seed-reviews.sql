-- ============================================
-- SEED: Reviews + extracted phrases for 4 demo venues
-- Populates both:
--   1. reviews table (raw 3rd-party reviews)
--   2. review_language table (AI-extracted phrases for the existing UI)
-- ============================================

-- ============================================
-- RAW REVIEWS (12 total: 3 per venue)
-- ============================================

INSERT INTO reviews (venue_id, source, reviewer_name, rating, body, review_date, sentiment_score, themes, is_featured) VALUES
  -- Hawthorne Manor
  ('22222222-2222-2222-2222-222222222201', 'google', 'Sarah & Michael K.', 5,
    'The most beautiful venue — our day was absolutely perfect. Jordan made everything seamless. Every detail was thought of and the grounds were stunning at golden hour.',
    '2025-10-12', 0.95, ARRAY['coordinator','space','experience'], true),
  ('22222222-2222-2222-2222-222222222201', 'the_knot', 'Emma & David L.', 5,
    'Stunning property, incredible staff. We couldn''t have asked for more. The bridal suite was a dream and the manor itself felt like something out of a fairytale.',
    '2025-12-01', 0.92, ARRAY['space','experience','accommodation'], false),
  ('22222222-2222-2222-2222-222222222201', 'wedding_wire', 'Jessica & Tom P.', 4,
    'Beautiful venue, minor hiccup with timing but overall wonderful. The team was responsive and the gardens are unmatched.',
    '2026-01-08', 0.65, ARRAY['space','process'], false),

  -- Crestwood Farm
  ('22222222-2222-2222-2222-222222222202', 'google', 'Olivia & Ryan M.', 5,
    'A hidden gem. The farm setting was exactly what we wanted — rustic but elegant. Our guests are still talking about it.',
    '2025-09-20', 0.93, ARRAY['space','experience'], true),
  ('22222222-2222-2222-2222-222222222202', 'the_knot', 'Megan & Chris T.', 4,
    'Lovely venue, Sam was great to work with. Some flexibility on outside vendors would have been nice but the day itself was beautiful.',
    '2025-11-14', 0.62, ARRAY['coordinator','flexibility'], false),
  ('22222222-2222-2222-2222-222222222202', 'wedding_wire', 'Ashley & Brian C.', 5,
    'Perfect rustic wedding. The barn lights at sunset were unforgettable and the staff went above and beyond.',
    '2026-02-03', 0.91, ARRAY['space','coordinator'], false),

  -- The Glass House
  ('22222222-2222-2222-2222-222222222203', 'google', 'Sofia & James W.', 5,
    'Breathtaking space. Our guests could not stop talking about it. The architecture is unlike any other venue we toured.',
    '2025-08-30', 0.94, ARRAY['space','experience'], true),
  ('22222222-2222-2222-2222-222222222203', 'the_knot', 'Hannah & Will B.', 5,
    'Nia and Max were exceptional — true professionals. They thought of everything and made the planning process completely stress-free.',
    '2025-10-25', 0.96, ARRAY['coordinator','experience','process'], false),
  ('22222222-2222-2222-2222-222222222203', 'wedding_wire', 'Lily & Marcus G.', 4,
    'Beautiful venue, a little pricey but worth it. The natural light in the photos is absolutely incredible.',
    '2026-01-15', 0.55, ARRAY['space','value'], false),

  -- Rose Hill Gardens
  ('22222222-2222-2222-2222-222222222204', 'google', 'Grace & Noah F.', 5,
    'The gardens were in full bloom — absolutely magical. Everything we hoped for and more. Dee took care of every detail.',
    '2025-09-18', 0.97, ARRAY['space','coordinator','experience'], true),
  ('22222222-2222-2222-2222-222222222204', 'the_knot', 'Maya & Eric H.', 4,
    'Great outdoor venue. Dee was very helpful throughout the process. Just wish there were more indoor backup options.',
    '2025-11-30', 0.50, ARRAY['coordinator','space'], false),
  ('22222222-2222-2222-2222-222222222204', 'wedding_wire', 'Charlotte & Ben S.', 5,
    'We are so glad we chose Rose Hill. The garden ceremony was breathtaking and our guests loved every moment.',
    '2026-02-20', 0.93, ARRAY['space','experience'], false)
ON CONFLICT DO NOTHING;

-- ============================================
-- EXTRACTED PHRASES (review_language)
-- These power the existing /intel/reviews page UI
-- ============================================

INSERT INTO review_language (venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing) VALUES
  -- Hawthorne Manor
  ('22222222-2222-2222-2222-222222222201', 'absolutely perfect day', 'experience', 0.95, 8, true, true),
  ('22222222-2222-2222-2222-222222222201', 'Jordan made everything seamless', 'coordinator', 0.96, 5, true, true),
  ('22222222-2222-2222-2222-222222222201', 'stunning at golden hour', 'space', 0.93, 6, true, true),
  ('22222222-2222-2222-2222-222222222201', 'felt like a fairytale', 'experience', 0.94, 4, true, true),
  ('22222222-2222-2222-2222-222222222201', 'gardens are unmatched', 'space', 0.91, 3, true, true),
  ('22222222-2222-2222-2222-222222222201', 'thought of every detail', 'coordinator', 0.92, 5, true, true),
  ('22222222-2222-2222-2222-222222222201', 'bridal suite was a dream', 'accommodation', 0.90, 4, true, false),

  -- Crestwood Farm
  ('22222222-2222-2222-2222-222222222202', 'a hidden gem', 'experience', 0.92, 7, true, true),
  ('22222222-2222-2222-2222-222222222202', 'rustic but elegant', 'space', 0.90, 6, true, true),
  ('22222222-2222-2222-2222-222222222202', 'Sam was great to work with', 'coordinator', 0.88, 4, true, true),
  ('22222222-2222-2222-2222-222222222202', 'barn lights at sunset', 'space', 0.93, 5, true, true),
  ('22222222-2222-2222-2222-222222222202', 'farm setting we wanted', 'space', 0.89, 4, true, false),
  ('22222222-2222-2222-2222-222222222202', 'flexibility on outside vendors', 'flexibility', -0.20, 3, false, false),
  ('22222222-2222-2222-2222-222222222202', 'staff went above and beyond', 'coordinator', 0.94, 5, true, true),

  -- The Glass House
  ('22222222-2222-2222-2222-222222222203', 'breathtaking space', 'space', 0.96, 9, true, true),
  ('22222222-2222-2222-2222-222222222203', 'Nia and Max were exceptional', 'coordinator', 0.97, 6, true, true),
  ('22222222-2222-2222-2222-222222222203', 'true professionals', 'coordinator', 0.92, 5, true, true),
  ('22222222-2222-2222-2222-222222222203', 'natural light is incredible', 'space', 0.94, 7, true, true),
  ('22222222-2222-2222-2222-222222222203', 'planning process was stress-free', 'process', 0.93, 4, true, true),
  ('22222222-2222-2222-2222-222222222203', 'unlike any other venue', 'space', 0.91, 5, true, true),
  ('22222222-2222-2222-2222-222222222203', 'a little pricey', 'value', -0.30, 4, false, false),

  -- Rose Hill Gardens
  ('22222222-2222-2222-2222-222222222204', 'gardens in full bloom', 'space', 0.95, 8, true, true),
  ('22222222-2222-2222-2222-222222222204', 'absolutely magical', 'experience', 0.96, 7, true, true),
  ('22222222-2222-2222-2222-222222222204', 'Dee took care of every detail', 'coordinator', 0.94, 6, true, true),
  ('22222222-2222-2222-2222-222222222204', 'breathtaking ceremony', 'ceremony', 0.93, 5, true, true),
  ('22222222-2222-2222-2222-222222222204', 'guests loved every moment', 'experience', 0.92, 4, true, true),
  ('22222222-2222-2222-2222-222222222204', 'wish for more indoor backup', 'space', -0.15, 3, false, false),
  ('22222222-2222-2222-2222-222222222204', 'so glad we chose Rose Hill', 'experience', 0.95, 5, true, true)
ON CONFLICT DO NOTHING;
