-- ---------------------------------------------------------------------------
-- 210_rate_limit_advisory_lock.sql
--
-- Adds pg_advisory_xact_lock to check_rate_limit to replace the FOR UPDATE
-- row-lock pattern from migration 208.
--
-- Problem with 208: The RPC uses SELECT ... FOR UPDATE on the key row.
-- Any global or shared key serializes all concurrent requests on that row.
-- Under high concurrency this becomes a bottleneck — every request for the
-- same key must wait for the previous transaction to release the row lock.
--
-- Fix: Use pg_advisory_xact_lock(hashtext(p_key)) before the INSERT/SELECT.
-- Advisory transaction locks:
--   - Serialise callers for the same key (same hash) without needing a row
--     in the table at all.
--   - Are automatically released at transaction end.
--   - Do not block cross-key callers (different hashes rarely collide).
--   - Are faster than row-level locks — no heap access required to acquire.
--
-- With the advisory lock providing serialisation we drop the FOR UPDATE
-- clause from the SELECT (the row is already protected by the advisory lock).
--
-- Idempotent: CREATE OR REPLACE. Safe to re-run.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key text,
  p_limit integer,
  p_window_sec integer
)
RETURNS TABLE(allowed boolean, remaining integer, reset_at timestamptz)
LANGUAGE plpgsql AS $$
DECLARE
  v_now    bigint := EXTRACT(EPOCH FROM now())::bigint;
  v_cutoff bigint := v_now - p_window_sec;
  v_filtered jsonb;
  v_count  integer;
  v_oldest bigint;
  v_reset_at timestamptz;
BEGIN
  -- Advisory transaction lock: serialises concurrent callers for the same
  -- key without a row-level lock. Released automatically at transaction end.
  -- hashtext() maps the key string to a 32-bit int — same key always maps
  -- to same lock, different keys almost never collide.
  PERFORM pg_advisory_xact_lock(hashtext(p_key));

  -- Insert-if-missing. ON CONFLICT DO NOTHING is safe here because the
  -- advisory lock above ensures only one caller reaches this point at a time
  -- for the same key.
  INSERT INTO public.rate_limit_buckets (key, hits, window_start, updated_at)
  VALUES (p_key, '[]'::jsonb, now(), now())
  ON CONFLICT (key) DO NOTHING;

  -- Load the bucket (no FOR UPDATE needed — advisory lock handles serialisation).
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
       SET hits         = v_filtered,
           window_start = to_timestamp(v_now),
           updated_at   = now()
     WHERE key = p_key;

    -- reset_at: oldest in-window hit + window. With the new hit appended
    -- this is the first hit's epoch (or v_now if this is the only one).
    SELECT MIN((elem)::bigint) INTO v_oldest
      FROM jsonb_array_elements(v_filtered) AS elem;
    v_reset_at := to_timestamp(COALESCE(v_oldest, v_now) + p_window_sec);

    RETURN QUERY SELECT
      true                          AS allowed,
      GREATEST(0, p_limit - v_count) AS remaining,
      v_reset_at                    AS reset_at;
  ELSE
    -- Denied: do NOT append the hit. Evict stale entries and touch
    -- updated_at so the prune sweep knows the bucket is still active.
    UPDATE public.rate_limit_buckets
       SET hits       = v_filtered,
           updated_at = now()
     WHERE key = p_key;

    SELECT MIN((elem)::bigint) INTO v_oldest
      FROM jsonb_array_elements(v_filtered) AS elem;
    v_reset_at := to_timestamp(COALESCE(v_oldest, v_now) + p_window_sec);

    RETURN QUERY SELECT
      false AS allowed,
      0     AS remaining,
      v_reset_at AS reset_at;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.check_rate_limit(text, integer, integer) IS
  'Sliding-window rate limiter. Returns (allowed, remaining, reset_at). '
  'Serialised via pg_advisory_xact_lock(hashtext(p_key)) — no FOR UPDATE. '
  'Migration 210 upgrade over 208 (advisory lock replaces row-level lock). '
  'Per PROJECT-AUDIT-V2 BUG-12.';
