# Wave 28 — Surface classification (Stream 2)

## Files created

- `src/lib/services/email/surface-classifier.ts`
  - Exports `Surface` union type (`inbox` | `system_notification` | `crm_attribution` | `voice_capture` | `integration_event`)
  - Exports `classifySurface({ fromEmail, type, crmSource, signalClass, body })` pure rules-based fn
  - Rules mirror migration 294's backfill exactly:
    - voicemail/meeting/sms (without crm_source) -> `voice_capture`
    - crm_source set + body starts with `provider:` -> `crm_attribution`
    - inbound email from Calendly/Acuity/no-reply/donotreply/notifications@honeybook -> `system_notification`
    - else -> `inbox`

## Files modified

- `src/lib/services/email/pipeline.ts`
  - Imported `classifySurface`
  - Added post-insert fire-and-forget surface upgrade right after `interactionId` is assigned. Skips outbound (`wave9InboundFromOwn`) rows. Only updates the row when computed surface differs from default `'inbox'`. Logs `pipeline.surface_upgrade_failed` on failure. Never blocks the pipeline.

- `src/lib/services/crm-import/index.ts`
  - Imported `Surface` type
  - Added `surface?: Surface` field to `NormalisedInteractionRow` interface (per-row override)
  - Added `defaultSurface?: Surface` arg to `commitNormalisedRows` (default `'inbox'`)
  - Wired `surface: i.surface ?? defaultSurface` into the interactions insert payload

- `src/lib/services/crm-import/honeybook.ts`
  - Synthetic provenance row in `adapterInteractions.push(...)` now declares `surface: 'crm_attribution'` (body starts with `provider:honeybook`)
  - Regular HoneyBook interactions (none currently produced by the adapter — only the synthetic row is created) would stay `inbox` via the default

- `src/lib/services/crm-import/tour-scheduler.ts`
  - The per-Calendly-row synthetic interaction in `interactions.push(...)` now declares `surface: 'integration_event'` (the booking row IS the event, not an email about it)

- `src/lib/services/crm-import/web-form.ts`
  - The single web-form-submission `NormalisedInteractionRow` now declares `surface: 'integration_event'` (the submission IS the event)

- `src/app/(platform)/agent/inbox/page.tsx`
  - First interactions SELECT query (`fetchInteractions`, ~line 1420) now filters `.eq('surface', 'inbox')` in addition to `.eq('type', 'email')`. Comment block explains why and notes that the lead-detail thread loader below does NOT filter.
  - Second interactions SELECT (thread loader, line ~1778) intentionally untouched — lead-detail timelines aggregate every surface so the row still shows up where it belongs.

## Surface assignments per code path

| Code path | Surface |
|---|---|
| Email pipeline, inbound, normal sender | `inbox` (default) |
| Email pipeline, inbound from Calendly / Acuity / no-reply@* / donotreply@* / notifications@honeybook.com | `system_notification` (post-insert update) |
| Email pipeline, outbound (wave9 self-flip OR coordinator reply) | `inbox` (default, no upgrade) |
| HoneyBook adapter synthetic provenance row | `crm_attribution` |
| Calendly tour-scheduler row | `integration_event` |
| Web-form (Rixey calculator / Typeform / Jotform / Google Forms / custom) | `integration_event` |
| `/api/agent/reply` outbound send | `inbox` (default) |
| Generic-csv adapter | no interactions emitted (empty array) — N/A |
| Dubsado / Aisle Planner adapter | scaffold only — N/A |

## Open questions / notes for the reconciler

1. **Zoom ingestion (`src/lib/services/ingestion/zoom.ts:576`) writes `type:'meeting'` directly into interactions.** It is currently NOT touching the new `surface` column, so rows will land as `'inbox'` (default), then the inbox query's `.eq('type', 'email')` filter happens to exclude them from the inbox UI anyway. But conceptually these are voice captures and should set `surface: 'voice_capture'`. **This is Stream 3's domain per the off-limits list ("anything in src/lib/services/zoom/ will be created by Stream 3")**, so I left it. Recommend Stream 3 set `surface: 'voice_capture'` on its zoom + sms inserts.

2. **Brain-dump imports (`src/lib/services/brain-dump/imports.ts:235`) writes `type:'note'`.** Default `'inbox'` surface mismatches conceptually, but the inbox UI filters `type='email'` so it never shows up there. Low priority; no action needed unless future surfaces (e.g. `/agent/notes-feed`) consume it.

3. **Coordinator reply API (`src/app/api/agent/reply/route.ts:80`) writes `type='email' direction='outbound'` with no explicit surface.** Defaults to `'inbox'` — correct behavior, the outbound reply belongs in the conversation thread.

4. **HoneyBook adapter only produces ONE synthetic interaction per imported lead** (the lead-source provenance row). If/when the adapter ever ports across HoneyBook's per-project Activity Log (real CRM-recorded conversations), those rows should land with `surface: 'inbox'` (default) so they show up in /agent/inbox as the operator's historical record. No action needed today; flagging for future adapter expansion.

5. **No regex/parsing collisions with Stream 1 (`author_class`).** I did not touch the `author_class` field in any insert payload. Pipeline pre-edit already left `author_class` alongside `surface` in `interactionPayload`. CRM-adapter payloads don't include `author_class` at all (that's Stream 1's surface).

6. **No vercel.json / cron registration changes.** This wave doesn't need a backfill cron — migration 294 already backfilled at the SQL level, and the in-flight writes pick up surface at insert time.
