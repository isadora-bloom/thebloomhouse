-- ---------------------------------------------------------------------------
-- 309_web_pixel.sql  (Wave 6E follow-up — close the cross-session attribution gap)
-- ---------------------------------------------------------------------------
-- The TBH Report's coverage disclosure called out pixel='not_installed'
-- as the single biggest cross-session attribution gap. This migration
-- lands the substrate that fills it.
--
-- Architecture (per the original investigation):
--
--   1. Pixel snippet on the venue's marketing site fires on every
--      pageview. POSTs to /api/v1/visit with the venue's per-venue
--      pixel_ingest_key. Sets a first-party cookie `bloom_visitor_id`
--      that follows the visitor across sessions (1-year max-age).
--
--   2. The /api/v1/visit endpoint validates the ingest key, writes a
--      web_visits row with utm_*, gclid/fbclid/ttclid/msclkid,
--      document.referrer, landing path, IP hash, UA hash.
--
--   3. When a form on the venue's site submits to Bloom (web-form
--      adapter, existing migration 205 path), the form payload
--      includes bloom_visitor_id from the cookie. The adapter writes
--      candidate_identities + ties web_visits.candidate_identity_id
--      back, creating the cross-session attribution chain.
--
-- This migration adds ONLY the substrate. The endpoint + pixel.js +
-- form integration are app-layer code.
--
-- Constitution alignment: web_visits is a PRE-ZERO candidate signal in
-- the Constitution's sense. It identifies a candidate identity (the
-- anonymous visitor) BEFORE Point Zero (name + reachable identifier).
-- The resolver promotes web_visits → candidate_identity → wedding the
-- same way Knot CSV signals do.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — venue_config: pixel_ingest_key + pixel_installed_at
-- ============================================================================
-- Per-venue ingest key. Generated on first read via app-level
-- gen_random_uuid() so existing rows backfill lazily. Stored separately
-- from the venue's API key so leaking the pixel key (it's embedded in
-- the public website's HTML) doesn't compromise anything else.

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS pixel_ingest_key text;

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS pixel_installed_at timestamptz;

COMMENT ON COLUMN public.venue_config.pixel_ingest_key IS
  'Per-venue public key embedded in the bloom-pixel.js snippet. Validates '
  '/api/v1/visit posts. Rotatable via /portal/pixel-config without re-'
  'deploying the snippet on the venue website (rotation invalidates the '
  'old key and the venue swaps the snippet). NULL until first read on '
  'the config page, then back-filled to gen_random_uuid()::text.';

COMMENT ON COLUMN public.venue_config.pixel_installed_at IS
  'Set the first time we receive a successful /api/v1/visit POST from '
  'this venue. Read by the TBH Report coverage disclosure to mark the '
  'pre-pixel period as forensic-only.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_venue_config_pixel_ingest_key
  ON public.venue_config (pixel_ingest_key)
  WHERE pixel_ingest_key IS NOT NULL;

-- ============================================================================
-- STEP 2 — web_visits table
-- ============================================================================
-- One row per pageview ingested via the pixel. anon_visitor_id is the
-- first-party cookie value (UUID, set client-side on first visit).
-- candidate_identity_id is NULL until a form submission carrying the
-- same cookie resolves the visitor to a person.

CREATE TABLE IF NOT EXISTS public.web_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- First-party cookie value. UUID v4 set by the pixel on first visit.
  -- Same visitor across sessions keeps the same value (1-year cookie).
  anon_visitor_id text NOT NULL,

  -- UTM + click-id capture. Captured on every visit; the FIRST non-null
  -- value across a (venue, anon_visitor_id) cluster is the canonical
  -- first-touch attribution input. App-layer resolver enforces.
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,

  -- Click identifiers from ad platforms. gclid = Google Ads,
  -- fbclid = Meta, ttclid = TikTok, msclkid = Microsoft.
  gclid text,
  fbclid text,
  ttclid text,
  msclkid text,

  -- Where the visitor came from + landed.
  referrer text,
  landing_path text,

  -- Hashed IP + UA for de-duplication + bot filtering. Raw values are
  -- never stored — privacy + size.
  ip_hash text,
  user_agent_hash text,

  -- When the pageview fired (per the pixel's client clock; we trust it
  -- within a tolerance band — ingest fills server time if missing).
  occurred_at timestamptz NOT NULL DEFAULT now(),

  -- Once a form submission ties this anonymous visitor to a real
  -- person, the resolver back-fills these columns.
  candidate_identity_id uuid REFERENCES public.candidate_identities(id) ON DELETE SET NULL,
  resolved_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT web_visits_anon_visitor_id_nonempty
    CHECK (length(trim(anon_visitor_id)) > 0)
);

COMMENT ON TABLE public.web_visits IS
  'owner:intelligence. Wave 6E follow-up. One row per pixel-tracked '
  'pageview on the venue marketing site. Anonymous until a form '
  'submission with the same bloom_visitor_id cookie resolves the '
  'visitor to a candidate_identity. Captures UTM + click-ids + referrer '
  'so cross-session attribution survives the gap between first ad-click '
  'and the form fill 3 days later. Migration 309.';

COMMENT ON COLUMN public.web_visits.anon_visitor_id IS
  'First-party cookie value (UUID v4). Same visitor across sessions '
  'keeps the same value for the 1-year cookie life. Resolver clusters '
  'by (venue, anon_visitor_id) to find first-touch.';

COMMENT ON COLUMN public.web_visits.gclid IS
  'Google Ads click identifier. When present, the Google Ads OAuth '
  'connector can lift the matching keyword + match type + ad group, '
  'which closes the brand-search vs non-brand attribution gap.';

COMMENT ON COLUMN public.web_visits.ip_hash IS
  'SHA-256 of the visitor IP with a per-venue salt. Used for bot '
  'filtering + de-duplication but never reversible to a raw address.';

CREATE INDEX IF NOT EXISTS idx_web_visits_venue_visitor
  ON public.web_visits (venue_id, anon_visitor_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_web_visits_venue_recent
  ON public.web_visits (venue_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_web_visits_candidate
  ON public.web_visits (candidate_identity_id)
  WHERE candidate_identity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_web_visits_gclid
  ON public.web_visits (gclid)
  WHERE gclid IS NOT NULL;

-- ============================================================================
-- STEP 3 — RLS
-- ============================================================================
-- Authenticated users see their own venue's visits (for the /intel
-- diagnostics page). Service role does all writes via the public ingest
-- endpoint. Anonymous is NEVER allowed to read.

ALTER TABLE public.web_visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "web_visits_select" ON public.web_visits;
CREATE POLICY "web_visits_select" ON public.web_visits
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "web_visits_service" ON public.web_visits;
CREATE POLICY "web_visits_service" ON public.web_visits
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
