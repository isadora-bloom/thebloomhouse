-- ---------------------------------------------------------------------------
-- 318_voice_channel_parity.sql  (Pattern 9. voice-channel parity with email)
-- ---------------------------------------------------------------------------
-- Live case anchor: Justin & Sandy at Rixey (RM-1139). SMS-only lead, 14+
-- inbound texts, every email-shaped system (auto-reply rules, follow-up
-- sequences, inbox lifecycle folders, draft AI brain, escalation routing)
-- treats the thread as invisible. Sage drafted a tone-deaf email follow-up
-- because the SMS conversation never surfaces in any of those systems.
--
-- This migration brings five email-only apparatus to SMS parity in one shot:
--
--   W1  auto_send_rules.channel       . extend table; email | sms
--   W2  follow_up_sequences.channel   . extend table; email | sms
--       new trigger types              . sms_no_reply, sms_tour_reminder,
--                                         sms_post_tour
--   W3  interactions.sms_lifecycle_folder. six SMS-flavour folders mirroring
--       mig 242 email folders
--   W4  pending_sms_drafts            . new table; coordinator review queue
--       for AI-drafted SMS replies (until the routability + send path lands)
--   W5  interactions.sms_escalation_requested_at. voice-channel escalation
--       flag (parallel to mig 300 escalation_requested for email)
--
-- Doctrine
--   - Wave 23: statement-level idempotency, no BEGIN/COMMIT.
--   - Every new column gets COMMENT ON COLUMN.
--   - No em dashes anywhere in copy.
--   - Multi-venue safe: per-venue scoping on every read/write site.
--   - Re-runnable: every ALTER is IF NOT EXISTS / DROP-then-ADD.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- W1. auto_send_rules.channel
-- ===========================================================================
-- Today auto_send_rules is email-only (no explicit channel column; the
-- eligibility code in checkAutoSendEligible reads it for inbound emails).
-- Add channel + default existing rows to 'email' so the eligibility query
-- can scope by (venue_id, context, channel) without code-side branching.
--
-- The thread_cap_24h column added in mig 070 already exists. Its semantics
-- become channel-aware here: the eligibility code joins drafts.gmail_thread_id
-- for email and (new) drafts.sms_thread_key for SMS. No schema change for
-- the cap itself; the runtime resolves the join based on rule.channel.

ALTER TABLE public.auto_send_rules
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email'
  CHECK (channel IN ('email', 'sms'));

COMMENT ON COLUMN public.auto_send_rules.channel IS
  'Wave Pattern-9 (mig 318): which channel this auto-send rule applies to. Existing rows default to email. SMS rules use a separate row per (venue_id, context, channel) so the eligibility query can scope without code branching.';

-- Backfill is implicit (DEFAULT 'email' applied to all existing rows). The
-- explicit UPDATE below is belt-and-braces for any historical row that
-- might already carry a non-default value from a partial earlier rollout.
UPDATE public.auto_send_rules
SET channel = 'email'
WHERE channel IS NULL;

-- Composite index for the channel-aware eligibility lookup. The existing
-- idx_auto_send_rules_venue_id (mig 002) does not cover the channel column.
CREATE INDEX IF NOT EXISTS idx_auto_send_rules_venue_channel_context
  ON public.auto_send_rules (venue_id, channel, context);

-- ===========================================================================
-- W2. follow_up_sequences.channel + new SMS trigger types
-- ===========================================================================
-- The sequences table got extended trigger types in mig 297 (tour_cancelled,
-- lost_reactivation, no_show, contract_overdue) but they all imply email
-- delivery. Add a channel column + extend the trigger_type CHECK to include
-- SMS-flavour triggers with their own cadence (minutes/hours, not days).

ALTER TABLE public.follow_up_sequences
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email'
  CHECK (channel IN ('email', 'sms'));

COMMENT ON COLUMN public.follow_up_sequences.channel IS
  'Wave Pattern-9 (mig 318): which channel this sequence sends through. Email sequences route to drafts (Gmail); SMS sequences route to pending_sms_drafts for coordinator review until the routable send path lands. Existing rows default to email.';

-- Backfill belt-and-braces.
UPDATE public.follow_up_sequences
SET channel = 'email'
WHERE channel IS NULL;

-- Extend the trigger_type CHECK. mig 297 listed:
--   post_tour / ghosted / post_booking / pre_event / tour_cancelled /
--   lost_reactivation / no_show / contract_overdue / custom
-- Add:
--   sms_no_reply       . couple sent inbound SMS, venue replied, then
--                         silence for N hours (config-driven, default 24h)
--   sms_tour_reminder  . outbound SMS reminder T-24h before tour
--   sms_post_tour      . post-tour SMS check-in for SMS-only leads
ALTER TABLE public.follow_up_sequences DROP CONSTRAINT IF EXISTS follow_up_sequences_trigger_type_check;
ALTER TABLE public.follow_up_sequences DROP CONSTRAINT IF EXISTS sequences_trigger_type_check;
ALTER TABLE public.follow_up_sequences
  ADD CONSTRAINT follow_up_sequences_trigger_type_check
  CHECK (trigger_type IN (
    'post_tour',
    'ghosted',
    'post_booking',
    'pre_event',
    'tour_cancelled',
    'lost_reactivation',
    'no_show',
    'contract_overdue',
    'sms_no_reply',
    'sms_tour_reminder',
    'sms_post_tour',
    'custom'
  ));

-- Per-channel partial index. the SMS sequence runner only loads
-- channel='sms' rows on its 15-min tick, so a partial index keeps that
-- scan cheap.
CREATE INDEX IF NOT EXISTS idx_follow_up_sequences_sms_active
  ON public.follow_up_sequences (venue_id, trigger_type)
  WHERE channel = 'sms' AND is_active = true;

-- ===========================================================================
-- W3. interactions.sms_lifecycle_folder
-- ===========================================================================
-- Email lifecycle uses interactions.lifecycle_folder (mig 242) with six
-- folders: new_inquiry / potential_client / client / vendor / advertiser /
-- other. The SMS-side mirror needs a different bucket set:
--   new           . first inbound SMS, no outbound reply yet
--   in_progress   . active back-and-forth (>=1 inbound + >=1 outbound)
--   awaiting_couple. venue replied last, waiting for couple
--   awaiting_venue . couple replied last, waiting for venue
--   on_hold       . operator-snoozed (Don't Disturb / weekend pause)
--   closed        . wedding booked / lost, OR opt-out received
--
-- These are CHECK-enforced. The TS-side state machine lives in
-- src/lib/services/sms/lifecycle.ts and writes via openphone.ts on every
-- SMS insert. The /agent/audio-inbox SMS tab filters by this column.

ALTER TABLE public.interactions
  ADD COLUMN IF NOT EXISTS sms_lifecycle_folder text
  CHECK (sms_lifecycle_folder IN (
    'new', 'in_progress', 'awaiting_couple', 'awaiting_venue', 'on_hold', 'closed'
  ));

COMMENT ON COLUMN public.interactions.sms_lifecycle_folder IS
  'Wave Pattern-9 (mig 318): SMS-side lifecycle folder. Mirrors the email lifecycle_folder (mig 242) but with SMS-flavour buckets. Decided per-thread by decideSmsLifecycleFolder() in src/lib/services/sms/lifecycle.ts and stamped on every SMS interaction in the thread on each ingest.';

-- Index used by the audio-inbox SMS tab filter (venue_id + folder + recent).
CREATE INDEX IF NOT EXISTS idx_interactions_sms_folder
  ON public.interactions (venue_id, sms_lifecycle_folder, timestamp DESC)
  WHERE type = 'sms';

-- ===========================================================================
-- W4. pending_sms_drafts
-- ===========================================================================
-- AI-generated SMS drafts land here for coordinator review until the
-- routable send path (P6 in BLOOM-PATTERNS-ZOOM-OUT.md) lands. Operator
-- hits Send manually; the row flips status='sent' on dispatch.
--
-- Shape mirrors drafts (mig 002 + extensions) but slimmer. no Gmail
-- thread/subject columns, no email-specific auto-send columns. The
-- "reason" enum lets the operator see why this draft exists.

CREATE TABLE IF NOT EXISTS public.pending_sms_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL,
  person_id uuid REFERENCES public.people(id) ON DELETE SET NULL,
  /** Triggering interaction (the inbound SMS that prompted the draft, or the
      last outbound for a sequence-driven draft). NULL only for ops-injected
      drafts. */
  trigger_interaction_id uuid REFERENCES public.interactions(id) ON DELETE SET NULL,
  /** E.164 phone the draft will be sent to. Mirrors drafts.to_email shape. */
  to_phone text NOT NULL,
  /** The draft body itself. SMS-sized: typically <= 320 chars but the
      column allows longer for multi-part. */
  draft_body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'sent', 'rejected', 'expired'
  )),
  /** Why the draft exists. Mirrors the email brain's reason taxonomy but
      SMS-flavoured. */
  reason text NOT NULL CHECK (reason IN (
    'auto_reply', 'sequence', 'manual'
  )),
  /** When the draft was generated by a sequence, which sequence row. */
  sequence_id uuid REFERENCES public.follow_up_sequences(id) ON DELETE SET NULL,
  /** Sequence type at draft time (sms_no_reply / sms_tour_reminder /
      sms_post_tour). Pinned at draft time so a sequence rename can't
      retro-rewrite history. */
  sequence_type text,
  /** Haiku confidence (0-100). Sage's email drafts use 0-1; SMS aligns to
      the 0-100 integer shape used by the autonomous-sender threshold so
      a coordinator viewing both surfaces gets one number system. */
  confidence_0_100 integer CHECK (confidence_0_100 BETWEEN 0 AND 100),
  /** Brain prompt version (SMS_BRAIN_PROMPT_VERSION). */
  prompt_version text,
  /** Cost ledger pointer. for audit. */
  cost decimal,
  tokens_used integer,
  /** Operator action audit. */
  approved_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  sent_at timestamptz,
  rejected_at timestamptz,
  rejection_reason text,
  /** Forensic correlation id from the triggering inbound's processing
      lineage. Links the draft to the cost log + admin notifications. */
  correlation_id uuid,
  created_at timestamptz DEFAULT now()
);

COMMENT ON TABLE public.pending_sms_drafts IS
  'Wave Pattern-9 (mig 318): coordinator-review queue for AI-generated SMS drafts. SMS auto-reply rules + SMS sequences land drafts here; the operator hits Send manually until the routable SMS send path (P6) ships.';

CREATE INDEX IF NOT EXISTS idx_pending_sms_drafts_venue_status
  ON public.pending_sms_drafts (venue_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_sms_drafts_wedding
  ON public.pending_sms_drafts (wedding_id)
  WHERE wedding_id IS NOT NULL;

-- RLS. venue isolation + super_admin bypass. Same shape as drafts (mig 006).
ALTER TABLE public.pending_sms_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_isolation" ON public.pending_sms_drafts;
CREATE POLICY "venue_isolation" ON public.pending_sms_drafts
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "super_admin_bypass" ON public.pending_sms_drafts;
CREATE POLICY "super_admin_bypass" ON public.pending_sms_drafts
  FOR ALL
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- ===========================================================================
-- W5. interactions.sms_escalation_requested_at
-- ===========================================================================
-- The email path uses interactions.escalation_requested (mig 300) +
-- escalation_reason + escalation_decided_at to flag a human-escalation
-- request and route it to admin_notifications. SMS today has none of
-- this. an inbound "can I talk to a real person?" SMS just sits there.
--
-- Add a parallel boolean stamped by classifyEscalation (Haiku) on the
-- SMS persist path. Separate column rather than overloading the email
-- escalation_requested because the email-side consumers (heat scoring
-- gates, classifier-health filters) only expect email rows. A dedicated
-- column lets the SMS coordinator surface filter cleanly without
-- breaking the email-side queries.

ALTER TABLE public.interactions
  ADD COLUMN IF NOT EXISTS sms_escalation_requested_at timestamptz;

COMMENT ON COLUMN public.interactions.sms_escalation_requested_at IS
  'Wave Pattern-9 (mig 318): when the SMS escalation classifier (Haiku + regex fast-path) flagged this inbound as a human-escalation request. NULL = not flagged or not yet classified. Pairs with admin_notifications.type=sms_escalation_requested for the coordinator-facing alert.';

ALTER TABLE public.interactions
  ADD COLUMN IF NOT EXISTS sms_escalation_reason text
  CHECK (sms_escalation_reason IS NULL OR sms_escalation_reason IN (
    'magic_words', 'haiku_detected', 'operator_flagged'
  ));

COMMENT ON COLUMN public.interactions.sms_escalation_reason IS
  'Wave Pattern-9 (mig 318): why the SMS escalation flag fired. magic_words = regex fast-path (mirror of email pipeline HUMAN_ESCALATION_PATTERN); haiku_detected = Haiku classifier verdict; operator_flagged = manual coordinator action from the SMS surface.';

-- Index used by the coordinator-facing SMS escalation feed.
CREATE INDEX IF NOT EXISTS idx_interactions_sms_escalation
  ON public.interactions (venue_id, sms_escalation_requested_at DESC)
  WHERE sms_escalation_requested_at IS NOT NULL;

NOTIFY pgrst, 'reload schema';
