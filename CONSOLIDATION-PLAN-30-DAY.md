# 30-Day Consolidation Plan — Self-Executable, With Parallel Agents

**Reframed from the previous 30-day plan.** I went back and was critical of it. Two things were wrong:

1. The previous version put architectural consolidation (Phase 1: pick one writer) before Susan-visible improvement. That means 10 days where Susan opens Bloom and still sees 63 Untracked. She doesn't have 10 days of patience and she shouldn't have to. The plan needed to surface visible wins in Week 1, not Week 3.

2. The previous version pretended one engineer working in series. I'm not one engineer in series. I can spawn parallel sub-agents for independent work, and I should design around that or I'm leaving leverage on the table.

Below is the rewrite. Each week ends with something Susan would notice. Each phase has critical-analysis blocks checking it against the 36 battery questions, against Susan, and against the doctrine.

---

## Week 1: make Susan see the right numbers (Days 1-7)

### Day 1: Parallel audit

I spawn six sub-agents simultaneously. Each one is a focused reader doing a different sweep over the codebase. I take the union when they all return.

| Agent | Mandate | Returns |
|---|---|---|
| A | Find every call site that writes to `weddings` table (any column) | List of files + line numbers + which writer is responsible |
| B | Find every call site that writes to `people` table | Same |
| C | Find every call site that writes to `interactions.wedding_id` | Same |
| D | Catalog every reader of `weddings.source`, `weddings.utm_source`, `attribution_events.source_platform` | List of files + which surface ultimately renders this |
| E | Catalog every page under `src/app/(platform)/intel/` with a one-line "what it shows" | A markdown table |
| F | Catalog every cron job — what it reads, what it writes, why it exists | A markdown table |

I spawn them in one tool-use block. They run in parallel. Total wall-clock: ~5 minutes. The synthesis is mine. The output is one document `CONSOLIDATION-AUDIT.md` committed to the repo, with three sections: writers, readers, surfaces.

**Critical analysis of Day 1:**
- *Battery questions:* none answered. Pure plumbing. The plan tolerates one day of zero Susan-visible improvement only because it unblocks Days 2-7.
- *Susan:* she sees nothing. Acceptable for one day, not more.
- *Doctrine:* essential prerequisite. You cannot enforce "one writer" until you have catalogued all writers. You cannot kill legacy reads until you have catalogued all readers.
- *Risk:* if I underestimate the breadth, Day 1 spills into Day 2. Acceptable.

### Day 2: backtrace the 63 untracked bookings

This is the highest single Susan-leverage move in the plan. I run the existing `source-backtrace` service in batch mode against every booked wedding with `source IN ('honeybook', NULL, 'untracked')`. The existing service is already redesigned for cluster-email matching + form-relay detection + confidence tiers; it just was never run at scale.

I do this as one sub-agent task:
- Sub-agent: build a script `scripts/run-backtrace-all.mjs` that iterates every Untracked booked wedding for Rixey, runs `backtraceOneWedding`, collects results.
- The script writes a `backtrace_results.csv` (operator-readable) with: wedding_id, current_source, suggested_source, confidence_tier, evidence_snippet.
- I commit + push the script. The user runs it (one command). The user reviews the CSV. The user confirms.

Then I auto-apply only the `confident_match` rows via `applyBacktrace`. Weak matches stay queued for operator review.

**Gate:** user reviews the CSV before the auto-apply step. This is non-negotiable. I do not retroactively rewrite 30+ bookings' source fields without explicit operator confirmation.

**Critical analysis of Day 2:**
- *Battery questions:* directly improves Q5 (multi-platform credit), Q26 (channel volume vs conversion), Q33 (consistency across reframings) once the spine has the data. Indirectly improves Q12 (YoY controlling for confounds).
- *Susan:* she opens /intel/sources tomorrow and probably 25-40 of the 63 Untracked bookings have a real source. The headline metric ($805k untracked) drops significantly. This is the visible win.
- *Doctrine:* backtrace writes weddings.source. That's still the LEGACY path. We need a follow-up that ALSO mirrors the recovered source into a spine touchpoint (acquisition channel_engagement). Otherwise /intel/attribution still shows holes. Day 3 fixes that.
- *Risk:* backtrace assigns the wrong source. The auto-apply only fires on confident_match (form-relay parser hit + identity-cluster email overlap). False positives at that confidence are rare. Weak matches stay queued.

### Day 3: mirror recovered sources into the spine

I write a one-shot script that walks every `wedding_touchpoints` row with `touch_type='inquiry'` and `signal_class='source'` produced by the backtrace and writes a corresponding spine touchpoint on the couple linked via `source_wedding_id`. This is what closes the gap between the legacy backtrace and the new spine reads.

The script is idempotent (upserts on `UNIQUE (venue_id, channel, external_id)`). User runs it once. Now /intel/attribution shows the same recovered sources /intel/sources does.

**Critical analysis of Day 3:**
- *Battery questions:* now Q5/Q26 work on both attribution surfaces. Q33 consistency check passes.
- *Susan:* if she opens /intel/attribution today, she sees the same recovered sources she sees on /intel/sources. Two surfaces, same answer. (This is exactly the test for whether the consolidation is working.)
- *Doctrine:* the spine now reflects history. The cascade-going-forward doctrine is fine; the cascade-for-historical question is solved by this one-shot mirror.
- *Risk:* if backtrace got something wrong in Day 2, it propagates to the spine in Day 3. Mitigated by the operator confirm gate in Day 2.

### Days 4-5: merge /intel/sources and /intel/attribution into one canonical page

Pick the winner. The right choice is the spine-reading one (D3 `/intel/attribution`) because that's where the future is going. /intel/sources gets a 302 redirect to /intel/attribution with all the legacy filters/segments preserved as URL params on the new page.

I spawn sub-agents:
- Sub-agent G: read `/intel/sources` rendering code, list every chart and table it shows. Return a markdown spec.
- Sub-agent H: read `/intel/attribution` rendering code, list every chart and table it shows. Return a markdown spec.

I diff the two specs. Anything on /intel/sources not on /intel/attribution gets added to /intel/attribution. After feature-parity, /intel/sources becomes a redirect.

I do the actual code consolidation myself (not in a sub-agent) because it involves merging React components and that's where subtle errors creep in.

**Critical analysis of Days 4-5:**
- *Battery questions:* Q26 + Q33 fully satisfied on one canonical page. No more "but which page is right."
- *Susan:* opens what used to be /intel/sources, lands on /intel/attribution, sees one set of numbers, sees the four model toggles (or one toggle if I take my own advice and remove three of them).
- *Doctrine:* one source of truth. The first real win against dual-state purgatory.
- *Risk:* losing a feature that was on /intel/sources but not on /intel/attribution. Mitigated by the spec diff.
- *Self-critique:* I was about to keep all four attribution models (first/last/linear/time-decay) because they're already coded. But my own critique was "Susan asks 'where did they come from' = first-touch." Be ruthless here. Default the page to first-touch. Make the others accessible via a "show advanced models" toggle. Don't show four numbers when one will do.

### Days 6-7: audit the other /intel surfaces against the canonical

Six sub-agents in parallel:
- Each takes 6-8 /intel pages (40+ total)
- Each agent: open the page in the codebase, identify what data source it reads, identify whether it shows attribution / heat / cohort / something else
- Return: keep / delete / merge into landing / merge into Sage NLQ

I synthesize into a single document `SURFACES-DECISION.md`. Each surface gets a verdict.

I do not delete anything yet. Day 22 is when surfaces get deprecated. But by end of Week 1, I know which 30+ surfaces are headed for the chopping block.

**Critical analysis of Days 6-7:**
- *Battery questions:* none answered today. Inventory work.
- *Susan:* no visible change.
- *Doctrine:* serves the "demand-driven dashboards" principle. Cannot collapse the surface set without knowing what's there.
- *Risk:* I miss a surface Susan secretly relies on. Mitigated by Day 22 deprecation banners (not deletions) and a "see all archived pages" affordance for 60 days.

**Week 1 verdict:**
Susan opens Bloom on day 7. The 63 Untracked headline is now ~25-40 Untracked (the remainder are genuinely lost). /intel/sources and /intel/attribution show the same numbers. She has not yet seen the new landing page, but she trusts the attribution number for the first time in months.

---

## Week 2: unify the writers (Days 8-14)

The audit from Day 1 surfaced every writer to weddings/people/interactions/couples/touchpoints. I expect roughly 20-25 writer call sites. Some are revenue-critical (the email pipeline's mint path). Some are obviously deletable (legacy backfill scripts). Most are somewhere in between.

### Day 8: design the single canonical writer contract

I write a doctrine document: every couple-mutating operation goes through `cascade_resolve_and_attach(venue_id, signal, adapter)`. The signal shape is the existing `NormalizedSignal`. The function returns `{ matched, couple_id, stage, touchpoint_id }`.

Every existing writer gets a migration plan: "writer X currently calls Y. After migration, writer X normalizes its input to a NormalizedSignal and calls cascade. The cascade does the write."

This is a design day. One commit: `CASCADE-CANONICAL-WRITER.md` doctrine doc. No code change.

**Critical analysis of Day 8:**
- *Battery questions:* none today.
- *Susan:* no visible change.
- *Doctrine:* this is THE doctrine document. Worth getting right before any code moves.
- *Risk:* the contract is wrong and Days 9-14 build on a flawed foundation. Mitigated by walking through 3-4 hard examples (HoneyBook contract import, Calendly invitee.created, Knot CSV row, brain-dump screenshot) in the doctrine doc.
- *Self-critique:* I considered shipping this as code first. The right move is doctrine first because the alternative is rebuilding the contract three times. One day of design saves three days of refactor.

### Days 9-11: migrate the high-volume writers

Three sub-agents in parallel, each handling one writer:
- Sub-agent: migrate the email pipeline's `mintWedding` path to call `cascade_resolve_and_attach` instead of the legacy resolveIdentity → createPerson → createWedding chain
- Sub-agent: migrate the Calendly webhook handler to the same
- Sub-agent: migrate the HoneyBook CSV import to the same

Each agent works in its own git worktree (the `isolation: "worktree"` option) so the changes don't collide. Each produces a PR-shaped commit. I review each, fix what's wrong, push.

I have to be honest: I can't actually do three of these simultaneously WITHOUT supervision, because if any of them is wrong, the whole pipeline breaks and Susan stops getting emails routed. So in practice this is two-in-parallel with me actively reviewing, not three-and-walk-away.

**Critical analysis of Days 9-11:**
- *Battery questions:* Q6 (duplicate identification) improves because all new writes go through the same dedup contract.
- *Susan:* invisible if I do it right, broken if I do it wrong. The Day 9-11 work is the highest-risk in the entire 30 days.
- *Doctrine:* this is THE doctrine win. After this, "one writer" is true, not aspirational.
- *Risk:* I drop a write. A new inquiry doesn't get a couple. Mitigated by: keeping the legacy path alive behind a feature flag for 48 hours after the cutover; comparing cascade-decided couples to the legacy path's couples for the first 48 hours; alerting on divergence.
- *Self-critique:* I'm tempted to do all 25+ writers in this week. That's wrong. The 5-7 highest-volume writers are 90% of daily writes; finish those, defer the rest. Long-tail writers (manual import scripts, backfill jobs, edge-case adapters) get the same migration in Week 4 or post-30-day.

### Days 12-14: deprecate the bypass paths

Now that the cascade is the canonical writer, every other writer that used to write directly gets either deleted or wrapped to call the cascade.

I run the audit from Day 1 again. Anything still writing direct gets a stop-write banner. Three sub-agents in parallel migrate the medium-volume writers (mirror-couple direct insert; backtrace's applyBacktrace; the post-wedding sweep's direct UPDATE on couples.lifecycle_state).

By Day 14 end: there is one writer. Everything else is either deleted or routed through it.

**Critical analysis of Days 12-14:**
- *Battery questions:* Q29 (identity merge confidence) becomes calibrate-able for the first time, because every merge happens through one rule set.
- *Susan:* still invisible.
- *Doctrine:* one writer achieved.
- *Risk:* I miss a writer in the codebase. Mitigated by a CI guard: a script that greps for direct INSERT/UPDATE to spine tables outside of `cascade_resolve_and_attach.ts`. Any new code that bypasses the cascade fails CI.
- *Self-critique:* This guard should land Day 14, not "later." Without it, the codebase regresses to multi-writer within a sprint.

**Week 2 verdict:**
There is one canonical writer. Susan still sees the same things she saw on Day 7. The internals are now sane. Doctrine is enforced by CI guard.

---

## Week 3: kill legacy reads + flatten the spine (Days 15-21)

### Days 15-17: migrate the load-bearing reads

The Day 1 audit listed every reader of `weddings.source`, `attribution_events.source_platform`, etc. I work through them surface by surface, migrating each to read the spine.

Three sub-agents in parallel:
- Sub-agent: migrate `/intel/roi` to read spine
- Sub-agent: migrate `/intel/clients` (the wedding list) to read spine
- Sub-agent: migrate the legacy /agent/* surfaces that read weddings.source

Each agent verifies the migrated surface shows the same numbers as before (where the spine has data) and an honest "data missing" state (where it doesn't).

**Critical analysis of Days 15-17:**
- *Battery questions:* Q33 consistency now holds platform-wide. Every page shows the same answer for the same question.
- *Susan:* she might notice numbers shift slightly as legacy-overwrites stop affecting display. Net positive.
- *Doctrine:* "every reader reads the spine" achieved.
- *Risk:* spine has a hole the legacy read didn't (e.g., a wedding without a corresponding couple). Mitigated by the Week 1 mirror script + a one-shot "every wedding has a couple" check on Day 15.
- *Self-critique:* I keep saying "migrate surface X to read spine." The reality is each surface has its own custom rollup logic. The right move is to extract canonical rollup functions (`getSourceFunnel(venueId)`, `getCohortMetrics(venueId, opts)`, etc.) that every surface calls. The surfaces become dumb renderers. Without this extraction, "migrate to spine" means rewriting each surface's logic, which is exactly the sprawl that produced the problem.

### Days 18-19: extract canonical rollup functions

One sub-agent + my supervision. I define a single `src/lib/intel/canonical.ts` that exports a small number of functions every surface uses:

```ts
// The complete read API for Intel surfaces
getVenueOverview(venueId): VenueOverview               // counts, top-line metrics
getSourceAttribution(venueId, opts): SourceAttribution // /intel/attribution data
getCohortFunnel(venueId, opts): CohortFunnel           // /intel/cohort data
getCoupleJourney(venueId, coupleId): CoupleJourney     // /intel/couples/[id]
getDailyList(venueId): DailyList                       // the landing page
askIntel(venueId, question): NLQResponse               // Sage NLQ
```

Six functions. Every Intel surface calls one of these. Sub-services consolidate. Many `src/lib/services/intel/*` files become unused and get deleted.

**Critical analysis of Days 18-19:**
- *Battery questions:* Q33 consistency now structurally enforced — same function, same data, same answer.
- *Susan:* no visible change.
- *Doctrine:* "demand-driven dashboards via canonical functions" achieved at the API level.
- *Risk:* the canonical API is wrong-shaped and surfaces start adding back per-surface helpers. Mitigated by CI guard: surfaces under `src/app/(platform)/intel/*` cannot import from `src/lib/services/intel/*` directly — only from `src/lib/intel/canonical.ts`.

### Days 20-21: delete the dead intel services

The Day 1 audit listed ~100 intel sub-services. By Day 19, most of those are no longer imported. I spawn one sub-agent: walk `src/lib/services/intel/`, find every file with zero importers, propose deletion. I review the list, accept it, delete.

Net delete target: 40-60 files. ~15,000-20,000 lines of code.

**Critical analysis of Days 20-21:**
- *Battery questions:* indirectly improves Q12, Q15, Q16, Q24, Q25 — the "is something changing" and "real insight" questions, because fewer drifting opinions exist.
- *Susan:* still no visible change. This is the largest invisible win in the plan.
- *Doctrine:* the swamp drains.
- *Risk:* I delete a file I shouldn't have. Mitigated by git (everything is recoverable) + the deletion happens in one PR that can be reverted as a unit.
- *Self-critique:* the temptation is to keep files "in case." Don't. Git is the archive. Code that isn't imported is code that doesn't run; if it doesn't run, deleting it cannot break Susan's experience.

**Week 3 verdict:**
There is one canonical Intel API. There is one canonical writer. There are ~50 fewer files. /intel/* surfaces show consistent numbers because they read the same functions. Susan sees small consistency improvements but the big change is still ahead.

---

## Week 4: one landing page + Sage NLQ for everything else (Days 22-30)

### Days 22-25: build the daily-list landing page

This is the new `/` (or `/intel`) — the first thing Susan sees after login.

I do this work myself (not via sub-agents) because it's the most important surface in the product and the design quality determines whether the consolidation succeeds.

Five blocks. Each block reads one canonical function. None of them shows a chart unless the chart is essential.

```
/intel landing
├── Block 1: Today (3 couples to reply to)
│   reads: getDailyList(venueId).inboxPriority
├── Block 2: This week's tours
│   reads: getDailyList(venueId).upcomingTours
├── Block 3: At risk (3 couples whose heat is dropping)
│   reads: getDailyList(venueId).atRiskCouples
├── Block 4: This week's one pattern (Sage-narrated)
│   reads: askIntel(venueId, "what is the one pattern from this week worth noticing")
└── Block 5: Ask Sage anything (text box)
    reads: askIntel(venueId, userQuestion) on submit
```

Each block has a "see more" link to a deeper surface. Block 5 is the wildcard that replaces 30+ deep-dive pages.

**Critical analysis of Days 22-25:**
- *Battery questions:* Block 5 (Sage NLQ) is meant to answer most of the battery in natural-language form. Questions 1-30 of the battery become NLQ answers. Specific tests:
  - Q1 (median response time + delta): Sage answers in Block 5.
  - Q19 (likely-to-ghost): Block 3 surfaces this directly; Block 5 explains why for any specific couple.
  - Q33 (consistency across reframings): the underlying canonical function returns the same data, so Sage's answers are consistent.
  - Q34 (find 3 couples + draft + explain): Block 1 IS this workflow. The drafts are right there.
- *Susan:* opens Bloom on Day 25 and sees something fundamentally different from what she's been seeing for six months. One page. Five things. Five answers. No tabs. No menu. This is the moment of truth.
- *Doctrine:* every block reads from one canonical function. There is no sidebar with 40 entries. The product becomes about ACTION, not navigation.
- *Risk:* Sage's Block 4 weekly pattern is dull or wrong. Mitigated by Sage having access to the full canonical Intel API at NLQ time; Block 4 is generated by Sage selecting from the most-notable pattern of the week, with operator feedback ("not interesting" / "tell me more") feeding back into the loop.
- *Self-critique:* the previous version of me would have built more blocks. Six blocks instead of five. Seven. Ten. Each new block looks like a small addition; together they reproduce the sidebar sprawl in a new location. Five is the doctrine.

### Days 26-28: wire Sage NLQ to canonical functions

Block 5 is only as good as Sage's ability to answer questions from the canonical API. I spend three days on the prompt assembly:
- Sage gets a context block that summarizes what the canonical functions can return.
- For each operator question, Sage decides which canonical function(s) to call, calls them, narrates the answer with cited evidence.
- Honesty rails apply: when data is missing, Sage says so; when the n is below threshold, Sage refuses to confidently rate; when the question is forecast-shaped, Sage hedges.

I run the full 36-question battery against this surface as the verification step. Score has to be ≥+1.0 average, zero −3 in Tier 4.

**Critical analysis of Days 26-28:**
- *Battery questions:* this is where the battery becomes the gate. If the battery doesn't pass, the consolidation isn't done, regardless of whether the rest of the work shipped.
- *Susan:* she can ask Sage anything and get a real answer with evidence. The 30+ deprecated /intel pages are no longer needed because Block 5 is the universal answer machine.
- *Doctrine:* "honesty in the runtime" achieved end-to-end. Sage refuses what it can't answer; cites evidence for what it can.
- *Risk:* Sage confabulates on Tier 4 honesty questions. Mitigated by the honesty rails I already shipped + the battery as the gate.

### Days 29-30: deprecate the old surfaces

Every /intel/* route except the new landing and the journey ribbon gets a deprecation banner: "This page is moving to the new dashboard + Sage. Ask Sage anything you used to look up here. This page will be removed in 30 days."

The pages still work for 30 days. After 30 days, they 404. Their data is in the canonical functions; their UIs were the bloat.

I update the nav config so the sidebar has 5 entries instead of 40:
- Inbox (Agent)
- Couples list
- Today (the new landing)
- Settings
- Sage chat

That's the entire navigation.

**Critical analysis of Days 29-30:**
- *Battery questions:* if the battery passes after the deprecation, the consolidation is done.
- *Susan:* she opens Bloom for the first time after the deprecation and sees five things in the sidebar. This is the visible change. Nothing she does requires more than five sidebar entries.
- *Doctrine:* "demand-driven dashboards" fully achieved.
- *Risk:* she had a workflow that depended on one of the deprecated pages. Mitigated by the 30-day grace period + a "see archived pages" link on the landing.

**Week 4 verdict:**
Susan opens Bloom on Day 30. She sees one landing page with five blocks. She can ask Sage anything. The sidebar is five entries. The numbers are consistent because they all read one canonical Intel API. The writers are unified. The dead code is deleted. The battery scores ≥+1.0.

---

## The parallel-agent execution model in detail

I spawn agents in three patterns:

**Pattern A: parallel audit.** Many independent reads. Used Day 1 (writer/reader/surface audit), Day 6 (per-surface verdicts), Day 20 (dead-file identification). Six agents in one tool-use block; I synthesize.

**Pattern B: parallel migration (worktree).** Each agent gets its own git worktree via `isolation: "worktree"` and migrates one writer or one surface. Used Days 9-11 (writer migration) and Days 15-17 (surface migration). Maximum three in parallel because they touch shared files (the canonical functions, the type definitions).

**Pattern C: serial verification.** Builds, tests, deploys, battery runs. These run in series because they validate the whole tree, not a part of it. I run the battery once after each major commit.

What I cannot parallelize: the doctrine work (Day 8 contract design, Days 22-25 landing page design). These require human-shaped reasoning, one decision at a time. I do these myself.

---

## Self-assessment checkpoints

I run an honest self-critique every 5 days. The questions:

1. **Susan-test:** would Susan notice a positive change from the last 5 days of work?
2. **Battery-test:** what battery questions are now better-answerable than they were 5 days ago?
3. **Doctrine-test:** is the spine more canonical, or less, after the last 5 days?
4. **Sprawl-test:** did I delete more lines of code than I added? If not, why not?

If the answer to any of those is "no" or "I don't know" for three consecutive checkpoints, the plan is wrong and I stop and replan with the user.

---

## What I cannot do alone (gates that need the user)

- **Day 2 backtrace auto-apply:** user reviews CSV before I run apply.
- **Day 8 canonical writer contract:** user signs off on the contract doc before Days 9-11 code lands.
- **Day 14 CI guard:** user signs off on the no-direct-write CI rule (because it's a permanent constraint on the codebase).
- **Day 20 dead-file deletion:** user signs off on the deletion PR before it merges.
- **Day 25 landing page:** user signs off on the five-block design before I wire NLQ.
- **Day 30 deprecation:** user signs off on the deprecation banner + sidebar collapse.

Six gates in 30 days. Each gate is a single yes/no from the user that lets the next block of work proceed. Between gates I work autonomously.

---

## What success looks like at day 30

A specific list. Each item is testable.

- One writer to the spine (CI-enforced).
- One Intel API (six canonical functions).
- Five-block landing page is the default Bloom experience.
- Sage NLQ answers all 36 battery questions with average score ≥+1.0 and zero −3 in Tier 4.
- Sidebar has five entries. The 30+ deprecated /intel pages are 404 with a "go to landing" redirect.
- The codebase is 30,000-40,000 lines lighter than it is today (current ~111k → target ~75k).
- The 365 migrations have been collapsed to a fresh-baseline + Week-4 deltas.
- /intel/sources and /intel/attribution are one page that shows consistent recovered-source data.
- Susan opens Bloom on day 30 and says "this is finally a product."

---

## The honest risks

**Risk 1: Day 2 backtrace recovers fewer than 25 of 63.** If the original inquiry emails are genuinely lost (predate Gmail backfill), even perfect backtrace doesn't help. Susan still sees Untracked. We don't add a new dashboard for this; we say so honestly.

**Risk 2: Week 2 writer migration breaks the email pipeline.** Highest single risk in the plan. Mitigated by feature-flag + 48-hour comparison + alert-on-divergence. If divergence is detected, roll back immediately.

**Risk 3: Sage NLQ doesn't pass the battery on Day 28.** Then Day 29-30 isn't a deprecation; it's a "deprecate everything except the surfaces that answer battery questions Sage can't." A partial consolidation is still a consolidation.

**Risk 4: I underestimate the writer count and Week 2 spills into Week 3.** Acceptable. The plan absorbs one week of slip without missing the Day 30 landing-page deliverable, by deferring the long-tail writers to post-30-day.

**Risk 5: I forget that I'm not a 24/7 engineer.** I cannot work for 30 calendar days continuously. The plan is "30 days of work" not "30 calendar days." Susan needs to know that.

---

That's the plan. It's tighter than the previous version, Susan-visible from Week 1, doctrine-anchored at every step, battery-gated at the end, and structured for parallel-agent execution where it pays off. If you say go, I start with Day 1's audit tomorrow.