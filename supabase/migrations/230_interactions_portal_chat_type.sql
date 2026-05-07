-- ============================================================================
-- 230: INTERACTIONS — portal_chat type (Tier-B #58C)
--
-- The agent inbox reads from `interactions`. In-portal couple messages
-- have lived in a separate `messages` table since mig 004 — coordinators
-- never saw them in their main inbox. Tier-B audit #58 flagged this as
-- a real coordinator pain.
--
-- Option C (selected by user): mirror in-portal couple messages into
-- `interactions` with a new type='portal_chat'. This keeps the existing
-- inbox surface unchanged (filtering, categorization, threads, escalation
-- detection all keep working) and adds a clear channel pill so
-- coordinators know which messages are from the portal vs Gmail.
--
-- The `messages` table stays as the source of truth for the couple-side
-- thread view; interactions is the read-only mirror for the coordinator
-- inbox. Coordinator replies STILL flow through the portal Messages UI
-- (a small server-side endpoint mirrors them back into messages so the
-- couple sees the response). Gmail is never involved for portal_chat.
-- ============================================================================

ALTER TABLE public.interactions DROP CONSTRAINT IF EXISTS interactions_type_check;
ALTER TABLE public.interactions
  ADD CONSTRAINT interactions_type_check
  CHECK (type IN ('email', 'call', 'voicemail', 'sms', 'meeting', 'web_form', 'portal_chat'));

COMMENT ON CONSTRAINT interactions_type_check ON public.interactions IS
  'Allowed interaction kinds. portal_chat added 2026-05-08 by migration 230 (Tier-B #58C) for in-portal couple messages mirrored from the messages table for agent-inbox visibility.';

NOTIFY pgrst, 'reload schema';
