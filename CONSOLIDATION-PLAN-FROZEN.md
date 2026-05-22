# Consolidation Plan — FROZEN (the kill list)

**Date:** 2026-05-22
**Phase:** 0.2 (per `CONSOLIDATION-PLAN-PHASED.md` §0.2 — "Generate the kill list").
**Branch:** `consolidation`. **This document is not committed by its author** — the operator/parent commits.

## What this is

The mechanical kill list for the Bloom House consolidation. It is **derived from** the Day-1 7-agent
audit (`CONSOLIDATION-AUDIT.md`) + the three architecture decisions (`ARCHITECTURE-DECISIONS.md`
D1/D2/D3) + the wipe manifest (`PHASE-2-WIPE-MANIFEST.md`). Per §0.2 this is *"bookkeeping, not a
guess"*: every item below maps to a phase —

- **Deletion budget → Phase 4** (delete the graveyard).
- **Schema / re-key list → Phase 1** (unify the write path).
- **Per-limb migration list → Phase 3** (limb-by-limb reader migration).

**Exact line-level deletion happens in Phase 4 ONLY.** Nothing here is removed now. This document is
the inventory Phase 4 executes against, after Phase 3 has proven every reader moved.

## Honesty notes on derivation (read before using this list)

The brief required a verify-then-build pass. Two things must be stated up front:

1. **The audit gives counts, not always full enumerated path lists.** Where the audit enumerates
   (services DELETE candidates, cron names, page KEEP/MERGE names) this document copies the
   enumeration. Where the audit only summarizes (e.g. "DELETE = 68 pages" with no 68-path list),
   this document **mechanically derives** the list from the repo (88 pages − 11 KEEP − MERGE) and
   marks it as derived. No path was invented to pad a count.

2. **The audit's "zero importer / dead code" service claims are partly WRONG — confirmed by
   spot-check.** See the Conflicts section. The §0.2 brief explicitly warned about this footgun
   ("11 of 15 0-importer sweep files are LIVE via dynamic dispatch in
   `src/app/api/cron/route.ts`"). The spot-check below reproduces that exact finding. The Phase 4
   service deletion list in this document is therefore **smaller and more conservative than the
   audit's 48** — it excludes every file still reachable via cron dynamic dispatch.

---

# PART 1 — Phase 4 deletion budget

Everything in Part 1 is deleted in Phase 4, after Phase 3 proves it unreferenced. Grouped by type.
Checklist lines. MERGE items are listed separately (§1.2) — they are folded, not deleted.

## 1.1 — Pages to DELETE

**Source:** Agent D catalog — 88 `page.tsx` under `/intel` + `/agent`; KEEP=11, MERGE (audit text
lists 15 names; see Conflict #3), DELETE=68. The repo confirms 88 (23 agent + 65 intel, verified).
The audit did **not** enumerate the 68 DELETE paths — the list below is **mechanically derived**:
full 88-page inventory minus the 11 KEEP minus the MERGE set. All paths verified to exist.

### KEEP — 11 pages (NOT deleted — listed for reconciliation)
- `intel/identity-review` · `intel/cohort` · `intel/source-quality` · `intel/heat`
- `intel/couples` · `intel/couples/[id]` · `intel/couples/[id]/journey`
- `intel/dashboard`
- `agent/brain-dump` · `agent/drafts` · `agent/inbox`

### DELETE — derived list (≈61 pages — see Conflict #3 for why not exactly 68)

Agent vertical:
- [ ] `agent/analytics`
- [ ] `agent/audio-inbox`  *(see Conflict #4 — CLAUDE.md documents this as the live audio surface)*
- [ ] `agent/auto-send-shadow`
- [ ] `agent/classification-health`
- [ ] `agent/codes`
- [ ] `agent/errors`
- [ ] `agent/forbidden-topics`  *(see Conflict #4 — CLAUDE.md documents this as a live config page)*
- [ ] `agent/identity-windows`  *(see Conflict #4 — CLAUDE.md documents this as a live config page)*
- [ ] `agent/knowledge-gaps`
- [ ] `agent/leads`
- [ ] `agent/learning`  *(see Conflict #4 — CLAUDE.md documents this as a live voice surface)*
- [ ] `agent/learning/recent-edits`
- [ ] `agent/notifications`
- [ ] `agent/omi-inbox`  *(superseded by `agent/audio-inbox` per CLAUDE.md — safe DELETE)*
- [ ] `agent/pipeline`
- [ ] `agent/relationships`
- [ ] `agent/rules`  *(see Conflict #4 — CLAUDE.md documents this as a live config page)*
- [ ] `agent/sequences`
- [ ] `agent/settings`  *(see Conflict #4 — CLAUDE.md documents this as a live config page)*

Intel — agency vertical (Agent D: "the entire agency vertical, 6 pages"):
- [ ] `intel/agencies`
- [ ] `intel/agencies/[id]`
- [ ] `intel/agencies/[id]/edit`
- [ ] `intel/agencies/[id]/leads`
- [ ] `intel/agencies/[id]/tbh-report`
- [ ] `intel/agencies/new`

Intel — multi-venue / portfolio / team / region surfaces:
- [ ] `intel/portfolio`
- [ ] `intel/portfolio/structure`
- [ ] `intel/team`
- [ ] `intel/regions`
- [ ] `intel/company`
- [ ] `intel/benchmark`

Intel — legacy `/intel/clients` tree (replaced by `/intel/couples`):
- [ ] `intel/clients`
- [ ] `intel/clients/[id]`
- [ ] `intel/clients/[id]/timeline`

Intel — marketing-roi sub-reports:
- [ ] `intel/marketing-roi/digest`
- [ ] `intel/marketing-roi/flags`
- [ ] `intel/marketing-roi/recommendations`
- [ ] `intel/marketing-spend`
- [ ] `intel/roi`
- [ ] `intel/reach`

Intel — reviews sub-tools:
- [ ] `intel/reviews/paste`
- [ ] `intel/reviews/solicitations`

Intel — forecast / macro / external-signal plumbing surfaces:
- [ ] `intel/forecasts`
- [ ] `intel/macro-correlations`
- [ ] `intel/external-signals`
- [ ] `intel/market-pulse`
- [ ] `intel/trends`
- [ ] `intel/cultural-moments`  *(see Conflict #4 — CLAUDE.md documents this as a live propose-confirm queue)*
- [ ] `intel/weather`
- [ ] `intel/insights/weather-tours`

Intel — diagnostic surfaces:
- [ ] `intel/data-fields`
- [ ] `intel/nlq`

Intel — other DELETE (per Agent D "legacy /intel/clients tree … all … sub-tools"):
- [ ] `intel/alumni`
- [ ] `intel/campaigns`
- [ ] `intel/capacity`
- [ ] `intel/channels/[channel_slug]`
- [ ] `intel/pricing-history`  *(see Conflict #2 — `pricing-history` has live API routes + nav entry; verify the PAGE specifically)*
- [ ] `intel/reengagement`
- [ ] `intel/referrals`
- [ ] `intel/social-integration`
- [ ] `intel/sources/track`
- [ ] `intel/tours`  *(verify against the new couple-keyed `tours` surface — Phase 1 §1.4 adds a couple-keyed tours table; a tours UI may be re-needed)*

> **Enumeration gap (honest):** the audit summary says DELETE=68 but the repo, after subtracting
> 11 KEEP and the 15-name MERGE set, leaves ~62 pages — and several of those 62 are flagged in
> Conflict #4 as KEEP-per-CLAUDE.md. The 68 number is not reconcilable from the audit text alone.
> **A mechanical extraction pass against `src/app` at the start of Phase 4 must produce the final
> exact DELETE list** — this document gives the derived candidate set + every conflict to resolve
> first. Do not delete the Conflict-#4 pages until the operator rules on them.

## 1.2 — Pages to MERGE (folded, NOT deleted — for Phase 3, surfaced in Phase 4)

**Source:** Agent D. The audit text says "MERGE (12)" then lists **15** names — Conflict #3. These
fold into the KEEP set or the dashboard insights strip. They are not in the deletion budget; they
are consumed during Phase 3 reader migration and their now-empty route shells are removed in Phase 4.

- [ ] `intel/anomalies` → dashboard insights strip
- [ ] `intel/attribution` → `intel/source-quality`
- [ ] `intel/candidates` → `intel/identity-review`
- [ ] `intel/channels` → `intel/source-quality`
- [ ] `intel/channel-truth` → `intel/source-quality`
- [ ] `intel/channels/[channel_slug]` *(audit "channels-by-slug duplicate")* → `intel/source-quality`
- [ ] `intel/discoveries` → dashboard insights strip
- [ ] `intel/health` → dashboard insights strip
- [ ] `intel/insights` → dashboard insights strip
- [ ] `intel/lost-deals` → `intel/cohort`
- [ ] `intel/marketing-roi` → `intel/source-quality`
- [ ] `intel/matches` → `intel/identity-review`
- [ ] `intel/matching` → `intel/identity-review`
- [ ] `intel/reviews` → KEEP-set fold (reviews overview)
- [ ] `intel/sources` → `intel/source-quality`

> Note: `intel/channels/[channel_slug]` appears in BOTH the §1.1 DELETE derived list and here — the
> audit names "channels-by-slug duplicate" under MERGE. Treat as MERGE (fold), not hard delete.
> Flagged as Conflict #3a.

## 1.3 — Services to DELETE

**Source:** Agent E (164 files: KEEP=110, MERGE=6, DELETE=48) + the §0.2-mandated dynamic-dispatch
cross-check against `src/app/api/cron/route.ts`. The repo today has **169** files
(80 intel + 14 brain + 75 identity) — grown slightly since the audit.

**THE CROSS-CHECK CHANGED THIS LIST.** The audit listed ~33 files as "clear DELETE candidates (zero
importers, dead code)". A spot-check (see Conflicts) found that claim **false for at least 13 of
them** — they are LIVE via dynamic `await import()` inside cron `case` handlers in
`src/app/api/cron/route.ts`. Those are NOT deleted in Phase 4; they are dead-cron candidates whose
fate is decided in §3 cron handling. The list below is the **verified-dead** subset only.

### DELETE — verified zero real importers (safe Phase 4 delete)

Confirmed by `grep -rl "services/<path>'"` returning 0 import sites:

- [ ] `src/lib/services/intel/tour-weather.ts` — 0 `from` importers (verified)
- [ ] `src/lib/services/intel/intelligence-engine-narration.ts` — 0 importers (verified)
- [ ] `src/lib/services/intel/referenced-couple-resolver.ts` — 0 importers (verified)
- [ ] `src/lib/services/intel/discovery/discovery-digest.ts` — 0 importers (verified)
- [ ] `src/lib/services/brain/cancellation-classifier.ts` — 0 importers (verified)
- [ ] `src/lib/services/brain/physical-presence-guard.ts` — 0 importers (verified)
- [ ] `src/lib/services/identity/candidate-ai-adjudicator.ts` — 0 importers (verified; audit: superseded by llm-judge)
- [ ] `src/lib/services/identity/capture-identifier.ts` — 0 importers (verified)
- [ ] `src/lib/services/identity/match-eligibility.ts` — 0 importers (verified)
- [ ] `src/lib/services/identity/touchpoints-writer.ts` — 0 importers (verified)
- [ ] `src/lib/services/identity/windows.ts` — 0 importers (verified; audit: superseded by windows-constants)

### DELETE — audit-named, NOT yet repo-verified by this pass (verify at Phase 4 start)

The audit named these as DELETE but this Phase-0.2 pass did not individually grep each one. They
must be re-verified in the Phase 4 mechanical pass before deletion:

- [ ] `src/lib/services/identity/auto-merge-duplicates.ts` — ⚠ has 1 importer = `cron/route.ts` (dynamic dispatch). NOT a safe delete — see Conflict #1.
- [ ] `src/lib/services/identity/binder-cron.ts` — ⚠ has 1 importer = `cron/route.ts`. NOT a safe delete — see Conflict #1.
- [ ] `src/lib/services/intel/digest-dispatch.ts` — ⚠ imported by `intel/daily-digest.ts:918`. NOT dead — see Conflict #1.
- [ ] `src/lib/services/intel/cohort-damping-refresh.ts` — ⚠ dynamic-dispatched at `cron/route.ts:1261`. NOT dead — see Conflict #1.
- [ ] `src/lib/services/intel/couple-intel-sweep.ts` — ⚠ dynamic-dispatched at `cron/route.ts:1046`. NOT dead — see Conflict #1.
- [ ] `src/lib/services/intel/cohort-rollup-sweep.ts` — ⚠ dynamic-dispatched at `cron/route.ts:1054`. NOT dead — see Conflict #1.
- [ ] `src/lib/services/intel/external-match-sweep.ts` — ⚠ dynamic-dispatched at `cron/route.ts:1080`. NOT dead — see Conflict #1.
- [ ] `src/lib/services/intel/alumni/sweep.ts` — ⚠ dynamic-dispatched at `cron/route.ts:1184`. NOT dead — see Conflict #1.
- [ ] `src/lib/services/intel/onboarding/sweep.ts` — ⚠ dynamic-dispatched at `cron/route.ts:1104`. NOT dead — see Conflict #1.
- [ ] `src/lib/services/intel/referrals/sweep.ts` — ⚠ dynamic-dispatched at `cron/route.ts:1177`. NOT dead — see Conflict #1.
- [ ] `src/lib/services/intel/discovery/sweep.ts` — ⚠ dynamic-dispatched at `cron/route.ts:1097`. NOT dead — see Conflict #1.
- [ ] `src/lib/services/intel/validation/sweep.ts` — ⚠ dynamic-dispatched at `cron/route.ts:1119`. NOT dead — see Conflict #1.
- [ ] `src/lib/services/intel/inbound-haiku-drain.ts` — ⚠ dynamic-dispatched at `cron/route.ts:1213`. NOT dead — see Conflict #1.
- [ ] `src/lib/services/intel/inbound-intent-drain.ts` — ⚠ dynamic-dispatched at `cron/route.ts:1223`. NOT dead — see Conflict #1.
- [ ] `src/lib/services/intel/inbound-haiku-classifier.ts` — 3 importers in repo; audit says replaced by mig 329. Verify the 3 are dead paths before delete.
- [ ] `src/lib/services/intel/friction-score.ts` — 0 `from`-import sites in spot-check; audit-named. Likely safe — verify.
- [ ] `src/lib/services/intel/pricing-history.ts` — ❌ NOT a delete. 6+ live importers incl. API routes + `nav-config.ts`. See Conflict #2. REMOVE from any delete list.
- [ ] `src/lib/services/identity/cascade-on-enrichment.ts` — ❌ 4 importers incl. `api/brain-dump/route.ts`. NOT dead. REMOVE from any delete list. See Conflict #2.
- [ ] `src/lib/services/identity/resolver-helpers.ts` — ⚠ 1 importer = `email/pipeline.ts`. NOT dead. See Conflict #2.

### DELETE — the spine-doctrine retirements (audit-named, deletion-fate clear)

- [ ] `src/lib/services/identity/mirror-couple.ts` — Agent B "DELETE-AFTER-DAY-13": Phase-A dual-write mirror; after the cascade is canonical it has nothing to mirror. Delete in Phase 4. (Currently imported — do not delete before Phase 1 cascade promotion.)
- [ ] `src/lib/services/identity/mint-couple.ts` — ⚠ imported by `src/lib/spine/cascade.ts`. Audit says "T8.1b unwired". CONFLICT: it IS wired into the cascade. See Conflict #2. Do NOT delete — likely a KEEP.
- [ ] `src/lib/services/identity/mint-person.ts` — ⚠ imported by `src/lib/spine/cascade.ts`. Audit says "chokepoint never adopted". CONFLICT: it IS imported by the cascade. See Conflict #2. Do NOT delete — likely a KEEP.

> **HONEST GAP — services list is NOT clean.** The audit's "~48 DELETE / ~37 after cross-check"
> cannot be reduced to a trustworthy enumerated path list from the audit text. This pass verified
> 11 files as truly dead and found ~5 audit-named "DELETE" files that are demonstrably LIVE. The
> remaining ~26 audit-named files are dynamic-dispatch-suspect and must each be individually
> grepped at the Phase 4 start against BOTH static imports AND the cron-route `case` table. The
> "~37 dead service files" figure in `CONSOLIDATION-PLAN-PHASED.md` §4 is **not yet substantiated
> at path level** and should be treated as an upper bound, not a budget.

## 1.4 — Crons to DELETE

**Source:** Agent F (47 crons in `vercel.json` — verified, 47 `"path"` entries; KEEP=11/13,
MERGE=11, DELETE=25). All 25 names below are enumerated in the audit. These are deleted from
`vercel.json` in Phase 4 (per the cron-fate section: repair/drift crons keep running through
Phases 1-3, deleted only in Phase 4).

- [ ] `anomaly_detection`
- [ ] `attribution_refresh`
- [ ] `essentials_suggest`
- [ ] `inbox_filter_learning`
- [ ] `venue_health_compute`
- [ ] `quality_signals_refresh`
- [ ] `correlation_analysis`
- [ ] `backtrace_scan`
- [ ] `phase_b_sweep`
- [ ] `identity_backtrack`
- [ ] `re_engagement_attribution`
- [ ] `cost_ceiling_check`
- [ ] `cost_ceiling_reset`
- [ ] `recompute_pending_temporal`
- [ ] `replay-paused-skipped`
- [ ] `outcome_measurement`
- [ ] `post_event_feedback_check`
- [ ] `compute_attribution_parity`
- [ ] `merge_people_aliases`
- [ ] `booked_data_recovery`
- [ ] `agency_activity_sweep`
- [ ] `tbh_reports_monthly`

> **Enumeration gap (honest):** the audit says DELETE=25 but lists only **22** names. The 3
> missing names are not in the audit text. The Phase 4 cron pass must diff `vercel.json` (47) −
> KEEP (13) − MERGE (11) = 23 deletable, reconcile against the 22 named, and resolve the
> remainder. Flagged as Conflict #5.

**Crons to MERGE (folded into umbrella crons — NOT deleted, listed for completeness, 11):**
`trends_refresh`, `weekly_briefing`, `monthly_briefing`, `cultural_moments_auto_propose`,
`cultural_moments_llm_propose`, `census_refresh`, `transcript_voice_mining`,
`external_calendar_refresh`, `weather_history_refresh`, `prune_expired_pulse_snoozes`,
`agency_document_orphans` → fold into `external_context_refresh` / `digest` / `voice_dna_refresh` /
`prune_maintenance`.

**Crons that SURVIVE (KEEP, 13):** `email_poll`, `heat_decay`, `daily_digest`,
`follow_up_sequences`, `weather_forecast`, `fred_daily_refresh`, `data_integrity_sweep`,
`voice_dna_refresh`, `identity_judge_sweep`, `prune_maintenance`, `openphone_poll`,
`google_places_reviews_refresh`, `tour_outcome_classifier` — plus 5 to ADD in Phase 1/Phase 4
(`cascade_drain`, `post_wedding_sweep`, `couple_intel_sweep`, `cohort_rollup_sweep`,
`battery_smoketest`). The ADD list is Phase-1/Phase-3 work, not deletion budget — noted here so
the dynamic-dispatch services behind `couple_intel_sweep` / `cohort_rollup_sweep` are NOT deleted.

## 1.5 — Legacy tables to DELETE (retired in Phase 4)

**Source:** ARCHITECTURE-DECISIONS D1 + §1.4 of the phased plan + Agent C ("`touchpoints.raw_payload`
carries their content — verified redundant"). All four verified to have a `CREATE TABLE` in
`supabase/migrations/`.

- [ ] `interactions` — created `supabase/migrations/002_agent_tables.sql`. Legacy pipeline table; `touchpoints.raw_payload` carries email-body content. Delete after Phase 3 proves no limb reads it.
- [ ] `attribution_events` — created `supabase/migrations/105_candidate_identities.sql`. Legacy attribution; KEEP `/intel` surfaces already read `touchpoints`/`couples` (Agent C). Delete after Phase 3.
- [ ] `wedding_touchpoints` — created `supabase/migrations/079_wedding_touchpoints.sql`. Legacy touchpoint table superseded by spine `touchpoints`. Delete after Phase 3.
- [ ] `people` — created `supabase/migrations/001_shared_tables.sql`. **No 1:1 successor** — see §2.2 for the mapping. Delete after Phase 3 + after the `people`→`couples`/`agents` migration.

> `weddings` is NOT in this list. Per D1 it is the EVENT entity and survives permanently. Anyone
> expecting "kill the legacy table" must read `ARCHITECTURE-DECISIONS.md` D1.

**Also in Phase 4:** migration baseline flatten (365 → 1) per `CONSOLIDATION-PLAN-PHASED.md` §4.

---

# PART 2 — Phase 1 schema / re-key list

**Source:** `ARCHITECTURE-DECISIONS.md` D1 + `CONSOLIDATION-PLAN-PHASED.md` §1.4 (the drift
correction).

## 2.1 — THERE IS NO ALTER-RE-KEY

§1.4 drift correction, verified against migration 346: `couples` and `touchpoints` are **already
`couple_id`-keyed**. `touchpoints.raw_payload` (jsonb) already carries signal content including
email bodies. **No Phase 1 ALTER renames a column.** A hard re-key would break every still-legacy
reader. The legacy `interactions` / `attribution_events` / `wedding_touchpoints` / `people` stay
`wedding_id`-keyed, dual-written through Phases 1-2, and are deleted in Phase 4 (§1.5). The
"migration" is each limb *switching which table it reads* — that is Phase 3, not a column swap.

## 2.2 — Additive schema work (Phase 1, additive ONLY — never an ALTER that breaks a reader)

- [ ] **Couple-keyed `tours` table.** A tour happens *before* booking — the couple may have no
  wedding yet — so `tours` cannot be `wedding_id`-keyed. The current migration-009 wedding-keyed
  `tours` is wrong for pre-booking tours. Write an additive couple-keyed `tours` schema in Phase 1;
  the Phase 2 reimport rebuilds it from Calendly.
- [ ] **Identity-evidence columns** if needed by the cascade (per `CASCADE-CANONICAL-WRITER.md`) —
  additive only.

## 2.3 — `people` → successor mapping (no re-key — a successor)

`people` dies; it has no 1:1 successor.
- [ ] The **two partner contacts** → `couples` columns (`primary_contact_*`, `partner_contact_*`).
- [ ] **MOB / FOB / planner / wedding-party** (people acting on a couple's behalf) → `agents`
  (couples with `lifecycle_state='agent'`, linked via `agent_couple_links`).
- [ ] **Incidental others** → dropped.
- [ ] Legacy `people` table itself → deleted in Phase 4 (§1.5).

## 2.4 — The ~50 MIGRATE writers, in 4 batches

**Source:** Agent A — 138 legacy writer call sites: 36 already cascade-routed; of the other 102,
~40 KEEP-AS-IS (lifecycle/heat/metadata UPDATEs), 8 `cleanup-ghost-weddings` sites DELETE
(constitution-violating), 4 couple-pages KEEP, **~50 MIGRATE**. Sequenced highest-volume-first.

- [ ] **Batch 1 — email pipeline.** `src/lib/services/email/pipeline.ts` lines **2211 / 2907 / 3062**
  (the Liam Hunt partner2 sites — confirmed by Agent A) + the other `pipeline.ts` writers.
- [ ] **Batch 2 — ingestion adapters.** Calendly webhook (`src/app/api/webhooks/calendly/route.ts:413`),
  HoneyBook CRM import (`src/lib/services/crm-import/index.ts`, 5 sites), Twilio/SMS (2 sites),
  Zoom, OpenPhone.
- [ ] **Batch 3 — the 15 direct-writing crons** (Agent F): `email_poll`, `follow_up_sequences`,
  `backtrace_scan`, `zoom_poll`, `openphone_poll`, `phase_b_sweep`, `identity_backtrack`,
  `re_engagement_attribution`, `recompute_pending_temporal`, `merge_people_aliases`,
  `tour_outcome_classifier`, `booked_data_recovery`, `compute_attribution_parity`,
  `replay-paused-skipped`, `google_places_reviews_refresh` — route each through the cascade.
- [ ] **Batch 4 — long-tail.** `reprocess-orphans` (5 sites), brain-dump imports (3 sites),
  data-integrity remediations.

**Also Phase 1, NOT a writer-migration but a deletion:**
- [ ] The **8 `cleanup-ghost-weddings` writer sites** — DELETE per the constitution-violation
  finding (it DELETEs weddings). Agent A.

## 2.5 — Phase 1 schema-adjacent CI / RLS work (from Agent G)

- [ ] Patch the 2 PII RLS-OFF tables: `notifications` (mig 017), `wedding_timeline` (mig 017).
- [ ] Audit/resolve the 13 RLS-enabled-no-policy tables — esp. `tours` (default-deny is suspicious;
  coordinator UI almost certainly reads it). `rate_limits` is intentional service-role-only.
- [ ] Also RLS-OFF, lower risk: `cohort_damping_cache` (mig 319), `mint_wedding_telemetry` (mig 320).
- [ ] CI guards: `scripts/check-cascade-only-writer.mjs`, `scripts/check-rls-on-venue-id.mjs`.

---

# PART 3 — Phase 3 per-limb migration list

**Source:** Agent A/C anatomical numbers + `CONSOLIDATION-PLAN-PHASED.md` §3 + the cross-limb
import triage rule.

**Triage rule (gap #4):** the anatomical pass found 20 cross-limb imports. NOT all are violations.
A limb importing **Sage** (the brain) = legitimate capability invocation, **STAYS**. Real
violations = peer-limb data/function coupling — **SEVER** (replace with a spine read) or **MOVE**
the shared function to a neutral `src/lib/shared/` module.

## 3.1 — Agent + Loop 1 (voice) — 140 legacy refs

- [ ] Migrate `src/lib/services/email/pipeline.ts` + all `/agent/*` reads from legacy → spine.
- [ ] **8 cross-limb imports — triaged:**
  - STAY (brain-calls): `brain/router`, `brain/inquiry`, `brain/client`, `brain/ai-disclosure`.
  - SEVER / MOVE-to-`shared/` (peer-limb coupling): `intel/inbound-intent-classifier`,
    `intel/asset-matcher`, `intel/knowledge-gaps`, `intel/consultant-tracking`.
- [ ] Close Loop 1: draft → operator edit → diff (`draft_feedback`) → voice DNA → next draft.
- [ ] Battery subset: Q1-6, Q22-25. Gate ≥ +1.0. Then delete Agent's legacy reads.

## 3.2 — Sage — 30 legacy refs

- [ ] Migrate `brain/*` context loaders from legacy → spine.
- [ ] **Sever the 4 Sage→Intel imports** (peer-limb coupling).
- [ ] Battery subset: Q17-21, Q31-32 (honesty tier). Gate ≥ +1.0. Then delete Sage's legacy reads.

## 3.3 — Intel + the six canonical functions — 167 legacy refs

- [ ] Least *rewrite* work — Agent C: the cohort module is already spine-clean; KEEP `/intel`
  surfaces (`cohort`, `heat`, `source-quality`, `identity-review`) already read `touchpoints` /
  `couples`. Read-migration is mostly **renaming**, not rewriting.
- [ ] Implement the six `INTEL-CANONICAL-API.md` functions for real (Day-4-5 stubs go live):
  `getSourceAttribution` ← rename `buildCoupleAttribution` + add opts (NOT a from-scratch build —
  Agent C); `getCohortFunnel` ← wrap `loadCohortData`; etc.
- [ ] Add the small UI piece to expose `touchpoints.cascade_stage` / `cascade_reason` (zero readers
  today — Agent C) for Q5 model-transparency.
- [ ] Migrate the 6-8 KEEP `/intel` surfaces onto the canonical functions.
- [ ] Triage Intel→Email coupling.
- [ ] Close Loop 3 (attribution, first-touch derived from the spine).
- [ ] Battery subset: Q7-16, Q26-28, Q33, Q35. Gate ≥ +1.0. Then delete Intel's legacy reads.

## 3.4 — Portal + Loop 4 (positioning) — 38 legacy refs

- [ ] Portal plans the EVENT — migrate onto `weddings` reached via `couples.source_wedding_id`
  (D1), **not** onto `couples` directly.
- [ ] **Sever the 5 Portal→Intel cross-limb imports.**
- [ ] Close Loop 4 (reviews → themes → drafts).
- [ ] Battery subset: Q34. Gate ≥ +1.0. Then delete Portal's legacy reads.

> Loops 2 (prediction) and 5 (capacity): confirmed/finished lighter-touch with their limbs, not
> battery-gated for the ship.

---

# PART 4 — Conflicts / unresolved (FOR OPERATOR REVIEW)

The §0.2 cross-check rule: DELETE lists must be reconciled against KEEP lists / dynamic-dispatch
before anything goes in the kill list. Every unresolved conflict found by this pass:

### Conflict #1 — Audit's "zero importer, dead code" service list is WRONG for ~13 files (dynamic dispatch)

**This is the exact footgun §0.2 warned about.** The audit (§E, "Clear DELETE candidates (zero
importers, dead code)") names a ~33-file list. A spot-check via
`grep -rl "services/<path>'" src` found **every one of these is referenced from
`src/app/api/cron/route.ts`** as a dynamically-`await import()`ed `case` handler — i.e. LIVE, not
dead:

| Audit-named "dead" service | Real importer (verified line) |
|---|---|
| `intel/alumni/sweep` | `cron/route.ts:1184` (`case 'alumni_sweep'`) |
| `intel/cohort-rollup-sweep` | `cron/route.ts:1054` (`case 'cohort_rollup_sweep'`) |
| `intel/external-match-sweep` | `cron/route.ts:1080` (`case 'external_match_sweep'`) |
| `intel/onboarding/sweep` | `cron/route.ts:1104` (`case … runVenueThesisSweep`) |
| `intel/referrals/sweep` | `cron/route.ts:1177` |
| `intel/discovery/sweep` | `cron/route.ts:1097` (`case 'discovery_engine_sweep'`) |
| `intel/validation/sweep` | `cron/route.ts:1119` |
| `intel/inbound-haiku-drain` | `cron/route.ts:1213` |
| `intel/inbound-intent-drain` | `cron/route.ts:1223` |
| `intel/cohort-damping-refresh` | `cron/route.ts:1261` |
| `intel/couple-intel-sweep` | `cron/route.ts:1046` |
| `intel/digest-dispatch` | `intel/daily-digest.ts:918` (static dynamic import) |
| `identity/auto-merge-duplicates` | `cron/route.ts:1276` |
| `identity/binder-cron` | `cron/route.ts:1248` |

**Why the audit got it wrong:** a plain "find references" of a basename misses
`await import('@/lib/services/…')` string-literal dynamic imports. **Resolution needed:** these are
not dead *code*; some may be dead *crons* (handler exists, cron not registered in `vercel.json` —
e.g. `couple_intel_sweep` / `cohort_rollup_sweep` are in the audit's "missing crons" list, meaning
the handler is unregistered). The operator must decide per file: (a) the cron is being ADDED in
Phase 1 (`couple_intel_sweep`, `cohort_rollup_sweep` per §1.4) → service is KEEP; (b) the cron is
in the Phase-4 DELETE list → service dies *with the cron, in Phase 4, after the case handler is
also removed*. **Do NOT delete any of these as "dead code" in isolation.**

### Conflict #2 — Audit-named DELETE services that are demonstrably LIVE

- `intel/pricing-history.ts` — audit implies DELETE; repo shows live importers:
  `api/intel/pricing-history/[id]/route.ts`, `api/onboarding/pricing-history/route.ts`,
  `components/shell/nav-config.ts`, `brain-dump/help.ts`, `crm-import/web-form-packages.ts`,
  `onboarding/project.ts`. **`pricing-history` is a live feature.** Remove from any delete list.
- `identity/cascade-on-enrichment.ts` — audit lists as DELETE; repo shows **4 importers** incl.
  `api/brain-dump/route.ts`. LIVE. Remove from delete list.
- `identity/resolver-helpers.ts` — audit lists as DELETE; imported by `email/pipeline.ts`. LIVE.
- `identity/mint-couple.ts` — audit says "T8.1b unwired"; repo shows it imported by
  `src/lib/spine/cascade.ts`. **It IS wired into the canonical cascade.** Likely KEEP — operator
  must confirm whether the cascade path that imports it is the live one.
- `identity/mint-person.ts` — audit says "chokepoint never adopted"; repo shows it imported by
  `src/lib/spine/cascade.ts`. Same as above — likely KEEP.

**Resolution needed:** the audit's service DELETE enumeration cannot be trusted at face value.
Phase 4 must individually grep every audit-named DELETE file against (a) static imports and (b) the
`cron/route.ts` case table before removing it.

### Conflict #3 — Page MERGE count: audit says "12", lists 15

Agent D's text: *"MERGE (12)"* — then the sentence enumerates **15** names (anomalies, attribution,
candidates, channels, channel-truth, channels-by-slug duplicate, discoveries, health, insights,
lost-deals, marketing-roi, matches, matching, reviews, sources). The "12" and the 15-item list do
not reconcile. Consequence: if MERGE is 15, DELETE is ~61 not 68; if MERGE is 12, three of those
15 names are actually DELETE. **Resolution needed:** operator confirms the MERGE set; the DELETE
page list (§1.1) is derived from it and currently assumes the 15-name reading.

**Conflict #3a:** `intel/channels/[channel_slug]` appears in the audit's MERGE list ("channels-by-slug
duplicate") AND is a candidate in the derived DELETE list. Treat as MERGE.

### Conflict #4 — Agent D DELETE vs CLAUDE.md "Coordinator surfaces" KEEP list

Agent D's DELETE summary sweeps in "settings surfaces wrongly placed under /agent" and "all
diagnostic surfaces". But `CLAUDE.md` explicitly documents these as **live coordinator surfaces**:
- `agent/learning` — "Teach voice"
- `agent/rules` — "Always / Never rules"
- `agent/settings` — "Auto-send + follow-ups"
- `agent/forbidden-topics` — "per-venue forbidden topic keywords (T1-J / B-21)"
- `agent/identity-windows` — "per-platform decay windows (T2-D)"
- `agent/audio-inbox` — "orphan transcripts from any audio-capture provider (T2-E)"
- `intel/cultural-moments` — "propose-and-confirm queue (T2-C)"

Agent D's plan-correction says the sidebar collapses to 5 entries and "the 8 KEEPs are accessed via
Dashboard cards + Couples sub-routes" — which implies these config pages are folded, not deleted,
OR their function moves into Settings. **Resolution needed:** the operator must rule whether each
of these 7 CLAUDE.md-documented surfaces is DELETE, MERGE-into-Settings, or KEEP. This document
flags them inline in §1.1 with *(see Conflict #4)* and they must NOT be deleted until ruled on.

### Conflict #5 — Cron DELETE count: audit says "25", lists 22

Agent F text: *"DELETE (25)"* — the enumerated list has **22** names. `vercel.json` has 47 entries;
47 − 13 KEEP − 11 MERGE = 23 deletable. Neither 22 nor 23 equals 25. **Resolution needed:** the
Phase 4 cron pass must mechanically diff `vercel.json` against the KEEP+MERGE sets and reconcile
the exact DELETE set. §1.4 lists the 22 named; the remaining ~1 is unidentified.

### Conflict #6 — Service file count drift: audit 164, repo 169

Audit (§E) counted 164 files (80 intel + 14 brain + 75 identity). The repo today has **169**
(80 + 14 + 75 = 169 — the identity dir grew, or the audit's 70 was approximate). Minor; noted so the
Phase 4 pass re-inventories rather than trusting 164.

---

# Honest gaps summary

1. **Page DELETE list is DERIVED, not audit-enumerated.** The audit gave "68 DELETE" as a count
   only. §1.1 derives ~61-62 candidate paths (88 − 11 KEEP − 15 MERGE) and the count does not
   reconcile to 68 (Conflict #3). A mechanical `src/app` extraction pass at Phase 4 start is
   required for the final exact list.
2. **Service DELETE list is NOT clean.** Only 11 files are verified-dead by this pass. ~14 audit-
   named "dead" files are proven LIVE via dynamic dispatch (Conflict #1); ~5 more are proven LIVE
   via static imports (Conflict #2). The "~37 dead services" Phase-4 figure is an unsubstantiated
   upper bound.
3. **Cron DELETE count does not reconcile** (Conflict #5) — 22 named vs 25 claimed vs 23 derivable.
4. **CLAUDE.md vs Agent D conflict unresolved** (Conflict #4) — 7 documented coordinator surfaces
   sit in the DELETE summary; operator must rule.
5. The audit's writer counts (138 legacy / 35 spine / 78 attribution-reader) are call-site counts,
   not file lists — §2.4 reproduces the audit's batch grouping but the per-site enumeration for
   Batches 2-4 is partial in the audit and must be expanded at Phase 1 start.

**Bottom line:** this document is accurate about *what the audit claims* and *where the audit is
wrong*. It is a faithful frozen kill list with every conflict surfaced — but the page DELETE list
and the service DELETE list both still need a mechanical repo-extraction pass (at the start of
Phase 4 and Phase 1 respectively) before any file is removed. Per §0.2 that is acceptable: this is
the bookkeeping that *routes* items to phases; the exact line-level deletion is Phase 4's job and
must re-verify.
