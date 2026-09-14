/**
 * Out-of-band capture of the loose details in an inbound message.
 *
 * The gap this closes
 * -------------------
 * `services/extraction.ts` has carried a `specialRequests` field since it
 * was written, and W50 added `intentions` beside it. Nothing called
 * `extractSignals`. Not one call site in the whole tree. So a couple
 * writing "we're having a groom's cake, my uncle is bringing it down on
 * the Friday" produced a classified interaction, a heat bump, a drafted
 * reply, and no record anywhere that a cake needs a table.
 *
 * Why out of band
 * ---------------
 * The inbound hot path already spends one Haiku call on classification
 * and the couple is waiting on the reply behind it. Adding a second
 * blocking call would put the cost of this feature on every inbound
 * message's latency. So the capture is scheduled after classification and
 * never awaited, in the same fire-and-forget-with-a-logged-failure shape
 * the pipeline already uses for `stampInboundVerdict` and the Haiku
 * classify drain: `void (async () => { try { … } catch { log } })()`.
 *
 * When it runs
 * ------------
 * Only when the interaction is attached to a wedding. A cold inquiry has
 * no day-of timeline to reconcile against, so there is nowhere for a
 * captured intention to be missing FROM, and spending two model calls per
 * cold inquiry to learn that would be waste. The moment a lead books and
 * gets a wedding, its conversations start being read for loose details.
 */

import { logEvent } from '@/lib/observability/logger'
import { redactError } from '@/lib/observability/redact'
import { extractSignals } from '@/lib/services/extraction'
import {
  extractVenueConversationNotes,
  planningNotesExistForInteraction,
  type PlanningNote,
} from '@/lib/services/intel/planning-extraction'

export interface LooseDetailCaptureArgs {
  venueId: string
  /** The interaction row this text arrived on. The idempotency key. */
  interactionId: string
  /** Null when the interaction is not attached to a wedding yet. */
  weddingId: string | null
  /** 'email' | 'sms' | 'instagram' | … */
  channel: string
  /** Body text as received. Subject may be prepended by the caller. */
  text: string
  correlationId?: string | null
}

export interface LooseDetailCaptureResult {
  ran: boolean
  reason: 'no_wedding' | 'empty' | 'already_captured' | null
  intentions: number
  specialRequests: number
  planningNotesSaved: number
}

/**
 * Run the capture and return what happened. Awaited by tests and by the
 * nightly catch-up; the hot path uses `scheduleLooseDetailCapture`.
 *
 * Throws only what the model client throws. The scheduler catches.
 */
export async function captureLooseDetails(
  args: LooseDetailCaptureArgs,
): Promise<LooseDetailCaptureResult> {
  const empty: LooseDetailCaptureResult = {
    ran: false,
    reason: null,
    intentions: 0,
    specialRequests: 0,
    planningNotesSaved: 0,
  }

  const { venueId, interactionId, weddingId, channel, text } = args

  if (!weddingId) return { ...empty, reason: 'no_wedding' }
  if (!text || text.trim().length < 10) return { ...empty, reason: 'empty' }

  // Check the replay guard BEFORE spending anything. A Gmail backfill
  // replaying six weeks of mail must not re-bill every message.
  if (await planningNotesExistForInteraction(venueId, interactionId)) {
    return { ...empty, reason: 'already_captured' }
  }

  const signals = await extractSignals(venueId, text)

  // Intentions and special requests both become planning notes, because
  // planning_notes is the table the coordinator's surfaces already read
  // and the reconciler already knows how to walk. Category 'note' for
  // intentions; a special request is closer to a policy question in
  // practice ("we need a ramp", "no nuts in anything") but it is not one,
  // so it is also a note. The `kind` distinction survives in the
  // reconciliation row, which is where it is actually read.
  const looseNotes: PlanningNote[] = []
  const sourceMessage = text.substring(0, 500)

  for (const intention of signals.intentions) {
    looseNotes.push({
      category: 'note',
      content: intention,
      source_message: sourceMessage,
    })
  }
  for (const request of signals.specialRequests) {
    looseNotes.push({
      category: 'note',
      content: request,
      source_message: sourceMessage,
    })
  }

  const result = await extractVenueConversationNotes({
    venueId,
    weddingId,
    interactionId,
    channel,
    text,
    additionalNotes: looseNotes,
  })

  return {
    ran: true,
    reason: result.skipped === 'already_extracted' ? 'already_captured' : null,
    intentions: signals.intentions.length,
    specialRequests: signals.specialRequests.length,
    planningNotesSaved: result.saved,
  }
}

/**
 * Fire and forget, with the failure logged rather than swallowed.
 *
 * Returns void immediately. The caller must NOT await the work — that is
 * the whole point — but must call this rather than an unguarded promise,
 * so an unhandled rejection can never take the pipeline down.
 */
export function scheduleLooseDetailCapture(args: LooseDetailCaptureArgs): void {
  void (async () => {
    try {
      const result = await captureLooseDetails(args)
      if (!result.ran) return
      logEvent({
        level: 'info',
        msg: 'commitments.loose_details_captured',
        event_type: 'loose_detail_capture',
        outcome: 'ok',
        venueId: args.venueId,
        correlationId: args.correlationId ?? null,
        data: {
          interactionId: args.interactionId,
          weddingId: args.weddingId,
          channel: args.channel,
          intentions: result.intentions,
          specialRequests: result.specialRequests,
          planningNotesSaved: result.planningNotesSaved,
        },
      })
    } catch (err) {
      // redactError, not err.message: the model client echoes prompt
      // content back in its 4xx bodies, and the prompt here is a couple's
      // email.
      logEvent({
        level: 'warn',
        msg: 'commitments.loose_details_failed',
        event_type: 'loose_detail_capture',
        outcome: 'fail',
        venueId: args.venueId,
        correlationId: args.correlationId ?? null,
        data: {
          interactionId: args.interactionId,
          weddingId: args.weddingId,
          error: redactError(err),
        },
      })
    }
  })()
}
