-- 423: billing_exempt, so a venue that never pays is not treated as a lapsed trial
--
-- Rixey Manor is free forever (Isadora, 2026-09-17) and the app had no way to
-- say so. src/lib/services/billing/billing-state.ts decides a venue is on trial
-- purely from `stripe_subscription_id IS NULL`, so Rixey read as a trial that
-- expired on 2026-05-04: the trial banner on every platform page, and capacity
-- capped to the `pre_opening` tier despite plan_tier being 'enterprise'. That is
-- the whole of "Rixey does not have full access".
--
-- This is the narrow half of the trial-freeze work (PR #1, branch trial-freeze).
-- That branch introduces the same column with the same definition, plus the
-- whole-account freeze, which touches the AI client, both sendEmail paths and
-- every polling loop, and has not been reviewed yet. None of that is needed to
-- stop charging a venue we have decided not to charge, so the column and its
-- guard come first and the freeze follows whenever PR #1 lands.
--
-- Written to be superseded cleanly:
--   * ADD COLUMN IF NOT EXISTS, with the same type and default, so whichever
--     runs second is a no-op.
--   * The trigger is deliberately named trg_venue_freeze, which is the name PR
--     #1 drops and recreates. Its richer version replaces this one by name and
--     leaves nothing behind. Do not rename it to something tidier.
--
-- Idempotent. No BEGIN/COMMIT, per the migration convention.

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS billing_exempt boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.venues.billing_exempt IS
  'Free forever: never on trial, never asked to pay. Set by Bloom staff with the service key only (trg_venue_freeze refuses it from signed-in users). Rixey Manor since 2026-09-17.';

-- ---------------------------------------------------------------------------
-- The hole this would otherwise open
--
-- venues_org_update (058) lets any authenticated org member update their own
-- org's venue row, with no column restriction. Adding billing_exempt without
-- this guard would let an org admin grant themselves a free account from the
-- browser. The same was already true of trial_ends_at and
-- stripe_subscription_id, so the guard covers the billing columns as a set.
--
-- Column-level REVOKE would mean enumerating every column a venue admin IS
-- allowed to update, and re-enumerating it whenever the table grows. A trigger
-- names only what it protects.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_venue_billing_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  billing_cols text[] := ARRAY[
    'stripe_subscription_id', 'stripe_customer_id', 'subscription_status',
    'plan_tier', 'past_due_since', 'trial_ends_at', 'is_demo', 'billing_exempt'
  ];
  jwt_role text := COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  old_j jsonb;
  new_j jsonb;
BEGIN
  -- Same escape hatch the freeze uses, so a wipe or a repair can run.
  IF current_setting('bloom.freeze_bypass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_j := to_jsonb(OLD);
    new_j := to_jsonb(NEW);

    IF jwt_role IN ('authenticated', 'anon')
       AND (SELECT jsonb_object_agg(k, old_j -> k) FROM unnest(billing_cols) k)
           IS DISTINCT FROM
           (SELECT jsonb_object_agg(k, new_j -> k) FROM unnest(billing_cols) k) THEN
      RAISE EXCEPTION 'billing fields on a venue are managed by Bloom, not from the app'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  -- A venue created from the app starts on an ordinary trial and cannot hand
  -- itself a subscription, demo status or an exemption on the way in.
  IF TG_OP = 'INSERT' THEN
    IF jwt_role IN ('authenticated', 'anon') THEN
      NEW.stripe_subscription_id := NULL;
      NEW.subscription_status := NULL;
      NEW.is_demo := false;
      NEW.billing_exempt := false;
      NEW.trial_ends_at := now() + interval '14 days';
    END IF;
    RETURN NEW;
  END IF;

  RETURN OLD;
END
$fn$;

COMMENT ON FUNCTION public.enforce_venue_billing_guard() IS
  'Billing columns on venues are service-key only. The narrow half of migration 420 on branch trial-freeze; that migration replaces trg_venue_freeze with a version that also enforces the account freeze.';

DROP TRIGGER IF EXISTS trg_venue_freeze ON public.venues;
CREATE TRIGGER trg_venue_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON public.venues
  FOR EACH ROW EXECUTE FUNCTION public.enforce_venue_billing_guard();

-- ---------------------------------------------------------------------------
-- Rixey Manor
--
-- The production id, which the copied projects share (same id on the E2E
-- project, checked 2026-09-18). Same value PR #1 sets, so whichever runs second
-- changes nothing. After the trigger, so billing_exempt counts as a billing
-- column when this statement runs and the service key is what is setting it.
-- ---------------------------------------------------------------------------
UPDATE public.venues
   SET billing_exempt = true
 WHERE id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
   AND billing_exempt = false;
