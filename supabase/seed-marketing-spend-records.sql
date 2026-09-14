-- Demo seed: per-day marketing spend for the Crestwood Collection venues.
--
-- W52 of NOVEMBER-PLAN.md wave 7. The new owner-facing page
-- (/intel/monthly-story) shows what each channel returns, and that number
-- comes from `getSourceAttribution`, which reads
-- `marketing_spend_records` (migration 263).
--
-- Nothing seeded that table. `supabase/seed.sql` §22 writes the LEGACY
-- `marketing_spend` (migration 003, monthly aggregates), which the
-- attribution builder does not read, so on the demo venues the channel
-- panel showed couples and an honest blank where the return should be.
-- That is the correct behaviour for a venue with no spend on file, and
-- exactly the wrong impression for a demo.
--
-- Two things this file is careful about.
--
-- 1. `channel` must be the SPINE channel key, not a platform name.
--    `rollupChannels` in src/lib/services/attribution/couple-attribution.ts
--    looks the spend up with `spendByChannel.get(channel)` where `channel`
--    is the acquisition touchpoint's own channel. Seeding 'theknot_fee'
--    here would load fine and match nothing.
--
-- 2. `loadSpendByChannel` windows on the first and last touchpoint in the
--    cohort, and the demo spine is rebuilt against a live clock by
--    `scripts/demo-reseed.ts`. So the rows are generated relative to
--    CURRENT_DATE rather than pinned to fixed dates, and they cover two
--    years back, which straddles whatever window the reseeder produced.
--
-- Amounts are invented, in the shape a small venue's spend actually
-- takes: a flat monthly listing fee per marketplace, and a smaller,
-- lumpier ad spend. They are demo numbers on fictional venues and are not
-- anybody's real figures.
--
-- Idempotent: deletes its own rows first, keyed on ingested_by.
-- Safe to re-run. Writes to demo venues only.

DELETE FROM public.marketing_spend_records
WHERE ingested_by = 'demo_seed_w52'
  AND venue_id IN (
    '22222222-2222-2222-2222-222222222201',
    '22222222-2222-2222-2222-222222222202',
    '22222222-2222-2222-2222-222222222203',
    '22222222-2222-2222-2222-222222222204'
  );

INSERT INTO public.marketing_spend_records
  (venue_id, channel, campaign_name, spend_date, amount_cents, currency, ingested_by)
SELECT
  v.venue_id,
  c.channel,
  c.campaign_name,
  (date_trunc('month', CURRENT_DATE) - (m || ' months')::interval)::date AS spend_date,
  -- A little month-to-month movement so the ROI column is not four
  -- identical numbers. Deterministic, not random, so two runs of the
  -- demo seed agree with each other.
  ((c.monthly_cents * v.scale) + ((m * 37) % 11) * 1000)::int AS amount_cents,
  'USD',
  'demo_seed_w52'
FROM (
  VALUES
    ('22222222-2222-2222-2222-222222222201'::uuid, 1.00),
    ('22222222-2222-2222-2222-222222222202'::uuid, 0.70),
    ('22222222-2222-2222-2222-222222222203'::uuid, 0.55),
    ('22222222-2222-2222-2222-222222222204'::uuid, 0.40)
) AS v(venue_id, scale)
CROSS JOIN (
  VALUES
    -- Spine channel keys. See the header: these must match the
    -- acquisition touchpoint's `channel`, not a platform's own name.
    ('knot',        'The Knot listing',      45000),
    ('weddingwire', 'WeddingWire listing',   32000),
    ('zola',        'Zola listing',          18000),
    ('website',     'Search ads to the site', 26000)
) AS c(channel, campaign_name, monthly_cents)
CROSS JOIN generate_series(0, 23) AS m
WHERE (c.monthly_cents * v.scale)::int > 0
-- The unique index is (venue_id, channel, COALESCE(campaign_id, ''),
-- spend_date), so a re-run after a partial delete is a no-op rather than
-- a constraint error.
ON CONFLICT DO NOTHING;

-- What this unlocks on the demo, and what it does not:
--
--   * Channel ROI on /intel/monthly-story and /intel/sources now has
--     spend behind it, so cost-per-booking and return per dollar render
--     instead of being withheld.
--   * Response time and the weekday tour table still need the identity
--     spine, which no SQL seed writes. Those come from
--     `npx tsx scripts/demo-reseed.ts --apply` (dry-run by default),
--     which replays the demo venues through linkSignal. Until that has
--     run, both panels say honestly that there is nothing on file rather
--     than drawing a zero.
--   * Reviews are already seeded by supabase/seed-reviews.sql (three per
--     venue, which is exactly the reporting floor), so the review trend
--     panel renders with a direction it can defend.
