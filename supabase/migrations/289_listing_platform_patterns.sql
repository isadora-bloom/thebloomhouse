-- ---------------------------------------------------------------------------
-- 289_listing_platform_patterns.sql
-- ---------------------------------------------------------------------------
-- Wave 23 — Generalize Wave 16's Knot-specific broadcast detector to
-- be platform-agnostic. Every wedding-listing platform with a "submit
-- inquiry to similar venues" feature has the same broadcast issue:
-- The Knot, WeddingWire, HereComesTheGuide (HCTG), Brides.com, Zola
-- Wedding, Junebug Weddings, Carats & Cake, Style Me Pretty. The
-- detector should match patterns from ANY of them without per-venue
-- tuning. Wave 16 hardcoded Knot/WW; Wave 23 extracts the platform
-- dimension and adds seeds for the rest.
--
-- Anchor docs:
--   - bloom-constitution.md (forensic identity reconstruction; doctrine
--     applies to broadcast-vs-targeted on every platform, not just Knot)
--   - feedback_deep_fix_vs_bandaid.md (Wave 16 was a layer fix grounded
--     in Rixey's Knot corpus; Wave 23 generalises the layer rather than
--     stacking per-venue overrides)
--   - bloom-may9-llm-vs-template.md (still deterministic — patterns
--     stay operator-curated per platform; LLM judge still only handles
--     the 40-59 ambiguity band)
--
-- What this migration does
-- ------------------------
-- 1. RENAME table knot_template_patterns → listing_platform_patterns.
--    Wave 16's seeded Knot rows are preserved.
-- 2. ADD column `platform text NOT NULL DEFAULT 'the_knot'` —
--    backfilled per existing row's `source` (seed_v1_weddingwire rows
--    get 'weddingwire', everything else 'the_knot'). DEFAULT dropped
--    after backfill so new rows MUST declare a platform.
-- 3. ADD column `platform_canonical text` — canonical-domain mapping
--    used by the TS-side inferPlatformFromInteraction (e.g.
--    'theknot.com' → 'the_knot'). Stored on the row so cross-table
--    joins / debugging can find the canonical bucket without a
--    separate registry.
-- 4. ADD CHECK constraint on `platform` enumerating the supported
--    listing-platform set. 'other' is the explicit escape hatch when a
--    coordinator pastes a pattern for a platform we haven't enumerated
--    yet — they can declare 'other' rather than mis-bucketing into a
--    nearby platform.
-- 5. ADD index on (platform, weight DESC) so the detector's per-
--    platform load is one B-tree seek + sequential.
-- 6. Seed entries for HCTG, Brides.com, Zola, Junebug, Carats & Cake,
--    Style Me Pretty. Each pattern has weight ~60 with `source =
--    'wave23_seed'` for audit. Where no real-world corpus exists for
--    Rixey today, we use plausible template language drawn from each
--    platform's public "submit to similar venues" UX.
--
-- Idempotent: rename guarded with `IF EXISTS`; column adds with
-- `IF NOT EXISTS`; check constraint dropped+recreated under a
-- DO/EXCEPTION wrapper; seed inserts use `ON CONFLICT DO NOTHING`.
--
-- NOTE: no BEGIN/COMMIT wrapper. The repo's exec_sql RPC executes the
-- migration body inside its own transaction and rejects nested
-- transaction commands ("EXECUTE of transaction commands is not
-- implemented" — observed during Wave 23 dev). All DDL/DML here is
-- still atomic via the RPC's outer transaction.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — Rename knot_template_patterns → listing_platform_patterns
-- ============================================================================
-- Wave 16 created knot_template_patterns. Wave 23 generalises the name
-- to reflect that the table holds patterns for ANY listing platform,
-- not just Knot. We rename rather than create-new-drop-old so the
-- existing 23 seeded Knot/WW rows are preserved verbatim (their
-- pattern_value strings + weights are still good for the_knot /
-- weddingwire platforms — Wave 23 isn't a re-seed of Knot, it's an
-- expansion to other platforms).
--
-- Rename is wrapped in a DO block so re-running the migration after a
-- prior apply is a no-op: if listing_platform_patterns already exists
-- (post-rename) we skip; if knot_template_patterns still exists
-- (pre-rename) we rename. If neither exists something is very wrong
-- and we let the error surface.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'knot_template_patterns'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'listing_platform_patterns'
  ) THEN
    ALTER TABLE public.knot_template_patterns
      RENAME TO listing_platform_patterns;
  END IF;
END $$;

-- Also rename the lookup index Wave 16 created so the canonical name
-- maps cleanly to the canonical table name. Skip silently if it was
-- already renamed in a prior apply.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_knot_template_patterns_lookup'
  ) THEN
    ALTER INDEX public.idx_knot_template_patterns_lookup
      RENAME TO idx_listing_platform_patterns_lookup;
  END IF;
END $$;

-- ============================================================================
-- STEP 2 — Add platform + platform_canonical columns
-- ============================================================================
-- DEFAULT 'the_knot' so the ADD COLUMN backfill is one statement; we
-- correct the WW rows in STEP 3 then drop the DEFAULT so new rows must
-- explicitly declare their platform.
ALTER TABLE public.listing_platform_patterns
  ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'the_knot';

COMMENT ON COLUMN public.listing_platform_patterns.platform IS
  'Wave 23 (mig 289). Which listing platform this pattern belongs to. '
  'Drives the detector''s per-platform load — patterns for the_knot are '
  'NEVER applied to a weddingwire inquiry and vice versa. Allowed '
  'values listed in the platform CHECK constraint. New listing-site '
  'integrations get a new enum value plus a new seed batch.';

ALTER TABLE public.listing_platform_patterns
  ADD COLUMN IF NOT EXISTS platform_canonical text;

COMMENT ON COLUMN public.listing_platform_patterns.platform_canonical IS
  'Wave 23 (mig 289). Canonical domain (e.g. theknot.com) the pattern '
  'is associated with. Used by inferPlatformFromInteraction in TS '
  'when an attribution_event has no source_platform but the inquiry '
  'from_email domain matches. Nullable: patterns added by coordinator '
  'paste may have no canonical domain.';

-- ============================================================================
-- STEP 3 — Backfill existing rows from their `source` label
-- ============================================================================
-- Wave 16's WeddingWire rows are tagged source='seed_v1_weddingwire'.
-- Everything else is some flavour of Knot — set those to 'the_knot'
-- (the DEFAULT already gave them that value; we re-run it for
-- explicitness in case the column already existed pre-default).
UPDATE public.listing_platform_patterns
   SET platform = 'weddingwire',
       platform_canonical = 'weddingwire.com'
 WHERE source = 'seed_v1_weddingwire';

UPDATE public.listing_platform_patterns
   SET platform = 'the_knot',
       platform_canonical = 'theknot.com'
 WHERE source IN ('seed_v1', 'seed_v1_rixey_corpus', 'seed_v1_knot_footer', 'seed_v1_generic_opener')
    OR source IS NULL;

-- Drop the DEFAULT now that existing rows are correctly backfilled.
-- New inserts MUST supply a platform — the seed block below does, and
-- coordinator-facing POSTs validate before insert.
ALTER TABLE public.listing_platform_patterns
  ALTER COLUMN platform DROP DEFAULT;

-- ============================================================================
-- STEP 4 — Platform CHECK constraint
-- ============================================================================
-- Enumerate the listing platforms we know about + the 'other' escape
-- hatch. Constraint is added under a DO block so a re-apply that
-- already created it is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'listing_platform_patterns_platform_check'
      AND conrelid = 'public.listing_platform_patterns'::regclass
  ) THEN
    ALTER TABLE public.listing_platform_patterns
      ADD CONSTRAINT listing_platform_patterns_platform_check
      CHECK (platform IN (
        'the_knot',
        'weddingwire',
        'hctg',
        'brides_com',
        'zola',
        'junebug',
        'carats_cake',
        'style_me_pretty',
        'other'
      ));
  END IF;
END $$;

-- ============================================================================
-- STEP 4b — Unique constraint for seed-idempotence
-- ============================================================================
-- Without a unique constraint, ON CONFLICT DO NOTHING on the seed
-- INSERT below is a no-op — re-running the migration would
-- duplicate every wave23 seed row. We need a unique constraint that
-- treats NULL venue_id values as equal (the seeds all use
-- venue_id=NULL), so we use a partial unique INDEX rather than the
-- column-level constraint which would let `(NULL, ...)` repeat.
--
-- Two partial indexes:
--   - venue-NULL tuple: (platform, pattern_type, pattern_value) when
--     venue_id IS NULL — the seed path
--   - venue-scoped tuple: (venue_id, platform, pattern_type,
--     pattern_value) when venue_id IS NOT NULL — coordinator paste
--
-- Operator paste collisions (same coordinator pasting the same
-- pattern twice) silently no-op rather than erroring; this is the
-- correct behaviour for an idempotent UI.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_listing_pattern_global
  ON public.listing_platform_patterns (platform, pattern_type, pattern_value)
  WHERE venue_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_listing_pattern_venue
  ON public.listing_platform_patterns (venue_id, platform, pattern_type, pattern_value)
  WHERE venue_id IS NOT NULL;

COMMENT ON INDEX public.uniq_listing_pattern_global IS
  'Wave 23 (mig 289). Idempotence guard for global (venue_id IS NULL) '
  'patterns. Re-running the seed insert is a no-op.';

COMMENT ON INDEX public.uniq_listing_pattern_venue IS
  'Wave 23 (mig 289). Idempotence guard for venue-scoped patterns. '
  'Coordinator paste of the same pattern twice silently no-ops.';

-- ============================================================================
-- STEP 5 — Per-platform lookup index
-- ============================================================================
-- The detector loads `WHERE platform = $1 AND enabled = true ORDER BY
-- weight DESC`. (platform, weight DESC) lets one B-tree seek answer
-- both the filter and the sort.
CREATE INDEX IF NOT EXISTS idx_listing_platform_patterns_by_platform
  ON public.listing_platform_patterns (platform, weight DESC);

COMMENT ON INDEX public.idx_listing_platform_patterns_by_platform IS
  'Wave 23 (mig 289). Per-platform detector load path — one seek '
  'returns enabled patterns for a single platform ordered by weight '
  'so the highest-value patterns evaluate first.';

-- ============================================================================
-- STEP 6 — Seed patterns for newly supported platforms
-- ============================================================================
-- Each platform gets a small batch of patterns drawn from the
-- platform's public "send inquiry to similar venues" UX. Weights sit
-- at ~60 (higher than Wave 16's mostly-30-40 weights) because the
-- per-platform load means each row already starts from a small pool
-- — we need fewer-but-stronger matches per platform to hit the 60
-- broadcast threshold.
--
-- Where Rixey's corpus has no evidence yet (HCTG, Brides.com, Zola,
-- Junebug, Carats & Cake, Style Me Pretty all sit at zero Rixey
-- attribution_events today), the patterns use plausible template
-- language pulled from each platform's documented submission flow.
-- These are starting points for the coordinator to refine once
-- multi-venue rollout brings real corpora.
INSERT INTO public.listing_platform_patterns
  (venue_id, platform, platform_canonical, pattern_type, pattern_value, weight, source, enabled)
VALUES
  -- HereComesTheGuide ("HCTG")
  (NULL, 'hctg', 'herecomestheguide.com', 'exact_phrase', 'I''m interested in your venue for my wedding', 60, 'wave23_seed', true),
  (NULL, 'hctg', 'herecomestheguide.com', 'exact_phrase', 'Could you send me your pricing and availability', 60, 'wave23_seed', true),
  (NULL, 'hctg', 'herecomestheguide.com', 'exact_phrase', 'found you on Here Comes The Guide', 55, 'wave23_seed', true),
  (NULL, 'hctg', 'herecomestheguide.com', 'exact_phrase', 'Please send me information about your venue', 50, 'wave23_seed', true),
  (NULL, 'hctg', 'herecomestheguide.com', 'exact_phrase', 'inquiring about availability and pricing', 50, 'wave23_seed', true),

  -- Brides.com
  (NULL, 'brides_com', 'brides.com', 'exact_phrase', 'I''m planning my wedding and would love to learn more about your venue', 60, 'wave23_seed', true),
  (NULL, 'brides_com', 'brides.com', 'exact_phrase', 'discovered your venue on Brides', 55, 'wave23_seed', true),
  (NULL, 'brides_com', 'brides.com', 'exact_phrase', 'would love to learn more about your offerings', 50, 'wave23_seed', true),
  (NULL, 'brides_com', 'brides.com', 'exact_phrase', 'Hi! I''m planning my wedding', 45, 'wave23_seed', true),

  -- Zola Wedding
  (NULL, 'zola', 'zola.com', 'exact_phrase', 'Reaching out from Zola', 60, 'wave23_seed', true),
  (NULL, 'zola', 'zola.com', 'exact_phrase', 'sent through Zola Wedding Venues', 55, 'wave23_seed', true),
  (NULL, 'zola', 'zola.com', 'exact_phrase', 'submitted via Zola', 50, 'wave23_seed', true),
  (NULL, 'zola', 'zola.com', 'exact_phrase', 'A couple is interested in your venue', 50, 'wave23_seed', true),

  -- Junebug Weddings
  (NULL, 'junebug', 'junebugweddings.com', 'exact_phrase', 'found your venue through Junebug Weddings', 60, 'wave23_seed', true),
  (NULL, 'junebug', 'junebugweddings.com', 'exact_phrase', 'submitting an inquiry through Junebug', 55, 'wave23_seed', true),
  (NULL, 'junebug', 'junebugweddings.com', 'exact_phrase', 'love your aesthetic and want to learn more', 45, 'wave23_seed', true),

  -- Carats & Cake
  (NULL, 'carats_cake', 'caratsandcake.com', 'exact_phrase', 'reaching out from Carats & Cake', 60, 'wave23_seed', true),
  (NULL, 'carats_cake', 'caratsandcake.com', 'exact_phrase', 'inquiring via Carats and Cake', 55, 'wave23_seed', true),
  (NULL, 'carats_cake', 'caratsandcake.com', 'exact_phrase', 'submitted through Carats & Cake', 50, 'wave23_seed', true),

  -- Style Me Pretty
  (NULL, 'style_me_pretty', 'stylemepretty.com', 'exact_phrase', 'found you on Style Me Pretty', 60, 'wave23_seed', true),
  (NULL, 'style_me_pretty', 'stylemepretty.com', 'exact_phrase', 'submitted via Style Me Pretty Vendor Guide', 55, 'wave23_seed', true),
  (NULL, 'style_me_pretty', 'stylemepretty.com', 'exact_phrase', 'inquiry from Style Me Pretty', 50, 'wave23_seed', true)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
