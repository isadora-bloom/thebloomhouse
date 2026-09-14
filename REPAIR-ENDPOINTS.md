# Repair endpoints and the legacy reads that stay

W66, wave 9. Companion to `scripts/check-no-new-legacy-reads.mjs` and the
W2 ratchet baseline.

## What this document is for

The ratchet counts direct reads of the five legacy tables — `weddings`,
`people`, `interactions`, `attribution_events`, `wedding_touchpoints` —
under `src/app`. A read can be taken off that count in two ways. It can
be converted to the spine, which is the point of the exercise. Or it can
be tagged `// legacy-read-ok:` with a reason, which is a decision, not a
way to pass.

A tag says: this read is on the legacy stack on purpose, here is why, and
here is what has to be true before it goes. This file is where those
reasons live in one place, so the next person sweeping the ratchet can
see the whole set rather than finding them one comment at a time.

**A read that a page or a brain consumes does not get tagged.** If a
surface renders the number, the number goes through the canonical layer.
The open items at the bottom are the reads where that is still true and
the conversion has not happened yet; they are deliberately left counted.

## The classes

| Class | What it means | How it retires |
|---|---|---|
| `LOAD-BEARING` | A repair primitive that does real work on the legacy mirror today. The read and the write are the same rows. | When the pre-resolver corpus drains and the primitive has nothing left to repair. |
| `LEGACY-ONLY` | Reads the pre-resolver corpus, or a column the spine deliberately does not carry (message bodies, sender addresses, the venue outbox). | Message transport reads retire only if the spine ever logs messages, which is not planned. Corpus reads retire with the corpus. |
| `MIRROR-MAINTENANCE` | The route's job is to write a legacy-mirror column. The read is that write's target lookup or its tenancy guard. | When the column moves to `couples` / `touchpoints`, or the surface that edits it does. |
| `MIRROR-MINT` | Mints the legacy mirror row (through `mintWedding`) and fills its columns. `linkSignal` remains the only spine writer. | Phase F, when `weddings` becomes the audit log. |
| `AUTH` | A one- or two-column ownership lookup feeding a 403/404 decision. Nothing rendered, nothing computed. | When `admin/identity-divergence` reports zero divergence, these can flip to `couples.source_wedding_id` in one pass. Flipping before then would 404 any wedding the mirror has not caught up with. |
| `DESTRUCTIVE-GATED` | An operator wipe. Targets the legacy mirror by definition. | Never a read path; it goes when the mirror does. |
| `NO-SPINE-EQUIVALENT` | The column exists on the legacy table and nowhere on the spine. Named in the ratchet's own opt-out note. | When the column lands on `couples` / `touchpoints`. Each row below says which column. |

## The table

Counts are untagged-read sites converted in W66 / sites now tagged.

| Endpoint | Class | Reason | Retire when |
|---|---|---|---|
| `admin/attribution/classify-single` | MIRROR-MAINTENANCE | Reads and writes the same `attribution_events` row; role, confidence and evidence are its own columns. | Role classification moves onto `touchpoints`. |
| `admin/attribution/intent/classify-single` | MIRROR-MAINTENANCE | Same row in and out; `intent_class` has no spine column. | Intent class moves onto `touchpoints`. |
| `admin/attribution/intent/reclassify` | MIRROR-MAINTENANCE | The enqueue pass counts and pages the rows it then reclassifies in place. | With the classifier above. |
| `admin/attribution/reclassify-roles` | MIRROR-MAINTENANCE | As above, for role. | With the classifier above. |
| `admin/force-draft` | LEGACY-ONLY | A draft needs the inbound message text. `touchpoints` carry signals, not bodies. | Not planned — the spine is not a message log. |
| `admin/identity-divergence` | NO-SPINE-EQUIVALENT | The metric *is* weddings-against-couples. Reading only the spine would measure nothing. | When divergence is zero and the endpoint is retired. |
| `admin/identity/enrich-profiles` | LOAD-BEARING | The intel file (`couple_identity_profile`) is keyed on `wedding_id`. | When the profile is keyed on `couple_id`. |
| `admin/identity/reconstruct-bulk` | LOAD-BEARING | Reconstruct is keyed on `wedding_id`, so a page of work is a page of the legacy active set. | With the profile re-key above. |
| `admin/identity/upgrade-names` | LOAD-BEARING | Writes `people` rows keyed on `wedding_id`. | When names stop being written to `people`. |
| `admin/identity/reconstruct`, `evidence/list`, `evidence/dismiss` | AUTH | Ownership lookups only. | Mirror-complete flip. |
| `admin/identity/evidence/sources` | NO-SPINE-EQUIVALENT + LEGACY-ONLY | `inquiry_date` is a `weddings` column; `tangential_signals` binds to `matched_person_id`, so the person ids must come from `people`. **Partner names converted to the spine in W66.** | When inquiry date and the tangential binding move to the spine. |
| `admin/identity/seed-vendor-domains` | LEGACY-ONLY | Seeds vendor domains from historical sender addresses; `from_email` is a message-log column. | Not planned. |
| `admin/intel/couple-derive`, `admin/intel/referrals/extract` | AUTH | Ownership lookups only. | Mirror-complete flip. |
| `admin/intel/referrals/list` | NO-SPINE-EQUIVALENT | The `referrer_*` columns are `attribution_events` columns; the spine carries no referral evidence. | When referral evidence lands on `touchpoints`. |
| `admin/interactions/[interactionId]/author-class` | MIRROR-MAINTENANCE | `author_class` is an `interactions` column, read only to override it. | With the message log. |
| `admin/knowledge-gaps/detect` | LEGACY-ONLY | Needs the inbound message text behind a draft. | Not planned. |
| `admin/lifecycle/wedding/[weddingId]` | NO-SPINE-EQUIVALENT | The thirteen-stage machine is per wedding, not per couple (migration 278). `canonical.ts` reads the same column for the same reason. | When the machine becomes per couple. |
| `admin/lifecycle/wedding/[weddingId]/override` | MIRROR-MAINTENANCE | Reads and writes `weddings.lifecycle_stage`. | As above. |
| `admin/marketing-spend/summary` | NO-SPINE-EQUIVALENT | `persona_overlay` is an `attribution_events` column. | Wave 6B spend rollup replaces the approximation. |
| `admin/people/[personId]/sticky-state` | MIRROR-MAINTENANCE | Sticky state is a `people` column, read only to patch it. | When sticky state moves to `couples`. |
| `admin/reclass-folders-ai` | LEGACY-ONLY | The folder classifier judges message bodies. | Not planned. |
| `admin/reviews/solicit/generate` | AUTH | Ownership lookup only. | Mirror-complete flip. |
| `admin/sms/rematch` | LOAD-BEARING | Named repair primitive. Re-matches unattached SMS by rewriting `interactions.person_id` / `wedding_id`. | When SMS ingestion lands on `linkSignal` alone. |
| `admin/timeline/wedding/[weddingId]`, `.../summary` | AUTH | Ownership + tombstone lookups feeding 403/404. | Mirror-complete flip. |
| `admin/weddings/[weddingId]/ai-opt-out` | MIRROR-MAINTENANCE | The opt-out flag is a `weddings` column, read only to toggle it. | When the flag moves to `couples`. |
| `admin/weddings/[weddingId]/override-field` | MIRROR-MAINTENANCE | The coordinator override writes legacy columns, including promoting a first-touch `attribution_events` row. | When overrides target the spine. |
| `admin/weddings/[weddingId]/sticky-state` | MIRROR-MAINTENANCE | Sticky state is a `weddings` column. | With the column. |
| `agent/backfill-senders` | LEGACY-ONLY | Repair primitive for pre-resolver rows; fills `from_email` / `person_id`. | When the pre-resolver corpus drains. |
| `agent/backfill-unknown-couples` | LEGACY-ONLY | Repair primitive for nameless pre-resolver `people` rows. | Same. |
| `agent/cleanup-ghost-weddings` | LOAD-BEARING | **Rewritten in W66.** The rule moved to `src/lib/services/identity/ghost-wedding-cleanup.ts` so it can be tested. Tombstones with `non_couple_at` (migration 332); never deletes. | When the self-bug class stops occurring at ingestion. |
| `agent/confirm-booking` | MIRROR-MAINTENANCE | Transitions `weddings.status`, so it reads the row it transitions. | When booking state is spine-only. |
| `agent/dedupe-interactions` | LOAD-BEARING | Named repair primitive on the message log. | When the corpus drains. |
| `agent/drafts/[id]/regenerate` | LEGACY-ONLY | Regeneration needs the inbound message text. | Not planned. |
| `agent/inbox/prior-touches/[personId]` | AUTH | Ownership lookup only. | Mirror-complete flip. |
| `agent/leads/[id]/source` | MIRROR-MAINTENANCE | `weddings.source` is the column the inline editor edits; the re-attribution audit trail is written into `wedding_touchpoints.metadata` by `applyBacktrace` and lives nowhere else. | When source attribution moves to `touchpoints.channel` plus a spine override. |
| `agent/messages/reply` | MIRROR-MAINTENANCE | The venue reply is mirrored into the legacy inbox thread view. | With the message log. |
| `agent/people/merge`, `agent/thread-lock` | AUTH | Ownership lookups only. | Mirror-complete flip. |
| `agent/pipeline-diagnostic` | LEGACY-ONLY | The endpoint diagnoses the legacy pipeline, so it must read what the pipeline wrote. | When the legacy pipeline is switched off. |
| `agent/repair-wedding-people` | LEGACY-ONLY | Named repair primitive; rebuilds `people` rows for pre-resolver weddings. | When the corpus drains. |
| `agent/reply` | LEGACY-ONLY | Email transport. `gmail_thread_id`, `from_email` and `disclosure_version` are `interactions` columns. | Not planned. |
| `agent/reprocess-form-relays` | LOAD-BEARING | Re-parses relayed form inbounds and rewrites the rows they made. | When the corpus drains. |
| `agent/reprocess-orphans` | LOAD-BEARING | Named repair primitive; re-runs identity resolution over unattached interactions. | When the corpus drains. |
| `agent/send` | MIRROR-MAINTENANCE | The outbound is logged to `interactions`, which the inbox thread view reads. | With the message log. |
| `agent/wipe-pipeline-data` | DESTRUCTIVE-GATED | The operator wipe targets the legacy mirror by definition. | With the mirror. |
| `brain-dump/[id]/resolve` | NO-SPINE-EQUIVALENT | `sage_context_notes` is a `weddings` column; the confirm re-reads it to append without stomping a parallel note. | When Sage context moves to `couples`. |
| `couple/messages` | MIRROR-MAINTENANCE | The couple message is mirrored into the legacy thread view; the `messages` row is the source of truth. | With the message log. |
| `couple/register` | AUTH + MIRROR-MAINTENANCE | The invite check is an ownership lookup; `couple_registered_at` is a `weddings` column. **The "is this address already ours?" read converted to the spine in W66.** | Mirror-complete flip, then the column. |
| `cron` — `recompute_pending_temporal` (3 sites) | MIRROR-MAINTENANCE | Clears `heat_recompute_pending` on the rows it just recomputed. | When heat is recomputed per couple. |
| `cron` — source roll-up | NO-SPINE-EQUIVALENT | Revenue per source, and `booking_value` is a `weddings` column. Feeds `source_attribution`, which the brain reads. | **When revenue lands on the spine.** Then this becomes `getSourceAttribution`. |
| `cron` — post-event feedback | MIRROR-MAINTENANCE | Selects which weddings are three days past. **The couple name on the notification converted to the spine in W66.** | When `lifecycle_state` alone can express booked-and-completed windows. |
| `intel/auto-context/[weddingId]`, `intel/relationships/[weddingId]` | AUTH | Ownership lookups only. | Mirror-complete flip. |
| `intel/benchmark` | NO-SPINE-EQUIVALENT | `booking_value` and `first_response_at` are `weddings` columns. | When revenue and response time land on the spine. |
| `intel/candidates/link` | LEGACY-ONLY | The candidate resolver links a candidate to a legacy wedding, so it reads the row it links to. | When candidates resolve to `couples`. |
| `intel/sources/wedding-rollup` | NO-SPINE-EQUIVALENT | `booking_value` again. | With revenue. |
| `intel/voice-dna`, `onboarding/voice-dna-extract` | LEGACY-ONLY | Count sent messages. The spine logs lead-side signals, not the venue outbox. | Not planned. |
| `onboarding/identity-reconciliation/details` | LEGACY-ONLY | The screen exists to show the operator the pre-resolver corpus. | When the corpus drains. |
| `portal/event-feedback` | NO-SPINE-EQUIVALENT | `guest_count_estimate` only. **Names and date converted to the spine in W66.** | When headcount lands on the spine. |
| `portal/invite-couple` | MIRROR-MAINTENANCE | Portal credentials are keyed to the legacy wedding and its `people` rows; `couple_invited_at` is a `weddings` column. | When portal identity is keyed on `couple_id`. |
| `portal/mint-wedding` | MIRROR-MINT | Mints the mirror row through `mintWedding`, then fills its portal columns. | Phase F. |
| `portal/sage`, `portal/weddings/[id]/priorities`, `portal/weddings/[id]/finalisations` | AUTH | Ownership lookups only. | Mirror-complete flip. |
| `public/wedding-website` | NO-SPINE-EQUIVALENT | `guest_count_estimate`. | With headcount. |
| `webhooks/calendly` | MIRROR-MAINTENANCE | Fills legacy columns (`calendly_qa`, assigned consultant) on the row `mintWedding` created. | Phase F. |
| `webhooks/twilio` | MIRROR-MAINTENANCE | Records to the message log and mints through `mintWedding`. | Phase F. |

## Converted in W66, not tagged

These are gone from the legacy stack entirely. All of them go through
`src/lib/intel/readers/couple-by-wedding.ts`, the small spine reader, or
through `getVenueOverview`.

| Endpoint | Was | Now |
|---|---|---|
| `vendor-portal/[token]` | `weddings.wedding_date` + a `people` role join | `loadCoupleByWedding` + `coupleDisplayName` |
| `portal/event-feedback` | `people` role filter + dedupe-by-name | `loadCoupleByWedding` + `coupleDisplayName` |
| `couple/register` | `people` email match on the wedding | `coupleEmails(loadCoupleByWedding(...))` |
| `intel/insights` | `weddings` joined to `people` for the couple label | `loadCouplesByWeddings` + `coupleDisplayName` |
| `intel/nlq` | `weddings` head count for the sufficiency gate | `getVenueOverview().couples.total` |
| `intel/partner-counts/batch` | `weddings.partner_count` | `partnerCount(...)` off `couples` |
| `intel/reviews/solicit-gap-backfill` | `weddings` by `status` + date window | `loadCouplesByWeddingDate` |
| `intel/reviews/[id]/draft-response` | `people` first/last name match | `findCouplesByName` |
| `admin/identity/evidence/sources` | `people` partner rows | `loadCoupleByWedding` |
| `cron` post-event feedback | `people` + `dedupePeopleByName` | `loadCoupleByWedding` + `coupleDisplayName` |

`agent/cleanup-ghost-weddings` also left `src/app`: its rule now lives in
`src/lib/services/identity/ghost-wedding-cleanup.ts` behind a dependency
seam so the tombstone-never-delete guarantee has a test. Three reads left
the scanned directory that way; they were not retired, they moved, and
the tags travelled with them.

## Open — still counted, deliberately

Reads that feed a surface or a brain, where the spine carries the
equivalent and the conversion has not been done. These are **not**
tagged, so the ratchet keeps counting them. They are the next
workstream's list.

Every remaining untagged read under `src/app/api` after W66 belongs to
W64: `api/intel/attribution` (5), `api/intel/name-evidence` (7),
`api/intel/journey-narrative` (2), `api/insights/lead/**` (3),
`api/intel/agencies/[id]/leads` (2). W66 did not touch them.

The rest of the ratchet's remaining count — 75 sites — is under
`src/app/(platform)`, `src/app/_couple-pages` and `src/app/couple`,
owned by the page workstreams. This document covers `src/app/api` only.

Two further things that are off the ratchet but not off the legacy
stack, worth knowing about:

- `buildCoupleTimeline` (`src/lib/services/timeline`) reads the legacy
  tables from outside the scanned directory, so the timeline endpoints
  look cleaner than the data path behind them is.
- The cron source roll-up writes `source_attribution`, which
  `intel-brain.ts` reads. Tagged NO-SPINE-EQUIVALENT above because
  revenue is not on the spine, but it is the one tagged read in this
  file that a brain consumes. It should be the first row retired when
  `booking_value` lands on `couples`.
