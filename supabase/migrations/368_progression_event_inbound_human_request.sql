-- ---------------------------------------------------------------------------
-- 368_progression_event_inbound_human_request.sql
-- ---------------------------------------------------------------------------
-- Phase 1 / Batch 1 / pressure-test remediation (PHASE-1-BATCH-1.md §
-- "Pressure-test findings", item: M9 action_type honesty fix, 2026-05-23).
--
-- The doctrine fix
-- ----------------
-- When the M9 humanRequested branch (`pipeline.ts` ~:2254 — see commit
-- 317b112) calls `linkSignal` for a human-escalation email, it currently
-- passes `action_type:'reply'` and stashes the escalation semantics in
-- `raw_payload.escalation:'human_requested'`. That was a forced workaround:
-- `progression.ts:progressionEventTypeFor` maps gmail `'reply'`/
-- `'inquiry'`/`'inbound_followup'` to a progression event and returns
-- `null` for anything else, so a bare `action_type:'human_requested'`
-- would silently drop the progression record (`recordProgressionIfEligible`
-- returns `{recorded:false}` and the decay clock would not move on what is
-- genuine inbound progression).
--
-- The pressure-test flagged this as a *quiet downgrade*: a touchpoint
-- reader sees `action_type:'reply'` for a human-escalation and has to grep
-- `raw_payload` to recover the truth. action_type IS the doctrine field —
-- it should carry the semantic. The fix is to admit a new progression
-- event type at the DB+code layers so the honest action_type can be
-- passed end-to-end, and the `raw_payload.escalation` workaround can be
-- retired.
--
-- The new event_type chosen — `'inbound_human_request'`
-- ----------------------------------------------------
-- Verb-noun, consistent with the mig-346 set
-- (`email_reply`, `tour_booked`, `tour_rescheduled`, `tour_attended`,
-- `new_channel_inquiry`, `portal_click`, `contract_signed`,
-- `inbound_followup`, `fragment_match_returned`). `inbound_` mirrors
-- `inbound_followup`'s direction prefix; `human_request` names the
-- couple-side semantic. The synonym `human_escalation_request` was
-- considered and rejected — "escalation" is operator-side framing; from
-- the couple's perspective they asked for a human, which is the verb
-- this column should record.
--
-- DEPLOY ORDER caveat (LOUD)
-- --------------------------
-- The TS code change (pipeline.ts M9 passing `action_type:'human_requested'`,
-- progression.ts mapping `'human_requested'` → `'inbound_human_request'`)
-- REQUIRES this migration to be applied FIRST. Without the CHECK swap,
-- a progression-event INSERT with `event_type:'inbound_human_request'`
-- fails the CHECK constraint (PostgreSQL error 23514). Apply this
-- migration before deploying the matching TS commit.
--
-- Belt: `progression.ts:recordProgressionIfEligible` catches the insert
-- error and returns `{recorded: false}` silently (verified at the
-- progression.ts:124-130 branch — the only `throw`-shaped error path
-- is the PK conflict 23505, every other code path returns the {recorded:
-- false} sentinel). So a misordered deploy degrades to "no progression
-- row + no clock bump" rather than a pipeline crash. The dual-write
-- legacy `engagement_events` row at pipeline.ts:~2194 is unaffected by
-- this migration and continues to fire. But that's the FAIL-SAFE; the
-- INTENT is for the migration to land first so progression rows DO get
-- written for human-escalations going forward.
--
-- CHECK-swap pattern
-- ------------------
-- The mig-346 CHECK on `couple_progression_events.event_type` is
-- anonymous (no constraint name was given on CREATE TABLE). Same as the
-- couple_merge_events case patched in migration 366, we look the
-- anonymous constraint up by `pg_constraint` (filtered to `contype='c'`
-- + `event_type` mentioned in the definition) before dropping, then
-- re-add as a NAMED constraint with the extended value list.
--
-- Rerun safety
-- ------------
-- The DO-block lookup is idempotent (the named replacement constraint
-- mentions `event_type` in its definition too — to avoid a self-match
-- on re-run we filter the lookup to drop only the OLD anonymous
-- constraint by name pattern, but in this codebase the anonymous
-- check still has the `_check`-without-the-named-prefix shape so the
-- pattern-LIKE filter works the same way as mig-366 + mig-365). On a
-- re-run after this migration has already landed, the lookup either
-- finds the named constraint (skip — already in the new shape) or finds
-- nothing (skip — table was rebuilt fresh from a later migration).
-- The ADD CONSTRAINT is guarded by `IF NOT EXISTS`-equivalent shape via
-- a name uniqueness check.
--
-- NOT APPLIED by this file's authoring — the operator/parent applies it
-- to the consolidation Supabase branch.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Drop the anonymous CHECK on couple_progression_events.event_type.
--    Same lookup-then-drop pattern as migration 366.
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

-- Re-add as a NAMED constraint with the extended value list. Idempotent:
-- if a previous run already created the named constraint, skip.
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
        'email_reply',
        'tour_booked',
        'tour_rescheduled',
        'tour_attended',
        'new_channel_inquiry',
        'portal_click',
        'contract_signed',
        'inbound_followup',
        'fragment_match_returned',
        'inbound_human_request'
      ));
  END IF;
END $$;

COMMENT ON TABLE public.couple_progression_events IS
  'Inbound-only progression log. Resets the decay clock. OUTBOUND venue activity is '
  'forbidden from writing here — §3 Don''t skip #1. The progression-event writer must '
  'not be wired from outbound code paths. event_type=''inbound_human_request'' added '
  'in migration 368 — fires when the couple explicitly asks for a human '
  '(pipeline.ts humanRequested branch). See PHASE-1-BATCH-1.md §"Pressure-test findings".';

NOTIFY pgrst, 'reload schema';
