-- seed-ad-connections-demo.sql
--
-- W54. Crestwood Farm with ONE ad platform connected and TWO still typed
-- in by hand, so the reallocation page at /intel/marketing-roi/recommendations
-- shows both halves of its own sentence rather than only ever the
-- pessimistic one.
--
-- Why one and not three. The honesty copy on that page is the point of
-- the workstream: a venue that has connected Meta should stop being told
-- its Meta figures were typed in, while still being told the truth about
-- Google and TikTok. A demo where everything is connected, or nothing is,
-- proves neither half.
--
-- Meta is the connected one because it is the platform a wedding venue is
-- most likely to actually be running ads on.
--
-- The venue is Crestwood Farm, 22222222-2222-2222-2222-222222222202,
-- already in supabase/seed.sql. Nothing here creates a venue.
--
-- NO REAL CREDENTIAL IS SEEDED. The token column holds an obvious
-- placeholder. That is enough for the status reader to answer
-- 'connected' (its rule is: the row says connected and something is
-- there), which is what the copy keys off. Any actual sync against this
-- row fails at Meta's door, which is correct: there is no demo ad
-- account to read.
--
-- Requires migrations 310 and 407. Idempotent: every insert is guarded by
-- a NOT EXISTS on the per-venue unique key.
--
-- Run:  psql < supabase/seed-ad-connections-demo.sql
--       (or paste into the Supabase SQL editor)

-- ---------------------------------------------------------------------------
-- 1. Meta Ads: connected
-- ---------------------------------------------------------------------------

INSERT INTO public.meta_ads_connections (
  venue_id, ad_account_id, ad_account_name, access_token, token_expires_at,
  scope, status, connected_at, last_synced_at
)
SELECT
  '22222222-2222-2222-2222-222222222202',
  '778899001122',
  'Crestwood Farm',
  'demo-not-a-real-token',
  now() + interval '50 days',
  'ads_read,business_management',
  'connected',
  now() - interval '9 days',
  now() - interval '14 hours'
WHERE NOT EXISTS (
  SELECT 1 FROM public.meta_ads_connections
  WHERE venue_id = '22222222-2222-2222-2222-222222222202'
);

-- Two days of spend as the connector would have written it, so the page
-- has connector-sourced rows to sit beside the hand-entered ones. The
-- ingested_by value is what the connector-health read looks for.
INSERT INTO public.marketing_spend_records (
  venue_id, channel, campaign_id, campaign_name, spend_date, amount_cents,
  currency, source_platform_metadata, ingested_by
)
SELECT
  '22222222-2222-2222-2222-222222222202',
  'meta_ads',
  '2390',
  'Autumn open day',
  (CURRENT_DATE - 2),
  8419,
  'USD',
  '{"provider":"meta_ads","impressions":15230,"clicks":412,"conversions":8,"campaign_id":"2390","campaign_name":"Autumn open day"}'::jsonb,
  'meta_ads_connector'
WHERE NOT EXISTS (
  SELECT 1 FROM public.marketing_spend_records
  WHERE venue_id = '22222222-2222-2222-2222-222222222202'
    AND channel = 'meta_ads'
    AND COALESCE(campaign_id, '') = '2390'
    AND spend_date = (CURRENT_DATE - 2)
);

INSERT INTO public.marketing_spend_records (
  venue_id, channel, campaign_id, campaign_name, spend_date, amount_cents,
  currency, source_platform_metadata, ingested_by
)
SELECT
  '22222222-2222-2222-2222-222222222202',
  'meta_ads',
  '2390',
  'Autumn open day',
  (CURRENT_DATE - 1),
  7688,
  'USD',
  '{"provider":"meta_ads","impressions":13990,"clicks":388,"conversions":6,"campaign_id":"2390","campaign_name":"Autumn open day"}'::jsonb,
  'meta_ads_connector'
WHERE NOT EXISTS (
  SELECT 1 FROM public.marketing_spend_records
  WHERE venue_id = '22222222-2222-2222-2222-222222222202'
    AND channel = 'meta_ads'
    AND COALESCE(campaign_id, '') = '2390'
    AND spend_date = (CURRENT_DATE - 1)
);

-- ---------------------------------------------------------------------------
-- 2. Google Ads: not connected
-- ---------------------------------------------------------------------------
-- A row in 'pending' is the honest state for a venue that started the
-- connect flow and never finished, which is the common one. The status
-- reader returns 'manual' for it, so the page still says the Google
-- figures were typed in.

INSERT INTO public.google_ads_connections (venue_id, status, status_reason)
SELECT
  '22222222-2222-2222-2222-222222222202',
  'pending',
  'not connected yet'
WHERE NOT EXISTS (
  SELECT 1 FROM public.google_ads_connections
  WHERE venue_id = '22222222-2222-2222-2222-222222222202'
);

-- The hand-entered Google figure it is standing in for.
INSERT INTO public.marketing_spend_records (
  venue_id, channel, campaign_id, campaign_name, spend_date, amount_cents,
  currency, source_platform_metadata, ingested_by
)
SELECT
  '22222222-2222-2222-2222-222222222202',
  'google_ads',
  NULL,
  'Typed in from the monthly summary',
  date_trunc('month', CURRENT_DATE)::date,
  145000,
  'USD',
  '{"entered_via":"manual_form"}'::jsonb,
  'manual'
WHERE NOT EXISTS (
  SELECT 1 FROM public.marketing_spend_records
  WHERE venue_id = '22222222-2222-2222-2222-222222222202'
    AND channel = 'google_ads'
    AND COALESCE(campaign_id, '') = ''
    AND spend_date = date_trunc('month', CURRENT_DATE)::date
);

-- ---------------------------------------------------------------------------
-- 3. TikTok Ads: no row at all
-- ---------------------------------------------------------------------------
-- The third state worth showing: a venue that has never touched this
-- platform's settings page. No row, status reads 'manual', and the page
-- says so without anything having to be written first.

INSERT INTO public.marketing_spend_records (
  venue_id, channel, campaign_id, campaign_name, spend_date, amount_cents,
  currency, source_platform_metadata, ingested_by
)
SELECT
  '22222222-2222-2222-2222-222222222202',
  'tiktok_ads',
  NULL,
  'Typed in from the monthly summary',
  date_trunc('month', CURRENT_DATE)::date,
  42000,
  'USD',
  '{"entered_via":"manual_form"}'::jsonb,
  'manual'
WHERE NOT EXISTS (
  SELECT 1 FROM public.marketing_spend_records
  WHERE venue_id = '22222222-2222-2222-2222-222222222202'
    AND channel = 'tiktok_ads'
    AND COALESCE(campaign_id, '') = ''
    AND spend_date = date_trunc('month', CURRENT_DATE)::date
);
