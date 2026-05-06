-- ============================================================================
-- Migration 214: free-text email signature appended to outbound Sage emails.
-- ============================================================================
--
-- Context: the post-onboarding checklist links to /agent/settings to
-- configure an email signature, but until now no column existed and no
-- code path appended one. Sage's outbound emails ended on the last line
-- of body text, which feels abrupt and unprofessional.
--
-- Migration 195 (T5-Rixey-FFF) added STRUCTURED signature fields
-- (signature_tagline, signature_website, signature_phone, ai_role_title,
-- signature_text_capable) to venue_ai_config. Those drive in-prompt
-- signature GENERATION — the AI is told to compose a sign-off using
-- those values when it writes the body. The new email_signature column
-- is different: a coordinator-authored free-text block appended LITERALLY
-- to the outbound body at send time, after the brain has produced the
-- draft. Two reasons it's a separate column:
--
--   1. Generation vs. append. Structured fields shape what the model
--      writes inside the body. email_signature is post-body text the
--      model never sees — predictable, deterministic, no LLM drift.
--   2. Legacy / migrating venues. Coordinators bringing a venue over
--      from another product often have a long-standing signature block
--      ("— Sage / Hawthorne Manor / 540-...") and want it pasted in
--      verbatim. The structured fields can't represent every layout
--      (multi-line addresses, custom punctuation, opt-in disclaimers).
--
-- We mirror migration 195's table choice because all other coordinator-
-- set tone/voice/sign-off fields already live on venue_ai_config:
-- ai_name, ai_role, ai_role_title, signature_*. Putting email_signature
-- next to them keeps the personality + outbound-presentation surface
-- coherent.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS guards re-runs.
-- ============================================================================

ALTER TABLE public.venue_ai_config
  ADD COLUMN IF NOT EXISTS email_signature text;

COMMENT ON COLUMN public.venue_ai_config.email_signature IS
  'Coordinator-authored free-text signature appended to every outbound Sage email (auto-send + approved drafts + agent reply / send / re-engagement). Two newlines + this string, inserted between the body and the AI-disclosure footer. Plain text only — HTML signatures introduce too much spam-filter risk. Empty / null = no signature line. Distinct from the structured signature_tagline / signature_website / signature_phone fields (migration 195) which the brain uses to GENERATE in-prompt sign-offs; email_signature is a literal append the model never sees.';

NOTIFY pgrst, 'reload schema';
