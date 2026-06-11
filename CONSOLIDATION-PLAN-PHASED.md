# Bloom House — Consolidation Plan (Phased) · v2.1

**Date:** 2026-05-22 · v2 closes 12 gaps found in a critical pass of v1. · **v2.1 (2026-06-11):** absorbs the Canonical-v1.0 D4/D5 reconciliation as §1.8 (a PRE-PHASE-2 requirement) + records the Jun-11 stress-test verdicts (Batch-3 cron triage: no Phase-1 MIGRATE work — see §1.2 note; reimport path verified cascade-routed end-to-end). This doc is the single execution authority; `BLOOM-MASTER-PLAN.md` is retired as the live tracker (its §3 decision ledger remains the rationale record).
**Status:** ACTIVE master plan. Supersedes `CONSOLIDATION-PLAN-25-DAY-ANCHORED.md` and predecessors.
**Foundation:** `ARCHITECTURE-DECISIONS.md` (D1/D2/D3) · `PHASE-2-WIPE-MANIFEST.md` (the exact wipe list).
**Contracts:** `CASCADE-CANONICAL-WRITER.md` · `INTEL-CANONICAL-API.md`.
**Inputs:** `CONSOLIDATION-AUDIT.md` (Day 1, 7-agent audit) · the 2026-05-22 anatomical pass · `BLOOM-TEST-QUESTIONS.md` (36-question battery, the ship gate).

Honest timeline: **~3 months** (~13-15 weeks). Confidence: Phase 0/2/4 estimates are firm; Phase 1 and Phase 3 are ranges — re-scoped at each phase boundary, never compressed.

---

## 0. Foundations + operating assumptions

**The three architecture decisions** (`ARCHITECTURE-DECISIONS.md`):
- **D1 — two-entity model.** `couples` = IDENTITY (the spine). `weddings` = EVENT (what the Portal plans). 1:1 via `couples.source_wedding_id`. `weddings` is not legacy — it is the event entity. Re-key the identity-core tables to `couple_id`; the ~70 portal/event tables stay `wedding_id`-keyed.
- **D2 — wipe + reimport.** Clean spine by construction. Gated on D3.
- **D3 — ordering.** Unify writes → wipe+reimport → migrate readers limb-by-limb → stop legacy writes → delete last.

**Operating assumptions (stated, not assumed):**
- **bloom-house is a pre-launch workbench. It is live for nobody.** Rixey's couples use `rixey-portal`; Rixey's staff use rixey-portal. Confirmed with the operator 2026-05-22. This is what makes the Phase 2 wipe safe — there is no production traffic to disturb.
- The work is single-venue (Rixey) but **all code stays multi-venue-safe** — every function keeps its `venueId` parameter, every query its `venue_id` filter. Multi-venue is re-verified at the Phase 4 gate (§4); it is not a feature to add, it is an invariant not to break.
- "The spine" = `couples ⇄ weddings (1:1 for booked) + touchpoints` — two linked entities (corrected doctrine).

**Current reality (verified, anatomical pass):** a built+wired spine+cascade running in SHADOW MODE beside four legacy-native limbs. 482 legacy `.from()` calls vs 48 spine across the limbs; 20 cross-limb imports; the cascade has 36 of 138 writers. The job is promotion + migration, not construction.

**Branching (gap #11).** The consolidation runs on a long-lived `consolidation` branch off `master`, rebased weekly. `master` stays deployable throughout (a discipline, even though nobody deploys it). Each phase merges to `master` only after its gate passes. This keeps every phase boundary a clean, revertable point.

---

## PHASE 0 — Prerequisites  (~1 week · firm)

The plan cannot gate itself without these. None existed; all are built here first.

**0.1 — Build the battery runner (gap #3).** No runner exists (verified — grep empty). Build `scripts/run-battery.ts`: feeds each of the 36 `BLOOM-TEST-QUESTIONS.md` questions through the NLQ path, captures answers, scores against stored expected-shapes (regex + evidence-quote presence + refusal/hedge detection per the rubric). Output: per-question score + average + Tier-4 −3 count. **It targets the EXISTING NLQ brain (`brain/intel-brain.ts`) for the Phase 0 baseline** — the canonical `askIntel` is a Day-4-5 stub that refuses everything until Phase 3.3 makes it real; the runner retargets to `askIntel` at Phase 3.3. **Every phase gate below invokes this. Without it, "battery as gate" is a manual slog.**

**0.1b — Build the shadow-compare harness (gap #8).** Phase 1's per-writer safety net (§1.3) needs a comparator: given a writer, run its old path + the cascade path, diff the resulting couple binding / touchpoint count / fields, log divergence. Build it here as `scripts/shadow-compare.ts` (or a test harness) so Phase 1 is not blocked building infrastructure mid-migration.

**0.2 — Generate the kill list.** Produce `CONSOLIDATION-PLAN-FROZEN.md` mechanically from the Day 1 catalogs + D1/D2/D3: deletion budget → Phase 4, re-key list → Phase 1, per-limb migration → Phase 3. Now bookkeeping, not a guess.

**0.3 — Loop current-state assessment (gap #7).** None of the five loops is greenfield; all have components. Document the real starting state so "wire Loop N" in Phase 3 is concrete, not hand-waved:

> **DONE 2026-05-22 → `LOOP-ASSESSMENT.md` (real code trace; supersedes the filename-level bullets below).** Verdicts: Loop 1 voice ~85% closed · Loop 2 prediction does NOT close (calibration is read-only, the model never reads it back) · Loop 3 attribution ~50%, gap = 6 unregistered `vercel.json` crons · Loop 4 positioning ~90% · Loop 5 capacity is not a loop (three unconnected parts). All five read legacy tables only → all are Phase 3 reader-migration targets. The bullets below were the pre-trace filename guess — trust `LOOP-ASSESSMENT.md`.
- **Loop 1 (voice):** `draft_feedback`, `voice-dna-extract.ts`, `draft_edit_insights`, `voice/gmail-backfill.ts` all exist. The draft→edit→diff→voice-DNA→next-draft chain has every part — Phase 3.1 confirms it closes end-to-end.
- **Loop 2 (prediction):** substantial — `per-couple-derive.ts` (close probability), a real `calibration/` module (`analyze.ts`, `measure-outcomes.ts`, `record-prediction.ts`), `prediction_snapshots`/`prediction_outcomes` tables. Built; Phase 3 confirms closure.
- **Loop 3 (attribution):** `source-backtrace.ts`, discovery-source, `attribution_events`, marketing-spend. Partial (the § N.12 discovery work). Phase 3.3 finishes.
- **Loop 4 (positioning):** `reviews-analytics.ts`, `review-response.ts`, `review-language.ts`. Partial. Phase 3.4 finishes.
- **Loop 5 (capacity):** the weakest — `coordinator_absences`, `venue_operational_state`, auto-send pacing exist but the close (capacity → auto-send pace → follow-up timing) is loosest. Lighter-touch in Phase 3.

**0.4 — Tag + branch.** `pre-consolidation-2026-05-22`, persistent Supabase branch, the `consolidation` working branch.

**Phase 0 gate:** battery runner produces a baseline score against the current dual-state system (expected: low/inconsistent — that is the disease, measured). Kill list committed. Loop assessment committed.

**Rollback (gap #8):** Phase 0 writes no production data and no `src/` runtime code except `scripts/run-battery.ts`. Nothing to roll back.

---

## PHASE 1 — Unify the write path  (~4-6 weeks · range)

**Goal:** every writer routes through the cascade so `couples`/`touchpoints` and the legacy tables are written in lockstep — no new divergence. Legacy is still read; NOT yet read-only.

**1.1 — Promote the cascade shadow→primary.** Today the cascade runs via `route-by-tier.ts` → tracer cron + `pipeline.ts:4109` `linkSignal`. The pipeline call is **already `await`ed** (verified 2026-05-22) — it is shadow by a *discarded `LinkResult` + empty `catch{}` + trailing position*, not a missing `await`. Promotion = capture the result, surface errors (log or re-throw), act on the couple binding, reposition as a first-class pipeline step. The cascade write becomes load-bearing. Detail: `PHASE-1-BATCH-1.md` §P5.

**1.2 — Migrate the writers, in ordered batches (gap #6).** Agent A catalogued 138 writers: 36 already cascade-routed; of the 102 others — ~50 identity-bearing (MIGRATE), ~40 lifecycle/heat/metadata UPDATEs (legitimately stay — R1 is a creation boundary), 8 `cleanup-ghost-weddings` sites (DELETE — constitution-violating), 4 couple-pages (stay). **Note (2026-05-23, post-Batch-1):** Batch 1 went 9 enumerated MIGRATE → 7 flipped + 2 reclassified STAY (M8 `candidate_identities` Wave-10 dual-write; M9 `engagement_events` is heat-not-identity) + 1 discovered MIGRATE missed in enumeration (M10 `flushPendingAutoSends` — the autonomous-send cron path). If Batch 1's 9-to-effectively-8 ratio + 1 discovery extrapolates across Batches 2-4, the "~50" likely lands closer to **~40-50** after similar reclassifications and discoveries. Re-estimate at each batch boundary. The MIGRATE writers, sequenced highest-volume-first so the riskiest code is done while attention is freshest:
- **Batch 1 — the email pipeline.** Decomposed in `PHASE-1-BATCH-1.md`: 39 write sites → 9 MIGRATE, 30 STAY. The Liam Hunt partner2 sites are `pipeline.ts:2211` + `:3062` only — `:2907` is an `interactions` re-link UPDATE, not a partner2 insert (earlier conflation, corrected). Highest volume, highest risk.
- **Batch 2 — the ingestion adapters.** Calendly webhook, HoneyBook CRM import, Twilio/SMS, Zoom, OpenPhone.
- **Batch 3 — the 15 direct-writing crons** (Agent F): route each through the cascade.
- **Batch 4 — long-tail** writers (brain-dump, reprocess endpoints, data-integrity remediations).

**1.3 v2 — Shadow-compare gate, honestly re-scoped under dual-write (revised 2026-05-23 post-Batch-1).** The original §1.3 prescribed: every migrated writer runs in shadow first, divergence sampled per writer, flip to cascade-only when zero. After Batch 1 that gate proved redundant: under strict **dual-write doctrine** (§0, the legacy insert STAYS in Phase 1; the cascade write is ADDED in lockstep), "divergence" reduces to "did we add a cascade call alongside the legacy write." That is verified by typecheck + the CI guards (`check-cascade-only-writer.mjs`, `check-no-direct-people-insert.mjs`, `check-no-direct-wedding-insert.mjs`) + a per-site logic trace — *by construction* no new divergence can be introduced, because the legacy path is unchanged. Batch 1 verified 7 site-flips this way (typecheck + guards + logic trace) + 2 already-routed sites by consistency audit against the Supabase branch (M1 binding 99.8%, M8 cohort coverage 100%). The `scripts/shadow-compare.ts` HARNESS is RETAINED — it remains the right instrument for (a) Phase 2's wipe+reimport reconciliation (clean spine vs preserved-export reconciliation), and (b) Phase 3's reader-migration where cascade outputs *replace* legacy reads (then divergence is no longer dual-write-construction-prevented). Re-scoping is honest: the original prescription anticipated cascade-only writers in Phase 1, which dual-write deferred to Phase 4.

**1.4 — Schema: the spine is already couple-keyed — there is NO ALTER-re-key.** Verified against migration 346: `couples` and `touchpoints` are already `couple_id`-keyed; `touchpoints.raw_payload` (jsonb) carries the signal content including email bodies. The legacy `interactions` / `attribution_events` / `wedding_touchpoints` / `people` stay `wedding_id`-keyed, dual-written through Phases 1-2, and are **DELETED in Phase 4** once no limb reads them. The migration is each limb *switching which table it reads* (legacy→spine, Phase 3) — not a column swap. A hard re-key in Phase 1 would break every still-legacy reader; it does not happen.

Two tables need an explicit *successor*, not a re-key:
- **`people` dies; it has no 1:1 successor.** `couples` carries exactly two contacts as columns (`primary_contact_*`, `partner_contact_*`). Legacy `people` also holds MOB/FOB/planner/wedding-party rows. The two partners → the `couples` columns; people acting on a couple's behalf → `agents` (couples with `lifecycle_state='agent'`, linked via `agent_couple_links`); incidental others drop. Legacy `people` is deleted in Phase 4.
- **`tours` becomes couple-keyed.** A tour happens *before* booking — the couple may have no wedding yet — so `tours` cannot be `wedding_id`-keyed. The current migration-009 wedding-keyed `tours` is wrong for pre-booking tours. A couple-keyed `tours` schema is written here (additive) and rebuilt by the Phase 2 reimport from Calendly.

`reviews` stays venue-keyed (operator-pasted + Google-pull, nullable couple link) — PRESERVE-VENUE per the wipe manifest.

Phase 1's schema work is therefore *additive only* — write the couple-keyed `tours` table, identity-evidence columns if needed — never an ALTER that breaks a legacy reader.

**1.5 — Partner2 dedup invariant.** Extend `MintPersonInput` with `weddingId`+`role`; enrich-or-skip when a partner2 exists. Closes the Liam Hunt class (`CASCADE-CANONICAL-WRITER.md` §3.2).

**1.6 — CI guards + RLS.** ✅ `scripts/check-cascade-only-writer.mjs` **built 2026-05-23** — exit 0 on baseline, 23 grandfathered files with one-line justifications, sanity-checked to trip on new violations. `pipeline.ts` is OFF the spine/people/weddings grandfather scope (still in for `interactions` + `candidate_identities` — Phase 3 limb migration). Pending: `check-rls-on-venue-id.mjs` (not yet built); patch the 2 PII RLS-OFF tables (`notifications`, `wedding_timeline`); resolve the 13 default-deny tables (Agent G). Those are Batch-2 prerequisites, not Batch-1.

**1.8 — Canonical v1.0 reconciliation (D4 + D5) — REQUIRED BEFORE PHASE 2 (added v2.1, 2026-06-11).** This plan predates Canonical Product Definition v1.0 (2026-05-28) and never absorbed its two schema-bearing rulings; `BLOOM-MASTER-PLAN.md` §0.5/§1.7 sequenced them correctly but was never executed. They MUST land before the Phase-2 wipe — the wipe's whole value is correctness-by-construction at write time, and reimporting without these columns produces a spine clean by OLD doctrine that then needs backfills (the exact pattern the wipe exists to escape):
- **D5 — decay 90–120d, couple-side inbound only** (`CANONICAL-RECONCILIATION-SPECS.md` D5). Migration: `couples.decay_window_days` default 180→120 + clamp existing rows + CHECK 90–120; `couple_progression_events.direction` column + backfill. Code: the three `180` fallbacks (decay.ts / lifecycle-audit.ts / intel canonical.ts) → 120; decay reset + `last_progression_at` bumps become inbound-only. Un-pends GC-9.
- **D4 — Point-Zero = mid-funnel** (`CANONICAL-RECONCILIATION-SPECS.md` D4). Migration: `couples.point_zero_at` + `couples.point_zero_touchpoint_id`; `touchpoints.zero_phase` CHECK ('pre_zero','post_zero'). Writer: forwards-linker stamps point_zero at the first signal carrying a name + reachable identifier; every touchpoint stamped `zero_phase` at link time. Un-pends GC-8. The Phase-2 reimport then stamps both correctly from the first replayed signal.

**1.2 note (v2.1):** the 2026-06-11 Batch-3 triage (R1 creation-boundary applied per cron, full sweep of route.ts + vercel.json) found **zero Phase-1 MIGRATE crons**: `phase_b_sweep` / `identity_backtrack` write legacy-only derived annotations (tables that die in Phase 4) → STAY-through-Phase-2, disable/retire in Phases 3-4; `backtrace_scan` writes only admin_notifications; everything else already routes through chokepoints. Batch 2 adapters + Batch 4 long-tail verified cascade-routed (HoneyBook `linkSignalBatch` crm-import/index.ts:1912; brain-dump `mintWedding`; data-import `resolveIdentity`/`mintWedding`; Calendly replay linkSignal; Zoom/OpenPhone `linkSignalWithLifecycle`; reviews + web-visit replays linkSignal). **Phase 1's writer-migration scope is therefore COMPLETE pending §1.8.**

**1.7 — The two open items, RESOLVED 2026-05-22** (`CASCADE-CANONICAL-WRITER.md` §9): (a) `lock_and_mint_couple` does **not** write a `couple_merge_events` audit row — a confirmed gap, not an open question. Batch 1 §P3 adds the audit row and routes `tracer.ts:730`'s chokepoint-bypassing direct `INSERT INTO couples` through `lockAndMintCouple`. (b) `CascadeSignal` and `NormalizedSignal` are distinct types with no direct adapter — the live path round-trips lossily through `MatchableRecord`, dropping body text so `cascadeMatch` stages 6-8 never fire from `linkSignal` (`PHASE-1-BATCH-1.md` Q5).

**Phase 1 gate:** CI guards green. Per-writer shadow-compare divergence zero for every migrated writer. A venue-wide divergence check (spine vs legacy counts + sample reconcile) passes. Battery runner re-run — score should be unchanged (Phase 1 changes writes, not reads) — a *drop* signals a regression. **(v2.1)** §1.8 D4/D5 migrations authored + applied to the test branch, D5 code constants flipped, GC-8/GC-9 un-pended.

**Rollback (gap #8):** writers flip one at a time behind shadow-compare; a bad writer is reverted individually without touching the rest. If the cascade promotion itself regresses the pipeline, revert §1.1 to fire-and-forget — the shadow cascade keeps running as before. Phase 1 merges to `master` only after the gate.

---

## PHASE 2 — Wipe + reimport  (~1 week · firm)

**Goal:** a provably-clean spine by construction. Runs strictly from `PHASE-2-WIPE-MANIFEST.md`.

**2.1 — Fix the two wipe-script bugs** (per the manifest): the Tier-8 script wrongly wipes `event_feedback`/`annotations`/`natural_language_queries`/`draft_feedback`/`sage_conversations`; neither script touches the migration-346 spine. Phase 2 runs a fresh wipe built from the manifest, not the old scripts.

**2.2 — Export the EXPORT-AND-REMERGE danger tables** (8 of the 22): `evidence_overrides`, `identity_decision_clusters`, `couple_merge_events` (manual rows), `candidate_matches` (resolutions), `person_merges`, `draft_feedback`, `discovery_feedback_actions`, `discovery_sources`, plus the `weddings` operator column-cluster (`owner_note`, `owner_photo`, manual `lead_source`). Export keyed by stable identifiers (email / external CRM id).

**2.3 — Snapshot** to a persistent branch (reversible).

**2.4 — Wipe** the ~78 WIPE tables (incl. the migration-346 spine). The ~70 PRESERVE-VENUE, ~40 PRESERVE-EVENT, and 14 PRESERVE-IN-PLACE danger tables are untouched. `email_sync_state` watermark reset; `processed_zoom_meetings`/`processed_sms_messages` wiped so Zoom/SMS re-ingest.

**2.5 — Reimport** through the unified writer: HoneyBook CSV → Calendly export → Gmail backfill (~8,183 emails, hours). Discovery-source backfill (§ N.12 — the Calendly `lead_source` self-report) runs as part of it.

**2.6 — Re-merge** the exported danger data against the new couple/wedding ids.

**Phase 2 gate:** spine sane — couples count plausible, every booked couple has a `source_wedding_id`, zero >2-people weddings, no orphan touchpoints. Re-merged danger data reconciles. Operator confirms via diagnostic SQL. Battery runner: data-integrity questions (Q29, Q30) now pass.

**Rollback (gap #8):** the persistent-branch snapshot (2.3) is the restore point. Phase 2 is days, fully reversible to pre-wipe. The export (2.2) is a second safety net for operator data.

---

## PHASE 3 — Limb-by-limb reader migration  (~6-9 weeks · range)

**Goal:** each limb reads the spine, its cross-limb imports are severed, its loop closes. One limb at a time — never two in flight.

Per-limb recipe: migrate the limb's reads legacy→spine → **triage** its cross-limb imports → finish wiring its loop (per the §0.3 assessment) → run the limb's battery subset → operator confirms → delete that limb's legacy reads.

**Cross-limb import triage (gap #4).** The anatomical pass found 20 cross-limb imports and called them all violations. They are not. The doctrine's own words — "Sage is not a surface, Sage is the brain that powers all limbs" — mean a limb *importing Sage* (Agent calling Sage to draft a reply, Intel calling Sage to narrate) is **legitimate capability invocation, not a violation.** The real violations are *peer-limb data/function coupling*: Agent→Intel (`pipeline.ts` importing `intel/inbound-intent-classifier`, `intel/asset-matcher`, `intel/knowledge-gaps`, `intel/consultant-tracking`), Sage→Intel, Portal→Intel, Intel→Email. Each limb migration triages its imports: brain-calls stay; peer-limb coupling is either severed (replaced with a spine read) or the shared function is moved to a neutral `src/lib/shared/` module. A classifier like `inbound-intent-classifier` is arguably a shared service, not "Intel" — that judgement is made per import, not by blanket rule.

**3.1 — Agent + Loop 1 (voice).** 140 legacy refs; 8 cross-limb imports — triaged: the Agent→Sage imports (`brain/router`, `brain/inquiry`, `brain/client`, `brain/ai-disclosure`) are legitimate brain-calls and stay; the Agent→Intel imports (`intel/inbound-intent-classifier`, `intel/asset-matcher`, `intel/knowledge-gaps`, `intel/consultant-tracking`) are the real coupling — sever or move to `src/lib/shared/`. Owns the draft loop (~70% of product value). Migrate `email/pipeline.ts` + `/agent/*` reads to the spine. Close Loop 1: draft → operator edit → diff (`draft_feedback`) → voice DNA → next draft. Battery: Q1-6, Q22-25.

**3.2 — Sage.** The brain powering all limbs — migrate right after Agent so Loop 1 fully closes. Migrate `brain/*` context loaders to the spine; sever the 4 Sage→Intel imports. Battery: Q17-21, Q31-32 (honesty tier).

**3.3 — Intel + the six canonical functions.** Least work — the cohort module is already spine-clean. Implement the six `INTEL-CANONICAL-API.md` functions for real (the Day-4-5 stubs go live): `getSourceAttribution` ← rename `buildCoupleAttribution`; `getCohortFunnel` ← wrap `loadCohortData`; etc. Migrate the 6-8 KEEP `/intel` surfaces onto them. Close Loop 3 (attribution — first-touch derived from the spine). Battery: Q7-16, Q26-28, Q33, Q35.

**3.4 — Portal + Loop 4 (positioning).** The Portal plans the EVENT — it migrates onto `weddings` reached via `couples.source_wedding_id`, not onto `couples` directly (D1). Sever the 5 Portal cross-limb imports. Close Loop 4 (reviews → themes → drafts). Battery: Q34.

Loops 2 (prediction) and 5 (capacity) are not battery-gated for the ship (Critical Audit: not survival-critical) — but `LOOP-ASSESSMENT.md` corrects §0.3: Loop 2 does **not** close today (calibration is read-only; Phase 3.2 must *build* the calibration→prediction feedback edge, not confirm it) and Loop 5 is **not a loop** (three unconnected parts; Phase 3.5 is a build-or-cut decision). Still lighter-touch and off the critical path — but build work, not confirmation.

**Phase 3 gate (per limb):** the limb's battery subset ≥ +1.0; its loop demonstrably closes; its legacy reads are deleted; CI guard still green.

**Rollback (gap #8):** each limb is an independent unit of work on the `consolidation` branch — a regressed limb migration reverts without touching the others. The spine is unaffected (Phase 1+2 already locked it). A limb that fails its gate is re-scoped, not forced.

---

## PHASE 4 — Delete the graveyard  (~1 week · firm)

**Goal:** remove what is now provably unreferenced.

Per the §0.2 kill list (exact counts live there, not here — gap #7): Agent D's catalog = 68 DELETE + 12 MERGE of 88 `/intel`+`/agent` pages; ~37 dead service files (after the sweep-file dynamic-dispatch cross-check); ~25 crons (repair/drift crons obsolete once the cascade is sole writer — see the cron section below); the retired legacy pipeline tables `interactions`/`attribution_events`/`wedding_touchpoints`/`people` (D6: `touchpoints.raw_payload` carries their content — verified redundant). Migration baseline flatten (365 → 1). Deletion is uneventful — every reader moved in Phase 3, so each delete removes the unreferenced.

**Phase 4 gate (the ship gate):** full 36-question battery ≥ +1.0 average, zero −3 in Tier 4, Tier 8 consistency all +2/0, Tier 9 chain ≥ +1. Multi-venue invariant re-verified (a second seeded venue reads its own data, no cross-venue leak). Clean `npm run build` + `npm run test:unit`.

**Rollback:** deletion is the one phase where rollback is just `git revert` — nothing was migrated, only removed, and Phase 3 already proved nothing reads it.

---

## Cron fate across the phases (gap #9)

47 crons. They are not all touched at once:
- **Phases 1-2:** the repair/drift crons (lifecycle-audit, suspect-merge, backtrace-scan, data-integrity sweeps) **keep running** — during the dual-write window they help hold legacy and spine consistent. The 15 direct-writing crons are migrated through the cascade in Batch 3 (§1.2).
- **Phase 3:** as each limb migrates and the dual-state for its domain disappears, that limb's repair crons lose their job — disabled (not deleted) per limb.
- **Phase 4:** the ~25 now-purposeless crons are deleted; ~12 canonical crons (`gmail_poll`, `cascade_drain`, `decay_sweep`, etc.) plus `battery_smoketest` (new) survive.

---

## Battery → phase map (gap: explicit mapping)

| Answerable after | Questions |
|---|---|
| Phase 2 gate (clean spine) | Q29, Q30 |
| Phase 3.1 (Agent + Loop 1) | Q1-6, Q22-25 |
| Phase 3.2 (Sage) | Q17-21, Q31-32 (honesty) |
| Phase 3.3 (Intel + six functions) | Q7-16, Q26-28, Q33, Q35 |
| Phase 3.4 (Portal) | Q34 |
| Out of scope | Q9 (needs operator-supplied competitor calendar) |

Q33 (adversarial consistency) passes only once every surface calls one canonical function — end of Phase 3.

---

## What carries over from Days 1-5 (not wasted)

`CONSOLIDATION-AUDIT.md` (catalogs → §0.2, §1.2, Phase 4) · `CASCADE-CANONICAL-WRITER.md` + `INTEL-CANONICAL-API.md` (the contracts, code-corrected) · `src/lib/spine/cascade.ts` + `src/lib/intel/canonical.ts` + the contract tests (in place; Phase 1 + 3.3 fill them) · `ARCHITECTURE-DECISIONS.md` + `PHASE-2-WIPE-MANIFEST.md` (foundations).

---

## Effort confidence (gap #12)

| Phase | Estimate | Confidence | Driver of the range |
|---|---|---|---|
| 0 | ~1 wk | firm | bounded build of one runner + docs |
| 1 | 4-6 wk | range | ~50 writer migrations; if coupling exceeds the audit, the high end holds |
| 2 | ~1 wk | firm | mechanical wipe + reimport from the manifest |
| 3 | 6-9 wk | range | four limbs, sequential; each re-scoped at its boundary |
| 4 | ~1 wk | firm | deletion of the provably-unreferenced |

Total **13-18 weeks**. Re-scope at every phase boundary; never compress to hit a number.

---

## Honest risks

1. **Phase 1 is the hard, invisible 4-6 weeks.** ~50 writer migrations, no visible product change. Jumping to surfaces is the failure mode.
2. **Phase 3 limb estimates are ranges.** Re-scope at each limb boundary; do not compress.
3. **The reimport depends on Phase 1 being truly complete** — one un-migrated writer reproduces the dual-state. The Phase 1 gate's per-writer shadow-compare guards this.
4. **`weddings` survives** as the event entity (D1) — anyone expecting "kill the legacy table" should read D1.
5. **The 22 DANGER tables** — Phase 2 must run from `PHASE-2-WIPE-MANIFEST.md`, never the old wipe scripts (which have two confirmed bugs).

---

## Deferred (post-consolidation)

`intel_rollups` two-tier cache, `platform_benchmarks` cross-venue, federated themes, full per-surface AI circuit-breaker, onboarding flow, billing-tier enforcement, the `fragments`/`couple_progression_events` schema collapse, Loops 2/5 to production quality. Named so they are not forgotten; not in the ~3-month critical path.
