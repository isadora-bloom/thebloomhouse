-- ============================================================================
-- Migration 059: Per-venue Sage identity fields
-- ============================================================================
--
-- Adds the knobs venues can turn without weakening AI disclosure:
--   - ai_role              : dropdown of "AI <noun>" labels. CHECK-constrained
--                            so a venue can't pick something like "coordinator"
--                            that drops the AI word. "AI" must stay in the label.
--   - ai_purposes          : the mad-libs completions for "I'm here to make
--                            sure you get ___". Multi-select. Stored as text[].
--   - ai_custom_purpose    : one free-text purpose slot for anything the
--                            pre-written options don't cover.
--   - ai_opener_shape      : structural shape for first-touch openers
--                            (direct / warm-story / question-first / practical).
--                            Used by the opener prompt so different venues
--                            produce structurally different first messages.
--
-- ai_name already exists on venue_ai_config (installed by 001). We reuse it.
--
-- The hard identity rule (must confirm AI when asked) lives in
-- src/config/prompts/universal-rules.ts and CANNOT be overridden by any of
-- these columns. These columns shape tone and structure, not disclosure.
-- ============================================================================

ALTER TABLE public.venue_ai_config
  ADD COLUMN IF NOT EXISTS ai_role            text   NOT NULL DEFAULT 'AI concierge',
  ADD COLUMN IF NOT EXISTS ai_purposes        text[] NOT NULL DEFAULT ARRAY[
    'quick answers about the venue',
    'an easy way to book a tour'
  ]::text[],
  ADD COLUMN IF NOT EXISTS ai_custom_purpose  text,
  ADD COLUMN IF NOT EXISTS ai_opener_shape    text   NOT NULL DEFAULT 'warm-story';

-- ── CHECK constraints ────────────────────────────────────────────────────────
-- ai_role: every allowed value contains "AI" so the disclosure is baked into
-- the label itself. Extending this list in a future migration is fine;
-- removing "AI" from any entry is not.
ALTER TABLE public.venue_ai_config
  DROP CONSTRAINT IF EXISTS venue_ai_config_ai_role_check;
ALTER TABLE public.venue_ai_config
  ADD CONSTRAINT venue_ai_config_ai_role_check
  CHECK (ai_role IN (
    'AI assistant',
    'AI concierge',
    'AI wedding helper',
    'AI coordinator',
    'AI guide'
  ));

ALTER TABLE public.venue_ai_config
  DROP CONSTRAINT IF EXISTS venue_ai_config_ai_opener_shape_check;
ALTER TABLE public.venue_ai_config
  ADD CONSTRAINT venue_ai_config_ai_opener_shape_check
  CHECK (ai_opener_shape IN ('direct', 'warm-story', 'question-first', 'practical'));

-- ai_purposes: require at least one entry so generated intros don't come out
-- as "I'm here to make sure you get .". Max 4 to keep the opener under
-- sentence-length control.
ALTER TABLE public.venue_ai_config
  DROP CONSTRAINT IF EXISTS venue_ai_config_ai_purposes_length_check;
ALTER TABLE public.venue_ai_config
  ADD CONSTRAINT venue_ai_config_ai_purposes_length_check
  CHECK (array_length(ai_purposes, 1) BETWEEN 1 AND 4);

NOTIFY pgrst, 'reload schema';
