-- ---------------------------------------------------------------------------
-- 191_signal_class.sql  (T5-Rixey-BBB identity-cluster attribution)
-- ---------------------------------------------------------------------------
-- Background — see audits/2026-05-T4-postlaunch/identity-cluster-
-- attribution-design.md for the full design. Spike at
-- scripts/rixey-load/50-bbb-spike.ts validated the model on Rixey
-- production data (854 weddings, 2,630 interactions, 1,951 tangentials).
--
-- Today every fact about a lead is conflated with every other fact:
-- Calendly is a touchpoint that sometimes gets stamped as "source",
-- HoneyBook is a CRM that sometimes gets stamped as "source", The Knot
-- inbound is BOTH a source signal AND a touchpoint relay (same row,
-- two roles). The spike found that of 802 chain-attributed Rixey
-- weddings, 559 were touchpoint/CRM buckets dressed up as "lead
-- source" — only 243 were genuine acquisition channels.
--
-- The fix is structural: every signal we capture carries an explicit
-- CLASS so the attribution engine can answer "what was the earliest
-- SOURCE-class signal in this lead's identity cluster?" with one
-- filter, not a 7-tier patchwork of platform-specific rules.
--
-- Four classes (closed set; growth requires its own migration):
--
--   source     — acquisition channel; where the lead first heard about
--                / discovered the venue. The Knot view, WeddingWire
--                saved-vendor, Google search, Instagram follow,
--                referral, bridal-show booth.
--   touchpoint — tool the lead used AFTER discovering us. Calculator
--                submission, Calendly tour booking, contact-form
--                submission. NOT an acquisition channel.
--   crm        — internal system that holds the record of the lead.
--                HoneyBook project, Dubsado workflow.
--   outcome    — terminal events. Booking, payment, lost reason,
--                cancellation reason.
--   unclassified — provisional bucket for legacy rows the backfill
--                  could not unambiguously place. Future writers MUST
--                  declare class explicitly (the DEFAULT is dropped at
--                  the end of this migration); 'unclassified' remains a
--                  valid value so historical rows + the rare
--                  genuinely-ambiguous case (e.g. brain-dump CSV with
--                  no provenance) round-trip without surprise.
--
-- This migration adds the column + a one-shot backfill on
-- interactions / tours / tangential_signals / lost_deals /
-- attribution_events. No code change yet — the cluster-compute
-- service consumes the column starting in Stream BBB-3, and the
-- adapters start declaring it on every insert in Stream BBB-2 (this
-- same commit). The DEFAULT is intentionally dropped after backfill
-- so a future adapter that forgets the field fails the NOT NULL
-- CHECK at insert time.
--
-- Idempotent: each ALTER is conditional on an information_schema
-- check; backfill is a strict subset (rows with NULL class only),
-- so re-running the migration is a no-op once stamped.
--
-- Multi-venue safe: every UPDATE is venue-agnostic; classification
-- is structural, not per-venue.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- STEP 1 — interactions.signal_class
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'interactions'
      AND column_name = 'signal_class'
  ) THEN
    ALTER TABLE public.interactions
      ADD COLUMN signal_class text NOT NULL DEFAULT 'unclassified'
        CHECK (signal_class IN ('source', 'touchpoint', 'crm', 'outcome', 'unclassified'));
  END IF;
END $$;

COMMENT ON COLUMN public.interactions.signal_class IS
  'BBB class-of-signal model. source=acquisition channel; touchpoint=lead-side intake tool; crm=internal record-keeping system; outcome=terminal event; unclassified=legacy or ambiguous. Cluster-compute (computeFirstTouchForCluster) returns the earliest source-class signal in the lead identity cluster as first-touch.';

-- Backfill — the spike script + adapter classifier are the canonical
-- source for these patterns. We replicate them as a CASE expression
-- so the live pipeline gets a sensible class on every existing row
-- without re-running the adapters. Anything that does not match the
-- known patterns stays as 'unclassified' — safer than wrong-class.

UPDATE public.interactions
SET signal_class = CASE
  -- crm-class first (most specific): adapter-tagged HoneyBook /
  -- Dubsado / Aisle Planner records, plus bare from-domain matches.
  WHEN crm_source IN ('honeybook', 'dubsado', 'aisle_planner')
    THEN 'crm'
  WHEN from_email ILIKE '%@honeybook.com'
    OR from_email ILIKE '%@dubsado.com'
    THEN 'crm'

  -- touchpoint-class: web-form intake + tour-scheduler bookings +
  -- calculator submissions. type='web_form' (mig 178) + type='meeting'
  -- (mig 100) when the from-domain is a scheduler.
  WHEN type IN ('web_form', 'form')
    THEN 'touchpoint'
  WHEN crm_source = 'web_form'
    THEN 'touchpoint'
  WHEN from_email ILIKE '%@calendly.com'
    OR from_email ILIKE '%@acuityscheduling.com'
    THEN 'touchpoint'
  WHEN type = 'meeting'
    AND extracted_identity IS NOT NULL
    AND (extracted_identity->>'provider') IN ('calendly', 'acuity', 'square_appointments')
    THEN 'touchpoint'
  WHEN lower(coalesce(subject, '')) LIKE '%calculator%'
    THEN 'touchpoint'

  -- source-class: from-domain matches the platform map, or the
  -- HoneyBook Q7 / lead_source field carries a recognised channel.
  WHEN from_email ILIKE '%@theknot.com'
    OR from_email ILIKE '%.theknot.com'
    OR from_email ILIKE '%@mail.theknot.com'
    OR from_email ILIKE '%@auth.theknot.com'
    OR from_email ILIKE '%@member.theknot.com'
    THEN 'source'
  WHEN from_email ILIKE '%@weddingwire.com'
    OR from_email ILIKE '%@mail.weddingwire.com'
    OR from_email ILIKE '%@authsolic.com'
    THEN 'source'
  WHEN from_email ILIKE '%@zola.com'
    OR from_email ILIKE '%@mail.zola.com'
    THEN 'source'
  WHEN from_email ILIKE '%@herecomestheguide.com'
    THEN 'source'
  WHEN from_email ILIKE '%@wedsites.com'
    THEN 'source'
  WHEN extracted_identity IS NOT NULL
    AND (extracted_identity ? 'hear_source' OR extracted_identity ? 'utm_source')
    THEN 'source'

  ELSE 'unclassified'
END
WHERE signal_class = 'unclassified';

-- ---------------------------------------------------------------------------
-- STEP 2 — tours.signal_class (always 'touchpoint')
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tours'
      AND column_name = 'signal_class'
  ) THEN
    ALTER TABLE public.tours
      ADD COLUMN signal_class text NOT NULL DEFAULT 'unclassified'
        CHECK (signal_class IN ('source', 'touchpoint', 'crm', 'outcome', 'unclassified'));
  END IF;
END $$;

COMMENT ON COLUMN public.tours.signal_class IS
  'BBB class-of-signal model. Tours are ALWAYS touchpoint — the lead used a scheduling tool to book a tour AFTER discovering the venue. They do not contribute to first-touch attribution.';

UPDATE public.tours
SET signal_class = 'touchpoint'
WHERE signal_class = 'unclassified';

-- ---------------------------------------------------------------------------
-- STEP 3 — tangential_signals.signal_class
-- ---------------------------------------------------------------------------
-- Tangential signals are cross-platform engagement (Knot view, WW
-- saved-vendor, IG follow, Pinterest pin, review) — by definition
-- source-class. Form-submission rows from the web-form adapter are
-- the exception (touchpoint). Any platform we don't recognise stays
-- 'unclassified' rather than guessing.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tangential_signals'
      AND column_name = 'signal_class'
  ) THEN
    ALTER TABLE public.tangential_signals
      ADD COLUMN signal_class text NOT NULL DEFAULT 'unclassified'
        CHECK (signal_class IN ('source', 'touchpoint', 'crm', 'outcome', 'unclassified'));
  END IF;
END $$;

COMMENT ON COLUMN public.tangential_signals.signal_class IS
  'BBB class-of-signal model. Cross-platform engagement signals are mostly source-class (Knot view, WW saved-vendor, IG follow, Pinterest pin). Web-form submissions are touchpoint. Unknown platforms stay unclassified.';

UPDATE public.tangential_signals
SET signal_class = CASE
  WHEN signal_type = 'form_submission' OR source_platform = 'website_form'
    THEN 'touchpoint'
  WHEN lower(source_platform) LIKE '%knot%'
    OR lower(source_platform) LIKE '%weddingwire%'
    OR lower(source_platform) LIKE '%wedding_wire%'
    OR lower(source_platform) LIKE '%zola%'
    OR lower(source_platform) LIKE '%instagram%'
    OR lower(source_platform) LIKE '%facebook%'
    OR lower(source_platform) LIKE '%pinterest%'
    OR lower(source_platform) LIKE '%google%'
    OR lower(source_platform) LIKE '%here_comes_the_guide%'
    OR lower(source_platform) LIKE '%hctg%'
    OR lower(source_platform) LIKE '%tiktok%'
    OR lower(source_platform) LIKE '%reddit%'
    OR lower(source_platform) LIKE '%youtube%'
    OR lower(source_platform) LIKE '%review%'
    THEN 'source'
  ELSE 'unclassified'
END
WHERE signal_class = 'unclassified';

-- ---------------------------------------------------------------------------
-- STEP 4 — lost_deals.signal_class (always 'outcome')
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'lost_deals'
      AND column_name = 'signal_class'
  ) THEN
    ALTER TABLE public.lost_deals
      ADD COLUMN signal_class text NOT NULL DEFAULT 'unclassified'
        CHECK (signal_class IN ('source', 'touchpoint', 'crm', 'outcome', 'unclassified'));
  END IF;
END $$;

COMMENT ON COLUMN public.lost_deals.signal_class IS
  'BBB class-of-signal model. Lost-deal records are ALWAYS outcome class — terminal event with reason metadata, no acquisition signal.';

UPDATE public.lost_deals
SET signal_class = 'outcome'
WHERE signal_class = 'unclassified';

-- ---------------------------------------------------------------------------
-- STEP 5 — attribution_events.signal_class
-- ---------------------------------------------------------------------------
-- Per Phase B (mig 105) attribution_events.is_first_touch=true marks
-- the chronologically earliest pre-inquiry signal — that is a
-- source-class anchor by definition. bucket='attribution' rows are
-- discovery-credit (source); bucket='nurture' rows are post-inquiry
-- comebacks (outcome-ish, but really "engagement" — no clean class
-- in the model, so 'source' is the safest backfill since these all
-- stem from acquisition platforms).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'attribution_events'
      AND column_name = 'signal_class'
  ) THEN
    ALTER TABLE public.attribution_events
      ADD COLUMN signal_class text NOT NULL DEFAULT 'unclassified'
        CHECK (signal_class IN ('source', 'touchpoint', 'crm', 'outcome', 'unclassified'));
  END IF;
END $$;

COMMENT ON COLUMN public.attribution_events.signal_class IS
  'BBB class-of-signal model. Phase B audit rows for resolved candidate-identity matches. is_first_touch=true rows are source class by definition (chronologically earliest discovery touch). bucket=attribution is source; bucket=nurture stays source (post-discovery re-engagement on the same acquisition platform).';

UPDATE public.attribution_events
SET signal_class = CASE
  WHEN is_first_touch = true THEN 'source'
  WHEN bucket = 'attribution' THEN 'source'
  WHEN bucket = 'nurture' THEN 'source'
  ELSE 'unclassified'
END
WHERE signal_class = 'unclassified';

-- ---------------------------------------------------------------------------
-- STEP 6 — drop the DEFAULTs.
-- ---------------------------------------------------------------------------
-- Per the design doc's "writers MUST declare class explicitly" rule:
-- a future adapter that forgets to set signal_class on insert should
-- get a NOT NULL violation, not silently land 'unclassified' rows.
-- The CI guard (scripts/check-signal-class-declared.mjs) enforces
-- this at the source-code level; dropping the DEFAULT enforces it at
-- the database level.

ALTER TABLE public.interactions       ALTER COLUMN signal_class DROP DEFAULT;
ALTER TABLE public.tours              ALTER COLUMN signal_class DROP DEFAULT;
ALTER TABLE public.tangential_signals ALTER COLUMN signal_class DROP DEFAULT;
ALTER TABLE public.lost_deals         ALTER COLUMN signal_class DROP DEFAULT;
ALTER TABLE public.attribution_events ALTER COLUMN signal_class DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- STEP 7 — supporting indexes
-- ---------------------------------------------------------------------------
-- The cluster-compute hot path walks every source-class signal for a
-- venue ordered by timestamp. A partial index on (venue_id,
-- signal_class) WHERE signal_class='source' keeps the per-cluster
-- walk cheap as wedding/interaction counts grow.

CREATE INDEX IF NOT EXISTS idx_interactions_venue_source_class
  ON public.interactions (venue_id, timestamp ASC)
  WHERE signal_class = 'source';

CREATE INDEX IF NOT EXISTS idx_tangential_signals_venue_source_class
  ON public.tangential_signals (venue_id, signal_date ASC)
  WHERE signal_class = 'source';

-- ---------------------------------------------------------------------------
-- STEP 8 — parity log table for the BBB-4 dashboard.
-- ---------------------------------------------------------------------------
-- The parity cron (`compute_attribution_parity`) writes one row per
-- active wedding per run, capturing the legacy chain output + the new
-- cluster output side-by-side. The dashboard at /intel/sources/parity
-- reads from this table to surface agreement rate over time +
-- divergent-row drill-downs.
--
-- Storage scale: 854 active Rixey weddings × daily run × 30 days =
-- ~25k rows/month, sub-megabyte. Multi-venue at 5,000 weddings × 30
-- days = 150k rows/month, still trivial.

CREATE TABLE IF NOT EXISTS public.attribution_parity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  -- Canonical first-touch from the legacy 7-tier chain
  -- (lead-source-derivation.ts).
  chain_source text,
  -- Canonical first-touch from the new identity-cluster compute
  -- (computeFirstTouchForCluster()).
  cluster_source text,
  -- True iff both produced the same canonical value (after
  -- formatSourceLabel canonicalisation).
  agree boolean NOT NULL,
  -- Detail blob: cluster confidence band, evidence count,
  -- signal-class distribution. Lets the dashboard surface a
  -- "why does the cluster pick X?" tooltip without re-running compute.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.attribution_parity_log IS
  'BBB-4 (2026-05-02). Side-by-side per-wedding capture of the legacy 7-tier chain output and the new identity-cluster first-touch output. Powers /intel/sources/parity coordinator dashboard. Cutover gate: USE_CLUSTER_FIRST_TOUCH flag flips ON only after dashboard shows >=90% agreement for 7 consecutive days AND CCC has been running for >=48h.';

CREATE INDEX IF NOT EXISTS idx_attribution_parity_log_venue_time
  ON public.attribution_parity_log (venue_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_attribution_parity_log_wedding_time
  ON public.attribution_parity_log (wedding_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_attribution_parity_log_disagree
  ON public.attribution_parity_log (venue_id, computed_at DESC)
  WHERE agree = false;

-- RLS: same pattern as attribution_events (mig 105). Coordinator
-- reads through the parity dashboard via a venue-scoped query;
-- service role writes from the cron path bypass RLS by default.
ALTER TABLE public.attribution_parity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "attribution_parity_log_select" ON public.attribution_parity_log;
CREATE POLICY "attribution_parity_log_select" ON public.attribution_parity_log
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

COMMIT;
