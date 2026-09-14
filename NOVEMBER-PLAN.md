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

## Operator items (Isadora)

- [ ] **RECONNECT GMAIL FIRST.** `gmail_connections` for Rixey has been `status=error`
  ("Token refresh failed") since **2026-07-24**. No email has been ingested for six weeks.
  The backfill and the live poll both need it. Settings → Gmail → Connect. (Found 2026-09-08.)
- [ ] Do NOT re-enable auto-send until the reimport is complete. All four `auto_send_rules`
  are `enabled=false` today (verified 2026-09-08). After a wipe the new-contact, per-thread
  and daily-limit gates all read empty tables and pass everything; `enabled` is the only gate.
- [x] Run `node scripts/phase2-wipe-finish.mjs --apply --allow-prod` (interactions + people) — done 2026-09-08, all Rixey pipeline tables 0
- [ ] Import the five HoneyBook CSVs through `/onboarding/crm-import`, oldest first — PAUSED by Isadora until wave-1 fixes land; parse verified offline (281 couples, 136 distinct emails)
- [ ] Download a fresh HoneyBook "Booked clients" report (newest on disk ends Jun 2026)
- [ ] Fast-forward `master` after each integration I hand you (wave 1 + wave 2 wiring ready on `consolidation` as of 2026-09-09)
- [x] Migrations 391, 392, 393, 394 applied to prod 2026-09-09 (couple_invites, demo anon reads, accommodations columns verified live)
- [ ] Decide: fix Hawthorne's `venue_config.business_name` by SQL (one line, I will give it)
- [ ] Decide: delete the two May snapshot branches to save cost, keep `pre-phase2-2026-09-08`

## Reimport steps (I run, after the finisher)

1. HoneyBook (UI, Isadora) or `scripts/phase2-run-honeybook-import.ts`
2. `scripts/phase2-remerge-operator-columns.mjs --apply --allow-prod`
3. `npx tsx scripts/phase2-replay-calendly.ts`
4. `scripts/phase2-trigger-gmail-backfill.mjs --apply --allow-prod` (cron drains, hours)
5. `scripts/phase2-run-knot-visitor-import.ts --apply --allow-prod`
6. Re-merge danger exports (draft_feedback 1 row, discovery_sources 3) by hand
7. Gate: spine sane, point_zero stamped, battery run, golden 15/15

## Parked until after November

Dubsado / Aisle Planner adapters, Meta/Google/TikTok spend connectors, per-venue Resend
domains, cross-venue benchmarks (needs a second tenant), native contracts inside Bloom,
the marketing-site demo becoming live, custom app domain.

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

Not in this wave, needs data or an external source: weather severity (no severity feed
exists), Instagram versus TikTok comparison (no TikTok connector), investor numbers.

Shared rules as wave 3. `git reset --hard consolidation` and `npm ci` first. No spine writes
outside linkSignal. No database writes. Migrations wait for `npm run migrate:pending`.

## Wave 7 candidates (from the CEO scenario audit, 2026-09-14; launch after wave 6 lands)

The pattern the audit named: built, tested, then never wired to live data or never given a
door. Dry work, no reimport needed.
- Review sentiment is never populated: `reviews.sentiment_score` exists and the six-month trend
  reads it, but neither the Google import nor the paste tool fills it. Wire the existing review
  language pass to score each review on ingest; backfill on replay.
- Social to tours: the correlation engine has no `tours` channel and the follower capture never
  feeds it. Add tours (from spine touchpoints) as a series and social engagement volume as
  another, so "does posting more lead to more tours" has a wire, then an honest answer.
- The groom's cake: four gaps in a row. (1) The loose-detail extractor exists but is switched
  off for inbox speed; run it out of band after classification. (2) A stated intention is not
  a question, so the fixed-list extractor drops it; add an `intentions` field. (3) Planning
  notes fill only from the chatbot and contract PDFs; venue conversations must write there
  too. (4) Nothing reconciles notes against the day-of timeline; a nightly pass that lists
  intentions with no timeline item, shown on the wedding page.
- Google Ads and TikTok connectors are stubs; the reallocation analyst runs on typed-in spend.
  Say so on the page until a connector exists.
- Weather severity has no source; a warning feed is an external dependency, parked.
