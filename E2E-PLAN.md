# End-to-end plan (Playwright), designed 2026-09-14, run after wave 9

## Why design it before wave 9 lands

The design decides what the test database must hold, and preparing that database is an operator
step with lead time (a Supabase branch, migrations 395 to 412, seeds, secrets). Writing the
journeys now against the wave 9 head means the run can start the day wave 9 merges.

## What exists, and the one thing wrong with it

`e2e/` already holds 33 section specs (harness, auth and roles, couple invite, budget, email
pipeline, phase 1 to 8 acceptance, voice training, plan gating, Sage, knowledge-base uploads,
couple portal, RSVP, staffing, brain dump, attribution, demo isolation, identity resolution,
Stripe, Gmail OAuth, scope switcher, Knot dedup), six pending specs, seed helpers for couples,
emails, staff and voice training, an API login helper, and `generate-report.ts`, which turns the
JSON results and screenshots into one audit report. The last recorded run is from 2026-04-20.

The wrong thing: `playwright.config.ts` loads `.env.local`, which points at production, and
`e2e/helpers/seed.ts` builds a service-role client from whatever it finds there with no refusal.
Every seed and cleanup in the old suite therefore wrote to the production project. That is the
first fix, before any journey is written: the harness reads `.env.test`, refuses the production
project ref by URL the way `tests/golden/run-golden-cases.ts` does, and every helper goes through
that one client.

## Target environment

- Database: the golden branch (`.env.test`, project `ciwqxwohczzthvzqqgjx`), reset from
  production schema and then brought to migrations 395 to 412 with
  `npx tsx scripts/apply-pending-migrations.ts --env .env.test --apply` (storage half of 411 in
  the SQL editor if the runner cannot own `storage.objects`). Read-only proof it is right:
  `scripts/check-live-policies.mjs` against `.env.test` must print OK on every line, and
  `npm run check:schema-drift -- --env .env.test` must print "no drift". The pending list is
  hand-kept against production's history; on 2026-09-15 the branch passed it while missing
  17 tables and 40 columns (291, 304 to 310, 369 to 394 in part). Apply what drift names with
  `MIGRATION_ENV_FILE=.env.test npx tsx scripts/run-migration.ts <file> --skip-storage`
  (storage.objects policies are printed for the SQL editor; `supabase/308-storage-steps-for-sql-editor.sql`
  and `411-storage-steps-for-sql-editor.sql` hold them), `--continue` for the batch RLS
  migration 383 whose six retired tables never existed on the branch.
- Seed: the Crestwood demo set (`supabase/seed.sql` plus `seed-demo-rich.ts`,
  `seed-marketing-spend-records.sql`, `seed-commitments-demo.sql`, `seed-contracts-demo.sql`,
  `seed-ad-connections-demo.sql`), one real-shaped venue ("Ashcombe Barn", not a demo flag, with
  `onboarding_completed`), one org_admin, one coordinator, one manager, one couple invitation.
  Seeding is one script, `scripts/e2e-seed.ts`, dry by default, refusing production.
- Secrets on the branch env: `CRON_SECRET` (32 bytes), `CRON_SECRET_DESTRUCTIVE`,
  `STATE_SIGNING_SECRET`, `DEMO_SIGNING_SECRET`, Stripe test-mode webhook secret, a Calendly
  signing key of our own choosing, `RESEND_API_KEY` in Resend's test mode or the existing email
  capture helper, `PUBLIC_DEMO_ALLOWED_ORIGINS` for the snapshot test.
- Model calls: a stub. `src/lib/ai/client.ts` has no fixture mode today. Add `AI_E2E_STUB=1`
  that returns canned, schema-valid responses keyed by prompt version (recorded once from real
  calls, stored under `e2e/fixtures/ai/`), logs the cost row as usual, and refuses to run when
  `VERCEL_ENV=production`. One opt-in journey (`--grep @live-model`) calls the real model.
- App: `next build` then `next start` on port 3100 with the branch env, as the config already
  does for `E2E_USE_LOCAL`.

## Journeys (new sections 26 to 32)

Each journey is one spec file, screenshots at every named step, and a final assertion on the
console (no errors) and the network (no 4xx or 5xx that the step does not expect).

| # | Journey | Steps that must pass | Waves it proves |
|---|---|---|---|
| 26 | A coordinator's Monday | login; `/` lands on `/today`; the "since you were last here" strip; four blocks with links; "Import a file" on leads; upload the Dubsado fixture through `/admin/imports/upload`; the couple appears on leads and pipeline with a handle and a stage from the vocabulary; open the wedding page; the five collapsed sections (story, contracts, timeline, commitments, contract); assign a guest from the table map and see it on the guest list | W8, W35, W37, W42 to W45, W50, W53, W57, W61, W62, W63 |
| 27 | A couple's portal | invitation email captured; `/couple/<slug>/register` refuses without a token and accepts with one; forgot-password reachable and the reset mail captured; login; dashboard package summary; chat with a `contractId` (no `fileContext`), every reply ends with the sign-off, a 5,000-character message is refused; seating page; the day-outlook card; the contract link opens on `/join/contract/<token>`, signs once, refuses a second time, carries the frame-denying headers | W1, W43, W44, W52, W57, S4b, S5 |
| 28 | Intelligence, one number per question | Ask your data with the stubbed model: a grounded answer and a refusal (empty venue, sensitive theme); `/intel/monthly-story` numbers equal `/today` and the ROI page for the same question; sources page platform-shift card; benchmarks off by default with the switch named, on with demo peers; reviews import populates sentiment | W3, W12 to W15, W46 to W48, W52, W56, W64 |
| 29 | Security regressions | `/demo/api/**` is 404; a demo session is refused on every mutating route the guard lists; `POST /api/team/invite` without a session is 401 and with a coordinator session is 403; each of the eight trusted-id route groups returns 403 or 404 for another venue's id; an authenticated user cannot list another venue's contracts bucket; unsigned Stripe and Calendly deliveries are 503; the six security headers on every response; a CSV export escapes a `=1+1` guest; the preview route returns 429 after its limit; `curl` with `Bearer undefined` is refused | S1 to S5 |
| 30 | Venue 2 self-serve | org_admin invites a manager for Ashcombe Barn; the manager completes onboarding without a terminal (project steps, CRM import, packages, tour scheduler, web-form import); readiness writer flips; `scripts/isolation-battery.ts` against Crestwood and Ashcombe passes with zero cross-venue rows | W5, W38, the plan's week 4 and week 7 gates |
| 31 | Integrations hub honesty | every hub card reachable; Dubsado and Aisle Planner say import, not coming soon; the three ad platforms say "not configured" with the variables named; the sending-domain section shows DNS records after a stubbed Resend create; Instagram shows the webhook URL | W28, W54, W55, W53 |
| 32 | Public surfaces | `/api/public/demo-snapshot` with an allowed origin returns the fixed demo venue and refuses another origin; the wedding website with a site password via POST; the vendor portal token; `/join/contract` token expiry after 30 days (clock-shifted fixture) | W58, S1, S5 |

## Repair pass on the 33 existing sections

Before the new journeys run, the old ones are re-pointed at what the waves changed: `/` now
lands on `/today`; registration is invite-gated; `/demo/api` is gone; the demo identity is
refused on writes; `/org` and `/sage` are deleted; the couple timeline and contracts moved into
shared components; `sendEmail` takes a venue id; the pipeline stages come from the vocabulary.
Specs that test retired behaviour are deleted, not skipped, with the reason in the commit.

## Reporting and CI

`generate-report.ts` stays the output, extended with one row per journey step and the
screenshot path. In CI the suite runs as its own workflow on the branch env (the secrets above as
repository secrets), on demand and nightly, never on every push; the isolation battery job that
already exists in `ci.yml` moves under the same workflow.

## Sequencing

1. Now, in a worktree (W69): harness fix (env file, production refusal, one client), the AI stub,
   `scripts/e2e-seed.ts`, the seven journeys written against the wave 9 head, the repair pass.
   Static gate only: `tsc`, `playwright test --list`, the seed script's dry run.
2. Operator: reset the branch, apply 395 to 412, run the seed, set the branch secrets.
3. First run, then fix on find. The report is the deliverable.
4. Only then the plan's week 8 rehearsal: the golden journey twice on two venues.
