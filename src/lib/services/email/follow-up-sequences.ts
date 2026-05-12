/**
 * Bloom House: Follow-Up Sequence Engine
 *
 * Tracks where each lead is in an automated follow-up sequence and
 * generates appropriate follow-up drafts when they come due.
 *
 * Sequence logic (v1, hardcoded):
 *   Day 3  → Gentle check-in
 *   Day 7  → Warmer, adds value
 *   Day 14 → Final follow-up, leave the door open
 *
 * Designed to run as a cron job via processAllVenueFollowUps().
 */

import { createServiceClient } from '@/lib/supabase/service'
import { generateFollowUp, BRAIN_PROMPT_VERSION as INQUIRY_BRAIN_PROMPT_VERSION } from '../brain/inquiry'
import { checkAutoSendEligible } from './autonomous-sender'
import { createNotification } from '../admin-notifications'
import { detectNoShow, detectContractOverdue } from '../lifecycle/state-machine'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SequenceStep {
  daysSinceLastContact: number
  type: string
}

export interface FollowUpDue {
  weddingId: string
  contactEmail: string
  daysSinceLastContact: number
  sequenceStep: number
  followUpType: string
}

export interface FollowUpStatus {
  currentStep: number
  nextStepDue: string | null
  followUpsSent: number
  maxFollowUps: number
  complete: boolean
}

// ---------------------------------------------------------------------------
// Sequence definition (v1 — hardcoded)
// ---------------------------------------------------------------------------

const INQUIRY_SEQUENCE: SequenceStep[] = [
  { daysSinceLastContact: 3, type: 'follow_up_3_day' },
  { daysSinceLastContact: 7, type: 'follow_up_7_day' },
  { daysSinceLastContact: 14, type: 'follow_up_final' },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Calculate days between a timestamp and now.
 */
function daysSince(isoTimestamp: string): number {
  const then = new Date(isoTimestamp)
  const now = new Date()
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24))
}

/**
 * Calculate a future date string from now.
 */
function daysFromNowDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

// ---------------------------------------------------------------------------
// 1. checkFollowUpsDue
// ---------------------------------------------------------------------------

/**
 * Scans all inquiry/tour_scheduled weddings for a venue and determines
 * which ones are due for a follow-up based on the sequence definition.
 *
 * Checks:
 *   - Days since last outbound interaction
 *   - How many follow-ups have already been sent (from drafts)
 *   - Whether max_follow_ups has been reached (from venue_ai_config)
 *   - Whether the next sequence step is due
 */
export async function checkFollowUpsDue(
  venueId: string
): Promise<FollowUpDue[]> {
  const supabase = createServiceClient()

  // Get venue max_follow_ups setting
  const { data: aiConfig } = await supabase
    .from('venue_ai_config')
    .select('max_follow_ups')
    .eq('venue_id', venueId)
    .single()

  const maxFollowUps = (aiConfig?.max_follow_ups as number) ?? INQUIRY_SEQUENCE.length

  // Get all active inquiry/tour_scheduled weddings
  const { data: weddings, error: weddingsError } = await supabase
    .from('weddings')
    .select('id, status')
    .eq('venue_id', venueId)
    .in('status', ['inquiry', 'tour_scheduled'])

  if (weddingsError || !weddings || weddings.length === 0) {
    return []
  }

  const due: FollowUpDue[] = []

  for (const wedding of weddings) {
    const weddingId = wedding.id as string

    // Get the contact email for this wedding
    const { data: contact } = await supabase
      .from('contacts')
      .select('email')
      .eq('wedding_id', weddingId)
      .eq('is_primary', true)
      .limit(1)
      .single()

    // Fall back to people table if no primary contact
    let contactEmail = (contact?.email as string) ?? null
    if (!contactEmail) {
      const { data: person } = await supabase
        .from('people')
        .select('email')
        .eq('wedding_id', weddingId)
        .not('email', 'is', null)
        .limit(1)
        .single()

      contactEmail = (person?.email as string) ?? null
    }

    if (!contactEmail) continue

    // Lifecycle gate (migration 246). The wedding's status is already
    // filtered to inquiry / tour_scheduled above, but the per-message
    // signal is the authoritative draft-suppression source: if the
    // couple's most recent inbound was a decline / going-with-other /
    // silent-close, even one that hasn't yet flipped the wedding row to
    // lost, we must NOT generate a follow-up. The Naina Davidar
    // regression came from exactly this gap on the inbound path; the
    // follow-up cron is the same risk on the time-driven path.
    const { data: latestSignaled } = await supabase
      .from('interactions')
      .select('lifecycle_signal')
      .eq('wedding_id', weddingId)
      .eq('direction', 'inbound')
      .not('lifecycle_signal', 'is', null)
      .order('timestamp', { ascending: false })
      .limit(1)
    const latestSignal =
      (latestSignaled && latestSignaled.length > 0
        ? (latestSignaled[0].lifecycle_signal as string | null)
        : null) ?? null
    if (
      latestSignal === 'lead_declined' ||
      latestSignal === 'going_with_other' ||
      latestSignal === 'silent_close'
    ) {
      console.log(
        `[follow-ups] Skipping wedding ${weddingId} -- most recent inbound carries lifecycle signal '${latestSignal}'`
      )
      continue
    }

    // Get the last outbound interaction
    const { data: lastOutbound } = await supabase
      .from('interactions')
      .select('timestamp')
      .eq('wedding_id', weddingId)
      .eq('direction', 'outbound')
      .order('timestamp', { ascending: false })
      .limit(1)
      .single()

    if (!lastOutbound?.timestamp) continue

    const daysSinceContact = daysSince(lastOutbound.timestamp as string)

    // Count follow-up drafts already generated for this wedding.
    // Pre-114, this used `LIKE 'follow_up_%'` on context_type — but that
    // column has a CHECK constraint allowing only 'inquiry' / 'client',
    // so the broken insert path could never produce a row matching that
    // pattern and the count was always 0 (which would have caused
    // re-generation of step 1 every cron tick once the insert was fixed).
    // Migration 114 adds drafts.follow_up_step; we count via that.
    const { count: followUpCount } = await supabase
      .from('drafts')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', weddingId)
      .not('follow_up_step', 'is', null)

    const sent = followUpCount ?? 0

    // Check if max reached
    if (sent >= maxFollowUps) continue

    // Determine which sequence step they're at
    const nextStepIndex = sent // 0-indexed: 0 = first follow-up, 1 = second, etc.
    if (nextStepIndex >= INQUIRY_SEQUENCE.length) continue

    const nextStep = INQUIRY_SEQUENCE[nextStepIndex]

    // Is this step due?
    if (daysSinceContact >= nextStep.daysSinceLastContact) {
      due.push({
        weddingId,
        contactEmail,
        daysSinceLastContact: daysSinceContact,
        sequenceStep: nextStepIndex + 1,
        followUpType: nextStep.type,
      })
    }
  }

  return due
}

// ---------------------------------------------------------------------------
// 2. generateFollowUps
// ---------------------------------------------------------------------------

/**
 * Checks which follow-ups are due for a venue, then generates draft
 * emails for each one. Inserts drafts with status='pending'.
 *
 * Returns the number of drafts generated.
 */
export async function generateFollowUps(venueId: string): Promise<number> {
  const dueFollowUps = await checkFollowUpsDue(venueId)

  if (dueFollowUps.length === 0) {
    console.log(`[follow-ups] No follow-ups due for venue ${venueId}`)
    return 0
  }

  const supabase = createServiceClient()
  let generated = 0

  // Batch the lastOutbound lookup that the per-follow-up code below
  // relies on for "Re: <subject>" thread continuity. Pre-fix this was
  // a per-iteration .single() query — N+1 against interactions for a
  // venue with N follow-ups due. One query + in-memory grouping
  // collapses to a single round-trip.
  const wedIds = dueFollowUps.map((f) => f.weddingId)
  const { data: outboundRows } = await supabase
    .from('interactions')
    .select('wedding_id, subject, gmail_thread_id, source, timestamp')
    .in('wedding_id', wedIds)
    .eq('direction', 'outbound')
    .order('timestamp', { ascending: false })
  // Group: keep only the most recent outbound per wedding_id (the
  // ORDER BY DESC means the first hit per wedding wins).
  const lastOutboundByWedding = new Map<string, {
    subject: string | null
    gmail_thread_id: string | null
    source: string | null
  }>()
  for (const row of (outboundRows ?? []) as Array<{
    wedding_id: string
    subject: string | null
    gmail_thread_id: string | null
    source: string | null
  }>) {
    if (!lastOutboundByWedding.has(row.wedding_id)) {
      lastOutboundByWedding.set(row.wedding_id, {
        subject: row.subject,
        gmail_thread_id: row.gmail_thread_id,
        source: row.source,
      })
    }
  }

  for (const followUp of dueFollowUps) {
    try {
      // Skip follow-up if the couple is actively engaged.
      // If they've sent a message or completed a checklist item in the last 3 days,
      // they don't need a nudge — they're already in the conversation.
      const threeDaysAgo = new Date()
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)
      const recentCutoff = threeDaysAgo.toISOString()

      const [recentMessages, recentChecklist] = await Promise.all([
        supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('wedding_id', followUp.weddingId)
          .gte('created_at', recentCutoff),
        supabase
          .from('checklist_items')
          .select('id', { count: 'exact', head: true })
          .eq('wedding_id', followUp.weddingId)
          .eq('completed', true)
          .gte('updated_at', recentCutoff),
      ])

      const messageCount = recentMessages.count ?? 0
      const checklistCount = recentChecklist.count ?? 0

      if (messageCount > 0 || checklistCount > 0) {
        console.log(
          `[follow-ups] Skipping wedding ${followUp.weddingId} — couple is actively engaged ` +
            `(${messageCount} messages, ${checklistCount} checklist items in last 3 days)`
        )
        continue
      }

      // Generate the follow-up draft via inquiry brain
      const result = await generateFollowUp({
        venueId,
        contactEmail: followUp.contactEmail,
        weddingId: followUp.weddingId,
        daysSinceLastContact: followUp.daysSinceLastContact,
      })

      // Subject: derive a "Re: <previous>" from the batched lookup
      // above. generateFollowUp does not return a subject (body is
      // templated) so we synthesise from the thread.
      const lastOutbound = lastOutboundByWedding.get(followUp.weddingId)

      const followUpSubject = lastOutbound?.subject
        ? `Re: ${(lastOutbound.subject as string).replace(/^Re:\s*/i, '')}`
        : 'Following up on your inquiry'
      const threadId = (lastOutbound?.gmail_thread_id as string) ?? undefined
      const detectedSource = (lastOutbound?.source as string) ?? 'direct'

      // Insert the draft. Pre-fix this used wrong column names
      // (`body`, `contact_email`) and a context_type that violated the
      // CHECK constraint (`follow_up_3_day` is not in the allowed
      // 'inquiry'/'client' set), so the cron has been silently failing
      // every run. Now: context_type='inquiry' (matches doctrine —
      // follow-ups go through the same approval path as inbound
      // replies, sliders apply); follow_up_step records which sequence
      // step this draft represents.
      const { data: draft, error } = await supabase
        .from('drafts')
        .insert({
          venue_id: venueId,
          wedding_id: followUp.weddingId,
          to_email: followUp.contactEmail,
          subject: followUpSubject,
          draft_body: result.draft,
          status: 'pending',
          context_type: 'inquiry',
          brain_used: 'inquiry',
          follow_up_step: followUp.followUpType,
          confidence_score: result.confidence,
          cost: result.cost,
          tokens_used: result.tokensUsed,
          auto_sent: false,
          prompt_version_used: INQUIRY_BRAIN_PROMPT_VERSION,
        })
        .select('id')
        .single()

      if (error || !draft) {
        console.error(
          `[follow-ups] Failed to insert draft for wedding ${followUp.weddingId}:`,
          error?.message
        )
        continue
      }

      const draftId = draft.id as string

      // Per Playbook 10.3: "No follow-up bypasses the slider model."
      // Run the same eligibility check the inbound pipeline runs and
      // fall into the same auto_send_pending + 5-min cancellation
      // window flow when the venue has the slider enabled. When the
      // venue has the slider off (the default), drafts simply remain
      // 'pending' for coordinator approval — same shape as before.
      try {
        // Round-3 audit follow-up #48: read the wedding's persisted
        // injection block. If a prior inbound on this wedding tripped
        // a prompt-injection signal (mig 219), every follow-up auto-
        // send must continue to be blocked until a coordinator clears
        // it. Without this, the round-2 protection had a hole:
        // follow-ups schedule outbound nudges with no fresh inbound,
        // so containsInjectionAttempt at scheduling time would never
        // re-trigger.
        const { data: weddingBlock } = await supabase
          .from('weddings')
          .select('auto_send_blocked_at')
          .eq('id', followUp.weddingId)
          .maybeSingle()
        const injectionSuspected = !!weddingBlock?.auto_send_blocked_at

        const eligibility = await checkAutoSendEligible(venueId, {
          contextType: 'inquiry',
          // Pass raw brain confidence — checkAutoSendEligible normalises
          // 0-100 → 0.0-1.0 internally (Repair K, 2026-05-01).
          confidenceScore: result.confidence,
          source: detectedSource,
          threadId,
          // Follow-ups simulate an inbound nudge — direction='inbound'
          // satisfies the INV-15 gate. Required (no default).
          direction: 'inbound',
          weddingId: followUp.weddingId,
          injectionSuspected,
        })

        if (eligibility.eligible) {
          const sendAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

          const { error: pendingErr } = await supabase
            .from('drafts')
            .update({
              status: 'auto_send_pending',
              auto_sent: false,
              auto_send_source: detectedSource,
              auto_send_attempts: 0,
            })
            .eq('id', draftId)
            .select('id')
            .single()

          if (!pendingErr) {
            await createNotification({
              venueId,
              weddingId: followUp.weddingId,
              type: 'auto_send_pending',
              title: `Auto-sending follow-up to ${followUp.contactEmail} in 5 minutes`,
              body: JSON.stringify({
                draftId,
                toEmail: followUp.contactEmail,
                subject: followUpSubject,
                threadId,
                sendAt,
                confidenceScore: result.confidence,
                source: detectedSource,
                followUpStep: followUp.followUpType,
              }),
            })
          } else {
            console.error(
              `[follow-ups] Failed to mark draft ${draftId} as auto_send_pending:`,
              pendingErr.message
            )
            // Falls through with status='pending' for manual approval.
          }
        }
      } catch (eligErr) {
        console.error(
          `[follow-ups] Eligibility check failed for wedding ${followUp.weddingId}:`,
          eligErr
        )
        // Draft stays in 'pending' for manual approval — fail-safe.
      }

      generated++
      console.log(
        `[follow-ups] Generated ${followUp.followUpType} for wedding ${followUp.weddingId} ` +
          `(step ${followUp.sequenceStep}, ${followUp.daysSinceLastContact} days since contact)`
      )
    } catch (err) {
      console.error(
        `[follow-ups] Error generating follow-up for wedding ${followUp.weddingId}:`,
        err
      )
    }
  }

  console.log(
    `[follow-ups] Generated ${generated}/${dueFollowUps.length} follow-ups for venue ${venueId}`
  )
  return generated
}

// ---------------------------------------------------------------------------
// 2b. evaluateConfiguredSequenceTriggers (F12 — mig 297)
// ---------------------------------------------------------------------------
//
// Evaluates the four new lifecycle-driven trigger types added in
// migration 297 against the per-venue follow_up_sequences table:
//
//   tour_cancelled     — tours.outcome='cancelled', N days elapsed
//   lost_reactivation  — weddings.lost_at, N days elapsed, no recent
//                        outbound (avoid piling on)
//   no_show            — tour past-due with outcome still pending
//   contract_overdue   — status='proposal_sent', N days elapsed
//
// For each active sequence with one of these triggers, this function
// finds matching weddings, checks per-wedding suppression (active
// engagement, max_follow_ups, lifecycle loss signal), generates a
// draft via generateFollowUp, and falls into the same auto-send
// eligibility path (which applies auto_send_rules thread / daily caps
// per `memory/bloom-auto-send-cap-audit.md`).
//
// All windows are read from sequence.trigger_config so the operator
// controls them via the existing /agent/sequences UI. No hard-coded
// day values — defaults live alongside the keys we read.
//
// Returns the number of drafts generated.
// ---------------------------------------------------------------------------

type ExtendedTriggerType =
  | 'tour_cancelled'
  | 'lost_reactivation'
  | 'no_show'
  | 'contract_overdue'

interface ConfiguredSequenceRow {
  id: string
  venue_id: string
  trigger_type: string
  trigger_config: Record<string, unknown> | null
  is_active: boolean
}

interface ExtendedCandidate {
  weddingId: string
  contactEmail: string
  sequence: ConfiguredSequenceRow
  followUpType: string
  daysSinceAnchor: number
  evidence: Record<string, unknown>
}

const EXTENDED_TRIGGERS: ReadonlyArray<ExtendedTriggerType> = [
  'tour_cancelled',
  'lost_reactivation',
  'no_show',
  'contract_overdue',
]

function readDays(
  config: Record<string, unknown> | null | undefined,
  key: string,
  fallback: number,
): number {
  if (!config) return fallback
  const raw = config[key]
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw
  if (typeof raw === 'string') {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return fallback
}

async function resolveContactEmail(
  supabase: ReturnType<typeof createServiceClient>,
  weddingId: string,
): Promise<string | null> {
  const { data: contact } = await supabase
    .from('contacts')
    .select('email')
    .eq('wedding_id', weddingId)
    .eq('is_primary', true)
    .limit(1)
    .single()
  if (contact?.email) return contact.email as string

  const { data: person } = await supabase
    .from('people')
    .select('email')
    .eq('wedding_id', weddingId)
    .not('email', 'is', null)
    .limit(1)
    .single()
  return (person?.email as string) ?? null
}

async function findTourCancelledCandidates(
  supabase: ReturnType<typeof createServiceClient>,
  seq: ConfiguredSequenceRow,
  now: Date,
): Promise<ExtendedCandidate[]> {
  const daysAfter = readDays(seq.trigger_config, 'days_after', 3)
  const cutoffMs = now.getTime() - daysAfter * 24 * 60 * 60 * 1000

  // Fetch cancelled tours for this venue. Use `updated_at` if present,
  // otherwise fall back to scheduled_at as the "when did this become
  // cancelled?" anchor. Schema today doesn't carry a cancelled_at column
  // on tours, so updated_at is the best proxy when available.
  const { data: tours, error } = await supabase
    .from('tours')
    .select('id, wedding_id, scheduled_at, outcome')
    .eq('venue_id', seq.venue_id)
    .eq('outcome', 'cancelled')
    .not('wedding_id', 'is', null)
    .limit(500)
  if (error || !tours) return []

  const candidates: ExtendedCandidate[] = []
  for (const t of tours as Array<{
    id: string
    wedding_id: string
    scheduled_at: string | null
    outcome: string | null
  }>) {
    const anchorIso = t.scheduled_at
    if (!anchorIso) continue
    const anchorMs = Date.parse(anchorIso)
    if (!Number.isFinite(anchorMs)) continue
    if (anchorMs > cutoffMs) continue

    const email = await resolveContactEmail(supabase, t.wedding_id)
    if (!email) continue

    candidates.push({
      weddingId: t.wedding_id,
      contactEmail: email,
      sequence: seq,
      followUpType: 'tour_cancelled',
      daysSinceAnchor: Math.floor(
        (now.getTime() - anchorMs) / (24 * 60 * 60 * 1000),
      ),
      evidence: { tour_id: t.id, scheduled_at: anchorIso, days_after: daysAfter },
    })
  }
  return candidates
}

async function findLostReactivationCandidates(
  supabase: ReturnType<typeof createServiceClient>,
  seq: ConfiguredSequenceRow,
  now: Date,
): Promise<ExtendedCandidate[]> {
  const daysAfter = readDays(seq.trigger_config, 'days_after', 90)
  const dontPilOnDays = readDays(seq.trigger_config, 'recent_outbound_window_days', 30)
  const cutoffMs = now.getTime() - daysAfter * 24 * 60 * 60 * 1000
  const recentOutboundCutoff = new Date(
    now.getTime() - dontPilOnDays * 24 * 60 * 60 * 1000,
  ).toISOString()

  // Sticky-state Pattern 1 (migration 306): lost_locked_by_operator
  // means the coordinator has declared this couple permanently gone.
  // Reactivation cron must skip these weddings — operator override of
  // the auto-engagement path.
  const { data: weddings, error } = await supabase
    .from('weddings')
    .select('id, lost_at, lost_locked_by_operator')
    .eq('venue_id', seq.venue_id)
    .eq('status', 'lost')
    .not('lost_at', 'is', null)
    .neq('lost_locked_by_operator', true)
    .limit(500)
  if (error || !weddings) return []

  const candidates: ExtendedCandidate[] = []
  for (const w of weddings as Array<{ id: string; lost_at: string | null }>) {
    if (!w.lost_at) continue
    const lostMs = Date.parse(w.lost_at)
    if (!Number.isFinite(lostMs)) continue
    if (lostMs > cutoffMs) continue

    // Don't pile on: skip if any outbound in the last N days
    const { count: recentOutCount } = await supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', w.id)
      .eq('direction', 'outbound')
      .gte('timestamp', recentOutboundCutoff)
    if ((recentOutCount ?? 0) > 0) continue

    const email = await resolveContactEmail(supabase, w.id)
    if (!email) continue

    candidates.push({
      weddingId: w.id,
      contactEmail: email,
      sequence: seq,
      followUpType: 'lost_reactivation',
      daysSinceAnchor: Math.floor(
        (now.getTime() - lostMs) / (24 * 60 * 60 * 1000),
      ),
      evidence: {
        lost_at: w.lost_at,
        days_after: daysAfter,
        recent_outbound_window_days: dontPilOnDays,
      },
    })
  }
  return candidates
}

async function findNoShowCandidates(
  supabase: ReturnType<typeof createServiceClient>,
  seq: ConfiguredSequenceRow,
  now: Date,
): Promise<ExtendedCandidate[]> {
  // no_show fires N days after the tour slot ended without outcome
  // resolution. Default 1d. detectNoShow (state-machine.ts) decides if
  // a tour slot has elapsed past the (scheduled_at + duration) cliff;
  // the runner here adds the "and that was at least N days ago" gate.
  const daysAfter = readDays(seq.trigger_config, 'days_after', 1)
  const assumedDurationMinutes = readDays(
    seq.trigger_config,
    'assumed_tour_duration_minutes',
    120,
  )
  const slotEndCutoffMs =
    now.getTime() - daysAfter * 24 * 60 * 60 * 1000

  // Pull pending tours scoped to this venue; detectNoShow does the
  // per-wedding decision. We scope at the SQL layer to keep the
  // candidate set small.
  const { data: tours, error } = await supabase
    .from('tours')
    .select('id, wedding_id, scheduled_at, outcome')
    .eq('venue_id', seq.venue_id)
    .or('outcome.is.null,outcome.eq.pending')
    .not('wedding_id', 'is', null)
    .limit(500)
  if (error || !tours) return []

  const candidates: ExtendedCandidate[] = []
  for (const t of tours as Array<{
    id: string
    wedding_id: string
    scheduled_at: string | null
    outcome: string | null
  }>) {
    const sched = t.scheduled_at ? Date.parse(t.scheduled_at) : NaN
    if (!Number.isFinite(sched)) continue
    const slotEndMs = sched + assumedDurationMinutes * 60 * 1000
    if (slotEndMs > slotEndCutoffMs) continue

    const detection = await detectNoShow({
      weddingId: t.wedding_id,
      supabase,
      assumedDurationMinutes,
      now,
    })
    if (!detection.detected) continue

    const email = await resolveContactEmail(supabase, t.wedding_id)
    if (!email) continue

    candidates.push({
      weddingId: t.wedding_id,
      contactEmail: email,
      sequence: seq,
      followUpType: 'no_show',
      daysSinceAnchor: Math.floor(
        (now.getTime() - slotEndMs) / (24 * 60 * 60 * 1000),
      ),
      evidence: {
        tour_id: detection.tour_id,
        scheduled_at: detection.scheduled_at,
        minutes_since_end: detection.minutes_since_end,
        days_after: daysAfter,
        assumed_tour_duration_minutes: assumedDurationMinutes,
      },
    })
  }
  return candidates
}

async function findContractOverdueCandidates(
  supabase: ReturnType<typeof createServiceClient>,
  seq: ConfiguredSequenceRow,
  now: Date,
): Promise<ExtendedCandidate[]> {
  const daysAfter = readDays(seq.trigger_config, 'days_after', 14)

  // status/updated_at are checked inside detectContractOverdue via a
  // dedicated lookup — we only need the id list at this layer.
  const { data: weddings, error } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', seq.venue_id)
    .eq('status', 'proposal_sent')
    .limit(500)
  if (error || !weddings) return []

  const candidates: ExtendedCandidate[] = []
  for (const w of weddings as Array<{ id: string }>) {
    const detection = await detectContractOverdue({
      weddingId: w.id,
      supabase,
      daysAfter,
      now,
    })
    if (!detection.detected) continue

    const email = await resolveContactEmail(supabase, w.id)
    if (!email) continue

    candidates.push({
      weddingId: w.id,
      contactEmail: email,
      sequence: seq,
      followUpType: 'contract_overdue',
      daysSinceAnchor: detection.days_since_proposal ?? daysAfter,
      evidence: {
        proposal_sent_at: detection.proposal_sent_at,
        days_since_proposal: detection.days_since_proposal,
        proposal_sent_source: detection.source,
        days_after: daysAfter,
      },
    })
  }
  return candidates
}

/**
 * For one wedding-driven extended-trigger candidate, run the same
 * suppression checks the hardcoded INQUIRY_SEQUENCE flow runs and emit
 * a draft (then fall into auto-send eligibility / cap enforcement).
 */
async function emitExtendedDraft(
  supabase: ReturnType<typeof createServiceClient>,
  candidate: ExtendedCandidate,
  now: Date,
): Promise<boolean> {
  const venueId = candidate.sequence.venue_id
  const weddingId = candidate.weddingId

  // Lifecycle-signal gate (mirrors checkFollowUpsDue): suppress when
  // the most recent inbound carries a loss signal. Even though
  // lost_reactivation explicitly targets lost weddings, a fresh signal
  // (e.g. a coordinator-cleared revival in motion) on top of that lost
  // row would still suppress the auto-nudge if the inbound is a
  // decline.
  const { data: latestSignaled } = await supabase
    .from('interactions')
    .select('lifecycle_signal')
    .eq('wedding_id', weddingId)
    .eq('direction', 'inbound')
    .not('lifecycle_signal', 'is', null)
    .order('timestamp', { ascending: false })
    .limit(1)
  const latestSignal =
    (latestSignaled && latestSignaled.length > 0
      ? (latestSignaled[0].lifecycle_signal as string | null)
      : null) ?? null
  if (
    candidate.followUpType !== 'lost_reactivation' &&
    (latestSignal === 'lead_declined' ||
      latestSignal === 'going_with_other' ||
      latestSignal === 'silent_close')
  ) {
    return false
  }

  // Active-engagement skip (mirrors generateFollowUps).
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString()
  const [recentMessages, recentChecklist] = await Promise.all([
    supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', weddingId)
      .gte('created_at', threeDaysAgo),
    supabase
      .from('checklist_items')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', weddingId)
      .eq('completed', true)
      .gte('updated_at', threeDaysAgo),
  ])
  if ((recentMessages.count ?? 0) > 0 || (recentChecklist.count ?? 0) > 0) {
    return false
  }

  // De-dupe per sequence: don't fire the same extended trigger
  // sequence twice for the same wedding. Uses drafts.follow_up_step
  // (mig 114) to record which sequence-type this draft was.
  const { count: priorCount } = await supabase
    .from('drafts')
    .select('id', { count: 'exact', head: true })
    .eq('wedding_id', weddingId)
    .eq('follow_up_step', candidate.followUpType)
  if ((priorCount ?? 0) > 0) {
    return false
  }

  // Pull a previous outbound for "Re: <subject>" continuity (best-
  // effort — these triggers may have no prior outbound at all).
  const { data: lastOutbound } = await supabase
    .from('interactions')
    .select('subject, gmail_thread_id, source, timestamp')
    .eq('wedding_id', weddingId)
    .eq('direction', 'outbound')
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle()

  const result = await generateFollowUp({
    venueId,
    contactEmail: candidate.contactEmail,
    weddingId,
    daysSinceLastContact: candidate.daysSinceAnchor,
  })

  const subjectBase =
    (lastOutbound?.subject as string | null) ??
    (candidate.followUpType === 'lost_reactivation'
      ? 'Thinking of you'
      : candidate.followUpType === 'contract_overdue'
        ? 'Following up on your proposal'
        : candidate.followUpType === 'no_show'
          ? 'We missed you for your tour'
          : 'Rescheduling your tour')
  const followUpSubject = `Re: ${subjectBase.replace(/^Re:\s*/i, '')}`
  const threadId = (lastOutbound?.gmail_thread_id as string | null) ?? undefined
  const detectedSource = (lastOutbound?.source as string | null) ?? 'direct'

  const { data: draft, error } = await supabase
    .from('drafts')
    .insert({
      venue_id: venueId,
      wedding_id: weddingId,
      to_email: candidate.contactEmail,
      subject: followUpSubject,
      draft_body: result.draft,
      status: 'pending',
      context_type: 'inquiry',
      brain_used: 'inquiry',
      follow_up_step: candidate.followUpType,
      confidence_score: result.confidence,
      cost: result.cost,
      tokens_used: result.tokensUsed,
      auto_sent: false,
      prompt_version_used: INQUIRY_BRAIN_PROMPT_VERSION,
    })
    .select('id')
    .single()

  if (error || !draft) {
    console.error(
      `[follow-ups:${candidate.followUpType}] Failed to insert draft for wedding ${weddingId}:`,
      error?.message,
    )
    return false
  }

  const draftId = draft.id as string

  // Auto-send eligibility (enforces auto_send_rules.thread_cap_24h +
  // daily_limit — see memory/bloom-auto-send-cap-audit.md).
  try {
    const { data: weddingBlock } = await supabase
      .from('weddings')
      .select('auto_send_blocked_at')
      .eq('id', weddingId)
      .maybeSingle()
    const injectionSuspected = !!weddingBlock?.auto_send_blocked_at

    const eligibility = await checkAutoSendEligible(venueId, {
      contextType: 'inquiry',
      confidenceScore: result.confidence,
      source: detectedSource,
      threadId,
      direction: 'inbound',
      weddingId,
      injectionSuspected,
    })

    if (eligibility.eligible) {
      const sendAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString()
      const { error: pendingErr } = await supabase
        .from('drafts')
        .update({
          status: 'auto_send_pending',
          auto_sent: false,
          auto_send_source: detectedSource,
          auto_send_attempts: 0,
        })
        .eq('id', draftId)
        .select('id')
        .single()
      if (!pendingErr) {
        await createNotification({
          venueId,
          weddingId,
          type: 'auto_send_pending',
          title: `Auto-sending ${candidate.followUpType} follow-up to ${candidate.contactEmail} in 5 minutes`,
          body: JSON.stringify({
            draftId,
            toEmail: candidate.contactEmail,
            subject: followUpSubject,
            threadId,
            sendAt,
            confidenceScore: result.confidence,
            source: detectedSource,
            followUpStep: candidate.followUpType,
            sequenceId: candidate.sequence.id,
            evidence: candidate.evidence,
          }),
        })
      }
    }
  } catch (eligErr) {
    console.error(
      `[follow-ups:${candidate.followUpType}] Eligibility check failed for wedding ${weddingId}:`,
      eligErr,
    )
  }

  console.log(
    `[follow-ups:${candidate.followUpType}] Generated draft for wedding ${weddingId} ` +
      `(${candidate.daysSinceAnchor}d since anchor)`,
  )
  return true
}

/**
 * Evaluates the four new lifecycle-driven sequence triggers for one
 * venue. Reads active `follow_up_sequences` rows whose trigger_type is
 * in the EXTENDED_TRIGGERS set and emits drafts for matching weddings.
 */
export async function evaluateConfiguredSequenceTriggers(
  venueId: string,
  now: Date = new Date(),
): Promise<number> {
  const supabase = createServiceClient()

  const { data: sequences, error } = await supabase
    .from('follow_up_sequences')
    .select('id, venue_id, trigger_type, trigger_config, is_active')
    .eq('venue_id', venueId)
    .eq('is_active', true)
    .in('trigger_type', EXTENDED_TRIGGERS as unknown as string[])
  if (error) {
    console.error(
      `[follow-ups] Failed to load extended sequences for venue ${venueId}:`,
      error.message,
    )
    return 0
  }
  if (!sequences || sequences.length === 0) return 0

  let generated = 0
  for (const seqRaw of sequences as ConfiguredSequenceRow[]) {
    const seq: ConfiguredSequenceRow = {
      ...seqRaw,
      trigger_config:
        (seqRaw.trigger_config as Record<string, unknown> | null) ?? {},
    }
    let candidates: ExtendedCandidate[] = []
    try {
      switch (seq.trigger_type as ExtendedTriggerType) {
        case 'tour_cancelled':
          candidates = await findTourCancelledCandidates(supabase, seq, now)
          break
        case 'lost_reactivation':
          candidates = await findLostReactivationCandidates(supabase, seq, now)
          break
        case 'no_show':
          candidates = await findNoShowCandidates(supabase, seq, now)
          break
        case 'contract_overdue':
          candidates = await findContractOverdueCandidates(supabase, seq, now)
          break
      }
    } catch (err) {
      console.error(
        `[follow-ups] Candidate scan failed for sequence ${seq.id} (${seq.trigger_type}):`,
        err,
      )
      continue
    }

    for (const c of candidates) {
      try {
        const emitted = await emitExtendedDraft(supabase, c, now)
        if (emitted) generated++
      } catch (err) {
        console.error(
          `[follow-ups:${c.followUpType}] Emit failed for wedding ${c.weddingId}:`,
          err,
        )
      }
    }
  }

  if (generated > 0) {
    console.log(
      `[follow-ups] Extended triggers generated ${generated} draft(s) for venue ${venueId}`,
    )
  }
  return generated
}

// ---------------------------------------------------------------------------
// 3. processAllVenueFollowUps
// ---------------------------------------------------------------------------

/**
 * Runs follow-up generation for all active venues.
 * Designed to be called from the cron route.
 */
export async function processAllVenueFollowUps(): Promise<
  Record<string, number>
> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id, name')

  if (error || !venues || venues.length === 0) {
    console.warn('[follow-ups] No venues found')
    return {}
  }

  // Cost-ceiling gate: follow-up generation calls inquiry-brain
  // (Sonnet) per follow-up due. The autonomous-sender path already
  // refuses to flush when paused, so a paused venue's follow-ups
  // would generate drafts that immediately stall in 'pending'. Skip
  // them entirely instead — the drafts are pure cost. OPS-21.4.3.
  const venueIds = venues.map((v) => v.id as string)
  const venueNames = new Map<string, string>(
    venues.map((v) => [v.id as string, (v.name as string) ?? (v.id as string)]),
  )
  const { filterActiveVenues } = await import('@/lib/services/cost-ceiling')
  const { active, skipped } = await filterActiveVenues(venueIds, {
    workType: 'follow_up_sequences',
  })
  if (skipped.length > 0) {
    console.log(`[follow-ups] Skipping ${skipped.length} paused venue(s); running ${active.length}`)
  }

  const results: Record<string, number> = {}

  for (const id of active) {
    const name = venueNames.get(id) ?? id

    try {
      const baseCount = await generateFollowUps(id)
      // F12: also evaluate the four new lifecycle-driven trigger types
      // configured against follow_up_sequences. These read sequence
      // rows with trigger_type in (tour_cancelled / lost_reactivation /
      // no_show / contract_overdue), find matching weddings, and emit
      // drafts through the same auto-send eligibility path. Wrap in
      // try/catch so a failure here cannot regress the hardcoded
      // INQUIRY_SEQUENCE flow.
      let extendedCount = 0
      try {
        extendedCount = await evaluateConfiguredSequenceTriggers(id)
      } catch (err) {
        console.error(
          `[follow-ups] Extended sequence evaluation failed for venue ${name}:`,
          err,
        )
      }
      const count = baseCount + extendedCount
      results[id] = count
      if (count > 0) {
        console.log(
          `[follow-ups] ${name}: ${baseCount} inquiry + ${extendedCount} extended = ${count} follow-ups generated`,
        )
      }
    } catch (err) {
      console.error(`[follow-ups] Failed for venue ${name}:`, err)
      results[id] = 0
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// 4. getFollowUpStatus
// ---------------------------------------------------------------------------

/**
 * Returns where a specific lead is in the follow-up sequence.
 */
export async function getFollowUpStatus(
  venueId: string,
  weddingId: string
): Promise<FollowUpStatus> {
  const supabase = createServiceClient()

  // Get venue max_follow_ups setting
  const { data: aiConfig } = await supabase
    .from('venue_ai_config')
    .select('max_follow_ups')
    .eq('venue_id', venueId)
    .single()

  const maxFollowUps = (aiConfig?.max_follow_ups as number) ?? INQUIRY_SEQUENCE.length

  // Count follow-up drafts for this wedding via follow_up_step (114).
  // Pre-fix this filtered context_type LIKE 'follow_up_%' but that
  // pattern can never match — the CHECK constraint allows only
  // 'inquiry' / 'client'. See generateFollowUps for the same fix.
  const { count: followUpCount } = await supabase
    .from('drafts')
    .select('id', { count: 'exact', head: true })
    .eq('wedding_id', weddingId)
    .not('follow_up_step', 'is', null)

  const sent = followUpCount ?? 0
  const currentStep = sent // 0 = no follow-ups sent yet

  // Determine if complete
  const complete = sent >= maxFollowUps || sent >= INQUIRY_SEQUENCE.length

  // Calculate next step due date
  let nextStepDue: string | null = null

  if (!complete && currentStep < INQUIRY_SEQUENCE.length) {
    // Get the last outbound interaction to calculate from
    const { data: lastOutbound } = await supabase
      .from('interactions')
      .select('timestamp')
      .eq('wedding_id', weddingId)
      .eq('direction', 'outbound')
      .order('timestamp', { ascending: false })
      .limit(1)
      .single()

    if (lastOutbound?.timestamp) {
      const lastDate = new Date(lastOutbound.timestamp as string)
      const nextStep = INQUIRY_SEQUENCE[currentStep]
      const daysSinceContact = daysSince(lastOutbound.timestamp as string)
      const daysUntilDue = nextStep.daysSinceLastContact - daysSinceContact

      if (daysUntilDue > 0) {
        nextStepDue = daysFromNowDate(daysUntilDue)
      } else {
        // Already due
        nextStepDue = new Date().toISOString().split('T')[0]
      }
    }
  }

  return {
    currentStep,
    nextStepDue,
    followUpsSent: sent,
    maxFollowUps,
    complete,
  }
}
