-- Migration 152: brain-dump graduation pattern (T4-E / Playbook
-- Part 20.5).
--
-- Per Playbook 20.5: when the same brain-dump pattern is confirmed
-- 3+ times by the same coordinator, the system should prompt
-- "remember this rule?" — graduating the pattern from per-instance
-- propose-and-confirm to a learned standing rule. Pre-fix: every
-- brain-dump confirmation was independent; coordinators re-confirmed
-- the same shape forever, friction never decreased with use.
--
-- This migration:
--   1. brain_dump_pattern_grants — coordinator-confirmed standing
--      rules. e.g. "always file operational notes about AC outages
--      to knowledge_gaps without confirming". Pattern signature is
--      a hash of (intent + classifier-output shape); future entries
--      matching the signature can auto-route without the propose
--      step.
--   2. brain_dump_entries.pattern_signature — stable hash of the
--      parsed entry's shape. Used to count repeat confirmations and
--      to match against existing grants.
--
-- Idempotent.

ALTER TABLE public.brain_dump_entries
  ADD COLUMN IF NOT EXISTS pattern_signature text;

COMMENT ON COLUMN public.brain_dump_entries.pattern_signature IS
  'Stable FNV-1a hash of (intent + parser-output shape). Drives the '
  'graduation pattern — when the same signature is confirmed >= 3 '
  'times by the same coordinator, the UI prompts "remember this rule?". '
  'Per Playbook 20.5 / T4-E.';

CREATE INDEX IF NOT EXISTS idx_brain_dump_entries_signature
  ON public.brain_dump_entries (venue_id, pattern_signature, parse_status)
  WHERE pattern_signature IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.brain_dump_pattern_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Stable signature matching brain_dump_entries.pattern_signature.
  pattern_signature text NOT NULL,

  -- Human-readable explanation of what this grant covers. e.g.
  -- "operational notes about HVAC are auto-filed to knowledge_gaps".
  description text NOT NULL,

  -- Which intent / table / action this grant authorises.
  intent text NOT NULL,
  routed_table text,    -- nullable for non-routing rules
  routed_action text,   -- e.g. 'append_sage_context_note', 'insert'

  -- Coordinator who granted + when. revoked_at + revoked_by track
  -- audit if the grant is later revoked.
  granted_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  revoked_at timestamptz,

  -- Hit + last-used counters drive a "this rule is stale" suggestion
  -- in the audit log when a grant goes 60+ days unused.
  hit_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_brain_dump_grants_venue_signature
  ON public.brain_dump_pattern_grants (venue_id, pattern_signature)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_brain_dump_grants_venue_active
  ON public.brain_dump_pattern_grants (venue_id, revoked_at)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE public.brain_dump_pattern_grants IS
  'Standing rules granted by coordinator after 3+ confirmations of '
  'the same brain-dump pattern signature. Future entries with a '
  'matching signature route automatically without the propose-and-'
  'confirm round-trip. Revocable via /settings/brain-dump-log. '
  'Per Playbook Part 20.5 / T4-E.';

ALTER TABLE public.brain_dump_pattern_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bdpg_select" ON public.brain_dump_pattern_grants;
CREATE POLICY "bdpg_select" ON public.brain_dump_pattern_grants
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid() AND up.role IN ('org_admin', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "bdpg_service" ON public.brain_dump_pattern_grants;
CREATE POLICY "bdpg_service" ON public.brain_dump_pattern_grants
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.brain_dump_pattern_grants_touch()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_brain_dump_pattern_grants_touch
  ON public.brain_dump_pattern_grants;
CREATE TRIGGER trg_brain_dump_pattern_grants_touch
  BEFORE UPDATE ON public.brain_dump_pattern_grants
  FOR EACH ROW
  EXECUTE FUNCTION public.brain_dump_pattern_grants_touch();
