-- ---------------------------------------------------------------------------
-- 336_pattern_a_uniqueness.sql
-- ---------------------------------------------------------------------------
-- Pattern A foundation. Anchor: Round 2 audit + agent-side impact pass
-- (2026-05-14). The audit observed Zachary Gragan with 9 duplicate
-- attribution_events and Eleanor Pittinger / Anthony Fontana with
-- reasoning-to-record drift. Root cause: write-write race across four
-- attribution_events writers and two wedding_touchpoints writers with
-- no DB-level uniqueness guard.
--
-- The race window
-- ---------------
-- triggerIdentityCascade() and resolveVenueCandidates() can both fire
-- on the same candidate_identity within milliseconds (brain-dump import
-- + nightly sweep + Calendly webhook + email pipeline all trigger).
-- The resolver fetches the candidate, decides it's unresolved, builds
-- the full signal-row set, and calls .insert(rows). If two threads do
-- this concurrently each writes the full set => N signals × M races
-- duplicate rows.
--
-- The same race lives in identity/backtrack.ts:548 (signal-first path)
-- and :1110 (cluster-attach path), plus the operator confirm path at
-- api/intel/candidates/link/route.ts:141. All four insert into
-- attribution_events with no ON CONFLICT.
--
-- wedding_touchpoints has the same class at backtrack.ts:602 + :1164.
-- Today the writer does an existence check via
-- `metadata @> {"signal_id": ...}` then inserts — race window between
-- check and insert. Sage's draft personalization reads touchpoints via
-- brain/inquiry.ts and reports inflated counts.
--
-- This migration is the foundation. It does everything needed for the
-- writer-conversion PR (Task #30) to land safely. Order matters:
--
--   1. Add columns (tombstoned_at, signal_id, narrative_cache_busted_at)
--   2. Backfill wedding_touchpoints.signal_id from metadata
--   3. Dedup wedding_touchpoints (tombstone duplicate signal_ids in metadata)
--   4. Dedup attribution_events (tombstone duplicate rows, keep earliest)
--   5. Mark affected weddings' narrative_cache_busted_at so Sage's
--      journey narrative regenerates instead of returning the inflated
--      cached prose
--   6. Create the partial unique indexes (now safe — no duplicates left)
--
-- The TIER 0c dedup-attribution-events script does the BIG version
-- (cross-venue reporting, audit ledger, per-wedding before/after
-- counts). This migration does the MIN version inline so the index
-- creation in step 6 doesn't fail.
--
-- Why not BEGIN/COMMIT
-- --------------------
-- exec_sql RPC silently rejects transaction wrappers (per repo
-- doctrine). Every statement runs independently. CREATE INDEX
-- CONCURRENTLY is not used because exec_sql also rejects that.
-- Tradeoff: brief table lock during index build. Tables are small
-- enough (attribution_events ~few-K rows per venue) that this is
-- acceptable.
-- ---------------------------------------------------------------------------


-- ============================================================================
-- STEP 1 — ADD COLUMNS
-- ============================================================================

-- 1a. attribution_events.tombstoned_at — soft-delete marker, distinct
-- from reverted_at. reverted = operator unwound; tombstoned = was a
-- duplicate of an earlier row.
ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS tombstoned_at timestamptz;

COMMENT ON COLUMN public.attribution_events.tombstoned_at IS
  'Soft-tombstone marker for Pattern A dedup. Distinct from reverted_at (operator-unwound). Readers must filter `tombstoned_at IS NULL AND reverted_at IS NULL` for live attributions.';

-- 1b. wedding_touchpoints.signal_id — promotes the metadata key to a
-- real column so the partial unique index can reference it.
ALTER TABLE public.wedding_touchpoints
  ADD COLUMN IF NOT EXISTS signal_id uuid;

COMMENT ON COLUMN public.wedding_touchpoints.signal_id IS
  'Denormalized from metadata.signal_id when this touchpoint came from a tangential_signal. NULL for inquiry/email_reply/calendly_booked touchpoints. Backfilled in mig 336 + populated by writers going forward.';

-- 1c. weddings.narrative_cache_busted_at — explicit invalidation
-- signal for Sage's journey-narrative cache. journey-narrative.ts
-- compares cache_generated_at against this and regenerates if
-- cache predates the bust.
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS narrative_cache_busted_at timestamptz;

COMMENT ON COLUMN public.weddings.narrative_cache_busted_at IS
  'Sage journey narrative invalidation marker. Set by mass mutations that change attribution truth (Pattern A dedup, mergeWeddings, wave-7B reclassification). Catches DECREASES in attribution count that the count-drift check at journey-narrative.ts cannot detect.';


-- ============================================================================
-- STEP 2 — BACKFILL wedding_touchpoints.signal_id FROM metadata
-- ============================================================================
-- Idempotent. UUID regex guards against malformed metadata.

UPDATE public.wedding_touchpoints
SET signal_id = (metadata->>'signal_id')::uuid
WHERE signal_id IS NULL
  AND metadata ? 'signal_id'
  AND (metadata->>'signal_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';


-- ============================================================================
-- STEP 3 — DEDUP wedding_touchpoints (tombstone duplicate signal_ids)
-- ============================================================================
-- If backfill surfaced duplicate (wedding_id, signal_id) tuples,
-- keep the earliest by occurred_at + created_at and tombstone the
-- rest into metadata.tombstoned_at_336. Soft-delete only: we NULL
-- the signal_id so the unique index won't conflict but the row
-- stays for audit.

WITH ranked AS (
  SELECT
    id,
    wedding_id,
    signal_id,
    ROW_NUMBER() OVER (
      PARTITION BY wedding_id, signal_id
      ORDER BY occurred_at ASC, created_at ASC, id ASC
    ) AS rn
  FROM public.wedding_touchpoints
  WHERE signal_id IS NOT NULL
)
UPDATE public.wedding_touchpoints wt
SET
  signal_id = NULL,
  metadata = wt.metadata
    || jsonb_build_object(
      'tombstoned_at_336', now()::text,
      'tombstoned_reason', 'pattern_a_dedup',
      'original_signal_id', wt.signal_id::text
    )
FROM ranked
WHERE wt.id = ranked.id
  AND ranked.rn > 1;


-- ============================================================================
-- STEP 4 — DEDUP attribution_events (tombstone duplicate rows)
-- ============================================================================
-- Keep the earliest by decided_at + created_at + id per
-- (candidate_identity_id, wedding_id, signal_id). The earliest row's
-- reasoning, tier, decided_by, etc. are canonical. Tombstone losers
-- with tombstoned_at = now().
--
-- Why ROW_NUMBER over (decided_at, created_at, id): the resolver
-- writes decided_at = now() on each call, but a race could produce
-- two rows with identical decided_at down to microsecond resolution.
-- The id (uuid v4) breaks ties deterministically.
--
-- Reverted rows are already excluded from the partial index, so we
-- don't need to tombstone them.

WITH ranked_attr AS (
  SELECT
    id,
    candidate_identity_id,
    wedding_id,
    signal_id,
    ROW_NUMBER() OVER (
      PARTITION BY candidate_identity_id, wedding_id, signal_id
      ORDER BY decided_at ASC, created_at ASC, id ASC
    ) AS rn
  FROM public.attribution_events
  WHERE signal_id IS NOT NULL
    AND reverted_at IS NULL
    AND tombstoned_at IS NULL
)
UPDATE public.attribution_events ae
SET tombstoned_at = now()
FROM ranked_attr
WHERE ae.id = ranked_attr.id
  AND ranked_attr.rn > 1;


-- ============================================================================
-- STEP 5 — MARK AFFECTED WEDDINGS' NARRATIVE CACHE STALE
-- ============================================================================
-- Every wedding that had ≥1 attribution_event tombstoned by step 4 OR
-- ≥1 wedding_touchpoint tombstoned by step 3 needs Sage's journey
-- narrative to regenerate.

UPDATE public.weddings w
SET narrative_cache_busted_at = now()
WHERE w.id IN (
  SELECT DISTINCT wedding_id FROM public.attribution_events
  WHERE tombstoned_at IS NOT NULL
    AND tombstoned_at >= now() - interval '5 minutes'
)
OR w.id IN (
  SELECT DISTINCT wedding_id FROM public.wedding_touchpoints
  WHERE metadata->>'tombstoned_at_336' IS NOT NULL
);


-- ============================================================================
-- STEP 6 — UNIQUE INDEXES (now safe — duplicates handled)
-- ============================================================================

-- Live-attribution lookup helper for readers. Filters reverted +
-- tombstoned in one shot.
CREATE INDEX IF NOT EXISTS idx_attribution_events_live
  ON public.attribution_events (venue_id, wedding_id)
  WHERE reverted_at IS NULL AND tombstoned_at IS NULL;

-- THE Pattern A index. Partial: reverted and tombstoned rows are
-- excluded so the audit trail stays queryable but no new duplicate
-- can land.
CREATE UNIQUE INDEX IF NOT EXISTS uq_attribution_events_live_signal
  ON public.attribution_events (candidate_identity_id, wedding_id, signal_id)
  WHERE reverted_at IS NULL AND tombstoned_at IS NULL AND signal_id IS NOT NULL;

-- Same for touchpoints.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wedding_touchpoints_live_signal
  ON public.wedding_touchpoints (wedding_id, signal_id)
  WHERE signal_id IS NOT NULL;

-- Index for the narrative-cache-busted lookup. journey-narrative.ts
-- compares per-wedding so a B-tree on wedding_id is fine; this index
-- helps mass jobs that scan for "what needs to be regenerated".
CREATE INDEX IF NOT EXISTS idx_weddings_narrative_cache_busted
  ON public.weddings (narrative_cache_busted_at)
  WHERE narrative_cache_busted_at IS NOT NULL;


-- ============================================================================
-- STEP 7 — LIVE-ATTRIBUTION VIEW
-- ============================================================================
-- Critical readers (briefings.ts, health-score, journey-narrative,
-- lead-source-derivation, candidates page) want only live rows. Today
-- some filter `reverted_at IS NULL` but none filter tombstoned_at
-- because that column didn't exist before this migration. Rather than
-- patching dozens of read sites individually, expose a view that
-- pre-filters both. Critical readers migrate to this view; less-
-- critical readers keep using the base table and continue to see the
-- audit trail (which is what they want for forensic backtrace).
--
-- The view is SECURITY INVOKER (default) so RLS on the base table
-- applies through it. No new RLS policy needed.

CREATE OR REPLACE VIEW public.attribution_events_live AS
SELECT *
FROM public.attribution_events
WHERE reverted_at IS NULL
  AND tombstoned_at IS NULL;

COMMENT ON VIEW public.attribution_events_live IS
  'Live attributions only. Filters reverted_at + tombstoned_at. Use this view for counts/aggregates that should reflect current truth; use the base attribution_events table for forensic / audit-trail queries that need to see reverted + tombstoned history.';

-- Same for touchpoints. signal_id-NULL'd rows (the tombstoned ones
-- from step 3) are excluded by the partial-index discipline; the
-- view makes that explicit at the query layer.
CREATE OR REPLACE VIEW public.wedding_touchpoints_live AS
SELECT *
FROM public.wedding_touchpoints
WHERE (metadata->>'tombstoned_at_336') IS NULL;

COMMENT ON VIEW public.wedding_touchpoints_live IS
  'Live touchpoints only. Filters out rows tombstoned by mig 336 (their metadata.tombstoned_at_336 is set). Use this view for couple-journey counts; use the base table for forensic queries.';
