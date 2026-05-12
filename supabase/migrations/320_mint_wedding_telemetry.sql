-- ---------------------------------------------------------------------------
-- 320_mint_wedding_telemetry.sql
-- ---------------------------------------------------------------------------
-- Soak instrumentation for the mintWedding chokepoint. Every call to
-- mintWedding (the canonical wedding writer at
-- src/lib/services/identity/mint-wedding.ts) inserts one row here so the
-- soak dashboard can answer:
--
--   - How many wedding mints happened in the last 24h / 7d / 30d?
--   - How are they distributed across entry paths (sources)?
--   - What's the resolver's match-chain hit rate? (email_exact vs created_new)
--   - What's the error rate?
--   - How does latency look across paths?
--
-- This is the data underneath the "is it safe to flip email/pipeline.ts to
-- mintWedding?" question. The 7 migrated sites today (brain-dump, csv-
-- import, reprocess endpoints, crm-import, portal-ui) will populate this
-- table over real traffic. When the volume is non-trivial and errors stay
-- near zero, the hot-path migration can proceed.
--
-- Bounded retention is a follow-up — for now keep all rows (volume is
-- O(weddings) so a Wedgewood-scale venue produces ~1000 rows/month, fine).
--
-- Idempotent. No BEGIN/COMMIT (Wave 23 doctrine).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mint_wedding_telemetry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid REFERENCES public.venues(id) ON DELETE CASCADE,
  source text NOT NULL,
  reason text,
  resolved_via text
    CHECK (resolved_via IS NULL OR resolved_via IN
      ('email_exact', 'email_canonical', 'phone', 'name_plus_date', 'created_new')),
  wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL,
  person_id uuid REFERENCES public.people(id) ON DELETE SET NULL,
  is_new_wedding boolean,
  is_new_person boolean,
  latency_ms integer,
  errored boolean NOT NULL DEFAULT false,
  error_message text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mint_wedding_telemetry IS
  'Soak telemetry for mintWedding (src/lib/services/identity/mint-wedding.ts). One row per call (success or error). Read by /api/admin/mint-wedding-stats. Used to confirm the chokepoint is stable before migrating the email/pipeline.ts hot-path direct INSERT. Mig 320.';

COMMENT ON COLUMN public.mint_wedding_telemetry.source IS
  'WeddingSource enum from mint-wedding.ts. Free-text-friendly so future entry paths can be added without a migration. Examples: email_pipeline | sms_inbound | brain_dump | csv_import | portal_ui.';

COMMENT ON COLUMN public.mint_wedding_telemetry.resolved_via IS
  'Which step in the match chain fired. created_new means a brand-new person + wedding row pair was minted. Others are existing-match paths. Distribution across these tells you whether the resolver is dedup-ing aggressively enough.';

COMMENT ON COLUMN public.mint_wedding_telemetry.errored IS
  'True when the underlying resolveIdentity call threw. Successful mints with non-fatal cascade-fire failures stay false (those land in identity.mint_wedding.cascade_failed structured logs instead).';

-- Indexes for the stats endpoint
CREATE INDEX IF NOT EXISTS idx_mint_wedding_telemetry_venue_created
  ON public.mint_wedding_telemetry (venue_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mint_wedding_telemetry_created
  ON public.mint_wedding_telemetry (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mint_wedding_telemetry_errors
  ON public.mint_wedding_telemetry (created_at DESC)
  WHERE errored = true;

NOTIFY pgrst, 'reload schema';
