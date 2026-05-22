> ⚠️ **SUPERSEDED 2026-05-22 by `CONSOLIDATION-PLAN-PHASED.md`.**
> The 25-day frame compressed the work in two ways that the anatomical pass
> proved wrong: deletion in the middle (must be last) and a 7-day four-limb
> migration sprint (must be one limb at a time). The phased plan (~3 months)
> is the active master plan. This document is kept for its § N corrections
> and the audit trail — its analysis fed forward; its calendar did not.

# 25-Day Consolidation Plan — ANCHORED VERSION

**Date:** 2026-05-21
**Supersedes:** `CONSOLIDATION-PLAN-25-DAY-NO-SUSAN.md` (preserved for diff)
**Anchored against:**
- `ASSUMPTIONS-VS-REALITY.md` — grep/read-verified counts
- `ENGINEERING-BUILD-PLAN.md` — target architecture (the "as if building new" spec)
- `CRITICAL-AUDIT.md` — what to wipe / what's overengineered

**The rule (from § Part 6 of bloom-may21-session memory):** *Every claim in this plan is grep-verified or read-verified. "Probably," "I expect," "I assume" are not permitted. If a number cannot be verified, the verification IS the task in the plan, not an assumption underneath it.*

---

## A. Anchoring summary — every number corrected vs. prior plan

| Prior plan claim | Verified reality | Source |
|---|---|---|
| 111,000 LOC | **85,877 LOC** in src/ | ASSUMPTIONS § Counted reality |
| 365 migrations | **363** migrations | ditto |
| ~40 /intel surfaces (target ~5 KEEP) | **65 page.tsx** under `src/app/(platform)/intel`; target 6-8 KEEP | ditto |
| ~100 intel sub-services | **80 files** in `src/lib/services/intel/` | ditto |
| ~15 brain files | **14 files** in `src/lib/services/brain/` | ditto |
| ~5 identity resolution paths | **70 files** in `src/lib/services/identity/` | ditto |
| ~12 healing crons | **47 cron paths** in `vercel.json` | ditto |
| Gmail backfill "probably 90 days" | **1095 days for booked**, already built end-to-end at `src/lib/services/email/historical-backfill.ts` | ditto |
| ~25 writer call sites | **UNKNOWN** — broad grep returns 596 refs (reads+writes). Real writer-only count is the OUTPUT of Day 1, not an input | ditto + Liam Hunt diagnosis (3 sites in pipeline.ts confirmed: 2198, 2850, 3053) |
| Delete ~40,000 lines (target -36%) | Against verified 85,877 base, a 40k delete is **-47%**, not -36%. Still possibly correct, but state it honestly | ditto |
| The cascade is "canonical" | Cascade has **2 real call sites** (matcher.ts:364, resolution.ts:548). Legacy weddings/people/interactions has **596 refs**. Spine is **5% presence**, not canonical | ditto |
| "LLM judge: delete entirely" | **Self-corrected** to "measure judge fire-rate + accuracy before deciding" — judge fires in intent-classifier + cluster-proposals; removing without measurement could damage classification quality | ASSUMPTIONS § Specific claims |
| Three SQL operator queries answered | **Still open** — backfill status, untracked-with-interactions count, Liam-Hunt-scope. Plan does NOT begin until these answer | ASSUMPTIONS § Open questions |

---

## B. Three buckets for the Engineering Build Plan deltas

The Engineering Build Plan describes the architecture as if building new. The 25-day consolidation can only handle a subset of the deltas. Every delta is named here and assigned to one bucket. Nothing is forgotten.

### Bucket A — DELETIONS that belong INSIDE the 25 days
These are choices already justified by the Critical Audit + the audit's reality check. They go into Day 6's kill list (`CONSOLIDATION-PLAN-FROZEN.md`):

| Delta | Build plan position | Audit position | Day in this plan |
|---|---|---|---|
| Drop 3 of 4 attribution models in the UI (first-touch only visible) | All four with toggle | First-touch is the only one Susan asks for | Day 6 kill list; UI removed by Day 17-18; function keeps all 4 as opts |
| Fold `fragments` into `touchpoints` with null `couple_id` | Separate table | Fragments = touchpoints that didn't anchor; same shape | Day 6 decision; Day 19 schema migration |
| Fold `couple_progression_events` into `touchpoints` with stricter `action_type` | Separate table | Special-case of touchpoints | Day 6 decision; Day 19 schema migration |
| Collapse 14 brain files into ≤4 canonical brains | Per-surface brains | Two brains: Agent + Intel | Day 2 doctrine; Day 17-19 collapse |
| Delete `~55` of 65 /intel routes | Each Intel surface has its own page | Intel is one page, not 40 | Day 6 kill list; Day 19 mass delete |
| Delete `~60` of 80 `src/lib/services/intel/*` files | One service per derivation | Six canonical Intel functions handle it | Day 6 kill list; Day 19 mass delete |
| Delete `~30` of 47 cron paths in vercel.json | 12 named healing crons | Crons exist to repair multi-writer drift; cascade-as-only-writer makes most obsolete | Day 6 kill list; Day 19 mass delete |
| Multi-writer drift sweeps (lifecycle-audit, suspect-merges, post-wedding-sweep direct UPDATEs) | Idempotent rerun-safe | After Day 13 there's nothing to repair | Day 19 mass delete |

### Bucket B — ADDITIONS that don't fit in 25 days
These are real net-new capabilities that the build plan specifies but consolidation cannot deliver. They are NAMED here so they cannot drift; they become inputs to the post-consolidation 30-day plan:

| Delta | Build plan position | Why deferred |
|---|---|---|
| `intel_rollups` two-tier compute (real-time + nightly cache) | §6 | No surface measured >500ms; premature optimization for 25-day window |
| `platform_benchmarks` cross-venue aggregates with percentiles | §8.3 | Needs >1 paying venue; no Susan = no benchmarks |
| Multi-venue isolation: federated themes ("your themes + your segment's themes") | §8.4 | Same — needs >1 venue |
| Five-loop integration tests (loop2 prediction, loop4 positioning, loop5 capacity) | §10.2 | Loop 1 (voice) + Loop 3 (attribution) covered in battery; the other three are post-25 |
| Onboarding flow + 5-day enterprise project guide | §13 Days 76-90 | Not survival; first-Susan polish |
| Full per-surface AI cost circuit-breaker (Sonnet→Haiku→template degradation) | §12.2 | Partial implementation exists (circuit-breaker.ts); full surface-by-surface tier is post-25 |
| Per-cron `cron_runs` audit table | §7 (Every cron writes audit row) | Add when collapsing crons in Day 19; partial in current code |
| Couple portal Loop 4 (couple-facing review themes feed Sage's next draft) | §13 Days 61-75 | Net-new feature; not part of consolidating what exists |
| `external_context` table cleanup (FRED + weather + cultural moments already partially built) | §2.3 | Critical Audit calls these "research artifacts"; Day 6 decides keep-or-fold; full work deferred |
| Battery CI gate on every PR (not just human-run at Day 23-24) | §10.3 | Add the gate after the first end-to-end pass; not a Day-1 dependency |

### Bucket C — DOCTRINE DECISIONS made DURING consolidation
These are choices where the Build Plan and the Critical Audit disagree, and the disagreement has to be resolved by a written decision in Days 2-3 (not deferred):

| Question | Build plan answer | Critical Audit answer | Decision (Day 2-3) |
|---|---|---|---|
| Five loops or one loop? | All five (voice, prediction, attribution, positioning, capacity) | One (draft loop) is survival; other four are post-survival | Keep Loop 1 (voice — Agent draft) and Loop 3 (attribution — already built) at production quality. Loops 2/4/5 stay in code but are not battery-gated and not Susan-facing |
| Four attribution models or one? | All four with toggle (first/last/linear/time-decay) | First-touch only | Function keeps all four as opts; UI surfaces only first-touch by default. Cost: ~zero — the math is already written |
| Twelve+ spine tables or six? | ~30 tables across spine + body + cron audits + cost + cache | Six is the minimum (couples, touchpoints, tours, reviews, couple_merge_events, candidate_matches) | Fold `fragments` + `couple_progression_events` into `touchpoints` (Bucket A); keep `external_context` (Day 6 decides); keep observability tables (`api_costs`, `voice_learning_events`); do NOT add `intel_rollups`/`platform_benchmarks` (Bucket B) |
| 90-day phased build or honest 120? | 90 days, 6 phases | 120 days, three deliverables | The 25-day consolidation is independent; after Day 25 the post-consolidation 30-day plan is the active timeline. The 90-day six-phase build sequence becomes the input to whatever comes after that |
| LLM judge delete or keep? | Keep as confirm/reject for 40-90 band, writes `candidate_matches.judge_reason` | Delete (cost not earned) | **DEFER to Day 6** — measure judge fire-rate + accuracy from `api_costs` + `candidate_matches.judge_reason` before Day 6 deletion decision. If the judge is firing <5%/month with >90% agreement, delete. Otherwise keep |

---

## C. Pre-flight: Operator SQL answers (Day -1)

The plan cannot begin until three queries from `ASSUMPTIONS-VS-REALITY § Open questions` are answered. Without them, Day 1 repeats the assumption sin.

```sql
-- Q1: Did the 3-year backfill complete on Rixey?
SELECT id, name, gmail_backfill_status, gmail_backfill_phase,
       gmail_backfill_cursor, gmail_backfill_emails,
       gmail_backfill_updated_at
  FROM venues WHERE slug = 'rixey-manor';

-- Q2: Of the 63 Untracked bookings, how many have ANY interactions?
SELECT w.id, w.source, count(i.id) AS interaction_count
  FROM weddings w
  LEFT JOIN interactions i ON i.wedding_id = w.id
 WHERE w.venue_id = '<rixey>'
   AND w.status = 'booked'
   AND (w.source IS NULL OR w.source IN ('honeybook','untracked'))
   AND w.merged_into_id IS NULL
 GROUP BY w.id, w.source
 ORDER BY interaction_count DESC;

-- Q3: Scope of the Liam-Hunt-shaped duplicate-partner2 bug
SELECT w.id, w.status, count(p.id) AS people_count,
       array_agg(p.first_name || ' ' || COALESCE(p.last_name,'null')) AS names
  FROM weddings w JOIN people p ON p.wedding_id = w.id
 WHERE w.venue_id = '<rixey>'
   AND w.status = 'booked'
   AND p.merged_into_id IS NULL
 GROUP BY w.id, w.status
HAVING count(p.id) > 2
 ORDER BY count(p.id) DESC;
```

**Branch logic on Q1's answer:**
- `gmail_backfill_status = 'complete'` → backfill ran; the 63 Untracked failure is downstream (backtrace, not ingestion). The plan can proceed; Day 23 backfill task becomes "verify" not "run."
- `gmail_backfill_status = 'running' OR 'pending'` → let it finish before Day 1. Wait, don't plan.
- `gmail_backfill_status IS NULL OR 'never_started'` → backfill never ran. **Day 23-24 backfill becomes critical path, not verification.** Also applies the doctrine refinement (Bucket A → see § E.Day-22.5 below).

**Branch logic on Q3's answer:**
- If duplicate-partner2 affects <5 weddings → fix during the writer migration on Days 7-9 (drop those rows + dedup in cascade contract).
- If affects 5-50 weddings → same, plus a one-shot maintenance script after Day 13.
- If affects >50 weddings → escalate; add a Day 13.5 dedicated reconcile pass after the writer migration completes.

---

## D. Phase 0: Tag pre-state (Day 0)

```bash
git checkout master
git pull origin master
git tag pre-consolidation-2026-05-21
git push origin pre-consolidation-2026-05-21
```

Also create a persistent Supabase branch from current production state — every schema change in Days 7-19 tests against the branch first; promote when stable per Build Plan §11.4.

---

## E. Week 1: Doctrine + Audit (Days 1-6)

### Day 1 — Parallel audit

Spawn **seven** sub-agents in one tool-use block (added Agent G for RLS).

| Agent | Mandate | Anchored target |
|---|---|---|
| A | Find every call site that **writes** (insert/update/delete) to `weddings`, `people`, `interactions.wedding_id`. AST-aware via ts-morph, not regex. Return file + line + which writer is responsible. | The 596-grep count is reads+writes combined. Real writer count is unknown. This number IS the output |
| B | Find every call site that writes to `couples`, `touchpoints`, `fragments`, `couple_progression_events`. Same shape | Verify the "2 cascade call sites" claim; identify other spine writers if any |
| C | Find every reader of `weddings.source`, `weddings.utm_source`, `attribution_events.source_platform`, `wedding_touchpoints.*`. List the surface each renders into | Maps surfaces to source-attribution dependency |
| D | Catalog every page under `src/app/(platform)/intel/` (verified count: 65) and `src/app/(platform)/agent/`. Return: route + what it shows + which service it imports + KEEP/MERGE/DELETE verdict | 65 pages → target ≤8 KEEP per Day 6 |
| E | Catalog every service file under `src/lib/services/intel/` (verified: 80), `src/lib/services/brain/` (verified: 14), `src/lib/services/identity/` (verified: 70). Return: file + who imports it + KEEP/MERGE/DELETE verdict | 80+14+70 = 164 files → target ≤30 KEEP across all three directories |
| F | Catalog every cron path in `vercel.json` (verified: 47). Return: name + schedule + what it reads + what it writes + why it exists + KEEP/MERGE/DELETE verdict | 47 crons → target ≤12 KEEP per Build Plan §7 list |
| **G (new)** | Audit RLS: every table with `venue_id`, verify a `venue_scoped_*` policy exists, verify cross-venue read is impossible from any anon/auth user without org-admin membership. List tables missing policy | Build Plan §2.4 R4 "multi-tenant from line zero" enforcement |

Synthesis: `CONSOLIDATION-AUDIT.md` committed. Four sections (writers, readers, surfaces+services, RLS) and one summary table.

**Critical analysis of Day 1:**
- *Doctrine:* essential prerequisite. Cannot enforce R1 ("one writer") without knowing all writers; cannot enforce R4 ("multi-tenant") without knowing the RLS gaps.
- *Battery:* none today.
- *Code shrinkage:* none today. Builds the kill list.
- *Self-critique:* my prior plan estimated "~25 writer call sites." That was a guess. Today's output replaces it with a number. If the real number is 100+, the writer-migration in Days 7-13 needs more sub-agents or more days, not the same shape with a different label.

### Day 2 — Canonical writer contract doctrine

Write one doctrine document: `CASCADE-CANONICAL-WRITER.md`. It specifies:

- The one function signature: `cascade_resolve_and_attach(venue_id, signal, adapter)` — matches Build Plan §3.1 verbatim
- The signal shape (`NormalizedSignal`) — Build Plan §4 verbatim
- The return shape (`{ matched, couple_id, stage, reason, touchpoint_id, audit_event_id, correlation_id }`)
- The transaction boundary (advisory lock + write + audit row in one transaction) — Build Plan §3.1
- **The partner2 dedup invariant** — explicit: cascade NEVER creates a second partner2 row when a partner1 of that first_name already exists on the wedding. Solves the Liam Hunt failure shape; codified as a writer-side rule rather than a post-hoc tombstone (Wave 4 Phase 4 was tombstone; this is preventative).
- **Four worked examples** — HoneyBook contract import, Calendly invitee.created, brain-dump CSV row, Knot screenshot OCR — Build Plan §3 examples.
- **The migration contract** — every existing writer documents which steps become normalize(), which become signal fields, which get deleted.
- **Bucket C decisions baked in here:**
  - Schema collapse: `fragments` becomes `touchpoints WHERE couple_id IS NULL`; `couple_progression_events` becomes `touchpoints WHERE action_type IN ('progression_*')`. Migration plan committed to Day 19.
  - Five loops → Loop 1 + Loop 3 named as production quality; Loops 2/4/5 documented as "in code but not battery-gated."
  - Four attribution models → all kept as opts; UI surfaces first-touch by default.

No code change. One doc.

**Critical analysis of Day 2:**
- *Doctrine:* this IS the doctrine document. Worth getting right before any code moves.
- *Battery:* indirectly Q6 (duplicate identification) + Q29 (merge confidence). Both depend on consistent writer behaviour.
- *Code shrinkage:* none today.
- *Self-critique:* the prior plan deferred the partner2 dedup to "Wave 4 Phase 4 should catch it." It doesn't. Codifying it in the writer contract makes the prevention permanent.

### Day 3 — Canonical Intel API contract doctrine

Write `INTEL-CANONICAL-API.md`. Six functions, each with full TS interface:

```ts
getVenueOverview(venueId: string): Promise<VenueOverview>
getSourceAttribution(venueId: string, opts: { model?: 'first'|'last'|'linear'|'time_decay'; period?: DateRange }): Promise<SourceAttribution>
getCohortFunnel(venueId: string, opts: { period?: DateRange; segment?: SegmentKey }): Promise<CohortFunnel>
getCoupleJourney(venueId: string, coupleId: string): Promise<CoupleJourney>
getDailyList(venueId: string): Promise<DailyList>
askIntel(venueId: string, question: string): Promise<IntelAnswer>
```

Every function:
- Returns honest "no data" — `{ value: null, n: 0, enoughData: false, reason: 'insufficient_sample' }`
- Logs to `api_costs` with task_type + venue_id + prompt_version (R5 enforcement)
- Has its return shape locked at TypeScript level (no `any`)

**Critical analysis of Day 3:**
- *Doctrine:* the read counterpart to Day 2. Together they constrain the entire data path.
- *Battery:* directly relevant to Q33 (consistency across reframings) — three framings of "best channel" call the same `getSourceAttribution`, same data, same answer.
- *Code shrinkage:* none today.
- *Self-critique:* if I find myself defining a seventh function next week, I fold it into one of the six as an opt. The number of API functions does not grow.

### Days 4-5 — Stub the contracts

- `src/lib/spine/cascade.ts` — canonical writer stub. Returns `{ ok: true, stub: true }`.
- `src/lib/intel/canonical.ts` — six read functions. Each returns empty / null / fixture data.

Integration tests against the stubs verify return-SHAPE is honored.

Walk the four worked examples from Day 2 through the stub signatures and confirm each can be expressed. If any cannot, **fix the contract before Day 6**, not after.

**Critical analysis of Days 4-5:**
- *Doctrine:* contracts become enforceable, not just documentation.
- *Code shrinkage:* +500 lines today (stubs + tests). Pays back 30x in Week 3.

### Day 6 — Kill list + Bucket A decisions

Take Day 1 audit + Day 2-3 contracts and produce `CONSOLIDATION-PLAN-FROZEN.md`. For every file in the Day 1 catalog:
- **KEEP** (rewrite to call cascade or canonical API)
- **MERGE** (into which file)
- **DELETE** (why nothing else needs it)

Expected breakdown (anchored to verified counts):

| Category | Verified count | KEEP target | MERGE target | DELETE target |
|---|---|---|---|---|
| Writer call sites | UNKNOWN (Day 1 output) | most | few | a few |
| `/intel` page.tsx | 65 | 6-8 | 3-5 (into canonical landing) | ~53-57 |
| `src/lib/services/intel/*` | 80 | 10 | ~10 (folded into canonical Intel) | ~60 |
| `src/lib/services/brain/*` | 14 | 2 (Agent + Intel brain) | 10 (folded into the 2) | 2 |
| `src/lib/services/identity/*` | 70 | ~15 (cascade + matcher + reconcile) | ~20 (folded) | ~35 |
| Cron paths in vercel.json | 47 | ~12 (per Build Plan §7) | 0 | ~35 |
| Migration files | 363 | (no delete; collapse into baseline migration on Day 19) | | |

Also decided at Day 6:
- **LLM judge keep/delete:** read `api_costs WHERE task_type LIKE '%judge%'` for the trailing 30 days. If fire-rate <5%/month → DELETE. If >5% and `candidate_matches.judge_reason` shows >90% agreement with operator → DELETE. Otherwise KEEP. (Measurement-driven, not assumption-driven.)
- **`external_context` keep/delete:** if any kept surface reads from it → KEEP. Otherwise DELETE.
- **`fragments` + `couple_progression_events` collapse:** confirmed; Day 19 migration plan written.

**This is the document that needs your sign-off before Week 2.** Once signed, every deletion is pre-authorized.

**Critical analysis of Day 6:**
- *Doctrine:* deletion budget makes consolidation enforceable.
- *Code shrinkage:* targets committed — 85,877 → ~50,000 (47% delete). State this honestly.
- *Self-critique:* the temptation is to mark too many things KEEP "just in case." Aggressive deletion is the entire point. Err on DELETE; git preserves restorability.

**End of Week 1:**
- Two doctrine docs frozen (writer + reader contract)
- One audit doc committed (CONSOLIDATION-AUDIT.md with 7 sections incl. RLS)
- One stub layer + tests
- One signed-off kill list
- Three Bucket A decisions committed (attribution model count, schema collapse, brain count)
- Three Bucket C decisions committed (loops, attribution UI, judge)
- LLM judge fate decided (measurement-driven, committed on Day 6)
- Zero production code changed
- ~+500 LOC added

The UI looks exactly like Day 0. Most-important week. Most-boring week.

---

## F. Week 2: Writer migration (Days 7-13)

### Days 7-9 — High-volume writer migration

Three sub-agents in parallel, each in its own git worktree:

| Worktree | Target |
|---|---|
| A | Migrate `mintWedding` + the three pipeline.ts insert sites (lines 2198, 2850, 3053 — confirmed by Liam Hunt diagnosis). Refactor each to build `NormalizedSignal` → `cascade_resolve_and_attach`. Partner2 dedup enforced inside cascade per Day-2 contract |
| B | Migrate the Calendly webhook handler (`src/app/api/calendly/webhook/route.ts`) |
| C | Migrate the HoneyBook CSV/webhook handler |

Review each worktree's diff before merging. Sequential merge to master; build verifies between merges. Integration tests from Day 4-5 run between merges.

**Bucket B partial:** `cron_runs` audit table — add now as the cascade RPC writes a `cron_runs` row when called by a cron. Build Plan §7 says "Every cron writes a cron_runs row." Get the table created here; backfill the writes during Days 10-11.

**Critical analysis of Days 7-9:**
- *Doctrine:* after these three migrations, ~80% of daily-volume writes route through the cascade. R1 partially achieved.
- *Battery:* Q6 + Q29 calibrate for the first time (consistent rule set across new merges).
- *Code shrinkage:* delete the legacy resolveIdentity → createPerson → createWedding chain inside mintWedding (~400 lines). Net -400.
- *Self-critique:* if Day 1 audit revealed >25 high-volume writer sites, this becomes Days 7-11, not 7-9. Honest re-scoping at start of Day 7 based on Day 6 final budget.

### Days 10-11 — Medium + long-tail writer migration

The remaining writer call sites from Day 1's actual count. Pattern from prior plan (mirror-couple, backtrace's applyBacktrace, post-wedding-sweep direct UPDATE, orphan-sweep, calendly-outcomes, tracer-rebind, knot/weddingwire/openphone/omi/sms adapters, data-integrity sweeps).

Three sub-agents in parallel, two rounds.

**Critical analysis of Days 10-11:**
- *Doctrine:* the spine has one writer at end of Day 11.
- *Code shrinkage:* ~30 lines per writer × ~15 writers = ~450 lines deleted.
- *Self-critique:* the data-integrity sweeps were supposed to repair multi-writer drift. After Day 11, they have nothing to repair. Half can be deleted in Day 19.

### Day 12 — CI guard

Sub-agent writes `scripts/check-cascade-only-writer.mjs`:
- AST-greps for `INSERT INTO couples`, `UPDATE couples`, `INSERT INTO touchpoints`, `UPDATE touchpoints` outside of `src/lib/spine/cascade.ts` and `supabase/migrations/`.
- CI fails PR if found.
- Exemptions: cascade implementation itself, migrations directory, one-shot maintenance scripts under `scripts/`.

**Bucket B partial:** add R4 enforcement guard — `scripts/check-rls-on-venue-id.mjs` greps every migration creating a `venue_id` column and verifies a matching RLS policy was added in the same or later migration.

**Critical analysis of Day 12:**
- *Doctrine:* R1 enforced forever (one writer); R4 enforced forever (RLS on every venue_id table).
- *Code shrinkage:* none.

### Day 13 — Kill the bypass paths

Walk Day 7-11 migrations. Confirm each actually routes through the cascade. CI guard from Day 12 should catch any miss.

If Q3 (Liam-Hunt-scope SQL) returned >50 affected weddings, run the one-shot reconcile on **Day 13.5**: a maintenance script that dedups partner2 rows across all affected weddings, routes through cascade with the new dedup invariant.

**Critical analysis of Day 13:**
- *Doctrine:* fully achieved at the writer level.
- *Battery:* the cascade now gets to enforce the 8-stage order on every new write. Q5 transparency works for every couple.
- *Code shrinkage:* cumulative -800 to -1,200 LOC across the week.

**End of Week 2:**
- One writer. CI-enforced.
- ~1,000 lines deleted.
- ~15 healing crons now redundant (queued for Day 19 delete).
- Liam Hunt failure shape closed permanently at the writer level.
- The UI still looks like Day 0.

---

## G. Week 3: Read migration + mass deletion (Days 14-19)

### Days 14-16 — Implement canonical Intel API for real

The six stub functions become real:
- **Day 14:** `getVenueOverview` + `getSourceAttribution` (folds work from /intel/sources + /intel/attribution into one function). All four attribution models present as opts; UI default first-touch (Bucket C decision)
- **Day 15:** `getCohortFunnel` + `getCoupleJourney` (folds /intel/cohort + journey ribbon)
- **Day 16:** `getDailyList` + `askIntel` (new functions; askIntel wraps existing NLQ brain)

Each function has full TS typing, full honesty primitives (n, enoughData, ratio safety), full integration tests against fixture venue.

**Bucket B partial:** the fixture venue described in Build Plan §10.4 (200 couples, 1,500 touchpoints, 80 tours, 40 reviews) — verify it exists; if not, seed it now. Not Bucket B if needed for Day 16 tests.

**Critical analysis of Days 14-16:**
- *Doctrine:* every read path has exactly one implementation.
- *Battery:* the six functions answer most of the battery natively (Q1 = getCohortFunnel; Q26 = getSourceAttribution; Q33 = consistency across reframings → same function).
- *Code shrinkage:* none today; pays back massively Days 17-19.

### Days 17-18 — Migrate KEPT surfaces to canonical API

The 6-8 /intel surfaces being KEPT (per Day 6 list) get refactored to call canonical functions. They become dumb renderers (R3 enforcement).

Two sub-agents in parallel, three rounds:
- Round 1: migrate /intel/sources (or /intel/attribution) to `getSourceAttribution`
- Round 2: migrate /intel/cohort to `getCohortFunnel`
- Round 3: migrate journey ribbon page + identity-review page

Surfaces NOT being migrated are not touched here; they will be deleted Day 19.

**Critical analysis of Days 17-18:**
- *Doctrine:* every kept surface reads one canonical function. R3 ("dumb readers") enforced.
- *Code shrinkage:* each migrated surface loses ~200-400 lines of per-surface derivation. Net ~-1,500 LOC.

### Day 19 — Mass deletion + schema collapse

The big day. Walk Day 6 kill list and execute every DELETE.

Four sub-agents in parallel (added one for schema collapse), each in worktree:

| Sub-agent | Mandate |
|---|---|
| A | Delete ~55 /intel page.tsx routes. Verify each has no inbound link from kept code. |
| B | Delete ~60 `src/lib/services/intel/*` files. Verify each has zero importers in the post-Day-18 codebase. |
| C | Delete the parallel identity-resolution chain (~35 of 70 identity files) + parallel attribution stack + 12 of 14 brain files (merged into Agent brain + Intel brain). |
| **D (new)** | Schema collapse: write migration that (a) adds `couple_id` nullable to `touchpoints` if not present, (b) inserts every `fragments` row as a `touchpoints` row with null couple_id, (c) inserts every `couple_progression_events` row as a `touchpoints` row with `action_type IN ('progression_*')`, (d) drops `fragments` table, (e) drops `couple_progression_events` table. Reversible via prior tag |

Each sub-agent's deletion goes into its worktree, then sequential merge. Build verifies between each merge.

Also Day 19: collapse 363 migration files into one fresh-baseline migration. History stays in git, schema starts fresh from this point.

**Bucket B partial:** if the `intel_rollups` cache layer is needed for any single page exceeding 500ms, add a minimal version here. Otherwise defer.

**Net delete target:** 85,877 LOC → ~50,000 LOC. Honest disclosure: that's a 47% delete, not 36%.

**Critical analysis of Day 19:**
- *Doctrine:* the swamp drains. R1 + R3 + R4 all enforced. Spine is the actual canonical store, not aspirational.
- *Code shrinkage:* the headline number.
- *Self-critique:* the build must stay clean after each merge. CI guard from Day 12 catches re-introduction of legacy writes.

**End of Week 3:**
- One reader API. R3 enforced.
- ~36,000 lines deleted.
- ~35 cron paths deleted.
- ~55 /intel routes 404.
- Schema collapsed: fragments + progression_events folded into touchpoints.
- The UI looks broken for any URL not in the kept set. **This is fine; you said you can look at junk for two weeks.**

---

## H. Week 4: Build landing + Sage NLQ + battery (Days 20-25)

### Days 20-22 — Build the daily-list landing

Five blocks. Each calls one canonical function. The page IS the new product surface.

Built without sub-agents; this is the design surface where the consolidation either works as a product or doesn't.

Each block has clear empty states (R5 "honesty in runtime") and Sage-narrated commentary when the canonical function returns a pattern worth narrating.

Page lives at `/dashboard` or `/intel`. Sidebar collapses to five entries: Inbox, Couples, Dashboard, Settings, Sage.

**Critical analysis of Days 20-22:**
- *Doctrine:* "demand-driven dashboards" — five blocks, not 65.
- *Battery:* Block 5 (Sage NLQ) is the catch-all; other four blocks each handle 2-4 specific battery questions natively.
- *Self-critique:* the prior version of me would build six blocks. Then seven. Then ten. Stop at five.

### Day 22.5 — Backfill doctrine refinement (per bloom-may21-session Part 8.5)

**Branch on Q1 answer from § C above:**

- If backfill ran (`gmail_backfill_status = 'complete'`) → skip to Day 23.
- If backfill did not run → trigger now and let it complete before Day 23.
- If backfill ran but operator directive says it should look back further than 1095 days → **implement the doctrine refinement now:** `historical-backfill.ts` extends the lookback per-couple when the earliest email found is at the boundary. Re-trigger backfill on Rixey with the new logic. This is the "look back to first contact OR declared discovery moment, whichever earlier" rule.

Code change: `src/lib/services/email/historical-backfill.ts`:
- Replace fixed `LOOKBACK_DAYS_BOOKED = 1095` with adaptive: search at 1095, if earliest result is within 7 days of the boundary, extend by 365 days, repeat until either (a) earliest result contains discovery-language pattern (regex on body for "I saw", "I found", "I came across", "we discovered", "hear about us", "Knot|WeddingWire|Zola"), or (b) no more results.
- Replace fixed `MAX_MSGS_PER_COUPLE = 80` with a two-pass: first 80 most-recent, then a targeted second pass for the oldest matching messages if the first didn't reach the discovery email.
- Record actual lookback used per couple on `couples.backfill_lookback_days_used`.

**Critical analysis of Day 22.5:**
- *Doctrine:* backfill is now correct shape, not a 12x-off heuristic.
- *Battery:* Q5 (where couple actually came from) is now answerable for legacy bookings where the discovery email is >3 years old.
- *Code shrinkage:* slight addition (~150 lines). Replaces incorrect fixed cap.

### Days 23-24 — Backtrace + Sage NLQ + battery

Now that the spine is canonical and the read API is canonical, run the backtrace pass against historical Untracked bookings. Result lands cleanly through the cascade (one writer accepts recovered sources via touchpoint route). The canonical attribution function reads it.

After backtrace runs, run the full 36-question battery (`BLOOM-TEST-QUESTIONS.md`) against the new system. Sage NLQ handles Q1-Q30; surface blocks handle workflow-chain questions.

**Ship gate:** battery passes ≥+1.0 average, zero −3 in Tier 4 → done. Battery fails → identify which questions failed, root cause, fix, re-run. Do not move to Day 25 until pass.

**Critical analysis of Days 23-24:**
- *Doctrine:* the battery IS the ship gate per Build Plan §10.3 + Critical Audit §C.6. This is when we know.
- *Battery:* 100% of battery runs against new product surface for the first time.
- *Self-critique:* without Susan, "ship" means "ready for first Susan." Bar is the same; only audience is different.

### Day 25 — Final cleanup + Bucket B handoff

Whatever long-tail items remain, the migration baseline flatten, the changelog. Final commit + push + tag `consolidation-complete-2026-06-15`.

**Write `BUCKET-B-POST-CONSOLIDATION.md`** — the named list of every build-plan delta from § B Bucket B above. This becomes the input to the next 30-day plan.

**End of Week 4:**
- One landing page is the product
- 36 battery questions answer with ≥+1.0 average
- ~36,000 LOC lighter (85,877 → ~50,000)
- 5 sidebar entries
- One writer (R1). One reader API (R3). One cascade. One brain stack. One source of truth.
- Full provenance on every signal (R2)
- RLS on every venue_id table (R4) — CI-enforced
- Honesty rails on every Intel surface + every Sage prompt (R5)
- Loop integration tests pass (R6) — Loops 1 + 3 minimum
- Ready for first Susan
- Bucket B explicitly named in handoff doc

---

## I. What's different vs. the prior 25-day plan

| Dimension | Prior plan | This anchored version |
|---|---|---|
| Susan in the loop | No (correct) | No (kept) |
| Pre-flight SQL gate | Implicit | **Explicit Day -1; plan cannot start without 3 answers** |
| Day 1 audit agents | 6 | **7 (added RLS audit)** |
| Day 1 writer count | "estimated ~25" | **"output of Day 1, not input"** |
| Day 2 doctrine doc | Generic | **Includes partner2 dedup invariant + Bucket C decisions baked in** |
| LLM judge fate | "Delete" | **"Measurement-driven decision on Day 6"** |
| Schema collapse (fragments + progression_events) | Implicit | **Explicit Day 6 decision + Day 19 migration** |
| Five-loop scope | All five | **Loops 1 + 3 production quality; 2/4/5 in code but not battery-gated** |
| Backfill doctrine refinement | Not addressed | **Explicit Day 22.5 (branch on Q1 answer)** |
| LOC delete target | "40,000" (against 111k) | **"35,000-40,000 against verified 85,877 — that's 41-47%"** |
| /intel route delete target | "~35 of 40" | **"~55 of 65"** |
| Service file delete target | "~60 of 100" | **"~60 of 80"** |
| Brain file delete target | "11 of 15" | **"10-12 of 14"** |
| Identity file delete target | Not stated | **"~35-45 of 70"** |
| Cron delete target | "~7 of 12" | **"~35 of 47"** |
| Bucket B (deferred deltas) | Not named | **Explicitly listed in § B; handoff doc written Day 25** |
| Bucket C (doctrine choices) | Not named | **Explicitly decided in Days 2-3** |

---

## J. What I still need from you

Two gates:

1. **Day -1:** answers to the three operator SQL queries in § C. Plan cannot start without them.
2. **End of Day 6:** sign-off on `CONSOLIDATION-PLAN-FROZEN.md` (the kill list with Day-1 audit numbers baked in). Plan cannot proceed to Week 2 without it.

After Day 6 sign-off, I work autonomously through Day 25, committing and pushing as I go. Critical-analysis self-assessments every 5 days as commit messages.

Reversible to `pre-consolidation-2026-05-21` tag at any point.

---

## K. Honest risks specific to this anchored version

**Risk 1: Day 1 reveals the writer count is 50+ rather than 15-25.** Days 7-13 don't fit. Mitigation: re-scope at end of Day 6 with the real number; if Week 2 needs to be 9 days instead of 7, the 25-day total becomes 27 days. Not a crisis.

**Risk 2: deletion goes too far.** Something deleted in Day 19 turns out to matter when first Susan onboards. Mitigation: git preserves restorability; restoring a deleted surface from tag is a one-day add-back. The pre-consolidation tag is the safety net.

**Risk 3: battery is too lenient as a gate.** A passing battery doesn't guarantee a real user is satisfied. Mitigation: the battery + a first-user pilot before charging. The 25-day plan ends with battery-ready, not market-ready. Bucket B handoff doc captures what market-ready needs after.

**Risk 4: the canonical API shape is wrong on Day 3.** Surfaces can't express their needs through six functions. Mitigation: walk the four worked examples through the contract on Day 3 itself. If a surface needs something the six can't return, fix the contract Day 3 — not Day 14.

**Risk 5: backfill doctrine refinement on Day 22.5 surfaces non-trivial bugs.** Adaptive lookback turns out to interact badly with cursor state or Gmail API rate limits. Mitigation: Day 22.5 has 0.5 days of slack; if it overflows, push to Day 24 and run battery Day 25, push final-cleanup to Day 26. Same shape, one day longer.

**Risk 6: the codebase after Day 25 is structurally clean but missing actual product features.** Real risk. The 25 days are about consolidating WHAT EXISTS, not building new capability. After Day 25, things a first paying venue probably needs (tour outcome workflow, contract-signing flow, real billing tier enforcement) are still gaps. That's the next 30 days. Bucket B handoff doc captures these explicitly.

**Risk 7: I get nerd-sniped during Day 19 mass deletion and miss a real dependency.** Mitigation: each sub-agent verifies zero importers before delete; CI rebuilds between merges. If anything goes red, that merge gets reverted, the dependency mapped, the delete redone.

---

## M. Battery-critical preservation list (added 2026-05-21 post pressure-test)

The pressure-test of this plan against `BLOOM-TEST-QUESTIONS.md` (36-question battery) surfaced two failure classes that would otherwise sink the ship-gate:

**Class 1 — Wave services with low static importer count but high battery-test load.** Day 6 kill-list cannot delete these based on importer count alone. Each is explicitly tagged **KEEP-OVERRIDE** regardless of what Day 1 audit reports:

| Service / Wave | Battery questions it serves | KEEP-OVERRIDE reason |
|---|---|---|
| `src/lib/services/phrase-usage/*` (Wave 5B emerging themes) | Q13, Q15, Q16, Q27 | Text-pattern-shift detection — Q13 alone is high-frequency operator question ("are couples asking about AC more?") |
| `src/lib/services/identity/wave4-reconstruction.ts` + sensitive-theme tagging | Q31 | Privacy-critical: Q31 must aggregate without naming. A -3 here is unship-able regardless of other scores |
| `src/lib/services/couple-intel/*` (Wave 5A close-probability + key_signals) | Q19, Q34 | Predictive transparency + workflow chain. Without key_signals, Q19 returns black-box scores → -3 |
| `src/lib/services/cohort/venue-thesis.ts` (Wave 5D cultural cohort) | Q35 | Cohort fairness segmentation. Flagged Rixey's 5-couple cultural-diverse-all-lost gap; the function must survive |
| `external_context` table + loaders (`fred.ts`, `weather.ts`, `cultural-moments.ts`, `calendar.ts`) | Q7, Q10 | Holiday + weather × tour-outcome. Day 6 keep/delete is **DECIDED HERE: KEEP**. Folding deferred to post-25 phase |
| `src/lib/services/data-integrity/*` 90d-completeness function | Q30 | Wave 9 self-report. Plan's "delete drift-repair sweeps" applies to multi-writer drift-repair, NOT to the completeness reporter. The reporter survives |

**Class 2 — Tier 5 (operator patterns) is a doctrine gap.** Q22-Q25 ask about the operator, not the cohort. The six canonical Intel functions don't have an axis for "tell me about ME." Resolution:

- **Day 2-3 amendment:** `getCohortFunnel` adds an opt `operatorAxis: boolean`. When true, the function segments by `responded_by` (which coordinator) and returns response-time distribution + reply-to-arrival alignment + stalled-engagement detection per operator.
- Alternative ruled out: adding a 7th canonical function `getOperatorPatterns`. Violates "six functions, no growth" doctrine. Opt-on-existing is cheaper.
- This handles Q22 (when do I respond fastest), Q23 (stalled engagement / Wave 11 stuck-state), Q24 (retrospective qualification — needs outcome lookback), Q25 (pre-tour signals predicting booking — needs feature-importance which is partly in Wave 5A).

**Class 3 — Q3/Q4 require pattern-detection, not just aggregation.** `getCohortFunnel` returns the conversion curve as a raw series. Adding a small `detectKnee()` helper inside the canonical function (~30 lines) that scans for an inflection point and returns `{ knee_response_hours: 7.5, dropoff_after: 0.42 }` when found. Day 14 implementation includes this.

**Battery pressure-test result after § M patch:**
- ✅ Easy after patch: 28 / 36 (was 15)
- ⚠️ At-risk: 4 / 36 (was 15)
- ⛔ Plan gap: 0 / 36 (was 4)
- ⛔ Out of scope: 1 / 36 (Q9 competitor calendar — operator-data dependent, not a plan deficiency)
- 1 grayzone: Q12 (June YoY + confounding controls) — function returns the data; narrative-generation is Sage NLQ quality, not a function gap

Average projected score after patch: ≥ +1.4. Tier 4 honesty zero -3 risk addressed via Wave 4 KEEP-OVERRIDE + askIntel honesty rails.

---

## N. Day-1 audit + Day -1 SQL — pressure-test corrections (2026-05-21)

After Day 1 parallel audit returned + Day -1 SQL gate closed, multiple plan claims need correction. Every change here is grep/SQL-verified; this section supersedes the earlier sections it contradicts.

### N.1 Day-1 audit raw counts (verified against codebase, not estimates)

- **Legacy writers (Agent A):** 138 sites. 36 cascade-routed, 102 not. Liam Hunt sites at pipeline.ts:**2211, 2907, 3062** confirmed.
- **Spine writers (Agent B):** 35 sites. **Cascade is pure TS (`identity-cascade.ts:490`), NOT a Postgres RPC.** Build Plan §3.1 wrong. 2 call sites (matcher.ts:364, resolution.ts:548) confirmed.
- **Attribution readers (Agent C):** 78 sites. 6 serve KEEP surfaces. 72 serve DELETE. `getSourceAttribution` doesn't exist — closest is `buildCoupleAttribution` (D3, shipped 2026-05-19). `touchpoints.cascade_stage` has ZERO readers.
- **Pages (Agent D):** 88 page.tsx (intel + agent). KEEP=8, MERGE=12, DELETE=68.
- **Services (Agent E):** 164 files. **Initial verdict KEEP=110, DELETE=48 was wrong on sweep files.** Cross-check against `src/app/api/cron/route.ts` case-string dispatch reveals 11 of 15 "0-importer" sweep files are LIVE via dynamic dispatch. **Real DELETE count = ~37.**
- **Crons (Agent F):** 47 entries. KEEP=11, MERGE=11, DELETE=25. **5 canonical crons missing from vercel.json:** `cascade_drain`, `post_wedding_sweep`, `couple_intel_sweep` (handler exists L1041), `cohort_rollup_sweep` (handler L1050), `battery_smoketest` (doesn't exist). Register on Day 12.
- **RLS (Agent G):** 226 tables. 209 CORRECT. **17 gaps:** 13 RLS-enabled-no-policy (default-deny — likely service-role-only by design or coverage gap), 4 RLS-OFF entirely. **PII risk:** `notifications` + `wedding_timeline` MUST be patched before Day 13.5 reimport.

### N.2 LOC delete projection (corrected)

85,877 → **~62,000-65,000** (24-27% delete). Plan's 47% target was over-aggressive. Many Wave files turned out to be load-bearing via dynamic dispatch.

### N.3 Sweep-file false-positive list (Agent E DELETE → actually KEEP)

11 sweep files Agent E marked DELETE are LIVE via dynamic dispatch in `route.ts`:

| File | Dispatched at | Real verdict |
|---|---|---|
| `couple-intel-sweep.ts` | L1041 `couple_intel_sweep` | KEEP |
| `cohort-rollup-sweep.ts` | L1050 `cohort_rollup_sweep` | KEEP |
| `external-match-sweep.ts` | L1075 `external_match_sweep` | KEEP |
| `cohort-damping-refresh.ts` | L1253 | KEEP |
| `validation/sweep.ts` | L1116 `hypothesis_validation_sweep` | KEEP |
| `alumni/sweep.ts` | L1181 `runAlumniSweep` dyn-import | KEEP |
| `inbound-haiku-drain.ts` | L1212-1215 | KEEP |
| `discovery/sweep.ts` | L1097 `runDiscoverySweep` | KEEP |
| `onboarding/sweep.ts` | L1104 `runVenueThesisSweep` (Wave 5D) | KEEP |
| `referrals/sweep.ts` | L1177 `runReferralSweep` | KEEP |
| `tour-weather.ts` | L1566 inline in weather_forecast cron | KEEP |

**Day 6 cross-check protocol:** for every file Agent E marked DELETE, grep `route.ts` for the file's exported function name; if found in a `case` block → flip to KEEP.

### N.4 Eight ADOPT-not-DELETE chokepoint files

These are unadopted-but-doctrinally-intended chokepoints. **Wire on Days 7-13 instead of deleting.**

| File | Day | Action |
|---|---|---|
| `mint-couple.ts` | 9 | Replace all 33 spine `couples.insert/upsert` calls with `mintCouple()`. |
| `mint-person.ts` | 8 | Replace all `people.insert` calls. **Partner2 dedup invariant goes inside mintPerson** — closes Liam Hunt class permanently at writer. |
| `capture-identifier.ts` | 10 | Wire into every cascade-match-success path so identifier pool grows. |
| `cascade-on-enrichment.ts` | 10 | Wire into brain-dump-confirm + storefront-ingestion hooks. |
| `binder-cron.ts` | 12 | Rename to `cascade-drain.ts`; register `cascade_drain` cron in vercel.json. |
| `touchpoints-writer.ts` | 9 | Adopt as race-safe touchpoint writer that mintCouple delegates to. |
| `auto-merge-duplicates.ts` | 6 | Investigate vs `reconciliation.ts`. If superseded, DELETE. |
| `match-eligibility.ts` | 6 | Investigate vs cascade tier logic. If superseded, DELETE. |

### N.5 Doctrine corrections to bake into Day 2

1. **Cascade stays TS, not RPC.** Add `acquire_couple_lock(p_venue_id, p_identity_key)` PL/pgSQL helper + thin TS wrapper at `src/lib/spine/cascade.ts`. Don't elevate the whole cascade to RPC (200-line refactor with high test surface). Identity key derivation: `email > phone > handle > fallback hash`.
2. **R1 is creation boundary, not commit boundary.** The cascade is the ONLY path that CREATES a couple or BINDS a touchpoint. Lifecycle / heat / metadata updates have their own bottleneck functions and don't route through cascade. CI guard from Day 12 blocks only `INSERT/UPSERT` to spine tables outside the chokepoints — not all writes.
3. **candidate-ai-adjudicator KEEP** (not DELETE). File header at line 28-30 of `llm-judge.ts` explicitly states they coexist on different schemas. After Day 19 schema collapse (if we do it), candidate-ai-adjudicator becomes redundant.
4. **6-entry sidebar, not 5.** Inbox · Brain-Dump · Couples · Dashboard · Settings · Sage. Brain-dump is first-class operator workflow (only ingest path for storefront / Knot screenshots / IG / Pinterest / Calendly Q&A paste); burying it loses its function.

### N.6 Bucket A → Bucket B move (defer schema collapse)

Schema collapse (fold `fragments` + `couple_progression_events` into `touchpoints` with discriminators) **doesn't unblock anything in the 25-day window.** Day 19 was originally schema collapse + mass delete. Moving collapse to Bucket B frees 2 days for read-migration overrun and Q5 UI piece.

### N.7 Reimport burst endpoint (Day 13.5)

Replace cron-paced backfill with operator-triggered burst:
- `POST /api/admin/reimport/gmail-burst { venueId }` — runs `runHistoricalBackfill` in tight loop, concurrency=4, no MAX_MSGS_PER_WEEK ceiling.
- Vercel Fluid Compute, split across function invocations via cursor handoff.
- Apply Part-8.5 doctrine refinement (adaptive lookback) here.
- Collapses Day 22.5 (separate task) into Day 13.5.

### N.8 RLS gaps to patch BEFORE Day 13.5

- **PII-critical (Day 7-9):** `notifications` + `wedding_timeline` — add scoped policies. Currently RLS-OFF.
- **Hygiene (Day 12):** `cohort_damping_cache` + `mint_wedding_telemetry` — enable RLS.
- **Verify (Day 6):** the 13 RLS-enabled-no-policy tables. Run authenticated-JWT test in Supabase SQL editor. Add policies where coordinator UI needs reads.

### N.9 § M phrase-usage correction

§ M originally KEEP-OVERRIDE'd `src/lib/services/phrase-usage/*` — that directory doesn't exist. `phrase_usage` is a TABLE. Real KEEP-OVERRIDE files for battery Q13/15/16/27:
- `src/lib/ai/phrase-selector.ts` (reads + writes phrase_usage)
- `src/lib/services/brain/voice-dna-extract.ts` (derives phrases from outbound drafts)
- `src/lib/services/intel/cohort-rollup.ts` (Wave 5B aggregator)
- `src/lib/services/intel/cohort-rollup-sweep.ts` (cron worker — LIVE via dynamic dispatch)
- `src/lib/services/intel/enqueue-cohort-rollup.ts`

### N.10 Day -1 SQL gate result — the 63 Untracked is purely backtrace

All three diagnostic angles came back clean:

- **Q1** — Gmail backfill ran (8,183 emails, status=complete, 2026-05-16).
- **Q2** — Every Untracked has interactions (6 have 1-4, 30 have 5-20, 27 have 21+). Zero have 0. Binding works.
- **Q3** — 0 weddings with >2 people. Liam Hunt bug not firing.
- **Cascade bridge** — 63/63 Untracked have a couples row via source_wedding_id. Spine knows them.
- **Orphan couples** — 1,524 (ghost couples = emailed but never booked; doctrinally correct).

**Failure is purely `weddings.source` backtrace.** Discovery-moment text is sitting in interactions unread. Day 2 / Day 7 candidate task: investigate `source-backtrace.ts` for the point-fix vs structural-rebuild question.

### N.11 Day 13.5 wipe target (shrunk)

Original plan: wipe ~36k client rows. **Corrected:** wipe ONLY:
- 1,524 orphan couples (no wedding link)
- 3,663 unbound fragments
- 1,677 legacy candidate_identities

**KEEP:** 431 weddings, 796 people, 5,645 interactions, 5,096 touchpoints. Cascade has already correctly minted couples for the 431 (bridge exists); the wipe is targeting only the orphan/fragment debris.

No Liam Hunt reconcile pass needed (Q3=0). Day 9 `mint-person.ts` adoption is prevention-only.

---

## N.12 Discovery-source attribution — the "how did you find us" loop (2026-05-21)

Surfaced while diagnosing the 63-Untracked failure. It is a first-class
attribution-loop concern, not a patch.

**The signal exists, unread.** Calendly tour bookings carry the couple's
self-reported "how did you hear about us?" answer. The scheduling parser
writes it into the interaction body as a structured `lead_source:VALUE`
line. On Rixey: 200 of 321 NULL-source weddings have one (the_knot 84,
google 73, referral 13, wedding_wire 12, + tail). Nothing reads it onto
`weddings.source` or into `discovery_sources`.

**Doctrine — self-report is a signal, not the truth:**
- `discovery_sources` = the verbatim claim, timestamped at booking, always
  recorded, immutable.
- `attribution_events` / `touchpoints` = each source-bearing signal with
  its own `occurred_at` + channel + provenance. The self-report is ONE
  touchpoint (`channel: couple_self_report`).
- First-touch `source` = DERIVED from the earliest credible touchpoint
  (R3 — compute, don't stamp). A Knot relay email predating the Calendly
  booking outranks a booking-time "Google" self-report.
- Self-report-vs-timeline conflict → operator review queue
  (`candidate_matches` pattern), never auto-resolved.

**Implementation (3 parts, all consolidation-plan work):**
- **A. Backfill** — `lead_source:` parsing becomes a scored evidence path
  INSIDE `source-backtrace.ts` (already walks the timeline earliest-first;
  earliest-wins reconciles self-report vs form-relay automatically). Runs
  once over the 321; thereafter the cron handles it.
- **B. Live-capture gap** — the Calendly webhook calls
  `captureDiscoverySource` (writes discovery_sources + attribution_events)
  but never writes `weddings.source`/derives first-touch. The
  scheduling-parser path producing `lead_source:` doesn't call
  `captureDiscoverySource` at all. Both route to the canonical
  source-resolution path.
- **C. Doctrine** — every intake adapter (Calendly Q&A, HoneyBook inquiry
  field, website calculator, brain-dump) extracts "how did you find us"
  and routes through one source-resolution function. Instance of the
  cascade-canonical-writer doctrine (§ N.5 R-rules).

**Mapper gap:** `discovery-source/canonical.ts` missing `zola` +
`herecomestheguide` — both real platforms. Add during A.

Lands in Days 14-16 (canonical Intel API — `getSourceAttribution` must
read the derived first-touch) + Day 7-13 (the source-backtrace evidence
path is a writer-side change).

---

## L. Anchor map — every § in this plan to its source

| § | Source |
|---|---|
| A (numbers) | `ASSUMPTIONS-VS-REALITY.md` |
| B Bucket A | `CRITICAL-AUDIT.md` + `ENGINEERING-BUILD-PLAN.md` deltas |
| B Bucket B | `ENGINEERING-BUILD-PLAN.md` deltas not handled in 25 days |
| B Bucket C | Disagreements between `ENGINEERING-BUILD-PLAN.md` and `CRITICAL-AUDIT.md` |
| C SQL | `ASSUMPTIONS-VS-REALITY § Open questions` |
| D tag | `bloom-may21-session § Part 1` precedent (`pre-tier-8-2026-05-14` tag pattern) |
| Day 1 audit | Prior plan Day 1 + new Agent G from `ENGINEERING-BUILD-PLAN § 2.4 RLS` |
| Day 2 partner2 dedup | `bloom-may21-session § Part 3 — Liam Hunt diagnosis` |
| Day 2 schema collapse | `CRITICAL-AUDIT § What's overengineered — Twelve tables` |
| Day 2 loop count | `CRITICAL-AUDIT § What's overengineered — Five loops` |
| Day 3 attribution opts | `CRITICAL-AUDIT § What's overengineered — Four attribution models` |
| Day 6 judge decision | `ASSUMPTIONS-VS-REALITY § Specific claims — LLM judge` |
| Day 7-9 writer scope | `bloom-may21-session § Part 3 — three pipeline.ts insert sites` |
| Day 12 RLS CI guard | `ENGINEERING-BUILD-PLAN § R4 — Multi-tenant from line zero` |
| Day 14-16 honesty primitives | `ENGINEERING-BUILD-PLAN § R5 — Honesty in runtime` |
| Day 17-18 dumb readers | `ENGINEERING-BUILD-PLAN § R3 — Read paths dumb and stateless` |
| Day 19 schema migration | Day 2 collapse decision |
| Day 22.5 backfill refinement | `bloom-may21-session § Part 8.5` |
| Day 23-24 battery gate | `ENGINEERING-BUILD-PLAN § 10.3` + `BLOOM-TEST-QUESTIONS.md` |
| Day 25 Bucket B handoff | This anchored plan § B Bucket B |

If a claim in this plan doesn't appear in the Anchor map, it's an assumption and needs to be either verified or removed before Day 1 starts.
