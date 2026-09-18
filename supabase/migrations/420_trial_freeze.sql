-- 420_trial_freeze
--
-- When a venue's 14-day trial ends with no Stripe subscription, the whole
-- account freezes. People can still sign in and look at everything, but
-- nothing is written for that venue by anyone: staff, couples, crons,
-- webhooks or the email pipeline (Isadora, 2026-09-17). Before this, an
-- expired trial only showed a banner and switched auto-send off.
--
-- Why the database, and not only the app: 92 client components write
-- straight to PostgREST from the browser, and most background work runs
-- on the service key, which skips RLS. A trigger fires for both. The app
-- also refuses early (middleware, the AI client, the two email senders,
-- the polling loops) so a frozen venue costs no model calls and sends no
-- mail, but this file is the guarantee.
--
-- The rule lives in one place, public.venue_is_frozen():
--   not a demo venue, not billing_exempt, no stripe_subscription_id,
--   trial_ends_at has passed.
--
-- billing_exempt marks a venue that never pays and never freezes. Rixey
-- Manor is free forever (Isadora, 2026-09-17), and it is set here.
-- A cancelled or past-due subscription is NOT a freeze; that stays with
-- require-plan.ts.
--
-- Left writable on purpose, because they are the account's own plumbing
-- rather than its data: user_profiles (sign-in and account), the billing
-- columns on venues (so Stripe can unfreeze it), admin_notifications (so
-- we can tell them), consumer_requests (privacy requests are a legal
-- duty), and the logs (error_logs, cron_runs, metered_events, api_costs,
-- twilio_webhook_log, zoom_webhook_log).
--
-- Deliberate maintenance on a frozen venue (a wipe, a repair) runs with
--   SELECT set_config('bloom.freeze_bypass', 'on', true);
-- in the same transaction.
--
-- Also closes a hole the freeze would otherwise open: venues_org_update
-- (058) lets an org admin update their own venue row, which included
-- stripe_subscription_id and trial_ends_at. A frozen admin could have
-- unfrozen themselves from the browser. Billing fields are now service
-- key only.
--
-- Idempotent. No BEGIN/COMMIT (per migration convention).

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS billing_exempt boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.venues.billing_exempt IS
  'Free forever: never on trial, never frozen, never asked to pay. Set by Bloom staff with the service key only (trg_venue_freeze refuses it from signed-in users). Rixey Manor since 2026-09-17.';

CREATE OR REPLACE FUNCTION public.venue_is_frozen(p_venue_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.venues v
     WHERE v.id = p_venue_id
       AND COALESCE(v.is_demo, false) = false
       AND v.billing_exempt = false
       AND v.stripe_subscription_id IS NULL
       AND v.trial_ends_at IS NOT NULL
       AND v.trial_ends_at <= now()
  )
$fn$;

REVOKE ALL ON FUNCTION public.venue_is_frozen(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venue_is_frozen(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.venue_is_frozen(uuid) IS
  'True when the venue''s trial has ended with no Stripe subscription (and it is neither a demo venue nor billing_exempt). The single definition of a frozen account; see migration 420.';

-- SQLSTATE PT402 makes PostgREST answer HTTP 402, so a browser write from
-- a frozen venue fails as "payment required", not as a generic 400. The
-- message starts with venue_frozen so app code can recognise it.

-- Tables that carry venue_id directly.
CREATE OR REPLACE FUNCTION public.enforce_venue_freeze()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_old uuid;
  v_new uuid;
BEGIN
  IF current_setting('bloom.freeze_bypass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP <> 'INSERT' THEN v_old := OLD.venue_id; END IF;
  IF TG_OP <> 'DELETE' THEN v_new := NEW.venue_id; END IF;

  IF (v_old IS NOT NULL AND public.venue_is_frozen(v_old))
     OR (v_new IS NOT NULL AND v_new IS DISTINCT FROM v_old AND public.venue_is_frozen(v_new)) THEN
    RAISE EXCEPTION 'venue_frozen: this venue''s trial has ended, so nothing can be changed until a plan is chosen'
      USING ERRCODE = 'PT402', HINT = TG_TABLE_NAME;
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$fn$;

-- Child tables that reach a venue through a parent row.
-- TG_ARGV[0] = parent table, TG_ARGV[1] = the foreign key column here.
CREATE OR REPLACE FUNCTION public.enforce_venue_freeze_via_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_parent_id uuid;
  v_venue_id uuid;
BEGIN
  IF current_setting('bloom.freeze_bypass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  FOREACH v_parent_id IN ARRAY ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN (to_jsonb(OLD) ->> TG_ARGV[1])::uuid END,
    CASE WHEN TG_OP <> 'DELETE' THEN (to_jsonb(NEW) ->> TG_ARGV[1])::uuid END
  ] LOOP
    CONTINUE WHEN v_parent_id IS NULL;
    EXECUTE format('SELECT venue_id FROM public.%I WHERE id = $1', TG_ARGV[0])
      INTO v_venue_id USING v_parent_id;
    IF v_venue_id IS NOT NULL AND public.venue_is_frozen(v_venue_id) THEN
      RAISE EXCEPTION 'venue_frozen: this venue''s trial has ended, so nothing can be changed until a plan is chosen'
        USING ERRCODE = 'PT402', HINT = TG_TABLE_NAME;
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END
$fn$;

-- The venues row itself. Billing and lifecycle columns stay writable by
-- the service key, so a Stripe webhook can unfreeze the venue and Bloom
-- staff can extend a trial. Everything else on a frozen venue is refused.
-- Signed-in users can never touch the billing columns, frozen or not.
CREATE OR REPLACE FUNCTION public.enforce_venue_freeze_on_venues()
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
  lifecycle_cols text[] := ARRAY['status', 'archived_at', 'updated_at'];
  jwt_role text := COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  old_j jsonb;
  new_j jsonb;
BEGIN
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

    IF public.venue_is_frozen(OLD.id)
       AND (old_j - billing_cols - lifecycle_cols) IS DISTINCT FROM (new_j - billing_cols - lifecycle_cols) THEN
      RAISE EXCEPTION 'venue_frozen: this venue''s trial has ended, so nothing can be changed until a plan is chosen'
        USING ERRCODE = 'PT402', HINT = TG_TABLE_NAME;
    END IF;

    RETURN NEW;
  END IF;

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

  -- DELETE
  IF public.venue_is_frozen(OLD.id) THEN
    RAISE EXCEPTION 'venue_frozen: this venue''s trial has ended, so nothing can be changed until a plan is chosen'
      USING ERRCODE = 'PT402', HINT = TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END
$fn$;

DROP TRIGGER IF EXISTS trg_venue_freeze ON public.venues;
CREATE TRIGGER trg_venue_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON public.venues
  FOR EACH ROW EXECUTE FUNCTION public.enforce_venue_freeze_on_venues();

-- Rixey Manor is free forever (production id, as in
-- scripts/backfill-rixey-history.ts; projects copied from production
-- share it). After the venues trigger so billing_exempt is a billing
-- column when this runs, which lets it through on an already-frozen row.
UPDATE public.venues
   SET billing_exempt = true
 WHERE id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
   AND billing_exempt = false;

-- Every other public table with a venue_id column, minus the plumbing
-- list above. Done as a loop so a table added later can be picked up by
-- re-running this block; check:venue-freeze-coverage fails CI when one
-- is missed.
DO $do$
DECLARE
  t text;
  exempt text[] := ARRAY[
    'venues', 'user_profiles', 'admin_notifications', 'consumer_requests',
    'error_logs', 'cron_runs', 'metered_events', 'api_costs',
    'twilio_webhook_log', 'zoom_webhook_log'
  ];
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN pg_tables p ON p.schemaname = 'public' AND p.tablename = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name = 'venue_id'
       AND c.table_name <> ALL (exempt)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_venue_freeze ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_venue_freeze BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.enforce_venue_freeze()', t);
  END LOOP;
END
$do$;

-- Child tables with no venue_id of their own.
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('ceremony_chair_plans',      'weddings',                'wedding_id'),
      ('table_map_layouts',         'weddings',                'wedding_id'),
      ('guest_tag_assignments',     'guest_list',              'guest_id'),
      ('sequence_steps',            'follow_up_sequences',     'sequence_id'),
      ('voice_training_responses',  'voice_training_sessions', 'session_id'),
      ('event_feedback_vendors',    'event_feedback',          'event_feedback_id'),
      ('contacts',                  'people',                  'person_id'),
      ('couple_progression_events', 'couples',                 'couple_id'),
      ('agent_couple_links',        'couples',                 'couple_id')
    ) AS v(child, parent, fk)
  LOOP
    IF to_regclass('public.' || r.child) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS trg_venue_freeze ON public.%I', r.child);
    EXECUTE format(
      'CREATE TRIGGER trg_venue_freeze BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.enforce_venue_freeze_via_parent(%L, %L)',
      r.child, r.parent, r.fk);
  END LOOP;
END
$do$;

COMMENT ON COLUMN public.venues.trial_ends_at IS
  'Deadline for the venue''s no-subscription platform trial (DB default: 14 days from creation). Past it with no stripe_subscription_id, and not a demo venue, the account is frozen: readable, but every write for the venue is refused by trg_venue_freeze (migration 420, public.venue_is_frozen).';
