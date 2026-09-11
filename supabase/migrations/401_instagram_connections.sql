-- ---------------------------------------------------------------------------
-- 401_instagram_connections.sql  (Wave 3, W28)
-- ---------------------------------------------------------------------------
-- Per-venue connection row for Instagram DMs through the Meta Messaging
-- API. Spec: HANDLE-IDENTITY-SPEC.md §4, the "Instagram DMs via Meta
-- Messaging API" row of the sources table.
--
-- WHY THIS EXISTS
-- ---------------
-- A DM is the first place a couple says anything in their own words, and
-- today it lands nowhere. The webhook at /api/webhooks/instagram turns
-- each inbound message into one NormalizedSignal with handles.instagram
-- set and hands it to linkSignal, exactly as the SMS path does. To route
-- an incoming Meta event to the right venue we need a lookup from the
-- Instagram business account id (which Meta puts in entry[].id) to a
-- venue, plus the page token that lets us resolve the sender's IGSID to
-- a username. That lookup is this table.
--
-- SECRETS
-- -------
-- The Meta app credentials (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET /
-- INSTAGRAM_VERIFY_TOKEN) are single global env vars, following the same
-- pattern as Twilio, Calendly and Google Ads. Per-venue secrets are
-- parked. What IS per-venue is the page access token, because it is
-- minted per Facebook Page during the OAuth exchange. Two ways to hold
-- it, in priority order:
--
--   1. page_token_env_key — the NAME of an env var holding the token.
--      Nothing secret lands in the database. This is the safe default
--      for the first venue (Rixey) while encryption at rest is still
--      owed.
--   2. page_access_token  — the token itself, service-role only, never
--      selectable by an authenticated client (see the column grants
--      below). Written by the OAuth callback.
--
-- HARDENING TODO (same marker google_ads_connections carries, mig 310):
-- wrap page_access_token in pgsodium before a second venue connects.
--
-- Idempotent: IF NOT EXISTS on every CREATE, DROP POLICY IF EXISTS
-- before every CREATE POLICY. Schema-qualified throughout. No
-- BEGIN/COMMIT wrapper (Wave 23 doctrine).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.instagram_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Meta identifiers. ig_business_id is the Instagram professional
  -- account id; it is what arrives as entry[].id on every messaging
  -- webhook, so it is the routing key. page_id is the Facebook Page the
  -- Instagram account is linked to, which is what the token belongs to.
  -- Both are free text: Meta returns them as decimal strings that do not
  -- fit in a bigint on every tier.
  ig_business_id text,
  ig_username text,
  page_id text,
  page_name text,

  -- Page access token. EITHER an env-var name (nothing secret stored)
  -- OR the token itself. The reader prefers page_token_env_key.
  page_token_env_key text,
  page_access_token text,
  token_expires_at timestamptz,

  -- Connection state. 'pending' until the OAuth exchange completes or an
  -- operator pastes a token; 'connected' means we believe the token
  -- works; 'error' means the last Graph call failed and the venue needs
  -- to reconnect; 'revoked' means an operator disconnected on purpose.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'error', 'revoked')),
  status_reason text,

  -- Audit + the operator-facing "is anything actually arriving" line.
  connected_by uuid REFERENCES public.user_profiles(id),
  connected_at timestamptz,
  -- Stamped by the webhook every time an inbound message is accepted for
  -- this venue. This is the field the settings page shows as "last event".
  last_event_at timestamptz,
  last_error_at timestamptz,
  last_error_message text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.instagram_connections IS
  'owner:intelligence. Wave 3 W28 (migration 401). One row per venue for '
  'Instagram DMs through the Meta Messaging API. ig_business_id is the '
  'webhook routing key (entry[].id). The page token is held either as an '
  'env-var NAME (page_token_env_key, preferred) or as the token itself '
  '(page_access_token, service-role only). HARDENING TODO: pgsodium on '
  'page_access_token before a second venue connects.';

COMMENT ON COLUMN public.instagram_connections.ig_business_id IS
  'Instagram professional account id. Arrives as entry[].id on every '
  'messaging webhook, so this is how an event finds its venue.';

COMMENT ON COLUMN public.instagram_connections.page_token_env_key IS
  'Name of the environment variable holding the page access token. '
  'Preferred over page_access_token: nothing secret lands in the row.';

COMMENT ON COLUMN public.instagram_connections.page_access_token IS
  'Page access token. Service-role only, never returned to an '
  'authenticated client. NULL when page_token_env_key is used instead.';

COMMENT ON COLUMN public.instagram_connections.last_event_at IS
  'Stamped when the webhook accepts an inbound message for this venue. '
  'The settings page reads it as "last event".';

-- One connection per venue. Matches openphone_connections +
-- google_ads_connections, and lets the OAuth callback upsert on venue_id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_connections_venue
  ON public.instagram_connections (venue_id);

-- The webhook's hot path: ig_business_id -> venue. Unique because two
-- venues cannot share one Instagram account, and a duplicate would make
-- routing ambiguous in a way the webhook should refuse rather than guess.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_connections_ig_business
  ON public.instagram_connections (ig_business_id)
  WHERE ig_business_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_instagram_connections_status
  ON public.instagram_connections (status);

-- ---------------------------------------------------------------------------
-- updated_at trigger, if the shared helper exists. Guarded so the
-- migration still applies on a database that predates it.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'set_updated_at' AND n.nspname = 'public'
  ) THEN
    DROP TRIGGER IF EXISTS trg_instagram_connections_updated_at
      ON public.instagram_connections;
    CREATE TRIGGER trg_instagram_connections_updated_at
      BEFORE UPDATE ON public.instagram_connections
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RLS — venue-scoped read/write, super_admin bypass, service_role full.
-- Copied from the prod-proven 377 / 383 pattern.
--
-- Deliberately NO demo-anon read policy: unlike knot_visitor_activity,
-- this row carries a credential. The demo venue has no Instagram
-- connection and should not be able to enumerate anyone else's.
-- ---------------------------------------------------------------------------

ALTER TABLE public.instagram_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "igconn_select" ON public.instagram_connections;
CREATE POLICY "igconn_select" ON public.instagram_connections
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

DROP POLICY IF EXISTS "igconn_modify" ON public.instagram_connections;
CREATE POLICY "igconn_modify" ON public.instagram_connections
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

DROP POLICY IF EXISTS "igconn_service" ON public.instagram_connections;
CREATE POLICY "igconn_service" ON public.instagram_connections
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Column grants. RLS decides which ROWS an authenticated user sees; these
-- grants decide which COLUMNS. The token must never leave the service
-- role, so `authenticated` is granted every column except
-- page_access_token.
--
-- Consequence worth knowing: with a column-level SELECT grant, a
-- `select('*')` from an authenticated client gets "permission denied for
-- column page_access_token" rather than a partial row. Every reader in
-- this repo names its columns, and the settings page reads through the
-- server-side status route anyway, so nothing in-tree hits that. A new
-- reader that reaches for `*` will fail loudly, which is the behaviour
-- we want on a table holding a credential.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.instagram_connections FROM authenticated;
GRANT SELECT (
  id, venue_id, ig_business_id, ig_username, page_id, page_name,
  page_token_env_key, token_expires_at, status, status_reason,
  connected_by, connected_at, last_event_at, last_error_at,
  last_error_message, created_at, updated_at
) ON public.instagram_connections TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.instagram_connections TO authenticated;

NOTIFY pgrst, 'reload schema';
