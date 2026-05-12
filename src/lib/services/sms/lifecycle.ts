// ---------------------------------------------------------------------------
// sms/lifecycle.ts. SMS-side lifecycle folder state machine
// ---------------------------------------------------------------------------
//
// Companion to migration 318. Six folders, single closed enum mirroring the
// email-side mig 242 / inbox/lifecycle.ts but with SMS-flavour buckets:
//
//   new             . first inbound SMS, no outbound reply yet
//   in_progress     . active back-and-forth (>=1 inbound + >=1 outbound)
//   awaiting_couple . venue replied last, waiting for couple
//   awaiting_venue  . couple replied last, waiting for venue
//   on_hold         . operator-snoozed (Don't Disturb / weekend pause)
//   closed          . wedding booked / lost, OR opt-out received
//
// Pure decider + DB-helper shape borrowed from inbox/lifecycle.ts. The
// pure function is intentionally allocation-free so unit tests cover every
// branch without mocking Supabase.
//
// Pattern 9 anchor: voice-channel parity with email. SMS-only leads
// (Justin & Sandy at Rixey) become first-class citizens in every
// coordinator-facing surface.
// ---------------------------------------------------------------------------

import type { createServiceClient } from '@/lib/supabase/service'

export type SmsLifecycleFolder =
  | 'new'
  | 'in_progress'
  | 'awaiting_couple'
  | 'awaiting_venue'
  | 'on_hold'
  | 'closed'

export const SMS_LIFECYCLE_FOLDERS: readonly SmsLifecycleFolder[] = [
  'new',
  'in_progress',
  'awaiting_couple',
  'awaiting_venue',
  'on_hold',
  'closed',
] as const

// Coordinator-facing labels. No em dashes per memory rule.
export const SMS_LIFECYCLE_LABELS: Record<SmsLifecycleFolder, string> = {
  new: 'New',
  in_progress: 'In Progress',
  awaiting_couple: 'Awaiting Couple',
  awaiting_venue: 'Awaiting Venue',
  on_hold: 'On Hold',
  closed: 'Closed',
}

// ---------------------------------------------------------------------------
// Pure decider
// ---------------------------------------------------------------------------

export type SmsWeddingStatusInput =
  | 'inquiry'
  | 'tour_scheduled'
  | 'tour_completed'
  | 'proposal_sent'
  | 'booked'
  | 'completed'
  | 'lost'
  | 'cancelled'
  | null

export interface SmsLifecycleDecisionInput {
  /** weddings.status. null when the SMS has no wedding link. */
  weddingStatus: SmsWeddingStatusInput
  /** weddings.booked_at. non-null also closes the thread. */
  bookedAt?: string | null
  /** weddings.lost_at. non-null also closes the thread. */
  lostAt?: string | null
  /** Inbound SMS count on this thread (per (venue, phone) pair). */
  inboundCount: number
  /** Outbound SMS count on this thread. */
  outboundCount: number
  /** Direction of the most recent SMS in the thread. */
  lastDirection: 'inbound' | 'outbound' | null
  /** Coordinator opt-out / snooze marker. When true, force 'on_hold'. */
  operatorSnoozed?: boolean
  /** True when the inbound carries an opt-out signal ("STOP", "unsubscribe").
      Forces 'closed' regardless of other state. */
  optedOut?: boolean
}

/**
 * Decide which SMS folder a thread belongs to. Priority order:
 *   1. opted_out -> closed
 *   2. wedding booked / lost / completed / cancelled -> closed
 *   3. operator_snoozed -> on_hold
 *   4. inboundCount === 1 && outboundCount === 0 -> new
 *   5. inboundCount >= 1 && outboundCount >= 1 -> in_progress with
 *      last-direction split: outbound-last -> awaiting_couple,
 *      inbound-last -> awaiting_venue, otherwise in_progress
 *   6. outboundCount >= 1 && inboundCount === 0 -> awaiting_couple
 *      (we reached out, no response yet)
 *   7. fallback -> new
 */
export function decideSmsLifecycleFolder(
  input: SmsLifecycleDecisionInput,
): SmsLifecycleFolder {
  const {
    weddingStatus,
    bookedAt,
    lostAt,
    inboundCount,
    outboundCount,
    lastDirection,
    operatorSnoozed,
    optedOut,
  } = input

  // 1) Opt-out is absolute.
  if (optedOut) return 'closed'

  // 2) Terminal wedding states close the thread.
  if (
    weddingStatus === 'booked' ||
    weddingStatus === 'completed' ||
    weddingStatus === 'lost' ||
    weddingStatus === 'cancelled' ||
    !!bookedAt ||
    !!lostAt
  ) {
    return 'closed'
  }

  // 3) Operator override before activity-based bucketing.
  if (operatorSnoozed) return 'on_hold'

  // 4) Virgin first-touch.
  if (inboundCount === 1 && outboundCount === 0) return 'new'

  // 5) Active back-and-forth. Direction of the last message decides whose
  //    court the ball is in.
  if (inboundCount >= 1 && outboundCount >= 1) {
    if (lastDirection === 'outbound') return 'awaiting_couple'
    if (lastDirection === 'inbound') return 'awaiting_venue'
    return 'in_progress'
  }

  // 6) We reached out, no inbound yet (e.g. operator initiated cold SMS).
  if (outboundCount >= 1 && inboundCount === 0) return 'awaiting_couple'

  // 7) Defensive default.
  return 'new'
}

// ---------------------------------------------------------------------------
// DB helper: compute + write the folder for an SMS thread
// ---------------------------------------------------------------------------

type ServiceClient = ReturnType<typeof createServiceClient>

export interface UpdateSmsThreadFolderArgs {
  supabase: ServiceClient
  venueId: string
  /** External party phone (E.164 or normalised). The thread key for SMS. */
  phone: string
  /** True when an inbound on this thread carries an opt-out marker. */
  optedOut?: boolean
  /** Coordinator-side snooze flag. Future surface; pass false today. */
  operatorSnoozed?: boolean
}

const OPT_OUT_PATTERN = /\b(?:STOP|UNSUBSCRIBE|REMOVE|QUIT|CANCEL|END|OPT[\s-]?OUT)\b/i

/**
 * After persisting an SMS interaction, call this to recompute + stamp the
 * SMS lifecycle folder across every row on the thread. Mirrors the email
 * side's updateThreadLifecycleFolder.
 *
 * Thread identity for SMS = (venue_id, type='sms', from_email OR to_email
 * matches the external phone). We carry the phone in interactions.from_email
 * for inbound and stamp the same for outbound (OpenPhone ingest follows
 * this convention. see persistRow in openphone.ts).
 *
 * Best-effort: a failure here mustn't block the SMS persist. The daily
 * data-integrity sweep reconciles drift.
 */
export async function updateSmsThreadLifecycleFolder(
  args: UpdateSmsThreadFolderArgs,
): Promise<{ folder: SmsLifecycleFolder | null; updated: number }> {
  const { supabase, venueId, phone, optedOut, operatorSnoozed } = args
  if (!phone || !phone.trim()) {
    return { folder: null, updated: 0 }
  }

  // Step 1: fetch every SMS interaction on the thread for this venue.
  // We scope on type='sms' so voicemail / call rows on the same phone
  // don't get an SMS folder (they have their own surface treatment).
  const { data: rows, error: rowErr } = await supabase
    .from('interactions')
    .select('id, direction, wedding_id, full_body, body_preview, timestamp, from_email')
    .eq('venue_id', venueId)
    .eq('type', 'sms')
    .eq('from_email', phone)
    .order('timestamp', { ascending: true })

  if (rowErr || !rows || rows.length === 0) {
    return { folder: null, updated: 0 }
  }

  let inboundCount = 0
  let outboundCount = 0
  let weddingId: string | null = null
  let lastDirection: 'inbound' | 'outbound' | null = null
  let detectedOptOut = !!optedOut

  for (const r of rows as Array<{
    direction: string | null
    wedding_id: string | null
    full_body: string | null
    body_preview: string | null
  }>) {
    if (r.direction === 'inbound') inboundCount += 1
    else if (r.direction === 'outbound') outboundCount += 1
    if (!weddingId && r.wedding_id) weddingId = r.wedding_id
    if (r.direction === 'inbound' || r.direction === 'outbound') {
      lastDirection = r.direction as 'inbound' | 'outbound'
    }
    if (!detectedOptOut) {
      const body = (r.full_body ?? r.body_preview ?? '').toString()
      if (body && OPT_OUT_PATTERN.test(body)) detectedOptOut = true
    }
  }

  // Step 2: wedding status + booked_at + lost_at.
  let weddingStatus: SmsWeddingStatusInput = null
  let bookedAt: string | null = null
  let lostAt: string | null = null
  if (weddingId) {
    const { data: w } = await supabase
      .from('weddings')
      .select('status, booked_at, lost_at')
      .eq('id', weddingId)
      .maybeSingle()
    if (w) {
      weddingStatus = (w.status as SmsWeddingStatusInput) ?? null
      bookedAt = (w.booked_at as string | null) ?? null
      lostAt = (w.lost_at as string | null) ?? null
    }
  }

  // Step 3: decide.
  const folder = decideSmsLifecycleFolder({
    weddingStatus,
    bookedAt,
    lostAt,
    inboundCount,
    outboundCount,
    lastDirection,
    operatorSnoozed: !!operatorSnoozed,
    optedOut: detectedOptOut,
  })

  // Step 4: stamp every SMS row on the thread.
  const { error: updateErr } = await supabase
    .from('interactions')
    .update({ sms_lifecycle_folder: folder })
    .eq('venue_id', venueId)
    .eq('type', 'sms')
    .eq('from_email', phone)

  if (updateErr) {
    return { folder, updated: 0 }
  }

  return { folder, updated: rows.length }
}
