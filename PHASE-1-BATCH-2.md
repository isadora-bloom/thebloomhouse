# Phase 1 — Batch 2 Worklist · Ingestion Adapters

**Date:** 2026-05-26 · **Plan:** `CONSOLIDATION-PLAN-PHASED.md` §1.2 (Batch 2 of 4).
**Inputs:** four code-verified enumeration agents (Calendly · HoneyBook · Twilio+OpenPhone+Zoom · cross-channel cascade-readiness audit), 2026-05-23/26.
**Scope:** five ingestion adapters — Calendly webhook, HoneyBook CSV import, Twilio/SMS, OpenPhone (SMS+voice+voicemail), Zoom (meetings+transcripts).

**Restore point:** git tag `pre-consolidation-2026-05-22` · Supabase branch `pre-consolidation-2026-05-22` (ref `ciwqxwohczzthvzqqgjx`). Per the §1.3 v2 re-scope, shadow-compare under dual-write reduces to typecheck + guards + per-site logic trace + post-flip consistency audit against the branch (M1/M8-style); the `OldPathRunner` harness is retained for Phase 2 reimport reconciliation.

---

## 0. What "migrate a writer" means (Batch 2)

Same as Batch 1 §0 — **dual-write, not delete**. A migrated writer adds the cascade-equivalent call (`linkSignal` / `linkSignalBatch` / `mintPerson` / `mergeWeddings`) alongside the existing legacy insert. Legacy stays until Phase 4. The cascade-only-writer CI guard (`scripts/check-cascade-only-writer.mjs`) keeps `webhooks/twilio/route.ts`, `ingestion/openphone.ts`, `ingestion/zoom.ts`, `crm-import/index.ts` on the grandfather list for `interactions`/`people` — these adapters' direct legacy inserts are Phase-3-limb-migration territory and stay; the Batch-2 flip is the ADDITION of the cascade call.

**One real exception:** Calendly's `calendly-outcomes.ts` writes spine `touchpoints` direct (cancellation + attendance sweep) — those are TRUE cascade-chokepoint violations (analog of Batch 1's `tracer.ts:730` issue, which P3 fixed). Those flips MUST remove the direct write, not dual-write.

---

## 1. Enumeration result (verified across 5 adapters)

**17 MIGRATE sites across 5 channels + 1 cross-channel attribution writer** (Calendly 5, HoneyBook 4, Twilio 2, OpenPhone 3, Zoom 2 + 1 already-routed shadow + 1 cross-channel intel/referrals).

**CORRECTION (pressure-test):** initial enumeration missed Twilio + OpenPhone `mintWedding` sites AND the `intel/referrals/resolve.ts` attribution_events writer. The original "~15" was 14 and undercount; this is 17. Numbers below: total writes per adapter / MIGRATE / STAY / chokepoint-violations / already-routed. Line numbers will drift — re-grep at execution.

### Calendly — 15 writes total · 5 MIGRATE · 9 STAY · 2 chokepoint-violations · 1 already-routed

| # | site | table | what it creates | Shipped | cascade target |
|---|---|---|---|---|---|
| C1 | `webhooks/calendly/route.ts:~365` | `tours` | pending tour row on `invitee.created` | **pending** | `linkSignal({channel:'calendly', action_type:'tour_booked'})` + decide tours-fate (Qcal-2) |
| C3 | `webhooks/calendly/route.ts:~432` (`linkSignal`) | `touchpoints`/`fragments`/`couples` via cascade | tour_booked spine record | **ALREADY ROUTED (shadow)** | P5-style promotion only — capture result, drop swallowed catch, drop inline literal in favor of `calendly-to-signal.ts` |
| C8 | `discovery-source/capture.ts:~158` | `discovery_sources` | verbatim "how did you hear" answer | **pending** | `linkSignal({action_type:'discovery_self_report'})` inside `captureDiscoverySource` — **shared with HoneyBook + intake forms** (one chokepoint fix, three callers) |
| C9 | `discovery-source/capture.ts:~236` | `attribution_events` | tier_1_full_name attribution row | **pending** | same call as C8 (captureDiscoverySource fires both) |
| C11 | `calendly-outcomes.ts:~137` | `touchpoints` (direct UPSERT) | tour_cancelled spine record | **CHOKEPOINT VIOLATION — pending** | replace direct `touchpoints.upsert` with `linkSignal({action_type:'tour_cancelled'})`. **MUST remove the direct write** — this is the analog of `tracer.ts:730` from Batch 1 (P3 fix). The new CI guard trips on this. |
| C12 | `calendly-outcomes.ts:~344` | `touchpoints` batch UPSERT | tour_attended spine records (daily sweep) | **CHOKEPOINT VIOLATION — pending** | replace with `linkSignalBatch({signals})` |

### HoneyBook — primary writer + email-pipeline scheduling-event + booked-data-recovery cron · 4 MIGRATE

| # | site | table | what it creates | Shipped | cascade target |
|---|---|---|---|---|---|
| H1 | `crm-import/index.ts:~796` | `people` | partner1 from CSV (no dedup beyond resolver miss) | **pending** | `mintPerson({weddingId, role:'partner1', signals:{email,phone,fullName}, source:'crm_import'})` |
| H2 | `crm-import/index.ts:~871` | `people` | **partner2 from CSV — Liam Hunt class** (only `ilike('first_name')` dedup; misses last-name-only, spelling variants, cross-channel collisions) | **pending — HIGHEST PRIORITY** | `mintPerson({weddingId, role:'partner2', signals:..., source:'crm_import'})` — P2 enrich-or-skip + migration 367 unique index close it permanently |
| H3 | `crm-import/index.ts:~1031` | `interactions` (batch) | per-row HoneyBook interactions incl. synthetic `crm_attribution` provenance row | **pending** | `linkSignalBatch` with `channel:'honeybook'`, action_types: `crm_imported_inquiry`/`crm_imported_booked`/`crm_imported_lost`/`crm_attribution`. The synthetic `crm_attribution` row carries `extracted_identity.hear_source` — true acquisition signal currently invisible to spine. |
| H4 | `booked-data-recovery.ts:~938` | `weddings` (UPDATE `merged_into_id`) | identity-bearing soft-merge of HoneyBook duplicates | **pending — HIGH BLAST RADIUS** | route through `mergeWeddings` chokepoint; record a `candidate_matches` row first so the merge has an audit trail. Today bypasses the canonical merge writer entirely. |
| (already routed) | `crm-import/index.ts:~731` + `pipeline.ts:~3372` (mintWedding paths) | `weddings`/`couples`-mirror | wedding shell + couple mirror | **chokepoint already canonical** | no change — `mintWedding` is the chokepoint per Batch-1 §5; the fire-and-forget mirror is the same review item flagged there |

### Twilio (SMS webhook) — 2 MIGRATE (T2 + T6 added post-pressure-test)

| # | site | table | what it creates | Shipped | cascade target |
|---|---|---|---|---|---|
| T2 | `webhooks/twilio/route.ts:~275` | `interactions` | core SMS interaction row | **pending** | `linkSignal` via new `sms-to-signal.ts` adapter (channel `'sms'`, action_type `'sms_inbound'`/`'sms_outbound'`) |
| T6 | `webhooks/twilio/route.ts:~376` (via `mintWedding`) | `weddings` + `couples` (mirror) + `people` + `mint_wedding_telemetry` | full Liam-Hunt-style mint cascade — classifier-gated when `intent_class ∈ {new_inquiry, inquiry_followup}` | **chokepoint already canonical** (parallel to Batch-1 §5 ruling for `pipeline.ts:2093/2955` mintWedding sites) | n/a — same `mintWedding`-is-the-chokepoint exemption as Batch-1 §5. The `weddings→couples` mirror is fire-and-forget; once T2's `linkSignal` is load-bearing the mirror becomes redundant — same review item flagged in Batch-1 §5. |

### OpenPhone (cron poll + manual sync) — 3 MIGRATE (O4, O7 + O6 added post-pressure-test)

| # | site | table | what it creates | Shipped | cascade target |
|---|---|---|---|---|---|
| O4 | `ingestion/openphone.ts:~994` | `interactions` | core SMS/voicemail/call interaction | **pending — HIGHEST VOLUME of phone-channel writes** | `linkSignal` via `sms-to-signal.ts` (SMS) + `voice-to-signal.ts` (call/voicemail). Choice of 1 channel `'sms'` vs 3 channels `'sms'`/`'phone'`/`'voicemail'` is Pbatch2-4. |
| O6 | `ingestion/openphone.ts:~1156` (via `mintWedding`) | `weddings` + `couples` (mirror) + `people` + `mint_wedding_telemetry` | same shape as T6 | **chokepoint already canonical** (parallel to Batch-1 §5) | n/a — same exemption as T6 |
| O7 | `ingestion/sms-name-match.ts:~88-104` (via `resolveIdentity`) | `people`/`weddings`/`contacts` | LEGACY-resolver-minted person from Tier-0 body-email match | **pending** | route the body-extracted email+name as a `linkSignal({action_type:'body_extracted_email'})` follow-up signal so the spine sees it (closes the body-stages-dead-on-live-path Q5 gap from Batch 1) |

### Cross-channel attribution — 1 MIGRATE (added post-pressure-test)

| # | site | table | what it creates | Shipped | cascade target |
|---|---|---|---|---|---|
| I1 | `src/lib/services/intel/referrals/resolve.ts:~280` | `attribution_events` | referral self-report attribution row | **pending** | same shape as C8/C9 — add `linkSignal({action_type:'referral_self_report'})` call. Pbatch2-6 covers Calendly's `captureDiscoverySource`; this is the parallel for referrals (sibling grandfather entry in the CI guard). Fold into Pbatch2-6's scope. |

### Zoom (cron poll) — 2 MIGRATE · 0 cascade routing today (worst case)

| # | site | table | what it creates | Shipped | cascade target |
|---|---|---|---|---|---|
| Z5 | `ingestion/zoom.ts:~673` | `interactions` | meeting transcript row | **pending** | `linkSignal` via new `zoom-to-signal.ts` (channel `'zoom'` — NOT `'meeting'` which collides with Calendly batch adapter — see Pbatch2-5) |
| Z6 | `ingestion/zoom.ts:~738/748` (body-extract dispatch) | `people`/`weddings`/`contacts` | per-extracted-email LEGACY resolver mint | **pending** | per-signal `linkSignal({action_type:'body_extracted_email'})` — same as O7. Closes Q5's "stages 6/7/8 never fire from `linkSignal`" gap with body fields populated. |

---

## 2. Prerequisites — build BEFORE site flips

Eight prerequisites. P-batch2-1/2/6 are blockers for flips; the rest are needed for completeness/correctness within Batch 2.

### Pbatch2-1 — Per-channel signal builders (5 new files)
Five named adapters under `src/lib/services/identity/` (or a new `signal-builders/` directory), each ~20-50 lines following the P1 `email-to-signal.ts` pattern:
- `calendly-to-signal.ts` — extracts the inline literal at `webhooks/calendly/route.ts:436-457`; three modes (`invitee_created`/`invitee_canceled`/`attended_derived`); resolves Qcal-1 (signal_tier `'high'` vs batch Tracer's `'highest'` for same tours).
- `honeybook-csv-to-signal.ts` — per CSV row; action_types `crm_imported_inquiry`/`crm_imported_booked`/`crm_imported_lost`/`crm_attribution`; pulls partner1+partner2+identity from row; `external_id` decision (see OQ-H2).
- `sms-to-signal.ts` — shared by Twilio + OpenPhone-SMS; channel `'sms'`; phone-direction logic.
- `voice-to-signal.ts` — OpenPhone call/voicemail; channels `'phone'`/`'voicemail'` (or unified `'sms'` per Pbatch2-4 decision).
- `zoom-to-signal.ts` — meeting+transcript+roster; channel `'zoom'`; carries body-extracted identifiers in signal slots (closes Q5).

**Doctrine bake-in:** these are the ONLY allowed construction sites for `NormalizedSignal` for their channels. Mirror Batch-1 P1's "every Batch-1 writer builds the signal one way" rule — extend a `check-no-inline-signal-literal.mjs` guard if we want CI to enforce.

### Pbatch2-2 — Shared signal helpers
Three pure functions reused across builders, in `src/lib/services/identity/signal-helpers/`:
- `phone-fields.ts` — `(direction, fromPhone, toPhone) → {primary_phone, partner_phone}` with correct couple-vs-venue semantics.
- `identity-hint.ts` — `name ?? email ?? phone ?? handle` fallback chain (currently re-implemented at `mint-couple.ts:113-119` and inline at each builder).
- `raw-payload.ts` — consistent shape `{subject?, body_preview?, thread_id?, external_url?, ...}` so downstream readers don't have to know per-channel field names.

### Pbatch2-3 — Migration 369: extend `couple_progression_events.event_type` CHECK + `progressionEventTypeFor`
**CORRECTION (pressure-test):** I overstated the new-value list. Migration 368's CHECK already contains `tour_attended` and `tour_rescheduled` (verified at `supabase/migrations/368_progression_event_inbound_human_request.sql:123-132`), and `progression.ts:progressionEventTypeFor` already maps them. So among the proposed Calendly values, **only `tour_cancelled` is genuinely new**.

Same NAMED-CHECK-swap pattern as migration 368 (drop the now-named `couple_progression_events_event_type_check`, re-add with extended value list). **Genuine new event_type values:** `tour_cancelled` (Calendly), `crm_inquiry`, `crm_booking`, `contract_signed_csv` (HoneyBook live CSV), `inbound_sms`, `inbound_call`, `voicemail_received` (phone/voice), `meeting_completed` (Zoom). 8 new values. Plus extend `progression.ts:progressionEventTypeFor` mapper for the 8.

**Deploy-order caveat (same as 368, but 8x surface area):** the code referencing new action_types must NOT run on a DB without migration 369 applied, or the CHECK violation will fire. Fail-safe: `recordProgressionIfEligible` already swallows insert errors; misordered deploy degrades to "no progression row" not pipeline crash. With 8 values vs 368's 1, the silent-degradation surface is 8x — recommend chunking (e.g. ship 4 + 4 across two migrations if any of the action_types are landing significantly later than the rest).

### Pbatch2-4 — Decide phone-only identity gate (`hasSufficientIdentity`)
**Operator decision required.** Current rule (`mint-couple.ts:91-98`): phone-only signals FAIL the gate → drop to Fragment. For Twilio/OpenPhone SMS-primary venues this means every cold SMS becomes a fragment until cross-channel bridging mints a couple. Option A: keep as-is (doctrinally pure; SMS is enrichment-only). Option B: special-case `channel === 'sms' && classifier_verdict === 'new_inquiry'` → mint couple (mirrors Gmail `author_class === 'couple'`). The Twilio webhook already runs the intent classifier (RM-1123) so this verdict is available. Recommend Option A initially with Option B as a follow-up if Phase-3 cohort math shows SMS-primary venues drowning in fragments.

### Pbatch2-5 — Rename Zoom channel `'meeting'` → `'zoom'`
`ingestion/zoom.ts:720` passes `channel:'meeting'` to `classifyInboundIntent`. The Calendly batch Tracer adapter at `sources/calendly.ts:128-178` scans `interactions WHERE type='meeting'` — Zoom rows would collide. Use `'zoom'` consistently (matches `touchpoints.channel` docstring at mig 346:191). Update the Zoom adapter + the eventual Backwards Tracer adapter.

### Pbatch2-6 — Discovery-self-report cascade routing
Inside `captureDiscoverySource` (`discovery-source/capture.ts:~70`), add a `linkSignal({action_type:'discovery_self_report'})` call after the legacy writes. **CORRECTION (pressure-test):** grep confirms `captureDiscoverySource` has exactly **one caller today — the Calendly webhook**. The "shared with HoneyBook + intake forms" claim I made was wrong — HoneyBook is CSV-only (no webhook), intake forms don't exist as a separate code path. Pbatch2-6 closes ONLY the Calendly C8+C9 attribution gap. HoneyBook's `crm_attribution` provenance row (H3) is a SEPARATE migration, not transitively closed by this prereq.

**Separately:** there is a SECOND `attribution_events` writer at `src/lib/services/intel/referrals/resolve.ts:280` (grandfathered alongside `discovery-source/capture.ts` in the CI guard). Same writer class. Add to Pbatch2-6's scope as a parallel `linkSignal({action_type:'referral_self_report'})` call, OR explicitly defer with reason. Recommend fold-in since the pattern is identical.

### Pbatch2-7 — Three new Backwards Tracer source adapters — **MOVED TO PHASE 2 PREP (NOT a Batch-2 prereq)**
**CORRECTION (pressure-test):** I had this as a Batch-2 prereq. Verified `CONSOLIDATION-PLAN-PHASED.md` §2.5: Phase 2 reimport names "HoneyBook CSV → Calendly export → Gmail backfill" as the reimport sources, NOT walker adapters. The wipe manifest preserves `processed_sms_messages`/`processed_zoom_meetings` dedup ledgers and the provider OAuth state (`openphone_connections`, `zoom_connections`) — so post-wipe, the OpenPhone 15-min cron + Zoom daily cron RE-INGEST organically from the provider APIs (the dedup ledgers are wiped alongside `interactions` per §2.4, so the next cron tick treats every provider message as new). **Tracer walker adapters are NOT required for Phase 2 SMS/voice/Zoom re-ingestion** — the live crons handle it.

What WOULD need walker adapters: an explicit Backwards-Tracer batch sweep that re-derives couples from historical `interactions` rows that survived the wipe. But Phase 2 wipes `interactions`, so there's no historical to walk. → **Defer Pbatch2-7. Move to a "Phase 2 prep sidebar" if a Backwards-Tracer post-wipe pass is ever wanted.** Batch 2's prereq count drops from 8 to 7.

### Pbatch2-8 — Lifecycle/state-machine call coverage parity
Three adapters, three different lifecycle-bumping behaviors:
- Twilio webhook → calls `recordSmsLifecycleSignal` (writes `wedding_lifecycle_events` + bumps `weddings.first_response_at`).
- OpenPhone → DOES NOT call it. Same SMS, different bookkeeping.
- Zoom → `recordZoomLifecycleSignal` is defined in `state-machine.ts:1020` but NEVER called anywhere.

Move the call inside `linkSignal`'s post-route hook (or into the per-channel signal builder's pre-link wrapper) so it fires regardless of which adapter ingested the signal. Closes a real structural inconsistency that predates Batch 2.

---

## 3. Per-channel flip order

Sequenced by volume + risk + dependency. HoneyBook first for Rixey historical reimport bulk; Calendly second as the live tick + chokepoint violations; phone/voice/video third because they need the biggest prerequisite stack (BP1+BP2+BP4+BP6+BP7).

### Batch 2 phase A — HoneyBook (depends on: Pbatch2-1, Pbatch2-2, Pbatch2-3, Pbatch2-6)
1. **H2 partner2 (Liam Hunt class)** — first flip, smallest scope, biggest doctrinal win. Replace raw `people.insert({role:'partner2'})` at `crm-import/index.ts:~871` with `mintPerson({weddingId, role:'partner2', ...})`. P2 enrich-or-skip + mig 367 unique index close the dup class permanently.
2. **H1 partner1** — same pattern. Lower urgency (resolver upstream catches most dups) but completes the symmetry; lets us remove `crm-import/index.ts` from `check-cascade-only-writer.mjs` grandfather list for `people`.
3. **H3 interactions batch** — `linkSignalBatch` with `honeybook-csv-to-signal.ts`. Largest information-density gain — every CSV row's identity + the synthetic `crm_attribution` provenance row enter the spine.
4. **H4 booked-data-recovery `merged_into_id` UPDATE** — route through `mergeWeddings` chokepoint. Lower volume (only on cron HIGH-confidence merges) but HIGH blast radius (can collapse two real couples). Recommend tightening the HIGH-confidence threshold (`booked-data-recovery.ts` 2-partner-match + ≤30d) inside `mergeWeddings`'s own quality assertions.

### Batch 2 phase B — Calendly (depends on: Pbatch2-1, Pbatch2-3, Pbatch2-6)
1. **C3 already-routed promotion** — replace inline literal with `calendly-to-signal.ts`; P5-style capture + surface errors. Likely no behaviour change; verify via M1-style consistency audit (`scripts/verify-calendly-binding.ts`) against the branch.
2. **C8 + C9 discovery-self-report** — Pbatch2-6 lands the change in `captureDiscoverySource`; Calendly + HoneyBook + intake forms all benefit. Close together.
3. **C11 tour_cancelled chokepoint violation** — replace direct `touchpoints.upsert` with `linkSignal({action_type:'tour_cancelled'})`. **HIGHEST RISK** — only deterministic cancellation signal; D9 cohort funnel reads it. Run shadow-compare/consistency audit before flipping.
4. **C12 tour_attended chokepoint violation** — replace direct batch upsert with `linkSignalBatch`. Daily cron; idempotency on `external_id` matters.
5. **C1 `tours` insert** — last because of Qcal-2. Either add cascade mirror (if `tours` stays as event entity per plan §1.4) or rely on C3's cascade touchpoint with `tours` STAYing as an operator-UI mirror.

### Batch 2 phase C — Phone/voice/video (depends on: Pbatch2-1, Pbatch2-2, Pbatch2-3, Pbatch2-4, Pbatch2-5, Pbatch2-7, Pbatch2-8)
1. **T2 Twilio SMS** — single MIGRATE, simplest of the three. `linkSignal` inline after the legacy interactions insert, mirroring Batch-1 M1 shape.
2. **O4 OpenPhone primary interactions insert** — same pattern; pass body-extracted identifiers from `voiceExtractedIdentity` into the signal so cascade stages 6/7/8 fire.
3. **O7 OpenPhone sms-name-match `resolveIdentity` call** — rerouting through `linkSignal` closes the spine-invisibility of body-extracted identifiers. Partial-flip pattern like Batch-1 M2 (legacy resolver stays; cascade gets parallel signal).
4. **Z5 Zoom transcript** — `linkSignal` with `zoom-to-signal.ts`; body fields populated from `extractIdentityFromEmail` output. **This is where Q5's "body-stages dead on live path" gets its real test** — Zoom transcripts often carry emails + names that should fire cascade stages 6-8.
5. **Z6 Zoom body-extract dispatch** — per-signal `linkSignal` for each extracted email/phone. Tightly coupled to Z5; ship together.

---

## 4. Chokepoint violations to close (treat like Batch-1 P3 tracer fix)

Two real chokepoint violations found by enumeration:

- **C11 / C12 — Calendly outcomes** write spine `touchpoints` direct from inside `src/lib/services/identity/calendly-outcomes.ts`. **CORRECTION (pressure-test): the `check-cascade-only-writer.mjs` guard does NOT trip on these.** The guard's `ALLOWED_PATH_PREFIXES` blanket-allows `src/lib/services/identity/`, so any file under that prefix is silently exempt — verified by reading `scripts/check-cascade-only-writer.mjs:100-103,307`. The violation is doctrinally real but CI-unenforced. Two paths: (a) restructure the guard from prefix-allow to an explicit chokepoint-file allowlist (`mint-couple.ts`, `mint-person.ts`, `mint-wedding.ts`, `forwards-linker.ts`, `route-by-tier.ts`, `touchpoints-writer.ts`) so future violations inside `identity/` are caught — recommended; (b) add a per-file exclusion for `calendly-outcomes.ts` only. Either way, **the guard improvement is a Pbatch2 prereq, not a downstream wish.** Then C11/C12: replace the direct write with `linkSignal({action_type:'tour_cancelled'/'tour_attended'})`. Same class as `tracer.ts:730` (Batch 1 P3 fix; both lived inside `identity/`, both bypassed `linkSignal`).
- **C11 cancellation-to-fragment failure mode (new finding).** `linkSignal` returns `{action:'fragment', matched_couple_id:null}` for identity-poor signals. A Calendly cancellation with no resolvable identity (phone-only Calendly booking, brain-dump-imported tour, missing `inviteeEmail` payload) currently lands a `touchpoints` row direct against the matched couple. Post-flip it lands as a `fragments` row instead — **D9 cohort funnel reads tour_cancelled touchpoints; fragments aren't read.** Mitigation: when `linkSignal` returns no `coupleId` AND the cancellation has a legacy `weddingId` anchor, the flip MUST fall back to a direct `touchpoints.upsert` against that couple via `couples.source_wedding_id`. Specify this in `calendly-to-signal.ts`'s cancellation builder.

A third architectural violation worth flagging (not a code site but an inconsistency):
- **Qcal-1 — Calendly tour `signal_tier`** disagreement. Live webhook inline literal uses `'high'`; batch Tracer adapter at `sources/calendly.ts:108` uses `'highest'`. Two writers, same event, different tier. Bring into agreement in `calendly-to-signal.ts`; align the Tracer.

---

## 5. Open questions

### Per-channel
- **Qcal-1** `signal_tier` for tours: `'high'` (live shadow) vs `'highest'` (batch Tracer) — pick one in `calendly-to-signal.ts`.
- **Qcal-2** `tours` table fate. Plan §1.4 says tours becomes couple-keyed (additive) and survives as event entity. Operator confirmation: is C1 STAY-and-add-cascade-mirror, or MIGRATE-and-drop?
- **Qcal-4** `external_id` collision risk between C3 (`tour_booked`), C11 (`<uri>:cancelled`), C12 (`<external>:attended`). Three touchpoints per Calendly booking is intentional but verify cascade dedup logic doesn't collapse them.
- **Qcal-6** Q&A nested-location bug — `extractDiscoveryAnswerFromCalendly` probes both `payload.questions_and_answers` AND `payload.scheduled_event.questions_and_answers`; the C2 Q&A-merge UPDATE at line 395 only reads the top-level one. STAY-side metadata issue.
- **OQ-H1** `NormalizedSignal.channel` is free text — recommend `'honeybook'` (already in use by `anchors.ts`). No conflict.
- **OQ-H2** Per-row `external_id` for HoneyBook synthetic provenance interaction — current adapter doesn't set one. Recommend `"honeybook:provenance:" + normalized_project_name + ":" + inquiry_date_iso` for re-upload idempotency.
- **OQ-H5** Should `engagement_events.event_type = 'honeybook_*'` writes in `pipeline.ts` also dual-write to spine `touchpoints`? Batch-1 verdict for `engagement_events` was STAY (heat-only). Reaffirming for HoneyBook but flagging.
- **OQ-H6** `booked-data-recovery` HIGH-confidence merge threshold (2 partners + ≤30d) — twin-siblings-at-same-venue risk. Tighten when routed through `mergeWeddings`.
- **OQ-T1** Twilio webhook does NOT call `sms-name-match`/body-extract that OpenPhone does. Parity fix or accept difference.
- **OQ-T2** Outbound Twilio SMS code exists but no outbound send function in repo today. Outbound flip can defer until outbound-send ships.
- **OQ-O1** OpenPhone has its own "cascade" terminology (Wave-10 `triggerIdentityCascade`) distinct from spine cascade. Easy to confuse — cross-reference once spine cascade lands.
- **OQ-O2** Pass `intent_class` through `raw_payload` so the cascade matcher can consume it, or keep the gate at the call site (current shape)?
- **OQ-Z1** `matchWeddingByName` (zoom.ts:489) can mis-match couples sharing a first name. No audit/log. Route through `linkSignal` so cascade's stronger stages decide + write a `couple_merge_events` audit row on attach.
- **OQ-Z3** Zoom currently silent-drops unmatched meetings (no inbox-surface insert). Under cascade routing the unmatched signal becomes a fragment (good — Tracer-rebindable).

### Cross-channel
- **OQ-B1 (structural Phase-2 risk)** No SMS/voice/Zoom Tracer source adapter exists (Pbatch2-7). Phase 2 wipe+reimport will silently miss couples whose first contact was on these channels. Build BP4 in Batch 2 or accept the gap with operator sign-off.
- **OQ-B3** Dedup-key collision check across new channels — Twilio `MessageSid`, OpenPhone `vm_`/`call_` prefixes, Zoom `meetingId` — all distinct namespaces, but write a check.
- **OQ-B-Multi-Person** N>2 attendees (Zoom roster, group SMS). Cascade today supports 2 (partner1+partner2). Either one signal per attendee (over-counts in cohort math) or one signal with N attendees in `raw_payload` (under-counts cross-couple intersection). Operator call.

---

## 6. Honest gaps

- **Shadow-compare for new writers** — Batch 1's §1.3 v2 re-scope (under dual-write, divergence reduces to "did we add a cascade call alongside the legacy write") applies to the new dual-writes (HoneyBook H1-H3, Twilio T2, OpenPhone O4, Zoom Z5) but NOT to the two chokepoint-violation FLIPS (Calendly C11, C12 — those replace, not add). Those two need real divergence verification before flipping. The `OldPathRunner` infra is still deferred; for C11/C12 a consistency audit (M1/M8-style: do tour_cancelled / tour_attended touchpoints today bind to the same couple the cascade would bind?) is the practical instrument.
- **No volume estimates** for sequencing within phase A/B/C. Operator data needed to confirm "HoneyBook first" — Rixey backfill bulk is the assumption but live tick volumes vary.
- **`identity_reconstruction_jobs` chain** — every Calendly invitee.created queues a Wave-4 reconstruction job. After the cascade flip, the job triggers from spine touchpoint creation too. Verify no double-trigger.
- **CRM-rows-import dedup** — `crm_import_rows` (mig 335) provides recurring-CSV dedup. The Batch-2 HoneyBook flips must respect it; row-fingerprint matters when calling `linkSignal`.
- **Pre-existing chokepoint violations not in Batch 2 scope** — `check-cascade-only-writer.mjs` grandfathers 23 files. Batch 2 closes Calendly's spine writes; the others (operator-driven `unmerge`/`resolve` endpoints, lifecycle-audit, discovery-source/capture pre-Pbatch2-6) stay grandfathered with chip-down deferred to Phase 3/4. The grandfather list is the kill-list anchor.
- **Authentication on Twilio webhook** — when `TWILIO_AUTH_TOKEN` is unset, the webhook accepts unsigned bodies with only a `console.warn` (Qcal-5 analog). Out of Batch 2 scope but a real security gap.
- **`flushPendingAutoSends` (M10 equivalent) for SMS/voice** — Batch 1 discovered M10 (autonomous-send was missing both legacy interactions row AND cascade call). Verify SMS/voice outbound paths don't have a parallel hidden gap. The OpenPhone sequences runner (`sms/sequences.ts`) writes `pending_sms_drafts` but I haven't traced what happens when those drafts are sent — pre-Batch-2 audit recommended.

---

## Batch 2 done-definition

P-batch2-1/2/3/4/5/6/7/8 shipped · all ~15 MIGRATE sites flipped (HoneyBook 4 · Calendly 5 · phone/voice/video 5) · 2 Calendly chokepoint violations CLOSED (direct writes removed) · CI guards green (`check-cascade-only-writer.mjs` should no longer grandfather `webhooks/calendly/route.ts` or `calendly-outcomes.ts` for spine writes; other adapters stay grandfathered for `interactions`/`people` until Phase 3) · M1/M8-style consistency audits green on the branch for the 4 already-routed-or-new cascade signal channels (verify scripts per channel). Then Batch 3 (15 direct-writing crons) per `CONSOLIDATION-PLAN-PHASED.md` §1.2.

**Sequencing within Batch 2 — recommended order:**
1. Prerequisites Pbatch2-1/2/3 (shared infra). + **Pbatch2-9 (CI guard fix)** must land before C11/C12 flip so post-flip regressions are catchable.
2. Pbatch2-6 (captureDiscoverySource cascade routing — closes Calendly C8+C9 + cross-channel I1 referrals; does NOT close HoneyBook H3).
3. HoneyBook phase A (4 flips). **H4 (mergeWeddings dependency) deferred until mergeWeddings itself routes through cascade — see §3 note.**
4. Calendly phase B (5 flips, includes the 2 chokepoint violations with the cancellation-to-fragment fallback).
5. Pbatch2-4 (operator decision) + Pbatch2-5 + Pbatch2-8 (phone/voice/zoom enabling work).
6. Phone/voice/video phase C (5 flips: T2, O4, O7, Z5, Z6).
7. Pressure-test (operator + engineer + lazy-coding lenses) — Batch 1 set the precedent that the pressure-test typically finds 1 CRITICAL + 2-3 HIGH defects that need closing before declaring DONE.

---

## 7. Pressure-test remediation v2 (2026-05-26)

Three adversarial agents (engineer / client-operator / lazy-coding-hunter) ran against v1 of this worklist. Found 2 CRITICAL + ~8 HIGH + ~10 MEDIUM defects. All confirmed against current code. Inline corrections applied above; this section captures structural additions.

### Three new prerequisites added

**Pbatch2-9 — CI-guard restructure (was the false-claim CRIT-1).** `scripts/check-cascade-only-writer.mjs` blanket-allows `src/lib/services/identity/` via `ALLOWED_PATH_PREFIXES`. This means `calendly-outcomes.ts` (and any future `identity/*-outcomes.ts` files) can write `touchpoints` direct and the guard never trips. Restructure to a chokepoint-FILE allowlist: only `mint-couple.ts`, `mint-person.ts`, `mint-wedding.ts`, `forwards-linker.ts`, `route-by-tier.ts`, `touchpoints-writer.ts` may write spine tables. Everything else in `identity/` (including `calendly-outcomes.ts`, `resolver.ts`, `tracer.ts`, etc.) gets scanned. **Must land before C11/C12 flip** so post-flip regressions are catchable.

**Pbatch2-10 — Cancellation-to-fragment fallback for C11.** `linkSignal` returns `{action:'fragment', matched_couple_id:null}` when identity is insufficient — a Calendly cancellation with no resolvable identity becomes a fragment. D9 cohort funnel reads `tour_cancelled` touchpoints, not fragments. Spec the fallback inside `calendly-to-signal.ts`'s cancellation builder: when `linkSignal` returns no `coupleId` AND a legacy `weddingId` anchor exists, fall back to a direct `touchpoints.upsert` against the wedding's couple (via `couples.source_wedding_id`). Document the fallback as a known-narrow exception inside the cancellation-only path.

**Pbatch2-11 — H3 `linkSignalBatch` judge-budget escalation.** Default `judgeBudget` is 25 (per `forwards-linker.ts:398`). A 1000-row HoneyBook CSV with ~100 medium-confidence rows would exhaust budget after row 25; remainder skip judging → default to fragments. Spec: H3 explicitly passes a `judgeBudget` proportional to row count (e.g. `Math.min(rowCount, 200)`) and sorts rows by confidence pre-batch so the high-information rows get judged first.

### H4 sequencing correction (HIGH)

H4 (booked-data-recovery `merged_into_id` UPDATE) was sequenced after H1-H3. The pressure-test caught: H4 routes through `mergeWeddings`, but `mergeWeddings` itself is the next chokepoint debt (hand-list-drift across 32 tables per `bloom-repair-endpoint-classification.md`). Sequencing H4 ahead of a `mergeWeddings`-cascade-routing fix compounds the existing footgun. **Defer H4** until `mergeWeddings` is itself cascade-routed (which is genuinely Batch 3 or a Phase 1 follow-up). Update §3 phase A to ship only H1-H3; flag H4 for the same gate `mergeWeddings` lands behind.

### Done-definition fix (HIGH — was unverifiable)

**Replace the prior count-vague done-definition with this:** Batch 2 done = exactly **17 MIGRATE sites resolved** (5 Calendly · 4 HoneyBook · 2 Twilio · 3 OpenPhone · 2 Zoom · 1 cross-channel referrals) where "resolved" means either flipped (cascade call added/replaced) or explicitly exempted with documented reasoning (T6/O6 mintWedding-chokepoint exemption per Batch 1 §5). H4 is the only enumerated site permitted to remain "deferred-to-Batch-3" with reason.

Plus 10 prerequisites complete (Pbatch2-1 through Pbatch2-11 minus Pbatch2-7 which moved to Phase 2 prep). Plus migration 369 written (operator applies).

Plus **5 named verification scripts written + run**:
- `scripts/verify-calendly-binding.ts` — M1-style cohort coverage for Calendly tour_booked since branch creation date.
- `scripts/verify-honeybook-attribution.ts` — for H3 synthetic provenance rows: are the corresponding spine touchpoints present?
- `scripts/verify-sms-binding.ts` — for T2 + O4: percentage of new SMS interactions with a spine touchpoint-or-fragment.
- `scripts/verify-zoom-binding.ts` — for Z5: meetings with a spine touchpoint-or-fragment.
- `scripts/verify-c11-c12-cutover.ts` — post-flip cancellation rate vs prior 14-day baseline; alerts if delta > 30%.

For phases with near-zero volume on the branch (Zoom, SMS post-wipe), scripts are written + run; "consistency audit green" is acceptable as "no observed divergence in N>0 rows" with N documented. If N=0, script run is logged and gate is "verification deferred — re-run after 14 days live traffic."

Plus CI guards green: `check-cascade-only-writer.mjs` (after Pbatch2-9 restructure) returns 0 violations + `calendly-outcomes.ts` no longer exempt. Grandfather entries removed for: `webhooks/calendly/route.ts` (after C3 promotion), `calendly-outcomes.ts` (after C11+C12 flip), `discovery-source/capture.ts` + `intel/referrals/resolve.ts` (after Pbatch2-6 + I1 flip). Other Batch-2 channels (`webhooks/twilio/route.ts`, `ingestion/openphone.ts`, `ingestion/zoom.ts`, `crm-import/index.ts`) STAY grandfathered for `interactions`/`people` — those are Phase-3-limb-migration territory.

### Operator-facing additions (5 BLOCK items from the client-lens pressure test)

These must land alongside Batch 2 to avoid reproducing the May-21 trust collapse:

1. **One-paragraph "What changes for you" preface** at the top of this worklist (and any operator-facing change-log): *"Batch 2 wires 5 ingestion channels into the spine. You will see NO Tier-4 confabulation improvement (Q17/Q20/Q21 don't move until Phase 3.2/3.3). Cohort numbers on /intel may wobble during the 2-3-week phase A→B→C window as channels migrate at different times. The visible change is tour-cancelled/tour-attended Calendly signals get rewired (watch the cohort funnel for ~48 hours after that cutover) and HoneyBook re-imports deduplicate going forward (historical Liam-Hunt duplicate-partner-two rows are NOT cleaned — that's Phase 2's wipe-and-reimport)."*

2. **`/system/consolidation-status` admin surface (or top-bar banner).** Tells the operator which channels are migrated. Without this, every weird number during Batch 2 looks like a real bug. Half-day build; covers 2-3 weeks of operator confusion otherwise.

3. **Recent-merges digest at `/intel/identity-review`.** H4 deferred per above — but `mergeWeddings` itself + ad-hoc operator-driven merges still happen. Operator needs a 24h-window list of merges with one-click `undoMerge`. The wrong-merge detection signal is the single biggest operational risk and the worklist had no answer before this.

4. **HoneyBook reimport pre-flight diff.** Before a CSV import writes, show: "X rows new, Y dedup-skip via `crm_import_rows.row_fingerprint`, Z would update existing wedding." Operator confirms. Avoids surprises during recurring imports.

5. **Migration 369 + the code that uses it = single deploy unit.** CI guard refuses to ship code referencing the new action_types without 369 applied. Prevents the silent-degradation case where progression events for `tour_cancelled`/`crm_inquiry`/etc. quietly stop writing.

### Operator-facing additions (DEGRADE-tier — should ship but lower stakes)

- **Timeline estimate in §3:** Phase A ~3 days · Phase B ~3 days · Phase C ~4 days · pressure-test+fix ~2 days = ~2 calendar weeks at sustainable pace.
- **Cost projection in §6 honest gaps:** at Rixey scale the Batch-2 incremental monthly cost projects under $20/mo (Calendly webhook negligible · HoneyBook reimport one-time <$5 · OpenPhone cron ~$0.30/day worst case · all judge-budget-capped). Real at multi-venue scale — add to launch tier C gate.
- **"What you still won't have after Batch 2" list:** Tier-4 confabulations (Phase 3.2/3.3) · Q33 cross-surface contradiction (end of Phase 3) · 65 /intel routes (Phase 3) · historical Liam-Hunt duplicates (Phase 2 wipe) · Batch-1 M4/M5 partner2 name-capture provenance debt · M10 autosend historical backfill (operator runs the script) · anything visible to a logged-in operator on bloom-house (still rixey-portal-only).
- **Per-channel error pattern spec:** Twilio + Calendly webhooks must return 2xx (no throw); OpenPhone + Zoom crons need per-venue try/catch; Twilio's existing 200-with-error pattern + Calendly's empty-catch are both consistent with "no throw." Pbatch2-1's signal builders + the dual-write call sites must respect this per-channel.

### Decisions promoted from "open questions" to "must-decide-before-Phase-C"

These were §5 open questions; pressure-test flagged them as decisions Batch 2 should make rather than punt:
- **Pbatch2-4** (phone-only identity gate): for SMS-primary venues, Option A leaves them with mostly fragments on day 1 (not Phase 3). Operator must confirm Option A acceptable for Rixey-class AND specify "revisit at venue-N onboarding if SMS share > 30%."
- **OQ-T1** Twilio body-extract parity with OpenPhone: pass-through fix or accept difference; affects whether T2's signal carries body-extracted identifiers.
- **OQ-Z3** Zoom unmatched-meeting silent-drop: under cascade routing becomes a fragment (good — Tracer-rebindable). Confirm acceptable.
- **OQ-Z1** `matchWeddingByName` first-name collision risk: route through `linkSignal` + write `couple_merge_events` audit row on attach.

### Other defects acknowledged but accepted-as-is

- **OldPathRunner deferral** (Batch 1 deferred infra). C11/C12 chokepoint replacements would genuinely benefit from a real shadow-compare; the v2 fix is the `verify-c11-c12-cutover.ts` script (post-flip 48h delta-vs-baseline) instead of building the harness. Accepted scope call.
- **Zoom historical-data migration** (`type='meeting'` rows already written): tracer filter update covers it without a data migration. Documented in Pbatch2-5.
- **Concurrency race** (Calendly booking+cancel arriving milliseconds apart): `lock_and_mint_couple` advisory lock handles the mint serialization; the dual touchpoint-writes are idempotent on `(venue,channel,external_id)`. Documented in Qcal-4.

### What v1 got right (balance — the pressure-test confirmed)

- Pbatch2-5 zoom channel rename — real collision evidence (`sources/calendly.ts:128-178` scans `type='meeting'`), real Tracer-filter break risk.
- H2 (Liam Hunt class) prioritization + reuse of Batch-1 P2 doctrine — honest cross-batch leverage.
- H4 blast-radius callout (now correctly deferred per above).
- §6 honest-gap pattern on M10-equivalent for SMS/voice — flagged the unknown, asked for the audit.
