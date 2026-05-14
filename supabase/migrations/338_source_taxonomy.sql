-- ---------------------------------------------------------------------------
-- 338_source_taxonomy.sql
-- ---------------------------------------------------------------------------
-- Anchor: Round 2 audit TIER 2e+2f (2026-05-14). The audit caught a
-- 110-conflict queue inflated by attributing HoneyBook / Calendly /
-- Acuity / Dubsado / Aisle Planner / Tave as origins. These aren't
-- origins — they're destinations (where the lead landed) or tools
-- (how it got routed). Forcing them through the conflict-with-legacy
-- queue requires manual review on something that was always going to
-- lose.
--
-- This migration adds the source taxonomy:
--
--   weddings.source_kind = 'origin'      The couple found us here
--                                         (knot, weddingwire, google, etc.)
--                        = 'destination'  This is a CRM / form tool that
--                                         RECEIVED the inquiry, not a
--                                         discovery source (honeybook,
--                                         calendly, dubsado, aisle_planner,
--                                         acuity, tave)
--                        = 'tool'         Automation / routing tool, not a
--                                         channel (zapier, ifttt, formstack)
--                        = 'unknown'      Source is null or unrecognized
--
-- Plus the conflict-resolution columns on attribution_events so the
-- auto-resolve service (Task 2e) can mark conflicts as auto-resolved
-- without losing the audit trail.
--
-- Agent-impact-pass adjustment (2026-05-14)
-- -----------------------------------------
-- brain/inquiry.ts:1101 reads wedding.source as a fallback when no
-- attribution-events-derived source exists. If we just NULL'd the
-- destination values, Sage's draft personalization would lose the
-- source reference entirely. Instead, when a wedding's source is a
-- 'destination' AND attribution_events has a wave-7B-classified
-- origin (is_first_touch=true), we MOVE the destination value to
-- source_detail and REPLACE source with the origin. Sage retains a
-- usable source string; the audit trail stays in source_detail.
--
-- Effect: any caller that reads weddings.source for display gets the
-- wave-7B truth. Any caller that needs to know "was this routed via
-- HoneyBook?" can read source_detail. lead-source-derivation already
-- supports this — it reads source_detail as an addendum.
-- ---------------------------------------------------------------------------


-- ============================================================================
-- STEP 1 — ADD COLUMNS
-- ============================================================================

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS source_kind text;

ALTER TABLE public.weddings
  ADD CONSTRAINT weddings_source_kind_check
  CHECK (
    source_kind IS NULL
    OR source_kind IN ('origin', 'destination', 'tool', 'unknown')
  );

COMMENT ON COLUMN public.weddings.source_kind IS
  'Taxonomy classification of weddings.source. origin = discovery channel; destination = CRM / form tool that received the inquiry; tool = automation routing layer; unknown = source is null or unrecognised. Set by mig 338 backfill + maintained going forward by classifySource() helper.';

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS conflict_resolution_state text;

ALTER TABLE public.attribution_events
  ADD CONSTRAINT attribution_events_resolution_check
  CHECK (
    conflict_resolution_state IS NULL
    OR conflict_resolution_state IN (
      'auto_resolved_destination',
      'auto_resolved_low_information',
      'auto_resolved_high_confidence',
      'manual_resolved'
    )
  );

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS conflict_resolved_at timestamptz;

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS conflict_resolved_by text;

COMMENT ON COLUMN public.attribution_events.conflict_resolution_state IS
  'Conflict-queue resolution outcome. NULL = open conflict, surfaces in /intel/candidates conflicts tab. auto_resolved_* = system rule auto-resolved (see lib/services/attribution/auto-resolve.ts). manual_resolved = coordinator explicitly resolved from the queue. Readers that count "open conflicts" filter `conflict_with_legacy_source IS NOT NULL AND conflict_resolution_state IS NULL`.';


-- ============================================================================
-- STEP 2 — BACKFILL weddings.source_kind
-- ============================================================================
-- Destination values: CRM platforms + scheduling tools that receive
-- the inquiry but don't generate discovery interest.

UPDATE public.weddings
SET source_kind = 'destination'
WHERE source_kind IS NULL
  AND LOWER(source) IN (
    'honeybook', 'calendly', 'acuity', 'dubsado', 'aisle_planner',
    'aisleplanner', 'tave', 'tave_studio', 'tavestudio'
  );

-- Tool values — automation / routing layers. Rare in real data but
-- future-proofs the schema.

UPDATE public.weddings
SET source_kind = 'tool'
WHERE source_kind IS NULL
  AND LOWER(source) IN ('zapier', 'ifttt', 'formstack', 'integromat', 'make');

-- Origin values — anything else with a non-null source.

UPDATE public.weddings
SET source_kind = 'origin'
WHERE source_kind IS NULL
  AND source IS NOT NULL;

UPDATE public.weddings
SET source_kind = 'unknown'
WHERE source_kind IS NULL;


-- ============================================================================
-- STEP 3 — REWRITE DESTINATION SOURCES (agent-impact-pass)
-- ============================================================================
-- For weddings whose source is a destination AND attribution_events
-- has a forensically-classified origin (is_first_touch=true,
-- bucket='attribution'): stash the destination in source_detail and
-- set source to the origin platform. Sage draft personalization
-- retains a usable source string.
--
-- We only do this when source_detail is currently NULL (don't
-- overwrite existing detail). Use the LIVE view so tombstoned
-- duplicates don't bias the pick.

WITH origin_picks AS (
  SELECT
    ae.wedding_id,
    ae.source_platform,
    ae.decided_at,
    ROW_NUMBER() OVER (
      PARTITION BY ae.wedding_id
      ORDER BY ae.decided_at ASC, ae.id ASC
    ) AS rn
  FROM public.attribution_events_live ae
  WHERE ae.is_first_touch = true
    AND ae.bucket = 'attribution'
    AND ae.source_platform IS NOT NULL
)
UPDATE public.weddings w
SET
  source_detail = COALESCE(w.source_detail, w.source),
  source = op.source_platform
FROM origin_picks op
WHERE w.id = op.wedding_id
  AND op.rn = 1
  AND w.source_kind = 'destination'
  AND op.source_platform IS NOT NULL
  AND op.source_platform <> w.source;

-- After Step 3 some weddings have a new origin source. Reclassify
-- them so source_kind catches up to the rewritten source.

UPDATE public.weddings
SET source_kind = 'origin'
WHERE source_kind = 'destination'
  AND LOWER(source) NOT IN (
    'honeybook', 'calendly', 'acuity', 'dubsado', 'aisle_planner',
    'aisleplanner', 'tave', 'tave_studio', 'tavestudio'
  );


-- ============================================================================
-- STEP 4 — Indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_weddings_source_kind
  ON public.weddings (venue_id, source_kind);

-- Open-conflict lookup helper. Conflict readers query
-- conflict_with_legacy_source IS NOT NULL AND conflict_resolution_state IS NULL.
CREATE INDEX IF NOT EXISTS idx_attribution_events_open_conflicts
  ON public.attribution_events (venue_id, decided_at DESC)
  WHERE conflict_with_legacy_source IS NOT NULL
    AND conflict_resolution_state IS NULL
    AND reverted_at IS NULL
    AND tombstoned_at IS NULL;


-- ============================================================================
-- STEP 5 — Update live view to filter resolved conflicts from "open" count
-- ============================================================================
-- attribution_events_live continues to expose all live rows. Callers
-- that count "open conflicts" must additionally filter
-- `conflict_resolution_state IS NULL`. We patch the briefings reader
-- in the same PR so the count drops as auto-resolve fires.

-- No change to the view itself; readers add the filter.


-- ============================================================================
-- STEP 6 — TIER 2d audit-trail column on candidate_identities
-- ============================================================================
-- When the resolver auto-dismisses a zero-match candidate (TIER 2d),
-- we soft-delete via deleted_at AND record WHY in deleted_reason so
-- the audit trail is intact for forensic queries.

ALTER TABLE public.candidate_identities
  ADD COLUMN IF NOT EXISTS deleted_reason text;

COMMENT ON COLUMN public.candidate_identities.deleted_reason IS
  'TIER 2d (2026-05-14). When deleted_at is set, this captures the reason. Values: "auto_dismissed_no_matches" (resolver found 0 weddings in tier_2 wide window), "operator_dismissed" (coordinator clicked dismiss), "merged_into_X" (merged into another candidate), "duplicate_of_X" (de-dup script). NULL for live candidates.';


-- ============================================================================
-- STEP 7 — TIER 2a venue config column for match-eligibility band
-- ============================================================================
-- The match-eligibility band defaults to 180d in the resolver. Venues
-- can override via venue_config.match_eligibility_band_days. The
-- helper falls back to default if the column is missing or NULL.

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS match_eligibility_band_days integer
  CHECK (match_eligibility_band_days IS NULL OR (match_eligibility_band_days >= 30 AND match_eligibility_band_days <= 730));

COMMENT ON COLUMN public.venue_config.match_eligibility_band_days IS
  'TIER 2a (2026-05-14). Venue-tunable maximum signal-to-wedding date distance for candidate resolution. NULL = use default 180d. Below 30d would gate out legitimate Calendly-routed inquiries; above 730d defeats the purpose. The candidate resolver and backtrack paths consult this via getMatchEligibilityBandDays().';
