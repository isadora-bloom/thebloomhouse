# Origin-Sourced Ingestion — Doctrine + Architecture

**Date:** 2026-05-28 · Ratified directive (CEO): *"re-source everything from origin — the way information ingests and what it pulls is as important as what it does with it."*
**Status:** elevates to a Canonical non-negotiable; is the concrete content of decision **D-2** and the spine-first cutover **D-5**.
**Grounded in:** the ingestion-surface map (4 audits + code trace, file:line below).

---

## 1. The principle (now a non-negotiable)

**Ingestion fidelity is first-class.** A signal's origin and what is captured at the door are load-bearing — not plumbing. The intelligence is only ever as true as what entered. Therefore:

> **There is exactly ONE way a signal becomes spine: its true ORIGIN → an adapter that captures it at FULL FIDELITY → `linkSignal` → the spine. No second reconstruction path. No reading our own mirrors. No silent drops.**

This kills the architecture's deepest flaw — that today reconstruction reads *derived* tables, so any extraction defect is laundered into the spine as if it were ground truth.

---

## 2. The core finding — two ingestion systems, collapse to one

| | Live ingestion | Backwards Tracer (`sources/*`) |
|---|---|---|
| Reads | **true origin** (Gmail API, Calendly/Twilio webhooks, Zoom/OpenPhone APIs, operator CSVs) | **DB mirrors** (`interactions`, `tours`, `candidate_identities`, `weddings`) |
| Fidelity | full (`full_body`, `rfc2822_headers`, Calendly Q&A, UTM/referrer, transcripts) | **lossy** (drops `full_body`, headers, Q&A, email/phone) |
| Writer | `linkSignal` / `linkSignalWithLifecycle` / `linkSignalBatch` (the chokepoint) | its **own** `insertTouchpointIdempotent` + `lockAndUpsertCouple` |

**Decision: retire the Tracer's mirror-adapters and its separate writer. The re-onboard replays each origin through the SAME live path that handles new traffic.** Reconstruction = live ingestion run over history. One code path, one writer, origin-sourced, full-fidelity. (Files: `src/lib/services/identity/sources/{gmail,calendly,knot,instagram,anchors}.ts` → deprecated; `tracer.ts`/`touchpoints-writer.ts` separate writer → folded into `linkSignal`.)

This also resolves **G1 permanently**: nothing reads `interactions` to *build* the spine. `interactions` becomes — at most — a downstream projection *of* the spine, or is dropped. The circular dependency is gone by construction.

---

## 3. The six ingestion non-negotiables

1. **One path.** Origin → adapter → `linkSignal` → spine. The Tracer's parallel writer is deleted. (Enforced: `check-cascade-only-writer.mjs` already guards spine writes; extend it to forbid `insertTouchpointIdempotent`/`lockAndUpsertCouple` outside `linkSignal` once the Tracer is folded in.)
2. **Origin, never mirror.** Adapters read external origins only. A re-onboard that reads our own tables is rejected. (New guard: `check-no-mirror-source.mjs` — `sources/*` may not import the supabase client to read `interactions`/`tours`/`candidate_identities`/`weddings`.)
3. **Full fidelity at the door.** Capture everything the origin offers; persist the raw payload verbatim in `touchpoints.raw_payload` (full_body, headers, Q&A, all CSV columns, UTM, transcripts). Extraction is layered on top of raw, never destructive. **No silent drops** — every field lands in canonical, `unmapped:*`, or `raw_payload`.
4. **Source attribution captured at ingestion**, from the upstream signal — never inferred from a CRM `lead_source`. (HoneyBook `lead_source` is already correctly ignored — `honeybook.ts:742` sets `weddings.source=NULL`; keep it.)
5. **Idempotent + replayable.** Every signal carries a stable `external_id`; the entire re-onboard is a repeatable no-op on dupes (`UNIQUE(venue_id, channel, external_id)`).
6. **Anonymous signals must be stitchable.** UTM/referrer (web pixel) and social aggregates must bind to a couple when a bridge identifier arrives — not be orphaned forever.

---

## 4. The unified pipeline

```
  TRUE ORIGIN                          ADAPTER (full fidelity)        ONE WRITER         SPINE
  Gmail API ─────────────────────────► gmailToSignal ───────────┐
  Calendly API + Q&A ────────────────► calendlyToSignal ────────┤
  Twilio / OpenPhone ────────────────► smsToSignal ─────────────┤
  Zoom / OpenPhone transcripts ──────► zoomToSignal ────────────┼──► linkSignal ──► couples
  HoneyBook / Knot / WW / Zola CSV ──► crmRowToSignal (batch) ──┤    (+lifecycle)    touchpoints
  Knot/WW/Zola relay emails (Gmail) ─► relayToSignal ───────────┤                    fragments
  Web pixel (UTM/referrer) ──────────► visitToSignal (+stitch) ─┤                    (raw_payload =
  Reviews (Google Places + paste) ───► reviewToSignal ──────────┤                     verbatim origin)
  IG / Pinterest screenshots ────────► brainDumpToSignal ───────┘
```
`interactions` (and the other legacy mirrors) are **downstream of**, never **input to**, this pipeline.

---

## 5. Per-source origin plan

| Source | True origin | Pull (full fidelity) | Spine route today | Build for the re-onboard |
|---|---|---|---|---|
| **Gmail/email** | Gmail API | full_body + `rfc2822_headers` + thread + labels + timestamps; UTM mined to `extracted_identity` | live: yes; Tracer: **drops full_body/headers** | Replay via `historical-backfill.ts` (already hits Gmail API live) through `linkSignal`; **carry full_body + rfc2822_headers into `raw_payload`**; delete `sources/gmail.ts` mirror read |
| **Calendly/tours** | Calendly API + `weddings.calendly_qa` | invitee email/phone/name, start_time, **four-state Q&A**, discovery answer | live webhook: yes (Q&A→`calendly_qa`); Tracer: **drops Q&A/email/phone** | Adapter reads Calendly API / `calendly_qa`; carry Q&A + contacts into the signal; reconcile `tours`/`meeting`/webhook into one origin read |
| **HoneyBook** | CSV (Projects/Payments/Contacts) | all columns; `raw_import_row` preserved; `lead_source` IGNORED | yes (`linkSignalBatch`) | Closest to ideal already. Add stable **recurring-CSV** re-onboard (ledger `crm_import_rows` exists; doctrine NOT YET BUILT) |
| **The Knot** | relay emails (Gmail) + leads CSV + visitor-activity CSV | relay localpart per-prospect id (corrected doctrine ✓), subject→action, CSV cols, visitor activity | yes (pipeline / `linkSignalBatch`) | Unify the 3 origins under one writer; add `the_knot` `crm_source` enum (today `generic_csv`) |
| **WeddingWire / Zola** | relay emails (Gmail) + CSV | relay localpart, CSV cols | yes (generic) | **Build per-prospect relay-ID extractors** (only Knot has one today) |
| **SMS** | Twilio webhook + OpenPhone API | body→full_body, MessageSid, from/to; raw form params preserved | yes (`linkSignalWithLifecycle`) | Add `recordVoiceLifecycleSignal` (Pbatch2-8 gap: phone/voicemail skip lifecycle) |
| **Zoom/audio** | Zoom API + OpenPhone transcripts | WEBVTT transcript + recording URLs | yes | same voice-lifecycle gap |
| **Web calculator/forms** | form POST + pixel | UTM/medium/campaign, click-ids, referrer, landing_path, answers | form-import: yes; **pixel `web_visits`: ORPHANED** | **Build `web_visits` → person stitch** (carry `anon_visitor_id` to form submit; join on bridge) so paid-attribution reaches couples |
| **Reviews** | Google Places API + paste | text, rating, author, source_review_id; phrases→`review_language` | **NONE — never touches spine** | **Build `sources/reviews.ts` + `reviewToSignal`** → `linkSignal`, bind to couple (feeds Voice DNA + positioning per USP) |
| **IG/Pinterest/social** | manual screenshot/paste (brain-dump) | aggregate fragments, handles | partial (`linkSignalBatch` branch) | Route all identity fragments through `linkSignal`; keep aggregates as channel-scoped until a bridge event |

---

## 6. Build list for the re-onboard (the cutover's real Phase 1)

This *is* the "make `linkSignal` the sole writer + re-source from origin" work — smaller than migrating 138 writers:

1. **Fold the Tracer into `linkSignal`.** Re-onboard = replay origins through the live path; delete the 5 mirror-adapters + the Tracer's separate writer. (Biggest single simplification.)
2. **Gmail:** full_body + rfc2822_headers into `raw_payload` (one-line fix in the signal builder); re-onboard via `historical-backfill.ts` (already origin).
3. **Calendly:** signal builder carries Q&A four-state + email/phone from `calendly_qa`.
4. **Reviews:** new `reviewToSignal` adapter → `linkSignal`.
5. **Web pixel → identity stitch:** join `web_visits.anon_visitor_id` to the minted couple on the first identified event.
6. **WW/Zola relay-ID extractors;** Knot `crm_source` enum.
7. **Voice lifecycle:** `recordVoiceLifecycleSignal` for phone/voicemail.
8. **Guards:** `check-no-mirror-source.mjs` (adapters can't read mirrors); extend `check-cascade-only-writer.mjs` to forbid the Tracer's writer once folded.

Sequence: do 1–3 + 8 → wipe → replay all origins through `linkSignal` → clean spine. Then 4–7 fill the gaps (reviews, pixel, relays, voice) as their golden cases demand.

---

## 7. New golden / fidelity assertions to add (Layer C)

The re-onboard makes these assertable; add to `cases.json`:
- **GC-10 fidelity:** every email touchpoint's `raw_payload` contains a non-empty `full_body` (proves Gmail fidelity; surface `spine` once D-2 lands).
- **GC-11 Q&A:** a Calendly tour touchpoint carries the discovery-answer Q&A in `raw_payload` (surface `spine`).
- **GC-12 no-mirror:** a re-onboard run with `interactions` truncated still rebuilds the spine identically (proves origin-sourced, not mirror — the anti-G1 assertion).
- **GC-13 pixel stitch:** a web visit with `utm_source=google` that later identifies binds the UTM to the couple (surface `pending:web-stitch`).

---

## 8. What to ratify

- **Add non-negotiable to Canonical v1.0 / Draft A:** "Single origin-sourced, full-fidelity ingestion path through `linkSignal`; no reconstruction from derived tables; no silent drops." (Sits alongside §3.1 forensic substrate + the no-silent-drops rail.)
- **Confirms D-2 (re-source from origin) and folds it into D-5 (spine-first cutover):** the cutover's "single writer" = retire the Tracer's writer; the cutover's "reimport" = replay origins through `linkSignal`.

The payoff: after the wipe, the spine is built from ground truth by the same code that serves live traffic — so what the system *knows* is exactly what it *ingested*, at full fidelity, with one auditable path from origin to couple.
