# Identity Chokepoint Migration

Companion to:
- `IDENTITY-RESOLUTION-AUDIT-2026-05-12.md` (root) — the audit that catalogued the fragmentation.
- `src/lib/services/identity/mint-wedding.ts` — the canonical writer.
- `src/lib/services/identity/binder-cron.ts` — the deferred binder.
- `scripts/check-no-direct-wedding-insert.mjs` — the CI guard.

## Status

2026-05-13 G2 closure: ALL 9 grandfathered sites migrated to
`mintWedding`. The CI guard (`scripts/check-no-direct-wedding-insert.mjs`)
now has an empty `GRANDFATHERED` set — any direct
`.from('weddings').insert(` outside `resolver.ts` / `mint-wedding.ts`
fails CI.

The two pipeline.ts hot-path sites are now wrapped:
- Fresh inquiry path (was `:1947`, now `:2036` after Wave 4 inserts):
  mintWedding source=`email_pipeline` reason=`fresh_inquiry`.
- Scheduling-event path (was `:2748`, now `:2838`): mintWedding
  source=`email_pipeline` reason=`scheduling_event:<kind>`.

Both apply a post-mint UPDATE for pipeline-specific columns the
resolver doesn't carry: UTM keys, wedding_date_precision,
guest_count_estimate, estimated_guests, status upgrade (scheduling
path only), tour_date (scheduling path only), legacy source column.

Side effects of the migration:
- Wave 2C re-engagement-after-loss linking now fires on the email
  path. Previously only direct resolveIdentity callers
  (crm-import/web-form/openphone/zoom/twilio) got `previous_wedding_id`
  stamped; the email path always minted fresh.
- mint_wedding_telemetry will start accumulating rows for the email
  path. Pre-migration the table was empty because pipeline.ts didn't
  go through mintWedding. Operator can now use
  `/api/admin/mint-wedding-stats` to see real soak data.
- Telemetry-as-soak-signal becomes actually useful for future migrations.

## Goal

Collapse the 8 places that `INSERT INTO weddings` directly into one
canonical call: `mintWedding(...)`. This document is the work-list for
the next sweep — it's deliberately NOT done in the round that shipped
the helper + binder + guard, so the infrastructure can soak before any
caller is rewritten.

## Why we're doing it this way

The resolver writer already owns the full match chain (email-exact →
canonical → phone → name+date → create) plus the re-engagement-after-loss
branch logic. Every direct-INSERT site below either skips that match
chain or re-implements a slimmer version of it — that's the bug class
that minted three weddings for Reem Ibrahim on 2026-05-08.

`mintWedding` is a thin wrapper around the resolver writer plus the P2
cascade trigger plus structured logging. Migrating each site is a
30-line edit per site, NOT an architectural change.

## The 8 grandfathered call sites

Ordered by migration risk (lowest first). Each row contains the file +
line, the entry path, current behaviour, target behaviour, and the test
plan to apply when migrating.

### 1. `src/app/api/agent/reprocess-orphans/route.ts:159` — DONE 2026-05-12

- Entry path: admin one-shot — re-process orphaned interactions that
  never bound to a wedding.
- Current: builds a minimal wedding payload from the interaction's
  extracted_identity, INSERTs directly, then re-attaches the
  interaction.
- Target: call `mintWedding({ source: 'reprocess_orphans', signals: {...},
  reason: 'orphan_reattach' })`, then update interactions.wedding_id
  with the returned id.
- Test plan:
  - Run the admin reprocess endpoint on a venue with known orphan
    interactions. Verify the resulting weddings match what the binder
    cron would have produced.
  - Verify no duplicate weddings are minted when the same interaction
    is reprocessed twice (the resolver's email-exact path should hit).

### 2. `src/app/api/agent/reprocess-form-relays/route.ts:117` — DONE 2026-05-12

- Entry path: admin one-shot — re-process Knot / WW form relays that
  fell through the live pipeline.
- Current: INSERTs a wedding shaped from the relay payload.
- Target: `mintWedding({ source: 'reprocess_form_relays', signals: {...} })`.
- Test plan:
  - Run on a Rixey snapshot with known Knot relays. Verify
    re-engagement logic fires correctly for relays that match an
    existing terminal wedding.

### 3. `src/lib/services/brain-dump/imports.ts:158` — DONE 2026-05-12

- Entry path: operator brain-dump confirm — CSV / screenshot
  ingestion creates weddings for each row.
- Current: per-row INSERT after AI extraction.
- Target: `mintWedding({ source: 'brain_dump', signals: {...} })` per
  row. The brain-dump cascade fires inside `mintWedding` — remove the
  explicit triggerIdentityCascade call from the brain-dump-confirm
  path once migrated.
- Test plan:
  - Upload a fresh Knot CSV with 50 rows. Verify exactly 50 weddings
    minted (or fewer if some match existing).
  - Verify `previous_wedding_id` is stamped for any row that matches a
    terminal wedding.

### 4. `src/lib/services/data-import.ts:942` — DONE 2026-05-12

- Entry path: legacy CSV import (pre-brain-dump). Still used by
  /admin/data-import.
- Current: bulk-INSERT shaped from CSV columns.
- Target: row-by-row `mintWedding({ source: 'csv_import', signals: {...} })`
  in a `Promise.allSettled` for parallelism.
- Test plan:
  - Compare bulk-import-of-100 latency before/after. Target ceiling:
    < 30s for 100 rows.
  - Verify ordering doesn't matter (the audit caught a case where the
    bulk path created a person before its wedding existed).

### 5. `src/lib/services/crm-import/index.ts:567` — DONE 2026-05-12

- Entry path: HoneyBook / Tave / Dubsado scheduled CRM sync.
- Current: per-record INSERT after CRM-side merge dedup.
- Target: `mintWedding({ source: 'crm_import', signals: {...},
  reason: 'honeybook_sync' })`. The CRM adapter's existing
  dedup-by-external-id stays — we only swap the wedding-creation
  primitive.
- Test plan:
  - Re-run the daily Rixey HoneyBook sync on a snapshot. Verify zero
    duplicate weddings.
  - Verify external_ids.honeybook is still stamped on the people row.

### 6. `src/lib/services/email/pipeline.ts:2036` and `:2838` — DONE 2026-05-13 (G2)

- Entry path: live email pipeline — both fresh inquiries and
  scheduling-tool reconciliations.
- Current: two separate INSERTs in the same file. Site `:1947` is the
  fresh-inquiry path; `:2748` is the calendly/honeybook event
  reconciliation path.
- Target: both call `mintWedding({ source: 'email_pipeline',
  signals: {...} })`. The pipeline already has the extracted_identity
  payload at the call site, so the signal-shape conversion is
  mechanical.
- Test plan:
  - Run the email-pipeline integration test suite. ALL fixtures should
    pass without modification.
  - Run a 100-email replay through pollEmails on a Rixey snapshot.
    Verify wedding count matches pre-migration baseline.
- Risk: this is the hot path. Migrate AFTER the lower-risk sites
  (#1-#5) have soaked in production for at least a week.

### 7. `src/app/(platform)/portal/weddings/page.tsx:538` and `:562` — DONE 2026-05-12

- Entry path: coordinator manual wedding creation in the portal.
- Current: client-side form posts that INSERT directly via the
  service-role Supabase client.
- Target: replace with a server action that calls `mintWedding({
  source: 'portal_ui', signals: {...} })`. This is the highest-effort
  migration because the form submission lives in a client component;
  expect to refactor into a server action.
- Resolution: new route `src/app/api/portal/mint-wedding/route.ts` is
  the server endpoint the modal posts to. The two browser-side
  INSERTs (the original + a unique-collision retry) collapse into one
  server call; the route handles event-code retry on collision.
- Test plan:
  - Manual: create a wedding via the portal UI with each combination
    of email-only / phone-only / name+date-only signal sets. Verify
    correct resolver path fires for each.
  - Verify that creating a wedding from the portal when an existing
    person matches the email pops the "merge or create new?"
    confirmation rather than silently creating a duplicate.

## Acceptance gate

The migration is "done" when:

1. All 8 sites above are calling `mintWedding`.
2. `scripts/check-no-direct-wedding-insert.mjs` has an empty
   `GRANDFATHERED` set, only `CANONICAL` remains.
3. `resolution.ts` has the deprecated `resolveIdentity` alias removed
   and `mig 320` lands renaming it permanently.
4. The integrity-sweep `wedding_has_people` invariant is clean across
   every active venue for 7 consecutive days post-migration.

## Next-up after the migration

Once every caller is on `mintWedding`, we can:

- Add a `binder_attempted_at` column on interactions so the binder
  stops re-scanning no-signal rows each tick (current TODO in
  `binder-cron.ts`).
- Make `mintWedding` synchronous-only for write paths and use the
  binder as the sole async pathway for orphans. The current
  dual-write pattern is the safety net while the inline path is still
  live in those 8 sites.
- Land the deprecated `resolveIdentity` reader removal (mig 320).
