/**
 * Progression-event writer.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §3. A couple's
 * `last_progression_at` clock moves only on INBOUND, doctrine-listed
 * action types. §3 Don't skip #1 is explicit: "I will be tempted to
 * count 'sent email to person' as progression because it's simpler.
 * It's not. Only inbound events from the enumerated list count."
 *
 * Eligible event types (mirrors couple_progression_events CHECK):
 *   - email_reply              (channel=gmail, inbound)
 *   - tour_booked              (channel=calendly, action=tour_booked)
 *   - tour_rescheduled         (channel=calendly, action=tour_rescheduled)
 *   - tour_attended            (channel=calendly, action=tour_attended)
 *   - new_channel_inquiry      (channel=knot/ww/zola/website, action=inquiry*)
 *   - portal_click             (channel=portal, action=portal_click)
 *   - contract_signed          (channel=honeybook, action=contract_signed —
 *                               also fires from CSV path
 *                               action=crm_imported_booked; one signal
 *                               class, two ingestion routes)
 *   - inbound_followup         (any inbound reply to an open thread)
 *   - fragment_match_returned  (operator confirms a candidate match)
 *   - inbound_human_request    (couple asks for a human — M9 escalation;
 *                               mapped from channel=gmail action=human_requested.
 *                               Added 2026-05-23 by migration 368 +
 *                               PHASE-1-BATCH-1 pressure-test remediation,
 *                               so the honest `action_type:'human_requested'`
 *                               at pipeline.ts M9 produces a progression
 *                               row instead of being a quiet downgrade to
 *                               `action_type:'reply'` with the semantic
 *                               buried in raw_payload.escalation.)
 *   - crm_inquiry              (HoneyBook CSV — channel=honeybook
 *                               action=crm_imported_inquiry. Distinct
 *                               from new_channel_inquiry; carries the
 *                               "imported, not live" provenance for D9
 *                               cohort math. Added migration 371,
 *                               Pbatch2-3.)
 *   - crm_booking              (HoneyBook CSV — channel=honeybook
 *                               action=crm_imported_booked is mapped to
 *                               this when the row is a STATUS-row import
 *                               rather than a SIGNING event. Note: the
 *                               current mapper routes crm_imported_booked
 *                               to contract_signed for DRY symmetry with
 *                               the email-pipeline path; crm_booking is
 *                               reserved for any future CSV path that
 *                               needs the status-row distinction
 *                               explicitly. Reserved-but-routable. Added
 *                               migration 371, Pbatch2-3.)
 *   - inbound_sms              (Twilio + OpenPhone — channel=sms
 *                               action=sms_inbound. Pbatch2-1 builder
 *                               sms-to-signal.ts produces this.)
 *   - inbound_call             (OpenPhone — channel=phone
 *                               action=inbound_call. Pbatch2-1 builder
 *                               voice-to-signal.ts.)
 *   - voicemail_received       (OpenPhone — channel=voicemail
 *                               action=voicemail_received. Same
 *                               Pbatch2-1 builder as inbound_call.)
 *   - meeting_completed        (Zoom — channel=zoom
 *                               action=meeting_completed. Pbatch2-1
 *                               builder zoom-to-signal.ts. Channel
 *                               renamed from 'meeting' to 'zoom' per
 *                               Pbatch2-5 to avoid collision with
 *                               Calendly batch Tracer filter.)
 *
 * NOT progression-eligible (intentionally omitted):
 *   - tour_cancelled (Calendly C11) — cancellation is REGRESSION, not
 *     progression. Moving the decay clock forward on a cancellation
 *     would mis-state lead health. Lives in `touchpoints` (C11's spine
 *     write covers it) and downstream regression detection reads from
 *     there. The mapper returns null for channel=calendly
 *     action=tour_cancelled; the migration 371 CHECK intentionally does
 *     NOT include `tour_cancelled`. See PHASE-1-BATCH-2.md §2 Pbatch2-3
 *     "DROPPED — tour_cancelled".
 *
 * Outbound action types and the venue's own sends NEVER write.
 *
 * Idempotency
 * -----------
 * couple_progression_events PRIMARY KEY is (couple_id, occurred_at,
 * event_type), so a re-run of the linker on the same signal produces
 * zero new rows. We rely on the PK ON CONFLICT DO NOTHING.
 *
 * Side effect on couples
 * ----------------------
 * After inserting a progression event, we UPDATE
 * couples.last_progression_at = greatest(existing, this_occurrence).
 * The greatest() guard handles out-of-order writes (a backfilled
 * older event must never roll the clock backward).
 */

// ---------------------------------------------------------------------------
// HOW TO ADD A NEW ACTION_TYPE
// ---------------------------------------------------------------------------
// Adding a new `action_type` literal (in a signal builder, a pipeline
// override, or this mapper) requires the migration + mapper + builder
// to land as ONE deploy unit. The CI guard
// `scripts/check-mig-deploy-unit.mjs` enforces this — see §7
// OPERATOR-BLOCK item 5 in `PHASE-1-BATCH-2.md`.
//
//   1. Decide whether the new action_type is PROGRESSION-eligible:
//      - Inbound, couple-initiated, moves the lead forward          → YES
//      - Outbound venue activity, terminal/regression, admin signal → NO
//        Add it explicitly to the `INTENTIONALLY_UNMAPPED` set in the
//        guard script with a one-line justification. (The mapper's
//        default fall-through is also `return null`, but the guard
//        treats unmapped action_types as failures so the intent is
//        recorded in source rather than inferred from silence.)
//
//   2. If YES, choose a progression `event_type`:
//      - Reuse an existing one when semantically equivalent (e.g.
//        HoneyBook CSV `crm_imported_booked` reuses `contract_signed`
//        at progression.ts:166 — one signal class, two ingestion routes).
//      - Coin a new one when distinct — naming pattern: verb-noun,
//        `inbound_` prefix when direction would otherwise be ambiguous.
//
//   3. If you coined a new event_type, create a new migration
//      `supabase/migrations/NNN_progression_event_<short>.sql` that
//      DROP-then-ADDs `couple_progression_events_event_type_check`
//      with the extended value list. Pattern: see migration 368 (one
//      new value) or 371/372 (six new values).
//
//   4. Add the mapper branch in `progressionEventTypeFor` below mapping
//      (channel, action_type) → new event_type.
//
//   5. Add the action_type literal in the builder file
//      (`src/lib/services/identity/<channel>-to-signal.ts`).
//
//   6. Run `node scripts/check-mig-deploy-unit.mjs` to verify.
//
//   7. Commit (3) + (4) + (5) together. CI fails if any of the three
//      drift — that's the entire point of the guard. Without it, a
//      code-before-migration deploy silently swallows `23514` CHECK
//      failures in `recordProgressionIfEligible` below (the catch at
//      line ~245 only treats `23505` as success; every other error
//      returns `{recorded:false}` without throwing).
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedSignal } from './sources/types'

export type ProgressionEventType =
  | 'email_reply'
  | 'tour_booked'
  | 'tour_rescheduled'
  | 'tour_attended'
  | 'new_channel_inquiry'
  | 'portal_click'
  | 'contract_signed'
  | 'inbound_followup'
  | 'fragment_match_returned'
  | 'inbound_human_request'
  // Pbatch2-3 / migration 371 — Batch 2 ingestion channels.
  | 'crm_inquiry'
  | 'crm_booking'
  | 'inbound_sms'
  | 'inbound_call'
  | 'voicemail_received'
  | 'meeting_completed'

/**
 * Map a NormalizedSignal to its progression event type if it qualifies.
 * Returns null when the signal is outbound or non-progression-eligible.
 */
export function progressionEventTypeFor(
  signal: NormalizedSignal,
): ProgressionEventType | null {
  const channel = signal.channel.toLowerCase()
  const action = signal.action_type.toLowerCase()

  // Explicit outbound exclusions per §3 Don't skip #1.
  if (action === 'venue_sent' || action === 'outbound' || action === 'auto_send') {
    return null
  }

  if (channel === 'gmail') {
    if (action === 'reply' || action === 'inquiry') return 'email_reply'
    if (action === 'inbound_followup') return 'inbound_followup'
    // M9 doctrine fix (PHASE-1-BATCH-1 pressure-test remediation,
    // 2026-05-23 + migration 368). A human-escalation email is genuine
    // inbound progression — the couple just asked for a human, the decay
    // clock SHOULD move. Pre-fix, the M9 site passed action_type:'reply'
    // as a workaround for this very map being incomplete; the action_type
    // now carries the truth and the workaround is retired.
    if (action === 'human_requested') return 'inbound_human_request'
  }
  if (channel === 'calendly') {
    if (action === 'tour_booked') return 'tour_booked'
    if (action === 'tour_attended' || action === 'tour_completed_inferred') return 'tour_attended'
    if (action === 'tour_rescheduled') return 'tour_rescheduled'
  }
  if (channel === 'honeybook') {
    if (action === 'contract_signed' || action === 'booking_signed') return 'contract_signed'
    // Pbatch2-3 / migration 371 — HoneyBook CSV (H3 batch import).
    // The CSV writer emits four action_types per
    // PHASE-1-BATCH-2.md §1 H3:
    //   - crm_imported_inquiry → crm_inquiry (new progression event;
    //     distinct from new_channel_inquiry which is for LIVE-channel
    //     inquiries — CSV is historical / backfill provenance).
    //   - crm_imported_booked → contract_signed (DRY — one signal class,
    //     two ingestion routes. The email-pipeline path already maps
    //     contract_signed/booking_signed to this event_type; reusing
    //     keeps the cohort funnel reader from having to OR-across
    //     near-synonyms for "did they sign?").
    //   - crm_imported_lost → null (terminal/regression state, not
    //     progression. Loss is read off `weddings.lost_at` /
    //     `weddings.status`, not the progression log.)
    //   - crm_attribution → null (synthetic provenance row carrying
    //     `extracted_identity.hear_source` — it's a discovery-source
    //     attribution event, not a couple-action progression. The
    //     discovery-source path has its own progression handling via
    //     captureDiscoverySource → Pbatch2-6 routing.)
    if (action === 'crm_imported_inquiry') return 'crm_inquiry'
    if (action === 'crm_imported_booked') return 'contract_signed'
  }
  if (channel === 'knot' || channel === 'weddingwire' || channel === 'zola') {
    if (action === 'inquiry' || action === 'inquiry_form' || action === 'message') return 'new_channel_inquiry'
  }
  if (channel === 'portal') {
    if (action === 'portal_click' || action === 'portal_visit') return 'portal_click'
  }
  if (channel === 'website') {
    if (action === 'inquiry_form_submitted' || action === 'inquiry') return 'new_channel_inquiry'
  }
  // Pbatch2-3 / migration 371 — phone-channel progression coverage.
  // Channel `'sms'` is shared by Twilio webhook + OpenPhone cron
  // (Pbatch2-1 `sms-to-signal.ts`). Channels `'phone'` + `'voicemail'`
  // are OpenPhone-only (Pbatch2-1 `voice-to-signal.ts`). The choice of
  // three separate channels vs one unified `'sms'` is Pbatch2-4
  // operator decision; this mapper covers both shapes so a Pbatch2-4
  // re-decision doesn't require a re-edit here.
  if (channel === 'sms') {
    if (action === 'sms_inbound') return 'inbound_sms'
  }
  if (channel === 'phone') {
    if (action === 'inbound_call') return 'inbound_call'
    if (action === 'voicemail_received') return 'voicemail_received'
  }
  if (channel === 'voicemail') {
    if (action === 'voicemail_received') return 'voicemail_received'
  }
  // Pbatch2-3 / migration 371 — Zoom meeting progression coverage.
  // Channel renamed from `'meeting'` to `'zoom'` per Pbatch2-5 (the
  // old `'meeting'` value collided with the Calendly batch Tracer's
  // `interactions WHERE type='meeting'` scan at sources/calendly.ts:128).
  if (channel === 'zoom') {
    if (action === 'meeting_completed') return 'meeting_completed'
  }
  // Calendly tour_cancelled intentionally returns null. The CHECK at
  // migration 371 does NOT include `tour_cancelled` either — the table
  // is "Inbound-only PROGRESSION log" and a cancellation is regression,
  // not progression. C11's spine `touchpoints` write covers the
  // cancellation; readers detect regression from there. See
  // PHASE-1-BATCH-2.md §2 Pbatch2-3 "DROPPED — tour_cancelled".

  return null
}

/**
 * Write a progression event and bump couples.last_progression_at.
 * Safe to call on every linker tick; no-ops when the signal does
 * not qualify or when the (couple_id, occurred_at, event_type) row
 * already exists.
 *
 * Returns { recorded: true } when the progression event was inserted
 * AND the clock moved. Otherwise { recorded: false } with reason for
 * telemetry.
 */
export async function recordProgressionIfEligible(args: {
  supabase: SupabaseClient
  coupleId: string
  signal: NormalizedSignal
  touchpointId: string | null
}): Promise<{ recorded: boolean; eventType: ProgressionEventType | null }> {
  const { supabase, coupleId, signal, touchpointId } = args
  const eventType = progressionEventTypeFor(signal)
  if (!eventType) return { recorded: false, eventType: null }

  const occurredAt = signal.occurred_at

  const { error: insertErr } = await supabase
    .from('couple_progression_events')
    .insert({
      couple_id: coupleId,
      occurred_at: occurredAt,
      event_type: eventType,
      source_touchpoint_id: touchpointId,
    })

  // PK conflict → already recorded this exact event. Treat as success
  // but don't move the clock again (idempotent re-run).
  if (insertErr) {
    if (insertErr.code === '23505') {
      return { recorded: false, eventType }
    }
    // Any other error: skip the clock update; surface upstream.
    return { recorded: false, eventType }
  }

  // Bump last_progression_at iff this event is more recent than the
  // current value. PostgREST .or() guards against rolling the clock
  // backward on out-of-order arrivals; the NULL clause covers couples
  // backfilled to created_at where the column is still defaulted.
  await supabase
    .from('couples')
    .update({ last_progression_at: occurredAt })
    .eq('id', coupleId)
    .or(`last_progression_at.is.null,last_progression_at.lt.${occurredAt}`)

  return { recorded: true, eventType }
}

/**
 * Direct progression record for operator-confirmed candidate matches
 * (event_type='fragment_match_returned'). Called by the merge endpoint
 * after a fragment promotes onto a couple.
 */
export async function recordFragmentMatchReturned(args: {
  supabase: SupabaseClient
  coupleId: string
  touchpointId: string | null
  occurredAt?: string
}): Promise<void> {
  const occurredAt = args.occurredAt ?? new Date().toISOString()
  await args.supabase
    .from('couple_progression_events')
    .insert({
      couple_id: args.coupleId,
      occurred_at: occurredAt,
      event_type: 'fragment_match_returned',
      source_touchpoint_id: args.touchpointId,
    })
    .then(() => undefined, () => undefined)
  await args.supabase
    .from('couples')
    .update({ last_progression_at: occurredAt })
    .eq('id', args.coupleId)
    .or(`last_progression_at.is.null,last_progression_at.lt.${occurredAt}`)
    .then(() => undefined, () => undefined)
}
