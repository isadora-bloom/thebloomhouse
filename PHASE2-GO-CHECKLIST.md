# Phase 2 — Go Checklist (wipe + reimport)

**Created 2026-06-11** (plan stress-test follow-up). Authority: `CONSOLIDATION-PLAN-PHASED.md` v2.1 §2 + `PHASE-2-WIPE-MANIFEST.md`. Tooling: `scripts/phase2-export-danger.mjs` + `scripts/phase2-wipe.mjs` (both built 2026-06-11; the old wipe scripts are RETIRED — both manifest bugs are fixed in the new one).

Every box is sequential. Stop at any ⚠ that fails.

## A. Preconditions (before anything destructive)

- [ ] **Phase 1 gate green** (PHASED v2.1): CI fully green on `consolidation` incl. the now-enforcing governance gates; writer scope complete (verified 2026-06-11 — all reimport sources cascade-routed); §1.8 D4/D5 shipped.
- [ ] **Migrations 380 + 381 applied** to BOTH prod (`jsxxgwprxuqgcauzlxcb`) and the test branch (`ciwqxxohczzthvzqqgjx` — check ref) via the dashboard SQL editor. 380 = decay 120 (clamps existing 180 rows). 381 = point_zero + zero_phase/direction. **The reimport stamps these at write time — wiping before applying them defeats §1.8.**
- [ ] **Re-verify "live for nobody" (D-1)** — last verified 2026-05-29, and the wipe's safety rests on it: run `scripts/verify-nobody-live.sql` in the SQL editor. Any non-operator session or recent portal write → STOP, the plan changes.
- [ ] **Dry-run the wipe on the TEST BRANCH first**: point `.env.local` at the branch, `node scripts/phase2-wipe.mjs` (dry-run), review counts, then `--apply` on the branch and run a smoke reimport there if time allows.
- [ ] **Snapshot prod** to a fresh persistent Supabase branch (the §2.3 restore point). Name it `pre-phase2-<date>`.
- [ ] **HoneyBook CSV export downloaded fresh** (the reimport's first source).
- [ ] Gmail connection healthy (`gmail_connections` row valid — backfill re-runs through it, ~8,183 emails, hours).

## B. Export (same day as the wipe)

- [ ] `node scripts/phase2-export-danger.mjs` against PROD — exports the 8 EXPORT-AND-REMERGE tables + FULL `weddings` + `people` rows to `phase2-exports/` (gitignored). Exit 0 required.
- [ ] Copy `phase2-exports/` somewhere off-machine (it is the only copy of operator decisions once the wipe runs).
- [ ] The wipe script refuses `--apply` without a fresh (<48h) export manifest — do not use `--skip-export-check`.

## C. Wipe

- [ ] `node scripts/phase2-wipe.mjs` (dry-run) against prod — review the counts. ⚠ If ANY event table shows rows, D-3 ("portal has NO data") is stale — STOP and re-decide.
- [ ] `node scripts/phase2-wipe.mjs --apply --allow-prod` — watch the post-wipe verification print `✓ every wiped table is empty`.

## D. Reimport — ORDER MATTERS

> ⚠ **The Calendly replay reads `weddings.calendly_qa` (replayCalendlyFromQa), which the wipe just emptied.** The payloads survive ONLY in `phase2-exports/weddings.json`. HoneyBook must rebuild the booked weddings first, then calendly_qa re-merges onto the NEW wedding ids (matched by couple email via `phase2-exports/people.json`), and only THEN does the Calendly replay run.

- [ ] 1. **HoneyBook CSV import** (the `/agent` import surface, "Check before import" → Commit). Fires `linkSignalBatch` per row — couples + weddings rebuild through the one writer.
- [ ] 2. **Re-merge `calendly_qa`** (+ `owner_note`, `owner_photo`, manual `lead_source`) from `phase2-exports/weddings.json` onto the new wedding rows, keyed by couple email from `people.json`. (Small re-merge script — write at execution time against the actual new ids; spec in PHASE-2-WIPE-MANIFEST.md §C.)
- [ ] 3. **Calendly replay**: `replayCalendlyFromQa` (identity/replay) — re-fires every stored invitee payload through linkSignal.
- [ ] 4. **Gmail backfill**: reset is automatic (`email_sync_state` wiped) — the `email_poll` cron drains the full backfill (~hours). Monitor `/system/consolidation-status` + `tracer_run_events`.
- [ ] 5. **Zoom / SMS / OpenPhone** re-ingest automatically (dedup ledgers wiped; crons re-pull their windows).
- [ ] 6. **Knot visitor-activity CSV** re-upload (operator) + matcher sweep.
- [ ] 7. **Re-merge the remaining DANGER exports** against new couple/wedding ids: draft_feedback (the voice-training corpus — highest value), evidence_overrides, identity_decision_clusters, candidate_matches resolutions (matcher-calibration corpus), re_engagement_actions edited rows. couple_merge_events manual rows + person_merges are AUDIT references — keep as exports, do not force-replay.

## E. Phase 2 gate (PHASED v2.1 §2)

- [ ] Spine sane: couples count plausible; every booked couple has `source_wedding_id`; zero >2-people weddings; no orphan touchpoints.
- [ ] **D4/D5 by construction**: spot-check that reimported couples carry `point_zero_at` + touchpoints carry `zero_phase`/`direction` (this is what §1.8 bought).
- [ ] Re-merged danger data reconciles (draft_feedback rows re-attached; spot-check 5).
- [ ] Operator diagnostic SQL pass + battery run: Q29/Q30 (data-integrity tier) now pass. `npx tsx scripts/run-battery.ts f3d10226-4c5c-47ad-b89b-98ad63842492` (~$3.6, ~9min — ⚠ reads `.env.local`; confirm it points at the DB you mean).
- [ ] Full golden on the test branch: `npm run test:golden` (15/15 + GC-8/GC-9 runtime assertions now un-pendable).
- [ ] Merge `consolidation` → `master` per the phase-boundary rule.

## Rollback

The §2.3 snapshot branch is the restore point — Phase 2 is fully reversible to pre-wipe. `phase2-exports/` is the second net for operator data.
