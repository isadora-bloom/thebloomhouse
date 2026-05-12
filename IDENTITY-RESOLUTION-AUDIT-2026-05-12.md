# Identity-resolution audit — May 12, 2026

The Justin & Sandy diagnostic (heat=0 despite 14 inbound SMS) surfaced one bug. The audit underneath found six more, plus structural fragmentation. This document is the synthesis after reading the actual code paths — not a hand-wave.

---

## 1. The chokepoint situation today

There is no single chokepoint. There are FOUR overlapping paths that each create a person + wedding, plus eight more places that bypass them with direct INSERTs.

### Two functions called `resolveIdentity`

| File | Signature | Behaviour |
|---|---|---|
| `src/lib/services/identity/resolver.ts:732` | `(venueId, signals, options)` | **Writer.** Single match return. Creates new person + wedding if no match. |
| `src/lib/services/identity/resolution.ts:378` | `(supabase, candidate)` | **Reader.** Returns `IdentityMatch[]` with tiers. No writes. |

Import callsites split by chance, not design:

| Caller | Imports | Path purpose |
|---|---|---|
| `email/pipeline.ts:39` | `identity/resolution` (reader) | Scheduling-event late-disambiguation |
| `webhooks/twilio/route.ts:40` | `identity/resolver` (writer) | Inbound SMS via Twilio |
| `ingestion/openphone.ts:884` | `identity/resolver` (dynamic) | Inbound SMS via OpenPhone |
| `ingestion/sms-name-match.ts` | `identity/resolver` (dynamic) | SMS body-email fallback |
| `ingestion/tangential-signals.ts:14` | `identity/resolution` (reader) | Pre-zero candidate scoring |
| `identity/enqueue.ts:21` | `identity/resolution` (reader) | Review-queue enqueue |
| `data-import.ts:267` | `identity/resolver` (dynamic) | CSV import |
| `crm-import/index.ts:510` | `identity/resolver` (dynamic) | CRM bulk import |

Bug class: trivial to import the wrong one by autocomplete. Both compile; they have completely different semantics.

### Three person/wedding creator paths

1. **`email/pipeline.ts:580 findOrCreateContact`** — own logic. Calls `findCanonicalPersonForEmail` from `resolver-helpers.ts`, falls back to contacts-table lookup, falls back to direct `people` INSERT. Doesn't go through `resolveIdentity` writer.
2. **`identity/resolver.ts:732 resolveIdentity`** — used by SMS, Twilio, CSV, CRM.
3. **Direct `from('people').insert()` + `from('weddings').insert()`** without any resolver — 8 places (see below).

The three paths have different match chains, different create defaults, and different post-create hooks. Same couple arriving via email vs SMS vs CSV goes through three different code paths and gets three different person-row shapes.

### Eight places that insert weddings directly

```
src/lib/services/email/pipeline.ts            (canonical-ish; uses findOrCreateContact above)
src/lib/services/identity/resolver.ts         (canonical-ish; writes via internal createWedding)
src/lib/services/crm-import/index.ts          (calls resolveIdentity sometimes; direct INSERT other times)
src/lib/services/data-import.ts               (mixed)
src/lib/services/brain-dump/imports.ts        (DIRECT — no resolver)
src/app/api/agent/reprocess-form-relays/...   (DIRECT)
src/app/api/agent/reprocess-orphans/...       (DIRECT)
src/app/(platform)/portal/weddings/page.tsx   (DIRECT FROM UI — bypasses everything)
```

The last one is concerning. A coordinator clicking "add wedding" in the portal makes a fresh row with zero identity-resolution discipline. That row will not get matched against pre-zero candidates, won't fire the cascade, and won't run the body-extract chain.

---

## 2. Timeline × channel matrix — where each combination actually lands

The Constitution's Point-Zero doctrine says "pre-zero" signals (Knot view, IG follow, Pinterest pin) become candidate_identity rows; "at-zero" (first inquiry) mints the wedding; "post-zero" appends. Cross-referencing the 11 channels Bloom ingests:

| Channel | Pre-zero arrival | At-zero arrival | Post-zero arrival | Retro / bulk import |
|---|---|---|---|---|
| **Email** | tangential-signals → candidate_identity | findOrCreateContact creates | email-exact/canonical/contacts match | crm-import + reprocess-orphans |
| **SMS (OpenPhone)** | post-Wave-28 only: creates fresh wedding; pre-Wave-28: orphan interaction | Same as pre-zero | Phone match in resolveIdentity | backfill-voice-heat (skips interactions with NULL wedding_id) |
| **Call / Voicemail** | Same as SMS | Same as SMS | Same as SMS | Same as SMS |
| **Zoom transcript** | Does NOT create wedding (zoom.ts:583) — orphans the interaction | N/A | Matches by attendee email | Backfill via processed_zoom_meetings join |
| **Twilio webhook** | resolveIdentity writer creates | Same | Phone/email match | N/A |
| **Calendly** | Webhook route creates `tours` row + calls pipeline.findOrCreateContact via the email pipeline | Same | Same | No backfill — webhook only |
| **Brain-dump operator note** | identity cascade fires post-confirm | direct INSERT in imports.ts | Body-extract + resolver (my P3) | brain-dump confirms run cascade |
| **Web form** | form-relay-parsers → crm-import → resolveIdentity sometimes | Same | Same | bulk CSV import |
| **Knot CSV / IG / Pinterest** | candidate_identity created via brain-dump confirm | (operator confirms AFTER wedding exists) | backtrack binds | brain-dump confirm fires venue-wide cascade |
| **Contract sign** | N/A (assumes wedding exists) | N/A | Match by signer email (or fail silently) | N/A |
| **Coordinator UI direct entry** | direct INSERT — no candidate check | direct INSERT — no cascade fire | N/A | N/A |

The matrix has 44 cells. The number of cells where data correctly flows through a single canonical resolver chain: about 12. The rest are partial, fragmented, or silent-fail.

---

## 3. Concrete failure modes I found by reading code (not speculation)

### F1. Heat backfill creates engagement_events but never recomputes heat_score

`scripts/backfill-voice-heat.ts:30` says explicitly:

> After this runs once, recalculateHeatScore picks up the new events on the next call (or you can force a recompute by touching the wedding).

The backfill fires engagement_events rows for historical SMS / calls / Zoom but never calls `recalculateHeatScore`. The wedding's `heat_score` column stays at 0 until a fresh post-wave-28 event lands. For a lead like Justin & Sandy where all SMS happened Apr 26 – May 5 and the wave-28 wiring went live ~May 10, heat sits at 0 indefinitely even though engagement_events rows visibly exist with `points=8`.

This is THE bug behind the heat=0 visible in the UI.

### F2. Heat backfill skips interactions with NULL wedding_id

`scripts/backfill-voice-heat.ts:196` filters `not('wedding_id', 'is', null)`. SMS that landed before any wedding existed for the couple never get heat credit, even after the wedding is created and the interactions are retroactively linked. Because the backfill is one-shot, it never re-runs to pick them up.

### F3. The orphan-rebinder I shipped (mig 313) only catches a thin slice

It targets `engagement_events.wedding_id IS NULL` whose `metadata.interaction_id` resolves to an interaction with a non-null `wedding_id`. The 33 skipped rows in your test apply run mean either:

- Their `metadata` doesn't carry `interaction_id` (legacy rows from a writer that didn't stamp it).
- The resolved interaction's `wedding_id` is ALSO null.

For Justin & Sandy specifically the rebinder is irrelevant because their events likely have `wedding_id` set (their wedding exists). The bug is F1, not orphan events.

### F4. Two `resolveIdentity` foot-gun

Already detailed. Bug class: code-completion picks the wrong import, the call compiles, returns a different shape, breaks silently.

### F5. Eight wedding-insert call sites with eight conventions

There is no `assertCouldNotExist` or "verify no candidate_identities point to this signal" gate before any of the eight insert sites. New weddings get created blind to pre-zero signals that should have bound to them. The cascade fires AFTER the create, which means the new wedding gets the binding eventually — but only if the cascade fires reliably (see F6).

### F6. Cascade-on-enrichment fires per-wedding when "newly known"; doesn't fire when wedding is freshly created

`identity/cascade-on-enrichment.ts:102 triggerIdentityCascade` is meant to fire when a wedding becomes newly-bindable — name lands, email lands, contract signer recorded. The new-inquiry path in `email/pipeline.ts:1955` (my P2 work) fires the venue-wide cascade after a fresh wedding insert, which works. But for SMS, the per-wedding cascade isn't wired into the `openphone.ts` post-create path. So Pinterest/IG/Knot signals that pre-dated the SMS-only couple don't get bound automatically.

### F7. Direct UI INSERT bypasses everything

`portal/weddings/page.tsx` calls `from('weddings').insert()` from the browser via Supabase client. No identity resolution, no cascade fire, no candidate scan. Coordinator types "Add wedding" and gets a clean room every time, even if a half-resolved candidate cluster exists for the same name.

### F8. Body-extract chain (my P3) populates extracted_identity but doesn't link

`pipeline.ts:953` and the 4 channels I wired in P3 all stamp `interactions.extracted_identity`. But for SMS / Zoom / brain-dump / web-form, after the extracted_identity lands, NOTHING fires a resolveIdentity call on the extracted email/phone. The hint sits as JSON on the interaction row.

(SMS sms-name-match.ts is an exception — it does call resolveIdentity inline on body-emails.)

So when a Zoom transcript says "yeah email me at rosalie.hoyle@gmail.com" — the extracted_identity captures it but no person row gets matched/created from that signal.

### F9. Backtrack only runs per-wedding, not on every new candidate

`identity/backtrack.ts runBacktrackForWedding` is called by the cascade. But the cascade only fires per-wedding-state-change. A fresh candidate_identity arriving via brain-dump fires the VENUE-WIDE cascade (which iterates active weddings) — but only catches weddings updated in the last 365 days. Truly cold weddings older than 365 days never get matched against new candidate scans.

### F10. No retroactive cross-couple merge sweep

`mergePeople` is called from:
- `pipeline.ts:2701` — scheduling-event identity match
- `enqueue.ts:84,94` — review-queue manual resolve
- `people-merge-aliases.ts:338` — alias merge
- `admin/identity/decision-clusters/*/accept` — operator approval
- `admin/identity/handle-merges/*/accept` — operator approval

There is no automatic sweep that says "for every venue, find people rows with the same email or phone but different IDs, and merge them." If SMS-only Justin gets created with phone +1302... and an email arrives from justin@gmail.com that creates a separate person row with no phone, they coexist as two records of the same person.

The handle-merges queue exists but only fires when handles converge across platforms (Pinterest+Knot+IG). It doesn't catch the email-only vs phone-only duplicate.

---

## 4. What Justin & Sandy reveals about the system

The Justin & Sandy lead is not one bug. It's a stack of bugs along a single timeline:

1. **Apr 26**: first SMS arrives. Pre-Wave-28 SMS pipeline existed but didn't fire heat or create weddings reliably. The interaction landed with NULL wedding_id, NULL person_id.
2. **Apr 26 → May 5**: 13 more SMS landed. Same NULL pattern.
3. **May 1**: tour happened (per SMS thread). No `tours` row created — pipeline only creates tours from email + Calendly + Zoom, never from SMS body content.
4. **~May 10**: Wave 28/30 wired voice-heat. New SMS started firing engagement_events.
5. **~May 11**: backfill-voice-heat ran, retroactively creating engagement_events for the older SMS that BY THEN had wedding_id set (the SMS got linked at some point — probably via sms-name-match or operator action). For SMS still missing wedding_id, backfill skipped them (F2).
6. **All engagement_events landed with `points=8`** — visible in the UI.
7. **Heat_score never recomputed** because backfill doesn't call recalculateHeatScore (F1).
8. **Lifecycle state machine** read the wedding as `status='inquiry'` — there's no tour row, no email engagement signal, just the dormant heat_score=0. Treats them as cold.
9. **Sage drafted "come tour"** because `has_toured_in_person=false` (P1 trigger only fires from tours.outcome='completed', which never landed for them).
10. **My P1 fix (sticky has_toured)** doesn't help retroactively — the tour row doesn't exist.
11. **My SMS scheduling extractor (Justin & Sandy bundle)** is the fix for #9 — but it only fires on NEW inbound SMS. Won't backfill past threads automatically.

The right read: every channel-timeline combination has its own subtle failure mode, and SMS-only is the channel where multiple failures stack.

---

## 5. What the system needs (ranked by leverage)

### Tier 1 — load-bearing fixes, ship immediately

**(a) Heat-recompute pass for every venue's weddings.** One-shot script + endpoint that iterates every wedding with status NOT IN (lost, cancelled, completed), calls `recalculateHeatScore`. Closes F1 + half of F2. Cost: ~5 minutes to run for a single venue. This unsticks Justin & Sandy AND every other SMS-heavy lead at Rixey.

**(b) SMS scheduling backfill — one-time pass.** Run the new `extractTourSignalsFromSmsThread` (already shipped in mig 313 work) against every venue's SMS-only weddings. Closes #9 in the Justin & Sandy stack retroactively.

**(c) Backfill-voice-heat improvement.** When backfill creates engagement_events, also queue `recalculateHeatScore` per affected wedding. One-line addition to `scripts/backfill-voice-heat.ts`. Pairs with (a).

### Tier 2 — structural — ship within a week

**(d) Rename one of the two `resolveIdentity` functions.** The reader in `resolution.ts` should be `findIdentityMatches`. The writer in `resolver.ts` keeps the name. Bug class F4 evaporates.

**(e) Wire `resolveIdentity` post-extract on the 4 P3 channels.** When body-extract finds an email in a Zoom transcript / brain-dump / web-form notes, fire `resolveIdentity` on the extracted email + flag the resulting binding back onto the interaction. Closes F8.

**(f) Cascade fire on every fresh wedding INSERT.** Move the cascade fire from email/pipeline.ts:1955 (where I added it for P2) into either a Postgres AFTER INSERT trigger on weddings OR a shared helper that the other 7 wedding-insert sites must use. Closes F5 / F6.

**(g) Retroactive cross-couple merge sweep.** Daily cron that looks for `people` rows with matching email or matching phone across different IDs in the same venue, runs through `enqueueIdentityMatch` for tier-1 exacts, lets the existing review-queue handle ambiguous cases. Closes F10.

### Tier 3 — discipline — ship over the next month

**(h) Lock down direct INSERTs.** Either remove the direct-INSERT paths in brain-dump/imports, reprocess endpoints, and portal/weddings/page.tsx, OR add a `createWedding(venueId, signals, source)` helper that those paths must call and that internally runs the resolver + cascade fire. Closes F7.

**(i) Single chokepoint test harness.** Write an integration test that feeds the same couple (email + phone + name + wedding-date) through all 11 channels in sequence in different orders and asserts they all converge to ONE person + ONE wedding. This is the regression test that proves the chokepoint actually chokes.

### Tier 4 — defer

**(j) The reader/writer split was deliberate** for some legacy reason — keep both but rename the reader. Don't merge them.

**(k) Knot/IG/Pinterest are operator-manual** per the Constitution. Don't try to wire them as APIs.

---

## 6. The one-page mental model

Identity resolution in Bloom is supposed to be: **every signal, regardless of channel or timing, converges on exactly one (person, wedding) pair via a single chokepoint.** Today it's: **every channel has its own chokepoint, each chokepoint has subtle different rules, and the synchronisation between them depends on cron sweeps and cascade triggers that have known gaps.**

The Bloom Constitution's Point-Zero forensic model is the right architecture. The implementation is leaky in 10 specific places. The leaks are fixable without a rewrite — the canonical chokepoint exists (`resolver.ts:resolveIdentity`), it's just not used everywhere.

For Justin & Sandy specifically: shipping Tier-1 (a), (b), (c) tonight fixes the visible bug. Tier-2 work prevents the next Justin & Sandy from looking like this when it arrives.
