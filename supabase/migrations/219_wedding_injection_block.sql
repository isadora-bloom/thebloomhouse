-- ============================================
-- 219_wedding_injection_block.sql
-- ============================================
--
-- Persists prompt-injection signals across the wedding lifecycle so
-- auto-send protection extends to follow-up sequences. Round-3 audit
-- caught a ghost-surface gap:
--
-- > follow-up-sequences.ts:353 calls checkAutoSendEligible without
-- > injectionSuspected. Follow-ups are scheduled outbound nudges; the
-- > original inbound's injection signal is not propagated forward. A
-- > coordinator-uninvolved follow-up sequence on a wedding whose first
-- > inbound was injection-flagged will still auto-send.
--
-- Approach:
--   - weddings.auto_send_blocked_at  : timestamptz, set when any
--     inbound on this wedding tripped containsInjectionAttempt. NULL
--     = clean. Coordinator can clear by setting NULL.
--   - weddings.auto_send_block_reason: text, captures the trigger
--     ('injection_subject', 'injection_body') for forensic review.
--
-- email-pipeline.ts will stamp these on detection. follow-up-
-- sequences.ts will read them and pass injectionSuspected accordingly.
-- A coordinator UI to clear is Tier-B (separate PR).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- ============================================

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS auto_send_blocked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS auto_send_block_reason text NULL;

COMMENT ON COLUMN public.weddings.auto_send_blocked_at IS
  'When any inbound on this wedding tripped a prompt-injection signal '
  '(containsInjectionAttempt). NULL means no signal recorded. Auto-'
  'send eligibility (autonomous-sender.ts checkAutoSendEligible) reads '
  'this and treats non-null as injectionSuspected for ALL drafts on '
  'the wedding, including follow-up sequences. Coordinator clears via '
  'a Tier-B UI (set NULL).';

COMMENT ON COLUMN public.weddings.auto_send_block_reason IS
  'Free-text reason captured at the moment of block. Examples: '
  '"injection_subject", "injection_body". Audit-only — used by ops '
  'to triage false positives.';

-- Index supports the eligibility-time read (lookup by id is already
-- the primary key). No additional index needed.

NOTIFY pgrst, 'reload schema';
