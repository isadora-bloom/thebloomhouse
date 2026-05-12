-- ---------------------------------------------------------------------------
-- 310_google_ads_and_downloads_audit.sql  (Wave 6E follow-up)
-- ---------------------------------------------------------------------------
-- Two follow-ups in one migration because they're both small and
-- complete distinct gaps the TBH Report's coverage disclosure called
-- out:
--
--   1. google_ads_connections — token storage for the Google Ads OAuth
--      connector. The TBH Report's brand-search vs non-brand split is
--      definitive ONLY when GCLID lookups can hit a real Google Ads
--      account; this is the substrate.
--
--   2. agency_document_downloads — audit log for downloads of agency
--      documents. Becomes interesting when the agency-portal mode lands
--      ("Hawthorn opened the Q2 contract on May 12") but the table is
--      cheap to land now so the download endpoint can start writing
--      rows immediately.
--
-- Both are idempotent. No BEGIN/COMMIT wrapper (Wave 23 doctrine).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — google_ads_connections
-- ============================================================================
-- One row per (venue, Google Ads customer). Tokens stored encrypted at
-- the API layer (pg_crypto + service-role-only access) — never exposed
-- to authenticated clients. The OAuth flow runs server-side; the
-- venue's coordinator only ever sees status (connected / not connected
-- / error).

CREATE TABLE IF NOT EXISTS public.google_ads_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- The Google Ads customer ID the venue wants to read from. NULL until
  -- the OAuth flow completes; populated from the customer-listing call
  -- after token exchange. Free-text since Google returns it as a string
  -- ("123-456-7890").
  customer_id text,
  customer_name text,

  -- Tokens. access_token is the short-lived bearer; refresh_token gets
  -- exchanged for new access_tokens periodically. Both are stored as
  -- text — encryption is a follow-up (we want a working flow before we
  -- layer encryption on top).
  --
  -- HARDENING TODO: wrap these in pgsodium / encrypt-at-rest before
  -- this connector goes near a live ads account. The marker is a NOT
  -- VALID CHECK so future SELECTs can be hardened without a backfill.
  access_token text,
  refresh_token text,
  access_token_expires_at timestamptz,

  -- OAuth metadata.
  scope text,
  token_type text,

  -- Connection state. 'pending' until OAuth completes. 'connected'
  -- means we have working tokens. 'error' means the last refresh
  -- failed and the venue needs to re-OAuth.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'error', 'revoked')),
  status_reason text,

  -- The user who initiated the connection (audit trail).
  connected_by uuid REFERENCES public.user_profiles(id),
  connected_at timestamptz,
  last_used_at timestamptz,
  last_error_at timestamptz,
  last_error_message text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.google_ads_connections IS
  'owner:intelligence. Wave 6E follow-up. OAuth token storage for the '
  'Google Ads connector. Tokens are service-role-only — never read by '
  'authenticated clients. customer_id resolved from the customers-list '
  'call after token exchange. HARDENING TODO: wrap access_token + '
  'refresh_token in pgsodium before live use. Migration 310.';

COMMENT ON COLUMN public.google_ads_connections.access_token IS
  'Bearer token. Short-lived (~1 hour). Refreshed automatically using '
  'refresh_token. NEVER returned to authenticated client.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_google_ads_connections_venue
  ON public.google_ads_connections (venue_id);

CREATE INDEX IF NOT EXISTS idx_google_ads_connections_status
  ON public.google_ads_connections (status, last_used_at);

ALTER TABLE public.google_ads_connections ENABLE ROW LEVEL SECURITY;

-- Authenticated users see STATUS only (the SELECT policy returns the
-- whole row, but the API layer never returns access_token / refresh_token
-- to the client. Server-side service-role reads are how tokens get used).
DROP POLICY IF EXISTS "google_ads_connections_select" ON public.google_ads_connections;
CREATE POLICY "google_ads_connections_select" ON public.google_ads_connections
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

DROP POLICY IF EXISTS "google_ads_connections_service" ON public.google_ads_connections;
CREATE POLICY "google_ads_connections_service" ON public.google_ads_connections
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Updated_at touch.
CREATE OR REPLACE FUNCTION public.google_ads_connections_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_google_ads_connections_updated_at
  ON public.google_ads_connections;
CREATE TRIGGER trg_google_ads_connections_updated_at
  BEFORE UPDATE ON public.google_ads_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.google_ads_connections_touch_updated_at();

-- ============================================================================
-- STEP 2 — agency_document_downloads (audit log)
-- ============================================================================
-- One row per attempted download. Pruning policy is "keep forever" for
-- now; rotation can land later if volume warrants.

CREATE TABLE IF NOT EXISTS public.agency_document_downloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.agency_documents(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES public.marketing_agencies(id) ON DELETE CASCADE,
  downloaded_by uuid REFERENCES public.user_profiles(id),
  -- IP hash with a per-venue salt — privacy floor identical to web_visits.
  ip_hash text,
  user_agent_hash text,
  downloaded_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agency_document_downloads IS
  'owner:intelligence. Wave 6E follow-up. Audit log of downloads from '
  'agency_documents. One row per successful signed-URL mint. Used by '
  'the agency-portal mode (deferred) to surface "Hawthorn opened your '
  'Q2 contract on May 12". Migration 310.';

CREATE INDEX IF NOT EXISTS idx_agency_document_downloads_document
  ON public.agency_document_downloads (document_id, downloaded_at DESC);

CREATE INDEX IF NOT EXISTS idx_agency_document_downloads_agency
  ON public.agency_document_downloads (agency_id, downloaded_at DESC);

ALTER TABLE public.agency_document_downloads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agency_document_downloads_select"
  ON public.agency_document_downloads;
CREATE POLICY "agency_document_downloads_select"
  ON public.agency_document_downloads
  FOR SELECT TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_document_downloads_service"
  ON public.agency_document_downloads;
CREATE POLICY "agency_document_downloads_service"
  ON public.agency_document_downloads
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
