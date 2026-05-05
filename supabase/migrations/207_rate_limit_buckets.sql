-- ---------------------------------------------------------------------------
-- 207_rate_limit_buckets.sql  (PROJECT-AUDIT-V2 BUG-12)
--
-- Durable, sliding-window rate limiter backed by Postgres. Replaces the
-- earlier `rate_limits` table (migration 053) AND every in-memory Map-based
-- limiter that pre-dated it. The earlier 053 table was a fixed-window
-- counter that did not meet the doctrine task contract:
--   1. table named `rate_limit_buckets` (not `rate_limits`)
--   2. true sliding-window semantics, not a calendar-window bump
--   3. no backwards-compat shim — single code path local + prod
--   4. cron-driven prune of expired rows
--   5. observability via metered_events (recordCounter)
--
-- This migration:
--   - Drops the legacy 053 `rate_limits` + `increment_rate_limit` artefacts
--     (they are read by exactly one file, src/lib/rate-limit.ts, which is
--     rewritten in the same commit to call this migration's function).
--   - Creates `rate_limit_buckets` keyed by `key text PRIMARY KEY` with a
--     hits jsonb array of unix-second timestamps (one row per limiter key
--     across the whole platform).
--   - Creates `check_rate_limit(p_key, p_limit, p_window_sec)` RPC that
--     evicts hits older than `now() - p_window_sec`, conditionally appends
--     the current hit when under limit, and returns
--     (allowed boolean, remaining int, reset_at timestamptz).
--   - Creates `prune_rate_limit_buckets()` for the cron-driven daily sweep
--     (vercel.json: prune_rate_limits 02:30 UTC). Drops rows whose newest
--     hit is older than 7 days (any window we care about is sub-hour).
--
-- Idempotent: every CREATE uses IF NOT EXISTS / OR REPLACE, every DROP
-- uses IF EXISTS. Safe to re-run on a half-applied environment.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Drop legacy 053 artefacts. No shim — src/lib/rate-limit.ts is rewritten
--    in the same commit. If this migration ran on a fresh DB that never had
--    053, the IF EXISTS guards keep it silent.
-- ===========================================================================

DROP FUNCTION IF EXISTS public.increment_rate_limit(text, integer, integer);
DROP TABLE IF EXISTS public.rate_limits;

-- ===========================================================================
-- 2. New durable bucket. One row per limiter key.
--
--    `hits` is a jsonb array of unix-second numbers — bigint-safe in
--    Postgres jsonb (numeric type, no 53-bit JS-number ceiling). On each
--    check we filter the array to entries within the window, compare
--    against `p_limit`, and conditionally append `now()`. The bucket
--    function is the only writer, so the array stays bounded by the
--    limiter's own configured limit per window.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
  key text PRIMARY KEY,
  hits jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- window_start is informational — kept for compatibility with the
  -- caller's mental model and for the prune sweep's recency check.
  window_start timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- key is already PRIMARY KEY (= unique btree index). Add the hot-path
-- prune index on updated_at so the daily sweep stays range-scan cheap.
CREATE INDEX IF NOT EXISTS rate_limit_buckets_updated_at_idx
  ON public.rate_limit_buckets (updated_at);

COMMENT ON TABLE public.rate_limit_buckets IS
  'Sliding-window rate limiter buckets. One row per limiter key '
  '(e.g. ''sage:<wedding_id>'' / ''nlq:<user_id>''). Written ONLY by the '
  'check_rate_limit RPC. Pruned daily 02:30 UTC by prune_rate_limit_buckets. '
  'Per PROJECT-AUDIT-V2 BUG-12.';

-- ===========================================================================
-- 3. check_rate_limit — atomic sliding-window check.
--
--    Behavior:
--      * Loads (or creates) the bucket row for p_key.
--      * Filters `hits` to entries within (now() - p_window_sec, now()].
--      * If filtered count < p_limit: appends now() (epoch seconds), allows.
--      * Else: leaves hits unchanged, denies.
--      * Returns: (allowed, remaining, reset_at). reset_at = oldest in-window
--        hit + p_window_sec (i.e. the soonest moment the caller can retry).
--
--    Concurrency: SELECT ... FOR UPDATE serialises concurrent checks for
--    the same key. Different keys take different rows so cross-key contention
--    is zero. Postgres advisory lock would be a faster alternative but the
--    row-lock path keeps the hits material visible to the same transaction.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key text,
  p_limit integer,
  p_window_sec integer
)
RETURNS TABLE(allowed boolean, remaining integer, reset_at timestamptz)
LANGUAGE plpgsql AS $$
DECLARE
  v_now bigint := EXTRACT(EPOCH FROM now())::bigint;
  v_cutoff bigint := v_now - p_window_sec;
  v_filtered jsonb;
  v_count integer;
  v_oldest bigint;
  v_reset_at timestamptz;
BEGIN
  -- Insert-if-missing then lock the row for this key. ON CONFLICT DO
  -- UPDATE (no-op) is the documented Postgres pattern for "ensure row
  -- exists then RETURNING the row" with stable concurrency semantics.
  INSERT INTO public.rate_limit_buckets (key, hits, window_start, updated_at)
  VALUES (p_key, '[]'::jsonb, now(), now())
  ON CONFLICT (key) DO NOTHING;

  -- Lock + load
  PERFORM 1 FROM public.rate_limit_buckets WHERE key = p_key FOR UPDATE;

  SELECT COALESCE(
    (
      SELECT jsonb_agg(elem)
      FROM jsonb_array_elements(hits) AS elem
      WHERE (elem)::bigint > v_cutoff
    ),
    '[]'::jsonb
  )
  INTO v_filtered
  FROM public.rate_limit_buckets
  WHERE key = p_key;

  v_count := jsonb_array_length(v_filtered);

  IF v_count < p_limit THEN
    v_filtered := v_filtered || to_jsonb(v_now);
    v_count := v_count + 1;
    UPDATE public.rate_limit_buckets
       SET hits = v_filtered,
           window_start = to_timestamp(v_now),
           updated_at = now()
     WHERE key = p_key;

    -- reset_at: oldest in-window hit + window. With the new hit appended
    -- this is the first hit's epoch (or v_now if this is the only one).
    SELECT MIN((elem)::bigint) INTO v_oldest
      FROM jsonb_array_elements(v_filtered) AS elem;
    v_reset_at := to_timestamp(COALESCE(v_oldest, v_now) + p_window_sec);

    RETURN QUERY SELECT
      true AS allowed,
      GREATEST(0, p_limit - v_count) AS remaining,
      v_reset_at AS reset_at;
  ELSE
    -- Denied: do NOT append the hit (that would punish the caller for
    -- retrying). Just touch updated_at so prune knows the bucket is live.
    UPDATE public.rate_limit_buckets
       SET hits = v_filtered,
           updated_at = now()
     WHERE key = p_key;

    SELECT MIN((elem)::bigint) INTO v_oldest
      FROM jsonb_array_elements(v_filtered) AS elem;
    v_reset_at := to_timestamp(COALESCE(v_oldest, v_now) + p_window_sec);

    RETURN QUERY SELECT
      false AS allowed,
      0 AS remaining,
      v_reset_at AS reset_at;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.check_rate_limit(text, integer, integer) IS
  'Sliding-window rate limiter. Returns (allowed, remaining, reset_at). '
  'Atomic via row-level FOR UPDATE on rate_limit_buckets.key. '
  'Per PROJECT-AUDIT-V2 BUG-12.';

-- ===========================================================================
-- 4. prune_rate_limit_buckets — cron sweep.
--
--    Drops rows whose updated_at is older than 7 days. Any active limiter
--    has windowSec <= 1h, so 7d is conservative — we won't evict a row that
--    is about to be re-checked by an in-flight caller.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.prune_rate_limit_buckets()
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.rate_limit_buckets
   WHERE updated_at < now() - interval '7 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.prune_rate_limit_buckets() IS
  'Daily sweep, called by /api/cron?job=prune_rate_limits at 02:30 UTC. '
  'Drops rate_limit_buckets rows whose updated_at < now() - 7 days.';

-- ===========================================================================
-- 5. RLS — service-role only. The public-facing routes that drive this
--    table go through the service client (bypasses RLS), and there is no
--    legitimate authenticated-user read pattern. Lock the table down so an
--    anon JWT cannot enumerate keys.
-- ===========================================================================

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rate_limit_buckets_service" ON public.rate_limit_buckets;
CREATE POLICY "rate_limit_buckets_service" ON public.rate_limit_buckets
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);
