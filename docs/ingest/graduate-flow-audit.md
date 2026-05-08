# Graduate-flow audit (C-INGEST-5)

**Date:** 2026-05-08
**Auditor:** session sweep against the live `tangential_signals` writer set
**Scope:** every code path that writes to `tangential_signals` plus every
matcher that promotes signals → people → wedding.

---

## What "graduate flow" means

A signal "graduates" when it moves through this state machine:

```
unmatched ─→ low_confidence_match ─→ suggested_match ─→ confirmed_match
                                                              │
                                                              ▼
                                                       linked to a
                                                       people row
                                                              │
                                                              ▼
                                                       linked to a
                                                       wedding row
```

C-INGEST-5 says: **every source enters this state machine at the same
gate, and crosses each transition under the same thresholds.** No
source-specific bypass; no eager-match for some sources and lazy-match
for others without an explicit reason.

---

## Writers to `tangential_signals`

The writer set at this audit date:

| Writer | Source class | Match strategy | Notes |
|---|---|---|---|
| `lib/services/ingestion/tangential-signals.ts:importIdentityCandidates` | Vision-extracted reviews + scraper JSON contract | **Eager**: calls `resolveIdentity` at insert time, sets `match_status` from returned tier | The reference path. Vision-extracted from screenshots + JSON-contract scraper output |
| `lib/services/ingestion/platform-signals.ts:219` | CSV imports via platform-detectors (Knot, WeddingWire, IG, Pinterest, Google Business, Facebook, HoneyBook, Tripleseat, Aisle Planner, Dubsado, Zola) | **Lazy**: inserts `match_status='unmatched'`, defers matching to `phase_b_sweep` cron + `identity-enqueue.ts` on new-person | Per-source signal_class is hard-coded as `'source'` on every row |
| `lib/services/crm-import/web-form.ts:884` | Web-form imports during onboarding (HoneyBook CSV, custom forms) | **Bypass**: inserts `match_status='confirmed_match'` with `matched_person_id=null` and `confidence_score=1.0` | Bandaid — see Finding 2 |

---

## Matchers / promoters

The matcher set:

| Matcher | When it fires | What it does |
|---|---|---|
| `resolveIdentity(supabase, args)` in `identity/resolution.ts` | Called by importIdentityCandidates inline; also called from email-pipeline on new contact | Returns top-N candidate matches with tier (high/medium/low) + confidence |
| `identity-enqueue.ts:enqueueIdentityMatch` | Fires when a new `people` row is created (post-zero attribution) | Probes the unmatched signal pool; promotes high-tier matches |
| `phase_b_sweep` cron | Daily 04:45 UTC | Runs candidate-clusterer + candidate-resolver across the whole pool; back-matches signals against existing people |
| Lead-side `email-pipeline.ts` `findOrCreateContact` | Inbound email → person creation | Triggers identity-enqueue on the new person |

---

## Findings

### Finding 1 — CSV imports lazy-match by design (acceptable)

`platform-signals.ts` inserts every row as `unmatched` and relies on
`phase_b_sweep` (daily 04:45 UTC) to back-match against the people
pool. This is a deliberate pattern — bulk imports of 1000+ rows would
otherwise issue 1000 `resolveIdentity` calls inline, blocking the
import. The matcher is **the same** matcher that vision-extracted
signals use; only the timing differs.

**Verdict:** consistent. Same threshold, same matcher, just deferred.

**Latency note:** a coordinator uploading a Knot CSV does NOT see
matches surface until the next 04:45 UTC sweep (worst case ~24h).
This is below the bar to fix today (matches eventually surface), but
worth flagging as a UX nit. A "match now" button on the import
summary page would close the window without the bulk-call cost.

### Finding 2 — web-form import writes `confirmed_match` without a person link (BUG)

`web-form.ts:884` writes:

```ts
match_status: 'confirmed_match',
matched_person_id: null,
confidence_score: 1.0,
```

This violates the state-machine contract — `confirmed_match` should
be unreachable without a `matched_person_id`. Two consequences:

1. The signal-quality scorecard counts these as confirmed matches and
   inflates the confirmed-match rate. Real confirmed matches sit at
   ~30%; web-form imports falsely report 100%.
2. Downstream readers (e.g. `/intel/sources/parity`) cannot follow the
   FK to a person, so they silently skip these rows when computing
   "this signal led to that wedding" attribution.

**Verdict:** bug. Fix at next batch — should write `unmatched` (and
let phase_b_sweep promote when the inquiry's person row is created),
OR flow the actual person-creation step through to populate
`matched_person_id` properly.

### Finding 3 — `signal_class` is hard-coded per writer (intentional)

Every writer hard-codes `signal_class` ('source' for platform-signals,
'touchpoint' for web-form, etc.). This is documented inline and
matches the T5-Rixey-BBB attribution model — discovery touches vs
interaction touchpoints are categorically different. Not a bug.

### Finding 4 — vision and scraper-JSON are eager-match consistent

`importIdentityCandidates` is the canonical eager-match writer. Both
the vision extraction path (line 522 in /api/brain-dump/route.ts) and
the new scraper-JSON path (line ~510, C-INGEST-4) call it. Same
thresholds, same `resolveIdentity`, same idempotency window.

**Verdict:** consistent.

---

## Recommendations

1. **Fix Finding 2** — web-form import should write `unmatched` not
   `confirmed_match`. The latter is reserved for rows with a real
   `matched_person_id`. Estimated effort: one-line change in
   web-form.ts + a backfill query against existing rows.

2. **Add a "Match now" affordance on CSV import summaries** — runs
   `phase_b_sweep` for just the venue's recent unmatched signals so
   the coordinator sees matches surface on import, not next morning.
   Estimated effort: 1 hour (sweep already exists).

3. **Add a graduate-flow integration test** — fixture: same identity
   arrives via vision, scraper-JSON, and CSV; assert all three land
   in confirmed_match within the expected window. Closes the audit
   loop and prevents drift on future writer additions.

4. **Lock writer registry** — when a future engineer adds a 12th
   detector or a new ingestion path, they should be required to
   choose between `importIdentityCandidates` (eager) and the
   `platform-signals.ts` pattern (lazy + sweep). A new shared helper
   `writeAndOptionallyMatch({...})` that takes a `matchMode` param
   (`'eager' | 'lazy'`) would force the choice explicit.

---

## Sign-off

The graduate flow is **substantially consistent** at this audit date.
Two findings worth tracking:

- Finding 2 is a real bug to fix.
- Finding 1 is a documented pattern, not a bug.
- Findings 3 and 4 are clean.

Future audits should re-run this sweep when a new writer is added
(grep for `from('tangential_signals').insert`) or when the matcher
thresholds change in `identity/resolution.ts`.
