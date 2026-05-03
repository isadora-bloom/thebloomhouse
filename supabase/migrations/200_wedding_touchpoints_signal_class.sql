-- ---------------------------------------------------------------------------
-- 200_wedding_touchpoints_signal_class.sql  (T5-Rixey-KKK)
-- ---------------------------------------------------------------------------
-- Background — see migration 192 (T5-Rixey-BBB) for the signal_class
-- model. BBB introduced signal_class on five tables (interactions,
-- tours, tangential_signals, lost_deals, attribution_events) and wired
-- the filter into FIRST-TOUCH cluster attribution. The other two
-- attribution models that the Sources & ROI page exposes — last_touch
-- and linear — read from `wedding_touchpoints` and got NO filter,
-- which means a Calendly tour confirmation (touchpoint, not source)
-- still credited Calendly with bookings. On Rixey production the bug
-- shape was:
--
--   Calendly last_touch bookings  : 17  (truth: 0)
--   Calendly linear  bookings     : 9.8 (truth: 0)
--   The Knot last_touch bookings  : >0  (truth: 0 — DB confirms zero
--                                         booked weddings have source
--                                         = 'the_knot')
--
-- Two paths considered:
--   A) Filter wedding_touchpoints rows by joining through their
--      underlying signal source-table (interactions /
--      tangential_signals / tours) at query time.
--   B) Denormalise signal_class onto wedding_touchpoints itself.
--
-- (B) wins: wedding_touchpoints is the canonical source-of-truth for
-- the multi-touch journey log, every read from it is a touchpoint
-- compute (the column belongs there structurally), and the join in
-- (A) would be slow + brittle (touchpoints don't always carry a
-- foreign key back to the originating signal row — see touchpoints.ts
-- writers, where the metadata jsonb captures the engagement_event_type
-- but not a row id).
--
-- Mapping rules (documented inline in the backfill CASE):
--   touch_type     → signal_class
--   ─────────────────────────────────────────────────────────────────
--   inquiry        → 'source'    (the originating outreach)
--   email_reply    → 'touchpoint'(post-discovery interaction)
--   tour_booked    → 'touchpoint'(scheduling tool action)
--   tour_conducted → 'touchpoint'(post-discovery event)
--   proposal_sent  → 'touchpoint'(post-discovery, venue-side)
--   contract_signed→ 'outcome'   (terminal booking event)
--   calendly_booked→ 'touchpoint'(scheduling tool action)
--   website_visit  → 'source'    (anonymous discovery touch)
--   ad_click       → 'source'    (anonymous discovery touch)
--   referral       → 'source'    (acquisition channel)
--   other          → 'unclassified'
--
-- Inquiry being 'source' is intentional even when source='calendly':
-- the inquiry row itself records the moment the lead reached out;
-- whether THAT particular inquiry came via a tool is captured by the
-- source column. The post-mig backfill REFINES this: any inquiry row
-- where source IN ('calendly','acuity','square_appointments') is
-- demoted to 'touchpoint' because the lead arrived via a scheduling
-- tool, not an acquisition channel. Symmetrically, contract_signed
-- rows whose source is a scheduling tool stay 'outcome' (the booking
-- itself is real, the channel is just plumbing).
--
-- Idempotent: ALTER is conditional, backfill only touches NULL rows.
-- Multi-venue safe: every UPDATE is venue-agnostic.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- STEP 1 — add the column with backfill DEFAULT then drop the default.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'wedding_touchpoints'
      AND column_name = 'signal_class'
  ) THEN
    ALTER TABLE public.wedding_touchpoints
      ADD COLUMN signal_class text NOT NULL DEFAULT 'unclassified'
        CHECK (signal_class IN ('source', 'touchpoint', 'crm', 'outcome', 'unclassified'));
  END IF;
END $$;

COMMENT ON COLUMN public.wedding_touchpoints.signal_class IS
  'KKK class-of-signal model (mirrors mig 192 on interactions/tours/tangential_signals/lost_deals/attribution_events). source=acquisition channel; touchpoint=lead-side intake/scheduling tool; crm=internal record-keeping; outcome=terminal event. computeSourceFunnel filters last_touch + linear models on signal_class=source so scheduling-tool touchpoints (Calendly, Acuity) cannot leak into channel attribution. Backfill mapping documented in 200_wedding_touchpoints_signal_class.sql.';

-- ---------------------------------------------------------------------------
-- STEP 2 — backfill from touch_type + source. Two-pass.
-- ---------------------------------------------------------------------------

-- Pass 1: classify by touch_type alone.
UPDATE public.wedding_touchpoints
SET signal_class = CASE
  WHEN touch_type = 'inquiry'         THEN 'source'
  WHEN touch_type = 'email_reply'     THEN 'touchpoint'
  WHEN touch_type = 'tour_booked'     THEN 'touchpoint'
  WHEN touch_type = 'tour_conducted'  THEN 'touchpoint'
  WHEN touch_type = 'proposal_sent'   THEN 'touchpoint'
  WHEN touch_type = 'contract_signed' THEN 'outcome'
  WHEN touch_type = 'calendly_booked' THEN 'touchpoint'
  WHEN touch_type = 'website_visit'   THEN 'source'
  WHEN touch_type = 'ad_click'        THEN 'source'
  WHEN touch_type = 'referral'        THEN 'source'
  ELSE 'unclassified'
END
WHERE signal_class = 'unclassified';

-- Pass 2: any inquiry row whose source is a scheduling tool gets
-- demoted from 'source' → 'touchpoint'. These are the Calendly /
-- Acuity rows that triggered the original bug — the lead used a
-- tool to reach out, but the tool is plumbing, not an acquisition
-- channel.
UPDATE public.wedding_touchpoints
SET signal_class = 'touchpoint'
WHERE touch_type = 'inquiry'
  AND lower(coalesce(source, '')) IN ('calendly', 'acuity', 'acuityscheduling', 'square_appointments', 'squareappointments');

-- ---------------------------------------------------------------------------
-- STEP 3 — keep the DEFAULT (parallel-stream safety).
-- ---------------------------------------------------------------------------
-- mig 192 dropped its DEFAULT to enforce "writers MUST declare class"
-- on the source tables (interactions/tours/etc). For wedding_touchpoints
-- we keep the DEFAULT='unclassified' because OTHER services
-- (identity-backtrack.ts, candidate-resolver.ts, source-backtrace.ts)
-- write to this table outside of touchpoints.ts and may not be touched
-- by THIS stream. Dropping the DEFAULT now would NOT NULL-violation
-- those writers at runtime. The primary writer (touchpoints.ts)
-- declares signal_class explicitly post-KKK; a follow-up stream can
-- thread the column through every direct writer + drop the DEFAULT
-- once the parallel-stream merge dust settles.
--
-- The attribution filter still works correctly: only rows where
-- signal_class='source' get last-touch / linear credit. 'unclassified'
-- rows are excluded by the filter the same way 'touchpoint' rows are
-- — the safer-of-the-two-failure-modes (an under-attributed legacy
-- row vs an over-attributed touchpoint-as-source row).

-- ---------------------------------------------------------------------------
-- STEP 4 — supporting index for the source-filtered hot path.
-- ---------------------------------------------------------------------------
-- computeSourceFunnel walks every touchpoint for a venue and filters
-- to signal_class='source' for last_touch + linear models. A partial
-- index on (venue_id, occurred_at) WHERE signal_class='source' keeps
-- that walk cheap as touchpoint counts grow.

CREATE INDEX IF NOT EXISTS idx_wedding_touchpoints_venue_source_class
  ON public.wedding_touchpoints (venue_id, occurred_at ASC)
  WHERE signal_class = 'source';

NOTIFY pgrst, 'reload schema';
