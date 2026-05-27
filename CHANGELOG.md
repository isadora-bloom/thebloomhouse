# Bloom House — Changelog

Operator-readable record of what shipped, when, and what it means.

## Maintenance note

This file is a **release note**, not auto-generated. Every meaningful
ship (a phase, a batch, a major fix) needs a new entry here. The
companion surface at `/system/consolidation-status` shows the same
content for the in-flight consolidation — when you add a new entry
here, update that page in lockstep, or the operator gets two different
stories from two surfaces.

Entries are reverse-chronological. Sections per entry:

- short prose paragraph(s) per chunk
- "What changes for the operator" (plain-language — same content as
  the parallel section on `/system/consolidation-status`)
- "Operator actions queued" (parallel to the same section on the page)

Future maintainers: do not let this file drift from the page. If the
two disagree, the answer is "edit both," not "delete one."

---

## 2026-05-27 — Tour outcome classifier silent-failure fix

Two-line bug, big impact. Both `src/lib/services/tour/outcome-classifier.ts` and `src/lib/services/lifecycle/sweep.ts` queried `venues` with `.eq('is_active', true)` — but the `venues` table has a `status` column ('active' | 'paused' | 'churned'), not an `is_active` boolean. Every cron run errored at the preflight venue lookup with PostgreSQL `42703: column "venues.is_active" does not exist` and returned an error response before touching a single tour.

**Operator-visible impact at Rixey**: 53 past-due 'pending' tours sat unclassified across 60+ days. Tour Tracking dashboard showed near-0% conversion. Same shape would hit every venue onboarded with backfill tour data going forward.

### What landed

- `src/lib/services/tour/outcome-classifier.ts` — `.eq('is_active', true)` → `.eq('status', 'active')`.
- `src/lib/services/lifecycle/sweep.ts` — same fix.

Both files keep a comment pointing at `filterActiveVenues` in `cost-ceiling.ts` as the preferred centralised helper for new code.

### Verification against prod (2026-05-27)

Ran `classifyTourOutcomes(supabase, rixey)` directly with the fix in place:
- Scanned: 331 past-due 'pending' tours
- **Completed: 329** (the bulk — past-due tours where no cancel/no-show evidence was found)
- Cancelled: 2 (cancellation walk caught explicit signals)
- No show: 0
- Skipped: 0
- Errors: []

Tour Tracking will now reflect actual conversion numbers for the first time at Rixey. The post-tour sequence cron only picks up tours from the last 14 days, so this catch-up doesn't trigger email spam — only the 7 already-seeded couples will get T+24h thank-yous on the next hourly tick.

### What changes for the operator

- The daily `tour_outcome_classifier` cron (06:00 UTC) starts working for the first time on the next tick.
- Tour Tracking dashboard suddenly displays real conversion rates. May feel like a jump — it's actually the corrected baseline.
- Every other venue onboarded with HoneyBook/Calendly backfill will get the same backfill catch-up on their next cron run.

## 2026-05-27 — Calendly custom-questions parser (source attribution fix)

Operator-reported 2026-05-27: Calendly tour-booking notifications arrive
at `info@rixeymanor.com` from `notifications@calendly.com` carrying a
structured Questions block in the HTML body. Rixey's Calendly form asks
six custom questions including **"Where did you first hear about us?"** —
the single most valuable per-couple source signal available for
Calendly-direct bookings. Bloom ingested the notifications but did not
extract the Questions block, so every Calendly-direct couple landed as
`source=direct/unknown` or `source=calendly` even when they wrote
"Google" or "The Knot" in the form.

Verified examples from Isadora's Gmail:
- Glascow/Minette → "Google" (logged as direct)
- Jennifer Nguyen → "The Knot" — bypassed the Knot inquiry flow and
  booked Calendly directly (logged as direct, losing Knot attribution)
- Erin B → "Google" (logged as direct)

This is a systematic blind spot: a meaningful chunk of "direct"
attribution is actually Knot/Google/Instagram/etc. that came through
Calendly.

### What landed

- `src/lib/services/ingestion/calendly-questions-parser.ts` — HTML-first
  parser for the Questions block. Defensive across three Calendly
  markup shapes (`<strong>Label</strong><p>Answer</p>`,
  `<strong>Label</strong><br>Answer<br>`, plain-text
  `Label\nAnswer`). Returns `{}` on parse failure, never throws.
  Typed accessors with fuzzy label matching:
  `getCalendlyPartnerName / PartnerEmail / Phone / EventDate /
  GuestCount / Source / SourceRaw / PackageInterest /
  BuiltCalculator`. Source canonicalizes to the same vocabulary as
  `IntentVerdict.signals.source` (`the_knot`, `wedding_wire`,
  `google`, `instagram`, `pinterest`, `facebook`, `tiktok`, `zola`,
  `here_comes_the_guide`, `referral`, `website`, `walk_in`,
  `calendly`, `wedding_pro`, `other`). One-shot
  `extractCalendlyQuestions(html)` returns a typed bundle.
- `src/lib/services/ingestion/scheduling-tool-parsers.ts` — wired the
  HTML parser as a defense-in-depth backstop. The plain-text path stays
  load-bearing; HTML extraction fills `extras.sourceCanonical` /
  `extras.builtCalculator` and fills any field the plain-text path
  returned null for. Strict additive, never destructive.
- `src/lib/services/identity/calendly-to-signal.ts` — Q&A scan now
  extracts the source answer, and an HTML-body fallback runs the parser
  when `payload.html_body` / `body` / `notification_html` is present.
  Canonical source + literal source land in
  `raw_payload.source_canonical` / `source_literal` so the Tracer-side
  signal carries the attribution forward.
- `src/lib/services/email/pipeline.ts` — three patch sites:
  - Step 2.5: when a Calendly scheduling event carries
    `extras.sourceCanonical`, patch `unifiedVerdict.signals.source` +
    `extracted_facts.source_mentioned` + `classification.extractedData.
    source` (only when current value is null OR equals `'calendly'`).
  - `weddings.update({source: ...})` — prefer the form canonical over
    the channel name `'calendly'`.
  - `recordEngagementEventsBatch` initial_inquiry metadata — same
    preference, carries channel + source_literal +
    `source_from_calendly_questions: true` flag for forensics.
- `src/lib/services/ingestion/__tests__/calendly-questions-parser.
  test.ts` — 32 tests covering the three operator-verified fixtures
  (Glascow/Google, Jennifer Nguyen/The Knot, Erin B/Google) plus edge
  cases (multi-paragraph answers, HTML entities, missing block, unknown
  free-text → 'other', plain-text fallback, reworded question variants,
  guest-range midpoint, date-format variants, malformed input no-throw).
  All 32 pass.
- `scripts/backfill-calendly-source.ts` — backfill script. Loads
  Calendly notifications in the venue's last N days (default 60), runs
  the parser, plans patches:
  - `interactions.extracted_facts.source_mentioned` (literal)
  - `interactions.extracted_facts.signals.source` (canonical)
  - `weddings.source` (only when null OR placeholder:
    `calendly`/`direct`/`other`/`unknown`)
  - `couples.source` mirror (same placeholder rule)
  Strict additive — never overwrites a real attribution. `--venue-id`
  REQUIRED. `--apply` required to write. `--allow-prod` required when
  the URL points at the prod ref. Same `BRANCH_URL` / `BRANCH_KEY` env
  pattern as the other scripts.

### What changes for the operator

The day a new Calendly tour booking arrives where the couple answered
"Where did you first hear about us?", the canonical source lands on
the wedding / couple / interaction row at ingest time. The /intel/
sources rollups and source attribution surfaces will credit Knot /
Google / Instagram / etc. instead of grouping every Calendly-direct
booking under direct/unknown.

### Operator actions queued

- After the next batch of real Calendly bookings flows in, run the
  backfill in dry-run mode to confirm the parser picked up the
  Questions block, then `--apply` to land the canonical source on the
  existing rows.
- Dry-run against prod 2026-05-27 found 0 backfillable rows because the
  Rixey wipe on 2026-05-14 cleared historical Calendly bookings — the
  4 notifications in the last year are all verification-code emails or
  developer surveys, no real bookings yet. The parser is verified
  working via the test fixtures.

---

## 2026-05-27 — Knot visitor-activity ingestion + verification-visit signal

Operator-shared 2026-05-27: The Knot exports a CSV called
`<Venue>-visitor-activities (N).csv` with five columns
(Action Taken / Visitor Name / Date of Visit / City / State) covering
every Storefront View, Save, Message, Click to Website, and Click to
Social. Rixey's last 12 months: 697 distinct visitors, 361 messagers,
~104 save-but-never-message, ~54 click-to-website. Bloom today only
sees the messagers (because Knot only forwards Message actions as
relay emails — and even some of those land only in the Knot dashboard
inbox, never in Gmail). Saves, views, and website clicks were
invisible.

The architectural insight: Knot is not just a lead **source**, it is
a **verification layer**. ~70% of Knot messagers viewed the profile
first. Couples already in the pipeline come back to view Knot to
verify — a heat signal Bloom never had visibility into.

Doug L. is the operator-named canary: 13 Knot actions including a
Message in April, but no email anywhere in Rixey's pipeline. The CSV
import + cascade promotes him to a record at least.

### What landed

- `supabase/migrations/377_knot_visitor_activity.sql` — new
  `knot_visitor_activity` table (one row per action, idempotent on
  `row_fingerprint = sha256(venue|name|action|when|city|state)`).
  Backreferences `person_id` + `couple_id` populated by the matcher
  sweep. Standard venue-scoped RLS + demo-anon read. Five indexes
  cover the live read patterns. **NOT applied — operator applies via
  Supabase dashboard.**
- `src/lib/services/crm-import/knot-visitor-activity.ts` — CSV
  importer. Parses the five columns, classifies the Action Taken
  string to the canonical enum, computes `row_fingerprint`, bulk
  upserts with `onConflict: 'venue_id,row_fingerprint',
  ignoreDuplicates: true`. Re-uploading the same export is a no-op.
- `src/lib/services/crm-import/knot-visitor-activity-adapter.ts` —
  CrmAdapter wrapper so the operator can hit it from
  `/onboarding/crm-import`. Follows the same out-of-band-payload
  pattern as the sibling `storefront-activity` adapter (parse returns
  `rows:[]` + the real payload on `knotVisitorRows`). Commit re-runs
  the importer with the real venue id and triggers the matcher sweep.
- `src/lib/services/identity/knot-visitor-match.ts` — identity
  matcher. For every unbound row, searches `people` by first name +
  last initial (Knot redacts surnames to one letter). Scores
  candidates by temporal proximity (±24mo around wedding_date) +
  existing source attribution (`source='the_knot'` adds +30).
  Exactly-one strong candidate → bind directly. Multiple strong
  candidates → write `candidate_matches` rows (medium tier) for
  operator review in `/intel/identity-review`. No candidate + action
  is `message` / `storefront_save` → promote via `linkSignal`
  (cascade barrel — CI-guard-compliant). View / click without a
  candidate → leave unbound (low-intent).
- **Verification-visit signal emitter** (also in
  knot-visitor-match.ts). After a bind, if the bound couple's
  wedding is in `inquiry` / `tour_scheduled` / `tour_completed` /
  `proposal_sent` AND `action_at` is AFTER the wedding's
  `inquiry_date`, emit `engagement_events.event_type =
  'knot_verification_visit'` with 3 points + metadata
  (`knot_action_taken`, `days_since_first_inquiry`,
  `knot_visitor_activity_id`). Idempotent on the
  `knot_visitor_activity_id` metadata field.
  `engagement_events.event_type` is free text (no CHECK constraint
  per mig 002) so this is a non-breaking string addition.
- `getVisitorJourneyMetrics({ venueId, personId })` — read-only
  helper returning total visits / total messages / first view /
  first message / days view→message. Intelligence-ready; UI surface
  deferred.
- Operator UI: added `knot_visitor_activity` adapter card to
  `/onboarding/crm-import` with explainer copy. The existing CSV
  auto-detector keeps routing the file to the sibling
  `storefront-activity` adapter by default (funnel rollup); the
  per-row matcher path is opt-in via the provider grid. Both
  adapters can be run on the same file — they write to different
  tables and are complementary.
- Unit tests:
  `src/lib/services/crm-import/__tests__/knot-visitor-activity.test.ts`
  — 32 tests covering action classification, date parsing, name
  splitting, fingerprint stability, in-file dedup, missing columns,
  the Doug L. canary recognition.

Verification: `npx tsc --noEmit` clean. `check-cascade-only-writer`
clean (no new offenders — pre-existing
`undo-merge/route.ts:201` failure unrelated). `check-no-direct-
people-insert` + `check-no-direct-wedding-insert` clean. Unit tests
32/32 passing.

### What changes for the operator

- Upload your Knot visitor-activities CSV at
  `/onboarding/crm-import` → choose **Knot visitor activity
  (per-row history)**. ~95% of weekly re-uploads short-circuit on
  the row fingerprint — no duplicate signals.
- Visitors who messaged or saved without an identifiable contact
  become ghost couples via the cascade — searchable, journey-
  traceable, ready to merge in when the same identity later arrives
  via email or Calendly.
- Couples already in your pipeline who come back to view Knot now
  emit a 3-point `knot_verification_visit` engagement event,
  feeding the heat score.
- Doug L. (canary): the import surfaces him in
  `knot_visitor_activity`; the cascade promotes him via
  `linkSignal`. The operator UI flags his per-row trace in the
  import warnings so you can verify the path on first run.

### Operator actions queued

- Apply migration 377 via Supabase dashboard
  (`supabase/migrations/377_knot_visitor_activity.sql`).
- First run on Rixey: upload the latest
  `RixeyManor-visitor-activities (N).csv` to
  `/onboarding/crm-import` → **Knot visitor activity (per-row
  history)**. Watch the import summary for the Doug L. trace.
- After the matcher sweep, eyeball
  `/intel/identity-review` for any new medium-tier
  `knot_visitor_activity` candidates (the multi-candidate branch).

## 2026-05-27 — Phase 1 closeout: scripts run against prod + new reclass CLI

After committing the inbox-misclassification fix (4b05c44) and the
script batch (522f675), ran the four data-mutating scripts against
prod (jsxxgwprxuqgcauzlxcb) under explicit operator authorization:

| Script | Result |
|---|---|
| `backfill-couples-bridge.ts` | 195/195 mirrored. 0 failed. Closes the 47% bridge gap (was 449 bridged, now 644). |
| `sync-couple-lifecycle-from-weddings.ts` | 181/181 lifecycle_state updated. 0 race-lost. After bridge, total bridged = 671 (476 → 671). Verified post-run: 0 real divergences remain (27 merged-away + 2 unknown-status flagged for operator). |
| `backfill-knot-orphan-candidate-matches.ts` | 295 orphans scored. 115 candidate proposals + 213 sentinels written = 328 candidate_matches rows. Knot orphans now visible in /intel/identity-review. |
| `reclass-folders.ts` (new) | Rixey: 495 reclassified, **340 folder changes**, 0 errors. Transitions: 288 advertiser→new_inquiry, 21 vendor→new_inquiry, 17 advertiser→potential_client, 5 vendor→client, 4 vendor→potential_client, 3 vendor→other, 1 each other→vendor/other→new_inquiry. Time-budget bumped 280s→600s (CLI not Vercel-constrained) so single sweep finishes the backlog. |

Also fixed a latent chunking issue in `sync-couple-lifecycle-from-weddings.ts` and `verify-cohort-divergence.ts` — the `.in('id', ...)` lookup chunk was 500, which exceeds PostgREST URI limits on prod (Undici fetch failure). Reduced to 100.

### New script: `scripts/reclass-folders.ts`

CLI wrapper around the historical reclass loop in `/api/admin/reclass-folders-ai/route.ts`. The endpoint requires browser session auth (`getPlatformAuth`); this script does the same work via service-role so an operator can fire it from the CLI without spinning up the Next.js server.

- Requires `--venue-id <uuid>` (no silent fan-out across venues).
- Default source folders: `vendor,advertiser,other` (where the form-relay misclassification bug deposited new inquiries).
- Default max-rows 500, batch-size 10. Time-budgeted 4m40s.
- Refuse-by-default for prod ref unless `--allow-prod`. Dry-run by default unless `--apply`.

### What changes for the operator

- Bridge-gap repaired: every live (non-merged) wedding now has a `couples` bridge row, so `linkSignal` legacy-fast-path resolves on first touch.
- 181 couples that had drifted `lifecycle_state` (mostly tour-stage → still 'ghost', or wedding-date-passed booked → still 'booked') now reflect their wedding's actual status. Cohort dashboards stabilise.
- Knot orphan touchpoints (295 rows from before mig 360's CHECK extension) surface in the identity-review queue.
- Mis-bucketed Rixey inbox rows (~500) get correctly-classified intent + correctly-derived folder via the reclass run.

### Operator actions queued

- Apply migration 374 via Supabase dashboard (`supabase/migrations/374_couple_merge_events_reattach_type.sql`).
- After mig 374: run `scripts/reattach-couple-author-orphans.ts --apply --allow-prod` to auto-bind 19 Tier-1 + queue 4 Tier-2 couple-author orphan gmail touchpoints.
- Merge `consolidation` → `master` so the inbox fix lands in prod. Until then, NEW inquiries via form-relays will keep landing in wrong folders even though the historical tail is now repaired.

## 2026-05-27 — Inbox misclassification fix: form-relay leads no longer land in Vendor/Advertiser

Operator reported real new inquiries landing in the Vendor folder. Root cause was three compounding defects:

1. **`synthClassificationFromFormLead` never set `unifiedVerdict`.** The pipeline's form-relay branch (Knot / WW / Zola / HoneyBook / calculator) built a synthesized 7-class `classification` but left `unifiedVerdict` null. That meant `updateThreadLifecycleFolder` got `intentClassOverride=null` and fell through to the structural fallback in `decideLifecycleFolder`. The fallback routed `member.theknot.com` → Advertiser (via `isAdvertiserDomain`) and HoneyBook "New estimate" → Vendor (via `senderRole`/allow-list).
2. **`decideLifecycleFolder` had no channel short-circuit.** Migrations 329 + 330 (May 12) documented a "deterministic channel-level short-circuit pinning form-relay senders to inquiry-stage folder" — but the code companion was never written. Real prospects coming through the highest-volume channels relied entirely on the fallible classifier; when it missed, they went to the wrong folder.
3. **`inbound_intent_drain` cron not scheduled.** The handler exists at `src/app/api/cron/route.ts:1218`, idempotent and ready, but `vercel.json` never scheduled it. Result on Rixey prod, last 30 days: **137 of 296 inbound emails (46%) had `intent_class IS NULL`** because the fire-and-forget classifier missed and nothing caught up. Same gap for `inbound_haiku_drain`.

**Fixes shipped (code-only, no migration):**

- `src/lib/services/intel/inbound-intent-classifier.ts` — new `synthVerdictForFormLead` helper. Returns a high-confidence (95) `new_inquiry` verdict built from parser-extracted fields, no LLM call.
- `src/lib/services/email/pipeline.ts` — form-relay branch now calls `synthVerdictForFormLead` and sets `unifiedVerdict`. Downstream stamp + folder override + heat scorer all read the right value.
- `src/lib/services/inbox/lifecycle.ts` — new `FORM_RELAY_AND_SCHEDULING_DOMAINS` const + `isFormRelayOrSchedulingDomain` helper + short-circuit at the top of `decideLifecycleFolder` (above the existing structural floor but below `booked`/`completed`). Pre-empts the advertiser/vendor fallback for known relay senders.
- `vercel.json` — added two cron entries: `inbound_intent_drain` (*/5) + `inbound_haiku_drain` (*/5). Catches the 46% miss rate at ~$0.0003/row.

### What changes for the operator

- Real new inquiries via Knot Pro Inbox, WeddingWire, Zola, HoneyBook estimate handoffs, and Calendly tour bookings now land in **New Inquiries** instead of Advertisers/Vendors.
- Drain crons run every 5 minutes — previously-missed rows get an intent_class within minutes, not never.
- An LLM-verdict of `spam_outreach` / `vendor_outreach` on a Knot domain (e.g. Knot pitching the venue, not relaying a couple) STILL routes through the intent-driven branch and lands in advertiser/other. The short-circuit only fires when the LLM has not spoken.

### Operator actions queued

- Run the existing `/api/admin/reclass-folders-ai` endpoint to re-walk the historical tail. Rough scope: ~46 demonstrably mis-bucketed rows on Rixey in the last 30 days, plus the ~137 NULL-intent rows that will land in the right folder once the drain catches up.
- Merge `consolidation` → `master` to put this fix in front of customers. Until then, prod still routes new inquiries to Vendor/Advertiser folders.

## 2026-05-26 — Orphan-touchpoint diagnosis fix #3: reattach couple-author orphans

New `scripts/reattach-couple-author-orphans.ts` sweep + migration `374_couple_merge_events_reattach_type.sql` (adds `'reattach'` event_type). Dry-run on prod: 25 orphan gmail touchpoints with `author_class='couple'`, dispositions 19 Tier 1 (auto-bind via cascade `exact_full_name` × 18 + `exact_email` × 1), 4 Tier 2 (queue candidate_match — Katie OBrien vs O'Brien apostrophe race), 2 Tier 0 (no match: Madison Blaine + Phil Anstee — operator review required). Refuse-by-default for prod (`--allow-prod` opt-in), default dry-run, idempotent.

## 2026-05-26 — Phase 1 consolidation: Batch 1 + Batch 2 on `consolidation` branch

> ⚠️ **Not in production.** The work below sits on the `consolidation`
> branch unmerged. `master` runs prod. End-users see none of this yet.
> The status page at `/system/consolidation-status` re-states this in
> banner form.

### Batch 1 prerequisites (P1-P5)

Five shared-machinery prereqs landed before any pipeline.ts site flip
could be safe. P1 extracted the inbound email → `NormalizedSignal`
adapter so every Batch-1 writer builds the signal the same way.
P2 extended `mintPerson` with `weddingId` + `role` so partner2
inserts can enrich-or-skip (closes the Liam-Hunt duplicate-partner-two
class permanently). P3 added a `couple_merge_events` audit insert to
the `lock_and_mint_couple` RPC + rerouted tracer's direct INSERT
through the chokepoint. P4 added `linkSignal` to the cascade.ts
barrel. P5 made the `linkSignal` call at pipeline.ts:4109 load-bearing
(capture result, surface errors, drop the swallowed catch). Migrations
**366** + **367** + **368** written; operator applies via dashboard.

### Batch 1 site flips (9 enumerated + M10 discovered)

All 9 enumerated MIGRATE sites in `src/lib/services/email/pipeline.ts`
plus M10 (the autonomous-send writer, discovered during pressure-test
as having neither a legacy `interactions` row nor a cascade call since
the loop was built). M2/M3 partner1 + contact mirror dual-write via
`findOrCreateContact`. M4/M5 partner2 (the Liam-Hunt class) now
mint through `mintPerson({weddingId, role:'partner2'})`. M6/M7
outbound `linkSignal` calls added. M8 verified as stay-as-dual-write
(252/252 cohort coverage; `candidate_identities` is a live Wave-10
layer the cascade subsumes in Phase 3/4). M9 added a `linkSignal`
call inside the `humanRequested` block before its early return.
M10 got both the missing legacy interactions insert and the cascade
call; historical backfill script at
`scripts/backfill-autosend-interactions.ts` (read-only by default).

### Pressure-test remediation (rounds 1 + 2)

Four-agent adversarial pressure tests found 1 CRITICAL + 2 HIGH +
several MEDIUM defects across the site flips. All closed. C1: M5
Calendly same-email partner2 → matched partner1 → name pollution;
fixed via new `mintPerson` guard + `createPartner2Person` helper that
discards same-wedding / cross-wedding partner1/2 matches. C2: M2
findOrCreateContact dropped matched person's `wedding_id` on
alias/pool resolver hits; fixed by re-querying. Doctrine debt closed
this round: M9 now passes `action_type:'human_requested'` directly
(migration 368 extends the CHECK); M4/M5 partner2 name-capture
provenance row suppressed at createPerson when role is partner2.

### Batch 2 prerequisites

Restructured the `check-cascade-only-writer.mjs` CI guard from
directory-prefix to chokepoint-FILE allowlist so post-flip
regressions inside `identity/` are catchable (Pbatch2-9). Built 5
per-channel signal builders (`calendly-to-signal.ts`,
`honeybook-csv-to-signal.ts`, `sms-to-signal.ts`, `voice-to-signal.ts`,
`zoom-to-signal.ts`) + 3 shared helpers (`phone-fields.ts`,
`identity-hint.ts`, `raw-payload.ts`). Migration **372** extends
`couple_progression_events.event_type` CHECK with 6 net-new types
for honeybook / sms / phone / voicemail / zoom; `progression.ts`
mapper extended.

### Batch 2 phase A — HoneyBook

H1 (partner1) + H2 (partner2 — Liam Hunt class for HoneyBook) +
H3 (per-row interactions batch + synthetic `crm_attribution`
provenance row) dual-write through `mintPerson` / `linkSignalBatch`.
H4 (`booked-data-recovery` `merged_into_id` UPDATE) DEFERRED — it
routes through `mergeWeddings`, and `mergeWeddings` itself is the
next chokepoint debt (hand-list-drift across 32 tables). Sequencing
H4 ahead of a `mergeWeddings`-cascade fix compounds the existing
footgun.

### Batch 2 phase B — Calendly

C3 already-routed promotion (inline literal replaced with
`calendly-to-signal.ts`, P5-style error surfacing). C11 (tour_cancelled
direct `touchpoints.upsert`) + C12 (tour_attended batch upsert)
chokepoint violations CLOSED — direct writes removed, `linkSignal` /
`linkSignalBatch` substituted, with the cancellation-to-fragment
fallback at Pbatch2-10 covering identity-poor cancellations. C1
(tours table insert) stays as the operator-UI event mirror per plan
§1.4.

### Batch 2 phase C — Phone / voice / video

T2 (Twilio SMS inbound) + O4 (OpenPhone primary interactions) + O7
(OpenPhone sms-name-match resolveIdentity) + Z5 (Zoom transcript) +
Z6 (Zoom body-extract dispatch) all dual-write. T6 + O6 mintWedding
sites exempted per Batch-1 §5 (mintWedding is already the chokepoint).
Zoom channel renamed `meeting` → `zoom` to avoid Tracer-filter
collision. Body-extracted identifiers now flow through the cascade
(closes Batch-1 Q5 "stages 6/7/8 never fire from `linkSignal`").

### Cross-channel referrals

I1: `intel/referrals/resolve.ts` `attribution_events` writer now
routes through `linkSignal({action_type: 'referral_self_report'})`.

### Operator-reported incidents (post-Batch 2)

Three deep-pressure-test findings remediated. Zola relay subdomain
regex was too narrow — silently routed ~73 ZolaVendors prospect emails
in 12 days to the wrong relay path, dropping them as orphans.
Glascow signal-identity passthrough — cascade was seeing the venue's
own From-header for all relay-resolved emails (wrong author class).
Both-partner cross-match auto-link — cascade stage 2b/5b matcher
bonus added (16 new unit tests). 200/200 unit tests pass.

### What changes for the operator

- **Tier-4 confabulations don't move.** Battery Q17/Q20/Q21 are not
  improved by Batch 2. They land in Phase 3.2/3.3 (reader migration).
- **Cohort numbers on /intel may wobble.** During the 2-3 week phase
  A → B → C window channels migrate at different times. Expect
  transient delta between framings; reconverges in Phase 3.
- **Tour-cancelled / tour-attended Calendly signals get rewired.**
  Watch the cohort funnel for the first 48 hours after the Calendly
  cutover. The `verify-c11-c12-cutover.ts` script (not yet written)
  is supposed to alert on >30% delta from the 14-day baseline; spot-
  check manually until it lands.
- **HoneyBook re-imports deduplicate going forward.** Liam-Hunt-class
  partner2 duplicates from recurring CSV uploads are closed by
  construction. Historical duplicate-partner-two rows are NOT cleaned
  by this — that is Phase 2's wipe-and-reimport.
- **Zola subdomain bug fix.** The ~73 lost-leads-in-12-days are
  recoverable via the `/api/agent/reprocess-form-relays` endpoint
  (operator action below).

### Operator actions queued

- Apply migration **366** to consolidation branch
  `ciwqxwohczzthvzqqgjx` (branch is missing the CHECK extension that
  admits `couple_minted`).
- Apply migration **367** (partner2 unique index) + migration **368**
  (`event_type` CHECK) to whichever DBs the M9/M4/M5 code lands on.
  15 partner-role dup groups already resolved on prod 2026-05-26;
  367 should now apply clean.
- Apply migration **372** (`progression_event_batch2_channels`) — 6
  net-new `event_type` values.
- Run `/api/agent/reprocess-form-relays` against historical
  `interactions WHERE from_email='weddingvendors@zola.com' AND direction='inbound'`
  to recover the ~73 Zola lost-leads.
- Run `scripts/backfill-autosend-interactions.ts --apply` against
  prod when desired (dry-run on branch found 0 rows).
- Renumber operator's uncommitted
  `372_section_finalisations_unique.sql` → 374+ to resolve collision
  with `372_progression_event_batch2_channels.sql`.
- Review JC Matos / Jancarlo Matos cross-role merge from group 4 of
  `a5777ff` (applied on both branch and prod).
- Re-run the battery against whichever DB the migrations landed on
  (`run-battery.ts` reads `.env.local` → prod by default).

### Known open gaps after Batch 2

- **CRITICAL — Lifecycle helper schema mismatch.**
  `recordSmsLifecycleSignal` + `recordZoomLifecycleSignal` write
  fields that don't match the `wedding_lifecycle_events` schema
  (mig 246). 100% silent 4xx since the helpers were written.
- **CRITICAL — `source_wedding_id` bridge backfill.** 47% of booked
  weddings on prod have NO `couples` row via the bridge. 100% of
  `completed` + `contracted`. `mirrorCoupleFromWedding` needs a
  status-transition hook + sweeper.
- **HIGH — 5 Batch-2 verification scripts unwritten.**
  `verify-calendly-binding.ts`, `verify-honeybook-attribution.ts`,
  `verify-sms-binding.ts`, `verify-zoom-binding.ts`,
  `verify-c11-c12-cutover.ts`. Done-definition unmet.
- **HIGH — Cohort divergence on "booked couples".** Branch 26 vs
  prod 86 vs weddings 66/67. `couples.lifecycle_state` unreliable
  as a metric source until Phase 3 readers move + the bridge
  backfill above lands.
- **HIGH — No deploy to prod yet.** Batch 1 + Batch 2 (20+ commits)
  remain on `consolidation`. The cohort numbers operators see today
  reflect `master`, not the cascade.
- **MEDIUM — `action_type` vocabulary leak.**
  `JourneyRibbon.tsx:130`, `intel/couples/[id]:148`,
  `identity-review-queue-tab.tsx:177` render raw enum strings as
  tooltips. Breaks the operator-vocabulary boundary
  `check:operator-vocab` is supposed to keep clean.
