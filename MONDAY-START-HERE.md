# Monday — Start Here

> ## ⚠️ STALE — this on-ramp is from 2026-05-29 and is DONE
> Everything below was executed (some of it weeks late): D-1 verified 05-29, guards
> flipped to enforcing 06-11, Phase 1.1 shipped 05-29, Phase 3.3 readers complete 06-02..04.
> **To resume today: read `CONSOLIDATION-PLAN-PHASED.md` (the execution authority) +
> `CHANGELOG.md` (current ship record).** `BLOOM-MASTER-PLAN.md` is retired as the live
> tracker (see its banner); its §3 decision ledger remains the rationale record.

A 15-minute on-ramp back into the rebuild. Nothing below is urgent; nothing is running against you over the weekend.

## What's true right now (so you can relax)
- **Nothing in your runtime or prod DB changed.** Everything produced this week is docs + new CI scripts.
- **The new CI guards are informational only** (`continue-on-error: true`) — push whatever you need this weekend; they print a worklist but **cannot fail your build**. They flip to enforcing in Phase 0, Monday (step 4 below).
- ~~The plan of record is `BLOOM-MASTER-PLAN.md`~~ **Stale — the plan of record is `CONSOLIDATION-PLAN-PHASED.md` v2.1** (corrected 2026-07-07, remediation R0).

## Monday, in order (each is small)

1. **Re-read the master plan's §1 + §3 + §5 Phase 0** (~10 min). That's the doctrine, the decisions to ratify, and the week's steps.

2. **Ratify (check the boxes):** in `BLOOM-MASTER-PLAN.md` §3, tick D-0/D-2/D-4/D-5/D-6/D-7/D-8 and ack D-9/D-10/D-11. Sign §10. (D-0/D-2/D-5 you already chose this week.)

3. **Run the one query only you can run (D-1):** open `scripts/verify-nobody-live.sql`, paste into the Supabase SQL editor for the bloom-house project, run, and paste the result into master-plan §0.2.
   - `active_30d = 0` + no recent portal writes → **green light to wipe.**
   - anything live → ping me, the plan changes.

4. **Flip the guards to enforcing (master-plan §0.9):** in `.github/workflows/ci.yml`, remove `continue-on-error: true` from the four "(informational)" governance steps. Now drift fails the build.

5. **Point the golden harness at a safe DB (D-12):** set `.env` to the `pre-tier-8` Supabase branch (NOT prod), seed `GOLDEN_TEST_VENUE`, then `npm run test:golden`. It tells you which of GC-1…9 already pass = your worklist.

6. **Then — and only then — Phase 1.1** begins: fold the Backwards Tracer into `linkSignal` (the one origin-sourced writer). Ask me to draft it adapter-by-adapter when you're ready; I'll also write `check-no-mirror-source.mjs` and golden cases GC-10–13.

## If you have 5 spare minutes this weekend (totally optional)
Just skim `BLOOM-CEO-DECISIONS.md` — it's the "why" behind the 12 decisions, so Monday's box-checking is fast and confident. Don't run anything; don't decide anything tired.

Have a good (if busy) weekend. Nothing here will rot before Monday.
