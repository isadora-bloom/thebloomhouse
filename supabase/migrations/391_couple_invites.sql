-- 391: couple portal invitations become a real credential
--
-- Before this, the ONLY thing standing between a stranger and a couple's
-- portal account was weddings.event_code: a three letter venue prefix plus
-- three digits (provisionCouplePortal), globally unique since migration 047,
-- printed in the invitation email, never expiring, and accepted by
-- /api/couple/register with no rate limit. Nine hundred codes per venue
-- prefix is a weekend of guessing.
--
-- The event code stays, as a human reference a coordinator can read down the
-- phone. It is no longer a credential. Registration now needs a row in this
-- table: a 128 bit random token minted when the coordinator sends the invite,
-- of which we store only the sha256. The plaintext exists in the emailed link
-- and nowhere else, so a database read does not yield a working invite.
--
-- Single use and time limited. The email body has claimed "expires in 14 days"
-- since it was written; expires_at is what finally makes that true.
--
-- Schema-qualified on purpose: scripts/run-migration.ts drives public.exec_sql,
-- which runs with search_path = pg_catalog, public. An unqualified CREATE lands
-- in the first schema on that path and fails with 42501.

CREATE TABLE IF NOT EXISTS public.couple_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  -- Address the invite was sent to. Registration must present this same
  -- address, compared case-insensitively, so a forwarded link cannot be
  -- redeemed by whoever it was forwarded to.
  email text NOT NULL,
  -- sha256 of the plaintext token, lower-case hex. Never the token itself.
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  used_at timestamptz,
  -- The coordinator who sent it. Deliberately not a foreign key: demo mode
  -- hands out a synthetic user id, and an invite outliving the coordinator
  -- who sent it is not a reason to lose the audit trail.
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Redemption path: look the token up by its hash. Unique already indexes it,
-- so these two are for the coordinator-facing reads (what is outstanding for
-- this wedding, what has this venue sent).
CREATE INDEX IF NOT EXISTS idx_couple_invites_wedding
  ON public.couple_invites (wedding_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_couple_invites_venue_open
  ON public.couple_invites (venue_id, expires_at)
  WHERE used_at IS NULL;

COMMENT ON TABLE public.couple_invites IS
  'Single-use, 14-day couple portal invitations. token_hash is sha256 of a 128-bit token that exists in plaintext only inside the emailed link. Redeemed by /api/couple/register, which claims the row by setting used_at.';

COMMENT ON COLUMN public.couple_invites.token_hash IS
  'Lower-case hex sha256 of the invite token. A database read must not yield a usable invite.';

-- ---------------------------------------------------------------------------
-- Venue isolation (gap G17). Canonical policy set copied from the prod-proven
-- 377/383/389 pattern, with one deliberate difference: NO demo anon read.
-- Every other venue-scoped table grants anon SELECT on demo venues so the
-- Crestwood demo keeps working. Invitations are credentials. Anon reads
-- nothing here, demo or not, and the demo portal does not need it because
-- demo couples never register.
--
-- Both real code paths (the invite sender and the register endpoint) use
-- createServiceClient, so the service_role policy is what makes the feature
-- work. The authenticated policies exist so a future direct-from-client read
-- cannot cross a venue boundary.
-- ---------------------------------------------------------------------------

ALTER TABLE public.couple_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "couple_invites_select" ON public.couple_invites;
CREATE POLICY "couple_invites_select" ON public.couple_invites
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

DROP POLICY IF EXISTS "couple_invites_modify" ON public.couple_invites;
CREATE POLICY "couple_invites_modify" ON public.couple_invites
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

DROP POLICY IF EXISTS "couple_invites_service" ON public.couple_invites;
CREATE POLICY "couple_invites_service" ON public.couple_invites
  FOR ALL TO service_role USING (true) WITH CHECK (true);
