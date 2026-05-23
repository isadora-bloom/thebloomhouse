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

The **9 MIGRATE sites** + **M10 (discovered during pressure-test)**. Line numbers DRIFT — `Shipped` column is canonical; see §3 for full per-site detail.

| # | site | table | what it creates | **Shipped** |
|---|---|---|---|---|
| M1 | `pipeline.ts:~1581` | `interactions` | core inbound touchpoint | ✅ **VERIFIED, no code** — `linkSignal:~4109` already routes it (P5 made it load-bearing). `b9745be` |
| M2 | `pipeline.ts:~696` | `people` | partner1 person (`findOrCreateContact`) | ✅ **FLIPPED — partial route.** Only the *create* goes through `mintPerson`; the canonical-resolver + contacts-table match steps stay outside the chokepoint (preserves contact resolution). `8d95181` + alias/pool fixes in `307ffd6` |
| M3 | `pipeline.ts:~724` | `contacts` | email-contact mirror | ✅ **STAY** — `mintPerson`/resolver do NOT write the contacts mirror. Guarded on `mintIsNew` + alias-recovery on resolved-existing (`307ffd6`). `8d95181` |
| M4 | `pipeline.ts:~2210` | `people` | partner2 fresh_inquiry (Liam Hunt) | ✅ **FLIPPED** — `mintPerson({weddingId, role:'partner2', signals.fullName})` + same-wedding collision guard. `c39cd17` + `307ffd6` |
| M5 | `pipeline.ts:~3060` | `people` | partner2 Calendly/scheduling (Liam Hunt) | ✅ **FLIPPED** — same. `c39cd17` + `307ffd6` |
| M6 | `pipeline.ts:~1169` | `interactions` | outbound `isOwnOutbound` self-loop | ✅ **`linkSignal` added** — `action_type:'venue_sent'` + `signal_tier:'medium'` (NOT `'outbound'` — byte-consistent with the batch Gmail adapter for rerun-safe dedup). `8d95181` |
| M7 | `sendApprovedDraft` | `interactions` | outbound from operator-approved send | ✅ **`linkSignal` added** (separate function). `8d95181` |
| M8 | `pipeline.ts:~2435` | `candidate_identities` | sub-Point-Zero pre-couple | ✅ **STAY-as-dual-write — pragmatic deferral** (not doctrinal sanction). `candidate_identities` is a live Wave-10 layer (42 readers incl. battery `intel-brain.ts`) that the spine eventually subsumes (Phase 3/4). Cascade equivalent already fires via `:~4204` `linkSignal`. Verified 252/252 cohort coverage. `317b112` |
| M9 | humanRequested block | (touchpoint via `linkSignal`) | spine record for human-escalation | ✅ **`linkSignal` added**. The `engagement_events.insert` at `:1940` STAYS (heat write — cascade doesn't touch heat). `action_type:'human_requested'` once migration **368** lands (extends `couple_progression_events.event_type` CHECK). `317b112` + `307ffd6` + this commit |
| **M10** | `flushPendingAutoSends` | `interactions` (was missing) | outbound from autonomous-send cron | ✅ **MISSED in original enumeration — discovered by pressure-test.** No `interactions` row + no cascade call since the loop was built. Both added (legacy + `linkSignal`). Historical backfill script `scripts/backfill-autosend-interactions.ts` ready for operator. `307ffd6` + this commit |

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
6. **M9 (`engagement_events`)** — ✅ **FLIPPED 2026-05-22 + DOCTRINE-DEBT CLOSED 2026-05-23** (Q4 resolved). Q4 corrected the worklist: `engagement_events` is a heat-table the cascade has zero relationship to — the `:1940` insert is a STAY, not an M-site. The REAL M9 gap: the `humanRequested` block returns at `:~1978` BEFORE the `:~4204` `linkSignal`, so human-escalation emails never reach the cascade (both the weddingless arm AND the `weddingId`-set arm). Added a `linkSignal` call inside the `humanRequested` block, positioned to cover both arms before the return. **Doctrine-debt close (this commit):** initial flip used `action_type:'reply'` + `raw_payload.escalation` workaround because `progressionEventTypeFor` only mapped `'reply'`/`'inquiry'`/`'inbound_followup'`. Now: migration **368** extends `couple_progression_events.event_type` CHECK to add `'inbound_human_request'`; `ProgressionEventType` + `progressionEventTypeFor` extended; M9 passes `action_type:'human_requested'` directly. Fail-safe: `recordProgressionIfEligible` already swallows CHECK violations, so a misordered deploy degrades to "no progression row" not a pipeline crash — but **migration 368 should land before the code reaches that DB** for correct progression-log inclusion.

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

## 7. Open questions

- **Q3 — `candidate_identities` vs `fragments`.** ✅ **RESOLVED 2026-05-22.** Distinct, not synonyms. `candidate_identities` is the Wave-10 cluster table (42 readers, incl. battery); `fragments` is the migration-346 spine pre-couple record. M8 stays as dual-write — the cascade already produces a fragment-or-couple via `:~4204` `linkSignal` for every M8 email. The Wave-10-vs-spine collapse is a Phase 3/4 reader-migration concern. Pragmatic deferral, not doctrinal sanction.
- **Q4 — `engagement_events` double writer.** ✅ **RESOLVED 2026-05-22.** `engagement_events` is a heat table; the cascade has zero relationship to it. M9's `:1940` insert STAYS (heat write). The actual fix was adding a `linkSignal` call inside the `humanRequested` block (the early `return` at `:~1978` was bypassing the trailing cascade write).
- **Q5 — cascade body-stages dead on the live path.** Still OPEN. `NormalizedSignal`→`CascadeSignal` round-trips through `MatchableRecord`, which has no body fields, so `cascadeMatch` stages 6/7/8 (body cross-ref, paired-name, family-name) never fire from `linkSignal` — only from the batch Tracer. Decide: add a real body-carrying adapter, or document body-stages as Tracer-only. Not a Batch-1 blocker but affects match quality.
- **Q6 — tracer synthetic touchpoint `external_id`.** Still OPEN. Tracer's `promoteFragmentInto` reroute (P3) creates a `touchpoint` keyed on the fragment's PK, not the original event id → latent double-count vs a live-linker touchpoint for the same event. Resolve at the tracer/M8 step.

## 8. Doc corrections to apply (from the code trace)

Fold into `CASCADE-CANONICAL-WRITER.md` + `src/lib/spine/cascade.ts` header:
1. `couple_merge_events` audit — change from "open question, verify Day 7" to **"confirmed gap — RPC does not write it; P3 adds it."**
2. "`pipeline.ts:4109` is fire-and-forget" — correct to **"awaited, but shadow by discarded result + swallowed error + trailing position."** (Stops the §1.1 implementer hunting a missing `await`.)
3. `lockAndMintCouple` "two live call paths" — precisely **one direct caller** (`applyTierRouting`), three upstream entry points (tracer cron, linker-via-pipeline, linker-via-Calendly/brain-dump).
4. `cascade.ts` barrel should export `linkSignal` (P4) or state the orchestrator-vs-chokepoint split.
5. `tracer.ts:730` direct `INSERT INTO couples` is a chokepoint violation — route through `lockAndMintCouple` (P3b).

---

## Batch 1 done-definition (the gate to Batch 2)

P1-P5 shipped ✅ · all 9 MIGRATE sites resolved (M1/M8 verified, M2-M7 + M9 flipped) ✅ · M10 (discovered) flipped ✅ · CI guard `check-cascade-only-writer.mjs` green on `pipeline.ts` ✅ (built 2026-05-23 — exit 0 on baseline, 23 grandfathered files for Phase 3/4 chip-down) · battery re-run not yet executed against branch-with-migrations-applied — pending operator (the DB-target hazard means a re-run against prod won't reflect Batch 1 writes; substrate is structurally unchanged either way per the pressure-test). **Per-site shadow-compare gate effectively re-scoped under dual-write doctrine** — see `CONSOLIDATION-PLAN-PHASED.md` §1.3 v2. Then Batch 2 (ingestion adapters: Calendly, HoneyBook, Twilio, Zoom, OpenPhone).

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

---

## Pressure-test 2 + gap-closure (2026-05-22 → 2026-05-23)

After all 9 site-flips landed, a second 4-agent pressure-test (doctrine / engineering-spec / code / battery) found 1 CRITICAL + 2 HIGH + 3 MEDIUM defects and three spec-level gaps. All fixed in `307ffd6` + this commit.

**Code defects fixed (`307ffd6`):** C1 M5 partner2 same-email collision (Calendly partnerEmail==inviteeEmail → matched partner1 of same wedding → name pollution) closed by a new `mintPerson` guard + `createPartner2Person` helper that discards same-wedding/cross-wedding-partner1/2 matches and mints fresh. C2 M2 `weddingId` dropped on alias/pool resolver hits — fixed by querying the matched person's wedding_id at the return. C3 `flushPendingAutoSends` missing both legacy `interactions` row AND cascade call (pre-existing bug — autonomous sends invisible to follow-up-sequences / signal-inference / voice-dna / thread view since the loop was built) — both added; **historical backfill script ready** (`scripts/backfill-autosend-interactions.ts` — read-only by default, `--apply` to write, operator runs against the branch first). 3 MEDIUMs: M2 bare-email name regression (display_handle fallback), M3 contacts mirror gap on alias hits, M2 tangential-signal promotion skipped on alias hits (split `enqueueIdentityMatches` via `skipAutoMerge` option).

**Doctrine debt closed (this commit):** M9 `action_type:'reply'` honesty workaround → migration **368** extends `couple_progression_events.event_type` CHECK to add `'inbound_human_request'`; `ProgressionEventType` + `progressionEventTypeFor` extended; M9 passes `action_type:'human_requested'` directly (raw_payload.escalation workaround removed). M4/M5 partner2 name-capture provenance bogus audit row → `createPerson` now suppresses its inner `captureNameEvidence` when `partnerContext?.role === 'partner2'` (the M4/M5 callers fire honest evidence with `source:'partner_mention_in_body'` / `'form_relay'` after). M8 framing in §3 item 5 reworded from "doctrinally distinct" to "pragmatic deferral."

**Spec gaps closed (this commit):**
1. **`scripts/check-cascade-only-writer.mjs` built.** Walks `src/**` (skips `identity/`, `spine/` which ARE the allowed-writer surface), detects INSERT/UPSERT/RPC to the 10 guarded tables (4 spine + 6 legacy identity), grandfather list of 23 files with one-line justifications per file. Exit 0 on baseline; sanity-checked to trip on new violations. `pipeline.ts` cleanly removed from the spine + people + weddings grandfather scope (still grandfathered for `interactions` + `candidate_identities` — Phase 3 limb migration).
2. **Per-site shadow-compare gate honestly re-scoped** in `CONSOLIDATION-PLAN-PHASED.md` §1.3 v2 (this commit) — under dual-write, divergence reduces to "did we add a cascade call alongside the legacy write," which typecheck+guards+logic-trace verify by construction; the `OldPathRunner` harness retains value for Phase 2 reimport reconciliation + Phase 3 reader migration where cascade outputs replace legacy reads.
3. **§1 table + §7 Q3/Q4** updated to reflect actual shipped state (was a reader trap — pre-flip verdicts still showing).

**Operator carry-forwards into Batch 2:**
- Apply migration **367** (partner2 unique index — needs branch dashboard re-run, 15 dup groups already resolved) and migration **368** (`event_type` CHECK extension — needs branch dashboard run).
- Review JC Matos / Jancarlo Matos cross-role merge from the dup-resolution (commit `a5777ff`).
- Run `scripts/backfill-autosend-interactions.ts --apply` on the branch (dry-run found 0 rows on the branch — autonomous-send flush hasn't fired since the May 14 wipe; rerun against prod when desired).
- Re-run the battery against whichever DB the migrations landed on (the `.env.local` → prod hazard is unresolved).
