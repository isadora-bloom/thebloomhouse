-- ---------------------------------------------------------------------------
-- 378_drafts_cc_emails.sql
-- ---------------------------------------------------------------------------
-- Add cc_emails column to drafts so outbound replies can ship to BOTH the
-- prospect's personal email AND the platform per-prospect relay
-- (e.g. send to tara.simpson@gmail.com AS the primary recipient with
-- tara.simpson.2.772357@member.theknot.com on Cc so the conversation
-- ALSO surfaces in Knot's WeddingPro dashboard inbox for the couple).
--
-- Operator request 2026-05-28: "make sure that it sends replies to all of
-- the emails that are legit on file — so the knot would have the knot
-- email and the persons direct email." Three drafts had already shipped
-- to Knot reminder-relay addresses only and were lost; this widens
-- routing to ALL known channels per prospect.
--
-- text[] (not text) so we can carry multiple Ccs in the future
-- (e.g. WW per-prospect relay + Knot relay if a couple inquired on both
-- platforms and we resolved them to one wedding). NULL allowed: most
-- drafts have a single primary recipient and no CC.
-- ---------------------------------------------------------------------------

ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS cc_emails text[] DEFAULT '{}'::text[];

COMMENT ON COLUMN public.drafts.cc_emails IS
  'Additional recipients (Cc) to include when sending. Populated by the form-relay parser when both a personal email and a per-prospect platform relay are known. NULL/empty array = no CC.';
