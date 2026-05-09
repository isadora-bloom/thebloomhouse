-- ---------------------------------------------------------------------------
-- 258_venue_vendor_domains.sql
-- ---------------------------------------------------------------------------
-- Per-venue vendor-domain allow-list — sister of ADVERTISER_DOMAINS in
-- src/lib/services/inbox/lifecycle.ts but venue-scoped.
--
-- Why this exists
-- ---------------
-- After /api/admin/reclass-folders-ai sweeps the venue's 'other' inbox,
-- Haiku correctly labels vendors (Gibson Rental, Signature Event Rentals,
-- Parts Town, Catering Co, All Pro Charter, etc.). But every NEW email
-- from those domains tomorrow goes through the rule-based decider FIRST,
-- falls to 'other', and the coordinator has to pay Haiku again to
-- reclassify. Token waste at ~$0.0003/call x thousands of vendor emails
-- per year per venue.
--
-- The fix is venue-scoped: ADVERTISER_DOMAINS is a global constant
-- because cold sales SaaS / Knot relays / recruiter spam look the same
-- everywhere, but vendors are venue-specific. Rixey's florist isn't
-- Wedgewood's florist. So this table sits beside the global advertiser
-- list and the rule-based decider checks it BEFORE falling to 'other'.
--
-- Source column captures provenance:
--   ai_classifier — promoted by /api/admin/reclass-folders-ai when Haiku
--                   labelled an email's sender domain as 'vendor' with
--                   confidence >= 80
--   manual        — coordinator added by hand on the settings page
--   backfill      — one-shot scanner over historical interactions
--                   already classified 'vendor' (sweep endpoint)
--
-- Confidence is preserved on AI promotions so the coordinator UI can
-- sort + colour-code, and so we can bump it on subsequent confirmations
-- without inserting duplicates.
--
-- RLS: matches migration 245 (auth_select / insert / update / delete).
-- The legacy venue_isolation pattern would silently drop INSERTs when
-- the coordinator's user_profiles.venue_id mismatches, which is the
-- multi-venue trap we hit on brand_assets.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS public.venue_vendor_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- The sender domain (lower-cased, no leading @, no path). Matches the
  -- format produced by `from_email.split('@').pop().toLowerCase()` in
  -- the email pipeline. 'gibsonrental.com' not '@gibsonrental.com'.
  domain text NOT NULL,

  -- How this row got here. See file header for definitions.
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('ai_classifier', 'manual', 'backfill')),

  -- 0..100 confidence stamp at the time of promotion. Manual additions
  -- default to 100 (the coordinator vouched for it). AI promotions
  -- carry the Haiku confidence; if a later AI sweep returns a higher
  -- confidence on the same domain, the upsert bumps this.
  confidence integer NOT NULL DEFAULT 100
    CHECK (confidence >= 0 AND confidence <= 100),

  -- Optional human note. Surfaced in the settings UI; not consulted by
  -- the matcher.
  note text,

  added_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Track who added the domain when known (manual additions). NULL for
  -- ai_classifier / backfill rows.
  added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  CONSTRAINT venue_vendor_domains_domain_nonempty
    CHECK (length(trim(domain)) > 0),
  CONSTRAINT venue_vendor_domains_domain_lowercase
    CHECK (domain = lower(domain))
);

-- One row per (venue, domain). Drives the upsert behaviour: subsequent
-- AI sweeps that re-encounter a known domain bump confidence without
-- inserting a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_venue_vendor_domains_venue_domain
  ON public.venue_vendor_domains (venue_id, domain);

-- The hot-path lookup is "given a venue_id + sender domain, is it
-- in the allow-list?". The unique index above already serves that
-- query, but we also want a covering index on (venue_id) alone for
-- the bulk loader the lifecycle helper hits once per
-- updateThreadLifecycleFolder call.
CREATE INDEX IF NOT EXISTS idx_venue_vendor_domains_venue
  ON public.venue_vendor_domains (venue_id);

COMMENT ON TABLE public.venue_vendor_domains IS
  'Per-venue vendor-domain allow-list (migration 258). Companion to '
  'ADVERTISER_DOMAINS in src/lib/services/inbox/lifecycle.ts. Checked '
  'BEFORE the rule chain falls to ''other'' so subsequent emails from '
  'a known vendor domain skip the Haiku call. Promoted by '
  '/api/admin/reclass-folders-ai when confidence >= 80.';

COMMENT ON COLUMN public.venue_vendor_domains.source IS
  'ai_classifier | manual | backfill. Provenance of the row — surfaced '
  'in the settings UI so a coordinator can tell a Haiku auto-promotion '
  'from a manual addition. ai_classifier rows can be safely re-promoted '
  'on subsequent sweeps (idempotent upsert).';

COMMENT ON COLUMN public.venue_vendor_domains.confidence IS
  '0..100 confidence stamp at promotion time. Manual=100. AI=Haiku '
  'classifier confidence. Bumped (never lowered) on subsequent '
  'confirmations of the same domain.';

-- ---------------------------------------------------------------------------
-- RLS — auth-permissive baseline (mirrors migration 245).
-- ---------------------------------------------------------------------------

ALTER TABLE public.venue_vendor_domains ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_venue_vendor_domains"
  ON public.venue_vendor_domains;
CREATE POLICY "auth_select_venue_vendor_domains" ON public.venue_vendor_domains
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_venue_vendor_domains"
  ON public.venue_vendor_domains;
CREATE POLICY "auth_insert_venue_vendor_domains" ON public.venue_vendor_domains
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_venue_vendor_domains"
  ON public.venue_vendor_domains;
CREATE POLICY "auth_update_venue_vendor_domains" ON public.venue_vendor_domains
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_delete_venue_vendor_domains"
  ON public.venue_vendor_domains;
CREATE POLICY "auth_delete_venue_vendor_domains" ON public.venue_vendor_domains
  FOR DELETE TO authenticated USING (true);

COMMIT;

NOTIFY pgrst, 'reload schema';
