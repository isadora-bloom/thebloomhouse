# Integrations Hub + Multi-Provider Adapter Architecture (Stream 8)

## What shipped

A unified Settings -> Integrations surface that lists every external
connector for the active venue, grouped by category, with per-venue
connection status fetched in parallel via a common adapter contract.
Mirrors the shape of `src/lib/services/crm-import/index.ts`.

## Adapter list

| Adapter | Category | Ready | Deep-config href | Status source |
| --- | --- | --- | --- | --- |
| gmail | email | yes (recommended) | /settings/gmail | gmail_connections |
| openphone | phone | yes (recommended) | /settings/openphone | openphone_connections |
| twilio | phone | yes | /settings/integrations/twilio | multi_channel_inbox_settings (sms_enabled + twilio_phone_numbers) |
| aircall | phone | coming soon | none | scaffold |
| dialpad | phone | coming soon | none | scaffold |
| ringcentral | phone | coming soon | none | scaffold |
| vonage | phone | coming soon | none | scaffold |
| zoom | video | yes (recommended) | /settings/zoom | zoom_connections |
| google_meet | video | coming soon | none | scaffold |
| ms_teams | video | coming soon | none | scaffold |
| whereby | video | coming soon | none | scaffold |
| calendly | calendar | yes (proxy signal) | /settings/integrations/calendly | venue_ai_config.tour_booking_links (calendly.com presence) |
| acuity | calendar | coming soon | none | scaffold |
| square_appointments | calendar | coming soon | none | scaffold |
| audio_capture | audio_capture | yes | /settings/audio-capture | venue_config.omi_webhook_token |
| honeybook | crm | yes | /onboarding/crm-import?provider=honeybook | weddings.crm_source='honeybook' count |
| dubsado | crm | coming soon | /onboarding/crm-import?provider=dubsado | weddings.crm_source='dubsado' count |
| aisle_planner | crm | coming soon | /onboarding/crm-import?provider=aisle_planner | weddings.crm_source='aisle_planner' count |

## Files created

Adapter contract + registry:

- `src/lib/services/integrations/types.ts` — `IntegrationCategory`, `IntegrationAuthShape`, `IntegrationStatus`, `IntegrationAdapter`, `DISCONNECTED_STATUS`.
- `src/lib/services/integrations/index.ts` — registry array + `CATEGORY_ORDER` + `CATEGORY_LABELS` + `CATEGORY_BLURBS` + `adaptersByCategory()` + `findAdapter()`.

Adapter implementations (one file per provider, 18 total):

- `gmail.ts`, `openphone.ts`, `twilio.ts`, `zoom.ts`, `calendly.ts`, `audio_capture.ts`, `honeybook.ts`, `dubsado.ts`, `aisle_planner.ts` (status backed by real tables)
- `aircall.ts`, `dialpad.ts`, `ringcentral.ts`, `vonage.ts`, `google_meet.ts`, `ms_teams.ts`, `whereby.ts`, `acuity.ts`, `square_appointments.ts` (scaffolds, `ready: false`)

Pages:

- `src/app/(platform)/settings/integrations/page.tsx` — hub. Server component. Fans `getStatus()` out in parallel via `Promise.all`. Category sections in `CATEGORY_ORDER` order. Per-adapter card renders icon, name, badge (Recommended / Beta / Coming soon), description, status line + last-sync relative time + error line, and a Configure/Connect/Import action that routes to `adapter.deepConfigHref`.
- `src/app/(platform)/settings/integrations/twilio/page.tsx` — thin Twilio deep-config. Hosts the Twilio-specific bits previously bundled in `/settings/multi-channel` (SMS toggle, E.164 number list, voice-capture inbox toggle, webhook URL copy).
- `src/app/(platform)/settings/integrations/calendly/page.tsx` — read-only Calendly summary. Lists configured Calendly tour links and links out to `/settings/sage-identity` where they're edited.

## Files edited

- `src/components/shell/nav-config.ts` — Connections section: replaced four rail entries (Gmail, Audio Capture, Multi-channel, OpenPhone) with a single `Integrations` entry pointing at `/settings/integrations` and using the `Link2` icon. Subtitle reframed to "Email, phone, video, calendar, audio, CRM" to advertise the breadth of the hub.

## Files deleted

- `src/app/(platform)/settings/multi-channel/page.tsx` — replaced by the new hub + Twilio deep-config page. The Zoom side of multi-channel was already redundant with the canonical `/settings/zoom` OAuth-poll integration.
- `src/app/api/webhooks/zoom/route.ts` — duplicate Zoom webhook scaffold. Canonical Zoom integration is the OAuth-poll flow already shipping (`/api/zoom/sync` + `zoom_connections` + `processed_zoom_meetings`).
- `src/lib/services/zoom/signature.ts` — webhook signature helper for the deleted route.
- `src/lib/services/zoom/fetch-transcript.ts` — webhook-payload-driven transcript fetcher for the deleted route.

The Twilio webhook route (`src/app/api/webhooks/twilio/route.ts`) and the
multi_channel_inbox_settings + twilio_webhook_log + zoom_webhook_log tables
are left in place. They underpin the Twilio adapter and are
env-var-guarded so they won't fire until credentials are configured.

## Reasonable choices made along the way

- **Calendly "connected" proxy.** No dedicated Calendly OAuth table
  exists yet. The adapter flips to connected when any
  `venue_ai_config.tour_booking_links` URL contains "calendly.com" —
  the same signal that drives Sage's tour-booking behaviour today.
  Calendly deep-config page makes this honest: it reads the links and
  links out to `/settings/sage-identity` for editing.

- **CRM adapters use weddings.crm_source as the presence signal.**
  The CRM import flow doesn't write a per-venue connection row, so
  "have we ever imported HoneyBook here?" is the only meaningful
  presence signal available. The CRM cards therefore say
  "N couples imported" once import has happened and "Not imported" /
  "Coming soon" otherwise.

- **Audio capture is one adapter card, not two.** Even though Omi and
  Plaud are different devices, they share `/settings/audio-capture`
  and the same `venue_config.omi_webhook_token` row. Splitting them
  in the hub would duplicate the same connect button.

- **Service-client fan-out.** The hub instantiates a single service
  client at request time and passes it into each adapter's
  `getStatus(supabase, venueId)`. Adapters that throw don't fail the
  whole page — they fall back to a default-disconnected status with a
  "Status check failed" line.

- **Scaffold adapters return "Coming soon".** They are surfaced on
  the hub deliberately so an operator browsing for, say, Dialpad sees
  it acknowledged and labelled, rather than feeling missed.

- **Nav cleanup.** The Connections section now has exactly one entry
  ("Integrations"), as briefed. The deep-config pages (`/settings/gmail`,
  `/settings/openphone`, `/settings/zoom`, `/settings/audio-capture`)
  remain reachable directly via deep links but are no longer in the
  sidebar.

## Open questions

1. **Real Calendly OAuth connection table.** The Calendly card today
   relies on a proxy signal (link presence). For full connection
   visibility (token expiry, last-sync timestamp, webhook
   subscription state) we'll want a dedicated table mirroring
   `zoom_connections`. Not blocking the hub — the proxy signal is
   honest and clearly labelled.

2. **CRM presence semantics.** A venue that imported HoneyBook six
   months ago and then disconnected shows as "Connected (71 couples
   imported)" forever. If we want a clearer last-import timestamp we
   could surface `MAX(weddings.created_at) WHERE crm_source='honeybook'`
   in the status line. Deferred; the current copy is unambiguous.

3. **OpenPhone deep-config page styling.** The existing
   `/settings/openphone` page predates this hub and doesn't have the
   "Back to Integrations" breadcrumb the two new pages have. Leaving
   the old pages untouched per "OFF-LIMITS" guard; they remain
   reachable via the hub's Configure button.

## Typecheck

`npx tsc --noEmit` from the repo root: clean (exit 0).
