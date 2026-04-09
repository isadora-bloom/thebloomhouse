-- ============================================================================
-- seed-intel-data.sql
-- Seeds lost_deals, social_posts, and campaigns for the 4 demo venues.
-- Reviews: there is NO dedicated reviews table — only review_language (phrase
-- extraction). Raw review seeding is skipped; see report.
-- Sources: already covered on the weddings table (verified pre-run).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- TASK 2.5 — LOST DEALS
-- ---------------------------------------------------------------------------

INSERT INTO lost_deals (
  id, venue_id, wedding_id, lost_at_stage, reason_category, reason_detail,
  competitor_name, recovery_attempted, recovery_outcome, lost_at, created_at
) VALUES
  -- Hawthorne Manor
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', NULL, 'tour',
    'competitor', 'Sophie & James Whitfield — chose another venue with more parking',
    'Riverview Estate', true, 'no_response', '2025-12-10T14:00:00Z', '2025-12-10T14:00:00Z'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', NULL, 'inquiry',
    'pricing', 'Liam & Maya Patterson — budget exceeded, $18k target',
    NULL, false, NULL, '2026-01-22T10:00:00Z', '2026-01-22T10:00:00Z'),

  -- Crestwood Farm
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222202', NULL, 'tour',
    'date_unavailable', 'Owen & Reese Burton — wanted September weekend, fully booked',
    NULL, false, NULL, '2025-11-15T11:00:00Z', '2025-11-15T11:00:00Z'),

  -- The Glass House
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222203', NULL, 'tour',
    'no_response', 'Asha & Theo Vasquez — ghosted after tour',
    NULL, false, NULL, '2026-02-01T15:30:00Z', '2026-02-01T15:30:00Z'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222203', NULL, 'tour',
    'competitor', 'Quinn & Elliot Park — indoor venue not preferred',
    'The Atrium', false, NULL, '2026-01-08T13:00:00Z', '2026-01-08T13:00:00Z'),

  -- Rose Hill Gardens
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222204', NULL, 'inquiry',
    'budget_change', 'Sienna & Beau Carter — eloped instead',
    NULL, false, NULL, '2026-03-05T09:00:00Z', '2026-03-05T09:00:00Z');


-- ---------------------------------------------------------------------------
-- TASK 2.8 — SOCIAL POSTS (6 per venue, spread across last 90 days)
-- ---------------------------------------------------------------------------

INSERT INTO social_posts (
  id, venue_id, platform, posted_at, caption,
  reach, impressions, likes, comments, shares, saves,
  website_clicks, profile_visits, engagement_rate, is_viral
) VALUES
  -- =========================================================================
  -- HAWTHORNE MANOR — garden / manor / classic / Virginia
  -- =========================================================================
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'instagram', NOW() - INTERVAL '4 days',
    'Golden hour at Hawthorne Manor. The south garden never disappoints. #virginiaweddings #manorwedding',
    4200, 5800, 247, 18, 12, 34, 42, 180, 0.0740, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'instagram', NOW() - INTERVAL '14 days',
    'Classic black tie ceremony on the lawn. Photo by @harperandoakphoto #classicwedding',
    2800, 3600, 168, 9, 4, 21, 18, 92, 0.0721, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'instagram', NOW() - INTERVAL '27 days',
    'When the peonies are in full bloom... Hawthorne in June is unmatched. #gardenvenue',
    11800, 16400, 376, 41, 38, 112, 88, 410, 0.1200, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'instagram', NOW() - INTERVAL '42 days',
    'Behind the scenes with our ceremony coordinator. 200 chairs, 30 minutes, zero stress.',
    1600, 2100, 72, 6, 2, 11, 9, 48, 0.0567, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'facebook', NOW() - INTERVAL '58 days',
    'Open house this Saturday 11am-2pm. Come tour the manor and meet our team. RSVP in bio.',
    3200, 4800, 94, 12, 8, 0, 54, 120, 0.0356, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', 'instagram', NOW() - INTERVAL '75 days',
    'Frost on the veranda. Winter weddings at the manor have their own magic. #virginiaweddings',
    2100, 2700, 121, 7, 3, 16, 14, 68, 0.0700, false),

  -- =========================================================================
  -- CRESTWOOD FARM — rustic / farm / barn / Charlottesville
  -- =========================================================================
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222202', 'instagram', NOW() - INTERVAL '6 days',
    'Barn doors open, string lights on, hay bales ready. Crestwood is booking fall 2026 fast. #rusticwedding',
    3600, 4900, 214, 22, 9, 28, 36, 156, 0.0758, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222202', 'instagram', NOW() - INTERVAL '18 days',
    'Charlottesville vineyards in the distance, our barn in the foreground. #charlottesvilleweddings',
    9400, 12800, 312, 35, 29, 78, 72, 298, 0.0909, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222202', 'instagram', NOW() - INTERVAL '30 days',
    'Sunset ceremony under the old oak. Nothing beats a farm wedding in October.',
    2400, 3100, 142, 11, 6, 19, 21, 84, 0.0742, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222202', 'instagram', NOW() - INTERVAL '47 days',
    'Reclaimed wood, mason jars, and Virginia wildflowers. Our couples bring the vision — we bring the space.',
    1800, 2300, 88, 5, 2, 14, 11, 52, 0.0606, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222202', 'facebook', NOW() - INTERVAL '63 days',
    'Happy 1-year anniversary to Emma & Jack! One of our favorite Crestwood couples.',
    1200, 1650, 56, 14, 4, 0, 6, 38, 0.0606, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222202', 'instagram', NOW() - INTERVAL '82 days',
    'Winter light through the barn slats. There is something quiet and perfect about January tours.',
    900, 1200, 41, 3, 1, 7, 4, 22, 0.0578, false),

  -- =========================================================================
  -- THE GLASS HOUSE — modern / glass / urban / contemporary
  -- =========================================================================
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222203', 'instagram', NOW() - INTERVAL '3 days',
    'Architectural light + a minimalist tablescape = The Glass House signature. #modernwedding',
    6200, 8400, 298, 24, 18, 52, 64, 240, 0.0632, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222203', 'instagram', NOW() - INTERVAL '12 days',
    'Floor-to-ceiling windows. 360 degrees of skyline. Who needs a view when you are the view? #glasshousevenue',
    12000, 17200, 412, 48, 42, 128, 110, 480, 0.1025, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222203', 'instagram', NOW() - INTERVAL '25 days',
    'Contemporary ceremony, metallic accents, black tie attire. Urban weddings done right.',
    3400, 4500, 186, 14, 9, 32, 28, 140, 0.0709, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222203', 'instagram', NOW() - INTERVAL '40 days',
    'Blue hour at The Glass House. The building becomes a lantern.',
    4800, 6600, 232, 19, 14, 44, 38, 180, 0.0644, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222203', 'facebook', NOW() - INTERVAL '55 days',
    'Our Q1 open houses are live. Tour dates: Feb 15, Mar 1, Mar 22. Book via the link in bio.',
    2100, 3000, 64, 8, 6, 0, 48, 96, 0.0371, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222203', 'instagram', NOW() - INTERVAL '78 days',
    'Black dahlias, brass candlesticks, architectural linens. Designed by @atelierfinewed',
    2600, 3400, 138, 12, 7, 26, 20, 102, 0.0704, false),

  -- =========================================================================
  -- ROSE HILL GARDENS — gardens / blooms / romantic / outdoor
  -- =========================================================================
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222204', 'instagram', NOW() - INTERVAL '5 days',
    'The first roses are opening. Spring at Rose Hill is officially here. #gardenwedding #outdoorvenue',
    4900, 6800, 278, 21, 14, 42, 48, 210, 0.0724, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222204', 'instagram', NOW() - INTERVAL '17 days',
    'Romantic garden ceremony under the rose arch. Our couples are the flowers.',
    2900, 3800, 168, 13, 7, 24, 22, 106, 0.0738, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222204', 'instagram', NOW() - INTERVAL '29 days',
    'One thousand blooms. One perfect day. Rose Hill at peak bloom is a dream. #romanticwedding',
    13200, 18400, 428, 52, 46, 134, 118, 510, 0.1144, true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222204', 'instagram', NOW() - INTERVAL '44 days',
    'Outdoor receptions under the pergola. Lights strung through climbing hydrangeas.',
    2200, 2900, 112, 9, 4, 18, 14, 78, 0.0650, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222204', 'facebook', NOW() - INTERVAL '61 days',
    'Garden tours start in April. Sign up for the spring open house at the link in bio.',
    1700, 2300, 52, 7, 3, 0, 26, 62, 0.0365, false),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222204', 'instagram', NOW() - INTERVAL '80 days',
    'Dormant garden, dreaming couples. We are already booking 2027 spring dates.',
    1400, 1800, 68, 4, 2, 11, 8, 36, 0.0607, false);


-- ---------------------------------------------------------------------------
-- TASK 2.10 — CAMPAIGNS (add fresh campaigns so every venue has 3+)
-- Cost per inquiry, cost per booking, and ROI ratio computed from the numbers.
-- ---------------------------------------------------------------------------

INSERT INTO campaigns (
  id, venue_id, name, channel, start_date, end_date,
  spend, inquiries_attributed, tours_attributed, bookings_attributed,
  revenue_attributed, cost_per_inquiry, cost_per_booking, roi_ratio, notes
) VALUES
  -- HAWTHORNE MANOR — already has 3 campaigns, skipping

  -- CRESTWOOD FARM — already has 1, add 2 more
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222202',
    'The Knot Featured Listing — Q1 2026', 'the_knot',
    '2026-01-01', '2026-03-31',
    1050.00, 8, 5, 2, 45500.00,
    131.25, 525.00, 42.333,
    'Premium featured placement for all of Q1. Strong lead volume.'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222202',
    'Instagram Spring Ads 2026', 'instagram',
    '2026-03-01', '2026-05-31',
    600.00, 14, 8, 3, 62000.00,
    42.8571, 200.00, 102.333,
    'Reels-driven spring campaign targeting Charlottesville engaged couples.'),

  -- THE GLASS HOUSE — no campaigns yet, add 3
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222203',
    'The Knot Featured Listing — Q1 2026', 'the_knot',
    '2026-01-01', '2026-03-31',
    1050.00, 8, 5, 2, 45500.00,
    131.25, 525.00, 42.333,
    'Premium placement. Urban contemporary filter drove strong qualified leads.'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222203',
    'Instagram Spring Ads 2026', 'instagram',
    '2026-03-01', '2026-05-31',
    600.00, 14, 9, 3, 62000.00,
    42.8571, 200.00, 102.333,
    'Architectural content performed well. High save rate.'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222203',
    'Wedding Wire Premium — Q4 2025', 'weddingwire',
    '2025-10-01', '2025-12-31',
    900.00, 6, 4, 1, 24500.00,
    150.00, 900.00, 26.2222,
    'Premium tier for holiday booking window.'),

  -- ROSE HILL GARDENS — no campaigns yet, add 3
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222204',
    'The Knot Featured Listing — Q1 2026', 'the_knot',
    '2026-01-01', '2026-03-31',
    1050.00, 8, 6, 2, 45500.00,
    131.25, 525.00, 42.333,
    'Garden venues in demand for late spring dates.'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222204',
    'Instagram Spring Ads 2026', 'instagram',
    '2026-03-01', '2026-05-31',
    600.00, 14, 9, 3, 62000.00,
    42.8571, 200.00, 102.333,
    'Peak bloom content had the highest engagement of any campaign.'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222204',
    'Wedding Wire Premium — Q4 2025', 'weddingwire',
    '2025-10-01', '2025-12-31',
    900.00, 6, 3, 1, 24500.00,
    150.00, 900.00, 26.2222,
    'Premium tier for couples planning 2026 spring weddings.');


-- Backfill NULL metrics on any existing demo campaigns (defensive — audit fix
-- should have covered this already).
UPDATE campaigns
SET cost_per_inquiry = ROUND(spend / NULLIF(inquiries_attributed, 0), 2),
    cost_per_booking = ROUND(spend / NULLIF(bookings_attributed, 0), 2),
    roi_ratio        = ROUND((revenue_attributed - spend) / NULLIF(spend, 0), 4)
WHERE venue_id::text LIKE '22222222%'
  AND (cost_per_inquiry IS NULL OR cost_per_booking IS NULL OR roi_ratio IS NULL)
  AND spend IS NOT NULL AND spend > 0;
