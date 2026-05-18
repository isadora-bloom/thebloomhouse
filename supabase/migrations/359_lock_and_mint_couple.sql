-- ---------------------------------------------------------------------------
-- 359_lock_and_mint_couple.sql
-- ---------------------------------------------------------------------------
-- Tier 8 / T8.1a. The advisory-locked couple-mint RPC.
--
-- Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 ("Don't skip #1" — advisory
-- lock around every couple mint) + Appendix C §C.3 + §C.5 T8.1.
--
-- Why an RPC and not two supabase-js calls
-- ----------------------------------------
-- The doctrine requires pg_try_advisory_xact_lock around every couple
-- mint. xact-scoped locks release at COMMIT/ROLLBACK — they only mean
-- anything if the lock, the re-check, and the INSERT share ONE
-- transaction. supabase-js issues each call as its own transaction, so
-- a TS-side lock would release before the INSERT it is meant to guard.
-- The lock therefore HAS to live inside a Postgres function. This is
-- the `lockAndUpsertCouple` helper the tracer.ts header promised; it
-- was re-cut out of T8.0b into T8.1 once the xact-scope was verified.
--
-- What it does (one transaction, under one advisory lock)
-- -------------------------------------------------------
--   1. pg_advisory_xact_lock on hash(venue_id || ':' || lock_key).
--   2. Idempotency: if a touchpoint already exists for
--      (venue_id, channel, external_id), this exact signal was already
--      swept — return its couple_id, mint nothing.
--   3. Re-check INSIDE the lock: if email/phone already resolves to a
--      couple (a concurrent process minted it between the matcher's
--      snapshot and now), attach to that couple instead of minting.
--   4. Otherwise mint a channel-scoped couple.
--   5. Attach the touchpoint (ON CONFLICT DO NOTHING — the
--      UNIQUE(venue_id, channel, external_id) constraint is the backstop).
--
-- Race-safety note
-- ----------------
-- For an email/phone lock_key the step-3 re-check makes the mint fully
-- race-safe. For a 'signal:<channel>:<external_id>' lock_key the key IS
-- the touchpoint dedup key, so step 2 is itself the re-check — also
-- fully safe. Only a 'handle:<channel>:<hint>' key can still produce
-- two channel-scoped couples under concurrency; that is benign — the
-- matcher coalesces channel-scoped couples in a later pass — and the
-- lock still serialises them so neither sees a torn write.
--
-- Rerun safety: CREATE OR REPLACE. No data writes at migration time.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.lock_and_mint_couple(
  p_venue_id      uuid,
  p_lock_key      text,
  p_channel       text,
  p_external_id   text,
  p_signal_tier   text,
  p_action_type   text,
  p_occurred_at   timestamptz,
  p_raw_payload   jsonb,
  p_primary_name  text,
  p_primary_email text,
  p_primary_phone text,
  p_partner_name  text,
  p_partner_email text,
  p_partner_phone text,
  p_wedding_date  date,
  p_channel_scope text
)
RETURNS TABLE (couple_id uuid, minted boolean, touchpoint_inserted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_couple_id uuid;
  v_tp_couple uuid;
  v_minted    boolean := false;
  v_tp_rows   integer := 0;
BEGIN
  -- (1) Transaction-scoped advisory lock. Auto-releases at COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_venue_id::text || ':' || p_lock_key, 0)
  );

  -- (2) Idempotency: this exact signal already swept?
  SELECT tp.couple_id INTO v_tp_couple
  FROM public.touchpoints tp
  WHERE tp.venue_id = p_venue_id
    AND tp.channel = p_channel
    AND tp.external_id = p_external_id
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_tp_couple, false, false;
    RETURN;
  END IF;

  -- (3) Re-check inside the lock: did a concurrent process already mint
  -- a couple for this email or phone?
  IF p_primary_email IS NOT NULL AND btrim(p_primary_email) <> '' THEN
    SELECT c.id INTO v_couple_id
    FROM public.couples c
    WHERE c.venue_id = p_venue_id
      AND ( lower(c.primary_contact_email) = lower(p_primary_email)
         OR lower(c.partner_contact_email) = lower(p_primary_email) )
    ORDER BY c.created_at ASC
    LIMIT 1;
  END IF;

  IF v_couple_id IS NULL
     AND p_primary_phone IS NOT NULL AND btrim(p_primary_phone) <> '' THEN
    SELECT c.id INTO v_couple_id
    FROM public.couples c
    WHERE c.venue_id = p_venue_id
      AND ( c.primary_contact_phone = p_primary_phone
         OR c.partner_contact_phone = p_primary_phone )
    ORDER BY c.created_at ASC
    LIMIT 1;
  END IF;

  -- (4) Mint a channel-scoped couple if none exists for this identifier.
  IF v_couple_id IS NULL THEN
    INSERT INTO public.couples (
      venue_id,
      primary_contact_name,
      primary_contact_email,
      primary_contact_phone,
      partner_contact_name,
      partner_contact_email,
      partner_contact_phone,
      wedding_date,
      lifecycle_state,
      channel_scope,
      last_progression_at
    ) VALUES (
      p_venue_id,
      p_primary_name,
      p_primary_email,
      p_primary_phone,
      p_partner_name,
      p_partner_email,
      p_partner_phone,
      p_wedding_date,
      'channel_scoped',
      p_channel_scope,
      p_occurred_at
    )
    RETURNING id INTO v_couple_id;
    v_minted := true;
  END IF;

  -- (5) Attach the touchpoint. UNIQUE(venue_id, channel, external_id)
  -- is the backstop; ON CONFLICT DO NOTHING keeps a concurrent loser
  -- idempotent.
  INSERT INTO public.touchpoints (
    venue_id, couple_id, channel, signal_tier, action_type,
    external_id, occurred_at, raw_payload
  ) VALUES (
    p_venue_id, v_couple_id, p_channel, p_signal_tier, p_action_type,
    p_external_id, p_occurred_at, p_raw_payload
  )
  ON CONFLICT (venue_id, channel, external_id) DO NOTHING;
  GET DIAGNOSTICS v_tp_rows = ROW_COUNT;

  RETURN QUERY SELECT v_couple_id, v_minted, (v_tp_rows > 0);
END;
$$;

COMMENT ON FUNCTION public.lock_and_mint_couple(
  uuid, text, text, text, text, text, timestamptz, jsonb,
  text, text, text, text, text, text, date, text
) IS
  'Tier 8 / T8.1a. Advisory-locked atomic couple-mint + touchpoint-attach. '
  'Acquires pg_advisory_xact_lock(hash(venue_id||lock_key)), re-checks for an '
  'existing couple by email/phone, mints a channel_scoped couple if none, then '
  'attaches the touchpoint. The lock, re-check, and INSERT share one txn so the '
  'xact-scoped lock actually guards the mint. See IDENTITY-FIRST-ARCHITECTURE.md '
  'Appendix C §C.3 + the tracer.ts header.';

REVOKE ALL ON FUNCTION public.lock_and_mint_couple(
  uuid, text, text, text, text, text, timestamptz, jsonb,
  text, text, text, text, text, text, date, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_and_mint_couple(
  uuid, text, text, text, text, text, timestamptz, jsonb,
  text, text, text, text, text, text, date, text
) FROM anon;
REVOKE ALL ON FUNCTION public.lock_and_mint_couple(
  uuid, text, text, text, text, text, timestamptz, jsonb,
  text, text, text, text, text, text, date, text
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.lock_and_mint_couple(
  uuid, text, text, text, text, text, timestamptz, jsonb,
  text, text, text, text, text, text, date, text
) TO service_role;

NOTIFY pgrst, 'reload schema';
