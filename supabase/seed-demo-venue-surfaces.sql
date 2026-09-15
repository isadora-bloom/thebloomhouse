-- seed-demo-venue-surfaces.sql
--
-- W70. The Crestwood rows the demo reseed cannot reach.
--
-- Everything couple-shaped now comes from `scripts/demo-reseed/mirror-rows.ts`,
-- where the dates are offsets from a live clock. What is left here is the
-- handful of things a TypeScript generator has no business writing:
--
--   1. auth users. `scripts/demo-reseed.ts` talks to PostgREST with a
--      service key; creating an auth user needs the admin API, and the
--      `user_profiles.id` foreign key means the profile cannot exist
--      without one. So the team lives in SQL, against `auth.users`
--      directly, the same way `supabase/seed.sql` already does it.
--   2. Columns rather than rows. Sending-domain state and benchmark
--      participation are `venue_config` columns (migrations 408 and 410),
--      so they are UPDATEs on a row seed.sql already made.
--   3. Ad-platform connections. One row per venue per platform, carrying
--      a status the integrations hub reads. Nothing here holds a real
--      token; the `access_token` column stays NULL and `token_env_key`
--      names the variable the connector would read.
--
-- Nothing in this file creates a venue, a wedding, a couple or a person.
-- Every insert is guarded, so a second run is a no-op.
--
-- Run: after supabase/seed.sql, before or after the reseed. It does not
--      depend on couples.
--
-- Fictional throughout. Addresses are on RFC 2606 reserved domains and
-- cannot receive mail.

-- ---------------------------------------------------------------------------
-- 1. The team, one account per role the app knows about
-- ---------------------------------------------------------------------------
--
-- `user_profiles.role` CHECK (migration 049 and friends) is
-- org_admin | venue_manager | coordinator | readonly. seed.sql already
-- creates one venue_manager and three coordinators. This adds the two
-- roles that were missing, plus a second coordinator on Hawthorne so the
-- assignment dropdown has more than one name in it, and a readonly
-- account for the "what can this role not do" journey.

INSERT INTO auth.users (id, email, role, instance_id, aud, created_at, updated_at, confirmation_token, email_confirmed_at)
SELECT '33333333-3333-3333-3333-333333333310', 'dana@crestwoodcollection.example.com', 'authenticated', '00000000-0000-0000-0000-000000000000', 'authenticated', now(), now(), '', now()
WHERE NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '33333333-3333-3333-3333-333333333310');

INSERT INTO auth.users (id, email, role, instance_id, aud, created_at, updated_at, confirmation_token, email_confirmed_at)
SELECT '33333333-3333-3333-3333-333333333311', 'priya@hawthornemanor.example.com', 'authenticated', '00000000-0000-0000-0000-000000000000', 'authenticated', now(), now(), '', now()
WHERE NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '33333333-3333-3333-3333-333333333311');

INSERT INTO auth.users (id, email, role, instance_id, aud, created_at, updated_at, confirmation_token, email_confirmed_at)
SELECT '33333333-3333-3333-3333-333333333312', 'accounts@crestwoodcollection.example.com', 'authenticated', '00000000-0000-0000-0000-000000000000', 'authenticated', now(), now(), '', now()
WHERE NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '33333333-3333-3333-3333-333333333312');

INSERT INTO auth.users (id, email, role, instance_id, aud, created_at, updated_at, confirmation_token, email_confirmed_at)
SELECT '33333333-3333-3333-3333-333333333313', 'noor@theglasshouse.example.com', 'authenticated', '00000000-0000-0000-0000-000000000000', 'authenticated', now(), now(), '', now()
WHERE NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '33333333-3333-3333-3333-333333333313');

-- org_admin: no venue_id, because the role is org-wide.
INSERT INTO user_profiles (id, venue_id, org_id, role, first_name, last_name)
SELECT '33333333-3333-3333-3333-333333333310', NULL, '11111111-1111-1111-1111-111111111111', 'org_admin', 'Dana', 'Okonkwo'
WHERE NOT EXISTS (SELECT 1 FROM user_profiles WHERE id = '33333333-3333-3333-3333-333333333310');

INSERT INTO user_profiles (id, venue_id, org_id, role, first_name, last_name)
SELECT '33333333-3333-3333-3333-333333333311', '22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Priya', 'Raman'
WHERE NOT EXISTS (SELECT 1 FROM user_profiles WHERE id = '33333333-3333-3333-3333-333333333311');

INSERT INTO user_profiles (id, venue_id, org_id, role, first_name, last_name)
SELECT '33333333-3333-3333-3333-333333333312', NULL, '11111111-1111-1111-1111-111111111111', 'readonly', 'Bookkeeping', 'Account'
WHERE NOT EXISTS (SELECT 1 FROM user_profiles WHERE id = '33333333-3333-3333-3333-333333333312');

INSERT INTO user_profiles (id, venue_id, org_id, role, first_name, last_name)
SELECT '33333333-3333-3333-3333-333333333313', '22222222-2222-2222-2222-222222222203', '11111111-1111-1111-1111-111111111111', 'venue_manager', 'Noor', 'Haddad'
WHERE NOT EXISTS (SELECT 1 FROM user_profiles WHERE id = '33333333-3333-3333-3333-333333333313');

-- ---------------------------------------------------------------------------
-- 2. Team invitations, including one still pending
-- ---------------------------------------------------------------------------
--
-- `token` is UNIQUE NOT NULL and `token_hash` was added by migration 411.
-- These are throwaway strings on a demo org; they grant nothing anywhere
-- else, and the pending one is the row the invite journey reads.

INSERT INTO team_invitations (id, org_id, venue_id, email, role, invited_by, token, token_hash, status, expires_at, accepted_at, created_at)
SELECT '55555555-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222201', 'new.coordinator@hawthornemanor.example.com', 'coordinator', '33333333-3333-3333-3333-333333333310', 'demo-invite-pending-0001', encode(sha256('demo-invite-pending-0001'::bytea), 'hex'), 'pending', now() + interval '9 days', NULL, now() - interval '2 days'
WHERE NOT EXISTS (SELECT 1 FROM team_invitations WHERE id = '55555555-0000-4000-8000-000000000001');

INSERT INTO team_invitations (id, org_id, venue_id, email, role, invited_by, token, token_hash, status, expires_at, accepted_at, created_at)
SELECT '55555555-0000-4000-8000-000000000002', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222202', 'jake@crestwoodfarm.example.com', 'coordinator', '33333333-3333-3333-3333-333333333310', 'demo-invite-accepted-0002', encode(sha256('demo-invite-accepted-0002'::bytea), 'hex'), 'accepted', now() - interval '20 days', now() - interval '27 days', now() - interval '34 days'
WHERE NOT EXISTS (SELECT 1 FROM team_invitations WHERE id = '55555555-0000-4000-8000-000000000002');

INSERT INTO team_invitations (id, org_id, venue_id, email, role, invited_by, token, token_hash, status, expires_at, accepted_at, created_at)
SELECT '55555555-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222203', 'weekend.help@theglasshouse.example.com', 'readonly', '33333333-3333-3333-3333-333333333310', 'demo-invite-expired-0003', encode(sha256('demo-invite-expired-0003'::bytea), 'hex'), 'expired', now() - interval '5 days', NULL, now() - interval '19 days'
WHERE NOT EXISTS (SELECT 1 FROM team_invitations WHERE id = '55555555-0000-4000-8000-000000000003');

INSERT INTO team_invitations (id, org_id, venue_id, email, role, invited_by, token, token_hash, status, expires_at, accepted_at, created_at)
SELECT '55555555-0000-4000-8000-000000000004', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222204', 'someone.who.left@rosehillgardens.example.com', 'coordinator', '33333333-3333-3333-3333-333333333310', 'demo-invite-revoked-0004', encode(sha256('demo-invite-revoked-0004'::bytea), 'hex'), 'revoked', now() + interval '4 days', NULL, now() - interval '11 days'
WHERE NOT EXISTS (SELECT 1 FROM team_invitations WHERE id = '55555555-0000-4000-8000-000000000004');

-- Org-level, no venue. The role dropdown on the invite page offers this
-- and nothing in the demo exercised it before.
INSERT INTO team_invitations (id, org_id, venue_id, email, role, invited_by, token, token_hash, status, expires_at, accepted_at, created_at)
SELECT '55555555-0000-4000-8000-000000000005', '11111111-1111-1111-1111-111111111111', NULL, 'second.owner@crestwoodcollection.example.com', 'org_admin', '33333333-3333-3333-3333-333333333310', 'demo-invite-org-0005', encode(sha256('demo-invite-org-0005'::bytea), 'hex'), 'pending', now() + interval '13 days', NULL, now() - interval '1 day'
WHERE NOT EXISTS (SELECT 1 FROM team_invitations WHERE id = '55555555-0000-4000-8000-000000000005');

-- ---------------------------------------------------------------------------
-- 3. Sending domains (migration 408) and benchmark participation (410)
-- ---------------------------------------------------------------------------
--
-- Four venues, four states, because the integrations hub has a card for
-- each and an all-green demo proves nothing. `transport.ts` only uses the
-- venue's own From header when the status is 'verified', so Hawthorne and
-- Rose Hill send as themselves and the other two fall back.
--
-- Benchmark participation is on for all four: `benchmarkPeerSet()` needs a
-- cohort of at least ten across the platform, and with the demo org
-- opted in the benchmarks panel has peers to show when a visitor turns the
-- switch on.

UPDATE venue_config SET
  sending_domain = 'hawthornemanor.example.com',
  sending_from_name = 'Hawthorne Manor',
  sending_domain_status = 'verified',
  sending_domain_checked_at = now() - interval '3 hours',
  benchmark_participation = true
WHERE venue_id = '22222222-2222-2222-2222-222222222201';

UPDATE venue_config SET
  sending_domain = 'crestwoodfarm.example.com',
  sending_from_name = 'Crestwood Farm',
  sending_domain_status = 'pending',
  sending_domain_checked_at = now() - interval '2 days',
  benchmark_participation = true
WHERE venue_id = '22222222-2222-2222-2222-222222222202';

UPDATE venue_config SET
  sending_domain = 'theglasshouse.example.com',
  sending_from_name = 'The Glass House',
  sending_domain_status = 'failed',
  sending_domain_checked_at = now() - interval '6 days',
  benchmark_participation = true
WHERE venue_id = '22222222-2222-2222-2222-222222222203';

UPDATE venue_config SET
  sending_domain = 'rosehillgardens.example.com',
  sending_from_name = 'Rose Hill Gardens',
  sending_domain_status = 'verified',
  sending_domain_checked_at = now() - interval '11 hours',
  benchmark_participation = true
WHERE venue_id = '22222222-2222-2222-2222-222222222204';

-- ---------------------------------------------------------------------------
-- 4. Ad-platform connections (migration 407)
-- ---------------------------------------------------------------------------
--
-- One row per venue per platform, with a spread of statuses so the hub
-- shows connected, pending, error and revoked rather than four of the
-- same. No tokens: `access_token` stays NULL and `token_env_key` names
-- the variable the connector reads, which is what a real connection on a
-- self-hosted deploy looks like anyway.
--
-- `supabase/seed-ad-connections-demo.sql` already puts one Meta and one
-- Google row on Crestwood Farm. These are guarded on id and on
-- (venue_id, platform) so the two files compose in either order.

INSERT INTO google_ads_connections (id, venue_id, customer_id, customer_name, status, connected_at, last_synced_at)
SELECT '66666666-0000-4000-8000-000000000001', '22222222-2222-2222-2222-222222222201', '482-551-9007', 'Hawthorne Manor', 'connected', now() - interval '120 days', now() - interval '6 hours'
WHERE NOT EXISTS (SELECT 1 FROM google_ads_connections WHERE venue_id = '22222222-2222-2222-2222-222222222201');

INSERT INTO google_ads_connections (id, venue_id, customer_id, customer_name, status, status_reason, connected_at, last_error_at, last_error_message)
SELECT '66666666-0000-4000-8000-000000000002', '22222222-2222-2222-2222-222222222203', '771-204-3318', 'The Glass House', 'error', 'The refresh token was rejected', now() - interval '90 days', now() - interval '2 days', 'invalid_grant: token has been expired or revoked'
WHERE NOT EXISTS (SELECT 1 FROM google_ads_connections WHERE venue_id = '22222222-2222-2222-2222-222222222203');

INSERT INTO google_ads_connections (id, venue_id, customer_id, customer_name, status, connected_at)
SELECT '66666666-0000-4000-8000-000000000003', '22222222-2222-2222-2222-222222222204', '318-990-4412', 'Rose Hill Gardens', 'pending', NULL
WHERE NOT EXISTS (SELECT 1 FROM google_ads_connections WHERE venue_id = '22222222-2222-2222-2222-222222222204');

INSERT INTO meta_ads_connections (id, venue_id, ad_account_id, ad_account_name, token_env_key, status, connected_at, last_synced_at)
SELECT '66666666-0000-4000-8000-000000000011', '22222222-2222-2222-2222-222222222201', '100200300', 'Hawthorne Manor', 'META_ADS_ACCESS_TOKEN', 'connected', now() - interval '150 days', now() - interval '9 hours'
WHERE NOT EXISTS (SELECT 1 FROM meta_ads_connections WHERE venue_id = '22222222-2222-2222-2222-222222222201');

INSERT INTO meta_ads_connections (id, venue_id, ad_account_id, ad_account_name, token_env_key, status, status_reason, connected_at)
SELECT '66666666-0000-4000-8000-000000000012', '22222222-2222-2222-2222-222222222204', '100200304', 'Rose Hill Gardens', 'META_ADS_ACCESS_TOKEN', 'revoked', 'The venue disconnected it from the Meta side', now() - interval '200 days'
WHERE NOT EXISTS (SELECT 1 FROM meta_ads_connections WHERE venue_id = '22222222-2222-2222-2222-222222222204');

INSERT INTO meta_ads_connections (id, venue_id, ad_account_id, ad_account_name, token_env_key, status)
SELECT '66666666-0000-4000-8000-000000000013', '22222222-2222-2222-2222-222222222203', '100200303', 'The Glass House', 'META_ADS_ACCESS_TOKEN', 'pending'
WHERE NOT EXISTS (SELECT 1 FROM meta_ads_connections WHERE venue_id = '22222222-2222-2222-2222-222222222203');

INSERT INTO tiktok_ads_connections (id, venue_id, advertiser_id, advertiser_name, currency, token_env_key, status, connected_at, last_synced_at)
SELECT '66666666-0000-4000-8000-000000000021', '22222222-2222-2222-2222-222222222201', '7100200300400', 'Hawthorne Manor', 'USD', 'TIKTOK_ADS_ACCESS_TOKEN', 'connected', now() - interval '60 days', now() - interval '14 hours'
WHERE NOT EXISTS (SELECT 1 FROM tiktok_ads_connections WHERE venue_id = '22222222-2222-2222-2222-222222222201');

INSERT INTO tiktok_ads_connections (id, venue_id, advertiser_id, advertiser_name, currency, token_env_key, status)
SELECT '66666666-0000-4000-8000-000000000022', '22222222-2222-2222-2222-222222222202', '7100200300401', 'Crestwood Farm', 'USD', 'TIKTOK_ADS_ACCESS_TOKEN', 'pending'
WHERE NOT EXISTS (SELECT 1 FROM tiktok_ads_connections WHERE venue_id = '22222222-2222-2222-2222-222222222202');

INSERT INTO tiktok_ads_connections (id, venue_id, advertiser_id, advertiser_name, currency, token_env_key, status, status_reason, last_error_at, last_error_message)
SELECT '66666666-0000-4000-8000-000000000023', '22222222-2222-2222-2222-222222222203', '7100200300402', 'The Glass House', 'USD', 'TIKTOK_ADS_ACCESS_TOKEN', 'error', 'The advertiser id is not on this token', now() - interval '4 days', '40001: permission denied for advertiser_id'
WHERE NOT EXISTS (SELECT 1 FROM tiktok_ads_connections WHERE venue_id = '22222222-2222-2222-2222-222222222203');

INSERT INTO tiktok_ads_connections (id, venue_id, advertiser_id, advertiser_name, currency, token_env_key, status)
SELECT '66666666-0000-4000-8000-000000000024', '22222222-2222-2222-2222-222222222204', '7100200300403', 'Rose Hill Gardens', 'USD', 'TIKTOK_ADS_ACCESS_TOKEN', 'revoked'
WHERE NOT EXISTS (SELECT 1 FROM tiktok_ads_connections WHERE venue_id = '22222222-2222-2222-2222-222222222204');
