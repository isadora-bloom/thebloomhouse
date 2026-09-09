# Capacity Loop — Design (W6, November Plan, 2026-09-08)

Design only. No code in this document ships anything — see LOOP-ASSESSMENT.md
Loop 5 for the code trace this design responds to, and NOVEMBER-PLAN.md
workstream W6 for why it exists now.

## What the loop should mean

"Coordinator capacity → auto-send pace → follow-up timing" should mean: when
a venue's human bandwidth to actually read and act on Sage's output is
reduced — a coordinator is on leave, the venue is mid-renovation, booked
capacity for the season is already near its ceiling — the system throttles
back how aggressively it acts autonomously and stretches out the cadence at
which it re-approaches silent leads, rather than continuing to fire
auto-sends and follow-ups at a fixed pace into an inbox nobody is watching
closely enough to catch a bad one. The loop closes when it also does the
reverse: as capacity frees up (absence ends, booked slots open up), pacing
and follow-up cadence return to normal without a human having to remember to
flip a setting back. This is a safety-and-quality throttle, not a growth
lever — it should only ever make Sage more conservative during a capacity
squeeze, never more aggressive to "catch up", because an unattended venue is
exactly the wrong moment to widen the blast radius of autonomous sending.

## The three existing parts (verified in LOOP-ASSESSMENT.md Loop 5)

1. **Capacity signals exist as data.** `coordinator_absences`
   (`assigned_consultant_id`, `reason`, `start_at`, `end_at`,
   `handoff_notes`) and `venue_operational_state` (`state_type`, `start_at`,
   `end_at`, `title`, `description`, `affected_space`) are real, operator-
   maintained tables (`/portal/absences-config`, `/portal/property-state-config`).
   `venue_availability.booked_count` / `max_events` also exists and already
   feeds `venue-health-compute.ts`'s fill-rate sub-score.
2. **The signals are consumed, but only for explanation.**
   `intel/anomaly-detection.ts` `loadInternalContextForAnomaly()` (lines
   ~600-625) reads both tables to give the anomaly hypothesis prompt context
   ("inquiries fell because the coordinator was on leave"). This is a
   read-only, backward-looking use — it helps the AI *explain* a metric
   change after the fact. It has no write path and no effect on any other
   service.
3. **Auto-send pacing exists, but is capacity-blind.** `email/autonomous-sender.ts`
   `checkAutoSendEligible()` gates on cost-ceiling pause, direction filter,
   injection containment, confidence threshold, `require_new_contact`, the
   per-thread rolling-24h cap (`auto_send_rules.thread_cap_24h`), and the
   venue-wide `auto_send_rules.daily_limit`. All of these are fixed,
   operator-configured numbers. `email/follow-up-sequences.ts` is likewise
   driven purely by sequence-step definitions, with no capacity input.

## The two missing edges

**Edge 1 — capacity signal → a scalar.** There is currently no function that
turns "coordinator X is out until Friday" + "the venue is mid-renovation" +
"booked_count is at 92% of max_events for the next 60 days" into a single
number a pacing decision can consume. This needs to exist before either
downstream edge can be built: a pure `computeCapacityFactor(venueId, asOf)`
(or similar) that reads the three signal sources above and returns something
like a 0.0-1.0 multiplier (1.0 = full capacity, lower = squeezed), plus the
reasons that produced it (for operator-facing transparency — this must never
silently throttle without a visible "why" the coordinator can see, per the
constitution's operator-authority principle). Coordinator-absence windows
and operational-state windows should combine (both active = more squeezed,
not double-counted into an unreasoned floor), and a near-full
`venue_availability` season should have a smaller, separate effect from an
absence — a fully-booked venue during a fully-staffed week is a different
situation from an empty-inbox week during a coordinator's holiday, and the
two should be distinguishable in the reasons list even if they compose into
one factor.

**Edge 2 — the scalar → `checkAutoSendEligible` and `follow-up-sequences`.**
Today neither reads any capacity input at all (zero grep hits for
absence/operational_state/capacity in either file). The design is: thread
the capacity factor from Edge 1 into `checkAutoSendEligible` as an
additional multiplicative gate on `auto_send_rules.daily_limit` and
`thread_cap_24h` (e.g. effective daily limit = configured limit × capacity
factor, floored at some minimum so auto-send never goes fully to zero
without an explicit operator pause — that's what the existing cost-ceiling
pause is for, this loop should not duplicate it), and into
`follow-up-sequences.ts` as a step-delay multiplier (e.g. a no-reply
follow-up due in 3 days during a squeeze fires in 3 ÷ capacity-factor days
instead — stretching the cadence, never shrinking it below the configured
default). Both reads should be cheap (the factor is computed once per venue
per tick, not recomputed per-email) and should degrade safely to "no
throttle" (factor = 1.0) if Edge 1's computation fails or the venue has no
absence/operational-state data at all, so this cannot become a new failure
mode for autonomous sending on venues that never configure the feature.

## Build-or-cut

Per LOOP-ASSESSMENT.md's framing, this is a decision point, not a "finish
wiring" task — there is nothing partially built to complete, only two edges
to construct from scratch on top of data that already exists. Estimated at
roughly one session once scoped (a pure scalar function + two call-site
threadings + operator-visible reasons), consistent with LOOP-ASSESSMENT.md's
own estimate. Not attempted in this workstream (W6 scope was registering the
already-built dark crons + the calibration feedback edge); flagged here so
the November Plan can schedule it deliberately rather than let Loop 5 keep
reading as "partially built" when it is currently zero-built.
