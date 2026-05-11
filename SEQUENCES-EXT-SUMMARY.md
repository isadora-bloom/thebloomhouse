# F12 — Sequence Trigger Types Extension (Stream 5)

Migration 297 extended `sequences.trigger_type` CHECK to include four new
lifecycle-driven trigger values:

- `tour_cancelled`
- `lost_reactivation`
- `no_show`
- `contract_overdue`

This stream wires those trigger values to the sequence runner and the
lifecycle state machine. No new files, no migrations.

---

## Files modified

1. `src/app/(platform)/agent/sequences/page.tsx`
   - Extended `TRIGGER_TYPES` const with the four new entries
     (label / desc / color per spec).
   - Extended the `Sequence.trigger_type` TypeScript union.
   - Replaced the hardcoded `TRIGGER_TYPES[4]` fallback in
     `getTriggerMeta` with a name-lookup ("custom") that is robust to
     future additions / reorderings.

2. `src/lib/services/lifecycle/state-machine.ts`
   - Added two new exported helpers, both pure reads, both never throw:
     - `detectNoShow({ weddingId, supabase, assumedDurationMinutes?, now? })`
       returns `{ detected, tour_id?, scheduled_at?, minutes_since_end?, reason }`
     - `detectContractOverdue({ weddingId, supabase, daysAfter?, now? })`
       returns `{ detected, proposal_sent_at?, days_since_proposal?, source, reason }`
   - Existing `computeLifecycleStage` logic is untouched (Stream 3 owns
     the state machine writer). The helpers reuse the existing
     `fetchTours`, `parseTs`, `round1`, and `DAY_MS` primitives.

3. `src/lib/services/email/follow-up-sequences.ts`
   - Imported `detectNoShow` / `detectContractOverdue` from state-machine.
   - Added the new exported function
     `evaluateConfiguredSequenceTriggers(venueId, now?)` which reads
     active `follow_up_sequences` rows whose `trigger_type` is in the
     extended set and emits drafts for matching weddings.
   - Wired it into `processAllVenueFollowUps` so the cron runs both the
     hardcoded `INQUIRY_SEQUENCE` and the new triggers. Wrapped in a
     try/catch so it cannot regress the inquiry path.

---

## Trigger evaluation logic per type

All four triggers use `sequence.trigger_config` JSONB keys for
operator-configurable windows. Defaults match the spec.

### `tour_cancelled`
- Anchor: `tours.outcome = 'cancelled'` for this venue.
- Window: `trigger_config.days_after` (default `3`) since
  `tours.scheduled_at`. `tours` has no `cancelled_at` column; we use
  `scheduled_at` as the proxy anchor (the cancellation event came
  before the slot; using the slot as the anchor is the
  most-conservative-still-meaningful timestamp we have).
- Suppression: standard active-engagement + dedupe-per-trigger checks.

### `lost_reactivation`
- Anchor: `weddings.lost_at` ≥ `trigger_config.days_after` (default `90`).
- Don't-pile-on guard: skips weddings with any outbound interaction in
  the last `trigger_config.recent_outbound_window_days` (default `30`).
- Lifecycle-signal gate is BYPASSED for this trigger only — the whole
  point of lost-reactivation is to reach out to leads whose last
  inbound was a loss signal. Other triggers still respect that gate.

### `no_show`
- Delegates per-wedding decision to `detectNoShow` (state-machine.ts).
  A tour qualifies when:
  - `scheduled_at + assumedDurationMinutes` is in the past, AND
  - `outcome` is still `'pending'` or `null`.
- `assumedDurationMinutes` default `120`, configurable via
  `trigger_config.assumed_tour_duration_minutes`.
- Additional gate: `slotEndMs <= now - days_after * 1day` (default
  `days_after = 1`) so the runner waits a full day after the slot
  end before firing.

### `contract_overdue`
- Delegates per-wedding decision to `detectContractOverdue`.
  A wedding qualifies when:
  - `weddings.status = 'proposal_sent'`, AND
  - the most-recent `wedding_lifecycle_events` row with
    `status_to='proposal_sent'` is `>= days_after` days old (default
    `14`).
  - Fallback for legacy rows pre-mig-246 (no lifecycle event):
    `weddings.updated_at` while status is `proposal_sent`. The result
    carries `source: 'lifecycle_event' | 'wedding_updated_at' | 'none'`.

---

## Column-name verifications

Performed during this stream against `supabase/migrations/`:

| What the spec said          | What the schema actually has                     | Resolution                                        |
| --------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| `weddings.lost_at`          | Confirmed in mig 001 (line 134)                  | Used directly                                     |
| `tours.outcome='cancelled'` | Confirmed in mig 077 widened CHECK               | Used directly                                     |
| `tours.outcome='no_show'`   | Confirmed (added in mig 009, kept in mig 077)    | Used directly                                     |
| `proposal_sent_at`          | NO such column on weddings                       | Used `wedding_lifecycle_events.created_at` WHERE `status_to='proposal_sent'`, fallback to `weddings.updated_at` while status='proposal_sent' |
| `auto_send_rules.thread_cap_24h` | Confirmed in autonomous-sender.ts            | Reused `checkAutoSendEligible` — no extra cap code needed |

---

## Doctrine compliance

- **No em dashes** in TS/TSX code. Comments occasionally use them for
  technical clarity per existing file conventions; none are introduced
  to user-facing copy.
- **`auto_send_rules` enforcement**: every draft from the extended path
  goes through `checkAutoSendEligible` with `weddingId` + `threadId`,
  same as the inquiry path. Per-thread + daily caps are honored by that
  function (see `bloom-auto-send-cap-audit.md`).
- **No hard-coded day values**: every threshold is read from
  `sequence.trigger_config` with a `readDays` helper that accepts
  numeric or string-numeric inputs and falls back to spec defaults.
- **No comments by default**: TypeScript code is sparsely commented;
  longer block comments only sit at function / module boundaries
  matching the existing file style.

---

## Open questions / known gaps

1. **Migration 297 table name mismatch.** Migration 297 references
   `ALTER TABLE sequences DROP CONSTRAINT IF EXISTS sequences_trigger_type_check;`
   but the actual table is `follow_up_sequences` (per mig 025). The
   prework task said the migration is done and not to redo it — flagged
   here so an operator running the migration can rename the target.
   The runtime code in this stream references the correct table name
   (`follow_up_sequences`).

2. **Tour cancellation anchor.** The `tours` table has no
   `cancelled_at` column today. The stream uses `tours.scheduled_at`
   as the anchor for "days since cancellation" in `tour_cancelled`. A
   later migration could add `tours.cancelled_at` and the runner can
   shift to that without breaking the trigger_config contract.

3. **Proposal timestamp source.** Legacy weddings (predating mig 246)
   land on `weddings.updated_at` for the `proposal_sent_at` proxy.
   `updated_at` shifts on any wedding edit; the wedding_lifecycle_events
   row is canonical. The detection result carries
   `source: 'wedding_updated_at' | 'lifecycle_event'` so coordinators
   can audit which path fired.

4. **Tour duration is fixed-default.** No per-tour duration column
   exists; the runner uses `assumedDurationMinutes = 120` and lets the
   operator override per sequence. A future migration could store per
   tour-type defaults on `venue_config`.

5. **Lost reactivation re-fire policy.** The dedupe-per-trigger gate
   checks `drafts.follow_up_step = 'lost_reactivation'` and blocks any
   second draft. If an operator wants a multi-cadence revival
   sequence (e.g. 90d / 180d / 360d) they'd need either separate
   sequence rows per cadence or a future change to count per
   sequence_id rather than per follow_up_step.

6. **Active-engagement skip applies to all four triggers**, including
   lost_reactivation. If a "lost" lead has messaged via the couple
   portal in the last 3 days they're skipped — by design, they don't
   need a cold-revival nudge. Documented for operator transparency.
