# Remediation Plan — 2026-07-07 audit follow-up

> Status: ACTIVE checklist overlay. Subordinate to CONSOLIDATION-PLAN-PHASED.md v2.1,
> which remains the plan of record. This doc sequences the fixes from the 2026-07-07
> five-persona audit (engineer / CEO / group analyst / single-venue client / investor)
> in the order they unblock downstream work. Phases R1 and R3 are the phased plan's
> own Phases 2 and 3; the rest is remediation found by the audit.
>
> Dependency spine: R0 unblocks deploys → R1 unblocks trustworthy data →
> R2 unblocks trustworthy gates → R3 unblocks legacy deletion → R4 unblocks a team →
> R5 unblocks a customer → R6 unblocks the raise.
>
> MODEL PER PHASE (check `/model` at session start): Fable for anything that decides,
> Opus 4.8 for anything that executes. Each phase header below carries its model.

## Phase R0 — Restore deploy and doc truth (today, ~2h) — MODEL: Opus 4.8

Prod is missing the Knot fix. `consolidation` is 13 commits ahead of master, unpushed.

- [x] Push `consolidation` (13 commits) to origin
- [x] Fast-forward `master` to the `consolidation` head and push
- [x] Confirm Vercel prod redeploys; verify Knot fix `68b4277` live (per-prospect relay mints a wedding)
- [x] Re-run battery post Q31/Q32b patches; save JSON as last old-scorer baseline
- [x] Correct HANDOFF-STATE-OF-BLOOM-HOUSE.md §5.3 + §8 (branch story is wrong)
- [x] SUPERSEDED banners on CONSOLIDATION-PLAN-25-DAY-NO-SUSAN.md and CONSOLIDATION-PLAN-30-DAY.md
- [x] Fix MONDAY-START-HERE.md line 15 (still names BLOOM-MASTER-PLAN as plan of record)
- [x] In-repo CLAUDE.md: name CONSOLIDATION-PLAN-PHASED.md as plan of record (currently points at BLUEPRINT.md)
- [x] Copy phase2-exports/ (477 weddings, 1,425 people) off this machine

**Exit gate:** MET 2026-07-07. Prod = master = consolidation = `c06600b` (Vercel dpl_2zUJFUBJFo6mTpXMT99VfjcW59xY, Ready). Knot fix verified at data level: 122/125 2026 Knot inbounds linked, 76 backfilled weddings, 3 orphans remain. Exports copied to OneDrive/bloom-backups/phase2-exports-2026-07-07.

**R0 battery result (old scorer, baseline):** `battery-results/2026-07-07T22-46-21-030Z.json` — avg **1.556**, Tier-4 −3 count **1**. Q31 + Q32b patches confirmed fixed. The three remaining −3s are all SCORER false positives, not product failures: Q17 answered with a correct refusal ("That specific detail isn't in my data") that the refusal regex missed; Q28 same shape; Q33 is the known first-channel-token bug. Q12/Q34 errored on a transient "Claude failed, no OpenAI fallback". This is direct evidence for R2's priority: the product's honesty rails now outperform the instrument measuring them.

## Phase R1 — Execute the wipe (= phased plan Phase 2) (this week) — MODEL: Opus 4.8

Blocked on operator items since 2026-06-11. One day of operator time + the firm one-week window.

Operator items, same day:
- [ ] Persistent Supabase snapshot branch `pre-phase2-<date>`
- [ ] Fresh HoneyBook CSV download
- [ ] Re-run scripts/phase2-export-danger.mjs (wipe refuses --apply without <48h manifest)
- [ ] Re-run verify-nobody-live same day

Execution:
- [ ] Walk PHASE2-GO-CHECKLIST.md A–E, ticking in the file
- [ ] Wipe → reimport HoneyBook → Calendly → Gmail → Zoom/SMS → Knot, all through linkSignal
- [ ] phase2-remerge-operator-columns.mjs
- [ ] Spot-check known failure shapes: Liam Hunt duplicate-partner2; breanne/hiwote/emily cross-channel; 36 orphan Knot inquiries

**Exit gate:** spine sane, Q29/Q30 pass, spot-checks clean, snapshot restorable.

## Phase R2 — Make the instruments honest (1–2 sessions; start while R1 waits) — MODEL: FABLE (do not run on Opus)

Do NOT start R3 before this lands. Current scorer is regex-only: "evidence" = contains
a number; hedge words defeat −3; 29/38 questions at ceiling every run.

Battery rebuild:
- [x] Replace regex scorer with LLM judge + ground-truth probes — `battery-judge.ts` (v1.1) + `battery-ground-truth.ts` (17/43 questions carry a canonical-layer probe); regex demoted to judge-unreachable fallback, tagged `scorer:'regex-fallback'`
- [x] Fix Q33 dominantChannel first-token bug — now telemetry-only; judge scores consistency on whether the recommendation is coherent
- [x] Add Q37 (Saturday-morning tours workflow) to the runner — was doc-only
- [x] Reconcile Q32b runner-vs-doc divergence — dropped the runner-only "confirm that for me" suffix to match the doc
- [x] New tier for built-but-untested surfaces — Tier 12 (Q38 CAC-in-currency, Q39 capacity/pace, Q40 lost-deals, Q41 reviews)
- [~] Run the operator-review pass ONCE for real; record in BLOOM-TEST-FINDINGS.md — AUTOMATED HALF DONE: findings F0–F4 seeded, −3s DB-confirmed. **HUMAN HALF STILL OWED (operator only):** open `battery-results/review-sheet-2026-07-08T15-32-14-949Z.md`, verify the +1/+2 calibration scores against ground truth you know, paste verdicts into BLOOM-TEST-FINDINGS.md. `npx tsx scripts/battery-review-sheet.ts` regenerates it for any run.
- [x] Reconcile question count — 43 everywhere (doc, runner, sanity guard)
- [x] Run new battery twice back-to-back; confirm score stability — v1.1: avg +1.05 / +0.98, Tier-4 −3 count 1 / 0; judge stable, swings are product non-determinism (F2)

Ingestion monitoring:
- [x] Per-channel daily ingestion-volume baseline + anomaly alert → /intel/anomalies + operator email — `ingestion-volume-monitor.ts`, rides the 04:00 anomaly_detection cron; also fixed a day-one digest bug (alerts section queried a non-existent `resolved` column, silently empty since launch)
- [x] Backtest against Apr–Jun data; fires on the Knot regression — `scripts/backtest-ingestion-monitor.ts`: Knot alerts 10 of 14 weeks, continuously from week 1 of April (would have caught in week one what went unnoticed for two months)

**Exit gate:** MET 2026-07-08. New judge-scored baseline recorded (commit `75f4a2d`); backtest fires on the Knot regression (commit `1fc436f`). Residual: human operator-review pass (owed), and F1–F4 product findings feed R3. NOTE: two DB-confirmed reproducible product findings — F1 Q26 channel-conversion confabulation, F4 possible real HoneyBook ingestion drop — are open and belong to R3 / operator triage respectively.

## Phase R3 — Reader migration + pipeline decomposition (= phased plan Phase 3, amended) (6–9 wks) — MODEL: FABLE

Legacy:spine reads in src/app currently ~9:1 (979 vs 106) and widening.

- [ ] FIRST COMMIT: ratchet guard — no NEW legacy-table reads in src/app (.from('weddings') etc. may only fall from baseline)
- [ ] Wire /intel pages onto the six canonical readers in src/lib/intel/canonical.ts (built, parked since June)
- [ ] Limb order per plan: Agent+Loop1 → Sage → Intel → Portal
- [ ] Per-limb gate on the HONEST scorer: battery subset ≥ +1.0, loop closes, that limb's legacy reads deleted
- [ ] During Agent limb: decompose pipeline.ts — split ~3,900-line processIncomingEmail into staged modules (ingest / identity / classify / draft / send); golden-cascade green after every extraction; no function >~300 lines
- [ ] Promote a Playwright smoke subset (5–10 specs) into CI

**Exit gate:** four limbs on spine; pipeline.ts <~1,500 lines; migrated limbs read zero legacy tables.

## Phase R4 — Schema and tenancy hygiene (2–3 wks, overlaps R3) — MODEL: Opus 4.8

- [ ] Flatten 380 migrations to a single baseline post-wipe; adopt tracked migrations (applied-state lives in the DB, not memory)
- [ ] Delete the 9 root APPLY-*.sql / PASTE-*.sql bundles once confirmed applied
- [ ] RLS ratchet 74 → 0 venue-scoped tables, most sensitive first (rls-baseline.json may only fall)
- [ ] Fix scheduling-tool-parsers.ts:144 — machine-address filter reads venue config, not hardcoded rixeymanor|thebloomhouse regex
- [ ] De-Rixey cosmetics: extract-packages dropdown label; settings/venue-info/page.tsx:816 + settings/openphone/page.tsx:290 placeholders

**Exit gate:** RLS baseline 0; `supabase migration list` answers "what's applied" without the founder.

## Phase R5 — Venue-2 readiness (2–3 wks; gated on R1) — MODEL: split (UI build on Opus; fictional-venue dry-run on Fable)

- [ ] Productise onboarding tail: onboard-data-cleanup.ts + onboarding-readiness.ts become an admin UI step with per-invariant pass/fail, not founder CLI
- [ ] Generic-CSV column-mapping UI, or an honest concierge runbook
- [ ] Decide Dubsado + Aisle Planner: build adapters or state unsupported at signup (current "not yet implemented" throw is worst of both)
- [ ] Dry-run: onboard a fictional venue end-to-end without opening a terminal; every CLI reach is a bug in this phase
- [ ] Battery vs the new venue's near-empty state: honesty rails must refuse gracefully, zero −3s

**Exit gate:** hands-off dry-run completes; empty-state battery has zero −3s.

## Phase R6 — Commercial proof (after ship gate) — MODEL: Fable

- [ ] Full battery ≥ +1.0, zero Tier-4 −3s, honest scorer, on Rixey
- [ ] Three founding-member venues signed (the 50%-off instrument exists for this)
- [ ] ≥1 onboarded without founder terminal access
- [ ] 60 days of clean ingestion monitoring across all venues
- [ ] Rebuild investor materials on those numbers; lead with the honesty rails

## Explicitly parked

- Dunning ladder (matters at ~10 customers)
- Full e2e suite in CI (smoke set suffices)
- Knot/WeddingWire partnership (already parked in BLOOM-CEO-DECISIONS.md)
