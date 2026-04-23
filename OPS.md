# Bloom House — Ops notes

Short notes on things you do operationally (outside of writing features).

## Secrets rotation

### CRON_SECRET

Protects `/api/cron` (Vercel cron schedule in `vercel.json`).

- **Rotate:** when a developer leaves, or if `vercel env` output
  might have been viewed by an unauthorized party, or quarterly as
  hygiene.
- **How:** `vercel env pull` to see current. Set new value with
  `vercel env add CRON_SECRET production`. Re-deploy. Delete the
  old value with `vercel env rm CRON_SECRET production` after
  confirming the new one works.
- **Blast radius if leaked:** attacker can manually trigger cron
  jobs (heat decay, email poll, digests). Can cause noise
  (extra email polls) but not destructive state changes on their
  own — crons operate on venue data but each job is idempotent.

### TEST_HARNESS_SECRET

Protects `/api/admin/test-harness` — destructive actions (apply_daily_decay,
record_engagement_event, process_incoming_email). Intentionally
SEPARATE from CRON_SECRET because the harness should default OFF
in prod.

- **Production default:** UNSET. Endpoint returns 501.
- **If you need it temporarily (prod ops):**
  1. `vercel env add TEST_HARNESS_SECRET production` (use a fresh
     random value, not CRON_SECRET)
  2. Redeploy
  3. Run the action
  4. `vercel env rm TEST_HARNESS_SECRET production`
  5. Redeploy again
- **Dev default:** falls back to `CRON_SECRET` when
  `NODE_ENV !== 'production'`. Just make sure `CRON_SECRET` is in
  `.env.local` and everything works.

## Migrations

### Normal flow (new migrations going forward)

1. Write `supabase/migrations/NNN_description.sql`
2. `node scripts/apply-migrations.mjs` — report mode, lists what's
   pending vs already applied
3. `node scripts/apply-migrations.mjs --apply` — interactive
   confirmation + apply in order + re-probe after
4. Commit the migration file
5. If the migration has a probe-worthy CHECK / policy that
   `CREATE TABLE` / `ADD COLUMN` parsing can't see, add a
   `-- @probe: insert_accepts table.col=value` directive so the
   script can verify it on future runs

### Historical gap: 3 duplicate-prefix files

030/031/032 each have TWO files with the same prefix (e.g.
`030_ceremony_chair_plans.sql` and `030_guest_tags.sql`). Supabase
CLI's `schema_migrations` tracking table uses the prefix as primary
key, so it can only record one of each pair. `supabase db push`
will always list those three as pending. Ignore — `apply-migrations.mjs`
probes actual artifacts instead of trusting the tracking table.

## Demo data hygiene

The 4 demo venues (Crestwood Collection) are meant to be
frozen-in-time. Set `venue_config.lost_auto_mark_days = 0` on all
demo venues so the daily 06:00 UTC heat_decay cron doesn't auto-lose
demo inquiries as they age past 30 days silent.

When running decay probes against prod, scope them to a test wedding
in a non-demo venue OR restore demo state immediately after. See
`scripts/e2e-data-flow-test.mjs --cleanup` for the test-data pattern.

## CI

GitHub Actions workflow at `.github/workflows/ci.yml`:
- `tsc --noEmit` — type check
- `npx tsx scripts/test-normalize-source.ts` — 44 cases
- `npx tsx scripts/test-booking-signal.ts` — 31 cases

Runs on push to master + PRs. Vercel runs `next build` on deploy
which catches TypeScript errors independently, but the unit tests
above are NOT part of the Vercel build — the Actions workflow is
the only gate for those.

### Not yet in CI

- Playwright e2e suite (`e2e/sections/*.spec.ts`) — needs Supabase
  anon/service keys as Actions secrets + a running dev server on
  port 3100. Runs manually.
- `scripts/e2e-data-flow-test.mjs` — runs against live prod Supabase
  via `TEST_HARNESS_SECRET`. Explicitly kept manual so it doesn't
  hit Claude + mutate prod on every push.
