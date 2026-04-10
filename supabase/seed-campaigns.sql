-- P8.1: Seed campaigns with pre-computed metrics (no NaN)
-- Guarded by name+venue_id to avoid duplicates

-- 1. The Knot Featured Listing — Q1 2026 (Hawthorne)
INSERT INTO public.campaigns (
  id, venue_id, name, channel, start_date, end_date,
  spend, inquiries_attributed, tours_attributed, bookings_attributed, revenue_attributed,
  cost_per_inquiry, cost_per_booking, roi_ratio, notes, created_at
)
SELECT gen_random_uuid(),
       '22222222-2222-2222-2222-222222222201',
       'The Knot Featured Listing — Q1 2026',
       'The Knot',
       '2026-01-01', '2026-03-31',
       1050, 8, 4, 2, 45500,
       131.25, 525.00, 42.333333,
       'Featured listing for Hawthorne Manor on The Knot, Q1 2026.',
       '2026-01-01 00:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.campaigns
  WHERE venue_id = '22222222-2222-2222-2222-222222222201'
    AND name = 'The Knot Featured Listing — Q1 2026'
);

-- 2. Instagram Spring Campaign 2026 (Hawthorne)
INSERT INTO public.campaigns (
  id, venue_id, name, channel, start_date, end_date,
  spend, inquiries_attributed, tours_attributed, bookings_attributed, revenue_attributed,
  cost_per_inquiry, cost_per_booking, roi_ratio, notes, created_at
)
SELECT gen_random_uuid(),
       '22222222-2222-2222-2222-222222222201',
       'Instagram Spring Campaign 2026',
       'Instagram',
       '2026-02-01', '2026-03-31',
       600, 14, 7, 3, 62000,
       42.857143, 200.00, 102.333333,
       'Organic + boosted Reels promoting Hawthorne spring dates.',
       '2026-02-01 00:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.campaigns
  WHERE venue_id = '22222222-2222-2222-2222-222222222201'
    AND name = 'Instagram Spring Campaign 2026'
);

-- 3. Wedding Wire Premium — Q4 2025 (Hawthorne)
INSERT INTO public.campaigns (
  id, venue_id, name, channel, start_date, end_date,
  spend, inquiries_attributed, tours_attributed, bookings_attributed, revenue_attributed,
  cost_per_inquiry, cost_per_booking, roi_ratio, notes, created_at
)
SELECT gen_random_uuid(),
       '22222222-2222-2222-2222-222222222201',
       'Wedding Wire Premium — Q4 2025',
       'Wedding Wire',
       '2025-10-01', '2025-12-31',
       900, 6, 3, 1, 24500,
       150.00, 900.00, 26.222222,
       'Premium tier on Wedding Wire, Q4 2025.',
       '2025-10-01 00:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.campaigns
  WHERE venue_id = '22222222-2222-2222-2222-222222222201'
    AND name = 'Wedding Wire Premium — Q4 2025'
);

-- 4. Google Ads — Spring 2026 (Crestwood)
INSERT INTO public.campaigns (
  id, venue_id, name, channel, start_date, end_date,
  spend, inquiries_attributed, tours_attributed, bookings_attributed, revenue_attributed,
  cost_per_inquiry, cost_per_booking, roi_ratio, notes, created_at
)
SELECT gen_random_uuid(),
       '22222222-2222-2222-2222-222222222202',
       'Google Ads — Spring 2026',
       'Google',
       '2026-02-01', '2026-04-30',
       480, 9, 4, 2, 40500,
       53.333333, 240.00, 83.375000,
       'Local search ads targeting barn/farm wedding queries.',
       '2026-02-01 00:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.campaigns
  WHERE venue_id = '22222222-2222-2222-2222-222222222202'
    AND name = 'Google Ads — Spring 2026'
);

-- 5. The Knot Featured — Q1 2026 (Glass House)
INSERT INTO public.campaigns (
  id, venue_id, name, channel, start_date, end_date,
  spend, inquiries_attributed, tours_attributed, bookings_attributed, revenue_attributed,
  cost_per_inquiry, cost_per_booking, roi_ratio, notes, created_at
)
SELECT gen_random_uuid(),
       '22222222-2222-2222-2222-222222222203',
       'The Knot Featured — Q1 2026',
       'The Knot',
       '2026-01-01', '2026-03-31',
       1200, 5, 3, 2, 81500,
       240.00, 600.00, 66.916667,
       'Featured listing for The Glass House, Q1 2026.',
       '2026-01-01 00:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.campaigns
  WHERE venue_id = '22222222-2222-2222-2222-222222222203'
    AND name = 'The Knot Featured — Q1 2026'
);

-- 6. Instagram Luxury Wedding Campaign (Glass House)
INSERT INTO public.campaigns (
  id, venue_id, name, channel, start_date, end_date,
  spend, inquiries_attributed, tours_attributed, bookings_attributed, revenue_attributed,
  cost_per_inquiry, cost_per_booking, roi_ratio, notes, created_at
)
SELECT gen_random_uuid(),
       '22222222-2222-2222-2222-222222222203',
       'Instagram Luxury Wedding Campaign',
       'Instagram',
       '2026-01-01', '2026-03-31',
       850, 7, 4, 2, 79000,
       121.428571, 425.00, 91.941176,
       'High-end editorial content targeting luxury couples.',
       '2026-01-01 00:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.campaigns
  WHERE venue_id = '22222222-2222-2222-2222-222222222203'
    AND name = 'Instagram Luxury Wedding Campaign'
);

-- 7. Wedding Wire — Q1 2026 (Rose Hill)
INSERT INTO public.campaigns (
  id, venue_id, name, channel, start_date, end_date,
  spend, inquiries_attributed, tours_attributed, bookings_attributed, revenue_attributed,
  cost_per_inquiry, cost_per_booking, roi_ratio, notes, created_at
)
SELECT gen_random_uuid(),
       '22222222-2222-2222-2222-222222222204',
       'Wedding Wire — Q1 2026',
       'Wedding Wire',
       '2026-01-01', '2026-03-31',
       390, 4, 2, 1, 16500,
       97.50, 390.00, 41.307692,
       'Standard listing for Rose Hill Gardens, Q1 2026.',
       '2026-01-01 00:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.campaigns
  WHERE venue_id = '22222222-2222-2222-2222-222222222204'
    AND name = 'Wedding Wire — Q1 2026'
);

-- 8. Facebook Retargeting — Feb 2026 (Hawthorne) — 0 bookings, ROI -1.0
INSERT INTO public.campaigns (
  id, venue_id, name, channel, start_date, end_date,
  spend, inquiries_attributed, tours_attributed, bookings_attributed, revenue_attributed,
  cost_per_inquiry, cost_per_booking, roi_ratio, notes, created_at
)
SELECT gen_random_uuid(),
       '22222222-2222-2222-2222-222222222201',
       'Facebook Retargeting — Feb 2026',
       'Facebook',
       '2026-02-01', '2026-02-28',
       220, 3, 1, 0, 0,
       73.33, 0, -1.0,
       'Retargeted past site visitors. No bookings attributed — treat as learning spend.',
       '2026-02-01 00:00:00+00'
WHERE NOT EXISTS (
  SELECT 1 FROM public.campaigns
  WHERE venue_id = '22222222-2222-2222-2222-222222222201'
    AND name = 'Facebook Retargeting — Feb 2026'
);
