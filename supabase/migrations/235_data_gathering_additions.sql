-- ============================================================================
-- 235_data_gathering_additions.sql
-- Tier-D data-gathering bucket: #161 + #163 + #164 (2026-05-08).
--
-- Three additive schema changes that unlock signals already capturable
-- but currently dropped on the floor. All NULL-able, no CHECK constraints,
-- no writer change needed — existing rows stay valid; new rows can opt in.
--
-- Why no CHECK constraints + no NOT NULL: the writers that produce these
-- values (auto-extraction from contracts for #161, vision/forecast for
-- #164, brain-dump or guest CSV import for #163) ship one by one. NOT
-- NULL would block existing inserts. CHECK enums need a full writer
-- inventory pass first — deferred to a follow-up sweep.
-- ============================================================================

-- #161: Quote-to-book delta capture.
-- Today: weddings.booking_value records the contracted price. The
-- price originally quoted (often before negotiation, before package
-- swap, before discount) is lost. Knowing both lets the intel layer
-- compute a quote-to-book delta — one of the strongest signals of
-- pricing power and discount discipline.
--
-- Writer (deferred): inquiry-brain extracts the proposed quote from
-- the operator's first proposal email or the contract-extract pipeline.
-- For now NULL is the only legal value; backfill scaffolding lives in
-- a follow-up cron.

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS quoted_value numeric;

COMMENT ON COLUMN public.weddings.quoted_value IS
  'Original quoted price (pre-negotiation, pre-discount). NULL when unknown. Compare to booking_value for quote-to-book delta. Tier-D #161.';

-- #164: Per-tour weather snapshot.
-- Today: weather_data is captured per venue per day for wedding-date
-- forecasts, but the tour-time weather (was it raining when the couple
-- visited?) is never linked to the tour. Tour outcomes + tour weather
-- correlate strongly per industry research.
--
-- Writer (deferred): tour creation handler fetches Open-Meteo / NOAA
-- for the tour's scheduled timestamp + venue lat/lon. Stored as
-- structured jsonb so future fields (humidity, cloud cover) extend
-- without a migration.

ALTER TABLE public.tours
  ADD COLUMN IF NOT EXISTS weather_at_tour jsonb;

COMMENT ON COLUMN public.tours.weather_at_tour IS
  'Weather snapshot captured at tour start. Shape: { temp_f, condition, precip_mm, wind_mph, source: noaa|open_meteo, fetched_at }. NULL for historical tours pre-feature. Tier-D #164.';

CREATE INDEX IF NOT EXISTS idx_tours_weather_present
  ON public.tours (venue_id, outcome)
  WHERE weather_at_tour IS NOT NULL;

-- #163: Guest demographics.
-- Today: guest_list captures name, dietary, plus_one. Age bracket +
-- origin state are signals the venue legitimately collects (esp.
-- destination weddings) but never persists in structured form.
-- Coordinator-only data; never user-input by the couple directly,
-- so nothing in the couple-portal flow asks for it.
--
-- Writer (deferred): brain-dump path detects "65% over 50" or
-- "mostly Virginia / DC" prose and proposes the columns. Vision
-- on guest-list screenshots can fill them too.

ALTER TABLE public.guest_list
  ADD COLUMN IF NOT EXISTS age_bracket text;

ALTER TABLE public.guest_list
  ADD COLUMN IF NOT EXISTS origin_state text;

COMMENT ON COLUMN public.guest_list.age_bracket IS
  'Coarse age bracket (under_30, 30_50, 50_70, over_70). NULL when unknown. Free text — no CHECK enforced; analytics rolls up case-insensitively. Tier-D #163.';

COMMENT ON COLUMN public.guest_list.origin_state IS
  'Two-letter US state code or country-of-origin label for non-US guests. NULL when unknown. Tier-D #163.';
