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
