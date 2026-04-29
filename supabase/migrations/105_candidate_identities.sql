-- ---------------------------------------------------------------------------
-- 105_candidate_identities.sql
-- ---------------------------------------------------------------------------
-- Phase B of the platform-signals build (2026-04-28). Phase A landed
-- raw signals into tangential_signals. Phase B clusters those signals
-- into candidate identities, then resolves candidates to weddings
-- (the existing "lead" entity), writing an audit row per match.
--
-- Why a NEW table layer instead of matching tangential_signals.matched_person_id
-- directly to people:
--   * A "Sarah R." view + save + message funnel on Knot is one
--     candidate identity with three signals attached, not three
--     identities. Matching at the signal level loses the funnel
--     evidence (depth-3 funnel is much stronger than one view).
--   * Two distinct Sarah R.s (different states, or > 30d gap) need
--     to be separate candidates even before they're matched to leads.
--   * Cross-platform same-person lives as sibling candidates with a
--     same_as_candidate_id pointer until a wedding resolves them.
--   * Anonymous signals (the 250+ ". " rows from Knot) need to be
--     captured for ROI rollup but never become candidates.
--
-- Two new tables:
--   1. candidate_identities — clusters of signals for one (probable)
--      person on one platform at one venue. Carries first/last_seen,
--      funnel_depth, action_counts, resolution state.
--   2. attribution_events — audit row per match decision. Says
--      "candidate X resolved to wedding Y at confidence Z by AI/auto/
--      coordinator". Reversible via reverted_at; supports the conflict
--      flag system (wedding.source manually set vs. computed first-touch).
--
-- Plus: tangential_signals.candidate_identity_id FK so signals can
-- join up to their cluster.
--
-- The resolver computes first-touch as the EARLIEST signal in the
-- candidate's timeline, NOT the channel the inquiry email arrived on.
-- This matters because someone who followed on Instagram March 5,
-- viewed Knot March 12, then submitted via a Knot referral form should
-- attribute to Instagram (the actual first touch), not Knot (the
-- inquiry channel). attribution_events.is_first_touch captures this.
--
-- Data reuse: when a candidate resolves to a wedding, the resolver
-- also backfills wedding_touchpoints rows so the existing /intel
-- journey UI immediately surfaces the Knot view + save + message in
-- chronological order alongside email/Calendly touchpoints.
--
-- Cross-venue: each candidate is venue-scoped. Same Sarah R. on Rixey
-- AND Hawthorne Manor (when multi-venue) = two candidates. Each
-- venue's intelligence stays in its scope.
--
-- Cluster boundary semantics: existing cluster assignments are
-- immutable post-creation. The clusterer only processes signals
-- whose candidate_identity_id IS NULL, so re-running it never
-- shifts a previously-attached signal. Within a single batch the
-- ordering is deterministic (signals sorted by signal_date before
-- processing); across batches a late-arriving earlier signal joins
-- the closest existing cluster within window — that's the
-- chronological reality, not instability. To rebuild from scratch,
-- coordinator can soft-delete candidates and the nightly sweep
-- re-attaches their signals.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — candidate_identities table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.candidate_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Per-platform scope. Cross-platform same-person stays as sibling
  -- candidates linked via same_as_candidate_id; never auto-merged.
  source_platform text NOT NULL,

  -- Identity fingerprint (parsed from signal raw rows). Each is
  -- nullable because vendors give wildly different density:
  --   Knot/WW: first_name + last_initial + state (sometimes city)
  --   Instagram: username + display_name (no email, no location)
  --   Google Business: sometimes phone or email (gold)
  first_name text,
  last_initial text,
  last_name text,
  email text,
  phone text,
  username text,
  city text,
  state text,
  country text,

  -- Cluster grouping for long-gap same-fingerprint candidates. When a
  -- new signal lands beyond the 30-day clustering window, a new
  -- candidate is minted with the SAME cluster_group_key as the prior
  -- candidate(s). Coordinator review UI groups by cluster_group_key
  -- so they can see "you have 3 Sarah-R-VA candidates across the year,
  -- possibly the same person" without auto-merging us into a wrong
  -- collapse.
  cluster_group_key text,

  -- Cross-platform sibling pointer. NULL by default. Set when we have
  -- evidence two candidates on different platforms are likely the
  -- same person (matching display_name + state, or coordinator-
  -- confirmed). They stay as separate rows until a wedding resolves
  -- them — the lead inquiry is the ground truth that collapses them.
  same_as_candidate_id uuid REFERENCES public.candidate_identities(id) ON DELETE SET NULL,

  -- Aggregate signal stats. Updated by the clusterer on every signal
  -- attach. Funnel depth = count of distinct action_class values.
  -- A view+save+message cluster (depth=3) is much stronger evidence
  -- than a lone view (depth=1) when matching against a lead.
  signal_count integer NOT NULL DEFAULT 0,
  funnel_depth integer NOT NULL DEFAULT 0,
  -- Shape: { view: 3, save: 1, message: 1, click: 0, ... }
  action_counts jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- First and last signal_date observed in the cluster.
  first_seen timestamptz,
  last_seen timestamptz,

  -- Resolution state. NULL until matched.
  resolved_wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL,
  resolved_person_id uuid REFERENCES public.people(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolved_by text CHECK (resolved_by IS NULL OR resolved_by IN ('auto', 'ai', 'coordinator')),
  resolved_confidence integer CHECK (resolved_confidence IS NULL OR (resolved_confidence >= 0 AND resolved_confidence <= 100)),

  -- review_status flags clusters that need human review BEFORE auto-
  -- linking. The 14-30d cluster zone (signals that clustered but at
  -- the edge) sits at 'needs_review'. AI-uncertain Tier 2 matches
  -- also bump the parent candidate to 'needs_review' so coordinators
  -- see why the system held back.
  review_status text NOT NULL DEFAULT 'clean'
    CHECK (review_status IN ('clean', 'needs_review', 'reviewed')),

  -- Soft delete only — never hard-delete signal data.
  deleted_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.candidate_identities IS
  'Phase B (2026-04-28). Clusters of platform signals that probably represent one person on one platform at one venue. Sits between tangential_signals (raw) and weddings (resolved leads). Carries funnel-depth and action_counts so a Sarah-R-views+saves+messages cluster matches more confidently than a lone view. Cross-platform stays separate via same_as_candidate_id. Coordinator can soft-delete via deleted_at.';

COMMENT ON COLUMN public.candidate_identities.cluster_group_key IS
  'Phase B. Long-gap same-fingerprint candidates share a cluster_group_key. Lets the coordinator review UI group "all the Sarah-R-VA candidates across the year" for manual merge without us auto-collapsing them into one wrong cluster.';

COMMENT ON COLUMN public.candidate_identities.funnel_depth IS
  'Phase B. Count of distinct action_class values in this cluster. View+save+message = 3. Used as confidence boost when matching to a lead — a depth-3 candidate is much stronger evidence than depth-1.';

COMMENT ON COLUMN public.candidate_identities.review_status IS
  'Phase B. clean = auto-clustered cleanly (≤14d window). needs_review = at the cluster window edge (14-30d) or AI-uncertain match. reviewed = coordinator has confirmed/dismissed. Surfaces in coordinator review queue.';

-- Clustering lookup. Resolver and clusterer hit this constantly.
CREATE INDEX IF NOT EXISTS idx_candidate_identities_fingerprint
  ON public.candidate_identities (venue_id, source_platform, lower(first_name), lower(last_initial))
  WHERE deleted_at IS NULL;

-- Unresolved sweep. Nightly cron + lead-create resolver scan unresolved
-- candidates to attempt new matches.
CREATE INDEX IF NOT EXISTS idx_candidate_identities_unresolved
  ON public.candidate_identities (venue_id, last_seen DESC)
  WHERE resolved_wedding_id IS NULL AND deleted_at IS NULL;

-- "all candidates linked to this lead" — used in lead detail signal-evidence widget.
CREATE INDEX IF NOT EXISTS idx_candidate_identities_resolved_wedding
  ON public.candidate_identities (resolved_wedding_id, source_platform)
  WHERE resolved_wedding_id IS NOT NULL;

-- Long-gap cluster grouping for coordinator review.
CREATE INDEX IF NOT EXISTS idx_candidate_identities_cluster_group
  ON public.candidate_identities (venue_id, cluster_group_key)
  WHERE cluster_group_key IS NOT NULL;

-- Email and username exact-match Tier 1 paths.
CREATE INDEX IF NOT EXISTS idx_candidate_identities_email
  ON public.candidate_identities (venue_id, lower(email))
  WHERE email IS NOT NULL AND email != '';
CREATE INDEX IF NOT EXISTS idx_candidate_identities_username
  ON public.candidate_identities (venue_id, source_platform, lower(username))
  WHERE username IS NOT NULL AND username != '';

ALTER TABLE public.candidate_identities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "candidate_identities_select" ON public.candidate_identities;
CREATE POLICY "candidate_identities_select" ON public.candidate_identities
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

DROP POLICY IF EXISTS "candidate_identities_update" ON public.candidate_identities;
CREATE POLICY "candidate_identities_update" ON public.candidate_identities
  FOR UPDATE TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "demo_anon_select" ON public.candidate_identities;
CREATE POLICY "demo_anon_select" ON public.candidate_identities
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

CREATE OR REPLACE FUNCTION public.candidate_identities_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_candidate_identities_updated_at ON public.candidate_identities;
CREATE TRIGGER trg_candidate_identities_updated_at
  BEFORE UPDATE ON public.candidate_identities
  FOR EACH ROW
  EXECUTE FUNCTION public.candidate_identities_touch_updated_at();

-- ============================================================================
-- STEP 2 — attribution_events table
-- ============================================================================
-- Audit row per resolution decision. Every auto-link, AI-confident
-- match, and coordinator confirm writes one row. is_first_touch flags
-- the earliest pre-inquiry signal — that's the row /intel/sources
-- reads for ROI attribution. Other rows on the same wedding are
-- additional touches in the journey.
--
-- weddings.source is intentionally NEVER overwritten by this system.
-- It stays as a legacy display field. attribution_events is the
-- source of truth for actual first-touch — when the legacy field and
-- the new computation disagree, conflict_with_legacy_source captures
-- the divergence and the coordinator review UI surfaces a flag.

CREATE TABLE IF NOT EXISTS public.attribution_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  candidate_identity_id uuid NOT NULL REFERENCES public.candidate_identities(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  -- The specific signal that pinned this attribution. For first-touch
  -- rows this is the earliest pre-inquiry signal in the cluster. For
  -- nurture rows it's the relevant post-inquiry signal.
  signal_id uuid REFERENCES public.tangential_signals(id) ON DELETE SET NULL,

  -- Platform that this attribution credits. Denormalized from the
  -- candidate so /intel/sources can roll up without a join.
  source_platform text NOT NULL,

  -- Confidence (0-100) and tier. Tier mirrors the resolver decision
  -- band so the review UI can filter to "show me everything Tier 2
  -- AI decided".
  confidence integer NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  tier text NOT NULL CHECK (tier IN (
    'tier_1_exact',          -- email/phone/username exact match
    'tier_1_name_window',    -- first_name + last_initial + ±72h + uniqueness gate
    'tier_1_full_name',      -- last_name + first_name + state
    'tier_2_ai',             -- AI adjudicator confident
    'tier_2_coordinator',    -- coordinator confirmed from queue
    'tier_3_manual'          -- coordinator manually linked from search
  )),
  decided_by text NOT NULL CHECK (decided_by IN ('auto', 'ai', 'coordinator')),
  decided_at timestamptz NOT NULL DEFAULT now(),

  -- AI reasoning for tier_2_ai rows; coordinator notes for tier_2_coordinator.
  reasoning text,

  -- True when this signal is the chronologically earliest pre-inquiry
  -- signal across all candidates resolved to this wedding. Computed
  -- from the candidate's timeline, NOT inferred from the inquiry
  -- channel. Recomputed when a new earlier signal arrives.
  is_first_touch boolean NOT NULL DEFAULT false,

  -- Direction-aware bucket. Pre-inquiry signals are 'attribution'
  -- (claim discovery credit). Post-inquiry signals are 'nurture'
  -- (already a lead, this is them coming back). Two-bucket model
  -- keeps the ROI rollup honest — Knot only gets credit for
  -- pre-inquiry signals.
  bucket text NOT NULL CHECK (bucket IN ('attribution', 'nurture')),

  -- Conflict flag when the legacy weddings.source disagrees with this
  -- attribution. The flag surfaces a badge on lead detail and a row
  -- in coordinator review queue. Both attributions stored; neither
  -- silently wins.
  conflict_with_legacy_source text,

  -- Reversal via the "change" button on auto-linked rows. Reverted
  -- rows stay in the table (audit trail) but is_first_touch is
  -- recomputed across remaining live rows.
  reverted_at timestamptz,
  reverted_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reverted_reason text,

  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.attribution_events IS
  'Phase B (2026-04-28). One row per match decision (auto/AI/coordinator). is_first_touch=true marks the earliest pre-inquiry signal credited to a wedding — the row /intel/sources reads for ROI. weddings.source is legacy and never overwritten by this table; conflict_with_legacy_source flags divergence for coordinator review.';

COMMENT ON COLUMN public.attribution_events.is_first_touch IS
  'Phase B. True when this signal is chronologically earliest across all signals resolved to this wedding. Recomputed when a new earlier signal arrives. Drives /intel/sources ROI attribution. NEVER inferred from inquiry channel — Instagram-follow-March-5 wins over Knot-view-March-12 even when the inquiry email came through Knot.';

COMMENT ON COLUMN public.attribution_events.bucket IS
  'Phase B. attribution = signal predates the inquiry/tour, claim discovery credit. nurture = signal post-inquiry, already a lead just coming back to look. Two-bucket model keeps ROI rollup honest.';

COMMENT ON COLUMN public.attribution_events.conflict_with_legacy_source IS
  'Phase B. Captures the divergence when weddings.source (legacy display field) disagrees with the computed first-touch. Surfaces as a badge on lead detail + row in coordinator review queue. Neither side silently wins — coordinator decides.';

CREATE INDEX IF NOT EXISTS idx_attribution_events_wedding
  ON public.attribution_events (wedding_id, decided_at DESC)
  WHERE reverted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_attribution_events_first_touch
  ON public.attribution_events (venue_id, source_platform, decided_at DESC)
  WHERE is_first_touch = true AND reverted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_attribution_events_review_queue
  ON public.attribution_events (venue_id, decided_at DESC)
  WHERE conflict_with_legacy_source IS NOT NULL AND reverted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_attribution_events_candidate
  ON public.attribution_events (candidate_identity_id);

ALTER TABLE public.attribution_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "attribution_events_select" ON public.attribution_events;
CREATE POLICY "attribution_events_select" ON public.attribution_events
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

DROP POLICY IF EXISTS "attribution_events_update" ON public.attribution_events;
CREATE POLICY "attribution_events_update" ON public.attribution_events
  FOR UPDATE TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "demo_anon_select" ON public.attribution_events;
CREATE POLICY "demo_anon_select" ON public.attribution_events
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- ============================================================================
-- STEP 3 — tangential_signals.candidate_identity_id FK
-- ============================================================================
-- The signal-to-cluster join. NULL until the clusterer attaches the
-- signal (which happens immediately after Phase A insert via the
-- post-insert hook in PB.5). NULL is also valid for anonymous
-- signals (the ". " rows from Knot) — they live in tangential_signals
-- for ROI volume counts but never get a candidate.

ALTER TABLE public.tangential_signals
  ADD COLUMN IF NOT EXISTS candidate_identity_id uuid
    REFERENCES public.candidate_identities(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.tangential_signals.candidate_identity_id IS
  'Phase B. FK to the cluster this signal belongs to. NULL for anonymous signals (no parsed name) — they count for ROI volume but never resolve to a wedding. Set by the clusterer service post-insert.';

CREATE INDEX IF NOT EXISTS idx_tangential_signals_candidate
  ON public.tangential_signals (candidate_identity_id)
  WHERE candidate_identity_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
