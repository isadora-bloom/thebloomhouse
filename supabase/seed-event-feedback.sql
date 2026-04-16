-- ============================================
-- SEED: Event Feedback Demo Data
-- For Hawthorne Manor completed wedding (Emma & Liam, May 2024)
-- Wedding ID: 44444444-4444-4444-4444-444444000101
-- Venue ID: 22222222-2222-2222-2222-222222222201
-- ============================================

-- Insert a completed event feedback for the Emma & Liam wedding
INSERT INTO event_feedback (
  id,
  venue_id,
  wedding_id,
  overall_rating,
  couple_satisfaction,
  timeline_adherence,
  delay_phases,
  delay_notes,
  guest_complaints,
  guest_complaint_count,
  catering_quality,
  dietary_handling,
  service_timing,
  catering_notes,
  review_readiness,
  review_readiness_notes,
  what_went_well,
  what_to_change,
  proactive_response_draft,
  proactive_response_approved,
  feedback_triggered_at,
  submitted_at,
  created_at,
  updated_at
) VALUES (
  'f0000001-0000-0000-0000-000000000001',
  '22222222-2222-2222-2222-222222222201',
  '44444444-4444-4444-4444-444444000101',
  4,
  5,
  'minor_delays',
  ARRAY['photos_ran_long', 'cocktail_to_reception'],
  'Photo session ran about 20 minutes over due to beautiful golden hour light - couple loved the results. This pushed cocktail hour transition back slightly but guests were well entertained with lawn games.',
  'One guest mentioned the cocktail hour felt long. Another asked about vegan dessert options (we only had the standard cake flavors).',
  2,
  5,
  4,
  4,
  'Wildflower Catering knocked it out of the park on the main courses. The herb-crusted salmon was a showstopper. Minor timing gap between salad course and entree but nothing guests noticed. One table had a dietary mix-up with the vegetarian plate but was quickly resolved.',
  'yes',
  'Emma has already mentioned wanting to leave a review on The Knot. She was thrilled with everything, especially the ceremony meadow setup and the sparkler send-off.',
  'The ceremony meadow was absolutely perfect in May - wildflowers were at peak bloom. The string quartet during cocktail hour got so many compliments. The sparkler send-off was the highlight of the night. The bridal suite was a huge hit for morning-of prep. Coordinator-couple communication was excellent throughout planning.',
  'For future spring weddings, we should build in a 15-minute buffer between ceremony and cocktail hour to account for photo sessions running long. Also worth adding a vegan dessert option to the standard packages - we have gotten this request 3 times this season. The lawn games were a great call for extended cocktail hours.',
  'Thank you so much, Emma and Liam! What a magical May evening at Hawthorne Manor. From the wildflower-lined ceremony meadow to that unforgettable sparkler send-off, every moment reflected your beautiful love story. We were so honored to host your celebration with 150 of your closest friends and family. Your warmth and joy were truly contagious, and our entire team felt privileged to play a part in your special day. We hope every time you look at those golden hour photos, you are transported right back to that perfect evening. Wishing you a lifetime of happiness together!',
  true,
  '2024-05-21 09:00:00+00',
  '2024-05-22 14:30:00+00',
  '2024-05-22 14:30:00+00',
  '2024-05-22 14:30:00+00'
) ON CONFLICT (wedding_id) DO NOTHING;

-- Insert vendor feedback for this event
-- Note: These use NULL vendor_id since the completed wedding doesn't have booked_vendors seeded
INSERT INTO event_feedback_vendors (id, event_feedback_id, vendor_id, vendor_name, vendor_type, rating, notes, would_recommend) VALUES
  ('f1000001-0000-0000-0000-000000000001', 'f0000001-0000-0000-0000-000000000001', NULL, 'Sarah Jones Photography', 'Photographer', 5, 'Incredible work. Golden hour shots were breathtaking. Very professional, kept to timeline except for the extra 20 min which the couple loved.', true),
  ('f1000002-0000-0000-0000-000000000002', 'f0000001-0000-0000-0000-000000000001', NULL, 'Blue Ridge String Quartet', 'Musicians', 5, 'Cocktail hour music was perfect. Multiple guests commented. Arrived early, set up quietly, zero issues.', true),
  ('f1000003-0000-0000-0000-000000000003', 'f0000001-0000-0000-0000-000000000001', NULL, 'Wildflower Catering', 'Caterer', 4, 'Excellent food quality. Minor timing gap between courses and one dietary mix-up, but handled it gracefully.', true),
  ('f1000004-0000-0000-0000-000000000004', 'f0000001-0000-0000-0000-000000000001', NULL, 'Stems & Soil Florals', 'Florist', 5, 'The ceremony arch was stunning. Centerpieces perfectly complemented the venue. Delivered on time with extras.', true),
  ('f1000005-0000-0000-0000-000000000005', 'f0000001-0000-0000-0000-000000000001', NULL, 'DJ Marcus', 'DJ', 4, 'Great energy, read the room well. Could have been smoother on the transition from dinner to dancing. Sparkler send-off coordination was flawless.', true)
ON CONFLICT DO NOTHING;
