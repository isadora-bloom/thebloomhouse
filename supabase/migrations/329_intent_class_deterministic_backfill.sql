-- 329_intent_class_deterministic_backfill.sql
--
-- 2026-05-12 — Backfill for the inbound-intent classifier shipped earlier
-- today (migration 327). Two live cases caught the bug class:
--
--   - Keeley Tate (Knot intake) → labelled client_logistics. The form's
--     "Interested Services: Tables and chairs, Linens, Lighting..." line
--     matched Haiku's client_logistics vocabulary.
--   - Hassan Abidi (Calendly tour booking) → labelled vendor_outreach.
--     "We have an amazing tour planned for you" read as a vendor pitch.
--
-- Form-relay senders (Knot / WeddingWire / HCTG / Zola) and scheduling
-- tools (Calendly / Acuity) are inquiry-stage by channel definition. The
-- deterministic short-circuit in inbound-intent-classifier.ts ships
-- alongside this migration so new inbounds bypass the LLM here. This
-- migration cleans up the historical tail.
--
-- Two-step repair:
--   1. Re-stamp interactions.intent_class = 'new_inquiry' for matching
--      from_email patterns with a non-inquiry-stage verdict.
--   2. Restore engagement_events.points that were zeroed by the heat-
--      suppression branch in classifyInboundIntent, using the canonical
--      DEFAULT_POINTS map from src/lib/services/heat-mapping.ts. Negative-
--      signal event types are intentionally excluded — they weren't
--      suppressed by inbound-intent and a stale 0 there could be valid.
--
-- Statement-level idempotent (no BEGIN/COMMIT — exec_sql rejects those;
-- see feedback_migration_no_transaction_wrapper).

-- ---------------------------------------------------------------------------
-- Step 1: re-stamp intent for form-relay + scheduling-tool inbounds.
-- ---------------------------------------------------------------------------

UPDATE interactions
SET intent_class = 'new_inquiry',
    intent_referenced_couple_name = NULL,
    intent_classifier_note = 'deterministic backfill mig 329: form-relay / scheduling-tool channel.',
    intent_classified_at = now()
WHERE direction = 'inbound'
  AND intent_classified_at IS NOT NULL
  AND intent_class NOT IN ('new_inquiry', 'inquiry_followup')
  AND (
    from_email ILIKE '%@theknot.com'
    OR from_email ILIKE '%@knotemail.com'
    OR from_email ILIKE '%@member.theknot.com'
    OR from_email ILIKE '%@weddingwire.com'
    OR from_email ILIKE '%@mail.weddingwire.com'
    OR from_email ILIKE '%@authsolic.com'
    OR from_email ILIKE '%@theknotww.com'
    OR from_email ILIKE '%@herecomestheguide.com'
    OR from_email ILIKE '%@zola.com'
    OR from_email ILIKE '%@calendly.com'
    OR from_email ILIKE '%@calendlymail.com'
    OR from_email ILIKE '%@acuityscheduling.com'
  );

-- ---------------------------------------------------------------------------
-- Step 2: restore zeroed engagement points for events tied to the rows
-- we just re-stamped. The original suppression set points=0; the
-- canonical default per event_type is restored.
-- ---------------------------------------------------------------------------

UPDATE engagement_events ee
SET points = CASE ee.event_type
  WHEN 'initial_inquiry' THEN 40
  WHEN 'email_opened' THEN 2
  WHEN 'email_clicked' THEN 5
  WHEN 'email_reply_received' THEN 15
  WHEN 'tour_requested' THEN 15
  WHEN 'high_commitment_signal' THEN 10
  WHEN 'family_mentioned' THEN 5
  WHEN 'high_specificity' THEN 5
  WHEN 'sustained_engagement' THEN 5
  WHEN 'tour_scheduled' THEN 20
  WHEN 'tour_completed' THEN 25
  WHEN 'final_walkthrough' THEN 5
  WHEN 'pre_wedding_event' THEN 3
  WHEN 'planning_meeting' THEN 3
  WHEN 'tour_rescheduled' THEN 5
  WHEN 'call_outbound' THEN 5
  WHEN 'call_answered' THEN 10
  WHEN 'voicemail_left' THEN 3
  WHEN 'sms_received' THEN 8
  WHEN 'call_inbound' THEN 12
  WHEN 'call_inbound_with_transcript' THEN 18
  WHEN 'voicemail_received' THEN 5
  WHEN 'zoom_meeting_completed' THEN 25
  WHEN 'contract_sent' THEN 30
  WHEN 'contract_viewed' THEN 10
  WHEN 'contract_signed' THEN 50
  WHEN 'page_view' THEN 1
  WHEN 'pricing_page_view' THEN 5
  WHEN 'gallery_page_view' THEN 3
  WHEN 'availability_page_view' THEN 5
  WHEN 'note_added' THEN 2
  WHEN 'meeting_scheduled' THEN 15
  WHEN 'replied_quickly' THEN 15
  WHEN 'tour_booked' THEN 25
  WHEN 'proposal_viewed' THEN 20
  WHEN 'proposal_requested' THEN 15
  WHEN 'follow_up_response' THEN 10
  WHEN 'referred_friend' THEN 30
  WHEN 'social_engagement' THEN 5
  WHEN 'website_visit' THEN 3
  WHEN 'honeybook_contract_signed' THEN 50
  WHEN 'honeybook_payment_received' THEN 50
  WHEN 'honeybook_amendment' THEN 5
  ELSE ee.points  -- preserve unknown event_types as-is
END
WHERE ee.points = 0
  AND ee.event_type IN (
    'initial_inquiry','email_opened','email_clicked','email_reply_received',
    'tour_requested','high_commitment_signal','family_mentioned','high_specificity',
    'sustained_engagement','tour_scheduled','tour_completed','final_walkthrough',
    'pre_wedding_event','planning_meeting','tour_rescheduled','call_outbound',
    'call_answered','voicemail_left','sms_received','call_inbound',
    'call_inbound_with_transcript','voicemail_received','zoom_meeting_completed',
    'contract_sent','contract_viewed','contract_signed','page_view',
    'pricing_page_view','gallery_page_view','availability_page_view','note_added',
    'meeting_scheduled','replied_quickly','tour_booked','proposal_viewed',
    'proposal_requested','follow_up_response','referred_friend','social_engagement',
    'website_visit','honeybook_contract_signed','honeybook_payment_received',
    'honeybook_amendment'
  )
  AND (ee.metadata->>'interaction_id') IN (
    SELECT id::text
    FROM interactions
    WHERE intent_classifier_note = 'deterministic backfill mig 329: form-relay / scheduling-tool channel.'
  );
