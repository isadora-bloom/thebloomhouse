-- ---------------------------------------------------------------------------
-- 371_progression_event_batch2_channels.sql
-- ---------------------------------------------------------------------------
-- Phase 1 / Batch 2 / Pbatch2-3 (PHASE-1-BATCH-2.md §2 Pbatch2-3 +
-- §7 corrections, 2026-05-26).
--
-- The doctrine fix
-- ----------------
-- Batch 2 wires five new ingestion channels (Calendly cancellations,
-- HoneyBook CSV, Twilio + OpenPhone SMS, OpenPhone calls + voicemails,
-- Zoom meetings) into the cascade via `linkSignal`. Each channel emits
-- new `action_type` values that the existing `progression.ts:
-- progressionEventTypeFor` mapper does NOT recognise, so without this
-- migration every Batch-2 channel signal would silently degrade to
-- "no progression row + no decay-clock movement" (`recordProgressionIfEligible`
-- returns `{recorded:false}` and the insert error gets swallowed at the
-- progression.ts:124-130 branch — verified fail-safe).
--
-- This migration extends `couple_progression_events.event_type` CHECK
-- with the genuinely new event types needed for Batch 2's progression
-- coverage, and `progression.ts` is extended to map the corresponding
-- action_types to those event types.
--
-- Value-list provenance (read this before adding more values)
-- -----------------------------------------------------------
-- Migration 368 left the named constraint
-- `couple_progression_events_event_type_check` with TEN values:
--
--   email_reply, tour_booked, tour_rescheduled, tour_attended,
--   new_channel_inquiry, portal_click, contract_signed,
--   inbound_followup, fragment_match_returned, inbound_human_request
--
-- (Source: `supabase/migrations/368_progression_event_inbound_human_request.sql:123-132`.)
-- The pressure-test (PHASE-1-BATCH-2.md §2 Pbatch2-3) explicitly
-- corrected an earlier overcount: `tour_attended` and `tour_rescheduled`
-- already shipped in 368 — DO NOT re-add them.
--
-- Net-new values in this migration: SIX (not eight as v1 named).
-- Two of the v1-proposed values were dropped after doctrinal review:
--
--   DROPPED — tour_cancelled (Calendly).
--     The table is "Inbound-only progression log. Resets the decay
--     clock" (mig 346 COMMENT). A cancellation is inbound but it is a
--     REGRESSION, not progression — moving the decay clock forward on
--     a cancellation would mis-state lead health (a cancelled tour
--     looking "fresh"). progression.ts:71-74 already has an explicit
--     "outbound exclusions return null" guard for the same reason
--     (venue's own sends never write — they're not progression).
--     Cancellations belong in `touchpoints` (C11's spine write covers
--     it) and downstream regression-detection reads from there. Not
--     added to the CHECK; not added to the enum; mapper returns null
--     for `channel=calendly action=tour_cancelled`.
--
--   DROPPED — contract_signed_csv (HoneyBook CSV).
--     The existing `contract_signed` event_type already covers
--     "contract was signed" semantics — progression.ts:93 maps
--     channel=honeybook action=contract_signed|booking_signed to it.
--     The HoneyBook CSV path uses action_type `crm_imported_booked`
--     (one signal class, two ingestion routes). The CSV mapper case
--     ROUTES to the existing `contract_signed` rather than coining a
--     near-synonym — DRY, and keeps the cohort funnel reader from
--     having to OR two event_type values for "did they sign?"
--
-- Net-new genuine progression event types added by this migration:
--
--   1. crm_inquiry         — HoneyBook CSV historical-import inquiry.
--                            Distinct from `new_channel_inquiry`
--                            (which is LIVE-channel) — `crm_inquiry`
--                            says "this row is from a CSV import, not
--                            a live channel hit." Distinction matters
--                            for D9 cohort funnel which differentiates
--                            historical-backfill from organic acquisition.
--   2. crm_booking         — HoneyBook CSV says "this couple booked."
--                            Distinct from `contract_signed`: that's
--                            the SIGNING moment; `crm_booking` is a
--                            STATUS-row import (we know they booked
--                            because HoneyBook tracked it, not because
--                            we saw the signature event).
--   3. inbound_sms         — Twilio + OpenPhone inbound SMS.
--   4. inbound_call        — OpenPhone inbound phone call.
--   5. voicemail_received  — OpenPhone voicemail.
--   6. meeting_completed   — Zoom meeting completed (transcript ingested).
--
-- DEPLOY ORDER caveat (LOUD — single deploy unit recommended)
-- -----------------------------------------------------------
-- Migration 371 + the TS code referencing the new action_types must
-- ship as ONE deploy unit per Pbatch2-OPERATOR-BLOCK item 5
-- (PHASE-1-BATCH-2.md §7). Order within the unit: apply 371 to the DB
-- FIRST, then deploy the code. If code lands first, every Batch-2
-- channel signal that would have produced a progression row instead:
--   - INSERT against `couple_progression_events` fails CHECK (23514).
--   - `recordProgressionIfEligible` swallows the error and returns
--     `{recorded:false}` (verified at progression.ts:141-147 — only
--     `23505` PK conflict is treated as success-without-clock-bump;
--     every other error returns `{recorded:false}` without throwing).
--   - The legacy `engagement_events` / `interactions` / `touchpoints`
--     rows STILL land — pipeline doesn't crash.
--   - But `couples.last_progression_at` doesn't move, so decay
--     scoring + heat-map color + journey-ribbon-recency degrade
--     silently for 6 action types instead of 1 (368's single value).
--     6x the silent-degradation surface vs 368.
--
-- Mitigation per §7 BLOCK-5: a CI guard refuses to deploy code that
-- references the new action_types unless a `supabase/migrations/371_*`
-- file is present in the same commit. Migration applied via dashboard
-- (operator), code merged via PR (engineer); the guard couples the two.
--
-- CHECK-swap pattern (same as migration 368)
-- ------------------------------------------
-- Migration 368 already converted the constraint from anonymous (set
-- by mig 346's inline CHECK) to NAMED `couple_progression_events_event_type_check`.
-- We drop the NAMED constraint, then re-add NAMED with the extended
-- value list. The first DO-block is a safety net for the case where
-- some unanticipated re-apply path left the old anonymous constraint
-- around — same defensive idempotency as 368.
--
-- Rerun safety
-- ------------
-- Both DO-blocks are guarded:
--   - Anonymous-constraint drop: filtered by name pattern (`<>`
--     against the named constraint) so re-running this migration after
--     it has landed doesn't drop the new named constraint.
--   - Named-constraint add: guarded by `IF NOT EXISTS` against the
--     constraint name — re-runs are no-ops.
--
-- NOT APPLIED by this file's authoring — the operator/parent applies
-- it to the consolidation Supabase branch via dashboard.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Drop any anonymous CHECK left on couple_progression_events.event_type
--    (defensive — mig 368 should have already named it; this catches
--    the rebuild-fresh case).
-- ===========================================================================

DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.couple_progression_events'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%event_type%'
    AND conname <> 'couple_progression_events_event_type_check';

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.couple_progression_events DROP CONSTRAINT %I',
      v_constraint_name
    );
  END IF;
END $$;

-- ===========================================================================
-- 2. Drop the named constraint left by migration 368 so we can re-add
--    with the extended value list. Guarded so re-run after this
--    migration has landed is a no-op when the new constraint is already
--    the current shape (re-add step's IF NOT EXISTS guard would then
--    skip — that's the case where the schema is already correct and we
--    leave the existing constraint in place by not entering this
--    drop branch).
--
--    Detection: the OLD-shape named constraint has the v368 value list
--    (10 values, no `crm_inquiry`). The NEW-shape constraint has the
--    extended list. We use `pg_get_constraintdef` to detect the OLD
--    shape (looks for `crm_inquiry` absence) and drop only then.
-- ===========================================================================

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'public.couple_progression_events'::regclass
    AND conname = 'couple_progression_events_event_type_check';

  -- If the named constraint exists AND does not yet include the new
  -- values, drop it so we can re-add with the extended list. If it
  -- already includes them, leave it (rerun-safe no-op).
  IF v_def IS NOT NULL AND v_def NOT LIKE '%crm_inquiry%' THEN
    ALTER TABLE public.couple_progression_events
      DROP CONSTRAINT couple_progression_events_event_type_check;
  END IF;
END $$;

-- ===========================================================================
-- 3. Re-add NAMED constraint with the extended value list. Idempotent:
--    skip if the named constraint already exists (the §2 block would
--    have left it intact in the already-extended case).
-- ===========================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.couple_progression_events'::regclass
      AND conname = 'couple_progression_events_event_type_check'
  ) THEN
    ALTER TABLE public.couple_progression_events
      ADD CONSTRAINT couple_progression_events_event_type_check
      CHECK (event_type IN (
        -- migration 346 originals
        'email_reply',
        'tour_booked',
        'tour_rescheduled',
        'tour_attended',
        'new_channel_inquiry',
        'portal_click',
        'contract_signed',
        'inbound_followup',
        'fragment_match_returned',
        -- migration 368 addition (M9 human-escalation)
        'inbound_human_request',
        -- migration 371 additions (Batch 2 channels)
        'crm_inquiry',
        'crm_booking',
        'inbound_sms',
        'inbound_call',
        'voicemail_received',
        'meeting_completed'
      ));
  END IF;
END $$;

COMMENT ON TABLE public.couple_progression_events IS
  'Inbound-only progression log. Resets the decay clock. OUTBOUND venue activity is '
  'forbidden from writing here — §3 Don''t skip #1. The progression-event writer must '
  'not be wired from outbound code paths. event_type=''inbound_human_request'' added '
  'in migration 368. event_types ''crm_inquiry'' / ''crm_booking'' / ''inbound_sms'' / '
  '''inbound_call'' / ''voicemail_received'' / ''meeting_completed'' added in '
  'migration 371 for Phase 1 Batch 2 ingestion channels (HoneyBook CSV, Twilio/OpenPhone '
  'SMS, OpenPhone voice + voicemail, Zoom). REGRESSION signals (tour_cancelled) '
  'intentionally NOT progression-eligible — they live in `touchpoints` and downstream '
  'readers detect regressions from there. See PHASE-1-BATCH-2.md §2 Pbatch2-3.';

NOTIFY pgrst, 'reload schema';
