-- ============================================================================
-- 228: COUPLE-RLS EXCLUSION FIXES + assigned_to length cap
--
-- Round-7 bandaid audit caught two real issues that ship in this migration:
--
-- ## 1. Coordinator-internal tables leaked via mig 226 couple_read
--
-- Mig 226 walks `information_schema.columns WHERE column_name='wedding_id'`
-- and excludes a hardcoded list of coordinator-internal tables. The list
-- missed four tables that DO carry wedding_id but are internal:
--   - attribution_parity_log     (mig 192) — internal attribution scoring
--   - booked_data_recovery_log   (mig 201) — internal recovery audit
--   - event_feedback             (mig 043) — internal post-event feedback
--   - event_feedback_vendors     (mig 043) — internal vendor scoring
--
-- These got `couple_read` SELECT policies applied. Couples post-mig-226
-- can read all four. Drop the policies. Mig 226 source is also updated
-- so future re-runs against fresh schemas don't re-create them.
--
-- Inverting the rule to opt-in allowlist (audit recommendation #3) is
-- the right long-term shape but a bigger change; deferred. For now the
-- exclusion list grows.
--
-- ## 2. assigned_to length cap was JS-only
--
-- Mig 224 added checklist_items.assigned_to as unbounded TEXT. Round-6
-- noted this and the client capped at 80 chars in handleSetAssignedTo,
-- but anyone with service-role / Studio / a bypassed client could still
-- write 100KB. Add the CHECK at the schema level.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Drop couple_read policies on coordinator-internal tables
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "couple_read" ON public.attribution_parity_log;
DROP POLICY IF EXISTS "couple_read" ON public.booked_data_recovery_log;
DROP POLICY IF EXISTS "couple_read" ON public.event_feedback;
DROP POLICY IF EXISTS "couple_read" ON public.event_feedback_vendors;

-- Also drop any couple_write policies that landed (the write loop only
-- runs against an explicit v_tables list which doesn't include these,
-- but DROP IF EXISTS is idempotent so this catches future drift).
DROP POLICY IF EXISTS "couple_insert" ON public.attribution_parity_log;
DROP POLICY IF EXISTS "couple_update" ON public.attribution_parity_log;
DROP POLICY IF EXISTS "couple_delete" ON public.attribution_parity_log;
DROP POLICY IF EXISTS "couple_insert" ON public.booked_data_recovery_log;
DROP POLICY IF EXISTS "couple_update" ON public.booked_data_recovery_log;
DROP POLICY IF EXISTS "couple_delete" ON public.booked_data_recovery_log;
DROP POLICY IF EXISTS "couple_insert" ON public.event_feedback;
DROP POLICY IF EXISTS "couple_update" ON public.event_feedback;
DROP POLICY IF EXISTS "couple_delete" ON public.event_feedback;
DROP POLICY IF EXISTS "couple_insert" ON public.event_feedback_vendors;
DROP POLICY IF EXISTS "couple_update" ON public.event_feedback_vendors;
DROP POLICY IF EXISTS "couple_delete" ON public.event_feedback_vendors;

-- ----------------------------------------------------------------------------
-- 2. Length CHECK on checklist_items.assigned_to
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
     WHERE table_schema = 'public'
       AND table_name = 'checklist_items'
       AND constraint_name = 'checklist_items_assigned_to_length'
  ) THEN
    ALTER TABLE public.checklist_items
      ADD CONSTRAINT checklist_items_assigned_to_length
      CHECK (assigned_to IS NULL OR char_length(assigned_to) <= 80);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. Verification
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_remaining int;
  v_row record;
BEGIN
  SELECT COUNT(*) INTO v_remaining
    FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname IN ('couple_read', 'couple_insert', 'couple_update', 'couple_delete')
     AND tablename IN (
       'attribution_parity_log',
       'booked_data_recovery_log',
       'event_feedback',
       'event_feedback_vendors'
     );

  IF v_remaining > 0 THEN
    RAISE EXCEPTION '[228] Failed to drop all couple policies on coordinator-internal tables (% remain)', v_remaining;
  END IF;

  RAISE NOTICE '[228] Coordinator-internal tables now have zero couple policies';
END $$;

NOTIFY pgrst, 'reload schema';
