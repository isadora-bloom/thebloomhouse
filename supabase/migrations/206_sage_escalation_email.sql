-- ---------------------------------------------------------------------------
-- 206_sage_escalation_email.sql  (Stream EEEE)
-- ---------------------------------------------------------------------------
-- Background — Sage's outbound footer used to claim "drafted by Sage and
-- reviewed by a human from the team before anything important is
-- confirmed." That review claim is over-stated: auto-send is configurable
-- per venue, not every email is reviewed. The promise of human review on
-- an unattended autonomous send is a credibility risk if a couple ever
-- pulls the receipts.
--
-- Replacement: keep the disclosure (still legal-required + Anthropic-policy
-- required), drop the review claim, and add a hard escalation path. Every
-- Sage outbound now ends with the AI's name + role + an explicit click-
-- through that lets the couple skip Sage entirely and reach a human:
--
--    HUMAN REQUESTED  in the subject  →  pipeline skips draft generation,
--                                          fires admin notification,
--                                          coordinator handles directly.
--    Or email <escalation_email>      →  routes to a coordinator-monitored
--                                          inbox, never to Sage.
--
-- This column captures the venue's chosen escalation address. NULLABLE for
-- now (legacy rows fall back to venue contact email at footer-render time);
-- once onboarding enforces it (Stream EEEE Task 4), every NEW venue ships
-- with a real value. The fallback in src/lib/services/ai-disclosure.ts
-- keeps the footer rendering on legacy rows; if neither column resolves,
-- the second sentence is omitted entirely (never ship a broken mailto:).
--
-- No index — column is read at footer-render time (per-venue cache, called
-- once per outbound send), never queried-by.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run.
-- ---------------------------------------------------------------------------

ALTER TABLE public.venue_ai_config
  ADD COLUMN IF NOT EXISTS escalation_email text;

COMMENT ON COLUMN public.venue_ai_config.escalation_email IS
  'Required-from-onboarding human-escalation address used in Sage''s outbound footer. Couples who reply with "HUMAN REQUESTED" in the subject get routed to the coordinator; this column is the address printed in the footer''s "or email <addr> directly" sentence. NULLABLE on legacy rows; renderer falls back to venue_config.coordinator_email then venues.owner_email; if all three are absent the second footer sentence is omitted.';

NOTIFY pgrst, 'reload schema';
