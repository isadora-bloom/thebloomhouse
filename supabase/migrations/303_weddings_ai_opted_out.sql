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
