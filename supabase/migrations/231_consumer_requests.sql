-- ============================================================================
-- 231: CONSUMER REQUESTS LOG (Tier-C #118)
--
-- DSAR / CCPA / GDPR compliance ledger. Every right-to-erasure,
-- data-portability, and right-to-access request is recorded here with
-- its status. The substrate for audit, regulator response, and the
-- 45-day SLA CCPA imposes on operators.
--
-- Lifecycle:
--   pending     — request created, awaiting admin review
--   processing  — admin started the work; export building or erasure cascade running
--   completed   — work finished; resolution_notes describes what happened
--   denied      — admin refused (with required justification)
--   expired     — auto-flipped by cron after 45 days unprocessed
--                 (CCPA SLA tripwire — surfaces as a compliance breach)
--
-- Out of scope (deferred to Tier-C ops maturity bucket):
--   - DPA reference per processor (Anthropic, Resend, Stripe, etc.)
--   - State-specific PII breach-notification runbook
--   - SOC 2 path scoping
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.consumer_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Always tied to a venue. For super_admin self-requests this is the
  -- super_admin's home venue (per getPlatformAuth fallback). Keeping
  -- venue_id NOT NULL keeps the RLS policies simple — every request has
  -- a tenant.
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Requester identity. user_id is SET NULL on cascade so that an
  -- erasure request can complete (deleting the user_profiles row)
  -- without orphaning its own audit row. requester_email is the
  -- correspondence channel for follow-up after the user is gone.
  requester_user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  requester_email text NOT NULL,
  requester_role text NOT NULL CHECK (
    requester_role IN ('couple', 'coordinator', 'manager', 'org_admin', 'super_admin')
  ),

  -- What was requested + how broad
  request_type text NOT NULL CHECK (
    request_type IN ('erasure', 'portability', 'access')
  ),
  scope text NOT NULL CHECK (
    scope IN ('self', 'wedding', 'org')
  ),

  -- Workflow state
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'completed', 'denied', 'expired')
  ),
  resolution_notes text,

  processed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  processed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- CCPA SLA: 45 days to fulfil. expires_at trips the status='expired'
  -- flip in the daily cron (added separately) so unprocessed requests
  -- become a visible compliance breach instead of sitting silent.
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '45 days')
);

CREATE INDEX IF NOT EXISTS idx_consumer_requests_venue_status_created
  ON public.consumer_requests(venue_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consumer_requests_requester_user
  ON public.consumer_requests(requester_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consumer_requests_pending_expires
  ON public.consumer_requests(expires_at)
  WHERE status IN ('pending', 'processing');

COMMENT ON TABLE public.consumer_requests IS
  'CCPA / GDPR consumer-rights request ledger. Every DSAR / portability / erasure / access request is logged here with status. Tier-C #118.';

COMMENT ON COLUMN public.consumer_requests.requester_email IS
  'Snapshot of requester email at request time. Required because user_profiles may be erased before correspondence completes — the email is the only durable channel for follow-up.';

COMMENT ON COLUMN public.consumer_requests.scope IS
  'self = just the requester own profile / data. wedding = the requester own wedding (couple-side). org = entire org (org_admin / super_admin). Determines which helper the processor calls.';

COMMENT ON COLUMN public.consumer_requests.expires_at IS
  'CCPA SLA tripwire. 45 days from creation. The daily cron flips status to expired; unprocessed expired rows are a compliance breach the admin queue surfaces in red.';

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE public.consumer_requests ENABLE ROW LEVEL SECURITY;

-- super_admin sees everything (platform compliance team)
DROP POLICY IF EXISTS "super_admin_all" ON public.consumer_requests;
CREATE POLICY "super_admin_all" ON public.consumer_requests
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid() AND role = 'super_admin'
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid() AND role = 'super_admin'
  ));

-- org_admin sees requests within any venue in their org
DROP POLICY IF EXISTS "org_admin_select" ON public.consumer_requests;
CREATE POLICY "org_admin_select" ON public.consumer_requests
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      JOIN public.venues v ON v.id = consumer_requests.venue_id
      WHERE up.id = auth.uid()
        AND up.role = 'org_admin'
        AND v.org_id = up.org_id
    )
  );

DROP POLICY IF EXISTS "org_admin_update" ON public.consumer_requests;
CREATE POLICY "org_admin_update" ON public.consumer_requests
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      JOIN public.venues v ON v.id = consumer_requests.venue_id
      WHERE up.id = auth.uid()
        AND up.role = 'org_admin'
        AND v.org_id = up.org_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      JOIN public.venues v ON v.id = consumer_requests.venue_id
      WHERE up.id = auth.uid()
        AND up.role = 'org_admin'
        AND v.org_id = up.org_id
    )
  );

-- requester sees their own pending/processing/completed rows
DROP POLICY IF EXISTS "requester_select_own" ON public.consumer_requests;
CREATE POLICY "requester_select_own" ON public.consumer_requests
  FOR SELECT TO authenticated
  USING (requester_user_id = auth.uid());

-- requester can insert their own request. Service-role bypasses RLS so
-- API routes that authenticate then write via service client also work.
DROP POLICY IF EXISTS "requester_insert_own" ON public.consumer_requests;
CREATE POLICY "requester_insert_own" ON public.consumer_requests
  FOR INSERT TO authenticated
  WITH CHECK (requester_user_id = auth.uid());

-- No DELETE policy on purpose. Compliance ledger is append-only; even
-- denied requests stay for the audit trail.

NOTIFY pgrst, 'reload schema';
