# 25-Day Consolidation Plan — No-Susan-Yet Version

> ## ⚠️ SUPERSEDED — do not execute this plan
> Superseded by `CONSOLIDATION-PLAN-25-DAY-ANCHORED.md`, itself superseded by
> `CONSOLIDATION-PLAN-PHASED.md` v2.1 (the single plan of record). Kept for the
> rationale record only. Banner added 2026-07-07 (remediation R0).


**What changed.** You don't have a live operator yet, so I shouldn't optimize for "weekly visible wins." That was the wrong constraint for a pre-product codebase. The right constraint is: get the structure right before the first Susan arrives, even if the UI looks broken for two weeks while I do it.

This lets me do three things the previous plan couldn't:

1. **Front-load the painful structural work.** Audit, writer contract, Intel API contract, all in Week 1 before any code moves. The work no human team wants to do because it produces nothing visible.
2. **Delete aggressively.** Without a live user, deprecation banners and 30-day grace periods are theater. Old code dies the day it stops being imported. No graveyard.
3. **Compress the timeline.** ~25 days instead of 30. Most of the "Week 4 polish + grace period + verify against Susan" overhead disappears.

Below is the rewrite. Each phase has a critical-analysis block against doctrine, battery, and code shrinkage (replacing the Susan-test from before).

---

## Phase 0: Pre-flight (Day 0)

Before the plan starts I do one thing: take a clean tag of master at `pre-consolidation-2026-05-21` so the whole 25 days is reversible. One commit. One tag. Push. Done.

---

## Week 1: Doctrine + Audit (Days 1-6)

The week with zero code changes that the next two weeks cannot succeed without. This is where the previous plan's failures came from. I'm going to be patient here.

### Day 1: Parallel audit

Spawn six sub-agents in one tool-use block. Each agent does one read sweep.

| Agent | Mandate |
|---|---|
| A | Find every call site that writes to `weddings`, `people`, `interactions.wedding_id`. Return file + line + which writer is responsible. |
| B | Find every call site that writes to `couples`, `touchpoints`, `fragments`, `couple_progression_events`. Same shape. |
| C | Find every reader of `weddings.source`, `weddings.utm_source`, `attribution_events.source_platform`, `wedding_touchpoints.*`. List the surface each renders into. |
| D | Catalog every page under `src/app/(platform)/intel/` and `src/app/(platform)/agent/`. Return: route + what it shows + which service it imports + estimated kept/merged/deleted verdict. |
| E | Catalog every service file under `src/lib/services/intel/`, `src/lib/services/brain/`, `src/lib/services/identity/`. Return: file + who imports it + estimated kept/merged/deleted verdict. |
| F | Catalog every cron job. Return: name + schedule + what it reads + what it writes + why it exists + estimated kept/merged/deleted verdict. |

Synthesis: `CONSOLIDATION-AUDIT.md` committed to the repo. Three sections (writers, readers, surfaces) and one summary table.

**Critical analysis of Day 1:**
- *Doctrine:* essential prerequisite. Cannot enforce "one writer" without knowing all writers.
- *Battery:* none.
- *Code shrinkage:* none today. Builds the kill list.
- *Self-critique:* the previous plan also had this as Day 1. It was right. Keep it.

### Day 2: Canonical writer contract doctrine

I write one doctrine document: `CASCADE-CANONICAL-WRITER.md`. It specifies:

- The one function signature: `cascade_resolve_and_attach(venue_id, signal, adapter)`
- The signal shape (`NormalizedSignal`)
- The return shape (`{ matched, couple_id, stage, touchpoint_id, audit_event_id }`)
- The transaction boundary (advisory lock + write + audit row in one transaction)
- Four worked examples: HoneyBook contract import, Calendly invitee.created, brain-dump CSV row, Knot screenshot OCR. Each one walks from raw payload through normalize() through cascade() to the resulting couple/touchpoint pair.
- The migration contract: every existing writer documents which steps it currently does, which become normalize(), which become signal fields, which get deleted.

No code change. One doc.

**Critical analysis of Day 2:**
- *Doctrine:* this IS the doctrine document. Worth getting right before any code moves.
- *Battery:* indirectly Q6 (duplicate identification), Q29 (merge confidence calibration). Both depend on writers behaving consistently.
- *Code shrinkage:* none today.
- *Self-critique:* I am tempted to skip straight to coding. The reason this fails is that the contract gets rebuilt three times if it's not written down first. One day of design saves three days of refactor. The previous plan was right to insist on this; I'm just moving it from Day 8 to Day 2 since there's no Susan-bleeding pressure to chase quick wins first.

### Day 3: Canonical Intel API contract doctrine

Same shape, different scope. One doc: `INTEL-CANONICAL-API.md`. It specifies:

- Six (or fewer) read functions every Intel surface is allowed to call:
  - `getVenueOverview(venueId)` — top-line counts + lifecycle distribution + recent activity
  - `getSourceAttribution(venueId, opts)` — per-channel volume + conversion + CAC + revenue/$ with model toggle
  - `getCohortFunnel(venueId, opts)` — funnel + response time + lead time + conversion curve + segments
  - `getCoupleJourney(venueId, coupleId)` — full ribbon + progression + identity profile + look-alike cohort
  - `getDailyList(venueId)` — for the future landing page
  - `askIntel(venueId, question)` — Sage NLQ
- The exact return shape for each (TypeScript interfaces, no `any`).
- What honest "no data" looks like in each return (every metric has its `n` + `enoughData` flag).
- The cache contract (when stale-is-OK; when fresh-read is required).

**Critical analysis of Day 3:**
- *Doctrine:* the read counterpart to Day 2. Together they constrain the entire data path.
- *Battery:* directly relevant to Q33 (consistency across reframings). Same function, same data, same answer.
- *Code shrinkage:* none today, but locks in the eventual delete target.
- *Self-critique:* six functions is the doctrine. If I find myself defining a seventh next week, I should fold it into one of the six. The number of Intel API functions must not grow.

### Days 4-5: stub the contracts

I implement both contracts as stubs:

- `src/lib/spine/cascade.ts` — the canonical writer. Returns `{ ok: true, stub: true }` for now.
- `src/lib/intel/canonical.ts` — the six read functions. Each returns empty / null / fixture data.

The signatures are LIVE. The implementations are deferred to Week 2-3. The point is to commit the contract so no one (including me) can drift from it.

I also write integration tests against the stubs that verify the SHAPE of the return is honored (will reject incorrect implementations in Week 3).

**Critical analysis of Days 4-5:**
- *Doctrine:* contracts become enforceable, not just documentation.
- *Battery:* none today.
- *Code shrinkage:* slight addition (~500 lines of stub + tests). Will pay back 30x in Week 3 when surfaces collapse onto these.
- *Self-critique:* there's a risk I get the stub shape wrong and have to refactor in Week 3. Mitigated by walking the four worked examples from Day 2 through the stub signatures and confirming each can be expressed.

### Day 6: keep/merge/delete decision pass

I take the audit from Day 1 and the contracts from Days 2-3 and produce one final doc: `CONSOLIDATION-PLAN-FROZEN.md`. For every writer, reader, surface, and service file, the doc has a verdict:

- KEEP (and rewrite to call the cascade / canonical API)
- MERGE (into another file; specify which)
- DELETE (specify why nothing else needs it)

The expected breakdown:
- ~25 writer call sites → most KEEP-and-rewrite; a few DELETE
- ~100 service files under `src/lib/services/intel/` → ~60 DELETE, ~30 MERGE, ~10 KEEP
- ~40 /intel surfaces → ~35 DELETE, ~3 MERGE into landing, ~2 KEEP (journey ribbon + identity-review)
- ~15 brain files → 11 MERGE into 2 canonical brains, 4 DELETE
- ~12 crons → ~7 DELETE (no longer needed once cascade is canonical), 5 KEEP

**This is the document that needs your sign-off before Week 2 starts.** Once signed, I treat it as the budget. Every deletion is pre-authorized. No more "are you sure?" interruptions during execution.

**Critical analysis of Day 6:**
- *Doctrine:* the deletion budget makes consolidation enforceable. Without it, I'll second-guess every delete during execution.
- *Battery:* none today.
- *Code shrinkage:* the doc commits to the target. Expected delete: ~40,000-50,000 lines.
- *Self-critique:* the temptation is to mark too many things KEEP "just in case." Aggressive deletion is the entire point of this 25-day plan. The doc should err on the side of DELETE.

**End of Week 1:**
- Two doctrine docs frozen
- One audit doc committed
- One stub layer in place with tests
- One signed-off kill list
- Zero production code changed
- ~+500 LOC added (stubs + tests)

The UI looks exactly like it did on Day 0. Nothing visible has happened. This is the most important week of the plan and the most boring.

---

## Week 2: Writer migration (Days 7-13)

### Days 7-9: high-volume writer migration

Three sub-agents in parallel, each in its own git worktree:

- Worktree A: migrate `mintWedding` → `cascade_resolve_and_attach`. Walk every call site of mintWedding (~7-8 sites), refactor to build a NormalizedSignal and pass to the cascade RPC. The agent commits its branch when local tests pass.
- Worktree B: migrate the Calendly webhook handler. Same shape.
- Worktree C: migrate the HoneyBook CSV/webhook handler. Same shape.

I review each worktree's diff before merging. Each merges sequentially to master, build verifies between merges.

Between merges I run the integration test from Day 4-5 to confirm the writer-shape contract is honored.

**Critical analysis of Days 7-9:**
- *Doctrine:* this is THE doctrine work. After these three, ~80% of daily-volume writes go through the cascade.
- *Battery:* Q6 + Q29 become calibrate-able for the first time (consistent rule set across all new merges).
- *Code shrinkage:* delete the legacy resolveIdentity → createPerson → createWedding chain inside mintWedding (~400 lines). Net: ~-400 lines.
- *Self-critique:* this is high-risk. The email pipeline is the highest-volume code path in the system. If I drop a write, no email gets routed to a couple, and the test won't catch it because the test runs against fixtures. Mitigation: shadow-run for 48 hours with the old + new path both writing, compare results, flip the feature flag when divergence is zero.
- *Self-correction:* without Susan, the 48-hour shadow run is paranoia. There's no production load on this code. I can flip the feature flag immediately and verify with the fixture venue. Saves two days.

### Days 10-11: medium + long-tail writer migration

The remaining ~15 writer call sites from the Day 1 audit. These are: mirror-couple writes, backtrace's applyBacktrace, post-wedding-sweep direct UPDATE, the orphan-sweep in email pipeline, the calendly-outcomes I shipped today, the tracer-rebind I shipped today, various ingestion adapters (knot, weddingwire, openphone, omi, sms-name-match), the various data-integrity sweeps.

Three sub-agents in parallel, two rounds:

- Round 1 (Day 10): mirror-couple, post-wedding-sweep, tracer-rebind, backtrace apply.
- Round 2 (Day 11): the rest.

Same worktree pattern. Same review-before-merge.

**Critical analysis of Days 10-11:**
- *Doctrine:* the spine has one writer at end of Day 11.
- *Battery:* the suspect-merges + lifecycle-audit problems collapse because they were symptoms of multi-writer drift.
- *Code shrinkage:* each writer's direct-write code becomes "normalize + call cascade" — net delete ~30 lines per writer × 15 = ~450 lines.
- *Self-critique:* the data-integrity sweeps were supposed to repair multi-writer drift. After Day 11, they have nothing to repair. Half of them can be deleted. I should add that to the Week 3 deletion target.

### Day 12: CI guard

One sub-agent: write a script at `scripts/check-cascade-only-writer.mjs`. It greps for `INSERT INTO couples`, `UPDATE couples`, `INSERT INTO touchpoints`, etc. outside of `src/lib/spine/cascade.ts` and the migrations directory. CI fails the PR if any are found.

This is a 30-line script. It's the permanent enforcement of the doctrine. After Day 12, no future PR can re-fragment the writer model.

**Critical analysis of Day 12:**
- *Doctrine:* enforced forever.
- *Battery:* none directly.
- *Code shrinkage:* none.
- *Self-critique:* the script needs exemptions for explicit migration files + the cascade implementation itself. Easy. But I should also exempt one-shot maintenance scripts under `scripts/` — they're not in the runtime path.

### Day 13: kill the bypass paths

Walk through the writer call sites that were KEPT but rewritten in Days 7-11. Confirm each one ACTUALLY routes through the cascade now. Anything that was missed gets fixed today. The CI guard from Day 12 should catch this automatically.

End of Day 13: every spine write goes through one function. The doctrine is real.

**Critical analysis of Day 13:**
- *Doctrine:* fully achieved at the writer level.
- *Battery:* the cascade now gets to enforce the 8-stage order on EVERY new write. Q5 transparency works for every couple, not just the ones whose pipeline happened to route through findIdentityMatches.
- *Code shrinkage:* cumulative -800 to -1,200 LOC across the week.

**End of Week 2:**
- One writer. CI-enforced.
- ~1,000 lines deleted.
- Multiple healing crons are now redundant (they exist to repair drift the writer no longer causes).
- The UI still looks like Day 0. Numbers may have shifted slightly as the writer started producing more consistent state, but nothing was redesigned.

---

## Week 3: Read migration + mass deletion (Days 14-19)

### Days 14-16: implement the canonical Intel API for real

The six stub functions from Days 4-5 become real implementations. Each reads the spine, derives whatever the surfaces need, returns the canonical shape.

I do this in three days, sometimes with sub-agents:
- Day 14: `getVenueOverview` + `getSourceAttribution` (consolidating the work from /intel/sources and /intel/attribution into one function)
- Day 15: `getCohortFunnel` + `getCoupleJourney` (consolidating /intel/cohort + the journey ribbon)
- Day 16: `getDailyList` + `askIntel` (the new functions; the latter wraps the existing NLQ brain)

Each function has full TypeScript typing, full honesty primitives (n, enoughData, ratio safety), full integration tests against the fixture venue.

**Critical analysis of Days 14-16:**
- *Doctrine:* every read path now has exactly one implementation.
- *Battery:* the six functions together answer most of the battery. Specific checks:
  - Q1 (median response time + delta): `getCohortFunnel(venueId, {includeResponseTime: true})` returns it with `last12moMedian`, `prior12moMedian`, `deltaHours`.
  - Q26 (volume ≠ conversion): `getSourceAttribution` returns both side-by-side with top-volume + top-conversion badges.
  - Q33 (consistency across reframings): all three framings of "best channel" call the same function with the same data.
- *Code shrinkage:* none today (these are ADDED). Will pay back massively on Days 17-19.
- *Self-critique:* the temptation is to add a seventh function. Resist. If a future surface needs something the six can't return, the right move is to add a parameter to one of the existing six, not a new function.

### Days 17-18: migrate surfaces to canonical API

The 5 or 6 /intel surfaces being KEPT (per the Day 6 deletion list) get refactored to call canonical functions. They become dumb renderers.

Two sub-agents in parallel:
- Sub-agent: migrate /intel/sources (or /intel/attribution, whichever wins) to call `getSourceAttribution`.
- Sub-agent: migrate /intel/cohort to call `getCohortFunnel`.

After both merge, I migrate the journey ribbon page myself. Three surfaces in 2 days.

The rest of the /intel surfaces are not migrated; they will be deleted on Day 19.

**Critical analysis of Days 17-18:**
- *Doctrine:* every kept surface reads one canonical function.
- *Battery:* none new today.
- *Code shrinkage:* each migrated surface loses ~200-400 lines of per-surface derivation logic. Net ~-1,500 LOC.
- *Self-critique:* "dumb renderer" should be enforced. The surfaces should not contain any data derivation logic. If a surface needs to compute a ratio or filter a list, that goes in the canonical function, not the surface.

### Day 19: mass deletion

The big day. Walk the Day 6 deletion list and execute every DELETE entry.

Three sub-agents work in parallel, each deleting a category:
- Sub-agent A: delete ~35 /intel surface routes (verify each has no inbound link from kept code first).
- Sub-agent B: delete ~60 `src/lib/services/intel/*` files (verify each has zero importers in the post-Day-18 codebase).
- Sub-agent C: delete the parallel attribution stack (`src/lib/services/attribution/index.ts` legacy + supporting types), the parallel identity resolution chain (resolver.ts, candidate-resolver.ts), 11 of the brain files (consolidating into Agent brain + Intel brain).

Each sub-agent's deletion goes into its own worktree, then I merge sequentially. Build verifies between each merge.

Net delete target: 30,000-40,000 lines.

The migrations directory also gets a flatten: collapse 365 migration files into one fresh-baseline migration. The history stays in git.

**Critical analysis of Day 19:**
- *Doctrine:* the swamp drains.
- *Battery:* none directly; the underlying capability is preserved in the six canonical functions.
- *Code shrinkage:* the headline number. 111,000 LOC → ~75,000 LOC.
- *Self-critique:* the build must stay clean after each merge. If any deleted file is still imported somewhere, the build fails and I roll back. The CI guard catches this automatically.

**End of Week 3:**
- One reader API.
- ~30,000-40,000 lines deleted.
- ~7-10 cron files deleted (the multi-writer-drift repair crons).
- ~35 /intel routes 404.
- The UI looks broken for any URL not in the kept set. This is fine; you said you can look at junk for two weeks. You're looking at it now.

---

## Week 4 (truncated): Build the new landing + Sage NLQ + ship (Days 20-25)

### Days 20-22: build the daily-list landing page

Five blocks. Each calls one canonical function. The page IS the new product surface.

I do this myself, not via sub-agents, because it's the design surface that determines whether the consolidation actually works as a product.

Each block has clear empty states (when no data, say so honestly) and Sage-narrated commentary (when the canonical function returns a pattern worth narrating).

I add the page at `/dashboard` (or just `/intel`). The sidebar collapses to five entries: Inbox, Couples, Dashboard, Settings, Sage.

**Critical analysis of Days 20-22:**
- *Doctrine:* "demand-driven dashboards." Five blocks, not forty.
- *Battery:* Block 5 (Sage NLQ) is the catch-all. The other four blocks each handle 2-4 specific battery questions natively.
- *Code shrinkage:* slight addition (~800 lines of React component + helpers).
- *Self-critique:* the previous version of me would build six blocks. Then seven. Then ten. Stop at five.

### Days 23-24: backtrace + Sage NLQ + battery test

Now that the spine is canonical and the read API is canonical, I can finally run the backtrace pass against the historical untracked bookings. The result lands in the spine cleanly (one writer, the cascade, accepts the recovered source via the touchpoint route). The canonical attribution function reads it.

After backtrace runs, I run the full 36-question battery against the new system. Sage NLQ for Q1-Q30; the surface blocks for the workflow-chain questions.

Battery passes ≥+1.0 average, zero −3 in Tier 4 → ship.

Battery fails → identify which questions failed, root cause, fix, re-run. Do not ship until pass.

**Critical analysis of Days 23-24:**
- *Doctrine:* the battery is the ship gate per §C.6. This is when we know.
- *Battery:* 100% of the battery runs against the new product surface for the first time.
- *Code shrinkage:* none today. Pure verification.
- *Self-critique:* without Susan, "ship" means "ready for first Susan." The bar is the same; only the audience is different.

### Day 25: final cleanup

Whatever didn't get done in Weeks 2-4 long-tail items, the migration baseline flatten, the changelog of what changed. Final commit + push + tag `consolidation-complete-2026-06-15`.

**End of Week 4:**
- One landing page is the product.
- 36 battery questions answer with ≥+1.0 average score.
- ~40,000 LOC lighter than Day 0.
- 5 sidebar entries.
- One writer. One reader API. One cascade. One brain stack. One source of truth.
- Ready for first Susan.

---

## What's different vs the previous plan

| Dimension | Previous plan | This plan |
|---|---|---|
| Susan in the loop | Yes — visible win Week 1 | No — invisible work Week 1 |
| Backtrace timing | Day 2 (bleeding stop) | Day 23 (after spine is canonical) |
| Deprecation strategy | 30-day grace period + banner | Delete immediately |
| Total days | 30 | 25 |
| Approval gates | 6 user gates | 1 user gate (Day 6 deletion budget) |
| Risk to live ops | Real (active inbox) | None (no live ops yet) |
| Aggressive deletion | No (Susan might be using it) | Yes (no Susan to break) |

---

## What I still need from you

One gate: **sign off on `CONSOLIDATION-PLAN-FROZEN.md` at end of Day 6** before Week 2 starts.

After that signoff, I work autonomously through Day 25, committing and pushing as I go. I'll surface critical-analysis self-assessments every 5 days as commit messages so you can see my thinking even if you don't review every PR.

If at any point you want to interrupt and redirect, the codebase is reversible to the pre-consolidation tag from Day 0.

---

## Honest risks specific to this version

**Risk 1: deletion goes too far.** I delete something that turns out to matter when the first Susan onboards. Mitigated by: git preserves everything; if a real user surfaces a need, restoring a deleted surface from history is a one-day add-back, not a rebuild from scratch.

**Risk 2: the battery is too lenient as a gate.** A passing battery doesn't guarantee a real user is satisfied. Mitigated by: the battery + a first-user pilot before charging. The 25-day plan ends with battery-ready, not market-ready. The first paying-customer arc is a separate 30 days after this one.

**Risk 3: I get the canonical API shape wrong on Day 3 and surfaces can't actually express their needs through it.** Mitigated by walking the worked examples through the contract on Day 3 itself. If I find a surface that can't be expressed through six functions, that's the moment to add a seventh, not Week 3.

**Risk 4: the consolidation produces a clean codebase that's still missing actual product features.** Real risk. The 25 days are about consolidating WHAT EXISTS, not building new capability. After Day 25, the codebase is sound but probably missing things a first paying venue needs (tour outcome workflow, contract signing flow, real billing tier enforcement). That's the next 30 days, not these 25.

---

That's the no-Susan version. Tighter, more honest, lower-risk because there's no live user to break. If you say go, Day 1 starts with the parallel audit.