# Identity-Discovery Cascade — Stream B Summary

Date: 2026-05-12
Wedding under test: `9c18fd8b-ae27-4306-87ba-438b4f853987` (Justin & Sandy)
Venue: `f3d10226-4c5c-47ad-b89b-98ad63842492` (Rixey)

## What was built

New service `src/lib/services/identity/cascade-on-enrichment.ts` exporting one function:

```ts
triggerIdentityCascade({ venueId, weddingId, supabase, reason, correlationId? })
  → Promise<CascadeResult>
```

The cascade chains three existing services back to back in order. It is fire-and-forget — never throws, always resolves. Idempotent — re-firing on a wedding whose cascade already completed is a no-op (backtrack stamps `backtrack_attempted_at`, resolver skips resolved candidates, `recomputeFirstTouch` is naturally convergent).

Stages:

1. `runBacktrackForWedding(supabase, weddingId)` — scans every unresolved storefront candidate in the venue (Knot, WeddingWire, Pinterest, Instagram, Facebook, TikTok, HCTG) against this wedding's now-known partner names + state + inquiry window. High-confidence matches auto-link via `attribution_events`; medium goes to the coordinator review queue.
2. `resolveForWedding({ supabase, weddingId })` — re-runs the Tier-1 deterministic (exact email / phone / username) + Tier-2 AI adjudicator over every still-unresolved candidate in the venue. Catches the case where the just-enriched email or handle now hits a Tier-1 exact-email match for an anonymous shadow that already existed in candidate_identities.
3. `recomputeFirstTouch(supabase, weddingId)` — re-elects the earliest pre-inquiry `attribution_event` as `is_first_touch=true`.

Result shape:

```ts
{ backtrackHits, backtrackAutoLinked, backtrackQueued, candidatesResolved,
  candidatesDeferred, firstTouchUpdated, errors, latencyMs }
```

Every fire writes one structured log line via `logEvent` with `event_type='identity.cascade'`, outcome ok/fail, `venue_id`, `wedding_id`, `reason`, the result counts, and the first error if any. Datadog/Vercel will auto-group on `event_type`.

## Trigger points wired

| Trigger | File | Reason label | Mode |
|---|---|---|---|
| Backfill / one-shot enrichment | `scripts/enrich-from-body-emails.ts` | `enrich_from_body_emails` | Awaited per wedding (script context) |
| Live SMS body-email match | `src/lib/services/ingestion/sms-name-match.ts` (`tryMatchByBodyEmail`) | `sms_body_email_<matchedBy>` | Fire-and-forget `void`. Runs whether the resolver attached us to an existing wedding OR created a fresh one. Never blocks the SMS persist. |
| Operator manual override | `src/app/api/intel/name-evidence/[weddingId]/route.ts` (POST) | `name_evidence_override` | Fire-and-forget `void`. Runs after the override write succeeds and after the existing `logEvent` audit row. Never blocks the operator UI response. |
| Manual CLI | `scripts/cascade-for-wedding.ts --wedding=<uuid>` | `manual_cli` (or `--reason=…`) | Awaited |

The Name Evidence panel POST endpoint at `/api/intel/name-evidence/[weddingId]` is the operator-facing "Override" surface — it accepts `{ personId, firstName, lastName }`, appends a confidence-100 `manual_override` entry to `name_evidence`, stamps the people row, and now fires the cascade in the background.

No other operator-facing identity-stamping endpoint was found that needs wiring (the `decision-clusters/[clusterKey]/accept` family lives upstream in the chokepoint judge layer and writes through different surfaces; the `agent/leads/[id]/source` PATCH writes to wedding source not partner names). If a coordinator UI ever ships that stamps partner names from a different code path, point it at `triggerIdentityCascade` the same way.

## CLI output for Justin & Sandy

```
=== Identity cascade for wedding 9c18fd8b-ae27-4306-87ba-438b4f853987 ===
  venue:        f3d10226-4c5c-47ad-b89b-98ad63842492
  source:       (null)
  inquiry_date: 2026-05-05T17:07:10.942+00:00
  reason:       manual_cli

--- Result ---
  backtrack auto-linked:    0
  backtrack queued:         0
  backtrack hits total:     0
  candidates resolved:      1
  candidates deferred (AI): 15
  first_touch updated:      true
  latency:                  250877ms
  errors:                   0

--- attribution_events (live, max 20) ---
  (none for this wedding)

--- candidate_identities linked to this wedding (max 20) ---
  (none linked to this wedding)
```

Structured log line emitted:

```
{"ts":"2026-05-12T11:46:13.594Z","level":"info","msg":"identity.cascade",
 "venue_id":"f3d10226-4c5c-47ad-b89b-98ad63842492",
 "event_type":"identity.cascade","outcome":"ok","latency_ms":250877,
 "data":{"wedding_id":"9c18fd8b-ae27-4306-87ba-438b4f853987",
         "reason":"manual_cli",
         "backtrack_auto_linked":0,"backtrack_queued":0,
         "candidates_resolved":1,"candidates_deferred":15,
         "first_touch_updated":true,"error_count":0}}
```

## Sample of what the cascade actually did

Cascade fired against this wedding ran venue-wide (resolver scope). In the same 5-minute window:

- 187 Knot candidates had `backtrack_attempted_at` stamped (the sweep-skip idempotency token — they now skip the next 7 days of cron retries)
- 1 candidate was resolved by the AI adjudicator (different wedding):
  - `89373b45-5eef-41fb-95e5-53240a6bb627`, source_platform=the_knot, first_name="hyo jung" → wedding `9a3305b1-cce3-44c4-a75d-dd5dc8b1de08`, decided_by=ai, confidence=75
  - This wrote one new `attribution_events` row tier=`tier_2_wide_ai`
- 15 ambiguous candidates went to the coordinator review queue (`review_status='needs_review'`)
- 16 Sonnet adjudicator calls observed in stdout

For Justin & Sandy themselves, **zero** matches landed. The reason: at the moment of the run there were no `candidate_identities` rows in the venue with `first_name='Justin'` or `first_name='Sandy'`. The venue has 598 unresolved candidates (596 Knot + 2 WeddingWire), but the Knot proxy handles in Rixey's import don't yet have parsed first names attached. When (a) a Knot signal with the username `JustinS` arrives via the next storefront sync, OR (b) a candidate gets named via the chokepoint upstream from another SMS / email, the cascade will fire again from one of the four trigger points above and the orphan will bind.

## Open questions

1. **Justin/Sandy storefront signals were expected but absent.** Their wedding was enriched (people row has email + first names) but no tangential_signals reference them. The user's brief implied IG `@justinandsandy_wedding` + Knot `JustinS` should be present. Confirm with operator whether (a) the storefront-import paths for those platforms have not yet been run for this couple's pre-discovery window, or (b) the user meant this as a hypothetical illustration. The cascade trigger is wired correctly; once those signals exist + name-parse populates the candidate row, the cascade will pick them up.
2. **`enrich-from-body-emails.ts` cascade in dry-run.** In dry-run mode the script reports `cascade_fired=0` because no people rows actually changed. This matches expected behaviour but worth flagging in operator docs.
3. **AI cost in cascade trigger.** A live SMS persist that hits the cascade may queue ~15 Sonnet adjudicator calls (each ~2-3s, ~$0.02 each). That's a real cost but happens in the background fire-and-forget. We could add a `skipAI=true` mode to the cascade (passed through to `resolveVenueCandidates`) if cost becomes an issue at scale. For now, identity-binding moments are infrequent enough that the AI spend is worth the immediate forensic attribution. The nightly sweep already uses `skipAI=true`, so the cost is bounded to legitimate "new identity arrived" events only.
4. **Cascade latency in CLI path.** 250s for the Justin & Sandy run because the resolver invoked 16 AI calls against pending ambiguous candidates. In the live SMS path this is fine (background `void`). For an operator override in the API route the user gets the 200 OK immediately and the cascade runs detached — also fine. The CLI awaits intentionally so a backfill script can know when the side-effects are done.

## Files touched

- New: `src/lib/services/identity/cascade-on-enrichment.ts`
- New: `scripts/cascade-for-wedding.ts`
- Edited: `scripts/enrich-from-body-emails.ts` (cascade fire per enriched wedding + summary line)
- Edited: `src/lib/services/ingestion/sms-name-match.ts` (`tryMatchByBodyEmail` cascade fire after resolver match)
- Edited: `src/app/api/intel/name-evidence/[weddingId]/route.ts` (cascade fire after coordinator override)

Typecheck: `npx tsc --noEmit` clean (exit 0).
