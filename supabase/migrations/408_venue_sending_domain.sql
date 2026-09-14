-- 408: per-venue Resend sending domain
--
-- Wave 8, W55 (NOVEMBER-PLAN.md). Every venue's transactional mail
-- (portal invites, team invites, payment alerts, operator alerts) has
-- gone out through Bloom's own thebloomhouse.ai Resend domain since
-- transport.ts was written — see the "infrastructure carry-forward"
-- note on src/app/api/portal/invite-couple/route.ts, which flagged
-- exactly this as deferred. One shared sending domain means one
-- venue's bounces/spam complaints can drag down every other venue's
-- deliverability, and a couple's inbox shows "The Bloom House" instead
-- of the venue they actually booked. This migration is the storage
-- half of the fix; transport.ts (same commit) and
-- src/lib/services/email/sending-domain.ts (the Resend domain-
-- verification flow) are the other two.
--
-- Columns:
--   sending_domain            the venue's own domain, e.g. 'rixeymanor.com'.
--                              Null until the coordinator enters one.
--   sending_from_name          display name for the From header, e.g.
--                              'Rixey Manor'. Independent of business_name
--                              so a venue can pick different wording for
--                              the envelope than for the portal UI.
--   sending_domain_status      unverified (default, nothing attempted or
--                              DNS not yet added) | pending (Resend domain
--                              created, DNS check in flight) | verified
--                              (Resend confirmed SPF + DKIM; transport.ts
--                              may use this domain) | failed (Resend
--                              checked and the DNS records don't match —
--                              never used for sending).
--   resend_domain_id           the Resend domains/{id} this venue's
--                              domain maps to. Needed to call verify/get
--                              without re-creating the domain each time.
--   sending_domain_checked_at  last time the status was refreshed, either
--                              by the coordinator's "check now" button or
--                              the daily cron piggyback (see cron/route.ts
--                              heat_decay case). Shown on the settings
--                              page so a stuck "pending" reads as stale
--                              rather than actively wrong.
--
-- transport.ts only ever uses sending_domain/sending_from_name for the
-- From header when sending_domain_status = 'verified' — every other
-- status falls back to the platform default, logged, never silent.
--
-- RLS unchanged: venue_config already carries venue_id RLS (migration
-- 006 + tightened in 216/225/226); these are plain columns on an
-- already-isolated table, no new policy needed.
--
-- Schema-qualified because scripts/run-migration.ts drives
-- public.exec_sql with search_path = pg_catalog, public. Idempotent, no
-- BEGIN/COMMIT (the exec_sql RPC rejects transaction blocks).

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS sending_domain text,
  ADD COLUMN IF NOT EXISTS sending_from_name text,
  ADD COLUMN IF NOT EXISTS sending_domain_status text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS resend_domain_id text,
  ADD COLUMN IF NOT EXISTS sending_domain_checked_at timestamptz;

-- Guard the status enum the same way sending_domain_status is described
-- above. Dropped-and-recreated so a re-run of this file (idempotent
-- migration convention) doesn't fail on "constraint already exists".
ALTER TABLE public.venue_config
  DROP CONSTRAINT IF EXISTS venue_config_sending_domain_status_check;

ALTER TABLE public.venue_config
  ADD CONSTRAINT venue_config_sending_domain_status_check
  CHECK (sending_domain_status IN ('unverified', 'pending', 'verified', 'failed'));

COMMENT ON COLUMN public.venue_config.sending_domain IS
  'The venue''s own domain for outbound transactional mail, e.g. rixeymanor.com. Null until the coordinator sets one on Settings -> Sending domain. Migration 408.';

COMMENT ON COLUMN public.venue_config.sending_from_name IS
  'Display name for the From header when sending_domain_status is verified, e.g. "Rixey Manor". Migration 408.';

COMMENT ON COLUMN public.venue_config.sending_domain_status IS
  'unverified | pending | verified | failed. transport.ts sendEmail only builds a From address on this domain when verified; every other value falls back to the platform default with a logged reason. Migration 408.';

COMMENT ON COLUMN public.venue_config.resend_domain_id IS
  'The Resend domains/{id} this venue''s sending_domain was created as. Set by src/lib/services/email/sending-domain.ts on create, read back on every verify/refresh. Migration 408.';

COMMENT ON COLUMN public.venue_config.sending_domain_checked_at IS
  'Last time sending_domain_status was refreshed against Resend — coordinator "check now" or the daily cron piggyback (cron/route.ts heat_decay case). Migration 408.';
