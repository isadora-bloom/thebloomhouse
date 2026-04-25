-- ============================================
-- 093: extend wedding_touchpoints.touch_type enum
--
-- The original CHECK in migration 079 covered the funnel up through
-- tour_conducted. Source attribution needs the next three rungs to
-- compute proper per-source conversion: did this lead progress past
-- the tour to a serious conversation, sign a contract, and pay?
--
-- Adds:
--   proposal_sent     — coordinator sent an offer / contract draft
--   contract_signed   — booking confirmed (deposit + signed contract)
--
-- (payment_received is intentionally NOT a separate type — every
-- payment for a wedding implies it's already contract_signed; squashing
-- payment events into contract_signed prevents over-counting bookings
-- on the funnel.)
--
-- Drop + recreate the CHECK rather than ALTER ADD-VALUE because we
-- defined it as a CHECK constraint, not a Postgres enum type.
-- ============================================

ALTER TABLE public.wedding_touchpoints DROP CONSTRAINT IF EXISTS wedding_touchpoints_touch_type_check;

ALTER TABLE public.wedding_touchpoints ADD CONSTRAINT wedding_touchpoints_touch_type_check CHECK (
  touch_type IN (
    'inquiry',
    'email_reply',
    'tour_booked',
    'tour_conducted',
    'proposal_sent',
    'contract_signed',
    'website_visit',
    'ad_click',
    'referral',
    'calendly_booked',
    'other'
  )
);

NOTIFY pgrst, 'reload schema';
