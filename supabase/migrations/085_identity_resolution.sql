-- ---------------------------------------------------------------------------
-- 085_identity_resolution.sql
-- ---------------------------------------------------------------------------
-- Phase 8: cross-channel identity resolution.
--
-- The client_match_queue table (migration 009) was built but never populated.
-- Its column names (client_a_id / client_b_id) diverged from the UI
-- (/intel/matching reads person_a_id / person_b_id) so the merge page was
-- broken at render time. This migration reconciles the schema, adds FK
-- constraints so orphan IDs can't land in the queue, adds a signals jsonb
-- column so we can explain WHY Bloom suggested a match, and adds the new
-- tables the Phase 8 brief requires: tangential_signals, person_merges,
-- and per-venue identity_match_config.
--
-- Design choices:
-- - tangential_signals lives as its own table instead of a flag on
--   engagement_events because the lifecycle is different: a signal has an
--   extracted_identity (name, handle, email fragment) and a match_status
--   that can promote over time. engagement_events are low-level fire-and-
--   forget rows.
-- - person_merges captures a full audit trail so merges are reversible.
--   Reversal doesn't restore the merged person's primary key (cascaded
--   deletes on people would have wiped references); it re-creates the
--   merged row with identical columns + re-points child records using the
--   snapshot in person_merges.snapshot jsonb.
-- - external_ids jsonb on people is intentionally loose — any channel can
--   add a key (instagram, the_knot, zola, pinterest, tiktok, website). The
--   matching engine treats external_ids as additional identity signals
--   alongside email/phone/name.
-- - Per-venue match_config lets Rixey run a tighter window than Oakwood if
--   Rixey has higher identity overlap (same local community).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — Reconcile client_match_queue column names with the UI
-- ============================================================================

-- Rename columns. The table has 0 rows today so data migration is trivial.
ALTER TABLE public.client_match_queue RENAME COLUMN client_a_id TO person_a_id;
ALTER TABLE public.client_match_queue RENAME COLUMN client_b_id TO person_b_id;

-- Add FK constraints so orphan IDs can't land in the queue.
ALTER TABLE public.client_match_queue
  ADD CONSTRAINT client_match_queue_person_a_fk
    FOREIGN KEY (person_a_id) REFERENCES public.people(id) ON DELETE CASCADE;
ALTER TABLE public.client_match_queue
  ADD CONSTRAINT client_match_queue_person_b_fk
    FOREIGN KEY (person_b_id) REFERENCES public.people(id) ON DELETE CASCADE;

-- Add a signals jsonb column so we can explain WHY each pair landed in the
-- queue (same_email, name_plus_partner_window, username_pattern, etc).
-- Shape: [{type: 'name_plus_partner_window', detail: 'Sarah + Kevin within 3 days', weight: 0.75}, ...]
ALTER TABLE public.client_match_queue
  ADD COLUMN IF NOT EXISTS signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'medium'
    CHECK (tier IN ('high', 'medium', 'low'));

COMMENT ON COLUMN public.client_match_queue.signals IS
  'Phase 8. Array of {type, detail, weight} objects recording which matching rules fired. Used by the UI to render "why we think these are the same person" and by auto-promotion to decide if a low_confidence row has accumulated enough signal to promote.';
COMMENT ON COLUMN public.client_match_queue.tier IS
  'Phase 8. high = auto-merge, medium = suggest to coordinator, low = loose connection recorded only. Rows at tier=low are also written to the queue for durable storage + promotion history; they just don''t surface in the main merge UI.';

CREATE INDEX IF NOT EXISTS idx_client_match_queue_tier
  ON public.client_match_queue (venue_id, tier, status)
  WHERE status IN ('pending', 'snoozed');

-- ============================================================================
-- STEP 2 — tangential_signals table
-- ============================================================================
-- Holds extracted identities from Instagram screenshots, review screenshots,
-- Knot profile-view analytics, etc. that don't match any existing person
-- YET. New inquiries are checked against this pool so when "Sarah H" on The
-- Knot finally writes in, Bloom sees she liked the venue on Instagram 3
-- weeks ago.

CREATE TABLE IF NOT EXISTS public.tangential_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- What kind of signal this is. Free-but-bounded: add new types by adding
  -- to the CHECK. Keeps misclassification loud.
  signal_type text NOT NULL CHECK (signal_type IN (
    'instagram_engagement',
    'instagram_follow',
    'website_visit',
    'review',
    'mention',
    'analytics_entry',
    'referral',
    'other'
  )),

  -- Shape: { name?: string, first_name?: string, last_name?: string,
  --         username?: string, handle?: string, email_fragment?: string,
  --         phone_fragment?: string, location?: string, partner_name?: string }
  -- All optional. Matching engine scores based on which subset is present.
  extracted_identity jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- What the signal was about (which Instagram post, which review text,
  -- which page URL). Free text for display.
  source_context text,

  -- When the signal happened in the real world (Instagram post date, review
  -- date). Distinct from created_at, which is when Bloom learned about it.
  signal_date timestamptz,

  match_status text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN (
    'unmatched', 'low_confidence_match', 'suggested_match', 'confirmed_match', 'dismissed'
  )),
  matched_person_id uuid REFERENCES public.people(id) ON DELETE SET NULL,
  confidence_score decimal CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)),

  -- Reference to the brain_dump_entry that created this signal (audit trail).
  source_entry_id uuid,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tangential_signals_venue_status
  ON public.tangential_signals (venue_id, match_status);
CREATE INDEX IF NOT EXISTS idx_tangential_signals_person
  ON public.tangential_signals (matched_person_id)
  WHERE matched_person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tangential_signals_date
  ON public.tangential_signals (venue_id, signal_date DESC);

COMMENT ON TABLE public.tangential_signals IS
  'owner:agent. Extracted identity signals from platform screenshots / CSVs / brain-dump that have not yet been matched to a client. The matching engine checks every new inbound inquiry against this pool — a "Sarah H" inquiry can then be linked to a "Sarah Highland" Instagram signal from 3 weeks earlier.';

-- RLS: mirrors venue_health_history pattern (authenticated org-scoped, demo anon).
ALTER TABLE public.tangential_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tangential_signals_select" ON public.tangential_signals;
CREATE POLICY "tangential_signals_select" ON public.tangential_signals
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

DROP POLICY IF EXISTS "tangential_signals_update" ON public.tangential_signals;
CREATE POLICY "tangential_signals_update" ON public.tangential_signals
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

DROP POLICY IF EXISTS "demo_anon_select" ON public.tangential_signals;
CREATE POLICY "demo_anon_select" ON public.tangential_signals
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- updated_at touch trigger
CREATE OR REPLACE FUNCTION public.tangential_signals_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tangential_signals_updated_at ON public.tangential_signals;
CREATE TRIGGER trg_tangential_signals_updated_at
  BEFORE UPDATE ON public.tangential_signals
  FOR EACH ROW
  EXECUTE FUNCTION public.tangential_signals_touch_updated_at();

-- ============================================================================
-- STEP 3 — person_merges audit + undo table
-- ============================================================================
-- Every auto-merge and every confirmed suggest-merge writes a row here. The
-- snapshot jsonb captures the entire merged_person before it was merged so
-- undo can re-create the row. kept_person_id is the surviving row id.

CREATE TABLE IF NOT EXISTS public.person_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  kept_person_id uuid REFERENCES public.people(id) ON DELETE SET NULL,
  merged_person_id uuid, -- may be null after undo (person was recreated with new id)
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  tier text NOT NULL CHECK (tier IN ('high', 'medium', 'low')),
  confidence_score decimal,
  -- Full snapshot of merged_person + its children before merge, for undo.
  -- Shape: {
  --   person: {...full people row...},
  --   weddings: [...wedding rows reassigned...],
  --   interactions_count: int,
  --   drafts_count: int,
  --   engagement_events_count: int
  -- }
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  merged_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  merged_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  undone_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_person_merges_venue
  ON public.person_merges (venue_id, merged_at DESC);
CREATE INDEX IF NOT EXISTS idx_person_merges_kept
  ON public.person_merges (kept_person_id)
  WHERE kept_person_id IS NOT NULL;

COMMENT ON TABLE public.person_merges IS
  'owner:agent. Audit + undo ledger for person merges. Every auto-merge and confirmed suggest-merge writes one row. The snapshot jsonb holds the entire merged_person row and a summary of its children so undo can reconstruct state.';

ALTER TABLE public.person_merges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "person_merges_select" ON public.person_merges;
CREATE POLICY "person_merges_select" ON public.person_merges
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

DROP POLICY IF EXISTS "demo_anon_select" ON public.person_merges;
CREATE POLICY "demo_anon_select" ON public.person_merges
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- ============================================================================
-- STEP 4 — people.external_ids jsonb
-- ============================================================================
-- Lets the matching engine store Instagram handle, Knot username, Zola ID
-- etc. on a person without another table. Shape:
--   { instagram: 'sarahhighland', the_knot: 'sarah.h.123', zola: '...' }
-- Matching treats these as additional identity signals alongside email/phone.

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS external_ids jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.people.external_ids IS
  'Phase 8. Per-platform identifiers for cross-channel matching: {instagram, the_knot, zola, wedding_wire, pinterest, tiktok, website}. Matching engine scores against these alongside email/phone.';

-- Partial GIN index for fast membership lookups ('does any person have
-- instagram handle X?').
CREATE INDEX IF NOT EXISTS idx_people_external_ids
  ON public.people USING GIN (external_ids)
  WHERE external_ids != '{}'::jsonb;

-- ============================================================================
-- STEP 5 — venue_config.identity_match_config jsonb
-- ============================================================================
-- Per-venue configuration for match windows and confidence thresholds.
-- Shape: {
--   windows: { name_plus_partner_days: 30, name_last_initial_days: 14, ... },
--   auto_merge_enabled: true,
--   fuzzy_name_enabled: false
-- }
-- The Phase 8 matching engine reads this on every evaluation. Defaults live
-- in code; this column lets coordinators override without a deploy.

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS identity_match_config jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.venue_config.identity_match_config IS
  'Phase 8. Per-venue overrides for identity matching: windows, confidence thresholds, auto_merge_enabled flag. Defaults live in src/lib/services/identity-resolution.ts.';

-- ============================================================================
-- STEP 6 — people (venue_id, lower(email)) helper index
-- ============================================================================
-- Not a unique constraint: the demo Crestwood venues seed intentional
-- duplicate emails for test diversity, and at least one real venue could
-- legitimately have duplicates created before this migration. We still
-- want fast lookup for "does a person with this email already exist for
-- this venue" so findOrCreateContact becomes an upsert-style path. The
-- uniqueness guarantee is enforced at the app layer in the Phase 8
-- identity-resolution service (which upserts + dedupes at matching time).

CREATE INDEX IF NOT EXISTS idx_people_venue_email_lower
  ON public.people (venue_id, LOWER(email))
  WHERE email IS NOT NULL AND email != '';

NOTIFY pgrst, 'reload schema';
