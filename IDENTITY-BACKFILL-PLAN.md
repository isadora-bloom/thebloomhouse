# Identity Name Backfill — operational contract

Status: shipped 2026-05-09 as part of Wave 2C of the identity-capture
redesign. Anchor design: `IDENTITY-CAPTURE-DESIGN.md` Phase 3. Anchor
audit: `IDENTITY-TRUTH-AUDIT.md` Q-A / Q-B / Q-C.

This file documents the operational contract for the
`POST /api/admin/identity/rebuild-names` endpoint that walks the
forensic record on disk and feeds every historical name signal back
through the chokepoint (`src/lib/services/identity/name-capture.ts`).

---

## What the endpoint does

For every active (non-tombstoned) wedding at the caller's venue, the
endpoint:

1. Loads every interaction, contract, brain-dump note,
   `weddings.notes`, `weddings.sage_context_notes`, and tangential
   signal attached to the wedding.
2. Extracts every name + handle signal from those rows. Sources
   covered:
   - `interactions.from_name` (Gmail / Knot relay / WeddingWire relay
     by from_email shape)
   - `interactions.extracted_identity.first_name` /
     `extracted_identity.last_name` (form-relay parser output)
   - `interactions.extracted_identity.names[]` (universal
     body-extractor output)
   - calculator-shaped emails (subject/body match) → body name pairs
     promoted to `calculator_form` source
   - `contracts.extracted_text` → contract signer pairs
   - `weddings.notes` and `weddings.sage_context_notes` → brain-dump
     name pairs
   - `tangential_signals.extracted_identity.username` → platform
     handle on the matching `Platform`
3. For each surviving signal, calls `captureNameEvidence(supabase,
   personId, signal)` (the Wave 2A chokepoint). The chokepoint
   classifies shape, scores confidence, dedupes, appends to
   `name_evidence`, and reruns the picker.
4. Returns a per-person diff (current display, proposed display,
   evidence count, source breakdown, handle count).

Per-signal attribution to a person row uses email-anchored matching
when the signal carries an email; otherwise the signal attributes to
the lone partner1 (or every person on a single-person wedding). This
mirrors how the live pipeline routes sub-zero candidates.

---

## Dry-run vs write contract

The endpoint MUST default to dry-run. The caller MUST pass
`{ "dryRun": false }` explicitly to write. Anything else (omitted,
truthy, the string "false") stays dry.

```
POST /api/admin/identity/rebuild-names
Body:
  {
    "dryRun": true | false,    // default true
    "limit":  50,              // weddings per call; 1..200
    "offset": 0                // continuation cursor
  }
```

Response:
```
{
  "ok": true,
  "dryRun": boolean,
  "processed": <weddings in this call>,
  "weddings_scanned": <same>,
  "people_processed": <persons whose display would/did change>,
  "upgrades_applied": <persons actually written; 0 on dryRun>,
  "total_in_venue": <count for paging>,
  "next_offset": <number | null>,
  "hasMore": boolean,
  "diffs": [
    {
      "personId": "...",
      "weddingId": "...",
      "currentDisplay":  { "first": "Jen", "last": "B" },
      "proposedDisplay": { "first": "Jennifer", "last": "Biaksangi", "confidence": 95 },
      "evidenceCount": 8,
      "sourceBreakdown": { "calculator_form": 1, "gmail_from_name": 5, "contract_signer": 2 },
      "handleCount": 1
    },
    ...
  ]
}
```

Dry-run runs the SAME signal extraction, but instead of calling
`captureNameEvidence` (which writes), it constructs shadow evidence
via `buildEvidenceFromSignal` and runs `pickDisplayName` locally.
The diff therefore reflects what the chokepoint WOULD do.

Coordinator workflow:

1. Run with `dryRun: true` first. Inspect `diffs`. Each diff entry
   is one person row that would move.
2. If the coordinator approves, re-run with `dryRun: false`. The
   chokepoint writes the evidence array and dual-writes
   `first_name` / `last_name` / `name_confidence`.
3. When `hasMore: true`, re-invoke with the previous response's
   `next_offset`. Repeat until `hasMore: false`.

---

## Cost

ZERO LLM calls. Pure deterministic shape extraction (regex name
pairs, JSON field reads, email-shape detectors) plus chokepoint
writes. The expensive operation is the 1-SELECT-1-UPDATE round trip
inside the chokepoint per signal. For Rixey (~670 weddings × ~3
people × ~8 signals = ~16k chokepoint calls) the run takes about
~13 minutes — the per-call cap of 200 weddings + the coordinator-side
`hasMore` loop split that across multiple invocations.

No SerpAPI, no Anthropic, no OpenAI, no third-party HTTP. The
endpoint is entirely self-contained against the venue's own data.

---

## Audit notification shape

Every wedding that moved under `dryRun: false` produces ONE
`admin_notifications` row, low priority, type `name_rebuild`. The
body lists every person upgrade in human-readable form:

```
type: name_rebuild
priority: low
title: "3 names rebuilt from historical evidence"
body: |
  Coordinator audit — Wave 2C historical-data backfill replayed every
  name signal we have on disk for this wedding (interactions, contracts,
  brain-dump notes, platform handles) through the chokepoint and the
  picker upgraded the following display names:

  Jen B → Jennifer Biaksangi (confidence 95, 8 evidence rows, 1 platform handles)
  Brett Smith → Brett Smith (confidence 100, 4 evidence rows, 0 platform handles)
  ... etc
```

One notification per wedding, NEVER one per person. A 500-wedding
sweep produces at most 500 notifications, well within the bell's
capacity. Notifications fail silently if `admin_notifications` write
errors out — the upgrade itself stands.

---

## Forensic invariants

The chokepoint (Wave 2A) preserves these invariants and the backfill
respects them automatically:

- `name_evidence` is append-only. Re-running the backfill twice
  adds NO duplicate evidence rows because the chokepoint's
  `deduplicateEvidence` rejects same-source-same-value-within-1-hour.
- `display_handle` is set once and never overwritten by the
  chokepoint. The backfill therefore can NOT clobber a
  coordinator-typed handle.
- Coordinator-typed names (confidence 100) ALWAYS win the picker.
  The backfill cannot downgrade a coordinator override.
- Tombstoned people (`merged_into_id IS NOT NULL`) are skipped at
  the loader. Their signals don't flow.

Idempotent. Safe to re-run.

---

## Failure modes + handling

- Per-wedding errors are caught and logged; the sweep continues.
  A coordinator who runs the backfill against a venue with a
  corrupted row gets a partial-success response.
- Per-signal `captureNameEvidence` failures are caught at the
  per-call level; the wedding's other signals still flow.
- Mig-255-not-yet-applied installs: the chokepoint already
  tolerates the missing columns and falls back to dual-writing
  legacy `first_name` / `last_name`. The backfill therefore works
  on pre-mig-255 environments too, with reduced evidence-trail
  fidelity.

---

## Coordination with adjacent work

- Wave 2A (committed `9bad22f`) shipped the chokepoint. This file
  calls it.
- Wave 2B (in flight) is refactoring the live capture sites. The
  backfill is independent — it operates on data already on disk.
  When 2B lands, the live pipeline starts producing fresh evidence
  arrays; the backfill remains useful for the historical-only
  weddings that never see another live signal.
- Wave 2D will ship the lead-detail evidence panel + the
  coordinator UI for the handle-merge-proposals endpoint. The
  backfill output is what those panels render.

End of plan.
