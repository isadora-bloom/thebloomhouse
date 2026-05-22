-- ---------------------------------------------------------------------------
-- 366_lock_and_mint_couple_audit_row.sql
-- ---------------------------------------------------------------------------
-- Phase 1 / Batch 1 / prerequisite P3 (PHASE-1-BATCH-1.md §2 P3, §8).
--
-- Confirmed gap: the migration-359 `lock_and_mint_couple` RPC mints a
-- couple SILENTLY — it does an `INSERT INTO couples` with no matching
-- `couple_merge_events` audit row. Meanwhile `tracer.ts` (fragment
-- coalesce) DOES audit its mints with an `event_type:'fragment_promoted'`
-- row. The chokepoint mint is the un-audited path.
--
-- This migration does two SQL-side things; the tracer.ts reroute (P3b)
-- is a separate TypeScript change in the same PR:
--
--   1. Extends the anonymous CHECK constraint on
--      `couple_merge_events.event_type` to admit a new value
--      `'couple_minted'`. The mig-346 CHECK only listed merge/unmerge/
--      resurrection/candidate/fragment_promoted values, so an INSERT of
--      'couple_minted' would otherwise fail the constraint.
--
--   2. CREATE OR REPLACE on `lock_and_mint_couple` — the function body is
--      copied VERBATIM from migration 359 with ONE additive change: right
--      after the `INSERT INTO couples ... RETURNING id`, an
--      `INSERT INTO couple_merge_events` records the mint. The audit row
--      fires ONLY on the mint branch (v_minted = true) — an idempotent
--      re-hit or an attach-to-existing produces no audit row, mirroring
--      the existing tracer semantics where only a fresh couple is logged.
--
-- The mint logic is unchanged. The advisory lock, the touchpoint
-- idempotency check, the email/phone re-check, and the INSERT INTO
-- couples are all identical to migration 359. Only the audit insert is
-- new, and it is positioned inside the `IF v_couple_id IS NULL` mint
-- branch so it shares the function's single transaction and the advisory
-- lock — the audit row commits atomically with the couple it describes.
--
-- couple_merge_events column set (verified against mig 346):
--   id (default), venue_id NOT NULL, event_type NOT NULL (CHECK),
--   primary_couple_id, secondary_couple_id, operator_id, rule_triggered,
--   confidence_tier (CHECK high|medium|low), reason, occurred_at (default).
-- Only venue_id + event_type are NOT NULL; both are in scope here.
-- primary_couple_id is the just-minted couple. operator_id stays NULL
-- (the RPC mint is system-driven, not operator-driven). confidence_tier
-- is left NULL — a mint is not a confidence-scored merge decision.
--
-- Rerun safety: CREATE OR REPLACE on the function; the CHECK swap is
-- guarded (drop-if-exists by lookup, re-add idempotently). No data
-- writes at migration time.
--
-- NOT APPLIED by this file's authoring — the operator/parent applies it
-- to the consolidation Supabase branch.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Extend the couple_merge_events.event_type CHECK with 'couple_minted'.
--    The mig-346 CHECK is anonymous (no constraint name was given), so we
--    look it up by definition before dropping — same pattern as mig 365.
-- ===========================================================================

DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.couple_merge_events'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%event_type%';

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.couple_merge_events DROP CONSTRAINT %I',
      v_constraint_name
    );
  END IF;
END $$;

ALTER TABLE public.couple_merge_events
  ADD CONSTRAINT couple_merge_events_event_type_check
  CHECK (event_type IN (
    'fragment_promoted',
    'channel_scoped_bridged',
    'candidate_confirmed',
    'candidate_rejected',
    'manual_merge',
    'manual_unmerge',
    'resurrection',
    'resurrection_rejected',
    'couple_minted'
  ));

COMMENT ON TABLE public.couple_merge_events IS
  'Audit log for every identity event: couple mint (chokepoint RPC), '
  'fragment promotion, candidate confirm/reject, manual merge/unmerge, '
  'ghost resurrection. The reason column feeds the calibration loop '
  '(§2 Don''t skip #2). See IDENTITY-FIRST-ARCHITECTURE.md §9.';


-- ===========================================================================
-- 2. lock_and_mint_couple — body copied verbatim from migration 359, with
--    one additive INSERT INTO couple_merge_events inside the mint branch.
-- ===========================================================================

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
RETURNS TABLE (
  couple_id           uuid,
  minted              boolean,
  touchpoint_inserted boolean,
  touchpoint_id       uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_couple_id uuid;
  v_tp_couple uuid;
  v_tp_id     uuid;
  v_minted    boolean := false;
  v_tp_rows   integer := 0;
BEGIN
  -- (1) Transaction-scoped advisory lock. Auto-releases at COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_venue_id::text || ':' || p_lock_key, 0)
  );

  -- (2) Idempotency: this exact signal already swept?
  SELECT tp.couple_id, tp.id INTO v_tp_couple, v_tp_id
  FROM public.touchpoints tp
  WHERE tp.venue_id = p_venue_id
    AND tp.channel = p_channel
    AND tp.external_id = p_external_id
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_tp_couple, false, false, v_tp_id;
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

    -- (4a) P3: audit the mint. Every couple minted through the
    -- chokepoint now leaves a couple_merge_events trail — previously
    -- this INSERT happened silently. The audit row shares this txn and
    -- the advisory lock, so it commits atomically with the couple.
    -- Only fires on the mint branch; an attach-to-existing or an
    -- idempotent re-hit produces no audit row.
    INSERT INTO public.couple_merge_events (
      venue_id,
      event_type,
      primary_couple_id,
      rule_triggered,
      reason
    ) VALUES (
      p_venue_id,
      'couple_minted',
      v_couple_id,
      'lock_and_mint_couple',
      'chokepoint mint: channel=' || coalesce(p_channel, '?')
        || ' lock_key=' || coalesce(p_lock_key, '?')
        || ' tier=' || coalesce(p_signal_tier, '?')
        || ' action=' || coalesce(p_action_type, '?')
    );
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
  ON CONFLICT (venue_id, channel, external_id) DO NOTHING
  RETURNING id INTO v_tp_id;
  GET DIAGNOSTICS v_tp_rows = ROW_COUNT;

  RETURN QUERY SELECT v_couple_id, v_minted, (v_tp_rows > 0), v_tp_id;
END;
$$;

COMMENT ON FUNCTION public.lock_and_mint_couple(
  uuid, text, text, text, text, text, timestamptz, jsonb,
  text, text, text, text, text, text, date, text
) IS
  'Tier 8 / T8.1a + Phase 1 P3. Advisory-locked atomic couple-mint + '
  'touchpoint-attach + mint audit. Acquires '
  'pg_advisory_xact_lock(hash(venue_id||lock_key)), re-checks for an '
  'existing couple by email/phone, mints a channel_scoped couple if none, '
  'writes a couple_merge_events ''couple_minted'' audit row on the mint '
  'branch, then attaches the touchpoint. The lock, re-check, INSERT, and '
  'audit row share one txn. See IDENTITY-FIRST-ARCHITECTURE.md Appendix C '
  '§C.3 + PHASE-1-BATCH-1.md §2 P3.';

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
