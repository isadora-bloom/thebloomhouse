-- ---------------------------------------------------------------------------
-- 317_wedding_evidence_projections.sql
-- ---------------------------------------------------------------------------
-- Extend the evidence-projection pattern (mig 255 name_evidence, mig 306
-- wedding_date_evidence) to three more weddings fields: source,
-- inquiry_date, guest_count_estimate.
--
-- Why this exists
-- ---------------
-- Today these three columns are scalar latest-wins values. Every signal
-- path can overwrite them:
--   - weddings.source: pipeline classifier, attribution backfill, Calendly
--     Q&A, operator UI, CRM import. The current value is "whichever wrote
--     most recently won." There's no audit of "Knot said Knot, the
--     calculator form said Instagram, the operator stamped Referral --
--     why did Referral win?"
--   - weddings.inquiry_date: minted at people-row creation, then bumped by
--     downstream logic. No record of conflicts ("Calendly says 4/3, first
--     interaction is 3/29 -- which is canonical?").
--   - weddings.guest_count_estimate: written by AI extraction from
--     inbound bodies, calculator form, brain-dump. Each path overwrites.
--
-- The Bloom Constitution treats every couple-level decision as forensic
-- evidence: append-only log + picked projection. Wave 4-8 already ported
-- this for names (mig 255) and wedding_date (mig 306). This migration
-- closes the gap for the next three high-leverage fields.
--
-- Shape (mirrors mig 306 wedding_date_evidence)
-- ---------------------------------------------
-- Every evidence entry:
--   {
--     "source": <enum text -- pipeline_classifier | calendly_form |
--                calculator | email_body | operator_override |
--                attribution_backfill | csv_import | brain_dump | etc.>,
--     "value": <typed value -- string for source, ISO date for
--                inquiry_date, integer for guest_count>,
--     "confidence": 0-100,
--     "captured_at": iso8601,
--     "interaction_id": uuid | null,
--     "actor_id": uuid | null
--   }
--
-- The scalar column (weddings.source / inquiry_date / guest_count_estimate)
-- becomes a *picked projection*: the picker function reads the evidence
-- log + the lock flag and returns the canonical value. Operator override
-- becomes "stamp a confidence-100 evidence row + flip the lock," not
-- "write to the scalar column."
--
-- Lock flag semantics
-- -------------------
-- <field>_locked_by_operator=true freezes the displayed projection. The
-- picker returns the most recent operator_override evidence row's value
-- regardless of fresher higher-confidence inferences. Auto-derive writers
-- may still APPEND to the evidence log (forensic record preserved) but
-- must not flip the lock or mutate the scalar.
--
-- Idempotent: every ADD COLUMN / CREATE INDEX uses IF NOT EXISTS.
-- No transaction wrapper -- exec_sql RPC rejects BEGIN/COMMIT (Wave 23).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 -- weddings.source_evidence + lock columns
-- ============================================================================

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS source_evidence jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS source_locked_by_operator boolean NOT NULL DEFAULT false;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS source_locked_at timestamptz;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS source_locked_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.weddings.source_evidence IS
  'Append-only log of every source claim ever observed for this wedding. '
  'Mirrors wedding_date_evidence shape (mig 306) and people.name_evidence '
  '(mig 255). Auto-derive writers (pipeline classifier, attribution '
  'backfill, Calendly form, brain-dump) APPEND on every signal; the '
  'weddings.source scalar is a *picked projection* computed by '
  'pickSource() in src/lib/services/identity/pick-from-evidence.ts. '
  'Coordinator overrides land here as source=''operator_override'' with '
  'confidence=100. Migration 317.';

COMMENT ON COLUMN public.weddings.source_locked_by_operator IS
  'When true, the picker returns the most recent operator_override '
  'evidence row''s value and ignores fresher higher-confidence inferences. '
  'Auto-derive paths may still APPEND to source_evidence (forensic record '
  'preserved) but must not flip this lock or mutate weddings.source. '
  'Cleared by explicit operator action. Sticky-state Pattern 1.';

COMMENT ON COLUMN public.weddings.source_locked_at IS
  'Timestamp the operator lock was last set. NULL when never locked. '
  'Used by the coordinator UI to display "locked by Jane 3 days ago" '
  'on the source row. Migration 317.';

COMMENT ON COLUMN public.weddings.source_locked_by IS
  'user_profiles.id of the operator who last set source_locked_by_operator. '
  'NULL when never locked or when the locking user was deleted. '
  'Migration 317.';

-- ============================================================================
-- STEP 2 -- weddings.inquiry_date_evidence + lock columns
-- ============================================================================

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS inquiry_date_evidence jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS inquiry_date_locked_by_operator boolean NOT NULL DEFAULT false;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS inquiry_date_locked_at timestamptz;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS inquiry_date_locked_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.weddings.inquiry_date_evidence IS
  'Append-only log of every inquiry-date claim observed. Each entry: '
  '{source, value:iso8601, confidence:0-100, captured_at, interaction_id?, '
  'actor_id?}. Sources include first_interaction_timestamp, '
  'calendly_form_submission, csv_import_field, operator_override. The '
  'weddings.inquiry_date scalar is the picked projection computed by '
  'pickInquiryDate(). Coordinator overrides land here with confidence=100 '
  'and source=''operator_override''. Migration 317.';

COMMENT ON COLUMN public.weddings.inquiry_date_locked_by_operator IS
  'When true, picker returns the most recent operator_override evidence '
  'row''s value. Auto-derive may still APPEND to inquiry_date_evidence '
  'but must not flip the lock or mutate weddings.inquiry_date. '
  'Sticky-state Pattern 1.';

COMMENT ON COLUMN public.weddings.inquiry_date_locked_at IS
  'Timestamp the operator lock was last set. NULL when never locked. '
  'Migration 317.';

COMMENT ON COLUMN public.weddings.inquiry_date_locked_by IS
  'user_profiles.id of the operator who last locked inquiry_date. '
  'Migration 317.';

-- ============================================================================
-- STEP 3 -- weddings.guest_count_evidence + lock columns
-- ============================================================================
-- Note: scalar column is weddings.guest_count_estimate (integer). The
-- evidence column is named guest_count_evidence (drops the _estimate
-- suffix because by the time we have a picked projection, the value is
-- the canonical count, not an estimate).

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS guest_count_evidence jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS guest_count_locked_by_operator boolean NOT NULL DEFAULT false;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS guest_count_locked_at timestamptz;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS guest_count_locked_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.weddings.guest_count_evidence IS
  'Append-only log of every guest-count claim observed. Each entry: '
  '{source, value:integer, confidence:0-100, captured_at, interaction_id?, '
  'actor_id?}. Sources: calculator_form (confidence ~95), ai_email_extract '
  '(confidence ~70), brain_dump (confidence ~80), operator_override '
  '(confidence 100). The weddings.guest_count_estimate scalar is the '
  'picked projection computed by pickGuestCount(). Counts outside the '
  'sane band (1..1000) are still appended for audit but ignored by the '
  'picker. Migration 317.';

COMMENT ON COLUMN public.weddings.guest_count_locked_by_operator IS
  'When true, picker returns the most recent operator_override evidence '
  'row''s value. Auto-derive may still APPEND to guest_count_evidence but '
  'must not flip the lock or mutate weddings.guest_count_estimate. '
  'Sticky-state Pattern 1.';

COMMENT ON COLUMN public.weddings.guest_count_locked_at IS
  'Timestamp the operator lock was last set. NULL when never locked. '
  'Migration 317.';

COMMENT ON COLUMN public.weddings.guest_count_locked_by IS
  'user_profiles.id of the operator who last locked guest_count. '
  'Migration 317.';

-- ============================================================================
-- STEP 4 -- Partial indexes on the lock columns (rare-true)
-- ============================================================================
-- The locks are rare-true. Partial indexes make "find all locked weddings"
-- instant without bloating the main lookup indexes. Mirrors the mig 306
-- partial-index style.

CREATE INDEX IF NOT EXISTS idx_weddings_source_locked
  ON public.weddings (venue_id)
  WHERE source_locked_by_operator = true;

CREATE INDEX IF NOT EXISTS idx_weddings_inquiry_date_locked
  ON public.weddings (venue_id)
  WHERE inquiry_date_locked_by_operator = true;

CREATE INDEX IF NOT EXISTS idx_weddings_guest_count_locked
  ON public.weddings (venue_id)
  WHERE guest_count_locked_by_operator = true;

-- ============================================================================
-- STEP 5 -- Backfill source_evidence from current weddings.source
-- ============================================================================
-- Each wedding with a non-null source gets one evidence row recording the
-- historical value with source='backfill_pre_evidence' and confidence=50.
-- captured_at uses inquiry_date as the best proxy for "when did this
-- source first land" (falls back to created_at when inquiry_date is null).
-- Idempotent via the empty-array WHERE guard.

UPDATE public.weddings w
SET source_evidence = jsonb_build_array(
  jsonb_build_object(
    'source', 'backfill_pre_evidence',
    'value', w.source::text,
    'confidence', 50,
    'captured_at', COALESCE(w.inquiry_date, w.created_at),
    'interaction_id', null,
    'actor_id', null
  )
)
WHERE w.source IS NOT NULL
  AND (w.source_evidence IS NULL OR w.source_evidence = '[]'::jsonb);

-- ============================================================================
-- STEP 6 -- Backfill inquiry_date_evidence from current weddings.inquiry_date
-- ============================================================================

UPDATE public.weddings w
SET inquiry_date_evidence = jsonb_build_array(
  jsonb_build_object(
    'source', 'backfill_pre_evidence',
    'value', to_char(w.inquiry_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'confidence', 50,
    'captured_at', COALESCE(w.inquiry_date, w.created_at),
    'interaction_id', null,
    'actor_id', null
  )
)
WHERE w.inquiry_date IS NOT NULL
  AND (w.inquiry_date_evidence IS NULL OR w.inquiry_date_evidence = '[]'::jsonb);

-- ============================================================================
-- STEP 7 -- Backfill guest_count_evidence from current weddings.guest_count_estimate
-- ============================================================================

UPDATE public.weddings w
SET guest_count_evidence = jsonb_build_array(
  jsonb_build_object(
    'source', 'backfill_pre_evidence',
    'value', w.guest_count_estimate,
    'confidence', 50,
    'captured_at', COALESCE(w.inquiry_date, w.created_at),
    'interaction_id', null,
    'actor_id', null
  )
)
WHERE w.guest_count_estimate IS NOT NULL
  AND (w.guest_count_evidence IS NULL OR w.guest_count_evidence = '[]'::jsonb);

NOTIFY pgrst, 'reload schema';
