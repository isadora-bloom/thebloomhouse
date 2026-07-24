-- Migration 384: sage_uncertain_queue.reason += 'ai_unavailable'
--
-- The couple-portal Sage route now degrades gracefully when BOTH AI
-- providers are down (Claude failed / skipped and the OpenAI fallback
-- also failed, is disabled, or is unconfigured — surfaced as an
-- AIUnavailableError from lib/ai/client.ts). On that path the route
-- gives the couple a warm holding reply and drops the question in this
-- queue so a coordinator can answer it by hand. That row carries
-- reason = 'ai_unavailable', which the migration 126 CHECK constraint
-- did not allow, so the queue insert would have failed silently.
--
-- This widens the CHECK to admit the new value. A provider outage is a
-- distinct triage class from 'low_confidence' (Sage tried, wasn't sure)
-- and 'forbidden_topic' (Sage was told not to answer): here Sage never
-- got to reason at all.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS then re-add.

ALTER TABLE sage_uncertain_queue
  DROP CONSTRAINT IF EXISTS sage_uncertain_queue_reason_check;
ALTER TABLE sage_uncertain_queue
  ADD CONSTRAINT sage_uncertain_queue_reason_check
    CHECK (reason IN ('low_confidence', 'forbidden_topic', 'ai_unavailable'));

COMMENT ON COLUMN sage_uncertain_queue.reason IS
  'Why this question landed in the queue. ''low_confidence'' = '
  'sage_brain returned confidence < 80. ''forbidden_topic'' = '
  'pre-classification matched a venue_forbidden_topics keyword or a '
  'global ESCALATION_KEYWORDS entry, so the message bypassed sage-brain '
  'entirely. ''ai_unavailable'' = both AI providers were down, so Sage '
  'gave a warm holding reply and routed the question to a human. '
  'Per Playbook LIMB-16.4 / B-20.';
