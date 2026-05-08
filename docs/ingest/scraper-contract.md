# Bring-your-own-scraper JSON contract

**C-INGEST-4 (2026-05-08)**

If a coordinator runs an Instagram scraper, Phyllo / Hexomatic export,
or any 3rd-party tool that produces identity signals, they should be
able to drop the output into the brain dump and have it land in
`tangential_signals` like a native source.

This doc defines the **canonical JSON contract** that any external
tool can target. Output that matches this shape is auto-detected and
imported through the same pipeline as Instagram screenshots or Knot
CSVs — no custom integration work, no per-tool branch in the importer.

---

## TL;DR

Wrap your scraper output in this:

```json
{
  "source": "instagram_scraper",
  "venue_id": "<bloom_venue_id>",
  "captured_at": "2026-05-08T12:00:00Z",
  "rows": [
    {
      "signal_type": "instagram_engagement",
      "signal_date": "2026-05-07T14:23:00Z",
      "extracted_identity": {
        "first_name": "Sarah",
        "last_name": "Highland",
        "username": "@sarahhighland",
        "email_fragment": "sarah.h@",
        "phone_fragment": null,
        "location": "Charlottesville, VA",
        "partner_name": "James"
      },
      "source_context": "Liked 3 posts, saved 1, followed venue account on May 7",
      "external_id": "ig:17841401234567890"
    }
  ]
}
```

Save it as `your-tool-export.json` and drop it into the brain dump.
That's it. Hash-based dedup means re-uploading is harmless.

---

## Required envelope fields

| Field | Type | Notes |
|---|---|---|
| `source` | string | Free-text label your tool uses for itself. e.g. `phyllo`, `hexomatic`, `instagram_scraper_v2`. We surface this in the source-quality scorecard so coordinators know where signals came from. |
| `venue_id` | uuid string | Optional. If omitted, the import takes the venue_id from the brain-dump submission's auth scope. Include it only when you're targeting a specific venue from a multi-venue scraper. |
| `captured_at` | ISO 8601 timestamp | When the scraper run produced this output. Used for "is this stale?" surfacing and for retroactive analytics. |
| `rows` | array | One element per identity signal. See "Per-row fields" below. |

---

## Per-row fields

Every row maps to one `tangential_signals` insert.

### Required

| Field | Type | Notes |
|---|---|---|
| `signal_type` | enum | One of: `instagram_engagement`, `instagram_follow`, `website_visit`, `review`, `mention`, `analytics_entry`, `referral`, `other`. CHECK constraint enforced at DB layer (see migration 085). Use `other` if your tool produces something not in the list. |
| `extracted_identity` | object | At minimum one identifying field. See "extracted_identity sub-shape" below. Empty objects are rejected. |

### Recommended

| Field | Type | Notes |
|---|---|---|
| `signal_date` | ISO 8601 timestamp | When the signal happened in the real world (the IG post date, the review date). If you don't know, omit and we'll fall back to `captured_at`. |
| `source_context` | string | Free-text human description: "Liked 3 posts in the last week" or "Reviewed venue with 5 stars". Surfaced in the journey timeline so the coordinator knows what fired. |
| `external_id` | string | Stable platform-specific identifier (Instagram media id, review id). Used for dedup so re-importing doesn't double-count. Format: `<platform>:<id>` recommended but free-text. |

### Optional

| Field | Type | Notes |
|---|---|---|
| `confidence` | number 0-1 | Your tool's self-assessed confidence the signal is real (vs. noise). We multiply this with our matching confidence later. Defaults to 1. |
| `metadata` | object | Anything else your tool wants to retain. Stored verbatim in the row, not used by the matcher. Useful for round-trip debugging when a coordinator says "what did this signal say in the original tool?". |

---

## `extracted_identity` sub-shape

All fields optional. Provide whichever your tool can extract; the
matcher scores based on the subset present. **At least one** field
must be populated or the row is rejected.

| Field | Notes |
|---|---|
| `first_name` | "Sarah" |
| `last_name` | "Highland" |
| `username` | "@sarahhighland" or "sarahhighland". The matcher recognises both with-@ and without. |
| `handle` | Synonym of `username`. Use whichever your tool calls it; we treat them identically. |
| `email_fragment` | "sarah.h@" or "@gmail.com". Partial OK; matchers handle that. |
| `phone_fragment` | "555-2310" or "...2310". Last 4 digits is enough for a partial match. |
| `location` | Free-text: "Charlottesville, VA" or "Northern Virginia". |
| `partner_name` | If your tool extracts wedding-couple pairs, the other partner's name goes here. |

---

## What happens after upload

1. The brain dump POST endpoint computes a content hash of your file
   bytes. If you upload the same JSON twice in 24h, the second upload
   returns the prior entry (no double-write).
2. The CSV/JSON shape detector runs. JSON files matching this contract
   are routed to `tangential-signals-import.ts`.
3. Each row writes to `tangential_signals` with `match_status='unmatched'`.
4. The matching engine (`identity-resolution.ts`) probes against:
   - existing `people` rows (auto-merge on high-confidence email match)
   - other unmatched signals (cluster suggestions to coordinator)
   - new inbound inquiries (cross-channel attribution within 14d/30d)
5. When a wedding inquiry arrives that matches one of your signals,
   the coordinator sees a "Prior touches" chip on the inquiry card
   and Sage's draft warmth adapts accordingly.

---

## Examples

### Phyllo creator-engagement export

```json
{
  "source": "phyllo",
  "captured_at": "2026-05-08T08:00:00Z",
  "rows": [
    {
      "signal_type": "instagram_engagement",
      "signal_date": "2026-05-07T16:42:00Z",
      "extracted_identity": {
        "username": "@sarahhighland",
        "first_name": "Sarah",
        "location": "Charlottesville, VA"
      },
      "source_context": "Engaged on @rixeymanor: 3 likes, 1 save, follow",
      "external_id": "ig:17841401234567890",
      "confidence": 0.92
    }
  ]
}
```

### Hexomatic batch website-visitor export

```json
{
  "source": "hexomatic_visitor_export",
  "captured_at": "2026-05-08T07:00:00Z",
  "rows": [
    {
      "signal_type": "website_visit",
      "signal_date": "2026-05-06T19:30:00Z",
      "extracted_identity": {
        "email_fragment": "@gmail.com",
        "location": "Washington, DC metro"
      },
      "source_context": "Visited /pricing for 4:23, downloaded pricing PDF",
      "metadata": {
        "pages_viewed": ["/", "/pricing", "/gallery"],
        "session_duration_sec": 263,
        "referrer": "google.com"
      }
    }
  ]
}
```

### Custom Instagram-Story scraper

```json
{
  "source": "ig_story_viewer_log_my_tool_v3",
  "captured_at": "2026-05-08T09:00:00Z",
  "rows": [
    {
      "signal_type": "instagram_engagement",
      "signal_date": "2026-05-07T20:14:00Z",
      "extracted_identity": {
        "username": "@jamie_and_alex_2027",
        "first_name": "Jamie",
        "partner_name": "Alex"
      },
      "source_context": "Viewed venue Story 4 times in 2 days",
      "external_id": "ig_story:7782990001"
    }
  ]
}
```

---

## Errors + edge cases

- **Empty `rows` array**: returns 200 with `imported: 0`.
- **Row with empty `extracted_identity` object**: skipped, counted as
  `summary.skipped += 1`.
- **`signal_type` not in the enum list**: row rejected, error
  appended to `summary.errors`.
- **`venue_id` in envelope doesn't match auth scope**: 403.
- **JSON malformed**: 400 with parse error message.
- **File > 5 MB**: 413; split into multiple files.

---

## Versioning

This contract is **v1**. Backwards-compatible additions (new optional
fields, new enum values) ship without a version bump. Breaking
changes (renaming a required field, removing an enum value) ship as
v2 with a deprecation window of at least 90 days for v1 acceptance.

The current version is exposed at `GET /api/brain-dump/contract` so
your tool can check + adapt at runtime.

---

## Why this exists

Per the Bloom House constitution: forensic identity reconstruction is
the moat. Native API integrations with HoneyBook / Tripleseat / Knot
make us a CRM; this contract makes us a **platform**. Any tool that
produces identity signals can feed Bloom without a custom integration.

When a new Instagram scraper, Pinterest analytics tool, or wedding-
specific aggregator appears, the coordinator just emits this shape and
it lands. We don't have to ship a v1 / v2 / v3 connector for every
such tool — they ship into our open contract.
