-- ---------------------------------------------------------------------------
-- 407_ad_connections.sql  (W54)
-- ---------------------------------------------------------------------------
-- Per-venue connection rows for the two ad platforms that did not have
-- one: Meta Ads and TikTok Ads. Google Ads already has its table from
-- migration 310 (google_ads_connections); this migration only adds the
-- one column that table was missing so all three read the same way.
--
-- WHY THIS EXISTS
-- ---------------
-- Until now every ad-spend figure in Bloom was typed in by hand from a
-- screenshot. The coordinator reads a number off the Meta dashboard,
-- types it into /intel/marketing-spend, and the reallocation page then
-- reasons about it as if it were measured. It says so plainly on the
-- page, which is honest, but honest about a gap is still a gap. A venue
-- that grants read access gets the real daily figure per campaign, and
-- the same page stops hedging for them.
--
-- WHAT A ROW HOLDS
-- ----------------
-- The account id to read from, the token to read it with, and the
-- audit trail of who connected it and when it last worked. One row per
-- venue per platform, which is what lets the connector status flip per
-- venue rather than globally.
--
-- SECRETS
-- -------
-- App credentials (META_ADS_APP_ID / META_ADS_APP_SECRET,
-- TIKTOK_ADS_APP_ID / TIKTOK_ADS_APP_SECRET) are single global env
-- vars, the same pattern Twilio, Calendly, Google Ads and Instagram
-- already use. What is per-venue is the account token, because it is
-- minted per ad account during the grant. Two ways to hold it, in
-- priority order, copied from migration 401:
--
--   1. token_env_key   the NAME of an env var holding the token.
--      Nothing secret lands in the database. Safe default for the
--      first venue while encryption at rest is still owed.
--   2. access_token    the token itself, service-role only, never
--      selectable by an authenticated client (see the column grants
--      at the foot of each table).
--
-- HARDENING TODO, the same marker google_ads_connections (310) and
-- instagram_connections (401) carry: wrap access_token and
-- refresh_token in pgsodium before a second venue connects.
--
-- Idempotent: IF NOT EXISTS on every CREATE, DROP POLICY IF EXISTS
-- before every CREATE POLICY. Schema-qualified throughout. No
-- BEGIN/COMMIT wrapper (Wave 23 doctrine).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 - meta_ads_connections
-- ============================================================================
-- Meta Marketing API. The read is
-- GET graph.facebook.com/v21.0/act_<ad_account_id>/insights with
-- fields spend, impressions, clicks, actions and a daily time
-- increment.
--
-- Meta has no refresh grant in the OAuth sense. A short-lived user
-- token is exchanged once for a long-lived one (about 60 days), and
-- that long-lived token is extended by exchanging it for another before
-- it lapses. token_expires_at is what the connector watches to know
-- when to do that.

CREATE TABLE IF NOT EXISTS public.meta_ads_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- The ad account to read. Meta returns it as "act_123456789"; we
  -- store the bare numeric part and the connector adds the prefix, so
  -- an operator who pastes either form gets the same behaviour.
  ad_account_id text,
  ad_account_name text,
  -- Business Manager the account sits under. Informational.
  business_id text,

  -- Token. EITHER an env-var name (nothing secret stored) OR the token
  -- itself. The reader prefers token_env_key.
  token_env_key text,
  access_token text,
  token_expires_at timestamptz,
  scope text,
  token_type text,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'error', 'revoked')),
  status_reason text,

  connected_by uuid REFERENCES public.user_profiles(id),
  connected_at timestamptz,
  last_synced_at timestamptz,
  last_error_at timestamptz,
  last_error_message text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.meta_ads_connections IS
  'owner:intelligence. W54 (migration 407). One row per venue for Meta '
  'Ads daily spend through the Meta Marketing API. ad_account_id is the '
  'account the insights read targets. The token is held either as an '
  'env-var NAME (token_env_key, preferred) or as the token itself '
  '(access_token, service-role only). HARDENING TODO: pgsodium on '
  'access_token before a second venue connects.';

COMMENT ON COLUMN public.meta_ads_connections.ad_account_id IS
  'Numeric ad account id without the act_ prefix. The connector adds '
  'the prefix when building the insights URL.';

COMMENT ON COLUMN public.meta_ads_connections.token_env_key IS
  'Name of the environment variable holding the access token. '
  'Preferred over access_token: nothing secret lands in the row.';

COMMENT ON COLUMN public.meta_ads_connections.access_token IS
  'Long-lived user access token. Service-role only, never returned to '
  'an authenticated client. NULL when token_env_key is used instead.';

COMMENT ON COLUMN public.meta_ads_connections.last_synced_at IS
  'Stamped when a spend sync completes for this venue. The settings '
  'page reads it as "last sync".';

CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_ads_connections_venue
  ON public.meta_ads_connections (venue_id);

CREATE INDEX IF NOT EXISTS idx_meta_ads_connections_status
  ON public.meta_ads_connections (status, last_synced_at);

-- ============================================================================
-- STEP 2 - tiktok_ads_connections
-- ============================================================================
-- TikTok Business API. The read is
-- GET business-api.tiktok.com/open_api/v1.3/report/integrated/get/ with
-- a CAMPAIGN data level and a daily dimension.
--
-- TikTok does issue a refresh token for some account types, so unlike
-- Meta there are two secrets to hold.

CREATE TABLE IF NOT EXISTS public.tiktok_ads_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  advertiser_id text,
  advertiser_name text,
  -- TikTok's report endpoint returns spend as a bare decimal with no
  -- currency on it, so the currency has to come from the advertiser
  -- record instead. Without this column every non-dollar venue would
  -- have its spend silently filed as dollars.
  currency text,

  token_env_key text,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'error', 'revoked')),
  status_reason text,

  connected_by uuid REFERENCES public.user_profiles(id),
  connected_at timestamptz,
  last_synced_at timestamptz,
  last_error_at timestamptz,
  last_error_message text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tiktok_ads_connections IS
  'owner:intelligence. W54 (migration 407). One row per venue for '
  'TikTok Ads daily spend through the TikTok Business API. '
  'advertiser_id is the account the report read targets. The token is '
  'held either as an env-var NAME (token_env_key, preferred) or as the '
  'token itself (access_token, service-role only). HARDENING TODO: '
  'pgsodium on access_token and refresh_token before a second venue '
  'connects.';

COMMENT ON COLUMN public.tiktok_ads_connections.advertiser_id IS
  'TikTok advertiser id. Required on every report call; the connector '
  'refuses to run without it rather than guessing an account.';

COMMENT ON COLUMN public.tiktok_ads_connections.token_env_key IS
  'Name of the environment variable holding the access token. '
  'Preferred over access_token: nothing secret lands in the row.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_tiktok_ads_connections_venue
  ON public.tiktok_ads_connections (venue_id);

CREATE INDEX IF NOT EXISTS idx_tiktok_ads_connections_status
  ON public.tiktok_ads_connections (status, last_synced_at);

-- ============================================================================
-- STEP 3 - google_ads_connections gains last_synced_at
-- ============================================================================
-- Migration 310 gave that table last_used_at, which the OAuth layer
-- stamps on every token read. The three connectors want one column that
-- means "a spend sync finished", separate from "a token was read", so
-- all three settings pages can show the same line. Additive and
-- idempotent; 310 itself is untouched.

-- Guarded on the table existing, because 310 has never been applied to
-- production and sits in the legacy list in
-- scripts/apply-pending-migrations.ts. If 310 lands after this, its own
-- CREATE TABLE runs and this column is added the next time 407 is
-- replayed. An unguarded ALTER here would make 407 unapplyable on any
-- database where 310 is still owed, which is most of them.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'google_ads_connections'
  ) THEN
    ALTER TABLE public.google_ads_connections
      ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

    COMMENT ON COLUMN public.google_ads_connections.last_synced_at IS
      'W54 (migration 407). Stamped when a spend sync completes for this '
      'venue. Distinct from last_used_at, which moves whenever the token '
      'is read.';
  END IF;
END $$;

-- ============================================================================
-- STEP 4 - row security
-- ============================================================================
-- Venue-scoped read and write, super-admin bypass, service_role full.
-- Copied from the prod-proven 401 pattern.
--
-- Deliberately no demo-anon read policy: these rows carry a credential.
-- The demo venues have no live ad connection and must not be able to
-- enumerate anyone else's.

ALTER TABLE public.meta_ads_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "meta_ads_connections_select" ON public.meta_ads_connections;
CREATE POLICY "meta_ads_connections_select" ON public.meta_ads_connections
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

DROP POLICY IF EXISTS "meta_ads_connections_modify" ON public.meta_ads_connections;
CREATE POLICY "meta_ads_connections_modify" ON public.meta_ads_connections
  FOR ALL TO authenticated
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
  )
  WITH CHECK (
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

DROP POLICY IF EXISTS "meta_ads_connections_service" ON public.meta_ads_connections;
CREATE POLICY "meta_ads_connections_service" ON public.meta_ads_connections
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.tiktok_ads_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tiktok_ads_connections_select" ON public.tiktok_ads_connections;
CREATE POLICY "tiktok_ads_connections_select" ON public.tiktok_ads_connections
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

DROP POLICY IF EXISTS "tiktok_ads_connections_modify" ON public.tiktok_ads_connections;
CREATE POLICY "tiktok_ads_connections_modify" ON public.tiktok_ads_connections
  FOR ALL TO authenticated
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
  )
  WITH CHECK (
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

DROP POLICY IF EXISTS "tiktok_ads_connections_service" ON public.tiktok_ads_connections;
CREATE POLICY "tiktok_ads_connections_service" ON public.tiktok_ads_connections
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- STEP 5 - updated_at triggers
-- ============================================================================
-- Guarded on the shared helper so the migration still applies on a
-- database that predates it.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'set_updated_at' AND n.nspname = 'public'
  ) THEN
    DROP TRIGGER IF EXISTS trg_meta_ads_connections_updated_at
      ON public.meta_ads_connections;
    CREATE TRIGGER trg_meta_ads_connections_updated_at
      BEFORE UPDATE ON public.meta_ads_connections
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

    DROP TRIGGER IF EXISTS trg_tiktok_ads_connections_updated_at
      ON public.tiktok_ads_connections;
    CREATE TRIGGER trg_tiktok_ads_connections_updated_at
      BEFORE UPDATE ON public.tiktok_ads_connections
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ============================================================================
-- STEP 6 - column grants
-- ============================================================================
-- Row security decides which ROWS an authenticated user sees; these
-- grants decide which COLUMNS. A token must never leave the service
-- role, so authenticated is granted every column except the token ones.
--
-- Consequence worth knowing, the same one migration 401 documents: with
-- a column-level SELECT grant, a select('*') from an authenticated
-- client gets "permission denied for column access_token" rather than a
-- partial row. Every reader in this repo names its columns, and the
-- settings pages read through the server-side status routes anyway. A
-- new reader that reaches for * will fail loudly, which is the
-- behaviour we want on a table holding a credential.

REVOKE ALL ON public.meta_ads_connections FROM authenticated;
GRANT SELECT (
  id, venue_id, ad_account_id, ad_account_name, business_id,
  token_env_key, token_expires_at, scope, token_type,
  status, status_reason, connected_by, connected_at, last_synced_at,
  last_error_at, last_error_message, created_at, updated_at
) ON public.meta_ads_connections TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.meta_ads_connections TO authenticated;

REVOKE ALL ON public.tiktok_ads_connections FROM authenticated;
GRANT SELECT (
  id, venue_id, advertiser_id, advertiser_name, currency,
  token_env_key, token_expires_at, refresh_token_expires_at, scope,
  status, status_reason, connected_by, connected_at, last_synced_at,
  last_error_at, last_error_message, created_at, updated_at
) ON public.tiktok_ads_connections TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.tiktok_ads_connections TO authenticated;

NOTIFY pgrst, 'reload schema';
