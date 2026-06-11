# Bloom — Ratified Execution Plan (Master · Drift-Proof)

> ## ⚠️ STATUS 2026-06-11 — SUPERSEDED AS THE EXECUTION TRACKER
> The 2026-06-11 plan stress-test (Fable-5 audit) found this document's checkboxes were
> never updated across ~35 commits of real work (Phase 3.3 complete, Phase 1.1 shipped,
> hardening done — all unticked). Rather than maintain two trackers, this doc is
> **retired as the live tracker**. What remains authoritative here: the §3 decision
> ledger (D-0…D-12 rationale) and the doctrine anchoring. For *sequence and current
> state*, read: **`CONSOLIDATION-PLAN-PHASED.md` (execution authority, incl. the new
> §1.8 D4/D5 pre-Phase-2 requirement) + `CHANGELOG.md` (ship record)**.
> The Phase-0 §0.9 guard flip was executed 2026-06-11 (commit on `consolidation`).

**Version:** 1.0 — **RATIFIED 2026-05-29** (CEO sign-off, §10)
**Date:** 2026-05-28 (ratified 2026-05-29) · **CEO:** Isadora Martin-Dye · **Eng Lead:** Claude (orchestrator)
**Status of the work:** RATIFIED. Phase 0 in progress — D-1 ✅ verified, D-3 ✅ resolved (portal empty → wipe); remaining Phase-0 actions: D-12 (wire test-branch `.env`) + flip the CI guards to enforcing (§0.9). Phase 1.1 starts Monday. *(Stale — see the 2026-06-11 banner above.)*

> **What this document is.** The single execution authority for the Bloom House rebuild. It does not restate the detail in the supporting docs — it *sequences* them, attaches a **guardrail** to every gate and a **checkbox** to every step, and defines what "no drift" means and how it is enforced. If any other doc conflicts with this one on *sequence or gates*, this wins; on *doctrine* the Canonical Product Definition v1.0 wins; on *identity/lifecycle detail* the supporting specs win.

**Anchored supporting docs (the detail lives here):**
- `BLOOM-HOUSE-VS-SCRATCH-COMPARISON.md` — why fix House, not ship Scratch.
- Canonical Product Definition v1.0 (CEO doc) — the supreme product doctrine.
- `CANONICAL-RECONCILIATION-SPECS.md` — D4 Point-Zero / D5 decay+direction / D6 five-state.
- `ORIGIN-INGESTION-SPEC.md` — one origin-sourced full-fidelity ingestion path.
- `CONSOLIDATION-PLAN-PHASED.md` v2 — the phase mechanics.
- `FIX-PLAN-GOVERNANCE-AND-CANONICAL.md` v2 — governance (B) + structural mandates (D).
- `BLOOM-CONSOLIDATION-GAP-REGISTER.md` — the audited gaps (G1–G23) + mandates (M1–M6).
- `BLOOM-CEO-DECISIONS.md` — the decision rationale (D-1…D-12).

---

## 1. The doctrine that can never drift (the non-negotiables)

These hold in every phase. A change to any of them requires CEO re-ratification (§10), recorded in revision history.

- [ ] **N1 — Bloom is a venue intelligence platform.** Identity reconstruction is the substrate, not the product. Lead with intelligence.
- [ ] **N2 — The couple is the unit.** Never two Person records for one wedding. Agents are a separate class.
- [ ] **N3 — One origin-sourced, full-fidelity ingestion path.** Origin → adapter → `linkSignal` → spine. No reconstruction from derived tables. No silent drops. (`ORIGIN-INGESTION-SPEC.md`)
- [ ] **N4 — Deterministic-first identity.** Email/phone/exact-name before fuzzy. No silent merges above review threshold. Unmerge is first-class.
- [ ] **N5 — Point-Zero is mid-funnel** (name + reachable identifier). Pre-zero = discovery; post-zero = reconfirmation. (D4)
- [ ] **N6 — Decay clock: 90–120d, couple-side inbound only.** Outbound never resets decay, never adds heat. Direction set at write time. (D5)
- [ ] **N7 — Honesty over confidence (TBH).** Carry `n`; null-safe ratios; refuse on absent data; aggregate-not-name on sensitive themes. A confident wrong number is the worst failure.
- [ ] **N8 — Every "AI/Sage/smart" label is a real LLM call.** LLM judges; structured signals decide. LLM never mints identifiers, never overrides a deterministic match.
- [ ] **N9 — Venue is the hard tenancy boundary.** No cross-venue read caused by another venue's event. Cross-venue analytics is a deliberate future feature, never an accident.
- [ ] **N10 — HoneyBook `lead_source` is untrusted.** Attribution from upstream raw signals only.

---

## 2. Governance operating model (how drift is prevented day-to-day)

- [ ] **Roles ratified.** CEO (Isadora) sets direction, ratifies amendments, acknowledges every phase gate explicitly. Eng Lead owns this plan as contract, reviews every PR against a cited §, cannot unilaterally amend. Track Agents work one step at a time, cite the § in every commit.
- [ ] **Plan-as-contract.** Every PR cites a plan §/Phase/mandate (`check-pr-cites-section.mjs`). Code without a trace is rejected: out of scope (cut) or plan incomplete (amend first).
- [ ] **Amendments need CEO sign-off**, recorded in §11. The Lead proposes; the CEO ratifies.
- [ ] **Phase gates are RED forcing functions.** A phase advances only when: deliverables ✓ + guardrails green ✓ + golden subset ✓ + **explicit CEO acknowledgement** (silent ≠ advance).
- [ ] **Stop-the-line.** Any golden-case regression or a risen ratchet halts all merges until fixed.

**Decision rights:** within-step detail → Agent · interface/schema/prompt/scoring → Lead · scope/phase/principle/Canonical → CEO.

---

## 3. Decision ledger (ratify by checking every box)

| # | Decision | Recommendation | Status |
|---|---|---|---|
| D-0 | Fix House, don't ship Scratch (Path C) | adopt | ✅ **RATIFIED 2026-05-29** |
| D-1 | Verify nobody is live before any wipe (G3) | run the SQL; proceed only if clean | ✅ **VERIFIED 2026-05-29** — only the operator (Isadora) has sessions; 3 sessions/30d all hers, latest = her own SQL-editor login. Pre-launch, no external users. **Wipe path GREEN.** |
| D-2 | Re-source everything from origin (one full-fidelity path) | adopt `ORIGIN-INGESTION-SPEC.md` | ✅ **RATIFIED 2026-05-29** |
| D-3 | Event/portal data on reimport (G2) | count it; wipe if seed, else deterministic ids | ✅ **RESOLVED 2026-05-29** — CEO confirms the portal has NO data → wipe the event tables too; no deterministic-id preservation needed. **Makes G2 (FK stability) moot.** |
| D-4 | Dual-write failure semantics (G4) | dissolved by D-5; one txn + throw for residual | ✅ **RATIFIED 2026-05-29** |
| D-5 | Spine-first cutover (vs 3-mo dual-write) | adopt cutover | ✅ **RATIFIED 2026-05-29** |
| D-6 | Canonical v1.0 supreme | yes | ✅ **RATIFIED 2026-05-29** |
| D-7 | Decay window default | 120 days | ✅ **RATIFIED 2026-05-29** |
| D-8 | Point-Zero + direction = real migrations | approve in Phase 0 | ✅ **RATIFIED 2026-05-29** |
| D-9 | Staffing section | park to Phase 3.4 | ✅ **ACK 2026-05-29** |
| D-10 | HoneyBook absorption | park post-consolidation | ✅ **ACK 2026-05-29** |
| D-11 | Knot/WW partnership | park | ✅ **ACK 2026-05-29** |
| D-12 | Golden harness → test-branch DB | point at `pre-tier-8` branch, seed test venue | ⏳ **PENDING-ACTION** (wire `.env`; Monday) |

> **RATIFIED 2026-05-29.** D-0–D-11 ratified/acked by CEO; D-1 verified (operator-only); D-3 resolved (portal empty → wipe event tables). Only D-12 (test-branch wiring) remains, a Monday action — it gates the golden full-run, not ratification.

---

## 4. Guardrail registry (the drift tripwires — all wired into CI / `npm run check:governance`)

| Guardrail | What it prevents | Command | Gate |
|---|---|---|---|
| **Cleanup-budget ratchet** | debt growing (crons, dup modules, hand-list, grandfather, migrations) | `check-cleanup-budget.mjs` | every push; targets at Phase 4 |
| **RLS venue ratchet** | new venue table without isolation (74 baseline, may only fall) | `check-rls-on-venue-id.mjs` | every push |
| **Plan-trace guard** | un-cited commits (drift) | `check-pr-cites-section.mjs` | every push |
| **Cascade-only-writer** | spine writes outside the chokepoint | `check-cascade-only-writer.mjs` | every push |
| **No-mirror-source** *(build in Phase 1)* | adapters reading our own tables | `check-no-mirror-source.mjs` | every push after P1 |
| **Merge-cascade sync** *(delete in Phase 3 when hand-list hits 0)* | hand-list/schema drift | `check-merge-weddings-cascade.mjs` | branch |
| **Golden cases** | identity-shape regressions | `npm run test:golden` (branch) / `--dry` (CI) | per-phase subset |
| **Battery (37 Q)** | intelligence-quality regression | `scripts/run-battery.ts` | per-phase subset |

**Ratchet targets at Phase 4 (the "no drift achieved" numbers):** `duplicate_identity_modules=0`, `resolver_reassign_calls=0`, `cron_count↓` (~24), `grandfather_entries=0`, `migration_files=1` (post-flatten), `rls gaps→0`, all golden cases green, battery ≥ +1.0 with zero −3.

---

## 5. The phases (each step a checkbox; each gate a hard guardrail)

### PHASE 0 — Ratify + instrument (~1 week · firm)
**Objective:** lock the contract and stand up every guardrail before touching ingestion.
- [ ] 0.1 CEO checks all of §3 (or annotates exceptions); §10 signed.
- [x] 0.2 D-1 run (2026-05-29): auth.sessions = 3/30d, all the operator's (latest her own login); no external users — **pre-launch confirmed, wipe path GREEN.** Gate to Phase 2 satisfied.
- [x] 0.3 D-3 resolved (2026-05-29): CEO confirms portal has NO data → wipe event tables too; no preservation; G2 (FK stability) moot.
- [ ] 0.4 Ratify Canonical v1.0 supreme (D-6); add N3 + the origin non-negotiable to the doctrine docs.
- [ ] 0.5 Write D4/D5/D6 into `ARCHITECTURE-DECISIONS.md`; author the 3 small migrations (point_zero cols, touchpoint direction/zero_phase, identifier reliability) — **do not apply to prod**.
- [ ] 0.6 Set decay default 120 (D-7).
- [ ] 0.7 Battery: replace "36"→"37"; assign Q37/Tier-9 to Phase 3.3; audit battery covers all 5 USPs.
- [ ] 0.8 Seed the test branch (D-12): `.env` → `pre-tier-8` branch; seed `GOLDEN_TEST_VENUE`; `npm run test:golden` runs (records which GC pass today = the worklist).
- [ ] 0.9 Confirm all guardrails green: `npm run check:governance`.
- **EXIT GATE 0:** §10 signed ✓ · D-1 result recorded ✓ · guardrails green ✓ · `npm run test:golden` produces a baseline ✓ · CEO ack ✓.

### PHASE 1 — One origin-sourced writer (~2 weeks · range) — `ORIGIN-INGESTION-SPEC.md` §6
**Objective:** `linkSignal` becomes the sole writer; ingestion is origin-sourced + full-fidelity. (Replaces PHASED §1's "migrate 138 writers.")
- [ ] 1.1 Fold the Backwards Tracer into `linkSignal`; deprecate `sources/{gmail,calendly,knot,instagram,anchors}.ts`; remove the Tracer's `insertTouchpointIdempotent`/`lockAndUpsertCouple` separate writer.
- [ ] 1.2 Gmail signal builder carries `full_body` + `rfc2822_headers` into `touchpoints.raw_payload`. (GC-10)
- [ ] 1.3 Calendly signal carries the four-state Q&A + email/phone. (GC-11)
- [ ] 1.4 Turn OFF legacy-identity writes from ingestion paths + disable repair/healing crons (the cron count starts falling).
- [ ] 1.5 Partner2 dedup invariant confirmed (already shipped: `mint-person.ts` + mig 367). (GC-3)
- [ ] 1.6 Build `check-no-mirror-source.mjs`; extend `check-cascade-only-writer.mjs` to forbid the retired Tracer writer.
- [ ] 1.7 Apply the D4/D5/D6 migrations to the **branch**; un-tag GC-8/GC-9/GC-10/GC-11 from `pending` → `spine`.
- **EXIT GATE 1:** all guardrails green ✓ · `check-no-mirror-source` passes ✓ · cleanup-budget shows cron_count + grandfather + dup-modules **fell** ✓ · GC-1/3/7/8/9/10/11 green on the branch ✓ · CEO ack ✓.

### PHASE 2 — Wipe + replay from origin (~1 week · firm) — gated on EXIT GATE 1 + D-1
**Objective:** a clean spine by construction.
- [ ] 2.1 Snapshot to a reversible branch (restore point).
- [ ] 2.2 Export the EXPORT-AND-REMERGE danger tables (operator overrides, manual merges, etc.) keyed by stable external ids.
- [ ] 2.3 Wipe the identity/pipeline spine + legacy mirrors (per a manifest rebuilt from `ORIGIN-INGESTION-SPEC.md`, not the old wipe scripts).
- [ ] 2.4 Replay **every origin** (Gmail API, Calendly API/QA, HoneyBook/Knot/WW/Zola CSVs, SMS, Zoom, web forms) through `linkSignal`. No mirror reads.
- [ ] 2.5 Re-merge the exported danger data against the new ids.
- [ ] 2.6 Run GC-12 (re-onboard with `interactions` truncated rebuilds the spine identically — proves origin-sourced).
- **EXIT GATE 2:** spine sane (plausible couple count · every booked couple has `source_wedding_id` · zero >2-people weddings · no orphan touchpoints) ✓ · GC-1/2/3/5/6/7/12 green ✓ · battery Q29/Q30 pass ✓ · re-merge reconciles ✓ · CEO ack ✓. **Rollback:** restore the 2.1 snapshot.

### PHASE 3 — Migrate readers limb-by-limb (~6–9 weeks · range)
**Objective:** each limb reads the spine; its loop closes; its legacy reads are deleted. One limb at a time.
- [ ] 3.1 Agent + Loop 1 (voice). Battery Q1-6, Q22-25. Sever Agent→Intel peer imports.
- [ ] 3.2 Sage (the brain). Battery Q17-21, Q31-32 (honesty).
- [ ] 3.3 Intel + the 6 canonical functions (replace the `askIntel` stub with the real implementation). Battery Q7-16, Q26-28, Q33, Q35, **Q37**.
- [ ] 3.4 Portal + Loop 4 (reads `weddings` via `source_wedding_id`, D1). Battery Q34. **Resolve D-9 staffing here.**
- [ ] 3.5 When `resolver_reassign_calls` hits 0: delete the hand-list AND `check-merge-weddings-cascade.mjs`.
- **EXIT GATE 3 (per limb):** the limb's battery subset ≥ +1.0 ✓ · its loop closes ✓ · its legacy reads deleted ✓ · guardrails green ✓ · cleanup-budget fell ✓ · CEO ack ✓.

### PHASE 4 — Delete the graveyard (~1 week · firm)
**Objective:** remove what is now provably unreferenced; hit the ratchet targets.
- [ ] 4.1 Execute the mechanically-verified kill list (M6 — produced, not "derived later"): dead pages, dead services (after dynamic-dispatch cross-check), obsolete crons, legacy tables (`interactions`/`attribution_events`/`wedding_touchpoints`/`people` — NOT `weddings`).
- [ ] 4.2 Migration baseline flatten → 1.
- [ ] 4.3 Multi-venue invariant re-verified (second seeded venue, no cross-venue leak).
- **EXIT GATE 4 (SHIP GATE):** full 37-Q battery ≥ +1.0, zero −3 in Tier 4, Tier 8 consistency +2/0, Tier 9 ≥ +1 ✓ · **all ratchet targets met** (§4) ✓ · all golden cases green ✓ · `npm run build` + `test:unit` clean ✓ · CEO ack ✓.

---

## 6. Drift-prevention rules (hold across all phases)

- [ ] **Every commit cites a §** (CI-enforced).
- [ ] **No metric in `cleanup-budget.json` ever rises** without a CEO-signed budget bump in the same PR.
- [ ] **No new `grandfather` entry** in any writer guard without a CEO note.
- [ ] **No adapter reads a mirror table** (`check-no-mirror-source.mjs`).
- [ ] **No golden case removed** without CEO sign-off; catalog is additive-only.
- [ ] **No phase advances on a silent yes** — explicit CEO ack, recorded in §11.
- [ ] **A risen ratchet or a red golden case = stop-the-line** until fixed.

---

## 7. Definition of "no drift achieved"

Drift is gone when all of these are simultaneously true and stay true (the ship state):
- [ ] One ingestion path; `check-no-mirror-source` + `check-cascade-only-writer` both green with empty grandfather lists.
- [ ] `duplicate_identity_modules = 0` (one matcher `cascadeMatch`, one writer `linkSignal`).
- [ ] `resolver_reassign_calls = 0` (no hand-maintained table list; the sync guard deleted).
- [ ] `rls gaps = 0` (every venue table isolated).
- [ ] `migration_files = 1`; `cron_count` at target.
- [ ] All golden cases green; battery ≥ +1.0 with zero −3.
- [ ] No legacy identity tables read by any limb.

When every box here is checked, the system that the user *sees* equals the system that was *ingested at origin*, on one auditable path, with no parallel truth.

---

## 8. Rollback ladder
Phase 0: nothing to roll back (no runtime change). · Phase 1: revert per-step; the live path is unchanged until 1.4. · Phase 2: restore the 2.1 snapshot (fully reversible). · Phase 3: per-limb git revert (independent units). · Phase 4: `git revert` (deletion only; Phase 3 proved nothing reads it).

---

## 9. Honest open risks (named so they're not forgotten)
- Phase 1's "fold the Tracer" is the riskiest single step — it changes the reconstruction writer. Mitigated by GC-12 (truncate-`interactions` rebuild) and the branch test.
- Reader migration (Phase 3) becomes urgent under the cutover (no months of legacy limping). This is the accepted trade for a clean spine first.
- The kill list (M6) must be mechanically re-derived at Phase 4 start, not trusted from today's draft.
- D-1 (nobody live) is the load-bearing assumption for the whole wipe — verified, not assumed (0.2).

---

## 10. Ratification

> By signing, the CEO ratifies this plan as the execution authority, the §1 non-negotiables, the §3 decisions as checked, and the §2 governance model. Amendments hereafter require a new signature line in §11.

- [x] **CEO (Isadora Martin-Dye): RATIFIED — D-0 through D-11 · date: 2026-05-29**
- [x] **Eng Lead acceptance (2026-05-29):** plan is internally consistent with all anchored docs. D-1 verified (operator-only); D-3 resolved (portal empty → wipe event tables, G2 moot); D-12 (test-branch wiring) is the only open Phase-0 action.

---

## 11. Revision history
- **v1.0 — RATIFIED (2026-05-29)** — CEO ratified D-0–D-11 + signed §10. D-1 verified (operator-only sessions → wipe path GREEN); D-3 resolved (portal empty → wipe event tables, G2 moot). Open: D-12 (test-branch wiring) + flip CI guards to enforcing (§0.9), both Monday. Execution authority is live.
- **v1.0-RC (2026-05-28)** — initial master plan. Synthesizes the comparison, Canonical v1.0, the reconciliation specs, the origin-ingestion spec, the consolidation phases, the governance + Layer-D mandates, and the D-1…D-12 decisions into one checkboxed, guardrailed execution authority. Pending CEO ratification (§10).
