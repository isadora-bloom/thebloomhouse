# Known bugs to pick up — for Phil

Found 2026-07-17 while Isadora was testing brain-dump upload. Both traced to root.

## Bug A — Brain-dump CSV confirm times out (504) on large files

**Symptom:** uploading a large CSV via brain dump returns `504` on
`POST /api/brain-dump/:id/resolve`.

**Root cause:** the confirm handler runs the whole import synchronously inside the
request. `src/app/api/brain-dump/[id]/resolve/route.ts` Case A calls
`routeAndProcessUpload(...)` inline — parse + adapter + raw-byte persistence +
`import_runs` audit + enqueue identity-reconstruction for every wedding touched. For a
large file (e.g. a full HoneyBook export) this exceeds the serverless function timeout,
so the gateway returns 504 even though the work may still be running server-side.

**Fix direction:** make the confirm import asynchronous. Return 202 immediately after
recording the job, then process the CSV in a background task / cron drain and report
progress back, instead of blocking the HTTP response. (The daily import cron pattern
already exists to model this on.) Interim workaround for Isadora: split the CSV into
smaller chunks so each confirm finishes under the timeout.

**Caution:** because the server may have partially imported before the 504, check
`import_runs` + row counts before re-running, so a retry doesn't double-import.

## Bug B — Couple profile card 400s (wrong column)

**Symptom:** repeated `400` on
`GET /rest/v1/couple_identity_profile?select=*&couple_id=eq.<uuid>`; the identity-profile
card on the couple page never loads.

**Root cause:** `src/app/(platform)/intel/couples/[id]/page.tsx:216` queries
`.eq('couple_id', coupleId)`, but `couple_identity_profile` has **no `couple_id`
column** — its primary key is `wedding_id` (migration 260, one row per wedding). No later
migration adds `couple_id`. PostgREST rejects the unknown column with 400.

**Fix direction:** resolve the couple's wedding first (couples row carries
`source_wedding_id`) and query the profile by `wedding_id`, not `couple_id`. Check the
sibling page `intel/clients/[id]/page.tsx` for the correct existing pattern before
copying. Low risk, isolated to the read path. Likely a leftover from the
persons→couples rename.
