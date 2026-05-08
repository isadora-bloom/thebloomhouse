-- ============================================================================
-- 241_people_addresses.sql
-- B2 starting cut (2026-05-08). Couple + relative addresses on people table.
--
-- Per docs/future-ideas.md the constitution-aligned home for couple-side
-- identity-graph data is the people table. Addresses go on people rows
-- so the matching engine + identity-resolution can correlate them with
-- future inbound signals (review left from that zip, social signal,
-- referral graph).
--
-- Two extensions:
--   1. role CHECK widens to include 'parent' (the address-holder role
--      for relatives the couple wants on file). 'family' already exists
--      but is too broad - 'parent' specifically marks address-bearing
--      relative rows the addresses page treats as first-class.
--   2. Address columns (street_line_1, street_line_2, city, region,
--      postal_code, country, address_label). All NULL-able. address_label
--      is the couple-typed free text ("My mom", "Joel's dad and step-mom")
--      shown alongside the role on the coordinator view.
--
-- Backwards compatible: existing rows stay valid; new columns default
-- NULL; new role enum value adds, none removed.
-- ============================================================================

-- (1) Extend role CHECK to include 'parent'.
ALTER TABLE public.people
  DROP CONSTRAINT IF EXISTS people_role_check;

ALTER TABLE public.people
  ADD CONSTRAINT people_role_check
  CHECK (role IN ('partner1', 'partner2', 'guest', 'wedding_party', 'vendor', 'family', 'parent'));

-- (2) Address columns.
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS street_line_1 text;

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS street_line_2 text;

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS city text;

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS region text;

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS postal_code text;

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS country text;

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS address_label text;

COMMENT ON COLUMN public.people.address_label IS
  'Couple-typed free-text label for relative-role rows ("My mom", "Joel''s dad and step-mom"). NULL on partner1/partner2 rows where role + first_name is enough.';

COMMENT ON COLUMN public.people.region IS
  'State / province / region. Free text, no enum - international addresses vary.';

-- Index for the addresses page read: pull all address-bearing rows for a wedding.
CREATE INDEX IF NOT EXISTS idx_people_wedding_addresses
  ON public.people (wedding_id)
  WHERE street_line_1 IS NOT NULL;
