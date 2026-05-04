-- ---------------------------------------------------------------------------
-- 201_booked_data_recovery_log.sql  (T5-Rixey-MMM)
-- ---------------------------------------------------------------------------
-- Booked-Data Recovery audit log.
--
-- Background — every wedding-venue onboarding to Bloom arrives with a
-- backlog of booked / completed weddings whose `booking_value` is NULL
-- or 0, whose `source` is missing, and whose `wedding_date` may be
-- unset. The actual numbers usually live in the venue's email history
-- (calculator-estimate emails, contract emails, HoneyBook export
-- confirmations) but nothing in Bloom currently walks those emails to
-- recover them. For Rixey today the gap is 12 of 51 booked weddings
-- (24% of bookings missing data); for a typical onboarding venue the
-- gap will be HIGHER because historical bookings predate Bloom's email
-- tracking entirely.
--
-- Stream MMM ships a reusable service (src/lib/services/booked-data-
-- recovery.ts) that walks each missing-data wedding and tries three
-- capabilities in order:
--
--   1. honeybook_dedup_merge       — find the HoneyBook duplicate of a
--                                    Calendly-synthesized wedding and
--                                    merge the source row into it
--                                    (HoneyBook record survives — it
--                                    holds the contract data).
--   2. calculator_extract          — pull the largest dollar amount
--                                    from the latest calculator-estimate
--                                    email subject / body and write it
--                                    into booking_value.
--   3. honeybook_export_recover    — for HoneyBook-imported weddings
--                                    with NULL booking_value, look in
--                                    the import-shaped interaction's
--                                    extracted_identity blob for a
--                                    `total` / `amount` / `value` field.
--
-- This table records EVERY attempt — recovered, merged, no-match, or
-- error. Why a separate audit table:
--   - The cron runs daily across every venue, so we need to dedupe
--     attempts (the orchestrator filter already restricts to
--     missing-bv weddings, but logging gives us idempotency telemetry).
--   - When a coordinator opens the Onboarding readiness page and sees
--     "5 weddings still missing booking value," they need a per-row
--     audit trail so they can decide whether to mark them
--     coordinator-supplied vs investigate further.
--   - It's also the integration point for the future "Mark coordinator-
--     supplied" UI affordance (Stream MMM stubs the readiness step but
--     defers the affordance to a follow-up stream — see the brief).
--
-- Schema
-- ------
-- Capability values match the orchestrator's switch-case in
-- src/lib/services/booked-data-recovery.ts and are fixed-set CHECK'd
-- so a future capability rename forces an explicit migration.
--
-- Outcome 'no_op' is reserved for orchestrator-level wedding-skip rows
-- (e.g. a wedding that started fixup but a parallel run already
-- recovered it before this attempt finished) — currently unused but
-- declared so the CHECK doesn't bite us when we add the dedup-race
-- handler later.
--
-- recovered_value_cents follows the bloom-wide convention (booking_value
-- is in INTEGER CENTS — see migration 181).
--
-- duplicate_wedding_id only set when capability='honeybook_dedup_merge'
-- and outcome='merged' — points at the surviving HoneyBook record (the
-- source wedding got merged_into_id stamped to this id).
--
-- Idempotent: re-running the recovery service on a venue inserts new
-- rows for every attempt (every attempt = audit point). The orchestrator
-- short-circuits the per-wedding work via the booking_value filter, so
-- in practice a clean run only logs the wedding once + marks it
-- 'recovered' / 'merged' / 'no_match'.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.booked_data_recovery_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  capability text NOT NULL CHECK (capability IN (
    'calculator_extract',
    'honeybook_dedup_merge',
    'honeybook_export_recover',
    'no_op'
  )),
  outcome text NOT NULL CHECK (outcome IN (
    'recovered',
    'merged',
    'no_match',
    'error'
  )),
  recovered_value_cents bigint NULL,
  source_interaction_id uuid NULL REFERENCES public.interactions(id) ON DELETE SET NULL,
  duplicate_wedding_id uuid NULL REFERENCES public.weddings(id) ON DELETE SET NULL,
  confidence text NULL CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low')),
  evidence jsonb NULL,
  error_message text NULL
);

COMMENT ON TABLE public.booked_data_recovery_log IS
  'T5-Rixey-MMM. One row per booked-data-recovery attempt by '
  'src/lib/services/booked-data-recovery.ts. Reusable across every '
  'onboarding venue. See src/app/api/cron/route.ts case '
  '"booked_data_recovery" for the daily orchestration. Audit-only — '
  'never read by attribution / source-quality. Coordinator UI is the '
  'consumer (onboarding readiness page surfaces unrecoverable count + '
  'links into a future per-row Mark coordinator-supplied affordance).';

COMMENT ON COLUMN public.booked_data_recovery_log.recovered_value_cents IS
  'INTEGER CENTS (Bloom convention; see migration 181 + '
  'booking_value column comment on weddings). Null for capability '
  'rows that did not produce a value (no_match, merged, error).';

COMMENT ON COLUMN public.booked_data_recovery_log.duplicate_wedding_id IS
  'Surviving wedding id when capability=honeybook_dedup_merge and '
  'outcome=merged. Source wedding (wedding_id col) gets its '
  'merged_into_id stamped to this id by the orchestrator.';

COMMENT ON COLUMN public.booked_data_recovery_log.evidence IS
  'Capability-specific evidence blob. For calculator_extract: { '
  'subject, dollar_amounts, picked_amount }. For honeybook_dedup_merge: '
  '{ matched_partners, date_window_days, source_score }. For '
  'honeybook_export_recover: { extracted_field, raw_value }.';

-- The audit-trail query pattern is "show recent attempts per venue,
-- newest first." A composite (venue_id, attempted_at DESC) covers
-- both the per-venue page filter AND the orchestrator's "have I
-- attempted this wedding lately" reverse-lookup.
CREATE INDEX IF NOT EXISTS idx_booked_data_recovery_log_venue_attempted
  ON public.booked_data_recovery_log (venue_id, attempted_at DESC);

-- Per-wedding audit: the readiness page renders the latest attempt
-- per wedding so the coordinator can decide what to do next.
CREATE INDEX IF NOT EXISTS idx_booked_data_recovery_log_wedding_attempted
  ON public.booked_data_recovery_log (wedding_id, attempted_at DESC);

NOTIFY pgrst, 'reload schema';
