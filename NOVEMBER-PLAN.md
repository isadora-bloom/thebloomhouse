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
- [ ] Fast-forward `master` after each integration I hand you
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
