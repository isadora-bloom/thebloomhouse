# scripts/

Operational scripts: backfills, one-shot migrations, ad-hoc audits, smoke tests, and CI guards. Most are run with `npx tsx scripts/<name>.ts` (TypeScript) or `node scripts/<name>.mjs` (ESM). Many require a populated `.env.local` with `SUPABASE_SERVICE_ROLE_KEY` to read/write through service-role.

This file classifies every script into one of five buckets so you know which can be deleted without thinking, which to keep, and which need investigation before retiring.

**Closes Tier-B audit #78.** Originally framed as "prune one-shot scripts" — but bulk deletion is risky (some "one-shots" turn out to be re-runnable on new venues). Index-and-classify gives the same clutter-reduction value with no destructive risk; do passes per bucket as time allows.

## Quick-reference table

| Bucket | Count | Safe to delete? |
|---|---|---|
| Active tools | 11 | NO — referenced in package.json, OPS.md, ONBOARDING-PLAYBOOK.md, or wired into CI |
| Maintenance / ops | 14 | NO — re-runnable on new venues or recovery scenarios |
| Tests (smoke / regression) | 30 | Maybe — most are pre-vitest one-offs; see notes below |
| Backfills (completed) | 12 | YES — historical data is in place |
| Self-reviews (phase-bound) | 11 | YES — one-shot phase audits, work captured in commits |
| Onboarding-specific one-shots | 9 | YES once Rixey + demo are stable |
| Debug / inspect (one-shots) | 32 | Per-script judgment — most are dead |

## 1. Active tools (KEEP — referenced)

| Script | Referenced from | Purpose |
|---|---|---|
| `check-internal-links.mjs` | `package.json` `check:links` | CI link-checker |
| `apply-pending-migrations.ts` | docs / runbooks | Generic migration runner (use this, not `apply-094.ts`) |
| `apply-migrations.mjs` | docs / runbooks | ESM variant of the above |
| `audit-prod-migrations.mjs` | runbooks | Compare prod migration state to repo |
| `audit-rixey-readiness.mjs` | onboarding playbook | Pre-go-live check |
| `audit-table-writers.ts` | DATA-SOURCE-AUDIT.md | Find tables with no writer |
| `audit-couple-reads.ts` | OPS.md | Audit couple-portal reads against RLS |
| `data-integrity-check.ts` | OPS.md | 8-invariant integrity sweep |
| `onboard-data-cleanup.ts` | ONBOARDING-PLAYBOOK.md | Re-run on every new venue |
| `onboarding-readiness.ts` | ONBOARDING-PLAYBOOK.md | Pre-onboard validation |
| `sweep-browser-client.mjs` | bloom-house-launch-plan.md | Future regression check for browser-supabase consolidation |

## 2. Maintenance / ops (KEEP — re-runnable)

These run on demand for specific recovery or onboarding scenarios. Don't delete.

- `apply-pending-migrations.ts` — generic migration runner
- `check-migration-state.ts` — verify schema against migration files
- `dedup-engagement-events.ts` — fix-once-fire-once events; needed if dedup invariant trips
- `dedup-fire-once-events.ts` — sibling of above
- `import-rixey-policies.mjs` — KB seed for Rixey; pattern for any new venue
- `recompute-attribution-buckets.ts` — re-run after attribution rule changes
- `recompute-heat-after-reclassify.ts` — re-run after touch_type changes
- `recover-gmail-window.ts` — backfill missed inbound when Gmail polling fails
- `reparse-calculator-orphans.ts` — re-attach calculator submissions after parser fix
- `rerun-resolver.ts` — re-run candidate resolver on backfilled data
- `seed-demo-correlations.ts` / `.sql` — demo seeding (pre-prod separation)
- `seed-demo-rich.ts` / `seed-demo-rich-helpers.ts` — demo seeding extension
- `restore-test-wedding.ts` — recover a single test wedding from snapshot

## 3. Tests / smoke (most replaceable by vitest)

These predate the vitest unit-test setup. Each runs a real-data scenario against the live DB. As features mature, the corresponding logic should grow a vitest unit test and the script can retire. Audit by feature owner before deleting.

- `test-normalize-source.ts` ✓ referenced in OPS.md — KEEP for now
- `test-booking-signal.ts` ✓ referenced in OPS.md — KEEP for now
- `test-ai-cache.ts`, `test-audio-capture-omi.ts`, `test-bloom-number.ts`,
  `test-body-identity.ts`, `test-brain-regression.ts`, `test-calculator-parser.ts`,
  `test-calendly-parser.ts`, `test-cancellation-guard-integration.ts`,
  `test-circuit-breaker.ts`, `test-cohort-match.ts`, `test-cultural-moments-auto-propose.ts`,
  `test-digest-preferences.ts`, `test-essentials-level.ts`, `test-external-context.ts`,
  `test-heatmap-fix.ts`, `test-honeybook-lifecycle.ts`, `test-identity-windows.ts`,
  `test-insights-foundation.ts`, `test-logger.ts`, `test-metrics.ts`,
  `test-onboarding-backfill.ts`, `test-pricing-elasticity.ts`,
  `test-pulse-aggregator.ts`, `test-redact.ts`, `test-risk-flags-sanitize.ts`,
  `test-source-mix-counterfactual.ts`, `test-stage-simulator.ts`,
  `test-t1j-bandaids.ts`, `test-t3i-self-knowledge.ts`, `test-ww-parser.ts`
  — review each. Many are dead.

- `test-harness/` — directory of test fixtures; keep until referenced tests retire.
- `smoke-test-onboarding.mjs` — onboarding smoke; still useful for new-venue cutover.
- `e2e-data-flow-test.mjs` — full data flow smoke; keep through Wedgewood prep.

## 4. Backfills (DONE — safe to delete)

Every backfill below was a one-shot run after a schema change. The rows it filled are now in production; the script has no further job. Delete on next pass.

- `backfill-booking-vs-tour-timestamps.ts`
- `backfill-concat-couple-names.ts`
- `backfill-heat-scores.ts`
- `backfill-html-text.ts`
- `backfill-inquiry-dates.ts`
- `backfill-phase-b.ts`
- `backfill-rixey-history.ts`
- `backfill-scheduling-event-dates.ts`
- `backfill-scheduling-events.ts`
- `backfill-touchpoint-sources.ts`
- `backfill-touchpoints.ts`
- `apply-094.ts` (specific to migration 094 — generic `apply-pending-migrations.ts` replaces it)

## 5. Self-reviews (DONE — safe to delete)

Phase-bound audit scripts. The findings landed in commits and memory. Delete on next pass.

- `selfreview-attribution.ts`, `selfreview-backtrace.ts`, `selfreview-backtrace-cron.ts`,
  `selfreview-couple-side.ts`, `selfreview-create-time-backtrace.ts`,
  `selfreview-data-cleanup.ts`, `selfreview-journey.ts`, `selfreview-p4.ts`,
  `selfreview-phase-b.ts`, `selfreview-platform-signals.ts`,
  `selfreview-source-override.ts`, `selfreview-touchpoints.ts`,
  `selfreview-tour-temporal-ggg.ts`

## 6. Onboarding one-shots (delete after Rixey + demo are stable)

Scripts that targeted a specific event in the Rixey onboarding timeline. Once we're past whatever they were debugging, these can go.

- `cleanup-touchpoint-bugs.ts`
- `fix-event-types-and-past-tours.ts`
- `merge-and-clean-rixey.ts`
- `reattach-orphan-interactions.ts`
- `reclassify-direction-from-gmail.ts`
- `rixey-scoring-rescue.ts`
- `split-ww-conflated-weddings.ts`
- `update-doctrine-cells.ts`
- `verify-191-applied.mjs`

## 7. Debug / inspect (most are dead)

Ad-hoc scripts written to investigate a single bug. Almost all should go after one-by-one review.

- `dbg-anon-voice.ts`, `inspect-current-attribution.ts`,
  `fetch-scheduling-tool-history.ts`, `probe-prod-tables.mjs`,
  `report-parity-stats.mjs`, `run-bbb-parity-once.mjs`, `run-migration.ts`

## 8. CI guards (KEEP — likely run in pipelines)

- `check-adapter-source-justification.mjs`
- `check-html-stripped-at-writer.mjs`
- `check-no-browser-weddings-fetch.mjs`
- `check-no-coordinator-facing-created-at.mjs`
- `check-no-hardcoded-sage.mjs`
- `check-no-raw-err-logs-in-t3.mjs`
- `check-on-conflict-constraints.mjs`
- `check-plan-enforcement.mjs`
- `check-sage-disclosure-enforced.mjs`
- `check-signal-class-declared.mjs`
- `check-source-rendering.mjs`

## 9. Wipes (KEEP — destructive but re-usable)

- `wipe-real-data.mjs` — full real-data wipe (used in pre-prod cutover)
- `wipe-rixey-for-reonboard.mjs` — Rixey-specific
- `wipe-rixey-pipeline.mjs` — Rixey-specific
- `audit-inbox-timestamp-clustering.ts` — diagnostic

## Pruning checklist

When you're ready to delete a bucket:

1. Run `git log --oneline scripts/<file>` — look for the commit that made it; if it says "one-shot for X", it's safe.
2. `grep -r "scripts/<file>"` — make sure no doc, no other script, no package.json references it.
3. Delete with a single commit per bucket so rollback is easy: `git rm scripts/backfill-*.ts && git commit`.
