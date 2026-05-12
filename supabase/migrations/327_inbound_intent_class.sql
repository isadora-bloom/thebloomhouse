-- ---------------------------------------------------------------------------
-- 327_inbound_intent_class.sql
-- ---------------------------------------------------------------------------
-- Inbound-intent classification chokepoint.
--
-- Why this exists (Anja Putman / RM-1152 trace, 2026-05-12):
-- Bloom currently assumes every inbound communication is a potentially-new
-- inquiry until proven otherwise. Anja Putman's logistics chatter on
-- behalf of her daughter Kajlie's booked wedding minted a fresh wedding
-- row, scored heat=99, and queued sequence drafts inviting her on a tour.
-- The class of problem: inbound looks like a new inquiry but is actually
-- post-booking ops / family-member proxy / vendor coordination / spam.
--
-- The fix is a single Haiku classifier that runs on every inbound across
-- every channel (email / SMS / call / voicemail / Zoom / brain-dump) and
-- writes structured intent to `interactions.intent_class`. Downstream
-- consumers (heat scoring, Sage drafts, sequence triggers, family-
-- member-proxy resolver) read this instead of re-inferring per-call.
--
-- Mirror shape of P5's haiku_classified_at / sentiment / urgency /
-- family_mentioned columns (migration 315). Same fire-and-forget +
-- cron-drain pattern: fast path on insert, daily drain for misses.
--
-- Idempotent. No BEGIN/COMMIT (Wave 23).
-- ---------------------------------------------------------------------------

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS intent_class text;

ALTER TABLE interactions DROP CONSTRAINT IF EXISTS interactions_intent_class_check;
ALTER TABLE interactions
  ADD CONSTRAINT interactions_intent_class_check
  CHECK (intent_class IS NULL OR intent_class IN (
    'new_inquiry',
    'inquiry_followup',
    'client_logistics',
    'client_emotional',
    'family_member_proxy',
    'vendor_communication',
    'vendor_outreach',
    'spam_outreach',
    'auto_reply',
    'coordinator_internal',
    'unknown'
  ));

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS intent_classified_at timestamptz;

-- Free-text name the classifier extracted when the inbound references an
-- existing couple (e.g. "this is Anja, Kajlie's mom" → "Kajlie"). Drives
-- checkpoint 6's family_member_proxy resolver that fuzzy-matches against
-- weddings.partner1/2 names.
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS intent_referenced_couple_name text;

-- One-line reasoning from the classifier so coordinator audit can read
-- WHY a given inbound was classified (or misclassified) the way it was.
-- Short text (<=500 chars), not free-form narrative.
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS intent_classifier_note text;

COMMENT ON COLUMN interactions.intent_class IS
  'Inbound intent classified by inbound-intent-classifier.ts (Haiku). '
  'Drives downstream routing: heat scoring fires only for new_inquiry / '
  'inquiry_followup / client_emotional; Sage drafts route to inquiry-brain '
  'vs client-brain vs skip; sequences gate on this. NULL = unclassified '
  '(cron drain will pick up). See migration 327.';

COMMENT ON COLUMN interactions.intent_classified_at IS
  'Timestamp the inbound-intent-classifier ran. Pair with intent_class '
  'IS NULL on the partial index for the cron drain. Mig 327.';

COMMENT ON COLUMN interactions.intent_referenced_couple_name IS
  'When intent_class IN (family_member_proxy, vendor_communication), the '
  'classifier extracts the referenced couple name from the body ("Kajlie''s '
  'mom" → "Kajlie"). Feeds checkpoint 6 family-member-proxy resolver. Mig 327.';

COMMENT ON COLUMN interactions.intent_classifier_note IS
  'One-line classifier reasoning. Audit only. Mig 327.';

CREATE INDEX IF NOT EXISTS idx_interactions_intent_pending
  ON interactions (venue_id, created_at)
  WHERE intent_classified_at IS NULL AND direction = 'inbound';

NOTIFY pgrst, 'reload schema';
