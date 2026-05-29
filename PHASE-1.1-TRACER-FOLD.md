# Phase 1.1 — Fold the Backwards Tracer into `linkSignal`

**Date:** 2026-05-29 · Plan-of-record: `BLOOM-MASTER-PLAN.md` §5 Phase 1, step 1.1 · Doctrine: `ORIGIN-INGESTION-SPEC.md` (N3)
**Status:** drafted, review-and-go. **No runtime changed by this doc.** Execution = Monday.

## Objective (one line)
Make `linkSignal` the **single** writer and ingestion **origin-sourced**: retire the mirror-reading Tracer; reconstruction becomes the *live ingestion path replayed over history*. Drives `check-no-mirror-source` from **8 → 0** and `duplicate_identity_modules` down.

## The worklist (from `check-no-mirror-source.mjs`, baselined at 8)
Each mirror read → its origin replacement:

| Adapter (RETIRE) | Mirror read today | True origin to replay from instead |
|---|---|---|
| `sources/gmail.ts:73,97` | `interactions`, `people` | **Gmail API** via `historical-backfill.ts` (already origin-sourced → `processIncomingEmail` → `linkSignal`) |
| `sources/calendly.ts:87,132` | `tours`, `interactions` | **Calendly** — replay `weddings.calendly_qa.webhook_invitee_raw` (the verbatim webhook payload) or the Calendly API; carry the four-state Q&A + email/phone |
| `sources/knot.ts:83` | `candidate_identities` | **Gmail relay emails** (`*@member.theknot.com`) + **Knot leads/visitor CSV** via `crm-import` |
| `sources/instagram.ts:54` | `candidate_identities` | **brain-dump artifacts** (the manual screenshot/paste origin) → `linkSignalBatch` |
| `sources/anchors.ts:64,79` | `weddings`, `people` | **HoneyBook contract CSV** — a booked couple is established by replaying the contract signal (sets `lifecycle='booked'` + `source_wedding_id`), not by reading the legacy table |

## Cutover steps (checkboxed)
- [x] **1.1.a — Reuse Gmail origin replay. DONE 2026-05-29.** Confirmed `historical-backfill.ts` → `processIncomingEmail` → `linkSignal` is the live origin path. `sources/gmail.ts` deleted. tsc clean.
- [x] **1.1.b — Fidelity fix (GC-10). DONE 2026-05-29.** `emailToNormalizedSignal` now accepts `fullBody` + `rfc2822Headers` (optional, backward-compatible) and writes them to `raw_payload`; both inbound call sites (`pipeline.ts:5009` main M1 + `:2530` escalation) forward `email.body` + `email.headers`. Outbound sites unchanged (no inbound body). `tsc --noEmit` clean. Verifies via GC-10 once the test branch is wired (D-12). _Uncommitted on `consolidation`._
- [x] **1.1.c — Calendly origin replay (GC-11). DONE 2026-05-29.** Built `identity/replay/calendly-replay.ts` (`replayCalendlyFromQa`) — reads `weddings.calendly_qa.webhook_invitee_raw` (verbatim origin) → reuses `calendlyToNormalizedSignal` → `linkSignal`, carrying the four-state Q&A. `sources/calendly.ts` deleted. tsc clean.
- [~] **1.1.d — Knot/WW/Zola. PARTIAL 2026-05-29.** `sources/knot.ts` deleted; reconstruction = Gmail relay replay + `crm-import` CSV (both existing). **REMAINING (next increment):** per-prospect relay-ID extractors for WeddingWire/Zola (only Knot has one today); add a `the_knot` value to the `crm_source` enum (currently `generic_csv`).
- [x] **1.1.e — Social. DONE 2026-05-29.** `sources/instagram.ts` deleted; brain-dump identity fragments already route through `linkSignalBatch` (existing branch); aggregates stay channel-scoped.
- [x] **1.1.f — Anchors. DONE 2026-05-29.** `sources/anchors.ts` deleted; booked-couple anchoring now comes from replaying the HoneyBook contract signal through `linkSignal` (`crm-import` → `linkSignalBatch`).
- [x] **1.1.g — Single writer. DONE 2026-05-29.** Blueprint correction: the Tracer had no separate couple-writer (it already mints via `lockAndMintCouple`); `lockAndUpsertCouple` was a phantom and `insertTouchpointIdempotent` belongs to the legacy `backtrack.ts` limb. Removed the redundant `processSignal`/`stageTouchpointSweep` adapter-walk; kept the shared spine writers (they ARE `linkSignal`'s plumbing). `tracer.ts` stays a chokepoint; new `check-no-mirror-source.mjs` enforces origin-only `sources/`.
- [x] **1.1.h — Mirror ratchet at target. DONE 2026-05-29.** `check-no-mirror-source` = **0** (8→0), baselined at 0. (`cleanup-budget` `duplicate_identity_modules` stays 5 — that metric tracks the resolution paths `resolver/matcher/etc.`, a separate Phase-3 target, not the retired adapters.)
- **BONUS built (beyond strict 1.1 list):** `replay/reviews.ts` (reviews now reach the spine — were orphaned), `replay/web-visit-stitch.ts` (UTM→couple stitch; needs anon-id carry-forward wired at calculator submit), `replay/index.ts` (the `replayAllOrigins` orchestrator Phase 2 calls). All tsc-clean.

## Replay-coverage matrix (confirm at step start — "verify before build")
| Source | Origin replay exists? | Action |
|---|---|---|
| Gmail | ✅ `historical-backfill.ts` | reuse |
| HoneyBook / Knot / WW / Zola CSV | ✅ `crm-import` → `linkSignalBatch` | reuse; add recurring-CSV |
| Calendly | ⚠️ webhook only (no historical) | **build** replay from `calendly_qa` (1.1.c) |
| SMS (OpenPhone) | ✅ 180-day backfill in `openphone.ts` | reuse; add voice-lifecycle dispatch |
| SMS (Twilio) / Zoom | ⚠️ webhook/poll, no historical | confirm coverage; backfill from provider API if gaps |
| Reviews | ❌ never reaches spine | **build** `sources/reviews.ts` → `linkSignal` (GC-13 sibling) |
| Web pixel | ❌ orphaned `web_visits` | **build** `web_visits → couple` stitch (GC-13) |

## Guardrails + golden cases
- `check-no-mirror-source.mjs` (8 → 0) · `check-cascade-only-writer.mjs` (extended) · `cleanup-budget` (`duplicate_identity_modules` ↓).
- Golden: **GC-3** (partner2, already green path) · **GC-10** full_body fidelity · **GC-11** Calendly Q&A · **GC-12** truncate-`interactions`-and-rebuild (proves origin-sourced) · **GC-13** pixel stitch. (GC-10–13 added to `cases.json`, tagged `pending:1.1` until the steps land, then flipped to `spine`.)

## Exit criteria (Phase 1.1 done)
- [ ] `sources/{gmail,calendly,knot,instagram,anchors}.ts` deleted; `check-no-mirror-source` = 0.
- [ ] One writer: `linkSignal` (Tracer's separate writer removed; cascade guard forbids it).
- [ ] GC-10/GC-11/GC-12 green on the test branch; full_body + Q&A present in `raw_payload`.
- [ ] `cleanup-budget` shows `duplicate_identity_modules` fell by 5; nothing rose.
- [ ] CEO ack → Phase 1 continues (turn off legacy-identity writes, §1.4) → Phase 2 wipe + replay.

## Honest risks
- **Calendly + Twilio/Zoom lack historical replay** — the live paths are event-driven. 1.1.c builds Calendly from `calendly_qa`; confirm Twilio/Zoom history coverage or accept that pre-existing SMS/Zoom signals replay only from their processed-tables (a narrow, contained mirror-exception to document, not a silent one).
- **`tracer.ts` may carry orchestration** (checkpointing, ordering) worth keeping — fold its *writer* into `linkSignal` without losing its *sequencing*.
- This is the single riskiest step (changes the reconstruction writer). GC-12 (rebuild with `interactions` truncated) is the proof it's truly origin-sourced before the wipe.
