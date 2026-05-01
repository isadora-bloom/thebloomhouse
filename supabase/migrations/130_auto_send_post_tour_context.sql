-- Migration 130: auto_send_rules.context = 'post_tour' (T2-E Phase 2 / ARCH-5.3)
--
-- Pre-T2-E the auto_send_rules.context CHECK constraint allowed only
-- 'inquiry' and 'client' contexts. The post-tour follow-up flow
-- (post-tour-brief.ts produces drafts with brain_used='sage_post_tour'
-- and context_type='client') was conflated with the client-message
-- context — meaning a coordinator who set "auto-send for client
-- messages = true" silently auto-sent post-tour follow-ups too,
-- regardless of confidence in the brief. Doctrine ARCH-5.3 wants
-- post_tour as its own auto-send slider so coordinators can tune it
-- separately (default OFF — post-tour briefs carry tier-1 transcript
-- intelligence + family context; auto-sending them by default would
-- invite coordinator embarrassment).
--
-- This migration:
--   1. Drops the existing CHECK constraint on auto_send_rules.context
--   2. Adds a wider CHECK that includes 'post_tour'
--   3. The drafts.context_type CHECK is similarly relaxed so the
--      post-tour-brief writer can stamp 'post_tour' instead of
--      conflating with 'client'.
--
-- post-tour-brief.ts is updated in the same commit to write
-- context_type='post_tour' so the new auto_send_rules slider can
-- match. Existing 'client' rows are unaffected — the change is
-- additive.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS, ADD CONSTRAINT.

ALTER TABLE auto_send_rules
  DROP CONSTRAINT IF EXISTS auto_send_rules_context_check;
ALTER TABLE auto_send_rules
  ADD CONSTRAINT auto_send_rules_context_check
    CHECK (context IN ('inquiry', 'client', 'post_tour'));

COMMENT ON COLUMN auto_send_rules.context IS
  'Slider context this rule applies to: ''inquiry'' = first-touch '
  'replies, ''client'' = booked-couple replies, ''post_tour'' = '
  'post-tour follow-up drafts produced by post-tour-brief.ts. '
  'Per Playbook ARCH-5.3 / T2-E Phase 2 — coordinators tune each '
  'slider independently because the risk profile differs '
  '(post-tour briefs carry tier-1 transcript intelligence).';

ALTER TABLE drafts
  DROP CONSTRAINT IF EXISTS drafts_context_type_check;
ALTER TABLE drafts
  ADD CONSTRAINT drafts_context_type_check
    CHECK (context_type IN ('inquiry', 'client', 'post_tour'));
