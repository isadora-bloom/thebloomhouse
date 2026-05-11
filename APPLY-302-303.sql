-- ---------------------------------------------------------------------------
-- 300_interactions_disclosure_and_escalation.sql  (deep fix 2026-05-11)
-- ---------------------------------------------------------------------------
-- Two columns to move idempotency + escalation state off the email body
-- and onto the row where they belong:
--
-- 1. disclosure_version — replaces the in-body `[sage-ai-disclosure-vN]`
--    marker that was leaking as visible text to recipients (a couple read
--    it and was understandably put off). The marker was used purely for
--    idempotency: "did we already append the footer to this body?". With
--    a column the footer body stays clean and the row carries the version
--    stamp.
--
-- 2. escalation_requested — set when the inbound carries a human-escalation
--    request (legacy "HUMAN REQUESTED" magic-words OR the broader Haiku
--    classifier's verdict). Surfaces in the inbox folder + auto-skips
--    drafting + fires admin_notifications. Today the pipeline detects
--    this only via regex on subject; the column lets every downstream
--    consumer (heat scoring, knowledge-gaps detector, classifier health)
--    skip these rows uniformly.
-- ---------------------------------------------------------------------------

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS disclosure_version TEXT;

ALTER TABLE interactions DROP CONSTRAINT IF EXISTS interactions_disclosure_version_check;
ALTER TABLE interactions
  ADD CONSTRAINT interactions_disclosure_version_check
  CHECK (
    disclosure_version IS NULL
    OR disclosure_version IN ('v1', 'v2', 'v3', 'v4')
  );

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS escalation_requested BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS escalation_reason TEXT;

ALTER TABLE interactions DROP CONSTRAINT IF EXISTS interactions_escalation_reason_check;
ALTER TABLE interactions
  ADD CONSTRAINT interactions_escalation_reason_check
  CHECK (
    escalation_reason IS NULL
    OR escalation_reason IN ('magic_words', 'haiku_detected', 'operator_flagged')
  );

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS escalation_decided_at TIMESTAMPTZ;

-- Backfill: any existing row whose body contains a legacy disclosure marker
-- gets its row-level disclosure_version stamped so future writes skip the
-- re-append. v3 is the most common; check it first to short-circuit.
UPDATE interactions
SET disclosure_version = 'v3'
WHERE disclosure_version IS NULL
  AND direction = 'outbound'
  AND full_body LIKE '%[sage-ai-disclosure-v3]%';

UPDATE interactions
SET disclosure_version = 'v2'
WHERE disclosure_version IS NULL
  AND direction = 'outbound'
  AND full_body LIKE '%[sage-ai-disclosure-v2]%';

UPDATE interactions
SET disclosure_version = 'v1'
WHERE disclosure_version IS NULL
  AND direction = 'outbound'
  AND full_body LIKE '%[sage-ai-disclosure-v1]%';

-- Index used by the inbox / classifier-health consumers to skip
-- escalated rows uniformly.
CREATE INDEX IF NOT EXISTS idx_interactions_escalation_requested
  ON interactions (venue_id, escalation_requested, timestamp DESC)
  WHERE escalation_requested = true;

-- ---------------------------------------------------------------------------
-- drafts mirror columns so the operator-facing drafts surface can show the
-- "address unreachable" + "escalation requested" states without joining
-- back to interactions on every render.
-- ---------------------------------------------------------------------------

ALTER TABLE drafts
  ADD COLUMN IF NOT EXISTS needs_real_address BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE drafts
  ADD COLUMN IF NOT EXISTS escalation_requested BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN interactions.disclosure_version IS
  '2026-05-11: row-level disclosure version stamp. Replaces the in-body marker that was leaking as visible text. NULL = no footer ever appended (inbound or legacy outbound).';

COMMENT ON COLUMN interactions.escalation_requested IS
  '2026-05-11: true when the inbound carries a human-escalation request. Routed by detectHumanEscalation (regex fast-path) or the Haiku escalation classifier. Pipeline skips drafting + fires admin_notifications; downstream consumers filter these out.';

COMMENT ON COLUMN drafts.needs_real_address IS
  '2026-05-11: draft targets an unroutable synthetic / .invalid address (e.g. WeddingWire relay token). Auto-send refuses; operator must resolve a real address before sending.';

NOTIFY pgrst, 'reload schema';
-- ---------------------------------------------------------------------------
-- 302_knowledge_base_source_extension.sql  (live-customer fix 2026-05-11)
-- ---------------------------------------------------------------------------
-- The brain-dump "Send to Sage" path (/api/brain-dump/[id]/resolve) writes
-- knowledge_base rows with source='brain_dump_confirmed' to preserve
-- provenance — but the original CHECK constraint from migration 033 only
-- allowed ('manual', 'auto-learned', 'csv'), so every brain-dump-driven
-- KB insert was failing with:
--
--   new row for relation "knowledge_base" violates check constraint
--   "knowledge_base_source_check"
--
-- Live-customer 2026-05-11: Isadora hit this trying to add a calculator
-- rule note ("when replying to inquiries that submitted a calculator it
-- needs to not assume there are overnights unless overnights are listed
-- on the calculator").
--
-- Fix: extend the CHECK to include 'brain_dump_confirmed'. We also add
-- 'content_suggester' so the Wave 26 / Stream 6 USP + seasonal-content
-- suggester (which doesn't write KB today but plausibly will) has a
-- ready-to-use provenance tag — avoids another constraint extension on
-- the same column in two weeks.
--
-- Provenance values now allowed:
--   manual                — coordinator typed it in /portal/kb
--   auto-learned          — Sage queue resolution promoted Q+A
--   csv                   — bulk CSV import (data-import.ts paths)
--   brain_dump_confirmed  — brain-dump propose-and-confirm flow
--   content_suggester     — Sonnet-suggested entry from venue website
-- ---------------------------------------------------------------------------

ALTER TABLE knowledge_base DROP CONSTRAINT IF EXISTS knowledge_base_source_check;

ALTER TABLE knowledge_base
  ADD CONSTRAINT knowledge_base_source_check
  CHECK (source IN (
    'manual',
    'auto-learned',
    'csv',
    'brain_dump_confirmed',
    'content_suggester'
  ));

COMMENT ON COLUMN knowledge_base.source IS
  'Provenance tag for the KB entry. manual = coordinator typed in /portal/kb. auto-learned = Sage queue resolution. csv = data-import bulk. brain_dump_confirmed = brain-dump propose-and-confirm flow (2026-05-11). content_suggester = Sonnet pull-from-website (Stream 6).';

NOTIFY pgrst, 'reload schema';
-- ---------------------------------------------------------------------------
-- 303_weddings_ai_opted_out.sql  (live-customer fix 2026-05-11)
-- ---------------------------------------------------------------------------
-- The escalation classifier (mig 300) detects "I want a human" requests
-- on individual inbound emails and skips drafting for THAT email. But the
-- flag is per-interaction, not per-couple — so the next email from the
-- same couple gets re-evaluated from scratch, and if it doesn't contain
-- explicit escalation phrases, drafting resumes.
--
-- Real-customer manifestation: Kristiana replied "HUMAN REQUESTED" to
-- Sage's first email. Sage correctly skipped drafting that reply. Then
-- she sent another email a few minutes later asking a normal question.
-- Sage drafted to her again, because the new email didn't repeat the
-- magic words.
--
-- Fix: opt-out is sticky at the WEDDING level. Once any inbound on a
-- wedding fires escalation, the couple is opted out of AI drafting
-- entirely until the operator clears the flag.
--
-- The flag is operator-clearable from /agent/leads/[id] and from
-- /agent/drafts when a draft is suppressed. Couple changing their mind
-- ("actually go ahead and use the AI assistant") is a real case.
-- ---------------------------------------------------------------------------

ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS ai_opted_out BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS ai_opted_out_at TIMESTAMPTZ;

ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS ai_opted_out_reason TEXT;

-- Index for the pipeline pre-flight: every inbound on a known wedding
-- runs a venue + wedding_id lookup with this filter before drafting.
CREATE INDEX IF NOT EXISTS idx_weddings_ai_opted_out
  ON weddings (venue_id, ai_opted_out)
  WHERE ai_opted_out = true;

COMMENT ON COLUMN weddings.ai_opted_out IS
  '2026-05-11: sticky flag set when an inbound on this wedding fires escalation_requested. Pipeline never drafts for an opted-out wedding regardless of the inbound content. Operator clears from /agent/leads/[id] when the couple changes their mind.';

-- Backfill: any wedding that has ever had an interaction with
-- escalation_requested=true gets the flag set retroactively. Catches
-- Kristiana + any other historical case where drafting kept happening
-- after escalation.
--
-- Defensive: only run when migration 300 has applied (escalation_requested
-- column exists on interactions). If 300 hasn't run yet, the backfill
-- skips silently — the operator can re-run this migration after 300
-- to pick up any historical rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'interactions'
      AND column_name = 'escalation_requested'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'interactions'
      AND column_name = 'escalation_decided_at'
  ) THEN
    EXECUTE $sql$
      UPDATE weddings w
      SET
        ai_opted_out = true,
        ai_opted_out_at = COALESCE(w.ai_opted_out_at, sub.first_request_at),
        ai_opted_out_reason = COALESCE(w.ai_opted_out_reason, 'historical_escalation_backfill')
      FROM (
        SELECT
          wedding_id,
          MIN(escalation_decided_at) AS first_request_at
        FROM interactions
        WHERE escalation_requested = true
          AND wedding_id IS NOT NULL
        GROUP BY wedding_id
      ) sub
      WHERE w.id = sub.wedding_id
        AND w.ai_opted_out = false;
    $sql$;
  ELSE
    RAISE NOTICE 'Migration 300 columns not present yet — skipping escalation backfill. Re-run 303 after 300 applies to pick up historical rows.';
  END IF;
END $$;

-- Cancel any pending or approved-not-yet-sent drafts on the just-flagged
-- weddings. A draft already queued at the moment of escalation should
-- never go out.
UPDATE drafts
SET
  status = 'rejected',
  feedback_notes = COALESCE(feedback_notes, '') ||
    CASE WHEN feedback_notes IS NULL OR feedback_notes = ''
      THEN 'auto-rejected: couple opted out of AI drafting (mig 303 backfill)'
      ELSE E'\nauto-rejected: couple opted out of AI drafting (mig 303 backfill)'
    END
WHERE wedding_id IN (SELECT id FROM weddings WHERE ai_opted_out = true)
  AND status IN ('pending', 'approved', 'auto_send_pending');

NOTIFY pgrst, 'reload schema';
