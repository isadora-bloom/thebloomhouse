-- ---------------------------------------------------------------------------
-- 053_rate_limits.sql
--
-- Persistent rate limiter backed by Supabase. Replaces in-memory Map-based
-- rate limiters that reset on every Vercel cold start (BUG-12).
--
-- Tables:
--   rate_limits           — one row per key, tracks count within window
--
-- Functions:
--   increment_rate_limit  — atomically increment a counter and return status
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY,                    -- e.g. 'sage:user_id' or 'nlq:venue_id'
  window_start timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limits_updated_at_idx ON rate_limits(updated_at);

-- GC: periodically delete rows where updated_at < now() - interval '1 hour'
-- (run manually or via scheduled job; not enforced by this migration)

-- ---------------------------------------------------------------------------
-- increment_rate_limit
--
-- Atomically increments the counter for a key and returns whether the request
-- is allowed given the supplied (limit, window_sec). If the existing window
-- has expired, the counter resets to 1 and a new window is started.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION increment_rate_limit(
  p_key text,
  p_limit integer,
  p_window_sec integer
)
RETURNS TABLE(allowed boolean, remaining integer, reset_at timestamptz)
LANGUAGE plpgsql AS $$
DECLARE
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_count integer;
BEGIN
  INSERT INTO rate_limits (key, window_start, count, updated_at)
  VALUES (p_key, v_now, 1, v_now)
  ON CONFLICT (key) DO UPDATE
    SET count = CASE
      WHEN rate_limits.window_start < v_now - (p_window_sec || ' seconds')::interval THEN 1
      ELSE rate_limits.count + 1
    END,
    window_start = CASE
      WHEN rate_limits.window_start < v_now - (p_window_sec || ' seconds')::interval THEN v_now
      ELSE rate_limits.window_start
    END,
    updated_at = v_now
  RETURNING rate_limits.count, rate_limits.window_start INTO v_count, v_window_start;

  RETURN QUERY SELECT
    v_count <= p_limit AS allowed,
    GREATEST(0, p_limit - v_count) AS remaining,
    v_window_start + (p_window_sec || ' seconds')::interval AS reset_at;
END;
$$;
