# Voice / SMS / Zoom heat-mapping wiring — Stream A summary

**Date:** 2026-05-12
**Trigger:** Live customer enriched a wedding (Justin & Sandy at Rixey) with
27+ SMS interactions; the wedding's `heat_score` stayed at 0 because
heat-mapping was email-centric. Voice channels (SMS, calls, voicemail,
Zoom) didn't fire engagement events.

---

## 1. Event types added to `DEFAULT_POINTS`

Added six new per-channel event types in `src/lib/services/heat-mapping.ts`.
All existing entries are unchanged.

| event_type | points | when it fires |
|---|---|---|
| `sms_received` | 8 | inbound SMS from couple |
| `sms_sent` | 0 | outbound SMS from venue (audit only, doesn't bump heat) |
| `call_inbound` | 12 | couple called us, no transcript hydrated |
| `call_inbound_with_transcript` | 18 | couple called us, real transcript landed |
| `voicemail_received` | 5 | voicemail FROM couple |
| `zoom_meeting_completed` | 25 | matched Zoom meeting completed with transcript |

`call_outbound` (5pts) and `voicemail_left` (3pts) already existed and
are reused for outbound venue activity.

The read-side filter in `recalculateHeatScore` already gates on
`direction='inbound'`, so the outbound `sms_sent` / `call_outbound` rows
never inflate heat. The fire-once dedup invariants (migration 159) don't
include any of these new types — voice / Zoom signals are naturally
multi-event (a thread of 27 SMS should accumulate).

---

## 2. Files touched

### `src/lib/services/heat-mapping.ts`
Added the six event-type entries to `DEFAULT_POINTS`. No other logic
changed — existing fire-once set, reopen retry, cohort damping all
unaffected.

### `src/lib/services/ingestion/openphone.ts`
- New import: `recordEngagementEvent` from `@/lib/services/heat-mapping`.
- `persistRow`: after the `interactions` insert resolves, capture the
  inserted row id (added `.select('id').maybeSingle()`) and fire the
  per-channel engagement event via `recordEngagementEvent` with
  fire-and-forget semantics. Failure logged at `warn`, never blocks
  the persist.
- New helper `pickVoiceEventType(row)` — maps `(channel, direction)` to
  the heat event type. Inbound calls escalate to
  `call_inbound_with_transcript` when `body_text` starts with `[Call]`
  (the marker the existing call hydrator stamps when summary or
  transcription text actually landed).
- `metadata` on every fired event carries
  `{ source: 'openphone', channel, openphone_message_id, interaction_id }`
  so the backfill + future audits can dedup by interaction id.
- `occurred_at` is passed through from the message so heat decay ages
  historical SMS correctly instead of treating everything as "today".

### `src/lib/services/ingestion/zoom.ts`
- New import: `recordEngagementEvent` from `@/lib/services/heat-mapping`.
- `syncMeetings`: captured the inserted interaction id via
  `.select('id').maybeSingle()` and, when a `matchedWeddingId` is
  resolved, fires `zoom_meeting_completed` (+25, inbound). Metadata
  carries `{ source: 'zoom', zoom_meeting_id, zoom_meeting_uuid, topic,
  duration_minutes, interaction_id }`. Fire-and-forget. Meetings without
  a wedding match already early-`continue` upstream in the no-transcript
  branch, so the heat block is reached only for wedding-linked meetings
  with real transcripts.

### `scripts/backfill-voice-heat.ts` (new)
One-shot script that walks every active venue's historical voice
interactions and fires the matching engagement event for each one.

- Pulls `interactions` where `surface='voice_capture'` AND
  `wedding_id IS NOT NULL` (SMS / call / voicemail from openphone).
- Pulls `processed_zoom_meetings` (NOT just `type='meeting'` — that
  over-matches Calendly tour bookings which also use `type='meeting'`
  with `surface='crm_attribution'` and would double-count tour
  attribution at +25 each).
- Idempotency: pre-fetches every engagement_event for the venue whose
  `metadata.interaction_id` is set, skips any interaction already
  represented. Also catches the fire-once unique violation (23505) as a
  belt-and-suspenders.
- Reports per-venue counts: SMS / call / voicemail / Zoom heat fired,
  plus `already_fired` and `unknown` skip counts.
- Flags: `--dry-run` (preview), `--venue=<uuid>` (scope to one venue).
- Excludes demo venues by default (filters `is_demo` true on the
  `venues` table).

---

## 3. Dry-run output (Rixey only — currently the only non-demo active venue)

```
Backfilling voice heat across 1 venue(s) (DRY RUN)
[f3d10226-4c5c-47ad-b89b-98ad63842492] scanning 1979 voice/Zoom interactions
[f3d10226-4c5c-47ad-b89b-98ad63842492] 349 interactions already have heat events
[f3d10226-4c5c-47ad-b89b-98ad63842492] sms=1979 call=0 voicemail=0 zoom=0 already_fired=0 unknown=0 (dry-run)

=== TOTAL ===
sms=1979 call=0 voicemail=0 zoom=0 already_fired=0 unknown=0 (dry-run)
Done.
```

### What the numbers mean
- **1,979 SMS rows** would fire `sms_received` / `sms_sent` events
  (1,979 wedding-linked SMS interactions at Rixey). Distribution between
  inbound and outbound depends on the `direction` field per row; the
  read-side filter in `recalculateHeatScore` drops outbound from the
  heat sum so only inbound rows actually bump scores.
- **0 calls** — at the time of this snapshot, Rixey's `interactions`
  table has zero `type='call'` rows linked to a wedding. The Quo (Open
  Phone) call sync writes these forward-going, but historical calls
  weren't backfilled to interactions yet. When that backfill runs,
  re-running this script will pick them up.
- **0 voicemails** — same situation as calls.
- **0 Zoom** — Rixey has no rows in `processed_zoom_meetings` with
  both a transcript and a matched wedding. Zoom integration is wired
  but no Zoom meetings landed in this database yet.
- **349 already-fired** in the diagnostic line refers to existing
  engagement events at this venue with `metadata.interaction_id` set
  (from the email pipeline). Of the 1,979 voice interaction IDs, none
  collided with those 349, so no SMS rows are skipped — every one is
  fresh heat credit.

### Heat-score impact preview
At +8 points per inbound SMS, decayed 0.98/day (~55% retained at 30
days), Rixey's most SMS-active leads should jump from 0 to scores in
the 50-100 range after the backfill. Justin & Sandy's wedding (27+ SMS)
should land near the top of the leaderboard.

---

## 4. Reasonable choices documented

1. **`is_active` column** doesn't exist on `venues` — the column is
   `status`. I switched the script to filter on `is_demo` IS NOT TRUE
   instead, which catches all real customers including ones in any
   non-`active` operational state.

2. **Zoom matching strategy.** `type='meeting'` over-matches because
   Calendly tour bookings also land as `type='meeting'` (with
   `surface='crm_attribution'`). I joined through `processed_zoom_meetings`
   directly so only genuine Zoom transcripts fire the +25 heat event.
   The fake interaction id `zoom_<meeting_id>` used inside the script
   for idempotency means re-running won't double-fire.

3. **`call_inbound_with_transcript` detection.** The openphone hydrator
   prepends `[Call]` to the body only when a summary or transcript
   actually landed; the no-transcript placeholder starts with "Inbound
   call" or "Outbound call". I use that marker to decide which tier
   fires. Backfill and live both use the same rule.

4. **Outbound SMS** still records `sms_sent` (+0) for symmetry — keeping
   an audit row in `engagement_events` means a future operator can
   reconstruct the full conversation timeline from one table. It costs
   nothing because the read-side direction filter drops it.

5. **Fire-and-forget semantics.** Both `openphone.ts` and `zoom.ts` use
   `void recordEngagementEvent(...).catch(...)`. A heat-write hiccup
   never blocks the ingestion. The doctrine in the brief required this.

---

## 5. `npx tsc --noEmit` result

Clean. Zero errors across the whole project.

---

## 6. Next steps after this merges

1. Run the backfill non-dry once to actually fire the 1,979 SMS events:
   ```
   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/backfill-voice-heat.ts
   ```
2. Force a heat recompute on every wedding that got new events (or wait
   for the next email / poll cycle to call `recalculateHeatScore`).
3. Verify Justin & Sandy's wedding now reports a non-zero heat score
   reflecting their 27+ SMS exchanges.
