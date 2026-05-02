-- Migration 151: observability — metered counters + cron_runs
-- (OPS-21.2.3 / Playbook 21.2).
--
-- Per Playbook OPS-21.2.3: 10 metered counters / histograms required
-- for production observability. api_costs already gives us 2 (call
-- count + cost). The remaining 8 (cron-run timing, queue depth,
-- pipeline latency p50/p95/p99, error rate, rate-limit hits, send
-- attempts, send failures, backfill rows-per-batch) need their own
-- store.
--
-- Two tables:
--   1. cron_runs        — one row per cron tick: started_at, ended_at,
--                          status, rows_processed, error_message.
--                          Drives "is the briefing cron stuck?" alerts.
--   2. metered_events   — generic counter/histogram row store. Each
--                          event has (counter_name, venue_id?, value,
--                          dimension jsonb, observed_at). Lets us
--                          compute p50/p95/p99 latency over the last
--                          15 min via percentile_cont aggregate.
--
-- Idempotent.

-- =====================================================================
-- 1. cron_runs
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.cron_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Cron identifier — matches the case keys in /api/cron/route.ts
  -- (weekly_briefing / daily_digest / decay_check / etc.).
  cron_name text NOT NULL,

  -- Optional venue scope. NULL = global cron (e.g., FRED daily fetch).
  venue_id uuid REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Lifecycle.
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'partial', 'failure', 'timeout')),

  -- What was processed. Free-form metric — for digests this is
  -- weddings briefed, for trends it's terms fetched, etc.
  rows_processed integer DEFAULT 0,

  -- Latency derived from (ended_at - started_at). Stored explicitly
  -- so the pipeline-health page can index + aggregate without
  -- recomputing the diff.
  duration_ms integer,

  -- Failure detail. NULL on success / running.
  error_message text,
  error_class text,  -- e.g. 'timeout', 'rate_limit', 'auth', 'unknown'

  -- Optional structured payload (e.g. per-step counts).
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_name_started
  ON public.cron_runs (cron_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_cron_runs_status_started
  ON public.cron_runs (status, started_at DESC)
  WHERE status IN ('failure', 'timeout', 'partial');

CREATE INDEX IF NOT EXISTS idx_cron_runs_venue_started
  ON public.cron_runs (venue_id, started_at DESC)
  WHERE venue_id IS NOT NULL;

COMMENT ON TABLE public.cron_runs IS
  'One row per cron tick. Drives the pipeline-health page + alerts on '
  'stuck/failed crons. Per Playbook OPS-21.2.3.';

-- =====================================================================
-- 2. metered_events
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.metered_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Counter / histogram name. Examples:
  --   'pipeline_processed_email_ms'  (histogram)
  --   'autonomous_send_success'      (counter)
  --   'autonomous_send_failure'      (counter)
  --   'autosend_rate_limited'        (counter)
  --   'serpapi_call_throttled'       (counter)
  --   'fred_fetch_failure'           (counter)
  --   'insight_cache_hit'            (counter)
  --   'insight_cache_miss'           (counter)
  --   'backfill_rows_upserted'       (histogram)
  counter_name text NOT NULL,

  -- Optional venue scope. NULL = global.
  venue_id uuid REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Numeric value. For counters: usually 1. For histograms:
  -- the observed value (latency_ms, row_count, etc.).
  value numeric NOT NULL DEFAULT 1,

  -- Free-form dimensions — counter-specific shape. Examples:
  --   {"stage": "router_brain", "outcome": "ok"}
  --   {"channel": "instagram", "term": "wedding venue"}
  dimension jsonb NOT NULL DEFAULT '{}'::jsonb,

  observed_at timestamptz NOT NULL DEFAULT now()
);

-- Hot-path indexes for the dashboard's last-15min queries.
CREATE INDEX IF NOT EXISTS idx_metered_events_name_observed
  ON public.metered_events (counter_name, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_metered_events_venue_observed
  ON public.metered_events (venue_id, observed_at DESC)
  WHERE venue_id IS NOT NULL;

COMMENT ON TABLE public.metered_events IS
  'Generic counter/histogram store. recordCounter / recordHistogram '
  'helpers in src/lib/observability/metrics.ts. Aggregate via '
  'percentile_cont for p50/p95/p99. Per Playbook OPS-21.2.3.';

-- =====================================================================
-- RLS
-- =====================================================================

ALTER TABLE public.cron_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.metered_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cron_runs_service" ON public.cron_runs;
CREATE POLICY "cron_runs_service" ON public.cron_runs
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Authenticated users see only their venue's rows (org-admins see org-wide).
DROP POLICY IF EXISTS "cron_runs_select" ON public.cron_runs;
CREATE POLICY "cron_runs_select" ON public.cron_runs
  FOR SELECT TO authenticated
  USING (
    venue_id IS NULL  -- global crons visible to all signed-in users
    OR venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid() AND up.role IN ('org_admin', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "metered_events_service" ON public.metered_events;
CREATE POLICY "metered_events_service" ON public.metered_events
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "metered_events_select" ON public.metered_events;
CREATE POLICY "metered_events_select" ON public.metered_events
  FOR SELECT TO authenticated
  USING (
    venue_id IS NULL
    OR venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid() AND up.role IN ('org_admin', 'super_admin')
    )
  );
