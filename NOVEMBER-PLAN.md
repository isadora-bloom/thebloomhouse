# November Plan (written 2026-09-08, deadline ~2026-11-08)

> Goal set by Isadora 2026-09-08: sign new venue clients and start onboarding them within
> two months. Move Rixey onto Bloom House. Phil is on the team. Static marketing demo stays.
> Custom domain later.
>
> This supersedes the pacing in REMEDIATION-PLAN-2026-07-07.md. That plan's R1 (the wipe)
> ran on 2026-09-08. CONSOLIDATION-PLAN-PHASED.md stays the architectural authority.
> The findings behind every item here are in memory `bloom-sep08-two-month-readiness`
> and in the 2026-09-08 session transcript. Nothing below is speculative; each item was
> found in code or on the live app today.

## The one sentence

The honest layer (one writer, six canonical readers, identity guards) is built. The visible
layer still reads around it, so the product gives three answers to one question. Fix =
route every visible number through the canonical layer, make the brain able to cite only
that layer, close the door on couple registration, make onboarding self-serve, and hide
everything not on the client path.

## Sequencing (what depends on what)

```
Wipe (done 09-08) -> finish interactions/people -> HoneyBook UI import (Isadora)
  -> re-merge -> Calendly replay -> Gmail backfill (hours) -> Knot CSVs -> gate + battery
Code workstreams W1..W10 run in parallel in worktrees, code only, no prod writes.
Integration: I merge branches -> tsc + vitest + governance -> Isadora FF master.
Battery on clean Rixey data is the gate for W2/W3 (readers + brain).
Venue-2 dry run (W5 output) is the gate for signing a client.
```

## Weeks

| Week | Focus | Gate |
|---|---|---|
| 1 (Sep 8-14) | Wipe + reimport on Rixey. P0 security. Demo repair. CI green. Fleet wave 1 lands. | Rixey data clean; CI green; couple invite is a real credential |
| 2 (Sep 15-21) | Canonical wiring of /intel surfaces. NLQ on tool-calling. Landing page for the morning. | One number per question on the four daily surfaces |
| 3 (Sep 22-28) | Battery >= 1.0 on clean data. Loops closed (crons registered, calibration fed back). | Battery avg >= 1.0, Tier 4 zero -3, Q26/Q37 fixed |
| 4 (Sep 29-Oct 5) | Venue-2 self-serve: readiness writer, cleanup UI, auto-send rules UI, hide scaffolds. | Fictional venue onboarded with no terminal |
| 5 (Oct 6-12) | Rixey couples onto the portal (invite real couples). Per-venue secrets where cheap. | First real couple logs in, resets a password, sees only their wedding |
| 6 (Oct 13-19) | Demo venue reseeded through linkSignal with a live clock. Billing enforcement (caps + trial). | Demo shows moving heat; a Solo venue hits its cap honestly |
| 7 (Oct 20-26) | Two-venue isolation battery. Phil's onboarding walkthrough with a friendly venue. | Zero cross-tenant reads; walkthrough completes |
| 8 (Oct 27-Nov 8) | Rehearsal, investor materials on measured numbers, freeze. | Golden journey passes twice on two venues |

## Wave 1 status (integrated 2026-09-08 evening, `consolidation` 51dcbac9)

All eleven workstreams (W1 to W11) merged. Gate on the integrated head: tsc 0, vitest
521/521, all twelve governance checks pass, links resolve, golden 15/15 valid, askIntel
grounding test passes. Migrations 391, 392, 393 dry-run clean on the prod snapshot branch.
W11 (added mid-wave) classified the 21 phantom tables and 62 phantom columns from
`scripts/check-schema-truth.mjs`; migrations 291/304/305/307/308/309/310 were never applied
to production and 394 is new. Remaining phantoms after the wave are exactly those unapplied
migrations plus the parked Meta connector.

## Workstreams and agents (wave 1, launched 2026-09-08)

Model rule: Haiku for mechanical sweeps, Sonnet for bounded code work, Opus for anything
that touches identity, the brain, or cross-cutting reads. Fable (this session) reviews,
integrates, and decides.

| # | Workstream | Model | Owns (files) | Migration no. |
|---|---|---|---|---|
| W1 | Couple registration security + password reset | Opus | `src/app/api/couple/register`, `src/app/api/portal/invite-couple`, `src/lib/services/portal/provision.ts`, `src/app/couple/[slug]/register`, `src/app/_couple-pages/login`, `src/lib/rate-limit.ts` (read) | 391 |
| W2 | Canonical read wiring of /intel + agent daily surfaces | Opus | `src/app/(platform)/intel/**` pages, `src/app/(platform)/agent/leads`, `/pipeline`, new `src/lib/intel/adapters/*`, new ratchet `scripts/check-no-new-legacy-reads.mjs` | none |
| W3 | NLQ brain on tool-calling over the six readers | Opus | `src/lib/ai/client.ts` (additive), new `src/lib/ai/tools.ts`, new `src/lib/intel/tools.ts`, `src/lib/intel/canonical.ts` (askIntel only), `src/lib/services/brain/intel-brain.ts`, `scripts/run-battery.ts` (retarget) | none |
| W4 | Demo repair | Sonnet | `src/middleware.ts` demo branch, `src/lib/services/demo-token.ts`, `src/lib/api/auth-helpers.ts` demo consts, `src/lib/hooks/use-couple-context.ts` demo consts, `supabase/seed*.sql` demo fixes, new `scripts/demo-repair-*.mjs` (dry-run default) | 392 |
| W5 | Venue-2 self-serve onboarding | Sonnet | `src/lib/services/onboarding/**`, `src/app/(platform)/onboarding/**`, `src/app/api/onboarding/**`, `src/app/(platform)/agent/settings` (auto-send rules), `src/lib/services/crm-import/index.ts` (adapter visibility only) | 393 |
| W6 | Close the loops | Sonnet | `src/app/api/cron/route.ts` (dispatch only), `vercel.json`, `src/lib/services/calibration/**`, `src/lib/services/intel/per-couple-derive.ts`, `src/lib/services/marketing-spend/loop/**`, `src/lib/services/voice-dna/sweep.ts` | none |
| W7 | CI and governance green + typed DB | Haiku | `.github/workflows/ci.yml`, `scripts/cleanup-budget.json`, `scripts/check-*.mjs` (baselines), `src/lib/services/couple-portal/seating-import.ts:406`, `src/lib/ai/alert-fallback.ts`, `src/lib/supabase/types.ts` + `types.generated.ts` | none |
| W8 | UX for non-technical clients: the morning landing | Opus | new `src/app/(platform)/today/**`, `src/components/shell/nav-config.ts` (Essential rail + landing), `src/components/ui/*` additive, `src/app/(platform)/page.tsx` | none |
| W9 | Hygiene: orphans, legacy nav, doc truth | Haiku | `src/components/shell/nav-config.ts` (legacy entries only, coordinate with W8), `SITEMAP.md`, `CLAUDE.md`, `MONDAY-START-HERE.md`, `src/lib/intel/canonical.ts` header comment, stale plan banners | none |
| W11 | Schema truth: phantom tables/columns classified and fixed (added mid-wave) | Sonnet | files outside other workstreams' ownership | 394 |
| W10 | Ingestion health + missing signals | Sonnet | `src/lib/services/intel/pulse-aggregator.ts`, `src/lib/services/ingestion-volume-monitor.ts`, `src/app/api/portal/sage/route.ts` (alert emission only), `src/lib/services/identity/replay/reviews.ts`, new `scripts/diag-honeybook-drop.mjs` (read-only) | none |

Shared rules for every agent:
- Work in your worktree only. Do not touch files owned by another workstream. If you must,
  write the change as a patch note in your report instead.
- No database writes. `.env.local` points at production. Do not run any script that
  connects to Supabase except read-only diagnostics you wrote yourself and that refuse
  `--apply`. Unit tests and `tsc` only.
- Before committing: `npx tsc --noEmit` clean, `npx vitest run` green, and your change must
  not raise any ratchet in `npm run check:cleanup-budget` / `check-swallowed-writes`.
- Stage explicit paths. Never `git add -A`.
- Plain English, British spelling, no em dashes, in code comments and commit messages.
- End your report with WHERE TO LOOK (files, routes) and WHAT TO TEST (static now vs needs
  the database), per the standing handoff convention.

## Security audit and remediation (2026-09-14, after the plan audit)

Six read-only auditors (unauthenticated surface, tenant isolation, chatbots and LLM chains,
integrations and OAuth, injection and files, secrets and config) and six fix workstreams S1 to S5,
all merged the same day. Findings, status and what is still open: `SECURITY-AUDIT-2026-09-14.md`.
The two things that matter most are operator actions: the production service-role key was
committed to this public repository (rotate it), and `CRON_SECRET` is a guessable literal that
also signs OAuth state (rotate, and set the four companion secrets before master moves).

Plan-audit verdict (nine verifiers over W1-W61): every workstream is built and wired as claimed,
with the gaps fixed in 88bece9d/e5c2e449/6d923d31, except the headline goal itself: the visible
layer still reads the legacy tables in 255 places and two of the four daily surfaces read
`weddings` directly. Proposed wave 9: finish W2 (canonical wiring of `/intel/**`, `/agent/leads`,
`/agent/pipeline`), plus the security follow-ups listed in the audit document.

## Operator items (Isadora), current as of 2026-09-14 evening

- [ ] **SECURITY FIRST (see SECURITY-AUDIT-2026-09-14.md):** rotate the Supabase service-role key;
  rotate `CRON_SECRET` (32 random bytes); set `CRON_SECRET_DESTRUCTIVE`, `STATE_SIGNING_SECRET`,
  `STRIPE_WEBHOOK_SECRET`, `CALENDLY_WEBHOOK_SECRET` in Vercel production. The merged code refuses
  cron jobs, OAuth connects and both webhooks without them, so this comes before the master FF.
- [ ] **Deploy, in this order (`docs/DEPLOY.md`):** `npm run preflight` must pass; then the four
  secrets (rotate `CRON_SECRET` to 32 random bytes, add `CRON_SECRET_DESTRUCTIVE`,
  `STRIPE_WEBHOOK_SECRET`, `CALENDLY_WEBHOOK_SECRET`; the classifier blocks me from writing them);
  then master FF + push (I do it); then the bundle `supabase/PENDING-MIGRATIONS-2026-09-14.sql`
  in the SQL editor (23 files); then `node scripts/check-live-policies.mjs`; then the types
  regeneration (I do it); then `npx tsx scripts/demo-reseed.ts --apply --allow-prod` once so the
  demo spine exists on production (W70 found touchpoints, progression events and fragments at
  zero rows for all four demo venues).
- [ ] **Test branch for the e2e run (`E2E-PLAN.md`, W69 and W70 reports):** reset, migrate with
  `--env .env.test`, `check-live-policies --env .env.test`, `e2e-seed.ts` dry then `--apply`
  (capture the printed credentials), `demo-coverage.ts --live --env .env.test`, branch secrets.
- [ ] **RECONNECT GMAIL.** `gmail_connections` for Rixey has been `status=error`
  ("Token refresh failed") since **2026-07-24**. Settings → Gmail → Connect. Nothing else replaces it.
- [ ] Fast-forward `master` to `consolidation` (129+ commits: waves 1 to 7 gated and pushed).
- [ ] Prod migrations, one run: `npm run migrate:pending` (dry) then
  `npm run migrate:pending -- --apply --allow-prod` (395, 397, 398, 399, 400, 401, 402, 403, 404, 406, 407, 408, 409, 410, 411;
  411's storage half may need the Supabase SQL editor, `scripts/check-live-policies.mjs` shows before and after). Then the older six with `--include-legacy`, 308 in the
  SQL editor. Then `npx tsx scripts/gen-wedding-fk-tables.ts` (read-only, regenerates the cascade
  list so 406 stops being "pending") and the types regeneration `check-types-fresh` asks for.
- [x] Test branch (`.env.test`) brought to 395-403 on 2026-09-14; golden 16/16 wet. Re-run
  `apply-pending-migrations.ts --env .env.test --apply` after each wave adds migrations.
- [ ] Decide Rixey's Google Trends metro: `venues.google_trends_metro` is `US-VA-584` (Richmond),
  copied onto three venues; Rixey's market is DC, `US-DC-511`. One UPDATE if you agree.
- [ ] Apply `supabase/seed-marketing-spend-records.sql` to the demo project so Crestwood's ROI column
  stops being blank (W52 finding: the legacy `marketing_spend` was seeded, the table attribution
  reads never was).
- [ ] Do NOT re-enable auto-send until the reimport is complete (all four rules `enabled=false`).
- [ ] Download a fresh HoneyBook "Booked clients" report (newest on disk ends Jun 2026), then the
  reimport sequence below.
- [ ] Meta app credentials for Instagram DMs; ad-platform app credentials when W54 lands
  (each connector documents its variables); Resend domain per venue when W55 lands.
- [ ] Marketing-site repos: the "Your Instagram (optional)" field.
- [ ] Decide: fix Hawthorne's `venue_config.business_name` by SQL (one line, I will give it).
- [ ] Decide: delete the two May snapshot branches to save cost, keep `pre-phase2-2026-09-08`.
- [x] Migrations 391-394 applied to prod 2026-09-09.
- [x] `phase2-wipe-finish.mjs` run 2026-09-08.

## Reimport steps (I run, after the finisher)

1. HoneyBook (UI, Isadora) or `scripts/phase2-run-honeybook-import.ts`
2. `scripts/phase2-remerge-operator-columns.mjs --apply --allow-prod`
3. `npx tsx scripts/phase2-replay-calendly.ts`
4. `scripts/phase2-trigger-gmail-backfill.mjs --apply --allow-prod` (cron drains, hours)
5. `scripts/phase2-run-knot-visitor-import.ts --apply --allow-prod`
6. Re-merge danger exports (draft_feedback 1 row, discovery_sources 3) by hand
7. Gate: spine sane, point_zero stamped, battery run, golden 15/15

## Everything has a wave now (2026-09-14)

Per Isadora: nothing stays parked indefinitely. Every item that used to sit under "Parked
until after November" is now a real workstream in wave 8, with a model, an owner, and either
a build-now scope or a named trigger condition (not a shrug). See wave 8 below.

## Wave 2 (launched 2026-09-09 morning)

Wave 1 closed the confabulation class: Ask your data can only state a number a tool
returned. The cost is about twenty battery questions now get an honest refusal even though
the data is in the database. Wave 2 turns each of those into a tool source behind the
plug-in contract in `src/lib/intel/tool-sources/`, and pulls forward the independent
code work from weeks 4 to 6 that does not need the reimport to land first.

State going in: `consolidation` 1134261f, master not yet fast-forwarded, migrations 392 and
394 applied to prod on 2026-09-09, then 391 later the same evening, 393 a no-op (thresholds
already 85). Gmail still disconnected. Rixey reimport paused. Two live SMS inquiries have
been minted since the wipe (identity resolver, 2026-09-09), so Rixey is not at zero rows.

| # | Workstream | Model | Owns (files) | Battery |
|---|---|---|---|---|
| W12 | Tool sources: time series + operator patterns | Opus | new `src/lib/intel/tool-sources/time-series.ts`, `operator-patterns.ts`, their tests, one line each in `tool-sources/index.ts` | Q1 Q7 Q11 Q12 Q14 Q22 Q23 Q24 |
| W13 | Tool sources: built but unexposed (ghost risk, completeness, identity precision, signals) | Opus | new `tool-sources/ghost-risk.ts`, `completeness.ts`, `identity-precision.ts`, `signals.ts`, tests, index lines | Q6 Q19 Q25 Q28 Q29 Q30 Q36 |
| W14 | Tool sources: reviews, lost deals, weather x tours, open Saturdays and pace | Sonnet | new `tool-sources/reviews.ts`, `lost-deals.ts`, `weather-tours.ts`, `capacity.ts`, tests, index lines | Q10 Q39 Q40 Q41 |
| W15 | Tool sources: drafting + follow-up state (proposal only, no writes) | Opus | new `tool-sources/follow-ups.ts`, tests, index line; pure compose path split out of `src/lib/services/cohort/bulk-follow-up.ts` if needed | Q34 Q37 |
| W16 | Coordinator-facing "Sage" literals onto the AI-name provider; subdomain couple layout provider | Sonnet | the 24 literal sites under `src/app/(platform)/**` and `src/components/**`, `src/app/_couple-pages/**` layout only | none |
| W17 | Honest errors on the daily surfaces: heat fetch errors on /agent/leads, tour times in venue timezone, inbox send failures not swallowed | Sonnet | `src/app/(platform)/agent/leads/page.tsx`, `src/app/(platform)/today/**`, `src/app/(platform)/intel/tours/**`, `src/app/api/inbox/**`, `src/lib/services/inbox/**` | none |
| W18 | Billing enforcement: real plan tier, honest tierHasFeature, capacity caps, trial expiry, dunning cron verified | Sonnet | `src/lib/services/billing/**`, `src/app/(platform)/settings/billing/**`, `src/app/api/billing/**`, cap-hit UI | none |
| W19 | Demo reseed through linkSignal with a live clock (DEMO-RESEED-DESIGN.md) | Opus | new `scripts/demo-reseed.ts` + `scripts/demo-reseed/**`, tests; dry-run default | none |
| W20 | HoneyBook parents and planners imported as Agent-class people, not dropped | Opus | `src/lib/services/crm-import/**` (HoneyBook adapter + person linking), tests | none |
| W21 | `npm run lint` works again on Next 16 (eslint CLI), wired into CI | Haiku | `package.json` lint script, `eslint.config.*`, `.github/workflows/ci.yml` lint step only | none |

Integrator (this session): wire `TOOL_SOURCES` into `CANONICAL_TOOLS` and the dispatcher in
`src/lib/intel/tools.ts`; rewrite `CANONICAL_TOOL_SCOPE_SUMMARY` and prune
`OUT_OF_SCOPE_SUBJECTS` (weather, reviews, lost deals leave the list once W14 lands); add
ground-truth probes in `scripts/battery-ground-truth.ts` for every question a new source
covers; gate (tsc, vitest, governance, links, golden); push `consolidation`; Isadora FF master.

Same shared rules as wave 1. Two additions: every worktree starts with
`git reset --hard consolidation` (the worktree tool may fork from master) and `npm ci`; and
no tool source may read a legacy table where the spine (`couples`, `touchpoints`) holds the
same fact.

## Wave 2 status (integrated 2026-09-09 evening)

All ten workstreams merged on `consolidation`. Gate on the integrated head: tsc 0, vitest
green (see the commit for the count), all governance and guard scripts green including
plan-enforcement, which had been red on master since the wave-1 canonical routes landed
without `requirePlan`. Lint runs again on the eslint CLI.

What Ask your data can now answer, all from tool results: 14 new tools across time series,
operator patterns, ghost risk, record completeness, identity precision, conversion signals,
reviews, lost deals, weather against tours, prime Saturday capacity, follow-up state and
follow-up proposals. The battery judge reads every registered source as ground truth.
Every rate still comes back `enoughData: false` on Rixey until the reimport lands.

Migrations owed to prod, in this order: 395 (billing `trial_ends_at`), 397 (drop the
`'Sage'` default on `venue_ai_config.ai_name`). Then the older seven.

Fixed on find during integration (no workstream owned the file): cohort loader read
`venues.timezone` (does not exist) and counted merged couples; mark-as-lost wrote the
weddings vocabulary into `lost_deals.lost_at_stage` and failed its CHECK on every loss after
inquiry; `/intel/lost-deals` read three phantom columns and saved without `venue_id`;
`/agent/pipeline` zeroed heat on a failed read; the subdomain couple portal had no floating
assistant; demo-repair refused its own dry run against prod.

Follow-ups carried to wave 3:
- Q37 link 1: "tours this weekend" in the past tense has no tool; `get_daily_list` is
  forward-only. Needs a tour-cohort tool with a date range.
- `findUngroundedClaims` name sweep: every W13 source returns `names` keys, so a ghost-risk
  call in the same turn as an empty tour bucket unlocks the proper-noun check. Decide whether
  the escape should be per tool.
- `reviews-analytics.ts` has no injectable client, so W14 re-derived its numbers; give it a
  seam and collapse the two.
- `propose_follow_ups` records `phrase_usage` and a cost row when it composes; decide whether
  a read tool may do that.
- `wedding_relationships.relationship_role` gained `parent`; widen the migration-255 comment.
- `/intel/tours` upcoming/this-year filters still use browser local time.
- `SAGE_DEFAULTS.ai_name` in `brain/sage-identity.ts` is still `'Sage'`.
- `supabase/seed.sql` writes `weddings.heat_score` and `temperature_tier`, dropped in 316.
- `DEMO-RESEED-DESIGN.md` §4 step 3: mint the wedding before the first signal, not after
  the tour (W19 found the mirror upsert requires it).
- Lint: `react-hooks/rules-of-hooks` is downgraded to warn for one site; fix the site and
  restore the rule.
- Demo reseed is built and tested but has NOT been run against prod; operator step:
  `npx tsx scripts/demo-reseed.ts` (dry run) → `--apply --allow-prod` → `--verify`.

## Wave 3 (launched 2026-09-09 night): handles on the spine

Isadora, 2026-09-09: tracking every touchpoint from the first Instagram follow through to the
review is THE most important thing. Spec: `HANDLE-IDENTITY-SPEC.md`. Contract landed before
launch: `NormalizedSignal.handles`, `HandlePlatform`, `normalizeHandle()`, migration 398.

| # | Workstream | Model | Owns (files) |
|---|---|---|---|
| W22 | Handle as identifier: cascade stage, matcher, linker stamping of `couples.handles` + `first_seen_at`, fragment promotion by handle, merge_couples carries handles, ratchet on `people.platform_handles` reads | Opus | `src/lib/services/identity/identity-cascade.ts`, `matcher.ts`, `forwards-linker.ts`, `tier-routing.ts`, `mint-couple.ts`, `point-zero.ts` (first_seen only), new `fragment-sweep.ts`, `merge-couples*`, `lifecycle-audit.ts` (invariant), new `scripts/check-no-platform-handles-reads.mjs`, golden case |
| W23 | Social captures through linkSignal: followers/story/DM list and screenshot rows become signals; delete the auto-bind fallbacks; social branch of orphan-promote goes | Opus | `src/lib/services/social/**`, `src/app/api/intel/social-integration/**`, `src/lib/services/identity/orphan-promote.ts` (social branch only), `src/lib/services/identity/replay/social.ts` (new) |
| W24 | Tangential pool collapses into fragments and candidate_matches; vision comment/tag candidates route through linkSignal; `client_match_queue` retires | Opus | `src/lib/services/ingestion/tangential-signals.ts`, `identity-enqueue.ts`, `src/lib/services/identity/candidate-clusterer.ts`, `candidate-resolver.ts` (handle emit only), `handle-convergence.ts`, admin routes that read those tables |
| W25 | Ask for the key: optional handle field on the inquiry form adapter, calculator, Calendly question mapping; email signature/body handle extraction through the existing extraction path plus profile-URL parse | Sonnet | `src/lib/services/crm-import/web-form.ts`, `src/lib/services/identity/calendly-to-signal.ts`, `email-to-signal.ts`, `src/lib/services/extraction.ts` (handles only), `src/config/prompts/*identity*`, the public form components |
| W26 | Tracer retires: coalesce moves under the linker as the nightly fragment sweep; `tracer.ts`, `backtrack.ts` dead paths removed; cron dispatch updated | Sonnet | `src/lib/services/identity/tracer.ts`, `tracer-runner.ts`, `backtrack.ts`, `src/app/api/cron/route.ts` (dispatch lines only), `vercel.json` |
| W27 | The ribbon shows it: getCoupleJourney and the couple page render first seen, handles, discovery vs known phases; identity-precision tool and journey adapter read `couples.handles` | Sonnet | `src/lib/intel/canonical.ts` (getCoupleJourney only), `src/lib/intel/adapters/**`, `src/app/(platform)/intel/couples/**`, `src/lib/intel/tool-sources/identity-precision.ts` |
| W28 | Instagram DMs via the Meta Messaging API into the SMS-shaped pipeline; env-gated, webhook verified, dry until credentials | Opus | new `src/lib/services/ingestion/instagram-dm.ts`, new `src/app/api/webhooks/instagram/route.ts`, `src/lib/services/integrations/**` (Meta only), settings page for the connection |

Shared rules as wave 1, plus: every worktree starts with `git reset --hard consolidation`
and `npm ci`; the only writer is `linkSignal`; `people.platform_handles` is read-only and
on its way out; a handle is always `(platform, handle)` through `normalizeHandle()`.
Migration numbers: 398 (contract, landed). W23/W24 may need 399/400 for retiring tables
(mark deprecated, do not drop).

## Wave 3 status (integrated 2026-09-11)

All seven workstreams merged on `consolidation`. Gate on the integrated head: tsc 0, vitest
965/965, governance green including the new `check:platform-handles` ratchet (36 reads left,
down from 51), every guard script green, golden 16/16 (GC-16 = follow → fragment → email →
mint → promote, first_seen_at at the follow), lint exits 0.

What is true now: a handle is `(platform, handle)` on the signal, `handle_exact` is a
high-tier cascade stage, `couples.handles` and `first_seen_at` are stamped by the linker, a
later signal promotes matching fragments deterministically, followers/story/DM pastes and
vision comment/tag candidates go through `linkSignal`, the trigram and email-local-part
auto-binds are deleted, the tangential pool and `client_match_queue` are retired, the tracer
orchestrator is retired into a nightly `fragment_sweep` cron, the inquiry CSV, Calendly and
email extraction can carry a handle, the couple page shows Discovery / Point zero / Known
couple with handle chips, and Instagram DMs have a webhook and settings page waiting on Meta
credentials.

Integration notes: W22 and W23 both numbered a migration 399; W22's `merge_couples` change is
now 402. Three branches each wrote `fragment-sweep.ts`; the merged result is W26's
orchestrator in `fragment-sweep.ts` calling W22's promotion in `fragment-sweep-handles.ts`,
with `sweepFragmentsForCouple` bridging W24's caller.

Migrations owed to prod, in order: 395, 397, 398, 399, 400, 401, 402. Then the older seven.

Follow-ups for wave 4:
- `email/pipeline.ts` does not yet pass extracted handles into `emailToNormalizedSignal`; W25
  built the extraction, the five call sites still need the one argument.
- `crm-import/index.ts` (web-form and calculator CSVs) mints via `mintWedding`, so the handle
  it captures lands on `interactions.extracted_identity`, not `couples.handles`, until that
  adapter moves onto `linkSignal`.
- Instagram DMs land on the spine but not in `/agent/inbox` and the classifier does not run
  on them; `buildInstagramInteractionRow()` is ready when the interactions writer lands.
- No public inquiry form or calculator component lives in this repo; the "your Instagram"
  field must be added on the marketing-site repos and mapped to the `instagram` column.
- `merge-people.ts` still updates the retired `client_match_queue`; one-line delete.
- `/api/intel/social-integration/captures/[captureId]` has no page; the modal link was removed.
- First-seen dates derived from screenshot relative ages are approximate; label them so.
- Meta app setup steps are in W28's settings page and its report.

## Wave 4 (launched 2026-09-11): close the handle journey end to end

Migrations are NOT applied between waves. One runner applies everything owed, in order, at the
end: `npm run migrate:pending` (dry run with read-only probes) then
`npm run migrate:pending -- --apply --allow-prod`; add `--include-legacy` for the older six.
308 still needs the SQL editor (storage policies).

| # | Workstream | Model | Owns (files) |
|---|---|---|---|
| W29 | Handles reach the couple from every live path: email pipeline passes extracted handles into the signal; CSV import (web form, calculator, HoneyBook) merges handles onto the mirrored couple after mint | Opus | `src/lib/services/email/pipeline.ts` (the emailToNormalizedSignal call sites + extraction call), `src/lib/services/crm-import/index.ts` (post-mint handle merge only), `src/lib/services/identity/route-by-tier.ts` (export only if needed) |
| W30 | Instagram DMs reach the inbox and the classifier through the same interactions chokepoint SMS uses; reply plumbing stubbed to the Graph send endpoint behind the same env gate | Sonnet | `src/lib/services/ingestion/instagram-dm.ts`, the SMS interactions writer it reuses (read the OpenPhone sync to find it), `src/app/api/webhooks/instagram/route.ts`, inbox filters for type/channel |
| W31 | Ribbon and social hygiene: approximate first-seen dates labelled on the couple page; a capture detail page at `/intel/social-integration/captures/[id]`; `/intel/tours` upcoming/this-year filters in venue time; `merge-people.ts` stops touching the retired queue | Sonnet | `src/app/(platform)/intel/couples/**` (labels only), `src/app/(platform)/intel/social-integration/**`, `src/app/(platform)/intel/tours/page.tsx`, `src/lib/services/identity/merge-people.ts` |
| W32 | Q37 link 1: a `get_tour_cohort` tool source with an explicit date range (past or future), so "everyone I toured this weekend" starts from the right list; battery ground truth follows automatically | Sonnet | new `src/lib/intel/tool-sources/tour-cohort.ts` + test + one line in `tool-sources/index.ts` |
| W33 | Fix the 20 React Compiler sites and restore the five rules to error; fix the one rules-of-hooks site | Haiku | the files eslint names, `eslint.config.mjs` |
| W34 | `reviews-analytics.ts` gains an injectable client and W14's `reviews.ts` tool source calls it instead of re-deriving; `propose_follow_ups` no longer records `phrase_usage` when composing a proposal (a read tool must not write a ledger) | Sonnet | `src/lib/services/intel/reviews-analytics.ts`, `src/lib/intel/tool-sources/reviews.ts`, `src/lib/ai/phrase-selector.ts` (a no-record flag), `src/lib/services/cohort/bulk-follow-up.ts` (pass the flag) |

Out of this repo: the "Your Instagram (optional)" field on the public inquiry form and the
calculator lives in the marketing-site repos; map it to the `instagram` CSV column W25
defaulted. Meta app credentials for W28 are an operator step.

Shared rules as wave 3. Every worktree starts with `git reset --hard consolidation` and
`npm ci`. linkSignal is the only spine writer. No database writes.

## Wave 4 status (integrated 2026-09-11)

All six workstreams merged on `consolidation`. Gate on the integrated head: tsc 0, vitest
1036/1036, governance green, every guard green, golden 16/16, links OK, lint 0 errors with
the six React Compiler rules back at error.

What is true now: an inbound email's profile URL lands on `couples.handles` and a venue reply
never does; a CSV row's handle is merged onto the mirrored couple with conflicts counted and
queued; an Instagram DM reaches `/agent/audio-inbox` and the classifier through the same
chokepoint SMS uses, labelled by handle, with replies stubbed until Meta credentials exist;
`get_tour_cohort` answers past windows and the name gate covers it; first-seen dates from
screenshot ages read "about 3 weeks before" rather than a false date; the capture detail page
exists; tour filters use venue time; the reviews tool calls the analytics service instead of
re-deriving; a proposal no longer writes `phrase_usage`; `normalizeHandle` rejects page
segments and unknown platforms instead of storing or throwing.

Migrations owed to prod, all at once: `npm run migrate:pending` then
`npm run migrate:pending -- --apply --allow-prod`. Then `npx tsx scripts/replay-social-to-spine.ts`
(dry run, then `--apply --allow-prod`) to put existing follower captures on the spine.

Follow-ups for wave 5:
- `nowMs()` in `src/lib/utils/clock.ts` satisfies the purity rule by hiding `Date.now()` behind a
  function; "ago" labels are now read once per mount. Fine for pages, wrong for a tab left open
  all day. A ticking clock hook is the honest fix.
- CSV adapters (web form, calculator, HoneyBook) still mint through `mintWedding`; the handle
  stamp works around it. Moving them onto `linkSignal` closes the last legacy writer on intake.
- A venue's own social handle can stamp a couple if a prospect pastes the venue's link above
  the quote line; add `venue_config` social handles and exclude them.
- A dated CSV row without a handle does not set `first_seen_at`; decide whether it should.
- Instagram outbound replies: `sendInstagramReply` is a refusing stub with the Graph endpoint
  named; needs the Meta app and a send path through the same disclosure guard as email.
- Marketing-site repos: add "Your Instagram (optional)" to the inquiry form and calculator,
  mapped to the `instagram` CSV column.
- Two lifecycles (six spine states vs the thirteen-stage wedding machine) remain unreconciled.

## Wave 5 (launched 2026-09-12): finish what can be finished without data

Isadora, 2026-09-12: the Rixey reimport waits until as much of the plan as possible is built.
No migrations between waves; `npm run migrate:pending` at the end.

| # | Workstream | Model | Owns (files) |
|---|---|---|---|
| W35 | Intake onto the one writer: the CSV adapters (web form, calculator, HoneyBook) commit through `linkSignal` instead of `mintWedding`, so couples, handles and first-seen are stamped by the spine itself; legacy wedding row still produced for the surfaces that read it | Opus | `src/lib/services/crm-import/index.ts` (commit path), `src/lib/services/crm-import/related-contacts.ts`, `src/lib/services/identity/link-with-lifecycle.ts`, tests |
| W36 | The venue's own handles and a ticking clock: `venue_config` social handles (migration 403) shown in settings and excluded from stamping; a `useNow()` hook replacing the once-per-mount `nowMs()` reads on pages with "ago" labels | Sonnet | new migration 403, `src/app/(platform)/settings/**` (one section), `src/lib/services/identity/handles.ts` (an exclusion helper), `src/lib/utils/clock.ts`, the nine files W33 touched for purity |
| W37 | One lifecycle vocabulary: define the mapping from the thirteen-stage wedding machine to the six spine states, an audit that reports disagreements per couple, and one status pill used by the couples list, the pipeline and the couple page | Opus | `src/lib/services/lifecycle/**`, `src/lib/services/identity/lifecycle-audit.ts`, `src/lib/services/identity/status-pill.ts`, `src/lib/copy/client-terms.ts` (terms), the three surfaces' pill components |
| W38 | Two-venue isolation battery: a script that, given two venue ids, calls every canonical reader, every tool source and every scope-aware route with each venue and asserts zero rows from the other; runnable against a test branch; CI job wired but skipped without credentials | Sonnet | new `scripts/isolation-battery.ts`, `tests/isolation/**`, `.github/workflows/ci.yml` (one job) |
| W39 | Hide everything not on the client path: audit `src/components/shell/nav-config.ts` and the 183 platform pages against the plan's four daily surfaces plus settings; pages with no nav entry and no client purpose get a `notFound()` behind a `SCAFFOLD_PAGES` flag; SITEMAP regenerated; orphan count in the plan | Sonnet | `src/components/shell/nav-config.ts`, `SITEMAP.md`, `scripts/gen-sitemap.mjs`, a new `src/lib/scaffold-gate.ts`, the orphan pages themselves (gate line only) |
| W40 | First-seen from any dated intake row (not only rows with a handle), and the daily surfaces off legacy: `/agent/leads`, `/agent/pipeline`, `/intel/sources` still read `weddings` directly; move those reads onto the canonical readers or the spine and ratchet `legacy-reads-baseline.json` down | Sonnet | `src/lib/services/crm-import/index.ts` (first-seen block only, coordinate with W35 by touching only `firstSeenCandidateFor`), `src/app/(platform)/agent/leads/page.tsx`, `src/app/(platform)/agent/pipeline/page.tsx`, `src/app/(platform)/intel/sources/page.tsx`, `src/lib/intel/adapters/**` |

Shared rules as wave 3. `git reset --hard consolidation` and `npm ci` first. linkSignal is the
only spine writer. No database writes. W35 and W40 both touch `crm-import/index.ts`: W35 owns
the commit path, W40 owns only `firstSeenCandidateFor`.

## Wave 5 status (integrated 2026-09-12)

All six workstreams merged on `consolidation`. Gate on the integrated head: tsc 0, vitest
1485/1485, governance green, every guard green, golden 16/16, links OK, lint 0 errors.

What is true now: CSV import (HoneyBook, web form, calculator, tour scheduler) commits through
`linkSignal`, mint-first so the mirror yields exactly one couple per row, with handles and
first-seen stamped by the spine itself; the venue's own social handles live on `venue_config`
and are never stamped on a couple; "ago" labels tick again; one lifecycle vocabulary maps the
thirteen-stage board onto the six spine states with a 131-case fixture, a disagreement audit
to run after the reimport, and one pill on the couples list, the pipeline and the couple page;
a two-venue isolation battery exists as a script and a CI job; 185 platform pages are audited
(167 keep, 9 hidden behind `SCAFFOLD_PAGES`, 7 redirects, 2 delete-recommended: `/org`, `/sage`)
and every kept page has a nav entry; the daily surfaces read the spine for last activity and
the legacy-reads baseline is 256.

Migrations owed to prod, all at once: 395, 397, 398, 399, 400, 401, 402, 403 via
`npm run migrate:pending` then `npm run migrate:pending -- --apply --allow-prod`.

What remains before the reimport is worth running (the plan's weeks 3, 5, 7 and 8 all need data):
- Gmail reconnect (operator). Nothing else replaces it.
- The reimport itself: HoneyBook CSVs through the UI, remerge, Calendly replay, Gmail backfill,
  Knot CSVs, social replay, then `lifecycleDisagreements`, the lifecycle audit, and the battery.
- Migrations above, then the older six with `--include-legacy`, 308 in the SQL editor.
- Meta app credentials for Instagram DMs (operator).
- Marketing-site repos: the "Your Instagram (optional)" field (operator or a separate session).

Follow-ups for wave 6 (dry work still possible):
- Delete `/org` and `/sage` full-page mirrors per the audit.
- Progression events for non-HoneyBook CSV anchors need an event type (migration) so a web-form
  import moves the decay clock the way a HoneyBook one does.
- `propose_follow_ups` still logs a cost row through the brain's own client; the isolation
  battery skips it for that reason. Decide whether a read tool may spend.
- Instagram outbound replies through the disclosure guard once credentials exist.
- Investor materials on measured numbers: the template can be written now, the numbers wait.

## Wave 6 (launched 2026-09-14): a coordinator's Monday, made true

Source: the Monday walkthrough audit (W39 agent, 2026-09-14), read against the code. The
morning loop is mostly real; the walkthrough is where the day breaks because the pieces live
on the couple's side of the portal or as two features never joined. Dry work; no data needed.

| # | Workstream | Model | Owns (files) |
|---|---|---|---|
| W41 | Screenshot capture works: enable the disabled file input on the social capture modal and wire it to the existing vision extraction so a followers/story/DM screenshot becomes rows through the W23 path | Sonnet | `src/components/intel/social/CaptureNowModal.tsx`, `src/app/api/intel/social-integration/capture/**`, `src/lib/services/social/vision-prompt.ts` (call only) |
| W42 | Monday admin reachable: a Knot/CSV upload entry on `/agent/leads` or the imports page (not only onboarding); a "since Friday" strip on `/today` (came in, auto-sent, waiting, failed) computed from the spine and drafts, not the midnight-reset stats | Sonnet | `src/app/(platform)/today/**`, `src/app/(platform)/admin/imports/**` or the leads page header, `src/lib/intel/adapters/**` (one new view model) |
| W43 | The coordinator's side of the wedding page: read and search the couple's contracts, view and edit the day-of timeline, and see the reconstructed couple story (identity profile) on the same wedding page a coordinator has open in a walkthrough | Opus | `src/app/(platform)/portal/weddings/[id]/**`, the couple-portal timeline and contract components made shareable under `src/components/couple/**` (read the couple pages, do not fork them), `src/lib/intel/adapters/identity-profile-view.ts` (reuse) |
| W44 | Table map and guest list joined: a named guest can be assigned to a table from the floor plan (drag or pick), and the assignment list and the map read the same rows | Opus | the seating components under `src/components/couple/**` and `src/app/_couple-pages/seating*/**`, `src/lib/services/couple-portal/seating*` |
| W45 | Housekeeping the audit asked for: delete `/org` and `/sage` full-page mirrors; migration 404 adds the progression event type so non-HoneyBook CSV anchors move the decay clock; `propose_follow_ups` cost row decision recorded (keep, it is an audit of spend) | Haiku | the two pages, `src/lib/services/identity/progression.ts`, new migration 404, `scripts/cleanup-budget.json`, the isolation battery's skip note |

Weather and the platform-shift question are not out of scope, they are wave 7 below — the
"no feed exists" line above was written before the audit revision confirmed most of this is
buildable from data Bloom already pulls in; corrected there.

Shared rules as wave 3. `git reset --hard consolidation` and `npm ci` first. No spine writes
outside linkSignal. No database writes. Migrations wait for `npm run migrate:pending`.

## Wave 6 status (integrated 2026-09-14)

The session that launched W42, W43 and W44 ended with all three still writing; their work was
found uncommitted in the worktrees, read against the plan, checked (tsc clean, own tests 16 + 31
+ 31) and committed here, then merged after W41 and W45. Gate on the integrated head: tsc 0,
vitest 1603, governance green, links OK (312 URLs), every CI guard green, golden 16/16 dry.

Two things the gate turned up, neither caused by wave 6:
- `check-no-coordinator-facing-created-at` had been red since W18 (wave 2) on one line in the
  billing cap. Tagged: the cap counts couples minted this month, so the mint is the event, and
  the check only notifies. CI had been failing that step on every push.
- `check-merge-weddings-cascade` (DB-backed, not in CI): 75 tables carry a `wedding_id` that
  `mergeWeddings` never reassigns, including couple_identity_profile, reviews, couple_invites,
  budget rows and rsvp rows; 9 entries in its hand-list are tables that no longer exist. The
  remerge step of the reimport would scatter those rows. Now W60 below.

What is true now: a coordinator back on a Monday can upload a Knot or HoneyBook export from the
leads page or `/admin/imports/upload` (same form, same route as onboarding) and `/today` opens
with a "since you were last here" strip over a venue-local window; the wedding page has the
couple story, a searchable contract library and the editable day-of timeline as collapsed
sections, rendered from the couple portal's own components with a role, so nothing is forked;
the couple's seating page draws the map and the assignment list from one view model and saves
through one path. W44 joined the couple side only; the coordinator table-map page is W61.

Two gate steps need Isadora because the auto-mode classifier refuses any Supabase write from
this session, test branch included:
- [ ] The golden-case branch (`.env.test`, project ciwqxwohczzthvzqqgjx) has none of migrations
  395-403, so the wet golden run fails on every case (linkSignal writes columns that are not
  there). Run once: `npx tsx scripts/apply-pending-migrations.ts --env .env.test --apply`
  (the runner gained `--env` today; production is refused by URL). Then `npm run test:golden`.
- [ ] Main checkout `node_modules` lacks `jsdom` (declared in package.json), so two test files
  (`seating-board.test.ts`, `use-now.test.ts`) could not start here; both pass in the worktrees.
  `npm ci` in the main checkout fixes it, once no lint or test run is using node_modules.

## Wave 7 launched (2026-09-14, from the wave 6 head)

W46, W47, W48, W49 and W51 launched from 1eaea6fb before wave 6 landed (no shared files). W50
and W52 launched from the wave 6 head because they sit on the wedding page and the couple pages
W43 and W44 reshaped. Two workstreams added from the gate:

| # | Workstream | Model | Owns (files) |
|---|---|---|---|
| W60 | mergeWeddings reassigns every wedding-keyed row by construction: a generated table list with a per-table strategy (reassign, one-per-wedding merge with audit, trigger-covered, archived skipped), the stale hand-list gone, the DB-backed guard fixed (Windows exit crash included) plus a CI-safe freshness check on the generated file | Opus | `src/lib/services/identity/resolver.ts` (mergeWeddings), new `wedding-fk-tables.generated.json`, `scripts/gen-wedding-fk-tables.ts`, `scripts/check-merge-weddings-cascade.mjs`, new `scripts/check-wedding-fk-tables-fresh.mjs`, package.json + ci.yml one line each |
| W61 | The coordinator's table-map page reads the same rows as the couple's seating page: one `SeatingView`, the shared board, the same save callbacks; the layout editor stays for shapes | Sonnet | `src/app/(platform)/portal/weddings/[id]/table-map/**`, print and portal subpages (seating reads only), the assigned count on the wedding page, `seating-view.ts` (additive) |

Migration slots handed out: 404 W49 (weather alerts), 405 W46 only if the column guard needs
it, 406 W50 (commitment reconciliation). Cron budget stays 49: W49 and W50 run inside existing
cases. Migrations owed to prod, all at once, now 395-403 plus whatever wave 7 lands.

## Wave 7 (launch after wave 6 lands): built, never wired, made to answer

Source: the CEO scenario audit (W39 agent, 2026-09-14) plus its revision. The pattern named:
built, tested, then never wired to live data or never given a door. Dry work, no reimport
needed. Isadora, 2026-09-14: nothing stays a caveat — every finding gets a build, not a flag.

| # | Workstream | Model | Owns (files) |
|---|---|---|---|
| W46 | Review sentiment, actually populated: wire the existing review-language scoring pass to run on every ingest path (Google Places poll, CSV/paste import, the brain-dump `reviews_from_screenshot` case) so `reviews.sentiment_score`/`themes` get written, not left null; backfill existing rows on replay | Sonnet | `src/lib/services/reviews/google-places.ts`, `src/lib/services/data-import.ts`, brain-dump route's review case, `src/lib/services/intel/review-language.ts` (call only), a backfill script |
| W47 | Tours as a series, and everything that unlocks: add a `tours` channel (from spine touchpoints) to `buildSeries`, so all eight existing external-context channels (weather, FRED, cultural moments, holiday calendar including election days, census, government shutdown — live and DC-weighted for Rixey, Google Trends via SerpAPI) and social engagement volume can pair against it, not just inquiries; verify Rixey has a `SERPAPI_API_KEY` and a `google_trends_metro` set, since Trends silently no-ops without both | Opus | `src/lib/services/intel/correlation-engine.ts`, `src/lib/utils/format-series-label.ts`, one operator check on the Trends config |
| W48 | Platform shift, named and answerable: "is engagement moving from Instagram to TikTok" is narrower than social-to-tours — brain-dump screenshots already land per-platform in `engagement_events` as `marketing_metric`, so build the per-platform series and a month-over-month share comparison, surfaced on the sources page and as an Ask-your-data tool | Sonnet | new `src/lib/intel/tool-sources/platform-shift.ts`, `src/app/(platform)/intel/sources/page.tsx` (a card), test, index line |
| W49 | Weather, three modes, all built, none parked: **specific** — a real severity feed via the National Weather Service's public alerts API (`api.weather.gov/alerts`, free, no key required), replacing the dead tornado-keyword branch; **historic** — activate the existing decade-normals backfill (code already exists, gated on an annual job that needs turning on and verifying it ran for Rixey); **future** — a genuine year-over-year trend calculation per month/metric, which the current two-point decade comparison does not provide | Sonnet | `src/lib/services/intel/weather.ts`, `weather-cancellation.ts`, `climate-context.ts`, `weather-climate-norms.ts`, new NWS alerts loader, one migration |
| W50 | The groom's cake, all four gaps closed: (1) run the existing loose-detail (`specialRequests`) extractor out-of-band after classification, not on the hot path; (2) add an `intentions` field to the fixed-schema classifier so a stated plan (not just a question) gets captured; (3) extend Planning Notes population to coordinator-venue conversations, not only the couple's chatbot and contract PDFs; (4) a nightly reconciliation pass that lists any captured intention with no matching day-of timeline event, shown on the wedding page | Opus | `src/lib/services/extraction.ts`, `src/lib/services/email/pipeline.ts` (two call sites, coordinate by call site not whole-file), `src/lib/services/intel/planning-extraction.ts`, new `src/lib/services/commitments/**`, a cron entry (reuse a slot — cron budget is at 49/49, its ratchet, do not just add one), a coordinator-facing queue on the wedding page |
| W51 | Reallocation analyst, honest about its inputs: the marketing-roi recommendations page states plainly, in the coordinator's own words, that Google/TikTok/Meta numbers are typed-in until a connector exists (W54 below), not silently presented as live | Haiku | `src/app/(platform)/intel/marketing-roi/recommendations/page.tsx`, `MarketingRecommendationsDashboard.tsx` |
| W52 | Surface it to all three audiences: a consolidated CEO view (response time, weekday tour conversion, channel ROI, review trend, one screen); coordinator daily-surface links from `/today` into the deeper answers; couple-experience personalisation from the identity profile (the repo's aggregate-not-disclose doctrine applies — scope which fields are safe to reflect back before wiring, this must read as warmth, not surveillance); weather- and conversion-informed couple nudges | Opus | new `src/app/(platform)/intel/monthly-story/page.tsx` + a real `nav-config.ts` entry, `src/app/(platform)/today/**` (links only), `src/lib/services/brain/**` (couple-portal prompt layer specifically), `_couple-pages/**` (wedding-day weather card) |

Every workstream above states its own "done when" in the description; hold to the wave 5
nav standard (a new page ships with a nav entry, not an orphan); add demo-seed coverage for
anything new so Crestwood shows it working, not only Rixey; add battery ground-truth probes
for W46-W48's new answerable questions; add W47's new channel and W50's new writer to the
wave 5 isolation battery's coverage. Shared rules as wave 3.

## Wave 7 status (integrated 2026-09-14, evening)

All nine merged on `consolidation` in this order: W51, W61, W47, W49, W48, W52, W50, W60, W46,
then W60's follow-up. Gate on the integrated head: tsc 0, vitest 1843 across 112 files, `next
build` clean, governance green including the new `check:wedding-fk-fresh`, every CI guard green,
`check:wedding-cascade` green against production (118 in the file, 117 live, the one difference
named as pending 406), links OK (315 URLs), lint 0 errors, golden **16/16 wet** on the test branch
(Isadora applied 395-403 there with `--env .env.test`).

Launch fault, recorded in memory `feedback-worktree-agent-base-branch`: five of the nine worktrees
were created from `master`, not `consolidation`. Caught after W46 and W49 had finished on the stale
base; all five committed WIP, rebased and re-gated. Every future prompt starts with
`git reset --hard consolidation`.

What is true now:
- Reviews get `sentiment_score` and `themes` on every insert path (Google Places poll, CSV/paste,
  screenshot), out of band through one helper; `scripts/backfill-review-sentiment.ts` for old rows.
- The correlation engine has a `tours` channel from spine touchpoints, so weather, FRED, calendar,
  cultural moments, shutdown, census, Trends and social volume all pair against tours. Two engine
  bugs fixed on the way: social-versus-venue pairs were never getting their 1.3x rank, and the
  shutdown channel was classed as venue-internal. Narration reads the same tours series.
- "Is engagement moving from Instagram to TikTok" is a tool (`platform-shift`) and a card on the
  sources page, from the same function; battery Q42.
- Weather in three modes: NWS alerts (free, keyless) replace the dead keyword branch and persist in
  `weather_alerts` (migration 404); per-year normals in `weather_climate_annual`; a least-squares
  year-over-year slope beside the two-point decade comparison. `scripts/check-climate-norms.ts`.
- The groom's cake: loose details extracted out of band after classification; `intentions` in the
  fixed schema (prompt v1.2); planning notes from coordinator-venue conversations; nightly
  reconciliation inside `data_integrity_sweep` into `commitment_reconciliation` (migration 406);
  a fourth collapsed section on the wedding page with add-to-running-order and dismiss.
- Reallocation page says which spend numbers are typed in, driven by a `CONNECTOR_STATUS` export
  per stub connector, so W54 flips it by shipping code.
- `/intel/monthly-story` (CEO view, one number per question through the canonical layer, nav entry);
  `/today` blocks link into the deeper answer; `profile-reflection-scope.ts` whitelists what the
  couple assistant may reflect back (tests prove ghost risk, heat, lifecycle, coordinator notes and
  third-party facts never reach a couple); a wedding-day outlook card and one conversion-informed
  nudge on the couple portal home.
- `mergeWeddings` is generated from the schema: 118 wedding-keyed columns, 82 reassign, 20
  one-per-wedding with audit, the rest skipped with a reason; the 35-entry hand-list is gone;
  pending migrations are representable; a merge writes one `activity_log` row with per-table counts.
- The coordinator's table-map page reads the same rows as the couple's seating page; the print
  page's seating chart, blank since it read a column nothing writes, now renders.

Findings for Isadora (operator decisions, not code):
- Rixey's `venues.google_trends_metro` is `US-VA-584` (Richmond), shared with Hawthorne and
  Crestwood, which reads like a copied default. Rixey is in the DC market (`US-DC-511`, what Rose
  Hill has). Trends is running; it may be measuring the wrong city.
- `supabase/seed.sql` seeds the legacy `marketing_spend` table, but attribution reads
  `marketing_spend_records`; nothing ever seeded that, so every demo venue showed a blank ROI
  column. W52 added `supabase/seed-marketing-spend-records.sql`; it needs applying to the demo.
- After a merge, the first real remerge is worth reading in `activity_log` (`wedding_merged`).
- A merge now costs about 104 UPDATE round trips instead of 36; the reimport's remerge will be slower.

Migrations owed to prod, all at once: 395-403 plus 404 and 406, via `npm run migrate:pending`
then `-- --apply --allow-prod`. Then regenerate the cascade file (`scripts/gen-wedding-fk-tables.ts`)
so 406 stops being "pending".

## Wave 8 status (integrated 2026-09-14, late evening)

All seven merged on `consolidation`: W58, W59, W53, W55, W54, W56, W57, in that order. Gate on
the integrated head: tsc 0, vitest 2120 across 129 files, `next build` clean, governance green
(including W56's new `check:browser-benchmark`), every CI guard green, `check:wedding-cascade`
green against production, links OK (318 URLs, 255 pages, 411 API routes), lint 0 errors, golden
16/16 wet. Conflicts: the migration ratchet three times (resolved to the on-disk count each time,
now 406), the isolation battery header (W54 and W56 both added an item), and one signature break
between parallel workstreams (W55 changed `sendEmail` to take a venue id while W57 still passed a
From string; fixed at integration).

What is true now:
- Dubsado and Aisle Planner exports import through the same registry as HoneyBook and the Knot,
  detected by header signature, with reconstructed fixtures (real exports still worth a check).
  Aisle Planner joined Dubsado on the list of sources a coordinator cannot set by hand.
- Google Ads, Meta Ads and TikTok Ads are real OAuth connectors (migration 407): grant flow, token
  renewal, daily campaign spend into `marketing_spend_records` on the spine's channel keys, an ad
  account chooser, and `connectorStatus(venueId)` so the reallocation copy flips per venue. The
  three settings pages now sit under an "Ad platforms" category on the integrations hub. Two gaps
  found and closed: the Google Ads callback returned 500 on every error branch, and no venue could
  ever set its ad account. Credentials are the operator's (each page names its variables).
- Each venue can send from its own verified domain (migration 408): Resend domain create, DNS
  records shown with copy buttons, verify, a daily status sweep inside `heat_decay`, and a From
  address that only uses the venue's domain once verified, with a logged fallback otherwise.
  `sendEmail` now requires a venue id (or an explicit null for platform sends).
- Cross-venue benchmarks exist and are off by construction until three real venues have finished
  setup and opted in (migration 410, doctrine INV-24.1-A; the switch is in Settings). A demo venue
  is compared against the other demo venues with a visible label. Peers are collapsed to numbers
  before anything leaves the module; a CI guard forbids importing it from the browser.
- Native contracts (migration 409): generated from the booking's own figures and the venue's
  plain-language template, PDF written by hand (no pdfkit, no polyfill), sent through the guarded
  transport, signed on a token page under `/join/contract/[token]` (token hashed, single use for
  signing), status trail on the wedding page's fifth collapsed section and a pill on the couple's
  library.
- `/api/public/demo-snapshot` serves the demo venue only (fixed server-side, refuses anything
  else), rate-limited, origin allow-listed, cached five minutes; `docs/PUBLIC-DEMO-SNAPSHOT.md`.
- The app is ready for a custom domain: `APP_CANONICAL_HOST` redirect in middleware, one
  `appUrl()` helper behind every absolute link, `docs/CUSTOM-DOMAIN.md` runbook.

Fix-on-find at integration: the demo seed wrote dollars into `weddings.booking_value` (a cents
column; 59 rows converted); the couple dashboard read `weddings.package`, which nothing writes;
`mergeWeddings` never busted the winner's narrative cache (column had a reader and no writer).

Migrations owed to prod, all at once: 395-403, 404, 406, 407, 408, 409, 410 (runner knows all).
Then regenerate the cascade file. Legacy 310 must land before 407's guarded ALTER means anything.

Operator findings from this wave: the demo venue id in code is Hawthorne Manor (`DEMO_VENUE_ID`),
while the plan talks about Crestwood; both are demo venues, but the public snapshot serves
Hawthorne. Tokens on the three ad connection tables and Instagram are still plaintext (the
pgsodium HARDENING TODO carried forward on 407); do that before a second venue connects.

## Wave 9 status (integrated 2026-09-14, late night)

All seven merged, plus W69 (the e2e harness). Legacy-table reads under `src/app`: **255 to 40**
(weddings 124 to 27, people 45 to 5, interactions 62 to 7, attribution_events 23 to 1,
wedding_touchpoints 1 to 0), baseline ratcheted once at the end; `people.platform_handles` reads
36 to 31. Gate on the head: tsc 0, vitest 2686 across 183 files, governance green with three more
guards (tangential writes, cascade update/delete ratchet, widened scopes), links 325 OK, every CI
guard green except `check-pr-cites-section` (two integrator commits; inert in CI) and
`check-types-fresh` (operator regen).

What is true now: the four daily surfaces and `/dashboard`, `/agent/inbox`, `/agent/analytics`,
`/intel/roi`, `/intel/clients/[id]`, the couple dashboard and the couple layout read the spine
through readers under `src/lib/intel/readers/`; the leads and pipeline boards are the thirteen
vocabulary stages from spine rows with a drag that writes through an audited API; `/intel/roi`
and `/intel/sources` give one channel answer by construction (a test asserts the chain); 17
API sites converted through a couple-by-wedding reader and 144 mirror-maintenance reads tagged
with their class and a retire-when in `REPAIR-ENDPOINTS.md`; `cleanup-ghost-weddings` tombstones
instead of deleting; the tangential pool has no writer left (four, not three, were found) with a
guard and a truthful migration 412; loose-detail capture and venue-conversation notes run on the
SMS and DM chokepoint; `tracer.ts` is `spine-writers.ts`; about 230 API routes return a generic
error plus correlation id instead of the driver's message; the e2e harness refuses production by
construction.

What the spine still cannot express, recorded by the workstreams with evidence (not a shrug):
no thirteen-stage column (the mirror's `lifecycle_stage` is read in one documented seam), no
outbound proposal event, no revenue (`booking_value` lives only on `weddings`, so the dashboard's
revenue tile is gone and points at `/intel/roi`; the agency drill-down lost its value column), no
`confidence_flag` or `code_extension`, a four-bucket heat where the legacy view had five, unstamped
direction on pre-381 touchpoints (counted as unknown and said so). The 40 reads left are: the
three coordinator wedding pages (fields with no spine home), `intel/company` and `intel/health`
(revenue and a stored composite), `couples/[id]` (`raw_import_row`), and a handful of
mirror-maintenance sites now tagged. Three channel derivations live outside `src/app` where the
ratchet cannot see them (`channel-intel-hub/compute.ts`, `channel-truth/data-loader.ts`,
`marketing-agencies.ts`), so the agency card and its drill-down disagree by construction: wave 10.

Behaviour changes worth an operator eye before master: the NLQ sufficiency gate counts couples
not weddings; inbox folders are recomputed from the spine (vendor rows may change tab); fresh CSV
imports no longer run the legacy Phase B clusterer (the nightly sweep still does); auto-send is
materially tighter (S4a); demo reseed needs one more `--apply` for the decision-timeline tile.

## Wave 9 (launched 2026-09-14, night): finish W2, the canonical wiring

The verification found the plan's headline goal unmet: 255 legacy-table reads under `src/app`
(weddings 131, interactions 62, people 46, attribution_events 25, wedding_touchpoints 1), most of
them in API routes rather than pages, and two daily surfaces still reading `weddings` under a
tag that named W37 as the blocker. W37 has shipped. Rules for the wave: no new reads of the five
tables; new readers go under `src/lib/intel/readers/` and adapters under `src/lib/intel/adapters/`
(nobody edits `canonical.ts`, so seven worktrees cannot collide on it); nobody edits the ratchet
baseline, the integrator lowers it once with `--write` at the end; a `legacy-read-ok` tag is a
documented decision on a mirror-maintenance route, never a way past the ratchet for a page.

| # | Workstream | Model | Owns (files) |
|---|---|---|---|
| W62 | `/agent/leads` and `/agent/pipeline` off `weddings` and `wedding_heat`: stages through the W37 vocabulary from spine rows, heat through the canonical heat path, the obsolete tags removed | Opus | the two pages, new `readers/lead-board.ts`, an adapter, tests |
| W63 | `/dashboard`, `/agent/inbox`, `/agent/analytics`, `/super-admin/pipeline-health` off the legacy tables; the inbox gets a spine thread reader; the dashboard shows `/today`'s figures from the same functions | Opus | the four pages, new readers, tests |
| W64 | `/intel/roi`, `/intel/sources`, `/intel/clients/[id]` and the intel APIs behind them (attribution, name-evidence, journey-narrative, prior-touches, agency leads) on the canonical readers; a sweep of every other `/intel` page rendering a spine fact without the canonical layer | Opus | those files, new readers, tests |
| W65 | The couple and wedding-record pages through one `getWeddingRecord` reader (the only place the legacy row is read, tagged there and nowhere else) | Sonnet | `_couple-pages/{page,addresses,couple-photo}`, `couple/[slug]/layout`, `portal/weddings/[id]/{page,portal,print}`, new `readers/wedding-record.ts` |
| W66 | Every other API route with a legacy read, classified: visible-figure reads converted; mirror-maintenance reads tagged with the doctrine's class and listed in `REPAIR-ENDPOINTS.md`; `cleanup-ghost-weddings` stops hard-deleting weddings (tombstone via `non_couple_at`) | Opus | those routes, `api/cron/route.ts` job bodies, `REPAIR-ENDPOINTS.md` |
| W67 | Test and guard gaps from the verification: four guards scan the directories the waves added; the raw-`error.message` guard covers API routes with an `apiError` helper; weather-cancellation tests; the monthly-story mock and GC-1 budgets; battery probes for W46 and W47; the cascade-only-writer ratchet covers update and delete | Sonnet | guard scripts, tests, `battery-expected.ts`, vitest config, `src/lib/api/api-error.ts` |
| W68 | Ingestion leftovers: the three CSV writers still filling `tangential_signals` go through `linkSignal` with a guard and a truthful migration 412 comment; loose-detail capture and venue-conversation notes run on the SMS and DM chokepoint too; `tracer.ts` renamed to what it is | Opus | `crm-import/{site-visitors,storefront-activity,web-form}.ts`, `ingestion/openphone.ts` (one call site), `identity/tracer.ts` rename, migration 412 |

Launched from d2dad192 after the security remediation; every worktree verified on that head.

## Wave 8 (launch after wave 7 lands): the rest, built or triggered, not parked

Everything that used to sit under "Parked until after November" gets a real workstream. Two
of these are trigger-gated on something outside this repo's control (a second signed venue, a
separate repo's release) rather than buildable this week — trigger-gated is not the same as
parked: the code ships now, the activation condition is named, not open-ended.

| # | Workstream | Model | Owns (files) |
|---|---|---|---|
| W53 | Dubsado and Aisle Planner CRM adapters, same adapter interface the Knot/HoneyBook adapters already use | Sonnet | new `src/lib/services/crm-import/dubsado.ts`, `aisle-planner.ts`, registry entries, tests |
| W54 | Real Google Ads, Meta Ads and TikTok Ads connectors: OAuth-based ingestion replacing the manual brain-dump-only spend capture, each connector's own documented API (Google Ads API, Meta Marketing API, TikTok Business API) | Opus | `src/lib/services/marketing-spend/connectors/google-ads.ts`, `meta-ads.ts`, `tiktok-ads.ts` (replace the stubs), OAuth settings pages under `src/app/(platform)/settings/integrations/**` |
| W55 | Per-venue Resend sending domains, so venue emails don't share one domain's reputation | Sonnet | `src/lib/services/email/**` (send path), a venue_config field, a settings section, Resend domain-verification flow |
| W56 | Cross-venue benchmarks: build the comparison surface now against the existing single-venue data model so it needs no further code once a second venue exists; **triggered** — goes live the moment venue 2's onboarding (the plan's own week-4 gate) completes, not before, since it has nothing to compare against until then | Opus | `src/app/(platform)/intel/benchmark/page.tsx` (already scaffolded, gear-menu-reachable — wire it for real), `src/lib/services/cohort/**` (cross-venue query path) |
| W57 | Native contracts inside Bloom, MVP scope: generate a contract from a booked wedding's package data, send it to the couple through the existing disclosure-guarded send path, track signed/unsigned status on the wedding page. Not full e-signature legal infrastructure — status tracking and generation, matching what the coordinator-side contract work in wave 6 (W43) already reads | Opus | new `src/lib/services/contracts/**`, `src/app/api/portal/contracts/**`, a section on `portal/weddings/[id]/page.tsx` |
| W58 | Marketing-site demo goes live: the Bloom-side hooks the live demo needs (a public-facing read-only snapshot route, rate-limited, no auth) — the marketing-site repo's own build is out of this repo, this workstream only ships what Bloom must expose | Sonnet | new `src/app/api/public/demo-snapshot/**`, rate-limit config |
| W59 | Custom app domain: DNS + Vercel domain config, cert, redirect from the current domain | Haiku | `vercel.json`, DNS records (operator applies), redirect middleware |

Launched 2026-09-14 evening from 761a01c2, seven agents, every worktree verified on the wave 7
head after the wave 7 launch fault. Migration slots: 407 W54, 408 W55, 409 W57.

Shared rules as wave 3. `git reset --hard consolidation` and `npm ci` first. No database
writes. W54's connectors are the only workstream here that needs real third-party credentials
before it can go live in production — build and test against each provider's sandbox/test
mode; going live is an operator step (provisioning API access), same shape as Instagram DMs
waiting on Meta credentials, not a reason to defer the build.
