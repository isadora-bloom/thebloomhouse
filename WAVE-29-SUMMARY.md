# Wave 29 — Multi-channel inbox (SMS / Zoom)

Stream 3 of the 2026-05-11 5-parallel-stream build. Scaffolds Twilio SMS
ingestion + Zoom meeting-transcript ingestion on top of the existing
`interactions` + `multi_channel_inbox_settings` schema (mig 295) that was
landed by the schema stream.

## What shipped

### New files (6)

- `src/lib/services/sms/twilio-signature.ts` — pure HMAC-SHA1 base64
  signature verifier for `X-Twilio-Signature`.
- `src/lib/services/zoom/signature.ts` — pure HMAC-SHA256 hex verifier
  for `x-zm-signature` + the `endpoint.url_validation` CRC helper.
- `src/lib/services/zoom/fetch-transcript.ts` — downloads + cleans a
  VTT transcript to plaintext, env-var-guarded on `ZOOM_OAUTH_TOKEN`
  with per-recording `download_token` fallback.
- `src/app/api/webhooks/twilio/route.ts` — POST handler. Verifies the
  Twilio signature, idempotency-logs to `twilio_webhook_log`, locates
  venue via `multi_channel_inbox_settings.twilio_phone_numbers`,
  resolves identity through `resolveIdentity({ phone })`, inserts an
  `interactions` row with `type='sms'`, `surface='voice_capture'`,
  `author_class='couple'` (inbound) or `'operator'` (outbound), then
  fire-and-forget calls into the lifecycle signal hook + identity
  reconstruction enqueue. Returns empty TwiML on 200.
- `src/app/api/webhooks/zoom/route.ts` — POST handler. Verifies the
  Zoom signature, handles the `endpoint.url_validation` CRC handshake,
  idempotency-logs to `zoom_webhook_log` keyed on
  `(meeting_uuid, event_type)`. On `recording.transcript_completed`
  it downloads + cleans the VTT, locates the venue by `host_email`
  against `multi_channel_inbox_settings.zoom_account_emails`, resolves
  the couple via tours scheduled within +/- 2h of the meeting, and
  inserts an `interactions` row with `type='meeting'`,
  `surface='voice_capture'`, `direction='inbound'`,
  `author_class='couple'`.
- `src/app/(platform)/settings/multi-channel/page.tsx` — per-venue
  settings UI: toggles for SMS / Zoom / voice-capture master,
  E.164-validated phone-number list, host-email list, copy-paste
  webhook URLs. Uses the existing shadcn / Tailwind / lucide patterns.

### Edited files (3)

- `src/app/(platform)/agent/audio-inbox/page.tsx` — extended to also
  query `interactions` where `surface='voice_capture'`. Added a tab
  strip (All Voice / Omi / SMS / Zoom) with counts. Omi orphans stay
  in their own table-driven section; SMS + Zoom show in a unified
  voice list with provider icons + per-row "View lead" link.
- `src/lib/services/lifecycle/state-machine.ts` — appended two new
  functions ONLY (no edits to existing logic):
  `recordSmsLifecycleSignal` bumps `weddings.first_response_at` on
  inbound SMS and logs a `wedding_lifecycle_events` row.
  `recordZoomLifecycleSignal` auto-completes the single matching
  pending tour within the meeting window. Both are best-effort and
  never throw.
- `src/components/shell/nav-config.ts` — added a `Multi-channel` entry
  in the Connections section under Sage's Brain mode.

## Files NOT touched (per stream isolation)

- `src/lib/services/email/**`
- `src/lib/services/crm-import/**`
- `src/lib/services/knowledge-gaps/**`
- `src/app/(platform)/agent/inbox/page.tsx`
- `src/app/(platform)/agent/classification-health/page.tsx`
- `src/app/(platform)/agent/sequences/page.tsx`
- `supabase/migrations/**`
- `vercel.json` / `vercel.ts`

## Required environment variables

All four are checked at the route entry. Missing creds = 503 with a
clear `{ error: 'sms_not_configured' | 'zoom_not_configured' }`
response. The settings page is functional without them so an operator
can preconfigure phone numbers + host emails ahead of provisioning.

| Variable | Required by | Purpose |
| --- | --- | --- |
| `TWILIO_AUTH_TOKEN` | `POST /api/webhooks/twilio` | HMAC key for `X-Twilio-Signature` verification |
| `TWILIO_ACCOUNT_SID` | reserved for outbound + manual API replay | not consumed by the webhook itself but Isadora needs to populate it when she sets up outbound SMS later |
| `ZOOM_WEBHOOK_SECRET` | `POST /api/webhooks/zoom` | Secret Token from the Zoom app's Feature page; verifies `x-zm-signature` + powers the CRC handshake |
| `ZOOM_OAUTH_TOKEN` | optional | Server-to-Server OAuth access token for replay / manual reprocessing when the per-recording `download_token` is not available |

## Webhook URLs to register

After deploying, register the following in each platform:

### Twilio (Console -> Phone Numbers -> Manage -> Active Numbers -> select number -> Messaging Configuration)
- **A MESSAGE COMES IN**: `https://<your-app>/api/webhooks/twilio`
- HTTP method: `POST`
- Content type: form-urlencoded (Twilio default)

### Zoom (Marketplace -> Your App -> Feature -> Event Subscriptions)
- **Event notification endpoint URL**: `https://<your-app>/api/webhooks/zoom`
- Required event types:
  - `Meeting -> Meeting has ended` (`meeting.ended`)
  - `Recording -> All recordings have completed` and / or
    `Recording -> Recording transcript files have completed`
    (`recording.transcript_completed`)
- The endpoint URL validation (CRC handshake) is handled automatically
  by the route — Zoom should show "Validated" within seconds.

## Decisions made (without asking back)

- **Twilio signature**: uses `request.url` as the canonical signed URL.
  Behind a reverse proxy / Vercel edge this may need to be adjusted if
  the public-facing URL differs from `request.url`. If Twilio starts
  returning 401s after deploy, that's the place to look — read
  `X-Forwarded-Host` / `X-Forwarded-Proto` and reconstruct.
- **Identity resolution for SMS**: phone-only. Names / emails are not
  present in an inbound SMS body. `resolveIdentity` will mint a fresh
  wedding for a new number; that's the desired behaviour per the
  Constitution (forensic identity reconstruction handles cleanup at
  the next reconstruction job, which we enqueue on inbound).
- **Identity resolution for Zoom**: looked up via `tours.scheduled_at`
  within +/- 2h of the Zoom `start_time`, preferring `tour_type` that
  contains `virtual` / `zoom` / `video`. Ambiguous matches (>1 tour in
  window) leave the interaction unmatched (`wedding_id = null`) for
  coordinator review. We deliberately did NOT mint a fresh wedding for
  unmatched Zoom transcripts — a 30-minute coordinator meeting isn't
  enough signal to confidently invent identity.
- **Outbound SMS direction detection**: if the `From` phone matches a
  registered venue number, the row is `direction='outbound'`,
  `author_class='operator'`. This handles "venue replied to a couple
  through Twilio" but doesn't yet handle "Sage auto-sent an SMS" —
  Wave 29's spec explicitly leaves outbound auto-send for a later wave.
- **Lifecycle hooks**: evidence-recording only, not state-mutating. The
  Wave 11 state machine recomputes stage from evidence on its next
  call. We bump `first_response_at` on first inbound SMS and
  auto-complete a single pending tour on Zoom transcript ingest.
  The `wedding_lifecycle_events` insert is best-effort — that table
  may not exist on all checkouts.
- **Audio Inbox tabs**: provider detection inspects
  `interactions.type` first, then falls back to
  `extracted_identity.provider` (a key future ingest paths can set).
  Omi rows that DID match a tour at ingest don't appear in this page
  at all — only orphan Omi rows (from `tour_transcript_orphans`)
  surface, consistent with the page's pre-Wave-29 purpose.

## Acceptance smoke tests (manual, post-deploy)

1. Hit `POST /api/webhooks/twilio` with no creds set → expect
   `503 { "error": "sms_not_configured" }`.
2. Hit `POST /api/webhooks/zoom` with no creds set → expect
   `503 { "error": "zoom_not_configured" }`.
3. With creds + a configured venue, send a test SMS via Twilio's
   "Send Test SMS" tool → expect an `interactions` row with
   `type='sms'`, `surface='voice_capture'`, `correlation_id` populated.
4. With creds, save a webhook in Zoom → expect Zoom dashboard to
   show "Validated" (CRC handshake worked).
5. Audio Inbox tabs render with non-zero counts after SMS / Zoom test
   events land.
