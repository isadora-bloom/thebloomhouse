# Bloom House — Fix Plan (Governance + Canonical Overlay) · v1

**Date:** 2026-05-28
**Status:** PROPOSED overlay. Amends, does not replace, `CONSOLIDATION-PLAN-PHASED.md` v2.
**Supreme contract:** *Bloom — Canonical Product Definition v1.0* (Isadora & Co, May 2026).
**Companion analysis:** `../BLOOM-HOUSE-VS-SCRATCH-COMPARISON.md`.

---

## 0. What this is — and what it is NOT

The decision (made 2026-05-28): **fix Bloom House; do not ship Bloom Scratch; transplant the discipline that made Scratch clean.** The companion comparison explains why — the expensive thing (the five USPs + Agent + Portal) already exists in House; the bounded thing (a divergent spine) is already mid-repair; and the no-live-customer window that makes the Phase 2 wipe safe is a depreciating asset.

`CONSOLIDATION-PLAN-PHASED.md` v2 is the **mechanically sound** repair plan for the spine. It is not changed by this document. This overlay adds the **two and only two** layers it lacks:

- **Layer A — The Contract.** Reconcile the plan with Canonical v1.0. The consolidation predates v1.0 and is anchored on superseded doctrine (Point-Zero = booked wedding; no decay window; "intelligence loop is the USP" rather than the five ranked USPs). Left unfixed, a *perfect* consolidation still ships the wrong anchor.
- **Layer B — The Governance.** Import the operating model that made Bloom Scratch clean (Bloom Scratch `PLAN.md` §1.5/§5/§7/§12): plan-as-contract, a per-commit golden-case ratchet, RED phase gates, and the CEO/Lead/Track-Agent roles. House did not get to 378 migrations because TypeScript is bad; it got there because **nothing stopped the drift.** Run the consolidation in the same governance vacuum and it re-accretes.

**Explicit non-goals.** This overlay does not rewrite the five phases, does not add product surfaces, does not port Scratch's code, and does not change D1/D2/D3. It is additive layers, not a new tree.

---

## Layer A — The Contract: reconcile with Canonical v1.0

Canonical v1.0 becomes the supreme doctrine, above `ARCHITECTURE-DECISIONS.md`, `BLOOM-PLAYBOOK.md`, and `IDENTITY-FIRST-ARCHITECTURE.md`. Four substantive deltas must be resolved into the plan **before Phase 1 writer migration commits** (they change spine semantics, so doing them after is rework):

### A.1 — Point-Zero = mid-funnel (name + reachable identifier). *Reverts Tier-8.*
- **Action:** add **D4** to `ARCHITECTURE-DECISIONS.md`: Point-Zero is the first event at which a couple is known by *both* a name and a reachable identifier — not the booked wedding. Pre-zero touches pin to the candidate/fragment; post-zero touches pin to the couple (and, once booked, the wedding).
- **Where it lands:** Phase 1 cascade semantics (the `linkSignal`/`cascadeMatch` path must stamp each touchpoint pre-zero vs post-zero relative to the couple's Point-Zero event). The Backwards Tracer's "anchor on booked wedding and walk backward" becomes "anchor on highest-trust ground truth, establish Point-Zero, type every signal by its side of zero." Pre-zero Knot view = *discovery* signal; post-zero Knot email = *reconfirmation* signal — they must not be conflated in attribution (Phase 3.3).
- **Gate:** golden case **GC-8** (below) asserts the pre/post-zero pinning and signal typing.

### A.2 — Decay window = 90–120 days, couple-side inbound only.
- **Action:** set the canonical decay constant to a configurable 90–120d (House currently 180). Enforce **direction discipline at the write layer** (Canonical §5): every interaction carries an `INBOUND`/`OUTBOUND` direction set at write time; outbound (venue email, Sage draft, auto-follow-up) **never** resets the decay clock and **never** contributes to heat.
- **Where it lands:** Phase 1 invariant + a new CI guard `check-heat-decay-inbound-only.mjs` (sits beside `check-cascade-only-writer.mjs`). This is the same *class* of guard the plan already uses; one more rule.
- **Gate:** golden case **GC-9** asserts outbound-does-not-reset.

### A.3 — Five identity states (Fragment → Channel-Scoped → Resolved → Ghost → Booked).
- **Status:** House's schema is *already* canonical here — `couples.lifecycle_state ∈ {channel_scoped, resolved, booked, ghost, agent}`. The only gaps: confirm **Fragment** is a real pre-couple state (it is, via `fragments`) and that the state machine's transitions match v1.0 (Booked never decays; Ghost revivable couple-side only; Fragment expires and never resurrects).
- **Action:** a one-page state-transition spec appended to `ARCHITECTURE-DECISIONS.md`; no schema change expected. This is the cheapest delta.

### A.4 — Intelligence-first framing + the five ranked USPs as the battery's spine.
- **Action:** the ship battery must demonstrably cover all five canonical USPs, in priority order: (1) heat scoring + decay detection, (2) source *quality* intelligence ("best couples, not most leads" — conversion × spend × review-score by source), (3) Voice DNA, (4) external macro signal layer, (5) NLQ. Audit `BLOOM-TEST-QUESTIONS.md` against these five; **USP #2's quality framing and the macro-layer questions are the likely gaps** — add questions if missing. (Note: reconcile the 36-vs-37 question count while here.)
- **Where it lands:** Phase 0 battery-runner expected-shapes; Phase 4 ship gate.

### A.5 — Close or park Canonical v1.0's three open items.
Staffing section, HoneyBook absorption trajectory, Knot/WW partnership data model (v1.0 §6 "Unresolved"). **Decision required from CEO** before Phase 3.4 (Portal) touches staffing. Park the other two as post-consolidation unless they block a limb.

---

## Layer B — The Governance: the operating model that prevents re-accretion

Adopted from Bloom Scratch `PLAN.md` §1.5. This wraps **all five existing phases**.

### B.1 — Roles
- **CEO (Isadora).** Sets direction; ratifies amendments to this overlay, to `CONSOLIDATION-PLAN-PHASED.md`, and to Canonical v1.0; holds veto on the non-negotiables; **acknowledges every phase gate explicitly** (a silent "looks fine" is not advancement).
- **Engineering Lead (the orchestrating Claude).** Owns both plan documents as the contract; assigns Track Agents to phases/batches; reviews every PR against a cited §; maintains the golden-case CI ratchet; writes the phase-gate reports; cannot unilaterally amend either plan.
- **Track Agents (Claude instances).** Work one batch/limb at a time; cite the plan § in every commit; escalate on interface/schema/scope ambiguity; cannot edit the plans, change interfaces, or skip a golden case.

### B.2 — Plan-as-source-of-truth (the anti-accretion rule)
1. **Every PR cites a §** of `CONSOLIDATION-PLAN-PHASED.md` (or this overlay). A PR that can't cite one is rejected: either it's out of scope (cut) or the plan is incomplete (amend first, then build).
2. **Amendments require CEO sign-off**, recorded in a revision-history section. The Lead proposes; the CEO ratifies.
3. **Code without a plan-trace is removed at review.** This is the single rule that 378 migrations prove House never had. (Enforce mechanically — see B.5 governance CI.)

### B.3 — Decision-rights matrix
| Decision | Owner |
|---|---|
| Within-batch implementation detail | Track Agent |
| Adding a golden case / pressure test | Track Agent (notify Lead) |
| Interface/schema/prompt/scoring-weight change | **Lead** |
| Cross-limb coupling resolution (sever vs move-to-`shared/`) | **Lead** |
| Scope change, phase re-scope, timeline slip | **CEO** |
| Canonical non-negotiable or D1–D4 change | **CEO** |

### B.4 — Phase gates become RED forcing functions
The plan already defines a gate per phase. This adds the Scratch discipline that makes a gate un-fudgeable:
- Each phase gate is encoded as a **failing CI suite** that only goes green when the phase's deliverables + golden-case subset + battery subset pass. (Mirror of Scratch's `test_phase_2_gate.py` RED-by-design pattern.)
- A phase **does not advance** until: (a) its CI gate is green, (b) the Lead writes a phase-gate report (golden cases? battery delta? cost? timeline vs estimate? amendments?), (c) the **CEO acknowledges explicitly.**
- **Stop-the-line:** any golden-case regression on `consolidation` or `master` halts all merges across all tracks until reverted/fixed.

### B.5 — Governance is itself CI-enforced
Add to the existing `scripts/check-*.mjs` family:
- `check-pr-cites-section.mjs` — PR body/commits must reference a plan §.
- `check-golden-cases.mjs` — runs the GC suite (Layer C) every commit; non-negotiable, Lead cannot waive.
- The existing `check-cascade-only-writer.mjs` stays the interface-contract guard.

---

## Layer C — The ratchet: golden cases (the thing that keeps the clean spine clean)

The plan gates on the 36-question battery — an *aggregate* score. Scratch's decisive insight: you also need a handful of **exact, frozen, identity-level assertions** that run every commit and can never regress. The battery proves intelligence quality; golden cases prove the spine doesn't rot. Seed the catalog from Scratch's two cases + House's known failure shapes + Canonical v1.0's worked examples:

| ID | Case | Asserts | Source |
|---|---|---|---|
| **GC-1** | Doug L. (warm→dropped→returned) | relay `@member.theknot.com` + direct gmail → **one** couple, two identifiers at two reliability tiers; timeline ordered through the 2-month gap; state `dropped-on-our-side` | Scratch golden A |
| **GC-2** | Ashley + Ryan (cross-source) | `original_source=The Knot`, `inquiry_channel=Calculator`, both shown side-by-side; origin confidence `confirmed` | Scratch golden B |
| **GC-3** | Liam Hunt (booked, partner2 exists) | minting with a partnerName when partner2 already present → **enrich-or-skip, never a 3rd person row** | House under-merge bug (§1.5) |
| **GC-4** | Two Sarahs (distinct, non-overlapping ids) | two same-name couples stay **TWO**; auto-merge suppressed; routed to review | House over-merge risk / Scratch Tier-1.5 guard |
| **GC-5** | Madison Bryant (5 signals) | Knot relay → IG → Calendly (partner email) → Calculator → HoneyBook contract = **one** record | Canonical v1.0 §9.5 worked example |
| **GC-6** | HoneyBook Lead Source ignored | attribution derives from upstream raw signal, never the CRM's `lead_source` stamp | Canonical §3.1 / conflict registry |
| **GC-7** | Knot relay ceiling | relay-only identity capped at **medium confidence**; cannot auto-merge until a direct identifier is observed | Canonical / conflict registry |
| **GC-8** | Point-Zero pinning | pre-zero touch pins to candidate, post-zero to couple/wedding; pre-zero Knot view = discovery, post-zero Knot email = reconfirmation | Canonical §3.3 (A.1) |
| **GC-9** | Decay clock direction | outbound email does **not** reset decay or add heat; only couple-side inbound does | Canonical §3.4/§5 (A.2) |

Catalog is **additive-only** (removal requires CEO sign-off). GC-1/GC-2 are portable verbatim from Scratch — its repo is the reference implementation of "what correct looks like."

---

## Layer D — Structural-collapse mandates (added 2026-05-28 after the gap audit)

Governance (B) + canonical reconciliation (A) are **necessary but not sufficient.** The four adversarial audits (`BLOOM-CONSOLIDATION-GAP-REGISTER.md`) proved the consolidation plan has structural cleanup gaps that no process fixes — deferrals that are *circular* or *impossible* as written. Layer D converts each named bandaid into a collapse, and each is mechanically enforced:

| # | Mandate | Kills | Enforced by |
|---|---|---|---|
| **M1** | Grandfather ledger / debt counters may only DECREASE | G6, G10, G5 | `scripts/check-cleanup-budget.mjs` + `cleanup-budget.json` (baselined to measured truth: 49 crons, 5 dup modules, 34 reassign calls, 27 grandfather entries, 376 migrations) |
| **M2** | Module-deletion budget: one matcher (`cascadeMatch`) + one writer (`linkSignal`); the other 5 get a delete date | G5 | `duplicate_identity_modules` metric → target 0 |
| **M3** | Break the circular reimport (re-source Gmail from API + carry `full_body`; or reclassify `interactions` PRESERVE) | G1 | Phase-2 manifest fix + a "clean spine has bodies" assertion |
| **M4** | Prove FK stability across reimport (external-id→UUID) before the wipe | G2 | pre-wipe reconciliation gate |
| **M5** | No hand-maintained table lists. `check-merge-weddings-cascade.mjs` already *keeps the hand-list synced* — that is a bandaid-that-keeps-a-bandaid-correct; the goal is to DELETE the hand-list (FK cascade / generated list), at which point that guard is deleted too | G7 | `resolver_reassign_calls` metric → target 0 (then remove `check-merge-weddings-cascade.mjs`) |
| **M6** | Make the Phase-4 kill list executable NOW (mechanical enumeration; resolve the 6 conflicts) | G8, G19 | a re-baseline pass producing a verified line-level list |

Plus three **verify-before-Phase-2** gates: **G3** (run the live-traffic query — the wipe's safety basis is a recollection), **G16** (pin the gate DB; the battery `.env` points at prod), **G4** (decide dual-write transaction semantics; the divergence gate was removed on a false premise).

**Governance code shipped (Layer B/C/D enforcement, all verified runnable):**
- `scripts/check-cleanup-budget.mjs` (+ `cleanup-budget.json`) — the M1 ratchet. Probes live code; debt may only fall.
- `scripts/check-rls-on-venue-id.mjs` (+ `rls-baseline.json`) — G17 ratchet. Surfaced **74 venue-scoped tables with no enforced isolation** (audit estimated "2+13"); baselined at 74, may only fall.
- `scripts/check-pr-cites-section.mjs` — B.2 plan-as-contract (every commit cites a §/Phase/mandate).
- `tests/golden/run-golden-cases.ts` + `cases.json` — Layer C. GC-1…GC-9, surface-tagged (spine runs now; legacy + `pending:D4/D5/A2` reported, never silently passed). `materialize()` drives the real `linkSignal`; refuses the prod DB.
- All wired into `.github/workflows/ci.yml` (static gates) + `package.json` (`npm run check:governance`). DB-driven full golden run stays branch-only.

**What the audit changed in A and the cases:** Draft A's D4/D5/D6 are not just doctrine — the real schema has **no** `point_zero_*`/`confidence` columns on `couples`, **no** `zero_phase`/`direction` on `touchpoints`, and **no** identifier-pool table with `reliability`. So A.1/A.2 imply **migrations**, and the golden cases tag those assertions `pending:D4/D5/A2` until the migrations land. This is recorded honestly rather than asserted against a schema that doesn't exist.

---

## How it all slots into the existing five phases (additive, minimal)

| Existing phase | What this overlay adds |
|---|---|
| **Phase 0** (prereqs, ~1wk) | **+A.1–A.5 canonical reconciliation** (D4 Point-Zero, decay constant + direction spec, 5-state spec, battery-vs-5-USP audit). **+B governance stood up** (roles named, the three `check-*.mjs` governance guards built alongside the existing battery runner + shadow-compare). **+C golden-case harness seeded** with GC-1…GC-9 (extends the already-planned `scripts/shadow-compare.ts`). |
| **Phase 1** (unify writes, 4-6wk) | Partner2 dedup (§1.5) **is GC-3** — already planned, now ratcheted. **+ direction-discipline guard (A.2)** and **+ Point-Zero stamping in the cascade (A.1).** Every writer PR cites §1.2 + passes GC suite. |
| **Phase 2** (wipe+reimport, ~1wk) | The clean reimported spine **must pass GC-1…GC-7 by construction** — this is the proof that "clean by construction" is real, not asserted. |
| **Phase 3** (limb migration, 6-9wk) | Each limb gate = its battery subset (already mapped) **+ its golden-case subset + CEO ack.** Phase 3.3 attribution honors pre/post-zero typing (A.1). |
| **Phase 4** (delete, ~1wk) | Ship gate = full battery (now covering all 5 USPs, A.4) **+ all 9 golden cases green + governance audit** (zero untraced code merged across the whole consolidation). |

**Net added effort:** concentrated in Phase 0 (~3-4 extra days: the reconciliation specs + three governance guards + nine golden-case fixtures). Phases 1-4 gain almost no new *work* — they gain *gates*. That asymmetry is the point: cheap to add, and it's what makes the three months stick.

---

## The go/no-go is already half-answered

My one condition for choosing "fix" over "rebuild" was a spike proving House's spine isn't fatally entangled. **Batch 1 already ran it:** 9 enumerated writers → 7 flipped cleanly + 2 correctly reclassified, verified by typecheck + CI guard + logic trace (`PHASE-1-BATCH-1.md`). That is direct evidence the write path is migratable, not rotten. **Formalize it:** before committing the full Phase 1, complete one Batch-1-style flip for *one writer of each adapter class* (pipeline ✅, one ingestion adapter, one cron). If any class proves fatally entangled, the Lead escalates to CEO and the rebuild calculus reopens. Absent that, proceed.

---

## What we explicitly do NOT do

- **Do not ship Bloom Scratch.** Keep it alive as the correctness oracle / reference implementation; archive it once Phase 2's clean spine passes GC-1…GC-7.
- **Do not rewrite the consolidation mechanics.** PHASED v2 is sound; this is an overlay.
- **Do not add product surfaces during Phases 1-2.** "Jumping to surfaces is the failure mode" (PHASED §Honest-risks #1).
- **Do not run the consolidation without the governance.** That is the one change that distinguishes this from the path that produced 378 migrations.

---

## Sequencing summary

1. **This week (paper, cheap):** ratify Canonical v1.0 as supreme; write D4 + decay/direction spec + 5-state spec (A.1-A.3); audit battery vs 5 USPs (A.4); CEO decision on the three open items (A.5).
2. **This week (stand up governance):** name the roles; build the three governance `check-*.mjs` guards; seed GC-1…GC-9 fixtures (Layer B + C, folded into the existing Phase 0).
3. **Then run PHASED v2 unchanged** — Phase 1→4 — now wrapped in plan-as-contract, gated by RED phase suites + the GC ratchet, each boundary closed by a Lead report + explicit CEO ack.
4. **Archive Scratch** once Phase 2 proves the clean spine.

The consolidation was always the right repair. This overlay is what makes it *hold*.

---

## Revision history
- **v2 (2026-05-28)** — added Layer D (structural-collapse mandates M1–M6) after the four-audit gap pass (`BLOOM-CONSOLIDATION-GAP-REGISTER.md`) proved governance alone insufficient. Shipped + verified the enforcement code (cleanup-budget ratchet, RLS ratchet — surfaced 74 isolation gaps, plan-trace guard, golden-case harness wired to real `linkSignal`), all baselined to measured truth and wired into CI. Recorded that Draft A's D4/D5 imply real migrations (no point_zero/direction/reliability columns exist today).
- **v1 (2026-05-28)** — initial overlay. Layer A (canonical reconciliation A.1-A.5), Layer B (governance B.1-B.5), Layer C (golden cases GC-1…GC-9). Built on `CONSOLIDATION-PLAN-PHASED.md` v2 + Canonical Product Definition v1.0 + the House-vs-Scratch comparison.
