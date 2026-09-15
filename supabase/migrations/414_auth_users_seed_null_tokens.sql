-- 414_auth_users_seed_null_tokens
--
-- Repair the auth.users rows the SQL seeds wrote by hand.
--
-- seed.sql, seed-demo-venue-surfaces.sql, seed-team-data.sql,
-- seed-team-tours-response.sql and run-all-remaining.sql INSERT INTO
-- auth.users directly. GoTrue's own createUser fills confirmation_token,
-- recovery_token, email_change, email_change_token_new and the two jsonb
-- metadata columns; the seeds left some or all of them out, so they
-- stored NULL. GoTrue scans those columns into non-null Go values, and
-- one such row in a page makes the whole page fail:
--
--   auth.admin.listUsers({ perPage: 200 })  ->  "Database error finding users"
--
-- On 2026-09-15 that was true on production and on the e2e project past a
-- page size of 10 (15 seeded rows, created 2026-03-27 and 2026-03-29).
-- findAuthUserByEmail (src/lib/api/auth-helpers.ts) pages at 200, so it
-- always errored and returned null, and every team invitation for an
-- address that already had an account took the create-a-new-user branch.
--
-- Idempotent. Only rows with a NULL in one of these columns change.
-- scripts/validate-seed-sql.ts now refuses a seed INSERT INTO auth.users
-- that omits them, so this does not come back.

UPDATE auth.users
   SET confirmation_token     = coalesce(confirmation_token, ''),
       recovery_token         = coalesce(recovery_token, ''),
       email_change           = coalesce(email_change, ''),
       email_change_token_new = coalesce(email_change_token_new, ''),
       raw_app_meta_data      = coalesce(raw_app_meta_data, '{"provider":"email","providers":["email"]}'::jsonb),
       raw_user_meta_data     = coalesce(raw_user_meta_data, '{}'::jsonb)
 WHERE confirmation_token IS NULL
    OR recovery_token IS NULL
    OR email_change IS NULL
    OR email_change_token_new IS NULL
    OR raw_app_meta_data IS NULL
    OR raw_user_meta_data IS NULL;
