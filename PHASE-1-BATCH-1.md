# Phase 1 — Batch 1 Worklist · The Email Pipeline

**Date:** 2026-05-22 · **Plan:** `CONSOLIDATION-PLAN-PHASED.md` §1 (Batch 1 of 4).
**Inputs:** two code-verified agent traces (pipeline writer enumeration + cascade write-path map), 2026-05-22.
**Scope:** `src/lib/services/email/pipeline.ts` (~4,920 lines, entrypoint `processIncomingEmail`). `historical-backfill.ts` routes *through* `processIncomingEmail` — no new sites. `follow-up-sequences.ts` is a cron → Batch 3.

**Restore point:** git tag `pre-consolidation-2026-05-22` · Supabase branch `pre-consolidation-2026-05-22` (ref `ciwqxwohczzthvzqqgjx`). All Batch 1 shadow-compare runs go against that branch — `scripts/shadow-compare.ts` hard-refuses the prod ref.

---

## 0. What "migrate a writer" means in Phase 1 (read first)

Phase 1 is **dual-write**, not delete. A migrated writer routes through the cascade so `couples`/`touchpoints` get the equivalent write **in lockstep with** the legacy insert. The legacy `interactions`/`people`/`attribution_events` insert **stays** — it is deleted only in Phase 4, after Phase 3 moves readers. So "MIGRATE site X" = "ensure that when X fires, the cascade equivalent also fires, and shadow-compare shows zero divergence."

---

## 1. Enumeration result (verified)

`pipeline.ts` has **39 write sites**: **9 MIGRATE**, **30 STAY**, **0 DELETE**.
STAY = lifecycle/heat/status/metadata UPDATEs on existing rows, draft-status writes, observability inserts — R1 is a *creation* boundary, these legitimately stay direct. Full STAY table is in the agent trace; not repeated here.

The **9 MIGRATE sites** (line numbers verified 2026-05-22, will drift — re-grep at execution):

| # | site | table | what it creates | cascade target |
|---|---|---|---|---|
| M1 | `pipeline.ts:1581` | `interactions` | the core inbound touchpoint (every classified inbound email) | `linkSignal` — **already fires at :4109**; covered by P5 promotion |
| M2 | `pipeline.ts:696` | `people` | partner1 person row (`findOrCreateContact` step 3, no match) | `mintPerson` |
| M3 | `pipeline.ts:724` | `contacts` | email-contact identifier mirror for the new person | co-locate with M2 in the `mintPerson` path |
| M4 | `pipeline.ts:2211` | `people` | **partner2 row, fresh_inquiry path — Liam Hunt bug, no dedup** | `mintPerson` w/ `weddingId`+`role` (P2) |
| M5 | `pipeline.ts:3062` | `people` | **partner2 row, scheduling/Calendly path — Liam Hunt bug, no dedup** | `mintPerson` w/ `weddingId`+`role` (P2) |
| M6 | `pipeline.ts:1169` | `interactions` | outbound interaction, `isOwnOutbound` self-loop | `linkSignal` (`action_type:'outbound'`) |
| M7 | `pipeline.ts:4891` | `interactions` | outbound interaction from `sendApprovedDraft` (writes `wedding_id:null` — unbound) | `linkSignal` — **separate function, no cascade call today** |
| M8 | `pipeline.ts:2435` | `candidate_identities` | sub-Point-Zero pre-couple identity record | cascade fragment path — **needs reconciliation, see Q3** |
| M9 | `pipeline.ts:1940` | `engagement_events` | weddingless engagement event (cold sender, `human_requested`) | `linkSignal` — **needs reconciliation, see Q4** |

**Partner2 bug confirmed:** M4 (`:2211`) and M5 (`:3062`) both do an unconditional `people.insert({role:'partner2'})` with **no check for an existing partner2** on the wedding. The header comment at M4 *claims* a skip-if-exists guard — it is not in the code. The plan's third cited line `:2907` is **not** a partner2 insert — it is an `interactions` UPDATE (re-link); the plan conflated a dependent re-link with a duplicate-creating insert.

---

## 2. Prerequisites — build BEFORE any site flips (ordered)

No MIGRATE site can flip until these land. They are the shared machinery.

### P1 — Extract `emailToNormalizedSignal()` adapter
Today the inbound email → `NormalizedSignal` conversion is an **inline object literal** at `pipeline.ts:4113-4136`. Every Batch-1 writer that calls `linkSignal` must build the same signal the same way. Extract the literal into a named adapter (proposed: `src/lib/services/identity/email-to-signal.ts`) so M1/M6/M7 all construct the signal through one function. Review item folded in: `signal_tier:'high'` is hard-coded in the literal — confirm it is correct for all inbound email or derive it.

### P2 — Extend `mintPerson` with wedding context + partner2 dedup invariant (§1.5)
`MintPersonInput` (`mint-person.ts:69`) and `IdentitySignals` (`resolver.ts:62`) carry **no `weddingId`/`role`** — verified. Add optional `weddingId?: string` and `role?: 'partner1'|'partner2'`. When `role==='partner2'` + `weddingId` set: query `people` for an existing partner2 on that wedding; if found, **enrich-or-skip** (merge new identity fields into the existing row) instead of inserting a duplicate. This is **greenfield** — no existing code does the at-mint check (`merge-people.ts` is post-hoc; the match-first chain dedups by identifier and Liam Hunt has no shared identifier). Closes the M4/M5 bug class permanently. Decide in `resolver.ts:createPerson` where the check sits.

### P3 — Add `couple_merge_events` audit insert to the `lock_and_mint_couple` RPC (§1.7a — confirmed gap)
Verified: the migration-359 RPC mints couples silently — **no `couple_merge_events` row**. Meanwhile `tracer.ts:753` (fragment-coalesce) *does* audit, and mints via a **direct `INSERT INTO couples`** bypassing `lockAndMintCouple` — a chokepoint violation. Phase 1: (a) add a `couple_merge_events` insert (`event_type:'couple_minted'`) inside the RPC; (b) route `tracer.ts:promoteFragmentInto` through `lockAndMintCouple`. New migration. Confirm `couple_merge_events` columns first (`tracer.ts:753` uses `venue_id, event_type, primary_couple_id, rule_triggered, confidence_tier, reason`).

### P4 — Add `linkSignal` to the `cascade.ts` barrel
`src/lib/spine/cascade.ts` re-exports `lockAndMintCouple`/`mintPerson`/`mintWedding` but **not `linkSignal`** — yet `linkSignal` is the function every Batch-1 identity/touchpoint writer should call. Add it, so the CI guard (`check-cascade-only-writer.mjs`, §1.6) has the right allowed-writer surface. Or clarify the doctrine: `linkSignal` = orchestrator, barrel = leaf chokepoints — pick one and write it in `CASCADE-CANONICAL-WRITER.md`.

### P5 — §1.1 promotion: make `linkSignal` load-bearing
`pipeline.ts:4109` **is** `await`ed but shadow by: discarded `LinkResult`, empty `catch {}`, trailing position. The promotion:
1. Capture: `const linkResult = await linkSignal({…})`.
2. Surface errors: replace `catch {}` with `logPipelineError(venueId,'cascade_link',err,…,correlationId)` (or re-throw — operator decision: fail-the-tick vs log-and-continue).
3. Act on result: assert `matched_couple_id`/`touchpoint_id` set when expected; log divergence from the legacy `weddingId` binding (this is the shadow-compare signal).
4. Reposition: move the call out of the trailing afterthought slot into a first-class pipeline step so later steps can use its couple binding.
5. Delete the "legacy path must not break on a linker hiccup" comment — that comment *is* the shadow-mode contract.
Rollback: revert to swallowed-catch shape; shadow cascade keeps running.

---

## 3. Per-site migration order (after P1-P5)

Highest-volume / highest-risk first, per plan §1.2. Each site: wire the cascade equivalent → run `scripts/shadow-compare.ts` with a per-site `OldPathRunner` adapter against the Supabase branch → flip when divergence is zero across a representative sample.

1. **M1 `:1581`** — core inbound touchpoint. ✅ **VERIFIED DONE 2026-05-22.** M1 needed no code — `linkSignal` already routes the inbound email and P5 made it load-bearing. Verified by `scripts/verify-m1-binding.ts` (consistency audit vs the Supabase branch, not a synthetic shadow-compare — the right instrument for an already-routed writer): binding consistency **99.8%** (cascade touchpoint binds to the same couple the legacy `interactions` row's wedding maps to), corrected coverage **99.2%** (touchpoint-OR-fragment — a cold-sender routed to `fragments` is a correct cascade outcome, not a drop). 0.8% genuine drops = Backwards-Tracer sweep lag (May 19-22), not a defect. **Caveat:** the live `linkSignal` path is thinly exercised on the branch (~40 rows) — coverage is currently carried by the batch Tracer; re-spot-check after live traffic accumulates.
2. **M4 `:2210` + M5 `:3060`** — the partner2 pair. ✅ **FLIPPED 2026-05-22.** Both raw `people.insert({role:'partner2'})` blocks replaced with `mintPerson({ venueId, weddingId, role:'partner2', signals:{ fullName, email?, phone? }, source:'email_pipeline' })`. Partner2 name passed in `signals.fullName` (the enrich + create paths both read it). `personId:null` (resolver error, or — once migration 367 lands — a concurrent-race unique-violation) is handled by re-querying the live `role='partner2'` row on the wedding; a genuine DB failure degrades without crashing the pipeline. `check-no-direct-people-insert` green — the two partner2 sites are gone from the detector (`pipeline.ts` stays grandfathered only for M2 `:695`, the partner1 site). **Verification level: typecheck + guard green + logic trace** — duplicate partner2 is closed by construction (`mintPerson` enrich-or-skip + migration 367's unique index). No runtime test (would need a Supabase-mock harness spanning mintPerson/resolver/enrich — deferred infra); honest gap recorded.
3. **M2 + M3** — partner1 + contact mirror. ✅ **FLIPPED 2026-05-22** (commit `8d95181`). M2: `findOrCreateContact`'s partner1 `people.insert` routes through `mintPerson` — only the create is rerouted; the canonical-resolver + contacts-table match steps stay (preserves contact-resolution behaviour). `isNewContact` derives correctly; step-5 matcher + return guarded on `mintIsNew`. `pipeline.ts` is now off the `check-no-direct-people-insert` grandfather list. M3: verified `mintPerson`/resolver do NOT write the contacts mirror, so M3's `contacts.insert` STAYS, guarded on `mintIsNew`.
4. **M6 + M7** — outbound interactions. ✅ **FLIPPED 2026-05-22** (commit `8d95181`). M6: the `isOwnOutbound` self-loop branch returns before the `:~4109` `linkSignal`, so a `linkSignal` call was added inline. M7: `sendApprovedDraft` is a separate function — added a `linkSignal` call anchored on the parent inbound interaction's `wedding_id` + `correlation_id`. Both use `emailToNormalizedSignal` with `action_type:'venue_sent'` + `signal_tier:'medium'` — byte-consistent with the batch Gmail adapter so the touchpoint dedups rerun-safely.
5. **M8 (`candidate_identities`)** — ✅ **STAY-AS-DUAL-WRITE, VERIFIED 2026-05-22** (Q3 resolved). Q3 found: the cascade equivalent ALREADY fires — the M8 branch does not return early before the `:~4204` `linkSignal`, and every M8 email reaches it. `candidate_identities` is a LIVE Wave-10 identity layer (~30 readers incl. `intel-brain.ts` battery path) genuinely distinct from `fragments` — its legacy insert stays (dual-write; dropped in Phase 4). M8 needs NO new code. Verified via `scripts/verify-m8-coverage.ts`: **252/252 M8-cohort interactions** have a cascade `touchpoints` OR `fragments` row (100% coverage). The Wave-10-vs-spine collapse is a Phase 3/4 concern, out of Batch 1 scope.
6. **M9 (`engagement_events`)** — ✅ **FLIPPED 2026-05-22** (Q4 resolved; commit to follow). Q4 corrected the worklist: `engagement_events` is a heat-table the cascade has zero relationship to — the `:1940` insert is a STAY, not an M-site. The REAL M9 gap: the `humanRequested` block returns at `:~1978` BEFORE the `:~4204` `linkSignal`, so human-escalation emails never reach the cascade (both the weddingless arm AND the `weddingId`-set arm). Added a `linkSignal` call inside the `humanRequested` block, positioned to cover both arms before the return. `action_type:'reply'` (not `'human_requested'` — `'reply'` preserves progression-log inclusion per `progression.ts`; the escalation semantics are kept in `raw_payload.escalation`). `signal_tier:'high'` (inbound default).

---

## 4. Re-link UPDATEs — FOLD candidates (not MIGRATE, not pure STAY)

`pipeline.ts:2252`, `:2907`, `:3039` are `UPDATE`s that re-bind `wedding_id`/`person_id` on existing `interactions` rows (orphan-sweep + high-match re-link). Strict R1 → STAY (UPDATE on existing row). But they perform identity *re-attachment*, which the cascade's `applyTierRouting` touchpoint-attach owns. **Ruling:** keep STAY for Batch 1 (don't expand scope), but flag for Phase 3 — when the reader migrates, the re-link should be the cascade's attach, not a direct UPDATE. Recorded so it is not lost.

---

## 5. The `mintWedding` chain — channeled but pre-cascade

`pipeline.ts:2093` (fresh_inquiry) + `:2955` (scheduling_event) call `mintWedding` → the **legacy** `weddings` chokepoint (`identity/mint-wedding.ts`), which mirrors into `couples` fire-and-forget via `mirrorCoupleFromWedding`. Per `CASCADE-CANONICAL-WRITER.md` §8 `mintWedding` is "no change — already the legacy chokepoint." **Ruling:** the two `mintWedding` *call sites* are not Batch-1 MIGRATE work (they are behind a chokepoint). But the `mintWedding`→`couples` mirror being **fire-and-forget** is its own shadow seam — track it as a Batch-1 *review item*: once `linkSignal` is load-bearing (P5), the mirror is redundant for the inbound path and the fresh-inquiry couple should come from the cascade, not the mirror. Decide at execution whether to converge them in Batch 1 or defer to Batch 2.

---

## 6. Operator rulings made in this decomposition

- **`drafts` inserts (`:3624`, `:3929`) → STAY.** A draft is generated outbound content tied to an existing interaction/wedding; it does not create a couple/person/touchpoint. R1 is *identity* creation, not table membership. (Agent flagged for explicit ruling — ruled STAY.)
- **Re-link UPDATEs → STAY for Batch 1, FOLD-flagged for Phase 3** (§4 above).
- **`mintWedding` call sites → not Batch-1 MIGRATE; mirror is a review item** (§5 above).
- **Plan line `:2907` is not a partner2 site** — the real Liam Hunt sites are `:2211` + `:3062` only.

## 7. Open questions to resolve at execution (not blockers to starting P1-P5)

- **Q3 — `candidate_identities` vs `fragments`.** M8 writes `candidate_identities`; the cascade's below-threshold path writes `fragments`. Are these the same concept under two table names, or distinct? Resolve before flipping M8. (`candidate_identities` is the legacy Wave-10 table; `fragments` is the migration-346 spine — likely M8 should write a `fragment`, but verify the readers.)
- **Q4 — `engagement_events` double writer.** M9 (`:1940`, weddingless) and the sibling `:1902` (wedding-bound, via `recordEngagementEventsBatch`) write the same event type two ways. Reconcile: should M9 route through `recordEngagementEventsBatch` first, then the cascade?
- **Q5 — cascade body-stages are dead on the live path.** `NormalizedSignal`→`CascadeSignal` round-trips through `MatchableRecord`, which has no body fields, so `cascadeMatch` stages 6/7/8 (body cross-ref, paired-name, family-name) never fire from `linkSignal` — only from the batch Tracer. Decide: add a real body-carrying adapter, or document body-stages as Tracer-only. Not a Batch-1 blocker but affects match quality.

## 8. Doc corrections to apply (from the code trace)

Fold into `CASCADE-CANONICAL-WRITER.md` + `src/lib/spine/cascade.ts` header:
1. `couple_merge_events` audit — change from "open question, verify Day 7" to **"confirmed gap — RPC does not write it; P3 adds it."**
2. "`pipeline.ts:4109` is fire-and-forget" — correct to **"awaited, but shadow by discarded result + swallowed error + trailing position."** (Stops the §1.1 implementer hunting a missing `await`.)
3. `lockAndMintCouple` "two live call paths" — precisely **one direct caller** (`applyTierRouting`), three upstream entry points (tracer cron, linker-via-pipeline, linker-via-Calendly/brain-dump).
4. `cascade.ts` barrel should export `linkSignal` (P4) or state the orchestrator-vs-chokepoint split.
5. `tracer.ts:730` direct `INSERT INTO couples` is a chokepoint violation — route through `lockAndMintCouple` (P3b).

---

## Batch 1 done-definition (the gate to Batch 2)

P1-P5 shipped · all 9 MIGRATE sites flipped · per-site shadow-compare divergence zero · CI guard `check-cascade-only-writer.mjs` green on `pipeline.ts` · battery re-run shows no regression from the 1.447 baseline (Phase 1 changes writes, not reads — a drop signals a bug). Then Batch 2 (ingestion adapters: Calendly, HoneyBook, Twilio, Zoom, OpenPhone).

---

## Pressure-test findings & remediation (2026-05-22)

A 4-agent adversarial pressure-test (doctrine / engineering-spec / code-correctness / battery) ran against the P1-P5 commit `352cf23`. Outcome: P1, P3, P4 sound as shipped; P2 was incomplete; P5's commit message over-claimed; the battery axis is regression-SAFE.

**P2 — was incomplete, now COMPLETED (commit follows `352cf23`).** The pressure-test found `enrichExistingPartner2` only closed the *2nd-and-later* partner2 case: the first partner2 fell through to `resolver.createPerson`, which hard-coded `role:'partner1'` + no `wedding_id`, so the next signal missed it and still duplicated. Plus a TOCTOU race (no DB uniqueness) and a surname-lowercasing bug. Remediation:
- `createPerson`/`resolvePersonOnly`/`mintPerson` now thread `role`+`weddingId` → a fresh partner2 mints correctly stamped. Default (no context) unchanged.
- **Migration 367** — partial unique index `people (venue_id, wedding_id, role) WHERE merged_into_id IS NULL AND wedding_id IS NOT NULL AND role IN ('partner1','partner2')`. The DB now enforces the invariant the TS check only checked optimistically (closes the race). Migration has a `DO`-block pre-flight that fails loud + names offending groups if pre-existing partner dups exist (it does NOT auto-dedup — that is the audited merge cascade's job).
- `lastNameOf` no longer lowercases (was corrupting stored surnames).
- **M4/M5 flip note:** once `pipeline.ts:2211/3062` route through `mintPerson`, a concurrent-race loser will hit the migration-367 unique index — the flip must treat a unique-violation as "partner already exists, re-query", not a hard failure.

**P5 — code is correct; the commit message over-claimed.** PHASE-1-BATCH-1.md §P5 listed 5 steps; P5 did 1, 2, 5. Step 3 (in-pipeline divergence logging) is delegated to `scripts/shadow-compare.ts` — acceptable. **Step 4 (reposition `linkSignal` as a first-class step so later steps consume its couple binding) is deliberately NOT done and should stay not-done** — repositioning so legacy steps depend on the cascade binding would violate the Phase 1 dual-write rule ("legacy stays source of truth"). §P5 step 4 was wrong for Phase 1; corrected here. No P5 code change needed.

**P3 — open item for the site-flip.** The tracer reroute's synthetic touchpoint uses `external_id = fragment.id` (the fragment PK), not the original event's external_id — so it will NOT dedup against a live-linker touchpoint for the same event → latent double-count in touchpoint/journey counts. Resolve when M8/the tracer path is touched (added to Q-list below as Q6).

**Battery — regression-SAFE.** `intel-brain` (the NLQ read path) reads ~30 tables; zero overlap with anything P1-P5 writes (`couples`/`touchpoints`/`couple_merge_events`/`people`/cascade). P1-P5 moves no battery question now (correct — prerequisites). **Hazard:** the battery runner reads `.env.local` → prod `jsxxgwprxuqgcauzlxcb`; migrations 366/367 are written for the consolidation Supabase branch. Any post-366/367 battery run must point `.env.local` at the DB the migrations were applied to, or it measures the wrong substrate.

- **Q6 (new) — tracer synthetic touchpoint external_id.** Use the fragment's original event external_id, not the fragment PK, or document the double-count as accepted. Resolve at the tracer/M8 step.
