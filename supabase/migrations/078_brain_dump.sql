-- ---------------------------------------------------------------------------
-- 078_brain_dump.sql
-- ---------------------------------------------------------------------------
-- Phase 2.5 Task 25. brain_dump_entries table + sage_context_notes on
-- weddings for the "Tell Sage something" universal capture button.
--
-- Design notes (from the spec):
--   * ONE entry row per coordinator submission, regardless of how many
--     tables the AI ultimately routes it to. The routing targets live in
--     `routed_to` as a JSON array of {table, id, field, action}.
--   * `raw_input` holds the original text/voice-transcript. Image + PDF
--     + CSV payloads live in Supabase Storage (bucket: brain-dump) with
--     the path in raw_input; `input_type` disambiguates.
--   * Destructive actions (date-cancelled, status-overwrite) MUST take
--     the clarification path — we never auto-apply them. The parser
--     writes an admin_notifications row of type
--     'brain_dump_needs_clarification' and parks the entry in
--     parse_status='needs_clarification' until the coordinator answers.
--   * Venue-scoped via venue_id. RLS on the table so a coordinator at
--     Rixey can never see an entry submitted at Oakwood.
--
-- sage_context_notes on weddings is a small jsonb array the brains can
-- read before drafting. Each entry is {body, source, added_at}. Recency
-- ordering and decay is the brain's job — not the DB's.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.brain_dump_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  submitted_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  raw_input text NOT NULL,
  input_type text NOT NULL DEFAULT 'text'
    CHECK (input_type IN ('text', 'voice', 'image', 'pdf', 'csv', 'mixed')),
  parsed_at timestamptz,
  parse_status text NOT NULL DEFAULT 'pending'
    CHECK (parse_status IN ('pending', 'parsed', 'needs_clarification', 'confirmed', 'dismissed')),
  parse_result jsonb,
  clarification_question text,
  clarification_answer text,
  routed_to jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

COMMENT ON TABLE public.brain_dump_entries IS
  'owner:portal. One row per coordinator submission through the universal brain-dump button. Every row is venue-scoped. routed_to is an array of [{"table":"weddings","id":"...","field":"sage_context_notes","action":"append"}] recording every destination the AI parser wrote to.';

CREATE INDEX IF NOT EXISTS idx_brain_dump_entries_venue_status
  ON public.brain_dump_entries (venue_id, parse_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_brain_dump_entries_submitted_by
  ON public.brain_dump_entries (submitted_by, created_at DESC);

-- ---------------------------------------------------------------------------
-- RLS — coordinators see their venue's entries; super_admin sees all.
-- Mirrors the existing venue-scoped policies on admin_notifications.
-- ---------------------------------------------------------------------------

ALTER TABLE public.brain_dump_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS venue_scope_select ON public.brain_dump_entries;
CREATE POLICY venue_scope_select ON public.brain_dump_entries
  FOR SELECT TO authenticated
  USING (venue_id IN (
    SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
  ));

DROP POLICY IF EXISTS venue_scope_insert ON public.brain_dump_entries;
CREATE POLICY venue_scope_insert ON public.brain_dump_entries
  FOR INSERT TO authenticated
  WITH CHECK (venue_id IN (
    SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
  ));

DROP POLICY IF EXISTS venue_scope_update ON public.brain_dump_entries
  ;
CREATE POLICY venue_scope_update ON public.brain_dump_entries
  FOR UPDATE TO authenticated
  USING (venue_id IN (
    SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
  ))
  WITH CHECK (venue_id IN (
    SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
  ));

DROP POLICY IF EXISTS venue_scope_delete ON public.brain_dump_entries;
CREATE POLICY venue_scope_delete ON public.brain_dump_entries
  FOR DELETE TO authenticated
  USING (venue_id IN (
    SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
  ));

DROP POLICY IF EXISTS super_admin_all ON public.brain_dump_entries;
CREATE POLICY super_admin_all ON public.brain_dump_entries
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- Demo anon read (parallels migration 064's pattern for other tables).
DROP POLICY IF EXISTS demo_anon_select ON public.brain_dump_entries;
CREATE POLICY demo_anon_select ON public.brain_dump_entries
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- ---------------------------------------------------------------------------
-- weddings.sage_context_notes — where brain-dump routed client notes land.
-- Inquiry-brain + client-brain read these before drafting so the next
-- reply acknowledges the coordinator's observation.
--
-- Shape: [{"body":"Jamie is anxious about weather","source":"brain_dump","added_at":"2026-04-23T..."}]
-- The brains are responsible for filtering by age (default: last 14 days).
-- ---------------------------------------------------------------------------

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS sage_context_notes jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.weddings.sage_context_notes IS
  'Free-form coordinator observations that should inform Sage''s next draft for this couple. Appended by the brain-dump router when intent="client_note". Ordered newest-last. Each entry: {body, source, added_at}.';

CREATE INDEX IF NOT EXISTS idx_weddings_sage_context_notes
  ON public.weddings USING GIN (sage_context_notes);

NOTIFY pgrst, 'reload schema';
