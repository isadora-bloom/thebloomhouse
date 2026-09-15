# Deploy Runbook

Operator steps for taking `consolidation` to production. Run these in
order, on your own machine. None of this runs in CI (see "Why the
preflight exists" below for why).

## 1. Preflight

```bash
npm run preflight
```

This is `scripts/deploy-preflight.mjs` (W71). It checks, read-only:

- **Git**: `master` is an ancestor of `consolidation` (a clean
  fast-forward), the working tree is clean, and `origin/consolidation`
  matches local.
- **Vercel link**: `.vercel/project.json` exists and actually points at
  the `the-bloom-house` team's `bloom-house` project (verified against
  the known production host, not just trusted at face value), and
  `vercel whoami` succeeds.
- **Secrets**: every production secret the code requires is present,
  and every one with an enforced minimum length is long enough. The
  required list is derived by reading `src/lib/cron-auth.ts`,
  `src/app/api/webhooks/stripe/route.ts`,
  `src/app/api/webhooks/calendly/route.ts`,
  `src/lib/services/integrations/oauth-state.ts` and
  `src/lib/services/demo-token.ts`. Never a hand-typed list, so a rename
  or a raised floor in those files is caught automatically.
- **Database**: a dry run of `apply-pending-migrations.ts` against
  production (d1), and schema drift (d2): every table and column the whole
  migration tree declares must be live, derived from the migrations and
  PostgREST's OpenAPI root, not from a hand-kept list. `npm run
  check:schema-drift` (add `--env .env.test` for the E2E project) prints
  the missing pieces and the ordered migrations to apply. Found 2026-09-15
  when the E2E project was 17 tables and 40 columns behind with d1 green.
- **Types**: whether `types.generated.ts` predates the newest migration
  (informational).
- **Governance**: the last `npm run check:governance` on this head.

It never prints a secret value, never writes one anywhere but a deleted
temp file, and never pushes or links anything on your behalf. A FAIL
means stop and fix that thing before going further. A WARN is
informational and does not block the deploy.

If it exits non-zero, stop here. Do not fast-forward master.

## 2. Fast-forward master and push

Once preflight is all PASS/WARN:

```bash
git checkout master
git merge --ff-only consolidation
git push origin master
```

Vercel's GitHub integration deploys `master` to production automatically
on push. Watch the deployment in the Vercel dashboard (or `vercel
inspect`) rather than assuming it went green.

## 3. Apply any pending migrations

If step 1 WARNed about absent migration markers, apply them before
anyone hits code that depends on the new schema:

```bash
npm run migrate:pending -- --apply --allow-prod
```

If a migration can't run through `exec_sql` (storage policy DDL needs
table ownership `exec_sql` doesn't have, same as migrations 308 and the
storage steps of 411), paste the relevant statements into the Supabase
SQL editor by hand. The one-file bundle for whatever is currently owed
is `supabase/PENDING-MIGRATIONS-2026-09-14.sql`, in dependency order.

## 4. Regenerate Supabase types

After migrations land, not before. The generated file has to describe
the schema migrations just created, not the one before them:

```bash
npx supabase gen types typescript --linked > src/lib/supabase/types.generated.ts
```

Requires `SUPABASE_ACCESS_TOKEN` in your environment. Commit the
regenerated file if it changed.

---

## Why the preflight exists

Two incidents, same root cause: a Vercel project link that pointed at
the wrong team and gave no sign of it.

- **isadoraandco**: `.vercel/project.json` was linked to the
  `isadoraandco` project under the wrong Vercel team (`isadoras-projects`
  rather than `the-bloom-house`), so every `vercel` command ran clean
  against a project nobody was looking at while the real production
  project drifted unmanaged.
- **bloom-house (2026-09-14)**: the same link-drift class recurred on
  this repo, and it hid what it was supposed to catch. `vercel env ls`
  answered without error while production was silently missing three
  required secrets (`CRON_SECRET_DESTRUCTIVE`, `STRIPE_WEBHOOK_SECRET`,
  `CALENDLY_WEBHOOK_SECRET`), and `CRON_SECRET` itself was 21 characters
  against the 32-character floor `src/lib/cron-auth.ts` enforces in
  production.

Neither failure looked like a failure. Both commands returned 0. The
preflight exists because "the CLI didn't error" is not the same claim as
"this is the right project", and nobody should have to remember to check
that by hand before every deploy.
