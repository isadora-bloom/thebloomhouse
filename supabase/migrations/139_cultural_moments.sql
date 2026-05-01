-- Migration 139: cultural_moments (T2-C / Playbook 17.4 + INS-19.5.8)
--
-- Per Playbook INS-19.5.8: cultural moments are time-bounded events
-- that materially shift wedding-related discretionary behaviour —
-- royal weddings, celebrity engagements, viral aesthetic shifts
-- (cottagecore / dark academia / coastal grandmother), generational
-- milestones (millennial peak / Gen Z entry into wedding age),
-- breaking news that affects bridal-industry sentiment.
--
-- The system can DETECT these patterns via search-trend spikes +
-- news embedding distance, but a coordinator must CONFIRM before
-- they enter the External Context as a named event with influence
-- weight. Auto-classification is too noisy + a wrong cultural
-- moment poisons every downstream correlation. Hence the propose-
-- and-confirm pattern.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, RLS DROP/CREATE.

CREATE TABLE IF NOT EXISTS public.cultural_moments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Lifecycle.
  status text NOT NULL DEFAULT 'proposed' CHECK (
    status IN ('proposed', 'confirmed', 'dismissed', 'archived')
  ),

  -- The moment itself.
  title text NOT NULL CHECK (length(trim(title)) > 0),
  description text,

  -- Time window. start_at required; end_at optional (some moments
  -- have a clear end date — Royal Wedding May 19 2018 — others are
  -- ongoing aesthetic shifts with no defined end).
  start_at timestamptz NOT NULL,
  end_at timestamptz,

  -- Category for grouping in /intel surfaces. Free-form so the AI
  -- proposer can suggest novel categories; the suggested values
  -- are the calibration set.
  category text CHECK (category IS NULL OR category IN (
    'celebrity_wedding',
    'aesthetic_shift',         -- cottagecore, coastal grandmother, etc.
    'generational_milestone',  -- millennial peak, Gen Z entry
    'industry_news',           -- bridal-industry-specific
    'macro_event',             -- election, pandemic, market crash
    'platform_event',          -- Pinterest algorithm shift, Knot redesign
    'other'
  )),

  -- Evidence for why this is a moment. Free-form jsonb so the AI
  -- proposer can record search-trend spike data + news embedding
  -- matches; coordinator can append notes.
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Influence weight (-100 to 100) once confirmed. Negative = damps
  -- bookings (recession, tragedy). Positive = lifts bookings (royal
  -- wedding inspiration). 0 = informational, no booking effect
  -- expected. correlation-engine reads to attribute booking-curve
  -- shifts to the named moment.
  influence_weight integer DEFAULT 0 CHECK (
    influence_weight >= -100 AND influence_weight <= 100
  ),

  -- Geographic scope. NULL = global. 'us' / 'us_northeast' / etc. for
  -- regional moments.
  geo_scope text,

  -- Who proposed this row + who confirmed/dismissed.
  proposed_by text NOT NULL DEFAULT 'system' CHECK (
    proposed_by IN ('system', 'ai', 'coordinator')
  ),
  reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cultural_moments_status
  ON public.cultural_moments (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cultural_moments_window
  ON public.cultural_moments (start_at, end_at)
  WHERE status = 'confirmed';

COMMENT ON TABLE public.cultural_moments IS
  'Named cultural / industry / macro moments with time bounds. AI '
  'proposes via propose-and-confirm pattern (status=proposed); '
  'coordinator reviews + confirms or dismisses. Confirmed moments '
  'enter External Context with influence_weight. Per Playbook '
  'INS-19.5.8 / T2-C.';

ALTER TABLE public.cultural_moments ENABLE ROW LEVEL SECURITY;

-- Cultural moments are global (not venue-scoped) — readable by any
-- authenticated user. Coordinator confirms/dismisses via service-side
-- writes; admin role gate enforced in the UI.
DROP POLICY IF EXISTS "cultural_moments_select" ON public.cultural_moments;
CREATE POLICY "cultural_moments_select" ON public.cultural_moments
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "cultural_moments_anon" ON public.cultural_moments;
CREATE POLICY "cultural_moments_anon" ON public.cultural_moments
  FOR SELECT TO anon USING (status = 'confirmed');

DROP POLICY IF EXISTS "cultural_moments_service" ON public.cultural_moments;
CREATE POLICY "cultural_moments_service" ON public.cultural_moments
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.cultural_moments_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cultural_moments_updated_at ON public.cultural_moments;
CREATE TRIGGER trg_cultural_moments_updated_at
  BEFORE UPDATE ON public.cultural_moments
  FOR EACH ROW
  EXECUTE FUNCTION public.cultural_moments_touch_updated_at();
