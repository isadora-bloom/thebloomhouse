# Multi-Venue Onboarding Playbook

How to onboard a new venue cleanly, without repeating the data
corruption sequence that bit Rixey on 2026-04-30.

## Background

The Rixey timeline-corruption sweep (commits `d53e606` through
`770c617`) uncovered four classes of structural bugs that any
venue's Gmail backfill triggers:

1. **Time conflation** — pipeline writers use wall-clock NOW for
   semantic-event time. Backfill collapses real timing onto import day.
2. **Direction misclassification** — Sage's outbound drips stored as
   inbound from the customer because Sage's sending alias wasn't in
   `venue_ai_config.ai_email`.
3. **Source inheritance** — touchpoint source defaults to wedding's
   legacy first-touch instead of the actual interaction's channel.
4. **Inquiry mispinning** — inquiry touchpoint sometimes bound to a
   later non-inquiry email (a Sage drip subject).

Code-side fixes shipped (b08c0d4, 91a8766, 770c617, ea6af6a) prevent
new venues from accumulating these errors **going forward**, but
historical Gmail backfill needs a one-time data correction pass.

## The flow

### 1. Connect Gmail

The venue admin connects their Gmail account through the standard
OAuth flow. This populates `gmail_connections` and starts the email
poll cron.

**Verify:** `select email_address, status from gmail_connections
where venue_id = '<uuid>'` returns a row with `status='active'` and
`email_address` matching the venue's actual sending address (e.g.
`info@venue.com` — NOT a personal Gmail).

### 2. Set Sage's identity

In the platform Settings → Sage Identity flow, set the venue's
`venue_ai_config.ai_email`. This MUST match the address Sage will
send drips from. If Sage sends from `info@venue.com` but
`ai_email = 'sage@venue.com'`, every Sage outbound during backfill
will be misclassified as inbound from the customer.

The reclassifier (b08c0d4) self-learns this address from prior
correctly-classified outbounds, so this matters most for the first
batch. Setting it correctly upfront prevents a cascade.

### 3. Run Gmail backfill

The connected Gmail account starts ingesting historical messages.
This is the dangerous step — every previously-unseen email gets
processed by the pipeline. The fixes from b08c0d4 onwards prevent
the worst patterns, but legacy data may still surface.

### 4. Run the cleanup pipeline

```bash
npx tsx scripts/onboard-data-cleanup.ts --venue <uuid>            # dry-run
npx tsx scripts/onboard-data-cleanup.ts --venue <uuid> --apply
```

Five steps, all idempotent. Already-correct rows are no-ops:

1. **Reclassify direction from Gmail labels** — re-fetches the
   labelIds for every interaction with a `gmail_message_id` and
   flips `direction` to outbound when the Gmail SENT label is
   present (or when the from_email is in the venue's known own
   senders, as a fallback for send-mail-as / forwarding edges).
   Side effect: deletes engagement events that fired on the now-
   correctly-outbound rows (false positives).
2. **Recover scheduling-event datetimes** — restores tour
   timestamps from `metadata.event_datetime` → `metadata.subject` →
   sibling-row propagation.
3. **Re-align booking vs tour timestamps** — sets
   `wedding.inquiry_date` to the earliest inbound interaction's
   timestamp, sets `tour_booked` touchpoints to the booking-email
   timestamp, leaves `tour_conducted` at the actual tour datetime.
4. **Repair touchpoint sources** — sets each touchpoint's `source`
   to the actual channel (calendly, acuity, the_knot, etc.)
   inferred from the linked interaction's `from_email` domain.
5. **Recompute heat scores** — heat may have been inflated by the
   false-positive engagement events deleted in step 1. Recalc
   everything.

Expect 5-15 minutes per venue depending on inbox size.

### 5. Run the readiness report

```bash
npx tsx scripts/onboarding-readiness.ts --venue <uuid>
```

This runs the 8 structural invariants (which **must all pass**)
plus 4 smoke tests (advisory). Three possible outcomes:

- **READY FOR GO LIVE** — all clean, activate the venue.
- **READY (with caveats)** — invariants pass but smoke tests have
  warnings. Coordinator reviews the messages, then activates if
  they're explainable.
- **NOT READY** — invariants violated or a smoke test failed. Do
  NOT activate. Investigate, re-run cleanup, re-check.

### 6. Activate

Toggle the venue to active in the admin UI. The daily cron
`data_integrity_sweep` (5 AM UTC) will continue monitoring the
8 invariants and surface any new violations as `data_anomaly`
rows on `/intel/anomalies`.

---

## What to check when an invariant fires

Each invariant has a `meaning` string explaining what the
violation likely indicates. Common patterns:

| Invariant | Likely cause | Fix |
|---|---|---|
| Causality | Inquiry stamped to a Sage drip subject after the real inquiry | Re-run cleanup pipeline; the `backfill-booking-vs-tour-timestamps` step handles this |
| Direction parity | Sage's sending alias isn't in `venue_ai_config.ai_email` | Set ai_email correctly, then re-run the reclassifier |
| False-positive parity | `signal-inference` ran before the reclassifier | Re-run reclassifier; it deletes false-positive events |
| Inquiry parity | Backfill stamped `inquiry_date` to NOW or a later email | Re-run booking-vs-tour timestamp script |
| Wedding has people | Wedding created without a person link (pipeline bug) | Investigate the wedding's first interaction; either link the person manually or delete the orphan |
| Future timestamps | Email body contained a forward-dated string the parser interpreted as the event time | Manually correct the wedding's dates; investigate which parser is overly trusting body text |
| Duplicate Gmail IDs | `email-pipeline.isEmailProcessed` dedup logic failed | Investigate the dedup keys; the dup rows can be merged or the later one deleted |
| Source consistency | Touchpoint inherited wedding's legacy source | Re-run `backfill-touchpoint-sources` |

---

## What `data_integrity_sweep` does daily

Runs the 8 invariants on every venue and either:
- Opens a `data_anomaly` insight row for each violated invariant
  (visible on `/intel/anomalies`).
- Self-heals (dismisses with `status='self_healed'`) any anomaly
  that previously fired but now passes — happens after a coordinator
  re-runs the cleanup pipeline or after a code fix lands.

Idempotent. Coordinator never needs to clear anomaly rows by hand.

---

## Code-level invariant for new contributors

When writing new pipeline code that inserts a row with a temporal
field, **never use `new Date().toISOString()` for a field that
represents when an event happened**. Use one of:

- `email.date` (RFC-2822 from Gmail) when the field should reflect
  email arrival
- `schedulingEvent.eventDatetime` for tour-time fields
- `signal.signal_date` for platform-engagement timestamps
- `parseEventTime(value)` from `src/lib/services/event-time.ts` to
  parse external strings safely (returns null on parse failure;
  caller decides what to do — never silently falls back to NOW)

Wall-clock NOW is correct ONLY for fields that represent the moment
of insertion (`created_at`, `updated_at`, `decided_at`,
`approved_at`, `dismissed_at`). Never for semantic event time.
