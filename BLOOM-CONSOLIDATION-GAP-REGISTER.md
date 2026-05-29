# Bloom House — Consolidation Gap Register

**Date:** 2026-05-28
**Method:** four adversarial code+doc audits, run through one lens: *does the plan COLLAPSE the problem, or add a CHECK AROUND it?* Collapse = cleanup. Check-around = bandaid.
**Companion:** `FIX-PLAN-GOVERNANCE-AND-CANONICAL.md`, `../BLOOM-HOUSE-VS-SCRATCH-COMPARISON.md`.

> **Verdict:** the fear is justified. In its current state the consolidation is **mostly bandaid with deferred cleanup**, and three of the deferrals are *structurally unable to complete as written* (circular reimport, surviving merge hand-list, non-executable kill list). The **one** genuine collapse (partner2/Liam Hunt: funnel + DB unique index) proves the team *can* do real cleanup — they just deferred the rest. "Defer the deletion" is exactly how House reached 378 migrations. This register is the list of what must change from *check-around* to *collapse* before the plan can be trusted.

---

## Bandaid-vs-cleanup scorecard

| Area | Verdict | Why |
|---|---|---|
| partner2 / Liam Hunt dedup | ✅ **CLEANUP** | `mintPerson` funnel + migration 367 partial-unique index → a duplicate is *impossible*, not *checked-for* |
| Source-quality / Voice DNA / macro layer | ✅ functional | real services, loops close (audit 3) |
| 5–6 identity resolution modules | ❌ **BANDAID** | all survive, none in any deletion budget; `matcher.ts` runs "in parallel" with legacy "by design" |
| Mint chokepoint | ❌ **BANDAID** | it's a grandfather ledger (~14 `people`-insert sites blessed); guard blocks only *new* sites |
| `mergeWeddings` 35-table hand-list | ❌ **BANDAID (unaddressed)** | survives untouched; plan never mentions it; Phase-4 deletes will leave it dangling + silently swallowing errors |
| `interactions`/`people` deletion | ❌ **BANDAID + DATA LOSS** | reimport reads *from* these tables; `raw_payload` is not a superset (`full_body` dropped) — circular, can't delete |
| Phase 4 kill list | ❌ **BANDAID** | not executable; ~19 "dead" files provably live; author disavows it ("not yet trustworthy") |
| `fragments`/`couple_progression_events` | ❌ **BANDAID** | collapse deferred → the "clean six-table spine" ships *with two redundant spine tables* |
| Healing crons | ⚠️ **BANDAID risk** | "disable not delete"; no proof-of-unneeded gate; system cron-dependent for ~15 weeks; count grew 47→49 |
| NLQ canonical path | ⚠️ **STUB** | live NLQ works (pre-consolidation brain); the consolidation's *target* `askIntel` returns "not yet implemented" |
| Battery ship-gate | ⚠️ **GAMEABLE** | scores regex shape; a wrong-but-well-shaped answer passes identically to a correct one |

---

## TIER 0 — BLOCKERS (bake in permanent dual-state or data loss; fix before Phase 2)

**G1 — Deleting `interactions` is circular and lossy.** [audit 2 #5]
`raw_payload` is claimed a superset of `interactions`; it is not — the live `email-to-signal.ts` writer stores `{subject, interaction_id…}` but **not `full_body`**; the spine reader `couple-attribution.ts:484` reads `raw_payload.body`/`full_body` which are never written → battery Q28 content-mining silently empties once `interactions` is gone. Worse, the Phase-2 reimport's Gmail/Calendly adapters read *from* `interactions`/`people`/`tours` — the very tables Phase 4 deletes. **The deletion target is the reimport's data source.** → permanent dual-state at the `interactions` boundary.
*Collapse requires:* re-source the reimport from the Gmail API (not the `interactions` mirror) AND carry `full_body` into `raw_payload`; **or** formally reclassify `interactions` as PRESERVE and admit it's permanent.

**G2 — PRESERVE-EVENT FK stability across reimport is unaddressed.** [audit 4 §5.8] *Likely the single biggest silent data-loss risk.*
Phase 2 wipes and rebuilds `weddings`/`couples`. ~40 PRESERVE-EVENT tables + `sage_conversations` are keyed on `wedding_id`. **No doc states whether a reimported wedding keeps its old `id`.** If HoneyBook external-id → a fresh UUID, every event table and every couple↔Sage chat orphans. The manifest asserts "weddings survives" but never proves id-stability across the rebuild.
*Collapse requires:* a deterministic external-id→UUID mapping proven stable before the wipe, or an explicit remap pass for all PRESERVE-EVENT FKs.

**G3 — "Nobody is live on bloom-house" is an operator recollection, not a verified query.** [audit 4 §2.1]
The entire safety basis for an irreversible-in-spirit wipe. No check of recent auth sessions / active Supabase connections / couple-portal logins on the bloom-house project is shown.
*Collapse requires:* run the query (auth sessions + portal logins, last 30d) and paste the result into the plan before Phase 2. One SQL statement.

**G4 — Dual-write partial-failure is undecided, and the divergence gate was removed on a false premise.** [audit 4 §5.1, §1.3-v2]
The plan never says what happens when the legacy insert succeeds and the cascade write fails (or vice-versa) in production — `PHASE-1-BATCH-1.md` P5 leaves "re-throw vs log-and-continue" *undecided*. Meanwhile §1.3-v2 **removed** the per-writer shadow-compare gate, arguing divergence is "construction-prevented." That argument only holds if both writes are one transaction — **they are two separate inserts**, so a partial failure creates exactly the dual-state the project exists to kill, with no reconciliation procedure.
*Collapse requires:* wrap legacy+spine writes in one transaction (or an outbox), decide the failure semantics, and restore a divergence reconciliation for the dual-write window.

---

## TIER 1 — STRUCTURAL BANDAIDS (cleanup deferred; will become permanent without a forcing function)

**G5 — The 5–6 duplicate identity modules all survive.** [audit 1 #1]
`resolver.ts` (1813 lines), `resolution.ts`, `matcher.ts`, `candidate-resolver.ts`, `tracer.ts` are all alive and wired; **none is in any deletion budget**. `matcher.ts:18` documents the legacy scorer "stays in place… the two matchers run in parallel without overlap." Partition-and-coexist ≠ collapse.
*Collapse requires:* a named module-deletion budget with a target end-state ("one matcher: `cascadeMatch`; one writer: `linkSignal`"), each legacy module assigned a Phase-3 delete date.

**G6 — The mint "chokepoint" is a grandfather ledger.** [audit 1 #2]
~14 files raw-insert `people`; the CI guard blesses 4 "canonical" + grandfathers ~9 and only fails on *new* sites. `mintPerson` itself delegates to `resolver.ts`'s raw insert. There is one *designated* path, not one *possible* path.
*Collapse requires:* the ratchet (M1) so the grandfather list can only shrink, plus routing the delegated inserts through the actual chokepoint so "canonical" means "the only insert."

**G7 — The `mergeWeddings` 35-table hand-list survives untouched — and will rot.** [audit 1 #4]
`resolver.ts:1685-1813` still hand-lists ~35 `reassign('table')` calls with swallowed per-table errors; it *explicitly rejects* FK-cascade. The plan never mentions it. Phase 4 deletes `interactions`/`people`/etc. while the hand-list still references them → silent partial merges hidden by the swallow-error design. There is no `mergeCouples` spine equivalent.
*Collapse requires:* kill the class — FK `ON DELETE`/reassign via a generated list or a single cascade, and a CI guard banning hand-maintained table-name lists (M5).

**G8 — Phase 4's kill list is not executable.** [audit 2 #2, audit 4 §1.10]
The kill-list doc disavows itself ("page DELETE list derived not enumerated"; "~37 dead services is an unsubstantiated upper bound — only 11 verified; ~14 proven LIVE via dynamic dispatch; 2 'delete' files are imported by the spine itself"). 6 named unresolved conflicts. Phase 4 = "re-derive the list at Phase 4 start."
*Collapse requires:* produce the mechanical, verified deletion list **now** (M6); resolve the 6 conflicts; until then Phase 4 has no real budget.

**G9 — `fragments` + `couple_progression_events` collapse is deferred → the "clean spine" ships unclean.** [audit 2 #3]
Both are part of migration 346 (the spine) and read by 18 files incl. KEEP surfaces. CRITICAL-AUDIT itself flags them as collapsible into `touchpoints`. Deferring means the promised clean six-table spine ships with two redundant spine tables.
*Collapse requires:* either collapse them in Phase 1 schema work, or drop the "clean spine" claim and document them as permanent with a reason.

**G10 — Healing crons: "disable not delete," no retirement gate.** [audit 2 #4]
The plan keeps repair/drift crons running through Phases 1–3 (up to 15 weeks) to "hold legacy and spine consistent," then "disables (not deletes)" them per limb. There is **no forcing function that proves a cron is unnecessary** before Phase 4. CRITICAL-AUDIT: "the repair tax is permanent because the writers are permanent." Cron count *grew* 47→49 during planning.
*Collapse requires:* a per-cron retirement gate ("zero rows changed over N runs ⇒ delete, not disable") and a hard rule that the cron count may only fall.

---

## TIER 2 — CANONICAL v1.0 DEVIATIONS (the plan predates your doc)

**G11 — Decay window is 180d (canonical 90–120); two parallel heat systems.** [audit 3 #1]
`decay_window_days` defaults 180 (`migration 346:89`, CHECK ≥90). Two heat models coexist (`wedding_heat` 0.98^days; `heat-score.ts` 14-day half-life). The outbound-exclusion invariant *does* hold, but via a read-time filter, not a write-time guarantee everywhere.

**G12 — The NLQ canonical path is a stub.** [audit 3 #5]
Live NLQ (`intel-brain.ts`) is real and grounded — but the consolidation's *designated* entrypoint `canonical.askIntel` returns "Intel is not yet implemented." The consolidation of NLQ has not happened; the gate runner even retargets from one to the other mid-plan (G18).

**G13 — Point-Zero is unreconciled.** Plan still implies booked-wedding anchor (Tier-8); canonical wants mid-funnel (name+identifier). No pre-zero/post-zero signal typing exists. → see Draft A (D4).

**G14 — The battery is 37 questions; every plan says 36; Q37/Tier-9 is assigned to no phase.** [audit 4 §1.1, §5.6]
The ship gate references the wrong denominator and silently drops the test the battery itself calls "the most operationally useful" (the workflow chain). The Phase-4 gate text mentions "Tier 9 chain ≥ +1" but the battery→phase map has no row for Q37.

---

## TIER 3 — GATE-INTEGRITY (the instruments can't be trusted yet)

**G15 — The battery is a gameable shape/regex proxy.** [audit 3] `EVIDENCE_RE` counts *any* number/date/quote ≥4 chars as "evidence"; a wrong-but-shaped answer scores +2 identically to a correct one. The consistency check only verifies the *same name* appears — a consistently-wrong channel passes. It's a calibration/honesty screen, **not a correctness oracle**. → must pair with the golden cases (Draft B) which assert exact values.

**G16 — The battery's `.env.local` points at PROD while migrations 366–376 are on the branch.** [audit 4 §3.4] Every phase gate invokes the runner; it may silently measure the wrong substrate. *Fix: pin the runner to the branch DB; fail if the schema_version doesn't match.*

**G17 — multi-venue isolation is unenforced on far more tables than the audit estimated.** The guard `check-rls-on-venue-id.mjs` did not exist; now built (Draft B). Its static scan found **74 venue-scoped tables with no enforced venue_id policy** (the audit estimated "2 PII RLS-OFF + 13 default-deny" — reality is ~5× worse). Baselined at 74 in `rls-baseline.json`; the count may only fall. Canonical §3.6 says no cross-venue leak is a non-negotiable, so these 74 are the most underestimated risk in the whole plan. [audit 4 §2.8, §4.2-4.3 + live scan 2026-05-28]

**G18 — The gate runner changes targets mid-plan** (`intel-brain` → `askIntel` stub at Phase 3.3), so the Phase-1 "score unchanged" gate and the Phase-3.3 "score improved" gate do not measure the same system. [audit 4 §4.1]

---

## TIER 4 — STALE BASELINE (re-measure before Phase 0 closes)

**G19** — Every load-bearing count is stale: crons 47→**49**; migrations 365→**376**; LOC "111k"→**85.9k**; service-DELETE 48 / ~37 / **11-verified**; page MERGE "12" but **15 listed**; "~50 writers"→"~40–50"; Liam line numbers disagree across three docs (2198/2850/3053 vs 2211/2907/3062 vs 2211/3062-only). [audit 4 §1.3–1.11] The §0.2 claim "the kill list is mechanical, not a guess" is falsified by its own output. *Fix: one re-baseline pass; freeze the numbers.*

---

## TIER 5 — UNADDRESSED OPERATIONALS

- **G20 — In-flight data during the wipe/reimport.** `email_poll` keeps running through Phase 2; inbound Gmail/Calendly/Twilio during the hours-long reimport, and poller-vs-wipe ordering, are unspecified. [audit 4 §5.2]
- **G21 — AI cost/rate-limit during the ~8,183-email reimport.** No cost envelope; the cost-ceiling crons are being deleted. [audit 4 §5.5]
- **G22 — Partial-limb data rollback.** Per-limb git revert is covered; *data* recovery after a limb's legacy reads are deleted and it then regresses is not. [audit 4 §5.3]
- **G23 — The attribution "rename" hides a reimplementation.** `getSourceAttribution ← rename buildCoupleAttribution` must re-prove the HoneyBook-overwrite precedence, the `signal_class='source'` filter (mig 200), and the status-gated booking count — none of which the spine version replicates. Budgeted as "least work"; it isn't. [audit 2 #1]

---

## What this means: six STRUCTURAL-COLLAPSE MANDATES (the real fix)

Governance + canonical reconciliation (the FIX-PLAN overlay) is **necessary but not sufficient.** The audits prove the consolidation plan has structural cleanup gaps that no amount of process fixes. Add these as **Layer D** of the fix plan — each converts a named bandaid into a collapse, and each is enforceable:

| # | Mandate | Kills which gap | Enforced by |
|---|---|---|---|
| **M1** | **Grandfather ledger is a RATCHET.** Commit a baseline count of every guard's GRANDFATHERED entries; CI fails if any count *rises*. Each phase has a target count it must hit. | G6, G10 | `check-grandfather-ratchet.mjs` (Draft B) |
| **M2** | **Module-deletion budget.** Name `resolver/resolution/matcher/candidate-resolver/backtrack` with a Phase-3 delete date and the end-state "one matcher, one writer." | G5 | plan amendment + the ratchet |
| **M3** | **Break the circular reimport.** Re-source Gmail from the API; carry `full_body` into `raw_payload`; OR reclassify `interactions` PRESERVE and admit dual-state. | G1 | Phase-2 manifest fix + a test that the clean spine has bodies |
| **M4** | **Prove FK stability across reimport** (external-id→UUID deterministic) before the wipe, or remap all PRESERVE-EVENT FKs. | G2 | a pre-wipe reconciliation script + gate |
| **M5** | **Kill the `mergeWeddings` hand-list** (FK cascade / generated list). NOTE: `check-merge-weddings-cascade.mjs` already exists but it *keeps the hand-list synced with schema* — a bandaid-that-keeps-a-bandaid-correct. The goal is to DELETE the hand-list, then delete that guard too. | G7 | `cleanup-budget.json` `resolver_reassign_calls` → 0 (no new guard — would fight the existing one) |
| **M6** | **Make the Phase-4 kill list executable NOW** (mechanical enumeration; resolve the 6 conflicts) — not "at Phase 4 start." | G8, G19 | a re-baseline pass that outputs a verified, line-level list |

Plus three **verify-before-trust** items that gate Phase 2: **G3** (run the live-traffic query), **G16** (pin the gate DB), **G4** (decide dual-write transaction semantics).

**The test of whether we're still bandaiding:** at the Phase-4 gate, the grandfather counts are **zero**, the duplicate modules are **deleted** (not disabled), the cron count has **fallen**, and there is **no hand-maintained table list anywhere**. If any of those is false, it was a bandaid. M1's ratchet is what makes that test continuous instead of a hope.
